import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

export async function checkActivePortfolio() {
  async function bundle(entry, plugins = []) {
    const out = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node', plugins });
    return import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
  }
  const domain = await bundle('src/modules/research/domain/active-portfolio.ts');
  const service = await bundle('src/modules/research/application/active-portfolio.ts');
  const now = Date.now(), asOf = new Date(now - 1000).toISOString();
  const dashboard = { rows: [], pending: [], revision: 'fixture', freshnessMs: 600000 };
  const draft = { ...domain.portfolioTemplate(), asOf, source: 'isolated test, not real holdings',
    positions: [{ account: 'test', code: '600036.SH', quantity: 10, price: 10, currency: 'CNY', fxToBase: 1 }],
    cash: [{ account: 'test', amount: 100, currency: 'CNY', fxToBase: 1 }] };
  domain.validatePortfolio(draft, now);
  assert.equal(domain.assessPortfolio(null, dashboard).nav, null);
  const record = { version: 1, snapshotVersion: 1, recordedAt: asOf, draft, decisions: [] };
  const assessed = domain.assessPortfolio(record, dashboard, now);
  assert.equal(assessed.nav, 200); assert.equal(assessed.companies[0].weight, .5);
  assert(assessed.tasks.some(t => t.subject === '600036.SH' && t.kind === 'data'));
  assert(assessed.tasks.some(t => t.subject === 'maxCompanyWeight'));
  assert.equal(assessed.executable, false);
  const withDraft = patch => ({ ...record, draft: { ...draft, ...patch } });
  for (const patch of [{ asOf: 'bad' }, { asOf: '2026-02-30T00:00:00Z' }, { asOf: new Date(now + 100000).toISOString() }, { asOf: '2026-01-01T00:00:00' }, { source: '' }, { strategy: 'index' }, { positions: [...draft.positions, ...draft.positions] }, { cash: [...draft.cash, ...draft.cash] }, { privateKey: 'not permitted' }, { rules: { ...draft.rules, maxHoldings: 40 } }, { rules: { ...draft.rules, maxCompanyWeight: 2 } }, { positions: [{ ...draft.positions[0], quantity: -1 }] }, { positions: [{ ...draft.positions[0], fxToBase: 2 }] }, { cash: [{ ...draft.cash[0], amount: -1 }] }]) assert.throws(() => domain.validatePortfolio({ ...draft, ...patch }, now));
  const missing = domain.assessPortfolio(withDraft({ positions: [{ ...draft.positions[0], price: null }] }), dashboard, now);
  assert.equal(missing.nav, null); assert.equal(missing.companies[0].weight, null);
  const noFx = domain.assessPortfolio(withDraft({ cash: [{ ...draft.cash[0], currency: 'USD', fxToBase: null }] }), dashboard, now);
  assert.equal(noFx.nav, null);
  const fx = domain.assessPortfolio(withDraft({ cash: [{ ...draft.cash[0], currency: 'USD', fxToBase: 7 }] }), dashboard, now);
  assert.equal(fx.nav, 800);
  // Universe security codes are authoritative; discover the actual H listing rather than guess aliases.
  const universe = JSON.parse(readFileSync(new URL('../../config/investment-universe.json', import.meta.url), 'utf8'));
  const company = universe.companies.find(c => c.securities.some(s => s.ticker === '600036.SH'));
  const hk = company.securities.find(s => s.market === 'HK');
  assert(hk);
  const us = domain.assessPortfolio(withDraft({ positions: [{ ...draft.positions[0], code: 'NVDA.US', currency: 'USD', fxToBase: 7 }] }), dashboard, now);
  assert(us.companies[0].name !== 'NVDA.US', 'US codes must join the bare universe ticker');
  assert.throws(() => domain.validatePortfolio({ ...draft, positions: [{ ...draft.positions[0], code: 'NVDA.US' }] }, now), /币种/);
  const merged = domain.assessPortfolio(withDraft({ positions: [...draft.positions, { ...draft.positions[0], code: hk.ticker, currency: 'HKD', fxToBase: .9 }, { ...draft.positions[0], account: 'other' }] }), dashboard, now);
  assert.equal(merged.companyCount, 1); assert.equal(merged.securityCount, 2);
  const forty = domain.assessPortfolio(withDraft({ positions: Array.from({ length: 40 }, (_, i) => ({ ...draft.positions[0], code: `TEST${i}.US` })) }), dashboard, now);
  assert(forty.tasks.some(t => t.subject === 'count'));
  const stale = domain.assessPortfolio(withDraft({ asOf: new Date(now - 40 * 3600000).toISOString() }), dashboard, now);
  assert(stale.tasks.some(t => t.subject === 'snapshot'));
  const limited = domain.assessPortfolio(withDraft({ rules: { ...draft.rules, maxCompanyWeight: .4, maxSectorWeight: .4 } }), dashboard, now);
  assert.equal(limited.tasks.filter(t => t.kind === 'risk').length, 2);
  const equal = domain.assessPortfolio(withDraft({ rules: { ...draft.rules, maxCompanyWeight: .5, maxSectorWeight: .5 } }), dashboard, now);
  assert.equal(equal.tasks.filter(t => t.kind === 'risk').length, 0);
  const row = { code: '600036.SH', computation: { id: 'one', revision: 'fixture', computedAt: asOf }, researchVersion: 1, opportunity: { stage: 'research_candidate', policyVersion: 'test', gates: [{ key: 'business', state: 'fail', reasons: ['earnings deteriorated'] }], workflow: { thesisStatus: 'invalidated', queue: 'review_risk', nextAction: 'verify thesis' } } };
  const live = { ...dashboard, rows: [row] };
  const risk = domain.assessPortfolio(record, live, now).tasks.find(t => t.subject === row.code);
  assert.equal(risk.kind, 'risk');
  const recomputed = { ...live, rows: [{ ...row, computation: { ...row.computation, id: 'two', computedAt: new Date(now).toISOString() } }] };
  assert.equal(domain.assessPortfolio(record, recomputed, now).tasks.find(t => t.subject === row.code).id, risk.id, 'poll/recompute must not duplicate semantic tasks');
  const changed = { ...live, rows: [{ ...row, researchVersion: 2 }] };
  assert.notEqual(domain.assessPortfolio(record, changed, now).tasks.find(t => t.subject === row.code).id, risk.id);
  for (const bad of [{ ...live, pending: [row.code] }, { ...live, revision: 'new' }, { ...live, rows: [{ ...row, computation: { ...row.computation, computedAt: new Date(now + 1000).toISOString() } }] }]) assert.equal(domain.assessPortfolio(record, bad, now).tasks.find(t => t.subject === row.code).kind, 'data');

  const proposalInput = { title: 'reduce concentration fixture', rationale: 'compare against holding unchanged', estimatedCosts: 0, externalCashFlow: 0,
    target: { ...draft, positions: [{ ...draft.positions[0], quantity: 5 }], cash: [{ ...draft.cash[0], amount: 150 }] } };
  const comparison = domain.comparePortfolioProposal(record, proposalInput, dashboard, now);
  assert.equal(comparison.before.nav, 200); assert.equal(comparison.after.nav, 200);
  assert.equal(comparison.after.companies[0].weight, .25); assert.equal(comparison.comparison.turnover, .25);
  assert.equal(comparison.comparison.fundingGap, 0); assert.equal(comparison.comparison.changes[0].valueChange, -50);
  assert.equal(record.draft.positions[0].quantity, 10, 'proposal cannot mutate actual holdings');
  assert.equal(domain.comparePortfolioProposal(record, { ...proposalInput, estimatedCosts: null }, dashboard, now).comparison.fundingGap, null);
  assert.equal(domain.comparePortfolioProposal(record, { ...proposalInput, estimatedCosts: 10 }, dashboard, now).comparison.fundingGap, 10);
  assert.equal(domain.comparePortfolioProposal(record, { ...proposalInput, estimatedCosts: 10, externalCashFlow: 10 }, dashboard, now).comparison.fundingGap, 0);
  for (const target of [{ ...proposalInput.target, asOf: new Date(now - 2000).toISOString() }, { ...proposalInput.target, rules: { ...draft.rules, maxCompanyWeight: .9 } }, { ...proposalInput.target, positions: [{ ...draft.positions[0], price: 20 }] }]) assert.throws(() => domain.comparePortfolioProposal(record, { ...proposalInput, target }, dashboard, now));

  const sqlite = new DatabaseSync(':memory:'); sqlite.exec(readFileSync(new URL('../../migrations/0117_create_kv_cache.sql', import.meta.url), 'utf8'));
  const DB = { prepare(sql) { const stmt = sqlite.prepare(sql); let values = []; const api = { bind(...args) { values = args; return api }, async first() { return stmt.get(...values) ?? null }, async all() { return { results: stmt.all(...values) } }, async run() { return stmt.run(...values) } }; return api } };
  try {
    const before = sqlite.prepare('select count(*) n from kv_cache').get().n;
    await service.readPortfolio(DB, dashboard);
    assert.equal(sqlite.prepare('select count(*) n from kv_cache').get().n, before, 'GET must not write');
    await service.writePortfolio(DB, 0, { type: 'snapshot', draft }, dashboard);
    await assert.rejects(service.writePortfolio(DB, 0, { type: 'snapshot', draft }, dashboard), /更新/);
    const read = await service.readPortfolio(DB, dashboard), task = read.assessment.tasks[0];
    const command = { type: 'decision', taskId: task.id, choice: 'keep', reason: 'test no trade', until: null };
    const concurrent = await Promise.allSettled([service.writePortfolio(DB, 1, command, dashboard), service.writePortfolio(DB, 1, command, dashboard)]);
    assert.equal(concurrent.filter(r => r.status === 'fulfilled').length, 1);
    const after = await service.readPortfolio(DB, dashboard);
    assert.equal(after.current.version, 2); assert.equal(after.current.snapshotVersion, 1);
    assert.equal(after.assessment.tasks.find(t => t.id === task.id).decision.choice, 'keep');
    assert(after.assessment.tasks.some(t => t.id === task.id), 'acknowledgement never removes underlying risk/gap');
    await assert.rejects(service.writePortfolio(DB, 2, { ...command, taskId: 'forged' }, dashboard), /依据/);
    await assert.rejects(service.writePortfolio(DB, 2, { ...command, choice: 'defer', until: asOf }, dashboard), /未来/);
    await assert.rejects(service.writePortfolio(DB, 2, { type: 'trade' }, dashboard), /不支持/);
    await service.writePortfolio(DB, 2, { type: 'snapshot', draft }, dashboard);
    const versions = await service.portfolioVersions(DB);
    assert.equal(versions.length, 3); assert.equal(versions[0].decisions.length, 0); assert.equal(versions[1].decisions.length, 1);
    assert.equal(sqlite.prepare('select count(*) n from kv_cache where expires_at is not null').get().n, 0);
    assert.equal(sqlite.prepare("select count(*) n from kv_cache where namespace != 'private-active-portfolio-v1'").get().n, 0);

    const { activePortfolioRoutes: router } = await bundle('src/modules/research/api/active-portfolio.routes.ts', [{ name: 'fixtures', setup(b) {
      b.onLoad({ filter: /valuation-screen-cache\.ts$/ }, () => ({ loader: 'js', contents: `export const readValuationDashboard=async()=>(${JSON.stringify(dashboard)})` }));
      b.onLoad({ filter: /shared\/http\.ts$/ }, () => ({ loader: 'js', contents: 'export const ok=(c,data)=>c.json({code:200,data});export const fail=(c,status,msg)=>c.json({code:status,msg},status);' }));
    } }]);
    const env = { DB, APP_RUNTIME: 'node', LLM_RUNTIME: 'local' }, url = 'http://127.0.0.1/research/portfolio/workspace';
    const res = await router.request(url, {}, env); assert.equal(res.status, 200); assert.equal(res.headers.get('Cache-Control'), 'no-store');
    for (const path of [url, url.replace('/workspace', '/history/1')]) {
      assert.equal((await router.request(path, {}, { ...env, APP_RUNTIME: 'cloudflare', LLM_RUNTIME: 'production' })).status, 404);
      assert.equal((await router.request(path, { headers: { Origin: 'https://evil.example' } }, env)).status, 403);
      assert.equal((await router.request(path, { headers: { 'Sec-Fetch-Site': 'cross-site' } }, env)).status, 403);
      assert.equal((await router.request(path.replace('127.0.0.1', 'evil.example'), {}, env)).status, 403);
    }
    assert.equal((await router.request(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' }, env)).status, 415);
    assert.equal((await router.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(150001) }, env)).status, 413);
    const saved = await router.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: 3, command: { type: 'snapshot', draft } }) }, env);
    assert.equal(saved.status, 200, await saved.text());
    assert.equal((await router.request(url.replace('/workspace', '/history/1'), {}, env)).status, 200);
    await service.writePortfolio(DB, 4, { type: 'proposal', proposal: proposalInput }, dashboard);
    const withProposal = (await service.readPortfolio(DB, dashboard)).current;
    assert.equal(withProposal.draft.positions[0].quantity, 10);
    assert.equal(withProposal.proposals[0].comparison.fundingGap, 0);
    await assert.rejects(service.writePortfolio(DB, 5, { type: 'review_proposal', id: withProposal.proposals[0].id, status: 'confirmed', reason: 'changed evidence' }, live), /依据已变化/);
    await service.writePortfolio(DB, 5, { type: 'review_proposal', id: withProposal.proposals[0].id, status: 'confirmed', reason: 'test recorded decision, not execution' }, dashboard);
    const confirmed = (await service.readPortfolio(DB, dashboard)).current;
    assert.equal(confirmed.proposals[0].status, 'confirmed'); assert.equal(confirmed.draft.positions[0].quantity, 10);
    await service.writePortfolio(DB, 6, { type: 'proposal', proposal: { ...proposalInput, estimatedCosts: null } }, dashboard);
    await assert.rejects(service.writePortfolio(DB, 7, { type: 'review_proposal', id: 'proposal-7', status: 'confirmed', reason: 'cannot confirm unknown costs' }, dashboard), /不能记录采纳/);
    await service.writePortfolio(DB, 7, { type: 'snapshot', draft }, dashboard);
    await assert.rejects(service.writePortfolio(DB, 8, { type: 'review_proposal', id: 'proposal-7', status: 'confirmed', reason: 'stale basis' }, dashboard), /快照已变化/);

  } finally { sqlite.close() }
  return { activePortfolio: 'passed', checks: ['snapshot-validation', 'cash/FX/full-denominator', 'company-merge', '39-cap', 'risk-thresholds', 'stale/future/revision', 'semantic-dedup', 'risk-preservation', 'CAS', 'immutable-durable-history', 'GET-readonly', 'private-local-origin', 'content-type/size', 'no-trades', 'proposal-before-after', 'funding/costs', 'proposal-separation', 'stale-proposal'] };
}
