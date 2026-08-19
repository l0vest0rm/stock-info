import assert from 'node:assert/strict'
import test from 'node:test'
import {
  calculateStrategyMetrics,
  intrinsicValue,
  strategyPayoffAtExpiry,
} from './strategy-calculator.ts'

const date = new Date('2026-08-19T12:00:00')

test('long call calculates breakeven, time cost, and expiry distance', () => {
  const legs = [{ id: '1', side: 'buy', type: 'call', strike: 100, expiration: '2026-09-18', premium: 5, quantity: 1, multiplier: 100 }]
  const metrics = calculateStrategyMetrics(legs, 98, date)
  assert.deepEqual(metrics.breakevens, [105])
  assert.equal(metrics.netPremiumCash, 500)
  assert.equal(metrics.timeCostCash, 500)
  assert.equal(metrics.minimumDaysToExpiry, 30)
  assert.equal(strategyPayoffAtExpiry(legs, 110), 500)
})

test('short put has signed time income and bounded expiry payoff', () => {
  const legs = [{ id: '1', side: 'sell', type: 'put', strike: 100, expiration: '2026-09-18', premium: 4, quantity: 1, multiplier: 100 }]
  const metrics = calculateStrategyMetrics(legs, 102, date)
  assert.deepEqual(metrics.breakevens, [96])
  assert.equal(metrics.netPremiumCash, -400)
  assert.equal(metrics.timeCostCash, -400)
  assert.equal(intrinsicValue('put', 90, 100), 10)
  assert.equal(strategyPayoffAtExpiry(legs, 90), -600)
})
