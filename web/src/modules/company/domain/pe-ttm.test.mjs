import assert from 'node:assert/strict'
import test from 'node:test'

import { trailingQuarterlyParentNetProfits } from './pe-ttm.ts'

const sunshinePowerIncome = [
  { reportDate: '2026-03-31', noticeDate: '2026-04-28', REPORT_TYPE: '一季度', parentNetprofit: 2_291_269_562.74 },
  { reportDate: '2025-12-31', noticeDate: '2026-04-01', FISCAL_PERIOD: '12M', REPORT_TYPE: '年报', parentNetprofit: 13_461_279_955.37 },
  { reportDate: '2025-12-31', noticeDate: '2026-04-01', REPORT_TYPE: '四季度', parentNetprofit: 1_580_056_344.03 },
  { reportDate: '2025-09-30', noticeDate: '2025-10-29', REPORT_TYPE: '三季度', parentNetprofit: 4_146_645_663.49 },
  { reportDate: '2025-06-30', noticeDate: '2025-08-26', REPORT_TYPE: '二季度', parentNetprofit: 3_908_417_030.52 },
  { reportDate: '2025-03-31', noticeDate: '2025-04-26', REPORT_TYPE: '一季度', parentNetprofit: 3_826_160_917.33 },
  { reportDate: '2024-12-31', noticeDate: '2025-04-26', REPORT_TYPE: '四季度', parentNetprofit: 3_436_725_899.67 },
]

test('uses four consecutive quarterly profits instead of double-counting the annual row', () => {
  const profits = trailingQuarterlyParentNetProfits(sunshinePowerIncome)
  const ttmProfit = profits.reduce((sum, value) => sum + value, 0)
  assert.deepEqual(profits, [2_291_269_562.74, 1_580_056_344.03, 4_146_645_663.49, 3_908_417_030.52])
  assert.equal(ttmProfit.toFixed(2), '11926388600.78')
  assert.equal((114.16 * 2_073_211_424 / ttmProfit).toFixed(2), '19.84')
})

test('does not use reports before they were disclosed for historical PE(TTM)', () => {
  const asOf = Date.parse('2026-03-31T00:00:00Z')
  assert.deepEqual(trailingQuarterlyParentNetProfits(sunshinePowerIncome, asOf), [
    4_146_645_663.49,
    3_908_417_030.52,
    3_826_160_917.33,
    3_436_725_899.67,
  ])
})
