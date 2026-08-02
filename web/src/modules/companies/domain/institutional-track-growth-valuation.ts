export type GrowthRatingState = 'deep-value' | 'value' | 'fair' | 'expensive' | 'overvalued'

export type GrowthValuationThresholds = {
  strongBuy: number
  buy: number
  watch: number
  noAdd: number
}

export type GrowthForecastPathPoint = {
  year: number
  netProfit: number
  forwardPe: number
  profitGrowth: number | null
}

type GrowthValuationInput = {
  marketCapYi: number | null
  forecasts: Array<Record<string, unknown>>
  incomeRows: Array<Record<string, unknown>>
  baseForecastYear: number
  targetForecastYear: number
  pegThresholds: GrowthValuationThresholds
  peThresholds: GrowthValuationThresholds
}

export type GrowthValuationResult = {
  status: 'rated' | 'growth-unstable' | 'unavailable'
  state: GrowthRatingState | null
  pegState: GrowthRatingState | null
  peState: GrowthRatingState | null
  baseForwardPe: number | null
  endpointCagr: number | null
  adjustedGrowth: number | null
  peg: number | null
  pathComplete: boolean
  path: GrowthForecastPathPoint[]
  reason: string
}

const stateRisk: Record<GrowthRatingState, number> = {
  'deep-value': 0,
  value: 1,
  fair: 2,
  expensive: 3,
  overvalued: 4,
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function actualAnnualNetProfitYi(incomeRows: Array<Record<string, unknown>>, year: number): number | null {
  const quarters = new Map<string, number>()
  for (const row of incomeRows) {
    const reportDate = String(row.reportDate ?? row.REPORT_DATE ?? '').slice(0, 10)
    if (!reportDate.startsWith(`${year}-`)) continue
    const month = reportDate.slice(5, 7)
    if (!['03', '06', '09', '12'].includes(month) || quarters.has(month)) continue
    if (row.dataSource && row.dataSource !== 'financial_report') continue
    const profit = finiteNumber(row.parentNetprofit ?? row.netProfit ?? row.PARENT_NETPROFIT ?? row.NETPROFIT)
    if (profit !== null) quarters.set(month, profit)
  }
  if (quarters.size !== 4) return null
  const annualProfit = [...quarters.values()].reduce((sum, profit) => sum + profit, 0) / 100_000_000
  return annualProfit > 0 && Number.isFinite(annualProfit) ? annualProfit : null
}

function rateLowerIsBetter(value: number, thresholds: GrowthValuationThresholds): GrowthRatingState {
  if (value <= thresholds.strongBuy) return 'deep-value'
  if (value <= thresholds.buy) return 'value'
  if (value <= thresholds.watch) return 'fair'
  if (value <= thresholds.noAdd) return 'expensive'
  return 'overvalued'
}

function riskierState(left: GrowthRatingState, right: GrowthRatingState): GrowthRatingState {
  return stateRisk[left] >= stateRisk[right] ? left : right
}

function unavailable(reason: string, path: GrowthForecastPathPoint[] = []): GrowthValuationResult {
  return {
    status: 'unavailable',
    state: null,
    pegState: null,
    peState: null,
    baseForwardPe: path[0]?.forwardPe ?? null,
    endpointCagr: null,
    adjustedGrowth: null,
    peg: null,
    pathComplete: false,
    path,
    reason,
  }
}

export function assessInstitutionalTrackGrowthValuation(input: GrowthValuationInput): GrowthValuationResult {
  const {
    marketCapYi,
    forecasts,
    baseForecastYear,
    targetForecastYear,
    pegThresholds,
    peThresholds,
  } = input
  if (marketCapYi === null || !Number.isFinite(marketCapYi) || marketCapYi <= 0) {
    return unavailable('缺少有效实时市值。')
  }
  if (!Number.isInteger(baseForecastYear) || !Number.isInteger(targetForecastYear) || targetForecastYear <= baseForecastYear) {
    return unavailable('成长估值年份配置无效。')
  }

  const forecastByYear = new Map(forecasts.map((forecast) => [Number(forecast.year), forecast]))
  const expectedYears = Array.from(
    { length: targetForecastYear - baseForecastYear + 1 },
    (_, index) => baseForecastYear + index,
  )
  const rawPath = expectedYears.map((year) => {
    const forecast = forecastByYear.get(year)
    const netProfit = finiteNumber(forecast?.netProfit)
    const reportedGrowth = finiteNumber(forecast?.profitGrowth)
    return { year, netProfit, reportedGrowth }
  })
  const missingYear = rawPath.find((point) => point.netProfit === null || point.netProfit <= 0)
  if (missingYear) {
    return unavailable(`缺少 ${missingYear.year}E 正利润预测，不能用远期年份跨过中间空档。`)
  }

  const baseActualProfit = actualAnnualNetProfitYi(input.incomeRows, baseForecastYear - 1)
  const path = rawPath.map((point, index): GrowthForecastPathPoint => {
    const netProfit = point.netProfit!
    const previousProfit = index > 0 ? rawPath[index - 1].netProfit! : baseActualProfit
    return {
      year: point.year,
      netProfit,
      forwardPe: marketCapYi / netProfit,
      profitGrowth: previousProfit === null
        ? point.reportedGrowth
        : ((netProfit / previousProfit) - 1) * 100,
    }
  })
  const baseForwardPe = path[0].forwardPe
  const baseProfit = path[0].netProfit
  const targetProfit = path[path.length - 1].netProfit
  const endpointCagr = ((targetProfit / baseProfit) ** (1 / (targetForecastYear - baseForecastYear)) - 1) * 100
  const growthPath = path.map((point) => point.profitGrowth).filter((growth): growth is number => growth !== null)
  const pathComplete = growthPath.length === path.length
  if (endpointCagr <= 0 || growthPath.some((growth) => growth <= 0)) {
    return {
      status: 'growth-unstable',
      state: null,
      pegState: null,
      peState: rateLowerIsBetter(baseForwardPe, peThresholds),
      baseForwardPe,
      endpointCagr,
      adjustedGrowth: null,
      peg: null,
      pathComplete,
      path,
      reason: '预测期内存在净利润不增长或下滑年份，不能用后续反弹抵消增长断档。',
    }
  }

  const harmonicGrowth = growthPath.length / growthPath.reduce((sum, growth) => sum + (1 / growth), 0)
  const adjustedGrowth = Math.min(endpointCagr, harmonicGrowth)
  if (!Number.isFinite(adjustedGrowth) || adjustedGrowth <= 0) {
    return unavailable('逐年利润路径不足，无法得到有效的路径调整增速。', path)
  }
  const peg = baseForwardPe / adjustedGrowth
  const pegState = rateLowerIsBetter(peg, pegThresholds)
  const peState = rateLowerIsBetter(baseForwardPe, peThresholds)
  return {
    status: 'rated',
    state: riskierState(pegState, peState),
    pegState,
    peState,
    baseForwardPe,
    endpointCagr,
    adjustedGrowth,
    peg,
    pathComplete,
    path,
    reason: pathComplete
      ? baseActualProfit === null
        ? '采用完整逐年净利增速路径。'
        : `采用 ${baseForecastYear - 1}A 实际净利及完整逐年预测增速路径。`
      : `缺少 ${baseForecastYear}E 同比增速，已用预测期内相邻年度增速保守计算。`,
  }
}
