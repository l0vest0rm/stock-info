import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { analyzeStopLoss, recommendPosition } from '../../web/src/modules/companies/domain/stop-loss-analysis.ts'

const config = JSON.parse(await readFile(new URL('../../web/src/config/companies-follow-risk.json', import.meta.url), 'utf8'))

function barsFromCloses(closes) {
  return closes.map((close, index) => [
    Date.UTC(2026, 0, index + 1),
    close,
    close,
    close + 0.4,
    close - 0.4,
  ])
}

test('stop-loss analysis rejects insufficient valid bars', () => {
  const rows = [
    ...barsFromCloses(Array.from({ length: 64 }, (_, index) => 100 + index)),
    [Date.UTC(2026, 3, 1), 0, 0, 0, 0],
  ]
  assert.deepEqual(analyzeStopLoss(rows, config), { available: false, validBars: 64 })
})

test('falling series triggers all six risk signals and the prior support rule', () => {
  const result = analyzeStopLoss(barsFromCloses(Array.from({ length: 65 }, (_, index) => 100 - index)), config)
  assert.equal(result.available, true)
  if (!result.available) return
  assert.equal(result.close, 36)
  assert.equal(result.riskLevel, 'high')
  assert.equal(result.riskScore, 6)
  assert.equal(result.supportBroken, true)
  assert.ok(Math.abs(result.priorSupport - 36.6) < 1e-9)
  assert.ok(Math.abs(result.return20Pct - -35.71428571428571) < 1e-9)
  assert.ok(Math.abs(result.drawdown60Pct - -62.10526315789473) < 1e-9)
})

test('rising series stays stable and produces a volatility-aware reference stop', () => {
  const result = analyzeStopLoss(barsFromCloses(Array.from({ length: 65 }, (_, index) => 36 + index)), config)
  assert.equal(result.available, true)
  if (!result.available) return
  assert.equal(result.close, 100)
  assert.equal(result.riskLevel, 'stable')
  assert.equal(result.riskScore, 0)
  assert.equal(result.supportBroken, false)
  assert.ok(Math.abs(result.stopPrice - 95.8) < 1e-9)
})

test('one or two risk signals map to take-profit instead of a stop-loss', () => {
  const rows = barsFromCloses(Array.from({ length: 65 }, (_, index) => 36 + index))
  rows[64][1] = 85
  rows[64][3] = 100.4
  rows[64][4] = 84.6
  const result = analyzeStopLoss(rows, config)
  assert.equal(result.available, true)
  if (!result.available) return
  assert.equal(result.riskLevel, 'weak')
  assert.ok(result.riskScore >= 1 && result.riskScore <= 2)
})

test('empty stable position builds one tranche from the risk-sized maximum', () => {
  const analysis = analyzeStopLoss(barsFromCloses(Array.from({ length: 65 }, (_, index) => 36 + index)), config)
  const recommendation = recommendPosition(analysis, {
    currentPositionPct: 0,
    costPrice: null,
    accountRiskPct: 0.8,
    maxStockPositionPct: 10,
  }, { ...config.positionSizing, overextendedAtr: 100 })
  assert.equal(recommendation.action, 'build')
  assert.equal(recommendation.reason, 'trend')
  assert.ok(Math.abs(recommendation.riskBasedMaxPositionPct - 10) < 1e-9)
  assert.ok(Math.abs(recommendation.suggestedPositionPct - 10 / 3) < 1e-9)
})

test('stable holding adds, holds, or reduces according to the risk-sized maximum', () => {
  const analysis = analyzeStopLoss(barsFromCloses(Array.from({ length: 65 }, (_, index) => 36 + index)), config)
  const input = { costPrice: 90, accountRiskPct: 0.8, maxStockPositionPct: 10 }
  const sizing = { ...config.positionSizing, overextendedAtr: 100 }
  assert.equal(recommendPosition(analysis, { ...input, currentPositionPct: 1 }, sizing).action, 'add')
  assert.equal(recommendPosition(analysis, { ...input, currentPositionPct: 10 }, sizing).action, 'hold')
  const oversized = recommendPosition(analysis, { ...input, currentPositionPct: 15 }, sizing)
  assert.equal(oversized.action, 'reduce')
  assert.equal(oversized.reason, 'position')
  assert.equal(oversized.suggestedPositionPct, 10)
})

test('confirmed support break exits and distinguishes profit protection from stop loss', () => {
  const analysis = analyzeStopLoss(barsFromCloses(Array.from({ length: 65 }, (_, index) => 100 - index)), config)
  const base = { currentPositionPct: 8, accountRiskPct: 0.8, maxStockPositionPct: 10 }
  const losing = recommendPosition(analysis, { ...base, costPrice: 40 }, config.positionSizing)
  const profitable = recommendPosition(analysis, { ...base, costPrice: 20 }, config.positionSizing)
  assert.deepEqual([losing.action, losing.reason, losing.suggestedPositionPct], ['exit', 'stopLoss', 0])
  assert.deepEqual([profitable.action, profitable.reason, profitable.suggestedPositionPct], ['exit', 'takeProfit', 0])
})

test('normalization sorts rows, deduplicates timestamps, and filters invalid OHLC', () => {
  const rows = barsFromCloses(Array.from({ length: 65 }, (_, index) => 36 + index))
  rows.push([...rows[10]])
  rows.push([Date.UTC(2027, 0, 1), 100, 100, 0, 99])
  rows.reverse()
  const result = analyzeStopLoss(rows, config)
  assert.equal(result.available, true)
  if (!result.available) return
  assert.equal(result.validBars, 65)
  assert.equal(result.close, 100)
  assert.equal(result.riskScore, 0)
})
