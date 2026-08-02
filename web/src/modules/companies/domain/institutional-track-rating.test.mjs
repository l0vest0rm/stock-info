import assert from 'node:assert/strict'
import test from 'node:test'

import { assessInstitutionalTrackRating } from './institutional-track-rating.ts'

test('maps valuation conclusions to institutional-style ratings', () => {
  const cases = [
    ['deep-value', '买入'],
    ['value', '增持'],
    ['fair', '持有'],
    ['expensive', '减持'],
    ['overvalued', '卖出'],
    ['growth-unstable', '减持'],
    ['income-stagnant', '卖出'],
    ['unavailable', '数据不足'],
  ]
  for (const [valuationState, label] of cases) {
    assert.equal(assessInstitutionalTrackRating({ valuationState, confidence: '高' }).label, label)
  }
})

test('does not issue a rating when the evidence confidence is low', () => {
  const rating = assessInstitutionalTrackRating({ valuationState: 'value', confidence: '低' })
  assert.equal(rating.state, 'insufficient')
  assert.equal(rating.label, '数据不足')
})
