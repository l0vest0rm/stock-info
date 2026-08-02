import { computed, createApp, defineComponent, h, onMounted, ref } from 'vue'
import trackSnapshotConfig from '../../../config/institutional-track-snapshot.json'
import valuationConfig from '../../../config/institutional-track-valuation.json'
import {
  assessInstitutionalTrackGrowthValuation,
  type GrowthForecastPathPoint,
  type GrowthValuationThresholds,
} from '../domain/institutional-track-growth-valuation'
import {
  assessInstitutionalTrackCycleValuation,
  assessInstitutionalTrackFinancialValuation,
  type ValuationThresholds,
} from '../domain/institutional-track-financial-valuation'
import {
  assessInstitutionalTrackBuyRecommendation,
  type BuyRecommendationPlan,
  type BuyRecommendationState,
} from '../domain/institutional-track-buy-recommendation'
import { isCompanyFollowed, toggleFollowedCompany } from '../domain/follow-storage'

type StockSource = {
  SECUCODE: string
  SECURITY_NAME_ABBR: string
  ALLCORP_NUM: number
  INDUSTRY?: string
  BOARD_NAME?: string
  CONCEPT?: string[]
  MAX_TRADE_DATE?: string
}

type TrackRow = {
  rank: number
  code: string
  name: string
  institutionCount: number
  industry: string
  concepts: string[]
  primaryTrack: string
  secondaryTrack: string
  tradeDate: string
}

type ValuationState = 'deep-value' | 'value' | 'fair' | 'expensive' | 'overvalued' | 'growth-unstable' | 'income-stagnant' | 'unavailable'
type ValuationFilter = ValuationState | 'pending'
type BuyRecommendationFilter = BuyRecommendationState | ''

type ValuationEvidenceLink = {
  title: string
  publishedAt: string
  url: string
}

type KlineValuationObservation = {
  date?: unknown
  close?: unknown
  high?: unknown
  peTtm?: unknown
  pb?: unknown
  marketCapital?: unknown
}

type CompanyValuation = {
  state: ValuationState
  modelLabel: string
  rationale: string
  confidence: '高' | '中' | '低'
  latestPrice: number | null
  pb: number | null
  roe: number | null
  normalizedPe: number | null
  forwardPe: number | null
  peg: number | null
  forecastYear: number | null
  profitGrowth: number | null
  profitCagr: number | null
  forecastPath: GrowthForecastPathPoint[]
  financeDate: string
  reportCount: number
  latestReports: ValuationEvidenceLink[]
  latestNews: ValuationEvidenceLink[]
  threeMonthHigh: number | null
  drawdownPct: number | null
  annualizedVolatility: number | null
  drawdownReviewThreshold: number | null
  pullbackWorthReview: boolean
  dividendYield: number | null
}

type ValuationModel = {
  id: string
  label: string
  primaryTracks?: string[]
  secondaryTracks?: string[]
  thresholds: Partial<Record<'strongBuy' | 'buy' | 'watch' | 'noAdd', number>>
  peThresholds?: Partial<Record<'strongBuy' | 'buy' | 'watch' | 'noAdd', number>>
  pbThresholds?: Partial<Record<'strongBuy' | 'buy' | 'watch' | 'noAdd', number>>
  roeThresholds?: Partial<Record<'strongBuy' | 'buy' | 'watch' | 'noAdd', number>>
  yieldThresholds?: {
    strongBuyYieldPct: number
    buyYieldPct: number
    watchYieldPct: number
    minimumProfitCagrPct: number
  }
}

type ApiEnvelope<T> = {
  code: number
  msg?: string
  data: T
}

const snapshot = trackSnapshotConfig as {
  classificationVersion: number
  dataDate: string
  rows: Array<{
    rank: number
    code: string
    name: string
    institutionCount: number
    industry: string
    concepts: string[]
    primaryTrack: string
    secondaryTrack: string
    classificationLabel: string
    classificationNote: string
  }>
}

const valuationRules = valuationConfig as {
  version: number
  batchLimit: number
  autoEvaluateLimit: number
  evaluationConcurrency: number
  evaluationCache: {
    version: number
    ttlMs: number
  }
  trackMinimumEvaluatedCompanies: number
  growthPeg: {
    baseForecastYear: number
    targetForecastYear: number
  }
  pullbackReview: {
    lookbackTradingDays: number
    annualizationDays: number
    volatilityMultiplier: number
    minimumDrawdownPct: number
    maximumDrawdownPct: number
  }
  buyRecommendation: {
    version: number
    companyCapPct: number
    themeCapPct: number
    industryCapPct: number
    minimumReportCount: number
    minimumInvalidationCount: number
  }
  models: ValuationModel[]
  fallback: ValuationModel
}

type ValuationCache = {
  savedAt: number
  valuations: Record<string, CompanyValuation>
}

type BuyPlanCache = {
  version: 1
  cashWeightPct: number | null
  positionsText: string
  plans: Record<string, BuyRecommendationPlan>
}

const valuationStateMeta: Record<ValuationState, { label: string, className: string, score: number | null }> = {
  'deep-value': { label: '显著低估', className: 'is-deep-value', score: 2 },
  value: { label: '估值偏低', className: 'is-value', score: 1 },
  fair: { label: '价格合理', className: 'is-fair', score: 0 },
  expensive: { label: '估值偏高', className: 'is-expensive', score: -1 },
  overvalued: { label: '估值透支', className: 'is-overvalued', score: -2 },
  'growth-unstable': { label: '增长路径不稳', className: 'is-growth-unstable', score: -1 },
  'income-stagnant': { label: '利润停滞，不宜新增', className: 'is-income-stagnant', score: -2 },
  unavailable: { label: '数据不足', className: 'is-unavailable', score: null },
}

const valuationStates = Object.keys(valuationStateMeta) as ValuationState[]

function numberOrNull(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function formatNumber(value: number | null, digits = 1): string {
  return value === null ? '—' : value.toFixed(digits)
}

function formatDate(value: string): string {
  return value ? value.slice(0, 10) : '—'
}

function completeThresholds(
  value: ValuationModel['thresholds'] | ValuationModel['peThresholds'] | ValuationModel['pbThresholds'] | ValuationModel['roeThresholds'],
): ValuationThresholds | null {
  const strongBuy = numberOrNull(value?.strongBuy)
  const buy = numberOrNull(value?.buy)
  const watch = numberOrNull(value?.watch)
  const noAdd = numberOrNull(value?.noAdd)
  return strongBuy !== null && buy !== null && watch !== null && noAdd !== null
    ? { strongBuy, buy, watch, noAdd }
    : null
}

function formatPePath(path: GrowthForecastPathPoint[]): string {
  return path.map((point) => `${point.year}E ${formatNumber(point.forwardPe)}×`).join(' / ')
}

function formatGrowthPath(path: GrowthForecastPathPoint[]): string {
  return path.map((point) => `${point.year}E ${point.profitGrowth === null ? '—' : `${formatNumber(point.profitGrowth)}%`}`).join(' / ')
}

function valuationModelFor(row: TrackRow): ValuationModel {
  return valuationRules.models.find((model) => model.secondaryTracks?.includes(row.secondaryTrack))
    || valuationRules.models.find((model) => model.primaryTracks?.includes(row.primaryTrack))
    || valuationRules.fallback
}

function emptyValuation(row: TrackRow, rationale: string): CompanyValuation {
  return {
    state: 'unavailable',
    modelLabel: valuationModelFor(row).label,
    rationale,
    confidence: '低',
    latestPrice: null,
    pb: null,
    roe: null,
    normalizedPe: null,
    forwardPe: null,
    peg: null,
    forecastYear: null,
    profitGrowth: null,
    profitCagr: null,
    forecastPath: [],
    financeDate: '',
    reportCount: 0,
    latestReports: [],
    latestNews: [],
    threeMonthHigh: null,
    drawdownPct: null,
    annualizedVolatility: null,
    drawdownReviewThreshold: null,
    pullbackWorthReview: false,
    dividendYield: null,
  }
}

function valuationCacheKey(): string {
  return [
    'institutional-track-valuation',
    valuationRules.evaluationCache.version,
    valuationRules.version,
    snapshot.classificationVersion,
    snapshot.dataDate,
  ].join(':')
}

function buyPlanCacheKey(): string {
  return `institutional-track-buy-plans:${valuationRules.buyRecommendation.version}:${snapshot.classificationVersion}:${snapshot.dataDate}`
}

function emptyBuyPlan(): BuyRecommendationPlan {
  return { fairValueLow: null, fairValueHigh: null, targetWeightPct: null, invalidations: [], tranchePlan: '', evidenceReviewed: false, financialRiskReviewed: false }
}

function parsePercent(value: string): number | null {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= 100 ? numeric : null
}

async function fetchApi<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`请求失败：${response.status}`)
  const body = await response.json() as ApiEnvelope<T>
  if (body.code !== 200) throw new Error(body.msg || '接口未返回成功结果')
  return body.data
}

function evidenceLinks(value: unknown): ValuationEvidenceLink[] {
  if (!value || typeof value !== 'object') return []
  const list = (value as { list?: unknown }).list
  if (!Array.isArray(list)) return []
  return list.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const row = item as Record<string, unknown>
    const title = String(row.title || '').trim()
    const url = String(row.url || '').trim()
    return title && url ? [{ title, url, publishedAt: String(row.published_at || '') }] : []
  })
}

function evidenceTotal(value: unknown): number {
  if (!value || typeof value !== 'object') return 0
  return Math.max(0, Number((value as { total?: unknown }).total) || 0)
}

function klineStartDate(): string {
  const date = new Date()
  date.setDate(date.getDate() - Math.ceil(valuationRules.pullbackReview.lookbackTradingDays * 2.5))
  return date.toISOString().slice(0, 10)
}

function calculatePullbackSignal(latestPrice: number | null, rows: KlineValuationObservation[]): Pick<CompanyValuation,
  'threeMonthHigh' | 'drawdownPct' | 'annualizedVolatility' | 'drawdownReviewThreshold' | 'pullbackWorthReview'
> {
  const window = rows
    .map((row) => ({ close: numberOrNull(row.close), high: numberOrNull(row.high) }))
    .filter((row) => row.close !== null && row.close > 0 && row.high !== null && row.high > 0)
    .slice(-valuationRules.pullbackReview.lookbackTradingDays)
  if (latestPrice === null || latestPrice <= 0 || window.length < 21) {
    return {
      threeMonthHigh: null,
      drawdownPct: null,
      annualizedVolatility: null,
      drawdownReviewThreshold: null,
      pullbackWorthReview: false,
    }
  }
  const logReturns = window.slice(1).map((row, index) => Math.log(row.close! / window[index].close!))
  const mean = logReturns.reduce((sum, value) => sum + value, 0) / logReturns.length
  const variance = logReturns.length > 1
    ? logReturns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (logReturns.length - 1)
    : 0
  const annualizedVolatility = Math.sqrt(variance) * Math.sqrt(valuationRules.pullbackReview.annualizationDays) * 100
  const threeMonthHigh = Math.max(...window.map((row) => row.high!))
  const drawdownPct = Math.max(0, ((threeMonthHigh - latestPrice) / threeMonthHigh) * 100)
  const drawdownReviewThreshold = Math.min(
    valuationRules.pullbackReview.maximumDrawdownPct,
    Math.max(
      valuationRules.pullbackReview.minimumDrawdownPct,
      annualizedVolatility * valuationRules.pullbackReview.volatilityMultiplier,
    ),
  )
  return {
    threeMonthHigh,
    drawdownPct,
    annualizedVolatility,
    drawdownReviewThreshold,
    pullbackWorthReview: drawdownPct >= drawdownReviewThreshold,
  }
}

function latestKlineObservation(rows: KlineValuationObservation[]): KlineValuationObservation | null {
  return [...rows].reverse().find((row) => numberOrNull(row.close) !== null && numberOrNull(row.close)! > 0) || null
}

function latestKlinePb(rows: KlineValuationObservation[]): number | null {
  const observation = [...rows].reverse().find((row) => {
    const pb = numberOrNull(row.pb)
    return pb !== null && pb > 0
  })
  return observation ? numberOrNull(observation.pb) : null
}

function forecastProfitCagr(forecasts: Array<Record<string, unknown>>): number | null {
  const baseYear = valuationRules.growthPeg.baseForecastYear
  const targetYear = valuationRules.growthPeg.targetForecastYear
  const values = new Map(forecasts.map((forecast) => [Number(forecast.year), numberOrNull(forecast.netProfit)]))
  const baseProfit = values.get(baseYear)
  const targetProfit = values.get(targetYear)
  if (baseProfit === null || baseProfit === undefined || targetProfit === null || targetProfit === undefined || baseProfit <= 0 || targetProfit <= 0) {
    return null
  }
  return ((targetProfit / baseProfit) ** (1 / (targetYear - baseYear)) - 1) * 100
}

function evaluateGrowthValuation(
  row: TrackRow,
  model: ValuationModel,
  marketCapYi: number | null,
  latestPrice: number | null,
  forecasts: Array<Record<string, unknown>>,
  financeDate: string,
  reportCount: number,
  latestReports: ValuationEvidenceLink[],
  latestNews: ValuationEvidenceLink[],
  pullbackSignal: ReturnType<typeof calculatePullbackSignal>,
): CompanyValuation {
  const baseYear = valuationRules.growthPeg.baseForecastYear
  const targetYear = valuationRules.growthPeg.targetForecastYear
  const pegThresholds = completeThresholds(model.thresholds) as GrowthValuationThresholds | null
  const peThresholds = completeThresholds(model.peThresholds) as GrowthValuationThresholds | null
  if (!pegThresholds || !peThresholds) {
    return {
      ...emptyValuation(row, '成长模型缺少完整的 PEG 或前瞻 PE 阈值配置。'),
      modelLabel: model.label,
      latestPrice,
      financeDate,
      reportCount,
      latestReports,
      latestNews,
      confidence: reportCount >= 1 ? '中' : '低',
      ...pullbackSignal,
    }
  }
  const result = assessInstitutionalTrackGrowthValuation({
    marketCapYi,
    forecasts,
    baseForecastYear: baseYear,
    targetForecastYear: targetYear,
    pegThresholds,
    peThresholds,
  })
  if (result.status === 'unavailable') {
    return {
      ...emptyValuation(row, result.reason),
      modelLabel: model.label,
      latestPrice,
      financeDate,
      reportCount,
      latestReports,
      latestNews,
      confidence: reportCount >= 1 ? '中' : '低',
      forecastPath: result.path,
      ...pullbackSignal,
    }
  }
  const confidence = result.pathComplete && reportCount >= 3 && financeDate
    ? '高'
    : reportCount >= 1 && financeDate ? '中' : '低'
  const pePath = formatPePath(result.path)
  const growthPath = formatGrowthPath(result.path)
  if (result.status === 'growth-unstable') {
    return {
      state: 'growth-unstable',
      modelLabel: model.label,
      rationale: `${pePath}；净利增速路径 ${growthPath}。${result.reason}`,
      confidence,
      latestPrice,
      pb: null,
      roe: null,
      normalizedPe: null,
      forwardPe: result.baseForwardPe,
      peg: null,
      forecastYear: baseYear,
      profitGrowth: null,
      profitCagr: result.endpointCagr,
      forecastPath: result.path,
      financeDate,
      reportCount,
      latestReports,
      latestNews,
      dividendYield: null,
      ...pullbackSignal,
    }
  }
  const pegLabel = valuationStateMeta[result.pegState!].label
  const peLabel = valuationStateMeta[result.peState!].label
  return {
    state: result.state!,
    modelLabel: model.label,
    rationale: `${pePath}；净利增速路径 ${growthPath}。端点 CAGR ${formatNumber(result.endpointCagr)}%，路径调整后采用 ${formatNumber(result.adjustedGrowth)}%；${baseYear}E PE ÷ 调整增速 = PEG ${formatNumber(result.peg, 2)}。PEG 档为“${pegLabel}”，近年 PE 档为“${peLabel}”，取更谨慎结论。${result.reason}`,
    confidence,
    latestPrice,
    pb: null,
    roe: null,
    normalizedPe: null,
    forwardPe: result.baseForwardPe,
    peg: result.peg,
    forecastYear: baseYear,
    profitGrowth: result.adjustedGrowth,
    profitCagr: result.endpointCagr,
    forecastPath: result.path,
    financeDate,
    reportCount,
    latestReports,
    latestNews,
    dividendYield: null,
    ...pullbackSignal,
  }
}

function evaluateYieldValuation(
  row: TrackRow,
  model: ValuationModel,
  forecasts: Array<Record<string, unknown>>,
  dividendYield: number | null,
  latestPrice: number | null,
  financeDate: string,
  reportCount: number,
  latestReports: ValuationEvidenceLink[],
  latestNews: ValuationEvidenceLink[],
  pullbackSignal: ReturnType<typeof calculatePullbackSignal>,
): CompanyValuation {
  const profitCagr = forecastProfitCagr(forecasts)
  const baseYear = valuationRules.growthPeg.baseForecastYear
  const targetYear = valuationRules.growthPeg.targetForecastYear
  if (dividendYield === null || dividendYield <= 0 || profitCagr === null) {
    return {
      ...emptyValuation(row, `缺少近四季股息率或 ${baseYear}E-${targetYear}E 利润预测，无法验证红利的可持续性。`),
      modelLabel: model.label,
      latestPrice,
      financeDate,
      reportCount,
      latestReports,
      latestNews,
      dividendYield,
      ...pullbackSignal,
    }
  }
  const thresholds = model.yieldThresholds
  if (!thresholds) {
    return {
      ...emptyValuation(row, '红利模型缺少股息率阈值配置。'),
      modelLabel: model.label,
      latestPrice,
      financeDate,
      reportCount,
      latestReports,
      latestNews,
      dividendYield,
      ...pullbackSignal,
    }
  }
  if (profitCagr <= thresholds.minimumProfitCagrPct) {
    return {
      state: 'income-stagnant',
      modelLabel: model.label,
      rationale: `${baseYear}E-${targetYear}E 净利 CAGR ${formatNumber(profitCagr)}%，未通过“利润增长”门槛；高股息不能单独构成投资理由。`,
      confidence: reportCount >= 3 && financeDate ? '高' : reportCount >= 1 && financeDate ? '中' : '低',
      latestPrice,
      pb: null,
      roe: null,
      normalizedPe: null,
      forwardPe: null,
      peg: null,
      forecastYear: targetYear,
      profitGrowth: profitCagr,
      profitCagr,
      forecastPath: [],
      financeDate,
      reportCount,
      latestReports,
      latestNews,
      dividendYield,
      ...pullbackSignal,
    }
  }
  let state: ValuationState = 'expensive'
  if (dividendYield >= thresholds.strongBuyYieldPct) state = 'deep-value'
  else if (dividendYield >= thresholds.buyYieldPct) state = 'value'
  else if (dividendYield >= thresholds.watchYieldPct) state = 'fair'
  return {
    state,
    modelLabel: model.label,
    rationale: `近四季年化股息率 ${formatNumber(dividendYield)}%，${baseYear}E-${targetYear}E 净利 CAGR ${formatNumber(profitCagr)}%；两项共同决定红利估值状态。`,
    confidence: reportCount >= 3 && financeDate ? '高' : reportCount >= 1 && financeDate ? '中' : '低',
    latestPrice,
    pb: null,
    roe: null,
    normalizedPe: null,
    forwardPe: null,
    peg: null,
    forecastYear: targetYear,
    profitGrowth: profitCagr,
    profitCagr,
    forecastPath: [],
    financeDate,
    reportCount,
    latestReports,
    latestNews,
    dividendYield,
    ...pullbackSignal,
  }
}

function evaluateFinancialValuation(
  row: TrackRow,
  model: ValuationModel,
  pb: number | null,
  latestPrice: number | null,
  incomeRows: Array<Record<string, unknown>>,
  balanceRows: Array<Record<string, unknown>>,
  financeDate: string,
  reportCount: number,
  latestReports: ValuationEvidenceLink[],
  latestNews: ValuationEvidenceLink[],
  pullbackSignal: ReturnType<typeof calculatePullbackSignal>,
): CompanyValuation {
  const pbThresholds = completeThresholds(model.pbThresholds)
  const roeThresholds = completeThresholds(model.roeThresholds)
  if (!pbThresholds || !roeThresholds) {
    return {
      ...emptyValuation(row, '金融模型缺少完整的 PB 或 ROE 阈值配置。'),
      modelLabel: model.label,
      latestPrice,
      pb,
      financeDate,
      reportCount,
      latestReports,
      latestNews,
      confidence: financeDate ? '中' : '低',
      ...pullbackSignal,
    }
  }
  const result = assessInstitutionalTrackFinancialValuation({ pb, incomeRows, balanceRows, pbThresholds, roeThresholds })
  if (result.status === 'unavailable') {
    return {
      ...emptyValuation(row, result.reason),
      modelLabel: model.label,
      latestPrice,
      pb,
      financeDate,
      reportCount,
      latestReports,
      latestNews,
      confidence: financeDate ? '中' : '低',
      ...pullbackSignal,
    }
  }
  return {
    state: result.state!,
    modelLabel: model.label,
    rationale: result.reason,
    confidence: financeDate && reportCount >= 1 ? '高' : financeDate ? '中' : '低',
    latestPrice,
    pb: result.pb,
    roe: result.roe,
    normalizedPe: null,
    forwardPe: null,
    peg: null,
    forecastYear: null,
    profitGrowth: null,
    profitCagr: null,
    forecastPath: [],
    financeDate,
    reportCount,
    latestReports,
    latestNews,
    dividendYield: null,
    ...pullbackSignal,
  }
}

function evaluateCycleValuation(
  row: TrackRow,
  model: ValuationModel,
  marketCapYi: number | null,
  latestPrice: number | null,
  incomeRows: Array<Record<string, unknown>>,
  financeDate: string,
  reportCount: number,
  latestReports: ValuationEvidenceLink[],
  latestNews: ValuationEvidenceLink[],
  pullbackSignal: ReturnType<typeof calculatePullbackSignal>,
): CompanyValuation {
  const normalizedPeThresholds = completeThresholds(model.peThresholds)
  if (!normalizedPeThresholds) {
    return {
      ...emptyValuation(row, '周期模型缺少完整的中周期 PE 阈值配置。'),
      modelLabel: model.label,
      latestPrice,
      financeDate,
      reportCount,
      latestReports,
      latestNews,
      confidence: financeDate ? '中' : '低',
      ...pullbackSignal,
    }
  }
  const result = assessInstitutionalTrackCycleValuation({ marketCapYi, incomeRows, normalizedPeThresholds })
  if (result.status === 'unavailable') {
    return {
      ...emptyValuation(row, result.reason),
      modelLabel: model.label,
      latestPrice,
      financeDate,
      reportCount,
      latestReports,
      latestNews,
      confidence: financeDate ? '中' : '低',
      ...pullbackSignal,
    }
  }
  return {
    state: result.state!,
    modelLabel: model.label,
    rationale: result.reason,
    confidence: financeDate && reportCount >= 1 ? '高' : financeDate ? '中' : '低',
    latestPrice,
    pb: null,
    roe: null,
    normalizedPe: result.normalizedPe,
    forwardPe: null,
    peg: null,
    forecastYear: null,
    profitGrowth: null,
    profitCagr: null,
    forecastPath: [],
    financeDate,
    reportCount,
    latestReports,
    latestNews,
    dividendYield: null,
    ...pullbackSignal,
  }
}

const pageStyle = `
.institutional-tracks-page { color: #23313f; }
.institutional-tracks-hero { background: linear-gradient(135deg, #0b3b2e, #155e75); border-radius: 1rem; color: #fff; padding: 1.4rem; }
.institutional-tracks-hero p { color: rgba(255,255,255,.78); }
.institutional-tracks-summary { display: flex; flex-wrap: wrap; gap: .45rem; }
.institutional-tracks-summary button { border: 1px solid #c9d7df; border-radius: 999px; background: #fff; color: #334155; padding: .3rem .7rem; }
.institutional-tracks-summary button.active { background: #0f766e; border-color: #0f766e; color: #fff; }
.institutional-tracks-table { font-size: .86rem; min-width: 1180px; }
.institutional-tracks-table th { white-space: nowrap; }
.institutional-tracks-sticky { position: sticky; left: 0; z-index: 1; background: #fff; }
.institutional-tracks-company-with-topics { display: inline-flex; position: relative; }
.institutional-tracks-topic-tooltip { background: #163b56; border-radius: .45rem; box-shadow: 0 .45rem 1rem rgba(15,23,42,.22); color: #fff; font-size: .75rem; font-weight: 400; left: 0; line-height: 1.4; max-width: min(22rem, calc(100vw - 2rem)); opacity: 0; padding: .45rem .6rem; pointer-events: none; position: absolute; top: calc(100% + .35rem); transform: translateY(.2rem); transition: opacity .14s ease, transform .14s ease; visibility: hidden; width: max-content; z-index: 10; }
.institutional-tracks-company-with-topics:hover .institutional-tracks-topic-tooltip, .institutional-tracks-company-with-topics:focus-within .institutional-tracks-topic-tooltip { opacity: 1; transform: translateY(0); visibility: visible; }
.institutional-tracks-follow-button { background: transparent; border: 0; font-size: 1.25rem; line-height: 1; padding: 0; }
.institutional-tracks-follow-button.is-followed { color: #eab308; }
.institutional-tracks-follow-button:not(.is-followed) { color: #94a3b8; }
.institutional-tracks-valuation-guide { background: #f8fafc; border: 1px solid #dbe5ec; border-radius: .75rem; padding: .85rem 1rem; }
.institutional-tracks-track-grid { display: grid; gap: .55rem; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); }
.institutional-tracks-track-card { border: 1px solid #dbe5ec; border-left-width: .4rem; border-radius: .55rem; padding: .6rem .7rem; background: #fff; }
.institutional-tracks-valuation-badge { display: inline-flex; align-items: center; border-radius: 999px; font-size: .75rem; font-weight: 700; line-height: 1.3; padding: .18rem .48rem; white-space: nowrap; }
.institutional-tracks-valuation-badge.is-deep-value, .institutional-tracks-track-card.is-deep-value { background: #dcfce7; border-color: #15803d; color: #14532d; }
.institutional-tracks-valuation-badge.is-value, .institutional-tracks-track-card.is-value { background: #ecfdf5; border-color: #0f766e; color: #115e59; }
.institutional-tracks-valuation-badge.is-fair, .institutional-tracks-track-card.is-fair { background: #fefce8; border-color: #ca8a04; color: #854d0e; }
.institutional-tracks-valuation-badge.is-expensive, .institutional-tracks-track-card.is-expensive { background: #fff7ed; border-color: #ea580c; color: #9a3412; }
.institutional-tracks-valuation-badge.is-overvalued, .institutional-tracks-track-card.is-overvalued { background: #fef2f2; border-color: #dc2626; color: #991b1b; }
.institutional-tracks-valuation-badge.is-growth-unstable, .institutional-tracks-track-card.is-growth-unstable { background: #fffbeb; border-color: #d97706; color: #92400e; }
.institutional-tracks-valuation-badge.is-income-stagnant, .institutional-tracks-track-card.is-income-stagnant { background: #fff7ed; border-color: #c2410c; color: #9a3412; }
.institutional-tracks-valuation-badge.is-unavailable, .institutional-tracks-track-card.is-unavailable { background: #f1f5f9; border-color: #94a3b8; color: #475569; }
.institutional-tracks-evidence { color: #64748b; font-size: .75rem; line-height: 1.4; max-width: 25rem; }
.institutional-tracks-evidence a { display: block; color: inherit; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.institutional-tracks-assess-button { font-size: .75rem; padding: .16rem .42rem; }
.institutional-tracks-buy-panel { background: #f8fafc; border: 1px solid #cbd5e1; border-radius: .75rem; padding: 1rem; }
.institutional-tracks-buy-status { border: 0; border-radius: .4rem; font-size: .75rem; padding: .22rem .45rem; text-align: left; }
.institutional-tracks-buy-status.is-plan-ready { background: #dcfce7; color: #14532d; }
.institutional-tracks-buy-status.is-portfolio-blocked, .institutional-tracks-buy-status.is-not-eligible { background: #fff7ed; color: #9a3412; }
.institutional-tracks-buy-status.is-needs-evidence, .institutional-tracks-buy-status.is-needs-plan, .institutional-tracks-buy-status.is-needs-portfolio { background: #eff6ff; color: #1d4ed8; }
.institutional-tracks-buy-detail { font-size: .8rem; line-height: 1.45; }
.institutional-tracks-buy-detail textarea { min-height: 4.5rem; }
`

const InstitutionalTracksPage = defineComponent({
  name: 'InstitutionalTracksPage',
  setup() {
    const rows = ref<TrackRow[]>([])
    const loading = ref(true)
    const error = ref('')
    const query = ref('')
    const primaryFilter = ref('')
    const secondaryFilter = ref('')
    const valuationFilter = ref<ValuationFilter | ''>('')
    const buyRecommendationFilter = ref<BuyRecommendationFilter>('')
    const followedCodes = ref(new Set<string>())
    const valuations = ref<Record<string, CompanyValuation>>({})
    const evaluatingCodes = ref(new Set<string>())
    const assessmentStatus = ref('')
    const assessmentRunning = ref(false)
    const buyPlans = ref<Record<string, BuyRecommendationPlan>>({})
    const cashWeightPct = ref<number | null>(null)
    const positionsText = ref('')
    const selectedPlanCode = ref('')
    let evaluationRun: Promise<void> | null = null

    const rowsMatchingTrackFilters = computed(() => {
      const keyword = query.value.trim().toLowerCase()
      return rows.value.filter((row) => {
        if (primaryFilter.value && row.primaryTrack !== primaryFilter.value) return false
        if (secondaryFilter.value && row.secondaryTrack !== secondaryFilter.value) return false
        if (!keyword) return true
        return [row.code, row.name, row.industry, row.primaryTrack, row.secondaryTrack, ...row.concepts]
          .join('|').toLowerCase().includes(keyword)
      })
    })

    const valuationCounts = computed(() => {
      const counts = new Map<ValuationFilter, number>()
      rowsMatchingTrackFilters.value.forEach((row) => {
        const state = valuations.value[row.code]?.state || 'pending'
        counts.set(state, (counts.get(state) || 0) + 1)
      })
      return counts
    })

    const visibleRows = computed(() => rowsMatchingTrackFilters.value.filter((row) => {
      if (!valuationFilter.value) return true
      const state = valuations.value[row.code]?.state || 'pending'
      return state === valuationFilter.value
    }).filter((row) => !buyRecommendationFilter.value || buyRecommendationFor(row).state === buyRecommendationFilter.value))

    const selectedPlanRow = computed(() => rows.value.find((row) => row.code === selectedPlanCode.value) || null)

    const primaryCounts = computed(() => {
      const countMap = new Map<string, number>()
      rows.value.forEach((row) => countMap.set(row.primaryTrack, (countMap.get(row.primaryTrack) || 0) + 1))
      return [...countMap.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    })

    const secondaryOptions = computed(() => {
      const values = rows.value
        .filter((row) => !primaryFilter.value || row.primaryTrack === primaryFilter.value)
        .map((row) => row.secondaryTrack)
        .filter(Boolean)
      return [...new Set(values)].sort((left, right) => left.localeCompare(right))
    })

    const trackSummaries = computed(() => {
      const useSecondaryTrack = Boolean(secondaryFilter.value)
      const groups = new Map<string, TrackRow[]>()
      visibleRows.value.forEach((row) => {
        const key = useSecondaryTrack ? row.secondaryTrack : row.primaryTrack
        groups.set(key, [...(groups.get(key) || []), row])
      })
      return [...groups.entries()].map(([track, trackRows]) => {
        const scores = trackRows
          .map((row) => valuations.value[row.code])
          .map((valuation) => valuation ? valuationStateMeta[valuation.state].score : null)
          .filter((score): score is number => score !== null)
        const evaluated = scores.length
        const averageScore = evaluated ? scores.reduce((sum, score) => sum + score, 0) / evaluated : null
        let state: ValuationState = 'unavailable'
        if (averageScore !== null && evaluated >= valuationRules.trackMinimumEvaluatedCompanies) {
          if (averageScore >= 1.5) state = 'deep-value'
          else if (averageScore >= 0.5) state = 'value'
          else if (averageScore > -0.5) state = 'fair'
          else if (averageScore > -1.5) state = 'expensive'
          else state = 'overvalued'
        }
        return { track, total: trackRows.length, evaluated, state }
      }).sort((left, right) => right.total - left.total || left.track.localeCompare(right.track))
    })

    function selectPrimary(track: string) {
      primaryFilter.value = track
      if (secondaryFilter.value && !secondaryOptions.value.includes(secondaryFilter.value)) {
        secondaryFilter.value = ''
      }
    }

    function loadRows() {
      loading.value = true
      error.value = ''
      try {
        const list: StockSource[] = snapshot.rows.map((item) => ({
          SECUCODE: item.code,
          SECURITY_NAME_ABBR: item.name,
          ALLCORP_NUM: item.institutionCount,
          INDUSTRY: item.industry,
          CONCEPT: item.concepts,
          MAX_TRADE_DATE: snapshot.dataDate,
        }))
        if (list.length !== 300) throw new Error(`快照应为 300 只，实际 ${list.length} 只`)
        if (list.some((item, index) => index > 0 && Number(item.ALLCORP_NUM) > Number(list[index - 1].ALLCORP_NUM))) {
          throw new Error('快照未按机构持股家数降序排列')
        }
        if (snapshot.classificationVersion !== 2) throw new Error(`不支持的主营赛道分类版本：${snapshot.classificationVersion}`)
        rows.value = list.map((stock, index) => {
          const assignment = snapshot.rows[index]
          if (!assignment.primaryTrack || !assignment.secondaryTrack || !assignment.classificationNote) {
            throw new Error(`${stock.SECUCODE} ${stock.SECURITY_NAME_ABBR} 缺少主营赛道分类`)
          }
          return {
            rank: index + 1,
            code: String(stock.SECUCODE),
            name: String(stock.SECURITY_NAME_ABBR || ''),
            institutionCount: Number(stock.ALLCORP_NUM || 0),
            industry: String(stock.INDUSTRY || stock.BOARD_NAME || '未分类'),
            concepts: Array.isArray(stock.CONCEPT) ? stock.CONCEPT.map(String) : [],
            tradeDate: String(stock.MAX_TRADE_DATE || ''),
            primaryTrack: assignment.primaryTrack,
            secondaryTrack: assignment.secondaryTrack,
          }
        })
        followedCodes.value = new Set(rows.value.map((row) => row.code).filter(isCompanyFollowed))
      } catch (caught) {
        error.value = caught instanceof Error ? caught.message : String(caught)
      } finally {
        loading.value = false
      }
    }

    function restoreBuyPlans() {
      try {
        const cached = JSON.parse(localStorage.getItem(buyPlanCacheKey()) || 'null') as BuyPlanCache | null
        if (!cached || cached.version !== 1 || !cached.plans || typeof cached.plans !== 'object') return
        buyPlans.value = cached.plans
        cashWeightPct.value = typeof cached.cashWeightPct === 'number' && cached.cashWeightPct >= 0 && cached.cashWeightPct <= 100
          ? cached.cashWeightPct
          : null
        positionsText.value = typeof cached.positionsText === 'string' ? cached.positionsText : ''
      } catch {
        // Personal plans remain optional local browser data and must not block research results.
      }
    }

    function persistBuyPlans() {
      try {
        localStorage.setItem(buyPlanCacheKey(), JSON.stringify({
          version: 1,
          cashWeightPct: cashWeightPct.value,
          positionsText: positionsText.value,
          plans: buyPlans.value,
        } satisfies BuyPlanCache))
      } catch {
        // Browser privacy settings must not block the read-only candidate assessment.
      }
    }

    function parsedPortfolio() {
      const rowByCode = new Map(rows.value.map((row) => [row.code, row]))
      const merged = new Map<string, number>()
      let hasUnmappedPositions = false
      for (const source of positionsText.value.split(/\r?\n/)) {
        const line = source.trim()
        if (!line) continue
        const [rawCode = '', rawWeight = ''] = line.split(/[,:，\s]+/)
        const code = rawCode.toUpperCase()
        const weightPct = parsePercent(rawWeight)
        if (weightPct === null || !rowByCode.has(code)) {
          hasUnmappedPositions = true
          continue
        }
        merged.set(code, (merged.get(code) || 0) + weightPct)
      }
      return {
        cashWeightPct: cashWeightPct.value,
        hasUnmappedPositions,
        positions: [...merged.entries()].map(([code, weightPct]) => {
          const row = rowByCode.get(code)!
          return { code, weightPct, secondaryTrack: row.secondaryTrack, concepts: row.concepts }
        }),
      }
    }

    function buyRecommendationFor(row: TrackRow) {
      const valuation = valuations.value[row.code]
      if (!valuation) {
        return { state: 'needs-evidence' as const, label: '先评估估值', reasons: ['尚未加载该公司的估值、财报和证据。'], additionalWeightPct: null, companyHeadroomPct: null, industryHeadroomPct: null, themeHeadroomPct: null }
      }
      return assessInstitutionalTrackBuyRecommendation({
        valuationState: valuation.state,
        confidence: valuation.confidence,
        financeDate: valuation.financeDate,
        reportCount: valuation.reportCount,
        plan: buyPlans.value[row.code] || null,
        portfolio: parsedPortfolio(),
        candidate: { code: row.code, secondaryTrack: row.secondaryTrack, concepts: row.concepts },
        requiresFinancialRiskReview: ['银行', '证券', '保险'].includes(row.secondaryTrack),
        policy: valuationRules.buyRecommendation,
      })
    }

    function selectPlan(row: TrackRow) {
      if (!buyPlans.value[row.code]) buyPlans.value = { ...buyPlans.value, [row.code]: emptyBuyPlan() }
      selectedPlanCode.value = row.code
      persistBuyPlans()
    }

    function updatePlan(code: string, patch: Partial<BuyRecommendationPlan>) {
      buyPlans.value = { ...buyPlans.value, [code]: { ...(buyPlans.value[code] || emptyBuyPlan()), ...patch } }
      persistBuyPlans()
    }

    function restoreValuations(): number {
      try {
        const cached = JSON.parse(localStorage.getItem(valuationCacheKey()) || 'null') as ValuationCache | null
        if (!cached || !Number.isFinite(cached.savedAt) || Date.now() - cached.savedAt > valuationRules.evaluationCache.ttlMs || !cached.valuations || typeof cached.valuations !== 'object') {
          return 0
        }
        const validCodes = new Set(rows.value.map((row) => row.code))
        valuations.value = Object.fromEntries(Object.entries(cached.valuations).filter(([code]) => validCodes.has(code)))
        return Object.keys(valuations.value).length
      } catch {
        return 0
      }
    }

    function persistValuations(): void {
      try {
        localStorage.setItem(valuationCacheKey(), JSON.stringify({
          savedAt: Date.now(),
          valuations: valuations.value,
        } satisfies ValuationCache))
      } catch {
        // Cache capacity or browser privacy settings must not block evaluation.
      }
    }

    function isFollowed(code: string): boolean {
      return followedCodes.value.has(code)
    }

    function toggleFollow(code: string): void {
      const followed = toggleFollowedCompany(code)
      followedCodes.value = new Set(followed
        ? [...followedCodes.value, code]
        : [...followedCodes.value].filter((item) => item !== code))
    }

    function isEvaluating(code: string): boolean {
      return evaluatingCodes.value.has(code)
    }

    async function evaluateCompany(row: TrackRow): Promise<boolean> {
      if (isEvaluating(row.code)) return false
      evaluatingCodes.value = new Set([...evaluatingCodes.value, row.code])
      const model = valuationModelFor(row)
      try {
        const [company, forecasts, incomeRows, balanceRows, reportDocs, newsDocs, klineRows, dividend] = await Promise.all([
          fetchApi<{ marketCapYi?: unknown }>(`/api/company/info?code=${encodeURIComponent(row.code)}`),
          fetchApi<Array<Record<string, unknown>>>(`/api/report/forecast?code=${encodeURIComponent(row.code)}`),
          fetchApi<Array<Record<string, unknown>>>(`/api/finance/income?code=${encodeURIComponent(row.code)}`),
          fetchApi<Array<Record<string, unknown>>>(`/api/finance/balance?code=${encodeURIComponent(row.code)}`).catch(() => []),
          fetchApi<unknown>(`/api/knowledge/docs?code=${encodeURIComponent(row.code)}&sourceType=company_report&page=1&pageSize=3`),
          fetchApi<unknown>(`/api/knowledge/docs?code=${encodeURIComponent(row.code)}&sourceType=web_news&page=1&pageSize=3`),
          fetchApi<KlineValuationObservation[]>(`/api/kline?code=${encodeURIComponent(row.code)}&period=day&fq=before&from=${encodeURIComponent(klineStartDate())}&format=structured`)
            .catch(() => []),
          fetchApi<{ currentYield?: unknown }>(`/api/finance/dividendyield?code=${encodeURIComponent(row.code)}`)
            .catch(() => null),
        ])
        const reportCount = evidenceTotal(reportDocs)
        const latestReports = evidenceLinks(reportDocs)
        const latestNews = evidenceLinks(newsDocs)
        const financeDate = String(incomeRows[0]?.NOTICE_DATE || incomeRows[0]?.REPORT_DATE || '')
        const latestPrice = latestKlineObservation(klineRows) ? numberOrNull(latestKlineObservation(klineRows)!.close) : null
        const latestPb = latestKlinePb(klineRows)
        const pullbackSignal = calculatePullbackSignal(latestPrice, klineRows)
        const dividendYield = dividend ? numberOrNull(dividend.currentYield) : null
        valuations.value = {
          ...valuations.value,
          [row.code]: model.id === 'growth'
            ? evaluateGrowthValuation(
              row,
              model,
              numberOrNull(company.marketCapYi),
              latestPrice,
              forecasts,
              financeDate,
              reportCount,
              latestReports,
              latestNews,
              pullbackSignal,
            )
            : model.id === 'yield'
              ? evaluateYieldValuation(
                row,
                model,
                forecasts,
                dividendYield,
                latestPrice,
                financeDate,
                reportCount,
                latestReports,
                latestNews,
                pullbackSignal,
              )
            : model.id === 'financial'
              ? evaluateFinancialValuation(
                row,
                model,
                latestPb,
                latestPrice,
                incomeRows,
                balanceRows,
                financeDate,
                reportCount,
                latestReports,
                latestNews,
                pullbackSignal,
              )
              : model.id === 'cycle'
                ? evaluateCycleValuation(
                  row,
                  model,
                  numberOrNull(company.marketCapYi),
                  latestPrice,
                  incomeRows,
                  financeDate,
                  reportCount,
                  latestReports,
                  latestNews,
                  pullbackSignal,
                )
            : {
              ...emptyValuation(row, `已加载最新财报、研报与新闻；${model.label}还需补齐专属估值字段，暂不自动给出颜色结论。`),
              modelLabel: model.label,
              latestPrice,
              financeDate,
              reportCount,
              latestReports,
              latestNews,
              confidence: reportCount >= 1 && financeDate ? '中' : '低',
              dividendYield,
              ...pullbackSignal,
            },
        }
        persistValuations()
        return true
      } catch (caught) {
        valuations.value = {
          ...valuations.value,
          [row.code]: emptyValuation(row, caught instanceof Error ? caught.message : String(caught)),
        }
        return false
      } finally {
        evaluatingCodes.value = new Set([...evaluatingCodes.value].filter((code) => code !== row.code))
      }
    }

    function evaluateRows(candidates: TrackRow[], label: string): Promise<void> {
      if (evaluationRun) return evaluationRun
      const pending = candidates.filter((row) => !valuations.value[row.code] && !isEvaluating(row.code))
      if (!pending.length) {
        assessmentStatus.value = '当前范围内没有待评估公司。'
        return Promise.resolve()
      }
      const concurrency = Math.max(1, Math.min(valuationRules.evaluationConcurrency, pending.length))
      assessmentRunning.value = true
      evaluationRun = (async () => {
        let completed = 0
        let cached = 0
        assessmentStatus.value = `${label} ${pending.length} 家公司（最多同时 ${concurrency} 家）…`
        const queue = [...pending]
        const worker = async () => {
          while (queue.length) {
            const row = queue.shift()
            if (!row) continue
            if (await evaluateCompany(row)) cached += 1
            completed += 1
            assessmentStatus.value = `${label} ${completed}/${pending.length} 家；已缓存 ${cached} 家结果。`
          }
        }
        await Promise.all(Array.from({ length: concurrency }, worker))
        assessmentStatus.value = `${label}完成：${cached}/${pending.length} 家结果已缓存。`
      })()
      return evaluationRun.finally(() => {
        evaluationRun = null
        assessmentRunning.value = false
      })
    }

    function evaluateVisibleRows(): Promise<void> {
      return evaluateRows(
        visibleRows.value.slice(0, valuationRules.batchLimit),
        '正在评估当前范围内',
      )
    }

    function startAutomaticEvaluation(): void {
      const restored = restoreValuations()
      const candidates = rows.value.slice(0, valuationRules.autoEvaluateLimit)
      const missing = candidates.filter((row) => !valuations.value[row.code]).length
      if (!missing) {
        assessmentStatus.value = `已从本地缓存恢复 ${restored} 家公司的评估结果。`
        return
      }
      assessmentStatus.value = restored
        ? `已恢复 ${restored} 家缓存结果；继续按机构持股排名自动评估其余 ${missing} 家…`
        : '将按机构持股排名自动评估公司…'
      void evaluateRows(candidates, '正在自动评估')
    }

    onMounted(() => {
      loadRows()
      restoreBuyPlans()
      if (!error.value && rows.value.length) startAutomaticEvaluation()
    })

    return () => h('div', { class: 'container-fluid my-3 institutional-tracks-page' }, [
      h('style', pageStyle),
      h('section', { class: 'institutional-tracks-hero mb-3' }, [
        h('div', { class: 'd-flex flex-wrap justify-content-between gap-3 align-items-end' }, [
          h('div', [
            h('h1', { class: 'h3 mb-2' }, '机构持股 Top300 主营赛道'),
            h('p', { class: 'mb-0' }, `按 ALLCORP_NUM 降序；榜单日期 ${rows.value[0]?.tradeDate || '加载中'}。一级、二级赛道按主营业务归类；东财概念仅作为主题标签展示。`),
          ]),
        ]),
      ]),
      error.value ? h('div', { class: 'alert alert-danger' }, error.value) : null,
      h('section', { class: 'institutional-tracks-valuation-guide mb-3' }, [
        h('div', { class: 'd-flex flex-wrap align-items-center justify-content-between gap-2' }, [
          h('div', [
            h('div', { class: 'fw-semibold' }, '估值颜色：赛道与公司分别判断'),
            h('div', { class: 'small text-muted' }, `页面打开后会按机构持股排名自动评估 Top${valuationRules.autoEvaluateLimit}，最多同时核对 ${valuationRules.evaluationConcurrency} 家；结果在本浏览器缓存 ${Math.round(valuationRules.evaluationCache.ttlMs / 60_000)} 分钟。成长赛道同时检查 ${valuationRules.growthPeg.baseForecastYear}E 绝对 PE 和逐年利润路径；红利赛道要求股息率与 ${valuationRules.growthPeg.baseForecastYear}E-${valuationRules.growthPeg.targetForecastYear}E 利润 CAGR 同时成立；银行、证券和保险使用 PB 与滚动 ROE 的更谨慎结论；周期赛道用连续三年滚动利润中位数计算中周期 PE。回撤只触发复核，不会自动上调估值或买入建议。建仓建议还必须通过证据、买入计划和组合集中度复核，绝不自动下单。`),
          ]),
          h('button', {
            type: 'button',
            class: 'btn btn-sm btn-outline-primary',
            disabled: assessmentRunning.value,
            onClick: () => { void evaluateVisibleRows() },
          }, `评估当前前 ${valuationRules.batchLimit} 家`),
        ]),
        assessmentStatus.value ? h('div', { class: 'small text-muted mt-2' }, assessmentStatus.value) : null,
      ]),
      h('div', { class: 'row g-2 mb-3 align-items-center' }, [
        h('div', { class: 'col-12 col-lg-3' }, [
          h('input', {
            class: 'form-control form-control-sm',
            value: query.value,
            placeholder: '搜索股票、行业、概念或赛道',
            onInput: (event: Event) => { query.value = (event.target as HTMLInputElement).value },
          }),
        ]),
        h('div', { class: 'col-12 col-lg-3' }, [
          h('select', {
            class: 'form-select form-select-sm',
            value: primaryFilter.value,
            onChange: (event: Event) => selectPrimary((event.target as HTMLSelectElement).value),
          }, [
            h('option', { value: '' }, `全部一级主营赛道（${rows.value.length}）`),
            ...primaryCounts.value.map(([track, count]) => h('option', { value: track }, `${track}（${count}）`)),
          ]),
        ]),
        h('div', { class: 'col-12 col-lg-3' }, [
          h('select', {
            class: 'form-select form-select-sm',
            value: secondaryFilter.value,
            onChange: (event: Event) => { secondaryFilter.value = (event.target as HTMLSelectElement).value },
          }, [
            h('option', { value: '' }, '全部二级主营赛道'),
            ...secondaryOptions.value.map((track) => h('option', { value: track }, track)),
          ]),
        ]),
        h('div', { class: 'col-12 col-lg-3' }, [
          h('select', {
            class: 'form-select form-select-sm',
            value: valuationFilter.value,
            'aria-label': '按估值状态筛选',
            onChange: (event: Event) => { valuationFilter.value = (event.target as HTMLSelectElement).value as ValuationFilter | '' },
          }, [
            h('option', { value: '' }, `全部估值状态（${rowsMatchingTrackFilters.value.length}）`),
            h('option', { value: 'pending' }, `待评估（${valuationCounts.value.get('pending') || 0}）`),
            ...valuationStates.map((state) => h(
              'option',
              { value: state },
              `${valuationStateMeta[state].label}（${valuationCounts.value.get(state) || 0}）`,
            )),
          ]),
        ]),
        h('div', { class: 'col-12 col-lg-3' }, [
          h('select', {
            class: 'form-select form-select-sm',
            value: buyRecommendationFilter.value,
            'aria-label': '按建仓建议筛选',
            onChange: (event: Event) => { buyRecommendationFilter.value = (event.target as HTMLSelectElement).value as BuyRecommendationFilter },
          }, [
            h('option', { value: '' }, '全部建仓建议'),
            h('option', { value: 'plan-ready' }, '计划已就绪'),
            h('option', { value: 'needs-plan' }, '创建买入计划'),
            h('option', { value: 'needs-evidence' }, '需补证据 / 先评估'),
            h('option', { value: 'needs-portfolio' }, '待组合复核'),
            h('option', { value: 'portfolio-blocked' }, '组合受限'),
            h('option', { value: 'not-eligible' }, '暂不新增 / 数据不足'),
          ]),
        ]),
      ]),
      !loading.value ? h('section', { class: 'institutional-tracks-buy-panel mb-3', 'aria-label': '建仓候选与买入计划' }, (() => {
        const selected = selectedPlanRow.value
        const plan = selected ? buyPlans.value[selected.code] || emptyBuyPlan() : null
        const recommendation = selected ? buyRecommendationFor(selected) : null
        return [
          h('div', { class: 'd-flex flex-wrap justify-content-between gap-2 align-items-center mb-2' }, [
            h('div', [
              h('div', { class: 'fw-semibold' }, '建仓候选与买入计划'),
              h('div', { class: 'small text-muted' }, `只保存本浏览器的个人计划；仓位按可投资资产比例填写。代码必须在当前 Top300 快照内，未识别持仓会阻止“计划已就绪”。单股≤${valuationRules.buyRecommendation.companyCapPct}%、主题≤${valuationRules.buyRecommendation.themeCapPct}%、二级主营赛道≤${valuationRules.buyRecommendation.industryCapPct}%。`),
            ]),
            selected ? h('button', { type: 'button', class: 'btn btn-sm btn-outline-secondary', onClick: () => { selectedPlanCode.value = '' } }, '关闭计划') : null,
          ]),
          h('div', { class: 'row g-2 mb-3' }, [
            h('label', { class: 'col-12 col-lg-3 small' }, [
              '可投资现金（%）',
              h('input', { class: 'form-control form-control-sm mt-1', type: 'number', min: 0, max: 100, value: cashWeightPct.value ?? '', onInput: (event: Event) => { cashWeightPct.value = parsePercent((event.target as HTMLInputElement).value); persistBuyPlans() } }),
            ]),
            h('label', { class: 'col-12 col-lg-9 small' }, [
              '现有股票持仓（每行：代码, 权重%；仅录入股票仓）',
              h('textarea', { class: 'form-control form-control-sm mt-1', placeholder: '600036.SH, 5\n601398.SH, 8', value: positionsText.value, onInput: (event: Event) => { positionsText.value = (event.target as HTMLTextAreaElement).value; persistBuyPlans() } }),
            ]),
          ]),
          selected && plan && recommendation ? h('div', { class: 'institutional-tracks-buy-detail border-top pt-3' }, [
            h('div', { class: 'd-flex flex-wrap align-items-center gap-2 mb-2' }, [
              h('span', { class: 'fw-semibold' }, `${selected.name} ${selected.code}`),
              h('span', { class: `institutional-tracks-buy-status is-${recommendation.state}` }, recommendation.label),
              recommendation.additionalWeightPct !== null ? h('span', { class: 'text-muted' }, `计划新增 ${formatNumber(recommendation.additionalWeightPct)}%`) : null,
            ]),
            h('div', { class: 'row g-2' }, [
              h('label', { class: 'col-6 col-lg-3' }, ['保守价值下限', h('input', { class: 'form-control form-control-sm mt-1', type: 'number', min: 0, value: plan.fairValueLow ?? '', onInput: (event: Event) => updatePlan(selected.code, { fairValueLow: numberOrNull((event.target as HTMLInputElement).value) }) })]),
              h('label', { class: 'col-6 col-lg-3' }, ['保守价值上限', h('input', { class: 'form-control form-control-sm mt-1', type: 'number', min: 0, value: plan.fairValueHigh ?? '', onInput: (event: Event) => updatePlan(selected.code, { fairValueHigh: numberOrNull((event.target as HTMLInputElement).value) }) })]),
              h('label', { class: 'col-12 col-lg-3' }, [`目标仓位（≤${valuationRules.buyRecommendation.companyCapPct}%）`, h('input', { class: 'form-control form-control-sm mt-1', type: 'number', min: 0, max: valuationRules.buyRecommendation.companyCapPct, value: plan.targetWeightPct ?? '', onInput: (event: Event) => updatePlan(selected.code, { targetWeightPct: parsePercent((event.target as HTMLInputElement).value) }) } )]),
              h('label', { class: 'col-12 col-lg-3 d-flex align-items-end gap-2 pb-1' }, [h('input', { type: 'checkbox', checked: plan.evidenceReviewed, onChange: (event: Event) => updatePlan(selected.code, { evidenceReviewed: (event.target as HTMLInputElement).checked }) }), '已复核近期公告与新闻']),
              ['银行', '证券', '保险'].includes(selected.secondaryTrack) ? h('label', { class: 'col-12 col-lg-3 d-flex align-items-end gap-2 pb-1' }, [h('input', { type: 'checkbox', checked: plan.financialRiskReviewed, onChange: (event: Event) => updatePlan(selected.code, { financialRiskReviewed: (event.target as HTMLInputElement).checked }) }), selected.secondaryTrack === '银行' ? '已复核资产质量与资本充足' : '已复核偿付/流动性及杠杆风险']) : null,
              h('label', { class: 'col-12 col-lg-6' }, [`证伪条件（每行一项，至少 ${valuationRules.buyRecommendation.minimumInvalidationCount} 项）`, h('textarea', { class: 'form-control form-control-sm mt-1', value: plan.invalidations.join('\n'), onInput: (event: Event) => updatePlan(selected.code, { invalidations: (event.target as HTMLTextAreaElement).value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean) }) })]),
              h('label', { class: 'col-12 col-lg-6' }, ['分批计划与限价条件', h('textarea', { class: 'form-control form-control-sm mt-1', value: plan.tranchePlan, onInput: (event: Event) => updatePlan(selected.code, { tranchePlan: (event.target as HTMLTextAreaElement).value }) })]),
            ]),
            h('ul', { class: 'mb-0 mt-2 ps-3' }, recommendation.reasons.map((reason) => h('li', reason))),
          ]) : h('div', { class: 'small text-muted' }, '点击表格中“建仓建议”列的状态，可为已评估公司建立并复核个人买入计划。'),
        ]
      })()) : null,
      !loading.value ? h('section', { class: 'institutional-tracks-track-grid mb-3', 'aria-label': '赛道估值状态' }, trackSummaries.value.map((summary) => {
        const meta = valuationStateMeta[summary.state]
        return h('div', { key: summary.track, class: `institutional-tracks-track-card ${meta.className}` }, [
          h('div', { class: 'd-flex justify-content-between gap-2' }, [
            h('span', { class: 'fw-semibold' }, summary.track),
            h('span', { class: 'institutional-tracks-valuation-badge ' + meta.className }, meta.label),
          ]),
          h('div', { class: 'small mt-1' }, summary.evaluated >= valuationRules.trackMinimumEvaluatedCompanies
            ? `已按 ${summary.evaluated}/${summary.total} 家有结论公司聚合`
            : `已评估 ${summary.evaluated}/${summary.total} 家；至少 ${valuationRules.trackMinimumEvaluatedCompanies} 家才给赛道颜色`),
        ])
      })) : null,
      loading.value
        ? h('div', { class: 'text-center text-muted py-5' }, '正在加载 Top300 并匹配赛道…')
        : h('div', { class: 'table-responsive border rounded' }, [
          h('table', { class: 'table table-sm table-hover align-middle mb-0 institutional-tracks-table' }, [
            h('thead', { class: 'table-light' }, [h('tr', [
              h('th', '排名'), h('th', '股票'), h('th', '估值状态'), h('th', '建仓建议'), h('th', '机构家数'), h('th', '东财行业'),
              h('th', '一级主营赛道'), h('th', '二级主营赛道'),
            ])]),
            h('tbody', visibleRows.value.map((row) => h('tr', { key: row.code }, [
              h('td', row.rank),
              h('td', { class: 'institutional-tracks-sticky' }, [
                h('span', { class: 'institutional-tracks-company-with-topics' }, [
                  h('a', {
                    href: `company.html?code=${encodeURIComponent(row.code)}`,
                    target: '_blank',
                    'aria-label': row.concepts.length ? `${row.name}，主题标签：${row.concepts.join('、')}` : row.name,
                  }, row.name),
                  row.concepts.length ? h('span', { class: 'institutional-tracks-topic-tooltip', role: 'tooltip' }, `主题标签：${row.concepts.join('、')}`) : null,
                ]),
                h('button', {
                  type: 'button',
                  class: `institutional-tracks-follow-button ms-1 ${isFollowed(row.code) ? 'is-followed' : ''}`,
                  title: isFollowed(row.code) ? '从我关注的移除' : '加入我关注的',
                  'aria-label': isFollowed(row.code) ? `取消关注 ${row.name}` : `关注 ${row.name}`,
                  onClick: () => toggleFollow(row.code),
                }, h('span', { 'aria-hidden': 'true' }, isFollowed(row.code) ? '★' : '☆')),
                h('div', { class: 'text-muted small' }, row.code),
              ]),
              h('td', { style: 'min-width: 15rem;' }, (() => {
                const valuation = valuations.value[row.code]
                if (!valuation) {
                  return h('button', {
                    type: 'button',
                    class: 'btn btn-sm btn-outline-secondary institutional-tracks-assess-button',
                    disabled: isEvaluating(row.code),
                    onClick: () => { void evaluateCompany(row) },
                  }, isEvaluating(row.code) ? '正在核对证据…' : '评估估值')
                }
                const meta = valuationStateMeta[valuation.state]
                const metric = valuation.forecastPath.length
                  ? `${formatPePath(valuation.forecastPath)}｜净利增速 ${formatGrowthPath(valuation.forecastPath)}${valuation.peg === null ? '' : `｜路径调整 PEG ${formatNumber(valuation.peg, 2)}`}`
                  : valuation.dividendYield !== null
                    ? `近四季股息率 ${formatNumber(valuation.dividendYield)}% / ${valuation.forecastYear}E 前净利 CAGR ${formatNumber(valuation.profitGrowth)}%`
                    : valuation.pb !== null || valuation.roe !== null
                      ? `PB ${formatNumber(valuation.pb, 2)}× / 滚动 ROE ${formatNumber(valuation.roe)}%`
                      : valuation.normalizedPe !== null
                        ? `三年中周期盈利 PE ${formatNumber(valuation.normalizedPe)}×`
                    : `财报 ${formatDate(valuation.financeDate)}｜研报 ${valuation.reportCount} 份`
                const pullbackText = valuation.drawdownPct === null
                  ? '近 3 个月回撤：数据不足'
                  : `近 3 个月高点 ${formatNumber(valuation.threeMonthHigh)}，回撤 ${formatNumber(valuation.drawdownPct)}%｜年化波动 ${formatNumber(valuation.annualizedVolatility)}%，关注线 ${formatNumber(valuation.drawdownReviewThreshold)}%${valuation.pullbackWorthReview ? '（回撤关注）' : ''}`
                return h('div', [
                  h('span', { class: `institutional-tracks-valuation-badge ${meta.className}`, title: valuation.rationale }, meta.label),
                  h('div', { class: 'small mt-1' }, metric),
                  h('div', { class: 'institutional-tracks-evidence mt-1' }, [
                    h('div', `${valuation.modelLabel}｜置信度 ${valuation.confidence}`),
                    h('div', valuation.rationale),
                    h('div', { class: valuation.pullbackWorthReview ? 'text-primary fw-semibold' : '' }, pullbackText),
                    ...valuation.latestReports.slice(0, 2).map((item) => h('a', { href: item.url, target: '_blank', rel: 'noreferrer', title: item.title }, `研报 ${formatDate(item.publishedAt)}：${item.title}`)),
                    ...valuation.latestNews.slice(0, 1).map((item) => h('a', { href: item.url, target: '_blank', rel: 'noreferrer', title: item.title }, `新闻 ${formatDate(item.publishedAt)}：${item.title}`)),
                  ]),
                ])
              })()),
              h('td', { style: 'min-width: 9rem;' }, (() => {
                const recommendation = buyRecommendationFor(row)
                return h('button', {
                  type: 'button',
                  class: `institutional-tracks-buy-status is-${recommendation.state}`,
                  title: recommendation.reasons.join('\n'),
                  onClick: () => selectPlan(row),
                }, recommendation.label)
              })()),
              h('td', { class: 'fw-semibold' }, row.institutionCount.toLocaleString()),
              h('td', row.industry),
              h('td', row.primaryTrack),
              h('td', row.secondaryTrack),
            ]))),
          ]),
        ]),
      h('p', { class: 'small text-muted mt-2' }, `当前显示 ${visibleRows.value.length} / ${rows.value.length}。颜色表示基于当前证据的估值状态，不构成个性化投资建议；同机构家数的边界股票按东财原始返回顺序截取，Top300 的行业占比只代表本榜单样本，不代表全市场。`),
    ])
  },
})

const root = document.getElementById('institutional-tracks-vue-root')
if (root) createApp(InstitutionalTracksPage).mount(root)
