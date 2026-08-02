import assert from 'node:assert/strict'
import test from 'node:test'

import { calculateLookbackRangePosition } from './institutional-track-performance.ts'

test('calculates drawdown from the range high and gain from the range low', () => {
  assert.deepEqual(calculateLookbackRangePosition([
    { close: 100, high: 105, low: 95 },
    { close: 110, high: 120, low: 90 },
    { close: 108, high: 115, low: 100 },
  ], 3), { drawdownPct: 10, gainPct: 20 })
})

test('returns null when the complete trading-day range is unavailable', () => {
  assert.equal(calculateLookbackRangePosition([
    { close: 100, high: 105, low: 95 },
    { close: 120, high: 125, low: null },
  ], 2), null)
})
