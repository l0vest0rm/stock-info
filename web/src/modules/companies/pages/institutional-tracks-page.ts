import { computed, createApp, defineComponent, h, onMounted, ref } from 'vue'
import trackSnapshotConfig from '../../../config/institutional-track-snapshot.json'
import em2016ProfilesConfig from '../../../../../config/eastmoney-company-em2016-profiles.json'
import sortingConfig from '../../../config/institutional-track-sorting.json'
import valuationConfig from '../../../config/institutional-track-valuation.json'
import {
  assessInstitutionalTrackGrowthValuation,
  type GrowthForecastPathPoint,
  type GrowthValuationThresholds,
} from '../domain/institutional-track-growth-valuation'
import {
  assessInstitutionalTrackCycleValuation,
  assessInstitutionalTrackBankShareholderReturn,
  assessInstitutionalTrackFinancialValuation,
  type BankShareholderReturnThresholds,
  type ValuationThresholds,
} from '../domain/institutional-track-financial-valuation'
import {
  assessInstitutionalTrackRating,
  institutionalTrackRatingMeta,
  institutionalTrackRatingStates,
  type InstitutionalTrackRatingState,
} from '../domain/institutional-track-rating'
import { calculateLookbackRangePosition } from '../domain/institutional-track-performance'
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
  em2016: string
  em2016Level1: string
  em2016Level2: string
  em2016Level3: string
  concepts: string[]
  primaryTrack: string
  secondaryTrack: string
  tradeDate: string
}

type ValuationState = 'deep-value' | 'value' | 'fair' | 'expensive' | 'overvalued' | 'growth-unstable' | 'income-stagnant' | 'unavailable'
type ValuationFilter = ValuationState | 'pending'
type RatingFilter = InstitutionalTrackRatingState | ''

type ValuationEvidenceLink = {
  title: string
  publishedAt: string
  url: string
}

type KlineValuationObservation = {
  date?: unknown
  close?: unknown
  high?: unknown
  low?: unknown
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
  ninetyDayDrawdownPct: number | null
  ninetyDayGainPct: number | null
  annualizedVolatility: number | null
  drawdownReviewThreshold: number | null
  pullbackWorthReview: boolean
  dividendYield: number | null
}

type TrackPerformance = {
  ninetyDayDrawdownPct: number | null
  ninetyDayGainPct: number | null
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

type Em2016ProfileEntry = {
  code: string
  name?: string
  availability: string
  industry: string | null
  industryLevels?: string[]
  mainBusiness?: string | null
  products?: string[]
  sourceUrl?: string
  updatedAt?: string | number
}

const em2016ProfileRegistry = em2016ProfilesConfig as {
  generatedAt?: string
  profiles: Array<{
    code: string
    name?: string
    availability: string
    industry: string | null
    industryLevels?: string[]
    mainBusiness?: string | null
    products?: string[]
    sourceUrl?: string
    updatedAt?: string | number
  }>
}

const valuationRules = valuationConfig as {
  version: number
  batchLimit: number
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
  models: ValuationModel[]
  fallback: ValuationModel
}

type ValuationCache = {
  savedAt: number
  valuations: Record<string, CompanyValuation>
}

type SortMetric = 'institutionCount' | 'ninetyDayDrawdownPct' | 'ninetyDayGainPct'
type SortDirection = 'asc' | 'desc'
type SortStrategy = {
  id: string
  label: string
  metric: SortMetric
  direction: SortDirection
}

const sortingRules = sortingConfig as {
  version: number
  lookbackTradingDays: number
  defaultStrategyId: string
  strategies: SortStrategy[]
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
const valuationCalculationVersion = 5

function parseEm2016Levels(value: string): [string, string, string] | null {
  const levels = value.split('-').map((item) => item.trim()).filter(Boolean)
  return levels.length === 3 ? [levels[0], levels[1], levels[2]] : null
}

function profileLevels(entry: Em2016ProfileEntry | null | undefined): [string, string, string] | null {
  if (!entry || entry.availability !== 'available' || !entry.industry) return null
  if (Array.isArray(entry.industryLevels) && entry.industryLevels.length === 3) {
    const levels = entry.industryLevels.map((item) => String(item || '').trim()).filter(Boolean)
    return levels.length === 3 ? [levels[0], levels[1], levels[2]] : null
  }
  return parseEm2016Levels(entry.industry)
}

function numberOrNull(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function formatNumber(value: number | null, digits = 1): string {
  return value === null ? '—' : value.toFixed(digits)
}

function formatPercent(value: number | null, showPositiveSign = false): string {
  if (value === null) return '—'
  return `${showPositiveSign && value > 0 ? '+' : ''}${formatNumber(value)}%`
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
    ninetyDayDrawdownPct: null,
    ninetyDayGainPct: null,
    annualizedVolatility: null,
    drawdownReviewThreshold: null,
    pullbackWorthReview: false,
    dividendYield: null,
  }
}

function valuationCacheKey(): string {
  return [
    'institutional-track-valuation',
    valuationCalculationVersion,
    valuationRules.evaluationCache.version,
    valuationRules.version,
    snapshot.classificationVersion,
    snapshot.dataDate,
  ].join(':')
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
  const requiredTradingDays = Math.max(
    valuationRules.pullbackReview.lookbackTradingDays,
    sortingRules.lookbackTradingDays,
  )
  date.setDate(date.getDate() - Math.ceil(requiredTradingDays * 2.5))
  return date.toISOString().slice(0, 10)
}

function calculatePullbackSignal(latestPrice: number | null, rows: KlineValuationObservation[]): Pick<CompanyValuation,
  'threeMonthHigh' | 'drawdownPct' | 'ninetyDayDrawdownPct' | 'ninetyDayGainPct' | 'annualizedVolatility' | 'drawdownReviewThreshold' | 'pullbackWorthReview'
> {
  const window = rows
    .map((row) => ({ close: numberOrNull(row.close), high: numberOrNull(row.high) }))
    .filter((row) => row.close !== null && row.close > 0 && row.high !== null && row.high > 0)
    .slice(-valuationRules.pullbackReview.lookbackTradingDays)
  if (latestPrice === null || latestPrice <= 0 || window.length < 21) {
    return {
      threeMonthHigh: null,
      drawdownPct: null,
      ninetyDayDrawdownPct: null,
      ninetyDayGainPct: null,
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
  const ninetyDayRange = calculateLookbackRangePosition(rows, sortingRules.lookbackTradingDays)
  return {
    threeMonthHigh,
    drawdownPct,
    ninetyDayDrawdownPct: ninetyDayRange?.drawdownPct ?? null,
    ninetyDayGainPct: ninetyDayRange?.gainPct ?? null,
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
  incomeRows: Array<Record<string, unknown>>,
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
    incomeRows,
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

function evaluateBankValuation(
  row: TrackRow,
  model: ValuationModel,
  pb: number | null,
  dividendYield: number | null,
  latestPrice: number | null,
  forecasts: Array<Record<string, unknown>>,
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
  const thresholds = model.yieldThresholds as BankShareholderReturnThresholds | undefined
  if (!pbThresholds || !roeThresholds || !thresholds) {
    return {
      ...emptyValuation(row, '银行模型缺少完整的股息率、PB 或 ROE 阈值配置。'),
      modelLabel: model.label,
      latestPrice,
      pb,
      financeDate,
      reportCount,
      latestReports,
      latestNews,
      dividendYield,
      ...pullbackSignal,
    }
  }
  const financial = assessInstitutionalTrackFinancialValuation({ pb, incomeRows, balanceRows, pbThresholds, roeThresholds })
  const result = assessInstitutionalTrackBankShareholderReturn({
    dividendYield,
    profitCagr: forecastProfitCagr(forecasts),
    financial,
    thresholds,
  })
  if (result.status === 'unavailable') {
    return {
      ...emptyValuation(row, result.reason),
      modelLabel: model.label,
      latestPrice,
      pb: result.pb,
      roe: result.roe,
      financeDate,
      reportCount,
      latestReports,
      latestNews,
      dividendYield,
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
    forecastYear: valuationRules.growthPeg.targetForecastYear,
    profitGrowth: result.profitCagr,
    profitCagr: result.profitCagr,
    forecastPath: [],
    financeDate,
    reportCount,
    latestReports,
    latestNews,
    dividendYield: result.dividendYield,
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
.institutional-tracks-rating { border: 0; border-radius: .4rem; font-size: .75rem; padding: .22rem .45rem; text-align: left; }
.institutional-tracks-rating.is-buy { background: #dcfce7; color: #14532d; }
.institutional-tracks-rating.is-overweight { background: #ecfdf5; color: #115e59; }
.institutional-tracks-rating.is-hold { background: #fefce8; color: #854d0e; }
.institutional-tracks-rating.is-underweight { background: #fff7ed; color: #9a3412; }
.institutional-tracks-rating.is-sell { background: #fef2f2; color: #991b1b; }
.institutional-tracks-rating.is-insufficient { background: #f1f5f9; color: #475569; }
`

const InstitutionalTracksPage = defineComponent({
  name: 'InstitutionalTracksPage',
  setup() {
    const rows = ref<TrackRow[]>([])
    const loading = ref(true)
    const error = ref('')
    const query = ref('')
    const level1Filter = ref('')
    const level2Filter = ref('')
    const level3Filter = ref('')
    const valuationFilter = ref<ValuationFilter | ''>('')
    const ratingFilter = ref<RatingFilter>('')
    const sortStrategyId = ref(sortingRules.defaultStrategyId)
    const followedCodes = ref(new Set<string>())
    const valuations = ref<Record<string, CompanyValuation>>({})
    const performances = ref<Record<string, TrackPerformance>>({})
    const evaluatingCodes = ref(new Set<string>())
    const assessmentStatus = ref('')
    const assessmentRunning = ref(false)
    const performanceStatus = ref('')
    const performanceRunning = ref(false)
    let evaluationRun: Promise<void> | null = null
    let performanceRun: Promise<void> | null = null

    const rowsMatchingIndustryFilters = computed(() => {
      const keyword = query.value.trim().toLowerCase()
      return rows.value.filter((row) => {
        if (level1Filter.value && row.em2016Level1 !== level1Filter.value) return false
        if (level2Filter.value && row.em2016Level2 !== level2Filter.value) return false
        if (level3Filter.value && row.em2016Level3 !== level3Filter.value) return false
        if (!keyword) return true
        return [row.code, row.name, row.industry, row.em2016, row.em2016Level1, row.em2016Level2, row.em2016Level3, ...row.concepts]
          .join('|').toLowerCase().includes(keyword)
      })
    })

    const valuationCounts = computed(() => {
      const counts = new Map<ValuationFilter, number>()
      rowsMatchingIndustryFilters.value.forEach((row) => {
        const state = valuations.value[row.code]?.state || 'pending'
        counts.set(state, (counts.get(state) || 0) + 1)
      })
      return counts
    })

    const selectedSortStrategy = computed<SortStrategy>(() => {
      const strategy = sortingRules.strategies.find((item) => item.id === sortStrategyId.value)
      if (!strategy) throw new Error(`未配置排序策略：${sortStrategyId.value}`)
      return strategy
    })

    function sortValue(row: TrackRow, strategy: SortStrategy): number | null {
      if (strategy.metric === 'institutionCount') return row.institutionCount
      return performances.value[row.code]?.[strategy.metric] ?? null
    }

    function compareRows(left: TrackRow, right: TrackRow, strategy: SortStrategy): number {
      const leftValue = sortValue(left, strategy)
      const rightValue = sortValue(right, strategy)
      if (leftValue === null && rightValue === null) return left.rank - right.rank
      if (leftValue === null) return 1
      if (rightValue === null) return -1
      if (leftValue === rightValue) return left.rank - right.rank
      return strategy.direction === 'asc' ? leftValue - rightValue : rightValue - leftValue
    }

    const visibleRows = computed(() => {
      const filtered = rowsMatchingIndustryFilters.value.filter((row) => {
        if (!valuationFilter.value) return true
        const state = valuations.value[row.code]?.state || 'pending'
        return state === valuationFilter.value
      }).filter((row) => !ratingFilter.value || ratingFor(row).state === ratingFilter.value)
      return [...filtered].sort((left, right) => compareRows(left, right, selectedSortStrategy.value))
    })

    const level1Counts = computed(() => {
      const countMap = new Map<string, number>()
      rows.value.forEach((row) => countMap.set(row.em2016Level1, (countMap.get(row.em2016Level1) || 0) + 1))
      return [...countMap.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    })

    const level2Options = computed(() => {
      const values = rows.value
        .filter((row) => !level1Filter.value || row.em2016Level1 === level1Filter.value)
        .map((row) => row.em2016Level2)
        .filter(Boolean)
      return [...new Set(values)].sort((left, right) => left.localeCompare(right))
    })

    const level3Options = computed(() => {
      const values = rows.value
        .filter((row) => !level1Filter.value || row.em2016Level1 === level1Filter.value)
        .filter((row) => !level2Filter.value || row.em2016Level2 === level2Filter.value)
        .map((row) => row.em2016Level3)
        .filter(Boolean)
      return [...new Set(values)].sort((left, right) => left.localeCompare(right))
    })

    const industrySummaries = computed(() => {
      const groups = new Map<string, TrackRow[]>()
      visibleRows.value.forEach((row) => {
        const key = level2Filter.value || level3Filter.value
          ? row.em2016Level3
          : level1Filter.value
            ? row.em2016Level2
            : row.em2016Level1
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

    function selectLevel1(track: string) {
      level1Filter.value = track
      if (level2Filter.value && !level2Options.value.includes(level2Filter.value)) {
        level2Filter.value = ''
      }
      if (level3Filter.value && !level3Options.value.includes(level3Filter.value)) {
        level3Filter.value = ''
      }
    }

    function selectLevel2(track: string) {
      level2Filter.value = track
      if (level3Filter.value && !level3Options.value.includes(level3Filter.value)) {
        level3Filter.value = ''
      }
    }

    async function fetchMissingEm2016Profiles(codes: string[]): Promise<Map<string, Em2016ProfileEntry>> {
      const resolved = new Map<string, Em2016ProfileEntry>()
      const queue = [...new Set(codes.map((item) => item.trim()).filter(Boolean))]
      const concurrency = Math.min(4, Math.max(1, queue.length))
      async function worker(): Promise<void> {
        while (queue.length) {
          const code = queue.shift()
          if (!code) continue
          try {
            const overview = await fetchApi<{ companyProfile?: Em2016ProfileEntry | null }>(`/api/company/overview?code=${encodeURIComponent(code)}`)
            const profile = overview.companyProfile
            if (profile) resolved.set(code, profile)
          } catch {
            // Keep failure visibility at the row-assembly boundary below.
          }
        }
      }
      await Promise.all(Array.from({ length: concurrency }, () => worker()))
      return resolved
    }

    async function loadRows() {
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
        if (snapshot.classificationVersion !== 2) throw new Error(`不支持的估值模型版本：${snapshot.classificationVersion}`)
        const em2016ByCode = new Map<string, Em2016ProfileEntry>(
          (em2016ProfileRegistry.profiles || []).map((item) => [String(item.code || '').trim(), item]),
        )
        const missingCodes = list
          .map((stock) => String(stock.SECUCODE || '').trim())
          .filter((code) => !profileLevels(em2016ByCode.get(code)))
        if (missingCodes.length) {
          const fetchedProfiles = await fetchMissingEm2016Profiles(missingCodes)
          fetchedProfiles.forEach((value, key) => em2016ByCode.set(key, value))
        }
        rows.value = list.map((stock, index) => {
          const assignment = snapshot.rows[index]
          if (!assignment.primaryTrack || !assignment.secondaryTrack || !assignment.classificationNote) {
            throw new Error(`${stock.SECUCODE} ${stock.SECURITY_NAME_ABBR} 缺少估值模型映射`)
          }
          const em2016Row = em2016ByCode.get(String(stock.SECUCODE || '').trim())
          if (!em2016Row) {
            throw new Error(`${stock.SECUCODE} ${stock.SECURITY_NAME_ABBR} 缺少东财 EM2016 行业；请运行 npm run sync:eastmoney-company-em2016-profiles 更新本地配置`)
          }
          const levels = profileLevels(em2016Row)
          if (!levels) throw new Error(`${stock.SECUCODE} ${stock.SECURITY_NAME_ABBR} 的东财 EM2016 不可用或不是完整三级路径；请运行 npm run sync:eastmoney-company-em2016-profiles 更新本地配置`)
          const [em2016Level1, em2016Level2, em2016Level3] = levels
          return {
            rank: index + 1,
            code: String(stock.SECUCODE),
            name: String(stock.SECURITY_NAME_ABBR || ''),
            institutionCount: Number(stock.ALLCORP_NUM || 0),
            industry: String(stock.INDUSTRY || stock.BOARD_NAME || '未分类'),
            em2016: em2016Row.industry || `${em2016Level1}-${em2016Level2}-${em2016Level3}`,
            em2016Level1,
            em2016Level2,
            em2016Level3,
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

    function ratingFor(row: TrackRow) {
      const valuation = valuations.value[row.code]
      if (!valuation) {
        return { state: 'insufficient' as const, label: '待评估', rationale: '尚未加载该公司的估值和证据。' }
      }
      return assessInstitutionalTrackRating({
        valuationState: valuation.state,
        confidence: valuation.confidence,
      })
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

    async function loadPerformanceFor(row: TrackRow): Promise<TrackPerformance> {
      try {
        const klineRows = await fetchApi<KlineValuationObservation[]>(`/api/kline?code=${encodeURIComponent(row.code)}&period=day&fq=before&from=${encodeURIComponent(klineStartDate())}&format=structured`)
        const range = calculateLookbackRangePosition(klineRows, sortingRules.lookbackTradingDays)
        return {
          ninetyDayDrawdownPct: range?.drawdownPct ?? null,
          ninetyDayGainPct: range?.gainPct ?? null,
        }
      } catch {
        return {
          ninetyDayDrawdownPct: null,
          ninetyDayGainPct: null,
        }
      }
    }

    function loadPerformances(candidates: TrackRow[]): Promise<void> {
      if (performanceRun) return performanceRun
      const pending = candidates.filter((row) => !Object.prototype.hasOwnProperty.call(performances.value, row.code))
      if (!pending.length) {
        performanceStatus.value = '近90个交易日表现已计算。'
        return Promise.resolve()
      }
      const concurrency = Math.max(1, Math.min(valuationRules.evaluationConcurrency, pending.length))
      performanceRunning.value = true
      performanceRun = (async () => {
        let completed = 0
        let available = 0
        performanceStatus.value = `正在计算近90个交易日表现 0/${pending.length}（最多同时 ${concurrency} 家）…`
        const queue = [...pending]
        const worker = async () => {
          while (queue.length) {
            const row = queue.shift()
            if (!row) continue
            const performance = await loadPerformanceFor(row)
            performances.value = {
              ...performances.value,
              [row.code]: performance,
            }
            if (performance.ninetyDayDrawdownPct !== null && performance.ninetyDayGainPct !== null) available += 1
            completed += 1
            performanceStatus.value = `正在计算近90个交易日表现 ${completed}/${pending.length}；${available} 家数据完整。`
          }
        }
        await Promise.all(Array.from({ length: concurrency }, worker))
        performanceStatus.value = `近90个交易日表现计算完成：${available}/${pending.length} 家数据完整。`
      })()
      return performanceRun.finally(() => {
        performanceRun = null
        performanceRunning.value = false
      })
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
        performances.value = {
          ...performances.value,
          [row.code]: {
            ninetyDayDrawdownPct: pullbackSignal.ninetyDayDrawdownPct,
            ninetyDayGainPct: pullbackSignal.ninetyDayGainPct,
          },
        }
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
              incomeRows,
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
            : model.id === 'bank'
              ? evaluateBankValuation(
                row,
                model,
                latestPb,
                dividendYield,
                latestPrice,
                forecasts,
                incomeRows,
                balanceRows,
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

    function restoreCachedValuations(): void {
      const restored = restoreValuations()
      if (restored) {
        assessmentStatus.value = `已从本地缓存恢复 ${restored} 家公司的评估结果。`
      }
    }

    onMounted(() => {
      void loadRows().then(() => {
        if (!error.value && rows.value.length) {
          restoreCachedValuations()
          void loadPerformances(rows.value)
        }
      })
    })

    return () => h('div', { class: 'container-fluid my-3 institutional-tracks-page' }, [
      h('style', pageStyle),
      h('section', { class: 'institutional-tracks-hero mb-3' }, [
        h('div', { class: 'd-flex flex-wrap justify-content-between gap-3 align-items-end' }, [
          h('div', [
            h('h1', { class: 'h3 mb-2' }, '机构持股 Top300 行业分类'),
            h('p', { class: 'mb-0' }, `按 ALLCORP_NUM 降序；榜单日期 ${rows.value[0]?.tradeDate || snapshot.dataDate || '加载中'}。一级、二级、三级行业使用东财 EM2016 分类；东财概念仅作为主题标签展示。`),
          ]),
        ]),
      ]),
      error.value ? h('div', { class: 'alert alert-danger' }, error.value) : null,
      h('section', { class: 'institutional-tracks-valuation-guide mb-3' }, [
        h('div', { class: 'd-flex flex-wrap align-items-center justify-content-between gap-2' }, [
          h('div', [
            h('div', { class: 'fw-semibold' }, '估值颜色：行业分组与公司分别判断'),
            h('div', { class: 'small text-muted' }, `页面打开后自动计算近90个交易日回撤/涨幅；估值只在点击“评估当前前 ${valuationRules.batchLimit} 家”或单只“评估估值”后计算，结果在本浏览器缓存 ${Math.round(valuationRules.evaluationCache.ttlMs / 60_000)} 分钟。成长类行业同时检查 ${valuationRules.growthPeg.baseForecastYear}E 绝对 PE 和逐年利润路径；红利类行业要求股息率与 ${valuationRules.growthPeg.baseForecastYear}E-${valuationRules.growthPeg.targetForecastYear}E 利润 CAGR 同时成立；银行以近四季股息率为主锚，预测利润增长检验持续性，PB 与滚动 ROE 只作更谨慎的约束；证券和保险使用 PB 与滚动 ROE；周期类行业用连续三年滚动利润中位数计算中周期 PE。机构式评级仅由当前估值结论和证据置信度生成，不创建个人买入计划，也不构成个性化投资建议。`),
          ]),
          h('button', {
            type: 'button',
            class: 'btn btn-sm btn-outline-primary',
            disabled: assessmentRunning.value,
            onClick: () => { void evaluateVisibleRows() },
          }, `评估当前前 ${valuationRules.batchLimit} 家`),
        ]),
        assessmentStatus.value ? h('div', { class: 'small text-muted mt-2' }, assessmentStatus.value) : null,
        performanceStatus.value ? h('div', { class: `small mt-1 ${performanceRunning.value ? 'text-primary' : 'text-muted'}` }, performanceStatus.value) : null,
      ]),
      h('div', { class: 'row g-2 mb-3 align-items-center' }, [
        h('div', { class: 'col-12 col-lg-3' }, [
          h('input', {
            class: 'form-control form-control-sm',
            value: query.value,
            placeholder: '搜索股票、EM2016 行业或概念',
            onInput: (event: Event) => { query.value = (event.target as HTMLInputElement).value },
          }),
        ]),
        h('div', { class: 'col-12 col-lg-3' }, [
          h('select', {
            class: 'form-select form-select-sm',
            value: sortStrategyId.value,
            'aria-label': '股票排序方式',
            onChange: (event: Event) => { sortStrategyId.value = (event.target as HTMLSelectElement).value },
          }, sortingRules.strategies.map((strategy) => h('option', { value: strategy.id }, strategy.label))),
        ]),
        h('div', { class: 'col-12 col-lg-3' }, [
          h('select', {
            class: 'form-select form-select-sm',
            value: level1Filter.value,
            onChange: (event: Event) => selectLevel1((event.target as HTMLSelectElement).value),
          }, [
            h('option', { value: '' }, `全部一级行业（${rows.value.length}）`),
            ...level1Counts.value.map(([track, count]) => h('option', { value: track }, `${track}（${count}）`)),
          ]),
        ]),
        h('div', { class: 'col-12 col-lg-3' }, [
          h('select', {
            class: 'form-select form-select-sm',
            value: level2Filter.value,
            onChange: (event: Event) => selectLevel2((event.target as HTMLSelectElement).value),
          }, [
            h('option', { value: '' }, '全部二级行业'),
            ...level2Options.value.map((track) => h('option', { value: track }, track)),
          ]),
        ]),
        h('div', { class: 'col-12 col-lg-3' }, [
          h('select', {
            class: 'form-select form-select-sm',
            value: level3Filter.value,
            onChange: (event: Event) => { level3Filter.value = (event.target as HTMLSelectElement).value },
          }, [
            h('option', { value: '' }, '全部三级行业'),
            ...level3Options.value.map((track) => h('option', { value: track }, track)),
          ]),
        ]),
        h('div', { class: 'col-12 col-lg-3' }, [
          h('select', {
            class: 'form-select form-select-sm',
            value: valuationFilter.value,
            'aria-label': '按估值状态筛选',
            onChange: (event: Event) => { valuationFilter.value = (event.target as HTMLSelectElement).value as ValuationFilter | '' },
          }, [
            h('option', { value: '' }, `全部估值状态（${rowsMatchingIndustryFilters.value.length}）`),
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
            value: ratingFilter.value,
            'aria-label': '按机构评级筛选',
            onChange: (event: Event) => { ratingFilter.value = (event.target as HTMLSelectElement).value as RatingFilter },
          }, [
            h('option', { value: '' }, '全部机构评级'),
            ...institutionalTrackRatingStates.map((state) => h('option', { value: state }, institutionalTrackRatingMeta[state].label)),
          ]),
        ]),
      ]),
      !loading.value ? h('section', { class: 'institutional-tracks-track-grid mb-3', 'aria-label': '行业估值状态' }, industrySummaries.value.map((summary) => {
        const meta = valuationStateMeta[summary.state]
        return h('div', { key: summary.track, class: `institutional-tracks-track-card ${meta.className}` }, [
          h('div', { class: 'd-flex justify-content-between gap-2' }, [
            h('span', { class: 'fw-semibold' }, summary.track),
            h('span', { class: 'institutional-tracks-valuation-badge ' + meta.className }, meta.label),
          ]),
          h('div', { class: 'small mt-1' }, summary.evaluated >= valuationRules.trackMinimumEvaluatedCompanies
            ? `已按 ${summary.evaluated}/${summary.total} 家有结论公司聚合`
            : `已评估 ${summary.evaluated}/${summary.total} 家；至少 ${valuationRules.trackMinimumEvaluatedCompanies} 家才给行业颜色`),
        ])
      })) : null,
      loading.value
        ? h('div', { class: 'text-center text-muted py-5' }, '正在加载 Top300 并匹配东财 EM2016 行业…')
        : h('div', { class: 'table-responsive border rounded' }, [
          h('table', { class: 'table table-sm table-hover align-middle mb-0 institutional-tracks-table' }, [
            h('thead', { class: 'table-light' }, [h('tr', [
              h('th', '排名'), h('th', '股票'), h('th', '估值状态'), h('th', '机构评级'), h('th', '机构家数'),
              h('th', '一级行业'), h('th', '二级行业'), h('th', '三级行业'), h('th', '近90日回撤'), h('th', '近90日涨幅'),
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
                    ? `近四季股息率 ${formatNumber(valuation.dividendYield)}% / ${valuationRules.growthPeg.baseForecastYear}E-${valuation.forecastYear}E 净利 CAGR ${formatNumber(valuation.profitGrowth)}%${valuation.pb === null && valuation.roe === null ? '' : ` / PB ${formatNumber(valuation.pb, 2)}× / 滚动 ROE ${formatNumber(valuation.roe)}%`}`
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
                const rating = ratingFor(row)
                return h('span', {
                  class: `institutional-tracks-rating is-${rating.state}`,
                  title: rating.rationale,
                }, rating.label)
              })()),
              h('td', { class: 'fw-semibold' }, row.institutionCount.toLocaleString()),
              h('td', { title: row.em2016 }, row.em2016Level1),
              h('td', { title: row.em2016 }, row.em2016Level2),
              h('td', { title: row.em2016 }, row.em2016Level3),
              h('td', { class: performances.value[row.code]?.ninetyDayDrawdownPct === null || performances.value[row.code]?.ninetyDayDrawdownPct === undefined
                ? 'text-muted'
                : 'text-success' }, formatPercent(performances.value[row.code]?.ninetyDayDrawdownPct ?? null)),
              h('td', { class: performances.value[row.code]?.ninetyDayGainPct === null || performances.value[row.code]?.ninetyDayGainPct === undefined
                ? 'text-muted'
                : 'text-danger' }, formatPercent(performances.value[row.code]?.ninetyDayGainPct ?? null, true)),
            ]))),
          ]),
        ]),
      h('p', { class: 'small text-muted mt-2' }, `当前显示 ${visibleRows.value.length} / ${rows.value.length}，排序：${selectedSortStrategy.value.label}。近90日回撤＝当前价相对90个交易日最高价的跌幅；近90日涨幅＝当前价相对90个交易日最低价的涨幅；均按前复权日线计算，数据不足时固定排在末尾。颜色表示基于当前证据的估值状态，不构成个性化投资建议；同机构家数的边界股票按东财原始返回顺序截取，Top300 的 EM2016 行业占比只代表本榜单样本，不代表全市场。`),
    ])
  },
})

const root = document.getElementById('institutional-tracks-vue-root')
if (root) createApp(InstitutionalTracksPage).mount(root)
