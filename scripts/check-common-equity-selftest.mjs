// Retained assertion coverage; all domain computations execute in native Rust.
import { callRustSelftest } from './lib/rust-analysis.mjs';
const commonEquity = (...args) => callRustSelftest('commonEquity', ...args);
const buildValuationInputs = (...args) => callRustSelftest('buildValuationInputs', ...args);
const buildValuationBands = (...args) => callRustSelftest('buildValuationBands', ...args);
import assert from 'node:assert/strict';



const facts = { TOTAL_PARENT_EQUITY: 1345033000000, OTHER_EQUITY_TOOL: 199989000000, PERPETUAL_BOND: 199989000000, PREFERRED_SHARES: null };
const cap = 1062512095170;
assert.equal(commonEquity(facts).value, 1145044000000, 'aggregate is subtracted once');
assert.equal(commonEquity({ TOTAL_PARENT_EQUITY: 100, OTHER_EQUITY_TOOL: 0 }).value, 100);
assert.equal(commonEquity({ TOTAL_PARENT_EQUITY: 100, PREFERRED_SHARES: 10, PERPETUAL_BOND: 20 }).value, 70);
assert.equal(commonEquity({ TOTAL_PARENT_EQUITY: 100, OTHER_EQUITY_TOOL: null }), null);
assert.equal(commonEquity({ TOTAL_PARENT_EQUITY: 100, PREFERRED_SHARES: null, PERPETUAL_BOND: 20 }), null);
assert.equal(commonEquity({ TOTAL_EQUITY: 100 }), null, 'no consolidated equity fallback');
for (const adjustment of [-1, 100, 101]) assert.equal(commonEquity({ TOTAL_PARENT_EQUITY: 100, OTHER_EQUITY_TOOL: adjustment }), null);
assert.equal(commonEquity({ TOTAL_PARENT_EQUITY: 100, OTHER_EQUITY_INVEST: 50 }).value, 100, 'investments are assets, not instruments');
const balance = { code: '600036.SH', statementType: 'balance', reportDate: '2026-06-30', payload: facts };
const none = { latest: null, priorYearSamePeriod: null };
const inputs = buildValuationInputs({ code: balance.code, income: none, balance: { ...none, latest: balance }, cashflow: none, balanceSheetArchetype: 'bank' });
const line = (key) => inputs.lines.find((v) => v.key === key);
assert.equal(line('parentEquity').value, facts.TOTAL_PARENT_EQUITY);
assert.deepEqual(line('commonEquity').sourceFields, ['TOTAL_PARENT_EQUITY', 'OTHER_EQUITY_TOOL']);
const bandInput = { code: balance.code, archetype: 'bank', asOf: { balance: balance.reportDate, income: null, cashflow: null }, ttm: {}, balance: { parentEquity: facts.TOTAL_PARENT_EQUITY, commonEquity: line('commonEquity').value }, marketCap: cap };
const pb = buildValuationBands(bandInput).bands.find((b) => b.key === 'pb');
assert.equal((cap / pb.denominator.value).toFixed(2), '0.93');
assert.equal(buildValuationBands({ ...bandInput, balance: { parentEquity: facts.TOTAL_PARENT_EQUITY } }).bands.find((b) => b.key === 'pb').status, 'insufficient_data');
const value = callRustSelftest('deriveLatestFinancialValuation', { marketCapitalization: cap, availableAt: '2026-10-28', incomeRows: [], balanceRows: [balance], cashflowRows: [] });
assert.equal(value.pb, cap / pb.denominator.value, 'generic PB and bands agree');
console.log('common-equity regression checks passed');
