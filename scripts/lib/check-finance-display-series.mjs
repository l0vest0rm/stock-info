import assert from 'node:assert/strict';
import { financeDisplayIncomeRows } from '../../web/src/modules/company/domain/finance-display-series.ts';

export function checkFinanceDisplaySeries() {
  const row = (date, revenue, quarter = false, extra = {}) => ({
    reportDate: date, totalOperateIncome: revenue,
    FINANCIAL_SOURCE_CONTRACT: quarter ? 'eastmoney_f10_incomeqc.v1' : 'eastmoney_f10_income.v1',
    ...extra,
  });
  // Screenshot regression: cumulative and quarterly rows share each report date.
  const mixed = [
    row('2026-09-30', 318), row('2026-09-30', 109, true),
    row('2026-06-30', 209), row('2026-06-30', 125, true),
    row('2026-03-31', 84), row('2026-03-31', 84, true),
  ];
  const before = JSON.stringify(mixed);
  const selected = financeDisplayIncomeRows(mixed);
  assert.deepEqual(selected.map(r => r.reportDate), ['2026-09-30', '2026-06-30', '2026-03-31']);
  assert.deepEqual(selected.map(r => r.totalOperateIncome), [109, 125, 84]);
  assert.equal(selected.reduce((sum, r) => sum + r.totalOperateIncome, 0), 318, 'yearly mode must not double count cumulative income');
  assert.equal(JSON.stringify(mixed), before, 'raw API/cache must remain available to other consumers');
  assert.deepEqual(financeDisplayIncomeRows([...mixed].reverse()), selected, 'sort newest first');
  assert.equal(financeDisplayIncomeRows([row('2026-12-31', 500), ...mixed]).length, 3, 'missing quarter must not be filled with FY cumulative');
  assert.deepEqual(financeDisplayIncomeRows([]), []);
  const hk = [row('2026-06-30', 200, false, { FINANCIAL_SOURCE_CONTRACT: 'eastmoney_hk_f10_main_indicator.v2' })];
  assert.deepEqual(financeDisplayIncomeRows(hk), hk, 'preserve cumulative-only markets');
  const legacy = [{ reportDate: '2026-06-30', REPORT_TYPE: '中报' }, { reportDate: '2026-06-30', REPORT_TYPE: '二季度' }];
  assert.deepEqual(financeDisplayIncomeRows(legacy), [legacy[1]]);
  const revised = row('2026-09-30', 110, true, { noticeDate: '2026-10-31' });
  assert.equal(financeDisplayIncomeRows([...mixed, revised])[0], revised, 'same-family revisions only appear once');
  return { financeDisplaySeries: 'passed' };
}
