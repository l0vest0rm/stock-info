import { getKvCache, listKvCacheByNamespace } from '../../../db/queries';
import { externalHttpOptions } from '../../../shared/http';
import type { Bindings } from '../../../types';
import opportunityPolicy from '../../../../config/investment-opportunity-policy.json';
import revision from '../../../../config/generated/valuation-revision.json';
import { VALUATION_FRESHNESS_MS, type DashboardRow, type DashboardRefresh, type ValuationDashboard } from '../../../../shared/valuation-dashboard';
import { screenTargets, screenValuationPool } from './screen-valuation-pool';

// Only existing kv_cache. Slots apply across API, cron, tabs and Worker isolates.
const NAMESPACE = 'valuation-screen-v4';
const LEASE_NAMESPACE = 'valuation-screen-v4-lease';
const RETENTION_MS = 7 * 86400000;
const LEASE_MS = 10 * 60_000;
type Environment = Pick<Bindings, 'DB' | 'MARKET_DATA_BUCKET'> & Partial<Bindings>;

function parse(text: string): DashboardRow | null {
  try {
    const row = JSON.parse(text) as DashboardRow;
    return row?.code && row.computation?.revision === revision.revision
      && row.opportunity?.policyVersion === opportunityPolicy.version
      && Number.isFinite(Date.parse(row.computation.computedAt)) ? row : null;
  } catch { return null; }
}
const fresh = (row: DashboardRow | null, now = Date.now()) => !!row
  && now >= Date.parse(row.computation.computedAt)
  && now - Date.parse(row.computation.computedAt) < VALUATION_FRESHNESS_MS;

async function readRow(env: Environment, code: string) {
  const cached = await getKvCache(env.DB, NAMESPACE, code);
  return cached ? parse(cached.valueJson) : null;
}

export async function readValuationDashboard(env: Environment): Promise<ValuationDashboard> {
  const targets = screenTargets().map(t => t.code);
  const stored = new Map((await listKvCacheByNamespace(env.DB, NAMESPACE))
    .map(r => parse(r.valueJson)).filter((r): r is DashboardRow => !!r).map(r => [r.code, r]));
  const rows = targets.flatMap(code => stored.has(code) ? [stored.get(code)!] : []);
  const now = Date.now();
  const pending = targets.filter(code => !fresh(stored.get(code) ?? null, now))
    .sort((a, b) => (Date.parse(stored.get(a)?.computation.computedAt ?? '') || 0)
      - (Date.parse(stored.get(b)?.computation.computedAt ?? '') || 0));
  const byVerdict: Record<string, number> = {};
  const blockedDetail: Record<string, number> = {};
  for (const row of rows) {
    byVerdict[row.verdict] = (byVerdict[row.verdict] ?? 0) + 1;
    for (const reason of row.blockReasons) blockedDetail[reason] = (blockedDetail[reason] ?? 0) + 1;
  }
  const dates = rows.map(r => r.computation.computedAt).sort();
  return {
    schemaVersion: 4, mode: 'rolling', revision: revision.revision, freshnessMs: VALUATION_FRESHNESS_MS,
    asOf: new Date(now).toISOString().slice(0, 10), generatedAt: dates.at(-1) ?? null,
    oldestComputedAt: dates[0] ?? null, companies: targets.length, targets, rows, byVerdict, blockedDetail,
    pending, stale: pending.length > 0,
    warnings: ['滚动结果，不是同一时点的历史回测快照；每条结果附计算标识和规则版本。',
      '服务端定时分批更新；10分钟内复用计算结果，财报遵循数据源缓存周期。计算时间不代表行情或财报日期。'],
  };
}

async function claim(env: Environment, key: string, token: string) {
  const now = Date.now();
  return env.DB.prepare(`insert into kv_cache(namespace, key, value_json, expires_at, updated_at)
    values (?, ?, ?, ?, ?) on conflict(namespace, key) do update set
    value_json = excluded.value_json, expires_at = excluded.expires_at, updated_at = excluded.updated_at
    where kv_cache.expires_at <= ? returning key`)
    .bind(LEASE_NAMESPACE, key, token, now + LEASE_MS, now, now).first();
}
async function release(env: Environment, key: string, token: string) {
  await env.DB.prepare('delete from kv_cache where namespace = ? and key = ? and value_json = ?')
    .bind(LEASE_NAMESPACE, key, token).run();
}

export async function refreshValuationDashboardRow(env: Environment, code: string): Promise<DashboardRefresh | null> {
  if (!screenTargets().some(t => t.code === code)) return null;
  let row = await readRow(env, code);
  if (fresh(row)) return { state: 'complete', row };
  const token = crypto.randomUUID();
  let slot: string | null = null;
  for (let i = 0; i < 2; i++) {
    if (await claim(env, `slot:${i}`, token)) { slot = `slot:${i}`; break; }
  }
  if (!slot) return { state: 'busy', row };
  const key = `security:${code}`;
  let ownsCode = false;
  try {
    ownsCode = !!await claim(env, key, token);
    if (!ownsCode) return { state: 'busy', row: await readRow(env, code) };
    // An owner may have completed between the first read and lease acquisition.
    row = await readRow(env, code);
    if (fresh(row)) return { state: 'complete', row };
    const snapshot = await screenValuationPool(env, { codeFilter: [code], concurrency: 1, refreshData: true, httpOptions: externalHttpOptions(env) });
    if (!snapshot.rows[0]) throw new Error('观察池目标在计算期间缺失');
    row = { ...snapshot.rows[0], computation: { id: token, revision: revision.revision, computedAt: new Date().toISOString() } };
    // Both ownership checks and the write are atomic. Expired owners cannot
    // overwrite a newer result. Errors are cached as blocked rows, not retried
    // for every visitor, and never silently replaced by an old green verdict.
    const saved = await env.DB.prepare(`insert into kv_cache(namespace, key, value_json, expires_at, updated_at)
      select ?, ?, ?, ?, ? where (
        select count(*) from kv_cache where namespace = ? and key in (?, ?) and value_json = ? and expires_at > ?
      ) = 2 on conflict(namespace, key) do update set value_json = excluded.value_json,
      expires_at = excluded.expires_at, updated_at = excluded.updated_at returning key`)
      .bind(NAMESPACE, code, JSON.stringify(row), Date.now() + RETENTION_MS, Date.now(), LEASE_NAMESPACE, key, slot, token, Date.now()).first();
    if (!saved) throw new Error('估值计算租约已过期，旧任务结果未写入');
    return { state: 'complete', row };
  } finally {
    try { if (ownsCode) await release(env, key, token); }
    finally { await release(env, slot, token); }
  }
}

/** Bounded work per invocation, resumable by the next cron tick. There is no
 * browser-owned queue and no whole-universe waitUntil. Oldest work goes first. */
export async function refreshValuationDashboardBatch(env: Environment, limit = 2) {
  const dashboard = await readValuationDashboard(env);
  const codes = dashboard.pending.slice(0, Math.max(1, Math.min(12, limit)));
  let cursor = 0;
  async function worker() {
    while (cursor < codes.length) {
      const code = codes[cursor++];
      await refreshValuationDashboardRow(env, code);
    }
  }
  const settled = await Promise.allSettled([worker(), worker()]);
  const failed = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failed.length) throw new AggregateError(failed.map(result => result.reason), '估值批次未完成，后续定时任务将重试');
  return readValuationDashboard(env);
}
