// Invoked only by the retained test:basic entry point.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildInvestmentOpportunity, priceOpportunityMetrics } from '../../src/modules/research/domain/investment-opportunity.ts';

export function checkInvestmentOpportunity() {
  const policy = JSON.parse(readFileSync(new URL('../../config/investment-opportunity-policy.json', import.meta.url), 'utf8'));
  const now = Date.parse('2026-10-28T12:00:00Z');
  const dates = [];
  for (let day = now; dates.length < 253; day -= 86400000) {
    const d = new Date(day);
    if (![0, 6].includes(d.getUTCDay())) dates.unshift(d.toISOString().slice(0, 10));
  }
  const adjustedBars = dates.map((date, i) => ({ date, close: i === 252 ? 60 : 100, fq: 'qfq', source: 'xueqiu' }));
  const assessment = {
    status: 'fair_low', confidence: 'medium', method: 'PE(TTM)', current: 12, unit: 'multiple',
    history: { metric: 'PE(TTM)', windows: [{ years: 3, percentile: .2 }, { years: 5, percentile: .2 }] },
    quote: { date: '2026-10-28', source: 'xueqiu' }, operating: { ttmGrowth: .25 },
  };
  const points = [
    { reportDate: '2026-06-30', quarterRevenue: 120, quarterNetProfit: 30, ttmNetProfit: 100, revenueYoY: .1, netProfitYoY: .2, provisional: false },
    { reportDate: '2026-03-31', quarterRevenue: 100, quarterNetProfit: 25, ttmNetProfit: 90, revenueYoY: .12, netProfitYoY: .3, provisional: false },
    { reportDate: '2024-06-30', ttmNetProfit: 64, revenueYoY: .1, netProfitYoY: .2, provisional: false },
  ];
  const input = { policy, now, assessment, archetype: 'growth_manufacturing', blockReasons: [], points, adjustedBars, cashflowTtm: 100, cashflowReportDate: '2026-06-30', debtRatio: .4, balanceReportDate: '2026-06-30' };
  const run = (overrides = {}) => buildInvestmentOpportunity({ ...input, ...overrides });
  const signal = (o, kind) => o.signals.find((s) => s.kind === kind);
  let checks = 0;
  const check = (name, fn) => { try { fn(); checks++; } catch (e) { throw new Error(name, { cause: e }); } };
  check('valid quantitative evidence may become a research candidate, never a trade', () => {
    const o = run(); assert.equal(o.stage, 'research_candidate'); assert.equal(o.executable, false);
    assert(o.gates.every((g) => g.state === 'pass')); assert.equal(o.quality.profitCagr2y, .25);
    assert.equal(o.signals.length, 4); assert.equal(signal(o, 'forward_gap').state, 'insufficient_data'); assert.equal(o.future, null);
    assert.equal(signal(o, 'historical_discount').state, 'triggered'); assert.equal(signal(o, 'earnings_delivery').state, 'triggered');
    assert.equal(signal(o, 'drawdown').state, 'triggered'); assert.equal(o.price.drawdown252, -.4);
    assert.equal(o.signals.filter((s) => s.group === 'price').length, 2); assert(!Object.hasOwn(o, 'score'));
  });
  check('QoQ uses formal adjacent single quarters and constrains promotion', () => {
    assert(Math.abs(run().quality.revenueQoQ - .2) < 1e-12);
    assert.equal(run().quality.qoqPeriod, '2026-03-31至2026-06-30');
    const declining = run({ points: points.map((r, i) => i === 0 ? { ...r, quarterNetProfit: 20 } : r) });
    assert.equal(signal(declining, 'earnings_delivery').state, 'triggered');
    assert.equal(declining.stage, 'clue');
    for (const patch of [{ quarterNetProfit: 0 }, { quarterNetProfit: -1 }, { quarterRevenue: null }, { provisional: true }, { reportDate: '2025-12-31' }]) {
      const o = run({ points: points.map((r, i) => i === 1 ? { ...r, ...patch } : r) });
      assert.notEqual(o.stage, 'research_candidate');
      assert(o.quality.revenueQoQ === null || o.quality.profitQoQ === null);
    }
    const crossYear = run({ points: [{ ...points[0], reportDate: '2026-03-31' }, { ...points[1], reportDate: '2025-12-31' }] });
    assert(Math.abs(crossYear.quality.profitQoQ - .2) < 1e-12);
    const loss = run({ points: points.map((r, i) => i === 0 ? { ...r, quarterNetProfit: -5 } : r) });
    assert(loss.quality.profitQoQ < -1); assert.notEqual(loss.stage, 'research_candidate');
  });
  check('both historical windows required', () => {
    assert.equal(signal(run({ assessment: { ...assessment, history: { metric: 'PE(TTM)', windows: [{ years: 3, percentile: .1 }, { years: 5, percentile: .21 }] } } }), 'historical_discount').state, 'not_triggered');
    assert.equal(signal(run({ assessment: { ...assessment, history: { metric: 'PE(TTM)', windows: [{ years: 3, percentile: .1 }] } } }), 'historical_discount').state, 'insufficient_data');
  });
  check('one strong quarter is not sustained growth', () => {
    const q = points.map((r, i) => i === 1 ? { ...r, netProfitYoY: .01 } : r);
    assert.equal(signal(run({ points: q }), 'earnings_delivery').state, 'not_triggered');
  });
  check('missing/semiannual/provisional quarters cannot pass', () => {
    for (const q of [points.slice(0, 1), points.map((r, i) => i === 1 ? { ...r, reportDate: '2025-12-31' } : r), points.map((r, i) => i === 0 ? { ...r, provisional: true } : r)]) {
      assert.equal(signal(run({ points: q }), 'earnings_delivery').state, 'insufficient_data');
    }
  });
  check('financial and cyclical models do not use generic PEG or peak TTM growth', () => {
    for (const archetype of ['bank', 'insurer', 'cyclical_commodity']) {
      const o = run({ archetype }); assert.equal(signal(o, 'earnings_delivery').state, 'not_applicable');
      assert.equal(signal(o, 'historical_discount').state, 'not_applicable'); assert.notEqual(o.stage, 'research_candidate');
    }
  });
  check('high growth does not override expensive valuation', () => {
    const o = run({ assessment: { ...assessment, status: 'very_expensive', current: 80 } });
    assert.equal(signal(o, 'earnings_delivery').state, 'triggered'); assert.equal(o.stage, 'clue');
  });
  check('negative cashflow and shrinking profits block a candidate', () => {
    assert.equal(run({ cashflowTtm: -1 }).stage, 'blocked');
    assert.equal(run({ assessment: { ...assessment, operating: { ttmGrowth: -.3 } } }).stage, 'blocked');
  });
  check('unknown quality data is not a pass', () => {
    for (const overrides of [{ debtRatio: null }, { cashflowTtm: null }, { cashflowReportDate: '2025-12-31' }, { points: points.slice(0, 2) }, { debtRatio: .9 }, { cashflowTtm: 20 }, { assessment: { ...assessment, operating: { ttmGrowth: null } } }]) assert.notEqual(run(overrides).stage, 'research_candidate');
  });
  check('missing or stale data invalidates candidate even if raw clues trigger', () => {
    for (const date of [null, 'invalid', '2025-01-01', '2027-01-01']) assert.equal(run({ assessment: { ...assessment, quote: { date } } }).stage, 'insufficient_data');
    assert.equal(run({ blockReasons: ['currency_mismatch'] }).stage, 'insufficient_data');
    assert.equal(run({ assessment: null }).stage, 'insufficient_data');
  });
  check('unadjusted prices, duplicates, null closes never manufacture crash signals', () => {
    for (const bars of [adjustedBars.map((r) => ({ ...r, fq: 'normal' })), [...adjustedBars.slice(0, 252), adjustedBars[251]], adjustedBars.map((r, i) => i === 252 ? { ...r, close: null } : r), []]) {
      const m = priceOpportunityMetrics(bars, policy, now); assert(m.returns.every((r) => r.value === null)); assert.equal(m.drawdown252, null);
    }
    const flat = adjustedBars.map((r) => ({ ...r, close: 100 }));
    assert.equal(signal(run({ adjustedBars: flat }), 'drawdown').state, 'not_triggered');
  });
  check('short IPO histories do not fill missing windows with zero', () => {
    const bars = adjustedBars.slice(-30).map((r) => ({ ...r, close: 100 }));
    const o = run({ adjustedBars: bars }); assert.equal(o.price.returns[0].value, 0); assert.equal(o.price.returns[1].value, null);
    assert.equal(signal(o, 'drawdown').state, 'insufficient_data');
  });
  check('future/stale adjusted prices are rejected', () => {
    for (const shift of [-365 * 86400000, 365 * 86400000]) {
      const bars = adjustedBars.map((r) => ({ ...r, date: new Date(Date.parse(r.date) + shift).toISOString().slice(0, 10) }));
      assert.equal(signal(run({ adjustedBars: bars }), 'drawdown').state, 'insufficient_data');
    }
  });
  return { opportunityRules: 'passed', cases: checks, policy: policy.version };
}
