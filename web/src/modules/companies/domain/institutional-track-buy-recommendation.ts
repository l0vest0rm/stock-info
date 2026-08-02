export type BuyRecommendationState = 'not-eligible' | 'needs-evidence' | 'needs-plan' | 'needs-portfolio' | 'portfolio-blocked' | 'plan-ready'

export type BuyRecommendationPlan = {
  fairValueLow: number | null
  fairValueHigh: number | null
  targetWeightPct: number | null
  invalidations: string[]
  tranchePlan: string
  evidenceReviewed: boolean
  financialRiskReviewed: boolean
}

export type BuyRecommendationPosition = {
  code: string
  weightPct: number
  secondaryTrack: string | null
  concepts: string[]
}

export type BuyRecommendationResult = {
  state: BuyRecommendationState
  label: string
  reasons: string[]
  additionalWeightPct: number | null
  companyHeadroomPct: number | null
  industryHeadroomPct: number | null
  themeHeadroomPct: number | null
}

type Input = {
  valuationState: string
  confidence: '高' | '中' | '低'
  financeDate: string
  reportCount: number
  plan: BuyRecommendationPlan | null
  portfolio: { cashWeightPct: number | null; positions: BuyRecommendationPosition[]; hasUnmappedPositions: boolean } | null
  candidate: { code: string; secondaryTrack: string; concepts: string[] }
  requiresFinancialRiskReview?: boolean
  policy: { companyCapPct: number; themeCapPct: number; industryCapPct: number; minimumReportCount: number; minimumInvalidationCount: number }
}

function result(state: BuyRecommendationState, label: string, reasons: string[], values: Partial<BuyRecommendationResult> = {}): BuyRecommendationResult {
  return { state, label, reasons, additionalWeightPct: null, companyHeadroomPct: null, industryHeadroomPct: null, themeHeadroomPct: null, ...values }
}

function positive(value: number | null): boolean { return value !== null && Number.isFinite(value) && value > 0 }

export function assessInstitutionalTrackBuyRecommendation(input: Input): BuyRecommendationResult {
  if (input.valuationState === 'unavailable') return result('not-eligible', '数据不足', ['估值模型没有得到可复核结论。'])
  if (!['deep-value', 'value'].includes(input.valuationState)) return result('not-eligible', '暂不新增', ['当前估值状态未达到“显著低估”或“估值偏低”。'])
  if (input.confidence !== '高' || !input.financeDate || input.reportCount < input.policy.minimumReportCount) {
    return result('needs-evidence', '需补证据', [`需要最新财报且至少 ${input.policy.minimumReportCount} 份可追溯研报；当前为财报 ${input.financeDate || '缺失'}、研报 ${input.reportCount} 份、置信度 ${input.confidence}。`])
  }
  const plan = input.plan
  if (!plan || !positive(plan.fairValueLow) || !positive(plan.fairValueHigh) || plan.fairValueLow! > plan.fairValueHigh! || !positive(plan.targetWeightPct) || plan.targetWeightPct! > input.policy.companyCapPct || plan.invalidations.filter(Boolean).length < input.policy.minimumInvalidationCount || !plan.tranchePlan.trim() || !plan.evidenceReviewed || (input.requiresFinancialRiskReview && !plan.financialRiskReviewed)) {
    return result('needs-plan', '创建买入计划', [`填写保守价值区间、目标仓位（不高于 ${input.policy.companyCapPct}%）、至少 ${input.policy.minimumInvalidationCount} 项证伪条件、分批计划，并完成新闻/公告复核${input.requiresFinancialRiskReview ? '与金融专项风险复核' : ''}。`])
  }
  const portfolio = input.portfolio
  if (!portfolio || portfolio.cashWeightPct === null || portfolio.hasUnmappedPositions) {
    return result('needs-portfolio', '待组合复核', ['录入可投资现金及全部股票持仓后，才能检查单股、主题和行业集中度。'])
  }
  const positions = portfolio.positions
  const companyWeight = positions.filter((item) => item.code === input.candidate.code).reduce((sum, item) => sum + item.weightPct, 0)
  const industryWeight = positions.filter((item) => item.secondaryTrack === input.candidate.secondaryTrack).reduce((sum, item) => sum + item.weightPct, 0)
  const themeWeights = input.candidate.concepts.map((theme) => positions.filter((item) => item.concepts.includes(theme)).reduce((sum, item) => sum + item.weightPct, 0))
  const companyHeadroomPct = input.policy.companyCapPct - companyWeight
  const industryHeadroomPct = input.policy.industryCapPct - industryWeight
  const themeHeadroomPct = themeWeights.length ? Math.min(...themeWeights.map((weight) => input.policy.themeCapPct - weight)) : Infinity
  const additionalWeightPct = plan.targetWeightPct! - companyWeight
  const reasons = []
  if (additionalWeightPct <= 0) reasons.push('当前公司仓位已达到或超过计划目标仓位。')
  if (companyWeight + Math.max(0, additionalWeightPct) > input.policy.companyCapPct) reasons.push(`交易后单股将超过 ${input.policy.companyCapPct}%。`)
  if (industryWeight + Math.max(0, additionalWeightPct) > input.policy.industryCapPct) reasons.push(`交易后二级主营赛道将超过 ${input.policy.industryCapPct}%。`)
  if (themeWeights.some((weight) => weight + Math.max(0, additionalWeightPct) > input.policy.themeCapPct)) reasons.push(`交易后至少一个主题暴露将超过 ${input.policy.themeCapPct}%。`)
  if (portfolio.cashWeightPct < Math.max(0, additionalWeightPct)) reasons.push('可投资现金不足以完成计划首期以外的目标增量。')
  const values = { additionalWeightPct: Math.max(0, additionalWeightPct), companyHeadroomPct, industryHeadroomPct, themeHeadroomPct: Number.isFinite(themeHeadroomPct) ? themeHeadroomPct : null }
  return reasons.length
    ? result('portfolio-blocked', '组合受限', reasons, values)
    : result('plan-ready', '计划已就绪', ['估值、证据、买入计划与三层集中度复核均已通过；仍需由用户自行决定是否下单。'], values)
}
