import assert from 'node:assert/strict'
import test from 'node:test'

import { assessInstitutionalTrackBuyRecommendation } from './institutional-track-buy-recommendation.ts'

const policy = { companyCapPct: 15, themeCapPct: 20, industryCapPct: 25, minimumReportCount: 3, minimumInvalidationCount: 2 }
const candidate = { code: '600000.SH', secondaryTrack: '银行', concepts: ['高股息'] }
const plan = { fairValueLow: 10, fairValueHigh: 12, targetWeightPct: 10, invalidations: ['净息差持续恶化', '资本充足率低于门槛'], tranchePlan: '分两笔，价格进入价值区间后执行。', evidenceReviewed: true, financialRiskReviewed: true }
const input = { valuationState: 'value', confidence: '高', financeDate: '2026-04-30', reportCount: 3, policy, candidate, plan }

test('a green valuation is not a buy plan until plan and portfolio gates pass', () => {
  assert.equal(assessInstitutionalTrackBuyRecommendation({ ...input, plan: null, portfolio: null }).state, 'needs-plan')
  assert.equal(assessInstitutionalTrackBuyRecommendation({ ...input, portfolio: null }).state, 'needs-portfolio')
})

test('concentration limits block a plan that would exceed an overlapping theme', () => {
  const result = assessInstitutionalTrackBuyRecommendation({ ...input, portfolio: {
    cashWeightPct: 30,
    hasUnmappedPositions: false,
    positions: [{ code: '600001.SH', weightPct: 15, secondaryTrack: '其他', concepts: ['高股息'] }],
  } })
  assert.equal(result.state, 'portfolio-blocked')
  assert.match(result.reasons.join('\n'), /主题/)
})

test('only a complete plan and compliant portfolio become plan-ready', () => {
  const result = assessInstitutionalTrackBuyRecommendation({ ...input, portfolio: { cashWeightPct: 20, hasUnmappedPositions: false, positions: [] } })
  assert.equal(result.state, 'plan-ready')
  assert.equal(result.additionalWeightPct, 10)
})

test('financial candidates require an explicit asset-quality or solvency review', () => {
  const result = assessInstitutionalTrackBuyRecommendation({ ...input, requiresFinancialRiskReview: true, plan: { ...plan, financialRiskReviewed: false }, portfolio: { cashWeightPct: 20, hasUnmappedPositions: false, positions: [] } })
  assert.equal(result.state, 'needs-plan')
})
