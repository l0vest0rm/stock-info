import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import policy from '../../config/investment-opportunity-policy.json' with { type: 'json' };

/** Real cache/lease SQL against isolated SQLite; only market computation is a
 * controllable stub. Included in test:basic before network-dependent checks. */
export async function checkValuationDashboard() {
  const fixtureKey = '__valuationDashboardFixture';
  const targets = ['600036.SH', '600519.SH', '000001.SZ'].map(code => ({ code }));
  let calls = 0;
  const gates = new Map();
  const fixture = {
    targets,
    async compute(_env, options) {
      calls++;
      const code = options.codeFilter[0];
      await gates.get(code)?.promise;
      return { rows: [{ code, executable: false, verdict: 'blocked', blockReasons: ['request_failed'],
        opportunity: { policyVersion: policy.version }, note: 'fixture' }] };
    },
  };
  globalThis[fixtureKey] = fixture;
  const bundled = await build({ entryPoints: ['src/modules/research/application/valuation-screen-cache.ts'], bundle: true,
    write: false, format: 'esm', platform: 'node', plugins: [{ name: 'market-fixture', setup(builder) {
      builder.onLoad({ filter: /screen-valuation-pool\.ts$/ }, () => ({ loader: 'js', contents:
        `export const screenTargets = () => globalThis.${fixtureKey}.targets;
         export const screenValuationPool = (...args) => globalThis.${fixtureKey}.compute(...args);` }));
      builder.onLoad({ filter: /shared\/http\.ts$/ }, () => ({ loader: 'js', contents: 'export const externalHttpOptions = () => ({});' }));
    } }] });
  const api = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('create table kv_cache(namespace text not null, key text not null, value_json text not null, expires_at integer, updated_at integer not null, primary key(namespace,key))');
  const DB = { prepare(sql) { return { bind(...args) { const statement = sqlite.prepare(sql); return {
    async first() { return statement.get(...args) ?? null; }, async run() { return statement.run(...args); },
    async all() { return { results: statement.all(...args) }; },
  }; } }; } };
  const env = { DB };
  const hold = code => {
    let release; const promise = new Promise(resolve => { release = resolve; });
    gates.set(code, { promise, release });
    return () => { release(); gates.delete(code); };
  };
  const waitFor = async predicate => {
    for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert(predicate(), 'fixture failed to reach computation barrier');
  };
  try {
    const empty = await api.readValuationDashboard(env);
    assert.equal(empty.rows.length, 0); assert.equal(empty.pending.length, 3); assert.equal(calls, 0, 'GET must not compute');
    assert.equal(await api.refreshValuationDashboardRow(env, 'INVALID'), null);
    const releaseA = hold(targets[0].code), releaseB = hold(targets[1].code);
    const a = api.refreshValuationDashboardRow(env, targets[0].code);
    await waitFor(() => calls === 1);
    assert.equal((await api.refreshValuationDashboardRow(env, targets[0].code)).state, 'busy');
    const b = api.refreshValuationDashboardRow(env, targets[1].code);
    await waitFor(() => calls === 2);
    assert.equal((await api.refreshValuationDashboardRow(env, targets[2].code)).state, 'busy', 'global slots must cap different securities');
    releaseA(); releaseB();
    const [first] = await Promise.all([a, b]);
    const reused = await api.refreshValuationDashboardRow(env, targets[0].code);
    assert.equal(reused.row.computation.id, first.row.computation.id); assert.equal(calls, 2, 'busy waiter must reuse completed result');
    const full = await api.refreshValuationDashboardBatch(env);
    assert.equal(full.rows.length, 3); assert.equal(full.stale, false); assert.equal(calls, 3);
    await api.refreshValuationDashboardBatch(env); assert.equal(calls, 3, 'fresh batch must be a no-op');
    assert.equal(full.blockedDetail.request_failed, 3);
    assert.equal(sqlite.prepare("select count(*) n from kv_cache where namespace like '%lease'").get().n, 0);
    // A different dependency revision must not leak into the read model.
    const changed = { ...first.row, computation: { ...first.row.computation, revision: 'old' } };
    sqlite.prepare('update kv_cache set value_json=? where namespace=? and key=?').run(JSON.stringify(changed), 'valuation-screen-v5', targets[0].code);
    assert.equal((await api.readValuationDashboard(env)).rows.length, 2);
    const releaseOld = hold(targets[0].code);
    const old = api.refreshValuationDashboardRow(env, targets[0].code);
    await waitFor(() => calls === 4);
    // Simulate lease takeover. The expired owner must neither write nor release
    // the replacement owner's lease.
    sqlite.prepare("update kv_cache set value_json='new-owner' where namespace=? and key=?")
      .run('valuation-screen-v4-lease', 'security:' + targets[0].code);
    releaseOld(); await assert.rejects(old, /租约已过期/);
    assert.equal(sqlite.prepare('select value_json from kv_cache where namespace=? and key=?')
      .get('valuation-screen-v4-lease', 'security:' + targets[0].code).value_json, 'new-owner');
    sqlite.prepare('delete from kv_cache where namespace=?').run('valuation-screen-v4-lease');
    // Exceptions release both leases and permit future work.
    const original = fixture.compute; fixture.compute = async () => { throw new Error('fixture storage failure'); };
    await assert.rejects(api.refreshValuationDashboardRow(env, targets[0].code), /fixture storage failure/);
    assert.equal(sqlite.prepare("select count(*) n from kv_cache where namespace like '%lease'").get().n, 0);
    fixture.compute = original;
    // Expired leases can be reclaimed without operator cleanup.
    sqlite.prepare('insert into kv_cache values (?, ?, ?, ?, ?)').run('valuation-screen-v4-lease', 'slot:0', 'expired', 0, 0);
    await api.refreshValuationDashboardRow(env, targets[0].code);
    assert.equal((await api.readValuationDashboard(env)).stale, false);
    sqlite.exec('delete from kv_cache');
    const bounded = await api.refreshValuationDashboardBatch(env);
    assert.equal(bounded.rows.length, 2, 'public batch must compute at most two securities');
    assert.equal(bounded.pending.length, 1);
    assert.equal((await api.refreshValuationDashboardBatch(env)).stale, false, 'next invocation must resume remaining work');
    // Research edits invalidate cached rows even within the ten-minute window.
    sqlite.prepare('insert into kv_cache values (?, ?, ?, null, ?)').run('observation-ledger-v1', 'observation-research:v1:' + targets[0].code + ':0000000001', JSON.stringify({code:targets[0].code,version:1}), Date.now());
    assert(!(await api.readValuationDashboard(env)).rows.some(r=>r.code===targets[0].code));
    const computeBefore=fixture.compute;
    fixture.compute=async (...args)=>{const r=await computeBefore(...args);r.rows[0].researchVersion=1;return r};
    const updated=await api.refreshValuationDashboardRow(env,targets[0].code);
    assert.equal(updated.row.researchVersion,1);
    assert.equal((await api.readValuationDashboard(env)).stale,false);
    return { valuationCache: 'passed', checks: ['read-only', 'single-flight', 'global-limit', 'fresh-reuse', 'batch-cache', 'revision', 'fencing', 'lease-recovery','research-version-invalidation'] };
  } finally { sqlite.close(); delete globalThis[fixtureKey]; }
}
