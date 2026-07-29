import companiesFollowConfig from '../../../config/companies-follow.json'
import companiesFollowRiskConfig from '../../../config/companies-follow-risk.json'
import {
  analyzeStopLoss,
  recommendPosition,
  type PositionAction,
  type PositionReason,
  type PositionSizingConfig,
  type StopLossRiskConfig,
  type StopLossRiskLevel,
} from '../domain/stop-loss-analysis'

type Callback = (data: unknown) => void
type CodesCallback = (codes: string[]) => void

interface CompaniesFollowForecastDisplay {
  year: number
  revenue: string
  revenueGrowth: string
  profit: string
  profitGrowth: string
  pe: string
  savedAt: string
}

interface CompaniesFollowTableRow {
  code: string
  track: string
  name: string
  price: string
  changeRatio: string
  positionPct: number
  costPrice: number | null
  suggestedPositionPct: number
  actionType: PositionAction
  action: string
  riskLevel: StopLossRiskLevel | 'unavailable'
  risk: string
  riskScore: number
  riskDetail: string
  stopLoss: string
  stopTriggered: boolean
  operationAdvice: string
  high90: string
  low90: string
  high180: string
  low180: string
  marketValueYi: string
  peTtm: string
  forecasts: CompaniesFollowForecastDisplay[]
}

const stopLossRiskConfig = companiesFollowRiskConfig as StopLossRiskConfig
const positionSizingConfig = companiesFollowRiskConfig.positionSizing as PositionSizingConfig

interface CompaniesFollowForecastConfig {
  version?: number
  tracks?: Record<string, string>
  positions?: Record<string, number>
  costs?: Record<string, number>
  riskPolicy?: {
    accountRiskPct?: number
    maxStockPositionPct?: number
  }
  profits?: Record<string, Record<string, number>>
  profitSavedAt?: Record<string, Record<string, string>>
}

type CompaniesFollowConfigStorage = 'backend' | 'browser'

interface CompaniesFollowConfigResponse extends CompaniesFollowForecastConfig {
  storage?: CompaniesFollowConfigStorage
  configured?: boolean
  error?: string
}

interface CompaniesFollowOverview {
  marketCapYi?: number | null
  peTtm?: number | null
}

type CompaniesFollowRuntimeContext = {
  server: string
  query: Record<string, any>
  fetchRequest: (request: {
    url?: string
    params?: Record<string, unknown>
    data?: unknown
    cacheKey?: string
    cacheTtl?: number
    silent?: boolean
  }) => Promise<unknown>
  cache: Record<string, unknown>
  codeNameMap: Record<string, string>
  fetchCodeNames: (codes: string[], callback: Callback) => void
  fetchKlines: (codes: string[], fq: string, callback: (codes: string[]) => void) => void
  fetchCodesData: (codes: string[], fetcher: (code: string, callback: Callback) => void, callback: CodesCallback) => void
  fetchFinanceIncome: (code: string, callback: Callback) => void
  selectedOptionValues: (element: Element | null) => string[]
  replaceUrlParam: (key: string, value: string) => void
  codeSelectInit: (cats: string[], id: string, placeholder: string, disabled: boolean) => void
}

export function createCompaniesFollowInitializer(context: CompaniesFollowRuntimeContext) {
  const {
    server,
    query,
    fetchRequest,
    cache,
    codeNameMap,
    fetchCodeNames,
    fetchKlines,
    fetchCodesData,
    fetchFinanceIncome,
    selectedOptionValues,
    replaceUrlParam,
    codeSelectInit,
  } = context

  let companiesFollowForecastConfig: CompaniesFollowForecastConfig = {
    version: 1,
    tracks: {},
    positions: {},
    costs: {},
    riskPolicy: {},
    profits: {},
    profitSavedAt: {},
  }
  let savedCompaniesFollowProfits: Record<string, Record<string, number>> = {}
  let companiesFollowConfigStorage: CompaniesFollowConfigStorage = 'browser'
  let companiesFollowRows: CompaniesFollowTableRow[] = []
  let companiesFollowCodes: string[] = []
  let companiesFollowLoadVersion = 0
  const companiesFollowReportForecastInflight = new Map<string, Promise<unknown>>()
  const companiesFollowBrowserStorageKey = 'companies-follow-config'

  function normalizeCompaniesFollowCode(code: string): string {
    const trimmed = String(code || '').trim()
    if (!trimmed) {
      return ''
    }
    const lower = trimmed.toLowerCase()
    if (lower.includes('.')) {
      const upper = trimmed.toUpperCase()
      return upper.endsWith('.HK') ? upper.padStart(8, '0') : upper
    }
    if (lower.startsWith('sh')) {
      return `${lower.slice(2).toUpperCase()}.SH`
    }
    if (lower.startsWith('sz')) {
      return `${lower.slice(2).toUpperCase()}.SZ`
    }
    if (lower.startsWith('bj')) {
      return `${lower.slice(2).toUpperCase()}.BJ`
    }
    if (lower.startsWith('hk')) {
      return `${lower.slice(2).toUpperCase()}.HK`.padStart(8, '0')
    }
    if (lower.startsWith('us')) {
      return `${lower.slice(2).toUpperCase()}.US`
    }
    if (trimmed.length < 6) {
      return `${trimmed.toUpperCase()}.HK`.padStart(8, '0')
    }
    if (trimmed.startsWith('0') || trimmed.startsWith('1') || trimmed.startsWith('3')) {
      return `${trimmed.toUpperCase()}.SZ`
    }
    if (trimmed.startsWith('8')) {
      return `${trimmed.toUpperCase()}.BJ`
    }
    return `${trimmed.toUpperCase()}.SH`
  }

  function normalizeCompaniesFollowCodes(codes: string[]): string[] {
    const normalized: string[] = []
    const seen = new Set<string>()
    for (const code of codes) {
      const next = normalizeCompaniesFollowCode(code)
      if (!next || seen.has(next)) {
        continue
      }
      seen.add(next)
      normalized.push(next)
    }
    return normalized
  }

  function emitCompaniesFollowStatus(message: string, danger = false): boolean {
    window.dispatchEvent(new CustomEvent('licai:companies-follow-status', { detail: { message, danger } }))
    return true
  }

  function emitCompaniesFollowYearHeaders(years: number[]): boolean {
    window.dispatchEvent(new CustomEvent('licai:companies-follow-years', { detail: { years } }))
    return true
  }

  function emitCompaniesFollowRows(rows: CompaniesFollowTableRow[]): boolean {
    window.dispatchEvent(new CustomEvent('licai:companies-follow-rows', { detail: { rows } }))
    return true
  }

  function emitCompaniesFollowRiskPolicy(): boolean {
    window.dispatchEvent(new CustomEvent('licai:companies-follow-policy', {
      detail: currentCompaniesFollowRiskPolicy(),
    }))
    return true
  }

  function setCompaniesFollowForecastStatus(message: string, danger = false): void {
    emitCompaniesFollowStatus(message, danger)
  }

  async function loadCompaniesFollowForecastConfig(): Promise<void> {
    const data = await fetchRequest({
      url: `${server}/api/companies/follow/forecast`,
      silent: true,
    }) as CompaniesFollowConfigResponse
    companiesFollowConfigStorage = data?.storage === 'backend' ? 'backend' : 'browser'
    if (companiesFollowConfigStorage === 'backend') {
      companiesFollowForecastConfig = data.configured === false
        ? normalizeCompaniesFollowConfig(companiesFollowConfig)
        : normalizeCompaniesFollowConfig(data)
      savedCompaniesFollowProfits = cloneCompaniesFollowProfits(companiesFollowForecastConfig.profits)
      return
    }
    companiesFollowForecastConfig = loadCompaniesFollowBrowserConfig()
    savedCompaniesFollowProfits = cloneCompaniesFollowProfits(companiesFollowForecastConfig.profits)
  }

  async function saveCompaniesFollowForecastConfig(): Promise<void> {
    setCompaniesFollowForecastStatus('正在保存...')
    const configToSave = withUpdatedCompaniesFollowProfitDates(
      companiesFollowForecastConfig,
      savedCompaniesFollowProfits,
      new Date().toISOString(),
    )
    if (companiesFollowConfigStorage === 'browser') {
      localStorage.setItem(companiesFollowBrowserStorageKey, JSON.stringify(configToSave))
      companiesFollowForecastConfig = configToSave
      savedCompaniesFollowProfits = cloneCompaniesFollowProfits(configToSave.profits)
      refreshCompaniesFollowRows()
      setCompaniesFollowForecastStatus('已保存到当前浏览器')
      return
    }
    const saved = await fetchRequest({
      url: `${server}/api/companies/follow/forecast`,
      data: configToSave,
      silent: true,
    }) as CompaniesFollowConfigResponse
    if (saved?.error) {
      throw new Error(saved.error)
    }
    companiesFollowForecastConfig = normalizeCompaniesFollowConfig(saved)
    savedCompaniesFollowProfits = cloneCompaniesFollowProfits(companiesFollowForecastConfig.profits)
    refreshCompaniesFollowRows()
    setCompaniesFollowForecastStatus('已保存到本地 D1')
  }

  function normalizeCompaniesFollowConfig(value: CompaniesFollowForecastConfig | null | undefined): CompaniesFollowForecastConfig {
    return {
      version: 1,
      tracks: value?.tracks && typeof value.tracks === 'object' ? { ...value.tracks } : {},
      positions: cloneCompaniesFollowPositions(value?.positions),
      costs: cloneCompaniesFollowCosts(value?.costs),
      riskPolicy: normalizeCompaniesFollowRiskPolicy(value?.riskPolicy),
      profits: cloneCompaniesFollowProfits(value?.profits),
      profitSavedAt: cloneCompaniesFollowProfitDates(value?.profitSavedAt),
    }
  }

  function cloneCompaniesFollowProfits(value: CompaniesFollowForecastConfig['profits']): Record<string, Record<string, number>> {
    return Object.fromEntries(Object.entries(value || {}).map(([code, years]) => [code, { ...years }]))
  }

  function cloneCompaniesFollowPositions(value: CompaniesFollowForecastConfig['positions']): Record<string, number> {
    return Object.fromEntries(Object.entries(value || {}).filter(([, position]) => (
      typeof position === 'number' && Number.isFinite(position) && position > 0 && position <= 100
    )))
  }

  function cloneCompaniesFollowCosts(value: CompaniesFollowForecastConfig['costs']): Record<string, number> {
    return Object.fromEntries(Object.entries(value || {}).filter(([, cost]) => (
      typeof cost === 'number' && Number.isFinite(cost) && cost > 0
    )))
  }

  function normalizeCompaniesFollowRiskPolicy(
    value: CompaniesFollowForecastConfig['riskPolicy'],
  ): NonNullable<CompaniesFollowForecastConfig['riskPolicy']> {
    const accountRiskPct = typeof value?.accountRiskPct === 'number' && value.accountRiskPct > 0 && value.accountRiskPct <= 5
      ? value.accountRiskPct
      : positionSizingConfig.defaultAccountRiskPct
    const maxStockPositionPct = typeof value?.maxStockPositionPct === 'number' && value.maxStockPositionPct > 0 && value.maxStockPositionPct <= 100
      ? value.maxStockPositionPct
      : positionSizingConfig.defaultMaxStockPositionPct
    return { accountRiskPct, maxStockPositionPct }
  }

  function currentCompaniesFollowRiskPolicy(): { accountRiskPct: number, maxStockPositionPct: number } {
    const policy = normalizeCompaniesFollowRiskPolicy(companiesFollowForecastConfig.riskPolicy)
    return {
      accountRiskPct: policy.accountRiskPct as number,
      maxStockPositionPct: policy.maxStockPositionPct as number,
    }
  }

  function cloneCompaniesFollowProfitDates(value: CompaniesFollowForecastConfig['profitSavedAt']): Record<string, Record<string, string>> {
    return Object.fromEntries(Object.entries(value || {}).map(([code, years]) => [code, { ...years }]))
  }

  function withUpdatedCompaniesFollowProfitDates(
    config: CompaniesFollowForecastConfig,
    savedProfits: Record<string, Record<string, number>>,
    savedAt: string,
  ): CompaniesFollowForecastConfig {
    const next = normalizeCompaniesFollowConfig(config)
    const nextProfits = next.profits || {}
    const nextDates = next.profitSavedAt || {}
    const codes = new Set([...Object.keys(savedProfits), ...Object.keys(nextProfits)])
    for (const code of codes) {
      const years = new Set([
        ...Object.keys(savedProfits[code] || {}),
        ...Object.keys(nextProfits[code] || {}),
      ])
      for (const year of years) {
        const previousProfit = savedProfits[code]?.[year]
        const nextProfit = nextProfits[code]?.[year]
        if (previousProfit === nextProfit) {
          continue
        }
        if (nextProfit === undefined) {
          delete nextDates[code]?.[year]
        } else {
          if (!nextDates[code]) {
            nextDates[code] = {}
          }
          nextDates[code][year] = savedAt
        }
      }
      if (nextDates[code] && Object.keys(nextDates[code]).length === 0) {
        delete nextDates[code]
      }
    }
    return next
  }

  function loadCompaniesFollowBrowserConfig(): CompaniesFollowForecastConfig {
    const bundledConfig = normalizeCompaniesFollowConfig(companiesFollowConfig)
    const stored = localStorage.getItem(companiesFollowBrowserStorageKey)
    if (!stored) {
      return bundledConfig
    }
    try {
      return normalizeCompaniesFollowConfig(JSON.parse(stored) as CompaniesFollowForecastConfig)
    } catch (error) {
      console.warn('Invalid companies follow browser config', error)
      return bundledConfig
    }
  }

  function getCompaniesFollowForecastYears(): number[] {
    const currentYear = new Date().getFullYear()
    return [currentYear, currentYear + 1, currentYear + 2]
  }

  function parseCompaniesFollowNumber(value: unknown): number | null {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null
    }
    if (typeof value === 'string') {
      const normalized = value.replace(/,/g, '').trim()
      if (!normalized || normalized === '-' || normalized === '--') {
        return null
      }
      const matched = normalized.match(/-?\d+(\.\d+)?/)
      if (!matched) {
        return null
      }
      const parsed = Number(matched[0])
      return Number.isFinite(parsed) ? parsed : null
    }
    return null
  }

  function formatCompaniesFollowNumber(value: number | null): string {
    return value === null ? '-' : value.toFixed(2)
  }

  function formatCompaniesFollowPercent(value: number | null): string {
    return value === null ? '-' : value.toFixed(2)
  }

  function formatCompaniesFollowPrice(value: number): string {
    if (value >= 100) return value.toFixed(2)
    if (value >= 10) return value.toFixed(3)
    return value.toFixed(4)
  }

  function buildCompaniesFollowRiskFields(
    kline: number[][],
    positionPct: number,
    costPrice: number | null,
  ): Pick<CompaniesFollowTableRow,
    'suggestedPositionPct' | 'actionType' | 'action' | 'riskLevel' | 'risk' | 'riskScore' | 'riskDetail' | 'stopLoss' | 'stopTriggered' | 'operationAdvice'> {
    const analysis = analyzeStopLoss(kline, stopLossRiskConfig)
    const policy = currentCompaniesFollowRiskPolicy()
    const recommendation = recommendPosition(analysis, {
      currentPositionPct: positionPct,
      costPrice,
      accountRiskPct: policy.accountRiskPct,
      maxStockPositionPct: policy.maxStockPositionPct,
    }, positionSizingConfig)
    const actionLabels: Record<PositionAction, string> = {
      build: '建仓',
      add: '加仓',
      hold: '持有',
      reduce: '减仓',
      exit: '清仓',
      watch: '观察',
    }
    if (!analysis.available) {
      return {
        suggestedPositionPct: recommendation.suggestedPositionPct,
        actionType: recommendation.action,
        action: actionLabels[recommendation.action],
        riskLevel: 'unavailable',
        risk: '数据不足',
        riskScore: -1,
        riskDetail: `仅有 ${analysis.validBars} 根有效日K，至少需要 ${stopLossRiskConfig.minimumBars} 根`,
        stopLoss: '-',
        stopTriggered: false,
        operationAdvice: '暂不生成止损建议',
      }
    }

    const riskLabels: Record<StopLossRiskLevel, string> = {
      high: '高风险',
      down: '下跌',
      weak: '转弱',
      stable: '稳健',
    }
    const stopPrice = formatCompaniesFollowPrice(analysis.stopPrice)
    const priorSupport = formatCompaniesFollowPrice(analysis.priorSupport)
    const positionLabel = formatCompaniesFollowPosition(positionPct)
    const suggestedLabel = formatCompaniesFollowPosition(recommendation.suggestedPositionPct)
    const riskLimitLabel = formatCompaniesFollowPosition(recommendation.riskBasedMaxPositionPct)
    const profitPct = costPrice && costPrice > 0 ? (analysis.close / costPrice - 1) * 100 : null
    let operationAdvice: string
    switch (recommendation.action) {
      case 'build':
        operationAdvice = `分批建仓至 ${suggestedLabel}%；风险仓位上限 ${riskLimitLabel}%`
        break
      case 'add':
        operationAdvice = `当前 ${positionLabel}%；建议加仓至 ${suggestedLabel}%`
        break
      case 'hold':
        operationAdvice = recommendation.reason === 'data'
          ? 'K线不足，维持当前仓位并等待数据完整'
          : `当前 ${positionLabel}%；仓位与风险上限匹配，继续持有`
        break
      case 'reduce':
        if (recommendation.reason === 'takeProfit' && profitPct !== null) {
          operationAdvice = `浮盈 ${profitPct.toFixed(2)}%；建议止盈至 ${suggestedLabel}%`
        } else if (recommendation.reason === 'position') {
          operationAdvice = `超过风险仓位上限 ${riskLimitLabel}%；减仓至 ${suggestedLabel}%`
        } else {
          operationAdvice = `趋势${riskLabels[analysis.riskLevel]}；建议减仓至 ${suggestedLabel}%`
        }
        break
      case 'exit':
        if (recommendation.reason === 'takeProfit' && profitPct !== null) {
          operationAdvice = `浮盈 ${profitPct.toFixed(2)}%；下一收盘仍低于 ${priorSupport}，保护利润清仓`
        } else if (profitPct !== null) {
          operationAdvice = `浮亏 ${Math.abs(profitPct).toFixed(2)}%；下一收盘仍低于 ${priorSupport}，止损清仓`
        } else {
          operationAdvice = `成本价未填；下一收盘仍低于 ${priorSupport}，按破位清仓`
        }
        break
      case 'watch':
        operationAdvice = recommendation.reason === 'data' ? 'K线不足，暂不建立仓位' : '空仓观察，等待趋势转稳'
        break
    }
    return {
      suggestedPositionPct: recommendation.suggestedPositionPct,
      actionType: recommendation.action,
      action: actionLabels[recommendation.action],
      riskLevel: analysis.riskLevel,
      risk: riskLabels[analysis.riskLevel],
      riskScore: analysis.riskScore,
      riskDetail: [
        `数据日 ${analysis.priceDate}`,
        `近20日 ${analysis.return20Pct.toFixed(2)}%`,
        `60日回撤 ${analysis.drawdown60Pct.toFixed(2)}%`,
        `ATR14 ${analysis.atrPct.toFixed(2)}%`,
      ].join('；'),
      stopLoss: analysis.supportBroken ? '已触发' : stopPrice,
      stopTriggered: analysis.supportBroken,
      operationAdvice,
    }
  }

  function formatCompaniesFollowPosition(value: number): string {
    return Number.isInteger(value) ? String(value) : value.toFixed(1)
  }

  function calcCompaniesFollowGrowth(base: number | null, target: number | null): number | null {
    if (base === null || target === null || base <= 0 || target <= 0) {
      return null
    }
    return (target / base - 1) * 100
  }

  function calcCompaniesFollowPE(marketValueYi: number, profitYi: number | null): number | null {
    if (!marketValueYi || marketValueYi <= 0 || profitYi === null || profitYi <= 0) {
      return null
    }
    return marketValueYi / profitYi
  }

  function getCompaniesFollowLatestAnnualFinancial(code: string): { revenue: number | null, profit: number | null } {
    const items = cache[`${code}-fsi`] as any[] | undefined
    if (!Array.isArray(items) || items.length === 0) {
      return { revenue: null, profit: null }
    }
    const annualMap: Record<string, {
      revenue: { sum: number, months: Record<string, boolean> }
      profit: { sum: number, months: Record<string, boolean> }
    }> = {}
    for (const item of items) {
      const reportDate = typeof item.reportDate === 'string' ? item.reportDate : ''
      if (reportDate.length < 10) {
        continue
      }
      const month = reportDate.slice(5, 7)
      if (!['03', '06', '09', '12'].includes(month)) {
        continue
      }
      const year = reportDate.slice(0, 4)
      if (!annualMap[year]) {
        annualMap[year] = {
          revenue: { sum: 0, months: {} },
          profit: { sum: 0, months: {} },
        }
      }
      const revenue = parseCompaniesFollowNumber(item.totalOperateIncome ?? item.operateIncome)
      if (revenue !== null && !annualMap[year].revenue.months[month]) {
        annualMap[year].revenue.sum += revenue
        annualMap[year].revenue.months[month] = true
      }
      const profit = parseCompaniesFollowNumber(item.parentNetprofit ?? item.netProfit)
      if (profit !== null && !annualMap[year].profit.months[month]) {
        annualMap[year].profit.sum += profit
        annualMap[year].profit.months[month] = true
      }
    }
    const years = Object.keys(annualMap).sort().reverse()
    for (const year of years) {
      const annual = annualMap[year]
      const revenue = Object.keys(annual.revenue.months).length >= 4 && annual.revenue.sum > 0
        ? annual.revenue.sum / 1e8
        : null
      const profit = Object.keys(annual.profit.months).length >= 4 && annual.profit.sum > 0
        ? annual.profit.sum / 1e8
        : null
      if (revenue !== null || profit !== null) {
        return { revenue, profit }
      }
    }
    return { revenue: null, profit: null }
  }

  function getCompaniesFollowForecastProfit(code: string, year: number, forecastMap: Map<number, number>): number | null {
    const manual = companiesFollowForecastConfig.profits?.[code]?.[String(year)]
    if (typeof manual === 'number' && Number.isFinite(manual) && manual > 0) {
      return manual
    }
    return forecastMap.get(year) ?? null
  }

  function buildCompaniesFollowForecastRow(code: string, marketValueYi: number): Record<string, string> {
    const forecastItems = cache[`${code}-rf`] as Array<{
      year: number
      revenue?: number
      revenueGrowth?: number
      netProfit?: number
    }> | undefined
    const revenueMap = new Map<number, number>()
    const revenueGrowthMap = new Map<number, number>()
    const profitMap = new Map<number, number>()
    if (Array.isArray(forecastItems)) {
      for (const item of forecastItems) {
        if (!item || typeof item.year !== 'number') {
          continue
        }
        if (typeof item.revenue === 'number' && item.revenue > 0) {
          revenueMap.set(item.year, item.revenue)
        }
        if (typeof item.revenueGrowth === 'number' && Number.isFinite(item.revenueGrowth)) {
          revenueGrowthMap.set(item.year, item.revenueGrowth)
        }
        if (typeof item.netProfit === 'number' && item.netProfit > 0) {
          profitMap.set(item.year, item.netProfit)
        }
      }
    }
    const years = getCompaniesFollowForecastYears()
    const latestActual = getCompaniesFollowLatestAnnualFinancial(code)
    const revenue0 = revenueMap.get(years[0]) ?? null
    const revenue1 = revenueMap.get(years[1]) ?? null
    const revenue2 = revenueMap.get(years[2]) ?? null
    const profit0 = getCompaniesFollowForecastProfit(code, years[0], profitMap)
    const profit1 = getCompaniesFollowForecastProfit(code, years[1], profitMap)
    const profit2 = getCompaniesFollowForecastProfit(code, years[2], profitMap)
    return {
      revenue0: formatCompaniesFollowNumber(revenue0),
      revenueGrowth0: formatCompaniesFollowPercent(revenueGrowthMap.get(years[0]) ?? calcCompaniesFollowGrowth(latestActual.revenue, revenue0)),
      profit0: formatCompaniesFollowNumber(profit0),
      profitGrowth0: formatCompaniesFollowPercent(calcCompaniesFollowGrowth(latestActual.profit, profit0)),
      pe0: formatCompaniesFollowNumber(calcCompaniesFollowPE(marketValueYi, profit0)),
      revenue1: formatCompaniesFollowNumber(revenue1),
      revenueGrowth1: formatCompaniesFollowPercent(revenueGrowthMap.get(years[1]) ?? calcCompaniesFollowGrowth(revenue0, revenue1)),
      profit1: formatCompaniesFollowNumber(profit1),
      profitGrowth1: formatCompaniesFollowPercent(calcCompaniesFollowGrowth(profit0, profit1)),
      pe1: formatCompaniesFollowNumber(calcCompaniesFollowPE(marketValueYi, profit1)),
      revenue2: formatCompaniesFollowNumber(revenue2),
      revenueGrowth2: formatCompaniesFollowPercent(revenueGrowthMap.get(years[2]) ?? calcCompaniesFollowGrowth(revenue1, revenue2)),
      profit2: formatCompaniesFollowNumber(profit2),
      profitGrowth2: formatCompaniesFollowPercent(calcCompaniesFollowGrowth(profit1, profit2)),
      pe2: formatCompaniesFollowNumber(calcCompaniesFollowPE(marketValueYi, profit2)),
    }
  }

  function fetchReportForecast(code: string, callback: (code: string, failed: boolean) => void): void {
    const cacheKey = `${code}-rf`
    if (cache[cacheKey] !== undefined) {
      callback(code, false)
      return
    }

    let request = companiesFollowReportForecastInflight.get(code)
    if (!request) {
      request = fetchRequest({
        url: `${server}/api/report/forecast`,
        params: { code },
        silent: true,
      }).then((data: unknown) => {
        if (data && typeof data === 'object' && 'error' in data) {
          const message = (data as { error?: unknown }).error
          throw new Error(typeof message === 'string' ? message : '研报预测加载失败')
        }
        cache[cacheKey] = data
        return data
      }).finally(() => {
        companiesFollowReportForecastInflight.delete(code)
      })
      companiesFollowReportForecastInflight.set(code, request)
    }

    void request.then(() => {
      callback(code, false)
    }).catch((error) => {
      console.warn(`Report forecast unavailable for ${code}:`, error)
      callback(code, true)
    })
  }

  function fetchReportForecasts(
    codes: string[],
    onProgress: (code: string) => void,
    callback: (codes: string[], failedCodes: string[]) => void,
  ): void {
    const should = codes.length
    let done = 0
    const failedCodes: string[] = []
    if (should === 0) {
      callback(codes, failedCodes)
      return
    }
    const success = (code: string, failed: boolean) => {
      done += 1
      if (failed) {
        failedCodes.push(code)
      }
      onProgress(code)
      if (done === should) {
        callback(codes, failedCodes)
      }
    }
    for (const code of codes) {
      fetchReportForecast(code, success)
    }
  }

  function fetchCompaniesFollowOverview(code: string, callback: Callback): void {
    const cacheKey = `${code}-companies-follow-overview`
    if (cache[cacheKey] !== undefined) {
      callback(code)
      return
    }
    void fetchRequest({
      url: `${server}/api/company/overview`,
      params: { code },
      silent: true,
    }).then((data) => {
      if (data && typeof data === 'object' && 'error' in data) {
        console.warn(`Company overview unavailable for ${code}:`, data)
        callback(code)
        return
      }
      cache[cacheKey] = data
      callback(code)
    })
  }

  function buildCompaniesFollowTableRow(code: string, days: number[]): CompaniesFollowTableRow | null {
    const kline = cache[code] as number[][] | undefined
    if (!kline || kline.length < 2) {
      return null
    }
    const idx = kline.length - 1
    const price = kline[idx][1]
    const changeRatio = price * 100 / kline[idx - 1][1] - 100
    const high: Record<number, number> = {}
    const low: Record<number, number> = {}
    const dayMetrics = new Map<number, { high: string, low: string }>()
    const lastDayTs = kline[idx][0]
    for (let j = kline.length - 1; j >= 0; j -= 1) {
      for (let k = 0; k < days.length; k += 1) {
        const day = days[k]
        if (!(day in high)) {
          high[day] = 0
        }
        if (!(day in low)) {
          low[day] = 9999999
        }
        const ts = lastDayTs - 24 * 3600 * 1000 * day
        if (ts < kline[j][0]) {
          if (kline[j][1] > high[day]) {
            high[day] = kline[j][1]
          }
          if (kline[j][1] < low[day]) {
            low[day] = kline[j][1]
          }
        } else if (!dayMetrics.has(day)) {
          dayMetrics.set(day, {
            high: (price * 100 / high[day] - 100).toFixed(2),
            low: (price * 100 / low[day] - 100).toFixed(2),
          })
        }
      }
    }
    const overview = cache[`${code}-companies-follow-overview`] as CompaniesFollowOverview | undefined
    const marketValueYi = parseCompaniesFollowNumber(overview?.marketCapYi)
    const peTtm = parseCompaniesFollowNumber(overview?.peTtm)
    const forecast = buildCompaniesFollowForecastRow(code, marketValueYi ?? 0)
    const positionPct = companiesFollowForecastConfig.positions?.[code] || 0
    const costPrice = companiesFollowForecastConfig.costs?.[code] || null
    const riskFields = buildCompaniesFollowRiskFields(kline, positionPct, costPrice)
    const years = getCompaniesFollowForecastYears()
    return {
      code,
      track: companiesFollowForecastConfig.tracks?.[code] || '-',
      name: codeNameMap[code] || code,
      price: formatCompaniesFollowNumber(price),
      changeRatio: changeRatio.toFixed(2),
      positionPct,
      costPrice,
      ...riskFields,
      high90: dayMetrics.get(90)?.high || '-',
      low90: dayMetrics.get(90)?.low || '-',
      high180: dayMetrics.get(180)?.high || '-',
      low180: dayMetrics.get(180)?.low || '-',
      marketValueYi: formatCompaniesFollowNumber(marketValueYi),
      peTtm: formatCompaniesFollowNumber(peTtm),
      forecasts: years.map((year, offset) => ({
        year,
        revenue: forecast[`revenue${offset}` as keyof typeof forecast],
        revenueGrowth: forecast[`revenueGrowth${offset}` as keyof typeof forecast],
        profit: forecast[`profit${offset}` as keyof typeof forecast],
        profitGrowth: forecast[`profitGrowth${offset}` as keyof typeof forecast],
        pe: forecast[`pe${offset}` as keyof typeof forecast],
        savedAt: companiesFollowForecastConfig.profitSavedAt?.[code]?.[String(year)] || '',
      })),
    }
  }

  function refreshCompaniesFollowRows(): void {
    const days = [90, 180]
    companiesFollowRows = companiesFollowCodes.map((code) => buildCompaniesFollowTableRow(code, days)).filter((row): row is CompaniesFollowTableRow => Boolean(row))
    emitCompaniesFollowRows(companiesFollowRows)
  }

  function updateCompaniesFollowForecastConfig(code: string, year: string, profit: number | null): void {
    if (!companiesFollowForecastConfig.profits) {
      companiesFollowForecastConfig.profits = {}
    }
    if (profit === null || profit <= 0) {
      delete companiesFollowForecastConfig.profits[code]?.[year]
      if (companiesFollowForecastConfig.profits[code] && Object.keys(companiesFollowForecastConfig.profits[code]).length === 0) {
        delete companiesFollowForecastConfig.profits[code]
      }
      return
    }
    if (!companiesFollowForecastConfig.profits[code]) {
      companiesFollowForecastConfig.profits[code] = {}
    }
    companiesFollowForecastConfig.profits[code][year] = profit
  }

  function updateCompaniesFollowTrackConfig(code: string, track: string): void {
    if (!companiesFollowForecastConfig.tracks) {
      companiesFollowForecastConfig.tracks = {}
    }
    const normalized = track.trim()
    if (!normalized) {
      delete companiesFollowForecastConfig.tracks[code]
      return
    }
    companiesFollowForecastConfig.tracks[code] = normalized
  }

  function updateCompaniesFollowPositionConfig(code: string, position: number | null): void {
    if (!companiesFollowForecastConfig.positions) {
      companiesFollowForecastConfig.positions = {}
    }
    if (position === null || position <= 0) {
      delete companiesFollowForecastConfig.positions[code]
      return
    }
    companiesFollowForecastConfig.positions[code] = Math.min(100, position)
  }

  function updateCompaniesFollowCostConfig(code: string, cost: number | null): void {
    if (!companiesFollowForecastConfig.costs) {
      companiesFollowForecastConfig.costs = {}
    }
    if (cost === null || cost <= 0) {
      delete companiesFollowForecastConfig.costs[code]
      return
    }
    companiesFollowForecastConfig.costs[code] = cost
  }

  function updateCompaniesFollowRiskPolicy(detail: { accountRiskPct?: unknown, maxStockPositionPct?: unknown }): void {
    const current = currentCompaniesFollowRiskPolicy()
    const accountRiskPct = parseCompaniesFollowNumber(detail.accountRiskPct)
    const maxStockPositionPct = parseCompaniesFollowNumber(detail.maxStockPositionPct)
    companiesFollowForecastConfig.riskPolicy = normalizeCompaniesFollowRiskPolicy({
      accountRiskPct: accountRiskPct === null ? current.accountRiskPct : Math.min(5, Math.max(0.1, accountRiskPct)),
      maxStockPositionPct: maxStockPositionPct === null ? current.maxStockPositionPct : Math.min(100, Math.max(0.1, maxStockPositionPct)),
    })
    refreshCompaniesFollowRows()
    setCompaniesFollowForecastStatus('风险参数已修改，记得保存')
  }

  function updateCompaniesFollowForecastRow(input: HTMLInputElement): void {
    refreshCompaniesFollowRows()
  }

  function setupCompaniesFollowForecastControls(): void {
    document.getElementById('companiesFollowSaveForecast')?.addEventListener('click', () => {
      void saveCompaniesFollowForecastConfig().catch((error) => {
        const message = error instanceof Error ? error.message : '保存配置失败'
        setCompaniesFollowForecastStatus(message, true)
      })
    })
    document.getElementById('companiesFollowTable')?.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement
      if (target.classList.contains('companies-follow-track')) {
        const code = target.dataset.code || ''
        updateCompaniesFollowTrackConfig(code, target.value)
        const row = companiesFollowRows.find((item) => item.code === code)
        if (row) {
          row.track = target.value.trim() || '-'
        }
        setCompaniesFollowForecastStatus('配置已修改，记得保存')
        return
      }
      if (target.classList.contains('companies-follow-position')) {
        const code = target.dataset.code || ''
        updateCompaniesFollowPositionConfig(code, parseCompaniesFollowNumber(target.value))
        refreshCompaniesFollowRows()
        setCompaniesFollowForecastStatus('持仓已修改，记得保存')
        return
      }
      if (target.classList.contains('companies-follow-cost')) {
        const code = target.dataset.code || ''
        updateCompaniesFollowCostConfig(code, parseCompaniesFollowNumber(target.value))
        refreshCompaniesFollowRows()
        setCompaniesFollowForecastStatus('成本价已修改，记得保存')
        return
      }
      if (!target.classList.contains('companies-follow-profit')) {
        return
      }
      const code = target.dataset.code || ''
      const year = target.dataset.year || ''
      const profit = parseCompaniesFollowNumber(target.value)
      updateCompaniesFollowForecastConfig(code, year, profit)
      setCompaniesFollowForecastStatus('预测已修改，记得保存')
    })
    document.getElementById('companiesFollowTable')?.addEventListener('change', (event) => {
      const target = event.target as HTMLInputElement
      if (target.classList.contains('companies-follow-position') || target.classList.contains('companies-follow-cost')) {
        return
      }
      if (!target.classList.contains('companies-follow-profit')) {
        return
      }
      updateCompaniesFollowForecastRow(target)
    })
    window.addEventListener('licai:companies-follow-policy-change', (event) => {
      const detail = (event as CustomEvent<{ accountRiskPct?: unknown, maxStockPositionPct?: unknown }>).detail || {}
      updateCompaniesFollowRiskPolicy(detail)
    })
  }

  function setCompaniesFollowYearHeaders() {
    const years = getCompaniesFollowForecastYears()
    emitCompaniesFollowYearHeaders(years)
  }

  function genFollowTable(codes: string[]) {
    const days = [90, 180]
    const normalizedCodes = normalizeCompaniesFollowCodes(codes)
    const loadVersion = ++companiesFollowLoadVersion
    const renderRows = (loadedCodes: string[]) => {
      if (loadVersion !== companiesFollowLoadVersion) {
        return
      }
      companiesFollowCodes = [...loadedCodes]
      const rows: CompaniesFollowTableRow[] = []
      for (const code of loadedCodes) {
        const row = buildCompaniesFollowTableRow(code, days)
        if (row) {
          rows.push(row)
        }
      }
      companiesFollowRows = rows
      emitCompaniesFollowRows(rows)
    }

    fetchCodeNames(normalizedCodes, () => {
      fetchKlines(normalizedCodes, '', () => {
        fetchCodesData(normalizedCodes, fetchCompaniesFollowOverview, () => {
          renderRows(normalizedCodes)
          fetchCodesData(normalizedCodes, fetchFinanceIncome, () => {
            renderRows(normalizedCodes)
            fetchReportForecasts(normalizedCodes, () => {
              renderRows(normalizedCodes)
            }, (_loadedCodes, failedCodes) => {
              if (loadVersion === companiesFollowLoadVersion && failedCodes.length > 0) {
                setCompaniesFollowForecastStatus(`部分研报预测加载失败：${failedCodes.join('、')}`, true)
              }
            })
          })
        })
      })
    })
  }

  function onFollowCodeSelectChange() {
    const selectedCodes = normalizeCompaniesFollowCodes(selectedOptionValues(document.getElementById('codes')))
    if (selectedCodes.length === 0) {
      companiesFollowLoadVersion += 1
      console.log('codes none')
      return
    }
    localStorage.setItem('follow', selectedCodes.join(','))
    genFollowTable(selectedCodes)
  }

  function initFollowCodes() {
    const codeStr = (query.code || localStorage.getItem('follow') || '').trim()
    if (!codeStr) {
      return
    }
    const codes = normalizeCompaniesFollowCodes(codeStr.split(','))
    const normalizedCodeStr = codes.join(',')
    localStorage.setItem('follow', normalizedCodeStr)
    replaceUrlParam('code', normalizedCodeStr)
    genFollowTable(codes)
  }

  async function initCompaniesFollow() {
    setCompaniesFollowYearHeaders()
    await loadCompaniesFollowForecastConfig()
    emitCompaniesFollowRiskPolicy()
    setupCompaniesFollowForecastControls()
    codeSelectInit(['SH', 'SZ', 'HK', 'US', 'KS'], 'codes', '股票关注', false)
    const codesElement = document.getElementById('codes')
    if (codesElement) {
      codesElement.addEventListener('change', onFollowCodeSelectChange)
    }
    initFollowCodes()
  }

  return initCompaniesFollow
}
