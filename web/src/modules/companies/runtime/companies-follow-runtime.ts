type Callback = (data: unknown) => void
type CodesCallback = (codes: string[]) => void

interface CompaniesFollowForecastDisplay {
  year: number
  profit: string
  growth: string
  pe: string
}

interface CompaniesFollowTableRow {
  code: string
  name: string
  price: string
  changeRatio: string
  high90: string
  low90: string
  high180: string
  low180: string
  marketValueYi: string
  peTtm: string
  forecasts: CompaniesFollowForecastDisplay[]
}

interface CompaniesFollowForecastConfig {
  version?: number
  profits?: Record<string, Record<string, number>>
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

  let companiesFollowForecastConfig: CompaniesFollowForecastConfig = { version: 1, profits: {} }
  let companiesFollowRows: CompaniesFollowTableRow[] = []
  let companiesFollowCodes: string[] = []

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

  function setCompaniesFollowForecastStatus(message: string, danger = false): void {
    emitCompaniesFollowStatus(message, danger)
  }

  async function loadCompaniesFollowForecastConfig(): Promise<void> {
    const data = await fetchRequest({ url: `${server}/api/companies/follow/forecast` }) as CompaniesFollowForecastConfig
    companiesFollowForecastConfig = {
      version: 1,
      profits: data?.profits || {},
    }
  }

  async function saveCompaniesFollowForecastConfig(): Promise<void> {
    setCompaniesFollowForecastStatus('正在保存...')
    const saved = await fetchRequest({
      url: `${server}/api/companies/follow/forecast`,
      data: companiesFollowForecastConfig,
    }) as CompaniesFollowForecastConfig
    companiesFollowForecastConfig = {
      version: 1,
      profits: saved?.profits || {},
    }
    setCompaniesFollowForecastStatus('已保存到 data/companies-follow-forecast.json')
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

  function getCompaniesFollowLatestAnnualProfit(code: string): number | null {
    const items = cache[`${code}-fsi`] as any[] | undefined
    if (!items || items.length === 0) {
      return null
    }
    const annualMap: Record<string, { sum: number, months: Record<string, boolean> }> = {}
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
        annualMap[year] = { sum: 0, months: {} }
      }
      if (annualMap[year].months[month]) {
        continue
      }
      const profit = parseCompaniesFollowNumber(item.parentNetprofit ?? item.netProfit)
      if (profit === null) {
        continue
      }
      annualMap[year].sum += profit
      annualMap[year].months[month] = true
    }
    const years = Object.keys(annualMap).sort().reverse()
    for (const year of years) {
      if (Object.keys(annualMap[year].months).length >= 4 && annualMap[year].sum > 0) {
        return annualMap[year].sum / 1e8
      }
    }
    return null
  }

  function getCompaniesFollowForecastProfit(code: string, year: number, forecastMap: Map<number, number>): number | null {
    const manual = companiesFollowForecastConfig.profits?.[code]?.[String(year)]
    if (typeof manual === 'number' && Number.isFinite(manual) && manual > 0) {
      return manual
    }
    return forecastMap.get(year) ?? null
  }

  function buildCompaniesFollowForecastRow(code: string, marketValueYi: number): Record<string, string> {
    const forecastItems = cache[`${code}-rf`] as Array<{ year: number, netProfit: number }> | undefined
    const forecastMap = new Map<number, number>()
    if (Array.isArray(forecastItems)) {
      for (const item of forecastItems) {
        if (item && typeof item.year === 'number' && typeof item.netProfit === 'number' && item.netProfit > 0) {
          forecastMap.set(item.year, item.netProfit)
        }
      }
    }
    const years = getCompaniesFollowForecastYears()
    const latestActualProfit = getCompaniesFollowLatestAnnualProfit(code)
    const profit0 = getCompaniesFollowForecastProfit(code, years[0], forecastMap)
    const profit1 = getCompaniesFollowForecastProfit(code, years[1], forecastMap)
    const profit2 = getCompaniesFollowForecastProfit(code, years[2], forecastMap)
    return {
      profit0: formatCompaniesFollowNumber(profit0),
      growth0: formatCompaniesFollowPercent(calcCompaniesFollowGrowth(latestActualProfit, profit0)),
      pe0: formatCompaniesFollowNumber(calcCompaniesFollowPE(marketValueYi, profit0)),
      profit1: formatCompaniesFollowNumber(profit1),
      growth1: formatCompaniesFollowPercent(calcCompaniesFollowGrowth(profit0, profit1)),
      pe1: formatCompaniesFollowNumber(calcCompaniesFollowPE(marketValueYi, profit1)),
      profit2: formatCompaniesFollowNumber(profit2),
      growth2: formatCompaniesFollowPercent(calcCompaniesFollowGrowth(profit1, profit2)),
      pe2: formatCompaniesFollowNumber(calcCompaniesFollowPE(marketValueYi, profit2)),
    }
  }

  function fetchReportForecast(code: string, callback: Callback): void {
    const cacheKey = `${code}-rf`
    if (cache[cacheKey] !== undefined) {
      callback(cache[cacheKey])
      return
    }
    void fetchRequest({
      url: `${server}/api/report/forecast`,
      params: { code },
    }).then((data: unknown) => {
      cache[cacheKey] = data
      callback(data)
    })
  }

  function fetchReportForecasts(codes: string[], callback: CodesCallback): void {
    const should = codes.length
    let done = 0
    const success = () => {
      done += 1
      if (done === should) {
        callback(codes)
      }
    }
    for (const code of codes) {
      fetchReportForecast(code, success)
    }
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
    const marketValueYi = Math.round(kline[idx][7] / 1e7) / 10
    const forecast = buildCompaniesFollowForecastRow(code, marketValueYi)
    const years = getCompaniesFollowForecastYears()
    return {
      code,
      name: codeNameMap[code] || code,
      price: formatCompaniesFollowNumber(price),
      changeRatio: changeRatio.toFixed(2),
      high90: dayMetrics.get(90)?.high || '-',
      low90: dayMetrics.get(90)?.low || '-',
      high180: dayMetrics.get(180)?.high || '-',
      low180: dayMetrics.get(180)?.low || '-',
      marketValueYi: marketValueYi.toFixed(2),
      peTtm: formatCompaniesFollowNumber(kline[idx][8]),
      forecasts: years.map((year, offset) => ({
        year,
        profit: forecast[`profit${offset}` as keyof typeof forecast],
        growth: forecast[`growth${offset}` as keyof typeof forecast],
        pe: forecast[`pe${offset}` as keyof typeof forecast],
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

  function updateCompaniesFollowForecastRow(input: HTMLInputElement): void {
    refreshCompaniesFollowRows()
  }

  function setupCompaniesFollowForecastControls(): void {
    document.getElementById('companiesFollowSaveForecast')?.addEventListener('click', () => {
      void saveCompaniesFollowForecastConfig().catch((error) => {
        const message = error instanceof Error ? error.message : '保存预测失败'
        setCompaniesFollowForecastStatus(message, true)
      })
    })
    document.getElementById('companiesFollowTable')?.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement
      if (!target.classList.contains('companies-follow-profit')) {
        return
      }
      const code = target.dataset.code || ''
      const year = target.dataset.year || ''
      const profit = parseCompaniesFollowNumber(target.value)
      updateCompaniesFollowForecastConfig(code, year, profit)
      updateCompaniesFollowForecastRow(target)
      setCompaniesFollowForecastStatus('预测已修改，记得保存')
    })
  }

  function setCompaniesFollowYearHeaders() {
    const years = getCompaniesFollowForecastYears()
    emitCompaniesFollowYearHeaders(years)
  }

  function genFollowTable(codes: string[]) {
    const days = [90, 180]
    const normalizedCodes = normalizeCompaniesFollowCodes(codes)
    const success = (loadedCodes: string[]) => {
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
        fetchCodesData(normalizedCodes, fetchFinanceIncome, () => {
          fetchReportForecasts(normalizedCodes, () => {
            success(normalizedCodes)
          })
        })
      })
    })
  }

  function onFollowCodeSelectChange() {
    const selectedCodes = normalizeCompaniesFollowCodes(selectedOptionValues(document.getElementById('codes')))
    if (selectedCodes.length === 0) {
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
    setupCompaniesFollowForecastControls()
    initFollowCodes()
    const codesElement = document.getElementById('codes')
    if (codesElement) {
      codesElement.addEventListener('change', onFollowCodeSelectChange)
    }
    codeSelectInit(['SH', 'SZ', 'HK', 'US', 'KS'], 'codes', '股票关注', false)
  }

  return initCompaniesFollow
}
