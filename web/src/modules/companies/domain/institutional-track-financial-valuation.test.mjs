import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assessInstitutionalTrackBankShareholderReturn,
  assessInstitutionalTrackCycleValuation,
  assessInstitutionalTrackFinancialValuation,
} from './institutional-track-financial-valuation.ts'

const pbThresholds = { strongBuy: 0.8, buy: 1, watch: 1.3, noAdd: 1.6 }
const roeThresholds = { strongBuy: 12, buy: 10, watch: 8, noAdd: 6 }
const incomeRows = [
  { reportDate: '2026-03-31', parentNetprofit: 30_000_000_000 },
  { reportDate: '2025-12-31', parentNetprofit: 30_000_000_000 },
  { reportDate: '2025-09-30', parentNetprofit: 30_000_000_000 },
  { reportDate: '2025-06-30', parentNetprofit: 30_000_000_000 },
  { reportDate: '2025-03-31', parentNetprofit: 28_000_000_000 },
  { reportDate: '2024-12-31', parentNetprofit: 28_000_000_000 },
  { reportDate: '2024-09-30', parentNetprofit: 28_000_000_000 },
  { reportDate: '2024-06-30', parentNetprofit: 28_000_000_000 },
  { reportDate: '2024-03-31', parentNetprofit: 28_000_000_000 },
  { reportDate: '2023-12-31', parentNetprofit: 28_000_000_000 },
  { reportDate: '2023-09-30', parentNetprofit: 28_000_000_000 },
  { reportDate: '2023-06-30', parentNetprofit: 28_000_000_000 },
]
const balanceRows = [
  { reportDate: '2026-03-31', totalParentEquity: 1_000_000_000_000 },
  { reportDate: '2025-03-31', totalParentEquity: 900_000_000_000 },
]

test('PB-ROE takes the more conservative PB and profitability state', () => {
  const result = assessInstitutionalTrackFinancialValuation({ pb: 0.7, incomeRows, balanceRows, pbThresholds, roeThresholds })
  assert.equal(result.status, 'rated')
  assert.equal(result.roe, 120 / 950 * 100)
  assert.equal(result.state, 'deep-value')

  const lowRoe = assessInstitutionalTrackFinancialValuation({
    pb: 0.7,
    incomeRows: incomeRows.map((row) => ({ ...row, parentNetprofit: Number(row.parentNetprofit) / 3 })),
    balanceRows,
    pbThresholds,
    roeThresholds,
  })
  assert.equal(lowRoe.state, 'overvalued')
})

test('financial model refuses PB-only conclusion without a four-quarter profit and equity history', () => {
  const result = assessInstitutionalTrackFinancialValuation({ pb: 0.7, incomeRows: incomeRows.slice(0, 3), balanceRows, pbThresholds, roeThresholds })
  assert.equal(result.status, 'unavailable')
  assert.match(result.reason, /四个单季/)
})

test('bank shareholder-return model uses dividend yield as the anchor and PB-ROE as a guardrail', () => {
  const financial = assessInstitutionalTrackFinancialValuation({ pb: 0.7, incomeRows, balanceRows, pbThresholds, roeThresholds })
  const thresholds = { strongBuyYieldPct: 5, buyYieldPct: 4, watchYieldPct: 3, minimumProfitCagrPct: -5 }
  const result = assessInstitutionalTrackBankShareholderReturn({ dividendYield: 5.5, profitCagr: 2, financial, thresholds })
  assert.equal(result.status, 'rated')
  assert.equal(result.state, 'deep-value')

  const declining = assessInstitutionalTrackBankShareholderReturn({ dividendYield: 5.5, profitCagr: -1, financial, thresholds })
  assert.equal(declining.state, 'value')

  const unsustainable = assessInstitutionalTrackBankShareholderReturn({ dividendYield: 5.5, profitCagr: -6, financial, thresholds })
  assert.equal(unsustainable.state, 'income-stagnant')
})

test('cycle model uses the median of three trailing-year profit windows', () => {
  const result = assessInstitutionalTrackCycleValuation({ marketCapYi: 12_000, incomeRows, normalizedPeThresholds: { strongBuy: 8, buy: 12, watch: 18, noAdd: 25 } })
  assert.equal(result.status, 'rated')
  assert.equal(result.normalizedPe, 12_000 / 1_120)
  assert.equal(result.state, 'value')
})
