import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { financeDisplayIncomeRows } from '../web/src/modules/company/domain/finance-display-series.ts';

const quarter = (reportDate, income) => ({ reportDate, income, FINANCIAL_SOURCE_CONTRACT: 'eastmoney_f10_incomeqc.v1' });
const cumulative = (reportDate, income) => ({ reportDate, income, FINANCIAL_SOURCE_CONTRACT: 'eastmoney_f10_income.v1' });
const quarters = [quarter('2026-09-30', 30), quarter('2026-06-30', 20), quarter('2026-03-31', 10)];
const mixed = [cumulative('2026-09-30', 60), quarters[0], cumulative('2026-06-30', 30), quarters[1], cumulative('2026-03-31', 10), quarters[2]];
const original = structuredClone(mixed);
for (const rows of [mixed, [...mixed].reverse()]) {
  assert.deepEqual(financeDisplayIncomeRows(rows), quarters, 'select the single-quarter family before date de-duplication, independent of provider family order');
  const yearly = financeDisplayIncomeRows(rows, true);
  assert.equal(yearly.reduce((total, row) => total + row.income, 0), 60, 'yearly formatter must not add cumulative rows to quarters');
}
assert.deepEqual(mixed, original, 'never remove cumulative rows or reorder the shared API cache');
assert.notEqual(financeDisplayIncomeRows(mixed), mixed);

const hk = [cumulative('2025-12-31', 100), cumulative('2026-06-30', 60), cumulative('2025-12-31', 999), cumulative('2025-06-30', 45)];
assert.deepEqual(financeDisplayIncomeRows(hk).map(row => row.income), [60, 100, 45], 'cumulative-only markets stay visible without duplicate dates');
assert.deepEqual(financeDisplayIncomeRows(hk, true).map(row => row.income), [60, 100], 'annual display must not add overlapping cumulative interims');

const legacy = [
  { reportDate: '2026-06-30', REPORT_TYPE: '中报', income: 30 },
  { reportDate: '2026-06-30', REPORT_TYPE: '二季度', income: 20 },
  { reportDate: '2026-03-31', REPORT_TYPE: '一季度', income: 10 },
];
assert.deepEqual(financeDisplayIncomeRows(legacy).map(row => row.income), [20, 10]);
const us = [
  { reportDate: '2025-12-31', FISCAL_PERIOD: '12M', FINANCIAL_SOURCE_CONTRACT: 'yahoo_finance_timeseries.v3', income: 100 },
  { reportDate: '2025-12-31', FISCAL_PERIOD: '3M', FINANCIAL_SOURCE_CONTRACT: 'yahoo_finance_timeseries.v3', income: 25 },
];
assert.deepEqual(financeDisplayIncomeRows(us).map(row => row.income), [25], 'Yahoo duration is explicit, not an inferred quarter');
assert.deepEqual(financeDisplayIncomeRows([{ reportDate: null }, { reportDate: 'bad' }]), []);
const runtime = readFileSync(new URL('../web/src/platform/legacy/legacy-runtime.ts', import.meta.url), 'utf8');
assert.match(runtime, /const cacheData = financeDisplayIncomeRows\(cache\[cacheKey\] as any\[\], compareType === 'yearly'\)/);
console.log('finance display series: family selection, unique dates, annual arithmetic, cumulative-only, immutability and runtime wiring passed');
