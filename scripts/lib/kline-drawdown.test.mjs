import assert from 'node:assert/strict'
import test from 'node:test'

import { calculateKlineDrawdowns } from '../../web/src/modules/market/domain/kline-drawdown.ts'

test('calculates completed and active high-to-low drawdown episodes', () => {
  const segments = calculateKlineDrawdowns([
    {x: '01-01', high: 10, low: 10},
    {x: '01-02', high: 9, low: 8},
    {x: '01-03', high: 10, low: 9},
    {x: '01-04', high: 12, low: 10},
    {x: '01-05', high: 11, low: 9},
  ])

  assert.deepEqual(segments.map(({peakX, troughX, percent}) => ({
    peakX,
    troughX,
    percent: Number(percent.toFixed(8)),
  })), [
    {peakX: '01-01', troughX: '01-02', percent: -20},
    {peakX: '01-04', troughX: '01-05', percent: -25},
  ])
})

test('keeps only the deepest trough before a running high is recovered', () => {
  const segments = calculateKlineDrawdowns([
    {x: 1, high: 20, low: 20},
    {x: 2, high: 19, low: 18},
    {x: 3, high: 19.5, low: 17},
    {x: 4, high: 20.5, low: 19},
  ])

  assert.equal(segments.length, 1)
  assert.equal(segments[0].troughX, 3)
  assert.ok(Math.abs(segments[0].percent - -15) < 1e-9)
})

test('does not infer the intraday order of a high and low on the same bar', () => {
  assert.deepEqual(calculateKlineDrawdowns([
    {x: 1, high: 10, low: 8},
    {x: 2, high: 11, low: 9},
  ]), [])
})
