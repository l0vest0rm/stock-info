import { getKvCache, listKvCacheByNamespace } from '../../../db/queries';
import { externalHttpOptions } from '../../../shared/http';
import type { Bindings } from '../../../types';
import opportunityPolicy from '../../../../config/investment-opportunity-policy.json';
import { screenTargets, screenValuationPool, type ValuationScreenRow } from './screen-valuation-pool';

// Existing kv_cache only. Per-security results avoid lost updates between tabs
// and allow small, bounded Worker requests instead of a 97-company waitUntil.
const NAMESPACE = 'valuation-screen-v3';
const LEASE_NAMESPACE = 'valuation-screen-v3-lease';
const RETENTION_MS = 7 * 86400000;
type Environment = Pick<Bindings, 'DB' | 'MARKET_DATA_BUCKET'> & Partial<Bindings>;
type Stored = { row: ValuationScreenRow; computedAt: string };

function parse(text: string): Stored | null {
  try {
    const value = JSON.parse(text) as Stored;
    return value?.row?.code && value.row.opportunity?.policyVersion === opportunityPolicy.version && Number.isFinite(Date.parse(value.computedAt)) ? value : null;
  } catch { return null; }
}

export async function readValuationDashboard(env: Environment) {
  const targets = screenTargets();
  const allowed = new Set(targets.map((target) => target.code));
  const stored = (await listKvCacheByNamespace(env.DB, NAMESPACE)).map((r) => parse(r.valueJson)).filter((r): r is Stored => !!r && allowed.has(r.row.code));
  const rows = stored.map((r) => r.row);
  const byVerdict: Record<string, number> = {};
  for (const row of rows) byVerdict[row.verdict] = (byVerdict[row.verdict] ?? 0) + 1;
  const dates = stored.map((r) => r.computedAt).sort();
  return {
    schemaVersion: 3, asOf: new Date().toISOString().slice(0, 10), generatedAt: dates.at(-1) ?? null,
    oldestComputedAt: dates[0] ?? null, companies: targets.length, targets: targets.map((t) => t.code), rows, byVerdict,
    stale: stored.length < targets.length || stored.some((r) => Date.now() - Date.parse(r.computedAt) > 10 * 60000),
    warnings: ['先展示缓存；每次打开/刷新页面逐家公司请求后台重算并缓存。行情请求上游最新数据，财报刷新按原数据源执行。未来估值未覆盖。'],
  };
}

export async function refreshValuationDashboardRow(env: Environment, code: string) {
  if (!screenTargets().some((t) => t.code === code)) return null;
  const token = crypto.randomUUID();
  const now = Date.now();
  const lease = await env.DB.prepare(`insert into kv_cache(namespace, key, value_json, expires_at, updated_at)
    values (?, ?, ?, ?, ?) on conflict(namespace, key) do update set
    value_json = excluded.value_json, expires_at = excluded.expires_at, updated_at = excluded.updated_at
    where kv_cache.expires_at < ? returning value_json`)
    .bind(LEASE_NAMESPACE, code, token, now + 10 * 60000, now, now).first();
  if (!lease) {
    const cached = await getKvCache(env.DB, NAMESPACE, code);
    return { state: 'busy' as const, row: cached ? parse(cached.valueJson)?.row ?? null : null };
  }
  try {
    const snapshot = await screenValuationPool(env, { codeFilter: [code], concurrency: 1, refreshData: true, httpOptions: externalHttpOptions(env) });
    const row = snapshot.rows[0];
    const stored: Stored = { row, computedAt: new Date().toISOString() };
    // The lease test and result write share one SQL statement (D1 and SQLite),
    // so an expired owner cannot race and overwrite a newer computation.
    const saved = await env.DB.prepare(`insert into kv_cache(namespace, key, value_json, expires_at, updated_at)
      select ?, ?, ?, ?, ? where exists (
        select 1 from kv_cache where namespace = ? and key = ? and value_json = ? and expires_at > ?
      ) on conflict(namespace, key) do update set value_json = excluded.value_json,
      expires_at = excluded.expires_at, updated_at = excluded.updated_at returning key`)
      .bind(NAMESPACE, code, JSON.stringify(stored), Date.now() + RETENTION_MS, Date.now(), LEASE_NAMESPACE, code, token, Date.now()).first();
    if (!saved) throw new Error('估值计算租约已过期，请刷新重试');
    return { state: 'complete' as const, row };
  } finally {
    await env.DB.prepare('delete from kv_cache where namespace = ? and key = ? and value_json = ?').bind(LEASE_NAMESPACE, code, token).run();
  }
}
