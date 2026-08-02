import assert from 'node:assert/strict'
import test from 'node:test'

import { assessInstitutionalTrackGrowthValuation } from './institutional-track-growth-valuation.ts'

const pegThresholds = { strongBuy: 0.6, buy: 1, watch: 1.5, noAdd: 2 }
const peThresholds = { strongBuy: 15, buy: 25, watch: 40, noAdd: 60 }

function assess(marketCapYi, forecasts) {
  return assessInstitutionalTrackGrowthValuation({
    marketCapYi,
    forecasts,
    incomeRows: [],
    baseForecastYear: 2026,
    targetForecastYear: 2028,
    pegThresholds,
    peThresholds,
  })
}

test('same PEG does not give PE 10 and PE 100 the same risk state', () => {
  const lowPe = assess(1_000, [
    { year: 2026, netProfit: 100, profitGrowth: 11.1111 },
    { year: 2027, netProfit: 111.1111 },
    { year: 2028, netProfit: 123.4568 },
  ])
  const highPe = assess(10_000, [
    { year: 2026, netProfit: 100, profitGrowth: 111.1111 },
    { year: 2027, netProfit: 211.1111 },
    { year: 2028, netProfit: 445.679 },
  ])

  assert.ok(Math.abs(lowPe.peg - 0.9) < 0.01)
  assert.ok(Math.abs(highPe.peg - 0.9) < 0.01)
  assert.equal(lowPe.state, 'value')
  assert.equal(highPe.state, 'overvalued')
  assert.equal(highPe.peState, 'overvalued')
})

test('uses a complete published annual result to calculate the first forecast-year growth', () => {
  const result = assessInstitutionalTrackGrowthValuation({
    marketCapYi: 1_000,
    forecasts: [
      { year: 2026, netProfit: 110 },
      { year: 2027, netProfit: 121 },
      { year: 2028, netProfit: 133.1 },
    ],
    incomeRows: [
      { reportDate: '2025-03-31', parentNetprofit: 2_500_000_000, dataSource: 'financial_report' },
      { reportDate: '2025-06-30', parentNetprofit: 2_500_000_000, dataSource: 'financial_report' },
      { reportDate: '2025-09-30', parentNetprofit: 2_500_000_000, dataSource: 'financial_report' },
      { reportDate: '2025-12-31', parentNetprofit: 2_500_000_000, dataSource: 'financial_report' },
    ],
    baseForecastYear: 2026,
    targetForecastYear: 2028,
    pegThresholds,
    peThresholds,
  })

  assert.equal(result.status, 'rated')
  assert.equal(result.pathComplete, true)
  assert.ok(Math.abs(result.path[0].profitGrowth - 10) < 1e-10)
  assert.match(result.reason, /2025A 实际净利/)
})

test('an intervening decline is not hidden by a later rebound', () => {
  const stable = assess(2_500, [
    { year: 2026, netProfit: 100, profitGrowth: 50 },
    { year: 2027, netProfit: 150 },
    { year: 2028, netProfit: 225 },
  ])
  const declineThenRebound = assess(2_500, [
    { year: 2026, netProfit: 100, profitGrowth: 50 },
    { year: 2027, netProfit: 80 },
    { year: 2028, netProfit: 225 },
  ])

  assert.equal(stable.status, 'rated')
  assert.equal(declineThenRebound.status, 'growth-unstable')
  assert.ok(Math.abs(declineThenRebound.path[1].profitGrowth - (-20)) < 1e-10)
  assert.match(declineThenRebound.reason, /不能用后续反弹抵消/)
})

test('uneven positive growth lowers the growth rate used by PEG', () => {
  const result = assess(2_500, [
    { year: 2026, netProfit: 100, profitGrowth: 50 },
    { year: 2027, netProfit: 110 },
    { year: 2028, netProfit: 225 },
  ])

  assert.equal(result.status, 'rated')
  assert.ok(result.adjustedGrowth < result.endpointCagr)
  assert.ok(result.peg > result.baseForwardPe / result.endpointCagr)
})

test('every forecast year is required instead of skipping the middle year', () => {
  const result = assess(2_500, [
    { year: 2026, netProfit: 100, profitGrowth: 50 },
    { year: 2028, netProfit: 225 },
  ])

  assert.equal(result.status, 'unavailable')
  assert.match(result.reason, /2027E/)
})
