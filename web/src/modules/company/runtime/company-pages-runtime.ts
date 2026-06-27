type FetchRequest = (request: {
  url?: string
  params?: Record<string, unknown>
  data?: unknown
  cacheKey?: string
  cacheTtl?: number
} | string) => Promise<unknown>

type Callback = (data: unknown) => void

type AnnualFinancial = {
  profit?: number
  growth?: number
}

type CompanyPagesRuntimeContext = {
  server: string
  reportAnalysisCacheVersion: string
  analysisTaskQueue: {
    showAnalysisResult: (id: string, title: string) => void
    addTask: (url: string, title: string, qtype: string, button: HTMLAnchorElement) => void
  }
  alert: (message: string, type?: string) => void
  echarts: any
  fetchRequest: FetchRequest
  fetchCodeNames: (codes: string[], callback: Callback) => void
  fetchFinanceIncome: (code: string, callback: Callback) => void
  fetchReportUrl: (qtype: string, code: string, callback: (url: string | null) => void) => void
  fetchCodesData: (codes: string[], fetcher: (code: string, callback: Callback) => void, callback: (codes: string[]) => void) => void
  fetchShareChange: (code: string, callback: (data: any) => void) => void
  toDateString: (ts: number) => string
  toTimestamp: (date: string) => number
  rerenderMyChart: () => void
  dateRangeInit: () => void
  codeSelectInit: (cats: string[], id: string, placeholder: string, disabled: boolean) => void
  klineOptionsInit: () => void
  marketProcess: () => void
  onKlineCodeSelectChange: () => void
  klinePriceChange: () => void
  marklineFinanceReportDate: () => void
  onRatioCheckChange: (checked: boolean) => void
  onAlignStartCheckChange: (checked: boolean) => void
  bsRadioButtons: (id: string) => void
  genFinanceChart: (id: string, codes: string[], keys: string[][], names: string[]) => void
  financeCharTableOnChange: () => void
  onFinanceCodeSelectChange: () => void
  getSelectedCodes: () => string[]
  getCode: () => string
  getCache: () => Record<string, unknown>
  getKlineCodes: () => string[]
  getCodeNameMap: () => Record<string, string>
  coreKeys: string[][]
  incomeKeys: string[][]
  balanceKeys: string[][]
  cashflowKeys: string[][]
}

type CompanyNewsRow = {
  rawTime: string
  sourceType: string
  sourceName: string
  title: string
  summary: string
  contentPreview: string
  docId: string
  sourceUrl: string
  accessMethod: string
}

function mergeAnnualFinancial(target: Map<number, AnnualFinancial>, year: number, value: AnnualFinancial): void {
  const current = target.get(year) || {}
  target.set(year, {
    profit: current.profit !== undefined ? current.profit : value.profit,
    growth: current.growth !== undefined ? current.growth : value.growth,
  })
}

function parseReportForecastNumber(value: any): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined
  }
  if (typeof value !== 'string') {
    return undefined
  }
  const normalized = value.trim().replace(/,/g, '').replace(/%$/g, '')
  if (!normalized || normalized === '-' || normalized === '--') {
    return undefined
  }
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : undefined
}

function getLegacyForecastStartYear(report: any): number {
  const publishYear = report?.publishDate ? new Date(report.publishDate).getFullYear() : NaN
  return Number.isFinite(publishYear) ? publishYear : 2025
}

function getForecastProfitMap(report: any): Map<number, number> {
  const result = new Map<number, number>()
  if (Array.isArray(report?.forecasts)) {
    for (const item of report.forecasts) {
      const year = Number(item?.year)
      const netProfit = parseReportForecastNumber(item?.netProfit)
      if (Number.isFinite(year) && netProfit !== undefined) {
        result.set(year, netProfit)
      }
    }
    if (result.size > 0) {
      return result
    }
  }
  const startYear = getLegacyForecastStartYear(report)
  const legacyProfits = [
    report?.predictThisYearProfit,
    report?.predictNextYearProfit,
    report?.predictNextTwoYearProfit,
  ]
  legacyProfits.forEach((value: any, index: number) => {
    const parsed = parseReportForecastNumber(value)
    if (parsed !== undefined) {
      result.set(startYear + index, parsed)
    }
  })
  return result
}

function getForecastEPSMap(report: any): Map<number, number> {
  const result = new Map<number, number>()
  if (Array.isArray(report?.forecasts)) {
    for (const item of report.forecasts) {
      const year = Number(item?.year)
      const eps = parseReportForecastNumber(item?.eps)
      if (Number.isFinite(year) && eps !== undefined) {
        result.set(year, eps)
      }
    }
    if (result.size > 0) {
      return result
    }
  }
  const startYear = getLegacyForecastStartYear(report)
  const legacyEPS = [
    report?.predictThisYearEps,
    report?.predictNextYearEps,
    report?.predictNextTwoYearEps,
  ]
  legacyEPS.forEach((value: any, index: number) => {
    const parsed = parseReportForecastNumber(value)
    if (parsed !== undefined) {
      result.set(startYear + index, parsed)
    }
  })
  return result
}

function getCurrentMarketCapYi(): number | undefined {
  const text = document.getElementById('marketCap')?.textContent?.trim()
  if (!text || text === '暂无数据') {
    return undefined
  }
  const marketCap = Number(text)
  if (!Number.isFinite(marketCap) || marketCap <= 0) {
    return undefined
  }
  return marketCap
}

function getCurrentPriceNumber(): number | undefined {
  const text = document.getElementById('currentPrice')?.textContent?.trim()
  if (!text || text === '暂无数据') {
    return undefined
  }
  const price = Number(text)
  if (!Number.isFinite(price) || price <= 0) {
    return undefined
  }
  return price
}

function getActualAnnualFinancialMap(cache: Record<string, unknown>, code: string): Map<number, AnnualFinancial> {
  const result = new Map<number, AnnualFinancial>()
  const financeItems = cache[`${code}-fsi`] as any[]
  if (!Array.isArray(financeItems)) {
    return result
  }
  const annual = new Map<number, { sum: number, months: Set<string> }>()
  for (const item of financeItems) {
    const reportDate = String(item?.reportDate || '')
    if (reportDate.length < 10) {
      continue
    }
    const month = reportDate.substring(5, 7)
    if (!['03', '06', '09', '12'].includes(month)) {
      continue
    }
    const year = Number(reportDate.substring(0, 4))
    const profit = Number(item?.parentNetprofit ?? item?.netProfit)
    if (!Number.isFinite(year) || !Number.isFinite(profit)) {
      continue
    }
    if (!annual.has(year)) {
      annual.set(year, { sum: 0, months: new Set<string>() })
    }
    const current = annual.get(year)!
    if (current.months.has(month)) {
      continue
    }
    current.sum += profit
    current.months.add(month)
  }
  annual.forEach((item, year) => {
    if (item.months.size === 4 && Number.isFinite(item.sum)) {
      mergeAnnualFinancial(result, year, { profit: Math.round(item.sum / 1e6) / 100 })
    }
  })
  return result
}

function normalizeAStockSecurityCode(code: string): string {
  return code.replace(/\.(SH|SZ|BJ)$/i, '')
}

function normalizeKnowledgeType(item: any): string {
  const reportType = String(item?.report_type || item?.source_type || '').trim()
  switch (reportType) {
    case 'local_news':
    case 'web_news':
    case 'news':
      return '新闻'
    case 'company_report':
      return '公司研报'
    case 'industry_report':
      return '行业研报'
    case 'research_report':
      return '研报'
    default:
      return reportType || '-'
  }
}

function formatKnowledgeTime(value: unknown): string {
  const raw = String(value || '').trim()
  if (!raw) {
    return '-'
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw
  }
  const hasTimeZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)
  if (!hasTimeZone) {
    return raw.replace('T', ' ').replace(/\.\d+$/, '').substring(0, 19)
  }
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) {
    return raw.replace('T', ' ').replace(/\+.*/, '').replace(/Z$/i, '').substring(0, 19)
  }
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const pick = (type: string) => parts.find((part) => part.type === type)?.value || ''
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}:${pick('second')}`
}

function openExternalUrlWithoutReferrer(url: string): void {
  const trimmed = String(url || '').trim()
  if (!trimmed) {
    return
  }
  const link = document.createElement('a')
  link.href = trimmed
  link.target = '_blank'
  link.rel = 'noreferrer noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
}

function openCompanyNewsDocument(row: CompanyNewsRow): void {
  const docId = String(row.docId || '').trim()
  const sourceUrl = String(row.sourceUrl || '').trim()
  const accessMethod = String(row.accessMethod || '').trim().toLowerCase()
  if (accessMethod === 'local_file' && docId) {
    window.open(`/api/knowledge/file?id=${encodeURIComponent(docId)}`, '_blank', 'noopener')
    return
  }
  if (accessMethod.includes('remote_pdf') || accessMethod === 'pdf' || /\.pdf(?:$|[?#])/i.test(sourceUrl)) {
    openExternalUrlWithoutReferrer(sourceUrl)
    return
  }
  if (docId) {
    const url = new URL('research-news.html', window.location.href)
    url.searchParams.set('docId', docId)
    window.open(url.toString(), '_blank', 'noopener')
    return
  }
  if (sourceUrl) {
    openExternalUrlWithoutReferrer(sourceUrl)
  }
}

function getResolvedProfitMap(report: any, actualFinancialMap: Map<number, AnnualFinancial>): Map<number, number> {
  const profitMap = getForecastProfitMap(report)
  actualFinancialMap.forEach((financial, year) => {
    if (financial.profit !== undefined) {
      profitMap.set(year, financial.profit)
    }
  })
  return profitMap
}

function formatForecastProfitGrowthPeCells(report: any, year: number, actualFinancialMap: Map<number, AnnualFinancial>): string[] {
  const profitMap = getResolvedProfitMap(report, actualFinancialMap)
  const profit = profitMap.get(year)
  const previousProfit = profitMap.get(year - 1)
  let growth = actualFinancialMap.get(year)?.growth
  if (growth === undefined && profit !== undefined && previousProfit !== undefined && previousProfit > 0) {
    growth = (profit / previousProfit - 1) * 100
  }
  let pe: number | undefined
  if (profit !== undefined && profit > 0) {
    const marketCap = getCurrentMarketCapYi()
    if (marketCap !== undefined) {
      pe = marketCap / profit
    }
  } else {
    const eps = getForecastEPSMap(report).get(year)
    const price = getCurrentPriceNumber()
    if (eps !== undefined && eps > 0 && price !== undefined) {
      pe = price / eps
    }
  }
  return [
    profit !== undefined ? profit.toFixed(2) : '-',
    growth !== undefined ? growth.toFixed(2) : '-',
    pe !== undefined ? pe.toFixed(2) : '-',
  ]
}

export function createCompanyFinanceInitializer(context: CompanyPagesRuntimeContext) {
  const {
    financeCharTableOnChange,
    onFinanceCodeSelectChange,
    codeSelectInit,
    bsRadioButtons,
    genFinanceChart,
    getSelectedCodes,
    coreKeys,
    incomeKeys,
    balanceKeys,
    cashflowKeys,
  } = context

  function chartModalShow(event: any) {
    const key = event.relatedTarget.dataset.key
    const item = [...coreKeys, ...incomeKeys, ...balanceKeys, ...cashflowKeys].find((candidate) => candidate[0] === key)
    if (!item) {
      console.log('chartModalShow not found key', key)
      return
    }
    genFinanceChart('singleChart', getSelectedCodes(), [key], [item[1]])
  }

  return function initCompanyFinance() {
    financeCharTableOnChange()
    document.getElementById('codes')!.addEventListener('change', onFinanceCodeSelectChange)
    document.getElementById('seasons')!.addEventListener('change', financeCharTableOnChange)
    document.getElementById('yoyRatio')!.addEventListener('change', financeCharTableOnChange)
    document.getElementById('displayEmpty')!.addEventListener('change', financeCharTableOnChange)
    document.getElementById('compareType')!.addEventListener('bs.change', financeCharTableOnChange)
    document.getElementById('chartModal')!.addEventListener('shown.bs.modal', chartModalShow)
    codeSelectInit(['SH', 'SZ', 'HK', 'US', 'KS'], 'codes', '股票对比', false)
    bsRadioButtons('compareType')
  }
}

export function createCompanyReportInitializer(context: CompanyPagesRuntimeContext) {
  const {
    server,
    fetchCodeNames,
    fetchFinanceIncome,
    fetchReportUrl,
    toDateString,
    getCode,
    getCache,
    getCodeNameMap,
    echarts,
    fetchRequest,
  } = context

  let companyReportCurrentPage = 1
  let companyReportEventsBound = false
  let companyReportActualFinancialMap: Map<number, AnnualFinancial> | null = null
  let companyReportStream: EventSource | null = null
  let valuationChart: any | null = null
  let valuationChartResizeBound = false

  function emitCompanyReportState(patch: any): boolean {
    window.dispatchEvent(new CustomEvent('licai:company-report-state', { detail: patch || {} }))
    return true
  }

  function companyReportLoadingStatus(page: number): string {
    if (page <= 1) {
      return '正在加载公司研报；如果有新研报，系统会先补齐预测数据，可能需要等待几十秒'
    }
    return `正在加载第 ${page} 页公司研报...`
  }

  function companyReportProgressStatus(completed: number, total: number, title: string): string {
    if (total <= 0) {
      return '公司研报已抓取，暂无待补预测，正在整理结果...'
    }
    if (title) {
      return `正在补研报预测 ${completed}/${total}：${title}`
    }
    return `正在补研报预测 ${completed}/${total}`
  }

  function companyReportLoadedStatus(page: number, count: number): string {
    if (count > 0) {
      return `已加载 ${count} 条公司研报，第 ${page} 页`
    }
    return `最近暂无公司研报，第 ${page} 页为空`
  }

  function closeCompanyReportStream(): void {
    if (companyReportStream) {
      companyReportStream.close()
      companyReportStream = null
    }
  }

  function companyReportRequestUrl(code: string, page: number): string {
    const name = getCodeNameMap()[code] || ''
    return `${server}/api/company/reports?code=${code}&name=${name}&page=${page}`
  }

  function openExternalUrlWithoutReferrer(url: string): void {
    const trimmed = String(url || '').trim()
    if (!trimmed) {
      return
    }
    const link = document.createElement('a')
    link.href = trimmed
    link.target = '_blank'
    link.rel = 'noreferrer noopener'
    document.body.appendChild(link)
    link.click()
    link.remove()
  }

  function mapCompanyReportRows(items: any[], actualFinancialMap: Map<number, AnnualFinancial>): any[] {
    if (!Array.isArray(items)) {
      return []
    }
    return items.map((item: any, index: number) => {
      let reportHref = ''
      let reportInfoCode = ''
      if (item.localUrl) {
        reportHref = `${item.localUrl}#zoom=150`
      } else if (item.url) {
        reportHref = `${item.url}#zoom=150`
      } else if (item.code && (item.code.endsWith('.HK') || item.code.endsWith('.US')) && item.infoCode) {
        reportInfoCode = String(item.infoCode || '')
      } else if (item.infoCode) {
        reportHref = `https://pdf.dfcfw.com/pdf/H3_${item.infoCode}_1.pdf#zoom=150`
      }

      const ts = item.publishDate ? Math.floor(Date.parse(item.publishDate.substring(0, 10)) / 1000) : item.ts
      const profit2025 = formatForecastProfitGrowthPeCells(item, 2025, actualFinancialMap)
      const profit2026 = formatForecastProfitGrowthPeCells(item, 2026, actualFinancialMap)
      const profit2027 = formatForecastProfitGrowthPeCells(item, 2027, actualFinancialMap)
      const profit2028 = formatForecastProfitGrowthPeCells(item, 2028, actualFinancialMap)

      return {
        rank: index + 1,
        publishDate: toDateString(ts),
        title: String(item.title || ''),
        reportHref,
        reportInfoCode,
        profit2025: profit2025[0],
        growth2025: profit2025[1],
        pe2025: profit2025[2],
        profit2026: profit2026[0],
        growth2026: profit2026[1],
        pe2026: profit2026[2],
        profit2027: profit2027[0],
        growth2027: profit2027[1],
        pe2027: profit2027[2],
        profit2028: profit2028[0],
        growth2028: profit2028[1],
        pe2028: profit2028[2],
        orgName: String(item.orgSName || item.org || ''),
        pages: String(item.attachPages || item.pages || ''),
      }
    })
  }

  function bindCompanyReportActionLinks(): void {
    const qtype = 'dataeye'
    document.querySelectorAll("a[name='infoCode']").forEach((elem) => {
      const link = elem as HTMLAnchorElement
      if (link.dataset.bound === '1') {
        return
      }
      link.dataset.bound = '1'
      link.addEventListener('click', () => {
        fetchReportUrl(qtype, link.dataset.code || '', (url: string | null) => {
          if (url) {
            openExternalUrlWithoutReferrer(url)
          }
        })
      })
    })
  }

  function renderCompanyReportRows(items: any[], actualFinancialMap: Map<number, AnnualFinancial>): void {
    const pageSize = 10
    emitCompanyReportState({
      rows: mapCompanyReportRows(items, actualFinancialMap),
      currentPage: companyReportCurrentPage,
      hasNext: items.length >= pageSize,
      status: companyReportLoadedStatus(companyReportCurrentPage, items.length),
      error: false,
    })
    requestAnimationFrame(() => {
      bindCompanyReportActionLinks()
    })
  }

  function renderCompanyReportRowsPartial(items: any[], actualFinancialMap: Map<number, AnnualFinancial>): void {
    const pageSize = 10
    emitCompanyReportState({
      rows: mapCompanyReportRows(items, actualFinancialMap),
      currentPage: companyReportCurrentPage,
      hasNext: items.length >= pageSize,
      error: false,
    })
    requestAnimationFrame(() => {
      bindCompanyReportActionLinks()
    })
  }

  function genCompanyReportTable(code: string, actualFinancialMap: Map<number, AnnualFinancial>) {
    closeCompanyReportStream()
    emitCompanyReportState({
      rows: [],
      currentPage: companyReportCurrentPage,
      hasNext: false,
      status: companyReportLoadingStatus(companyReportCurrentPage),
      error: false,
    })
    if (companyReportCurrentPage === 1 && typeof EventSource !== 'undefined') {
      const streamURL = `${server}/api/company/reports/stream?code=${encodeURIComponent(code)}&page=${companyReportCurrentPage}`
      let finished = false
      companyReportStream = new EventSource(streamURL)
      companyReportStream.onmessage = (event) => {
        let payload: any = null
        try {
          payload = JSON.parse(event.data)
        } catch (error) {
          console.error('Failed to parse company report stream payload:', error)
          return
        }
        if (!payload || typeof payload !== 'object') {
          return
        }
        if (payload.type === 'progress') {
          emitCompanyReportState({
            status: companyReportProgressStatus(Number(payload.completed || 0), Number(payload.total || 0), String(payload.title || '')),
            error: false,
          })
          return
        }
        if (payload.type === 'partial') {
          const items = Array.isArray(payload.data) ? payload.data : []
          renderCompanyReportRowsPartial(items, actualFinancialMap)
          void drawValuationTrendChart(code, actualFinancialMap, items)
          return
        }
        if (payload.type === 'error') {
          finished = true
          emitCompanyReportState({
            rows: [],
            currentPage: companyReportCurrentPage,
            hasNext: false,
            status: String(payload.error || '公司研报加载失败'),
            error: true,
          })
          closeCompanyReportStream()
          return
        }
        if (payload.type === 'result') {
          finished = true
          const items = Array.isArray(payload.data) ? payload.data : []
          renderCompanyReportRows(items, actualFinancialMap)
          closeCompanyReportStream()
          void drawValuationTrendChart(code, actualFinancialMap, items)
        }
      }
      companyReportStream.onerror = () => {
        if (finished) {
          closeCompanyReportStream()
          return
        }
        emitCompanyReportState({
          rows: [],
          currentPage: companyReportCurrentPage,
          hasNext: false,
          status: '公司研报进度流中断，请刷新重试',
          error: true,
        })
        closeCompanyReportStream()
      }
      return
    }
    void fetchRequest(companyReportRequestUrl(code, companyReportCurrentPage)).then((data: any) => {
      if (data && typeof data === 'object' && 'error' in data) {
        const message = typeof data.error === 'string' && data.error.trim() ? data.error : '公司研报加载失败'
        emitCompanyReportState({
          rows: [],
          currentPage: companyReportCurrentPage,
          hasNext: false,
          status: message,
          error: true,
        })
        return
      }
      const items = Array.isArray(data) ? data : []
      renderCompanyReportRows(items, actualFinancialMap)
      if (companyReportCurrentPage === 1) {
        void drawValuationTrendChart(code, actualFinancialMap, items)
      }
    })
  }

  async function drawValuationTrendChart(code: string, actualFinancialMap: Map<number, AnnualFinancial>, prefetchedReports?: any[]) {
    try {
      const chartDom = document.getElementById('valuationChart')
      if (!chartDom) {
        return
      }
      valuationChart = valuationChart || echarts.getInstanceByDom(chartDom) || echarts.init(chartDom)
      const response = Array.isArray(prefetchedReports)
        ? prefetchedReports
        : await fetchRequest(companyReportRequestUrl(code, 1)) as any[]
      if (!response || response.length === 0) {
        valuationChart.clear()
        return
      }
      const reports = [...response].sort((a, b) => {
        const dateA = new Date(a.publishDate || a.ts * 1000).getTime()
        const dateB = new Date(b.publishDate || b.ts * 1000).getTime()
        return dateA - dateB
      })
      const dates: string[] = []
      const profit2025Data: (number | null)[] = []
      const profit2026Data: (number | null)[] = []
      const profit2027Data: (number | null)[] = []
      const profit2028Data: (number | null)[] = []
      let hasForecastData = false
      for (const report of reports) {
        const date = report.publishDate ? report.publishDate.substring(0, 10) : toDateString(report.ts)
        dates.push(date)
        const profitMap = getResolvedProfitMap(report, actualFinancialMap)
        const value2025 = profitMap.get(2025) ?? null
        const value2026 = profitMap.get(2026) ?? null
        const value2027 = profitMap.get(2027) ?? null
        const value2028 = profitMap.get(2028) ?? null
        profit2025Data.push(value2025)
        profit2026Data.push(value2026)
        profit2027Data.push(value2027)
        profit2028Data.push(value2028)
        if (value2025 !== null || value2026 !== null || value2027 !== null || value2028 !== null) {
          hasForecastData = true
        }
      }
      valuationChart.setOption({
        title: {
          text: `${getCodeNameMap()[code] || code} 净利润预测趋势图`,
          left: 'center',
        },
        graphic: hasForecastData
          ? []
          : [{
              type: 'text',
              left: 'center',
              top: 'middle',
              style: {
                text: '正在补充预测数据...',
                fill: '#6c757d',
                fontSize: 14,
              },
            }],
        tooltip: {
          trigger: 'axis',
          formatter(params: any) {
            let result = params[0].axisValue + '<br/>'
            params.forEach((item: any) => {
              if (item.value !== null && item.value !== undefined) {
                result += `${item.marker}${item.seriesName}: ${item.value.toFixed(2)}亿<br/>`
              }
            })
            return result
          },
        },
        legend: {
          data: ['2025净利润', '2026净利润', '2027净利润', '2028净利润'],
          top: 30,
        },
        grid: {
          left: '3%',
          right: '4%',
          bottom: '3%',
          containLabel: true,
        },
        xAxis: {
          type: 'category',
          data: dates,
          axisLabel: {
            rotate: 45,
            interval: Math.floor(dates.length / 10),
          },
        },
        yAxis: {
          type: 'value',
          name: '净利润(亿)',
          axisLabel: { formatter: '{value}' },
        },
        series: [
          { name: '2025净利润', type: 'line', data: profit2025Data, connectNulls: true, symbol: 'circle', symbolSize: 6 },
          { name: '2026净利润', type: 'line', data: profit2026Data, connectNulls: true, symbol: 'circle', symbolSize: 6 },
          { name: '2027净利润', type: 'line', data: profit2027Data, connectNulls: true, symbol: 'circle', symbolSize: 6 },
          { name: '2028净利润', type: 'line', data: profit2028Data, connectNulls: true, symbol: 'circle', symbolSize: 6 },
        ],
      }, true)
      if (!valuationChartResizeBound) {
        valuationChartResizeBound = true
        window.addEventListener('resize', () => {
          valuationChart?.resize()
        })
      }
    } catch (error) {
      console.error('Failed to draw valuation trend chart:', error)
    }
  }

  return async function initCompanyReport() {
    const code = getCode()
    companyReportCurrentPage = 1
    if (!getCodeNameMap()[code]) {
      await new Promise((resolve) => {
        fetchCodeNames([code], resolve)
      })
    }
    await new Promise((resolve) => {
      fetchFinanceIncome(code, () => resolve(undefined))
    })
    const actualFinancialMap = getActualAnnualFinancialMap(getCache(), code)
    companyReportActualFinancialMap = actualFinancialMap
    emitCompanyReportState({
      rows: [],
      currentPage: companyReportCurrentPage,
      hasNext: false,
      status: companyReportLoadingStatus(companyReportCurrentPage),
      error: false,
    })
    if (!companyReportEventsBound) {
      companyReportEventsBound = true
      window.addEventListener('licai:company-report-page-change', ((event: CustomEvent<{ page?: number }>) => {
        const page = Number(event.detail?.page || 1)
        if (!Number.isFinite(page) || page < 1 || !companyReportActualFinancialMap) {
          return
        }
        companyReportCurrentPage = page
        genCompanyReportTable(code, companyReportActualFinancialMap)
      }) as EventListener)
    }
    genCompanyReportTable(code, actualFinancialMap)
  }
}

export function createCompanyNewsInitializer(context: CompanyPagesRuntimeContext) {
  const { server, fetchRequest, getCode } = context

  let companyNewsCurrentPage = 1
  let companyNewsHasNext = false
  let companyNewsTotal = 0
  let companyNewsRows: CompanyNewsRow[] = []
  let companyNewsEventsBound = false

  function emitCompanyNewsState(patch: Record<string, unknown>) {
    window.dispatchEvent(new CustomEvent('licai:company-news-state', { detail: patch }))
  }

  function companyNewsLoadingStatus(page: number): string {
    return page <= 1 ? '正在加载资讯...' : `正在加载第 ${page} 页资讯...`
  }

  function companyNewsLoadedStatus(page: number, count: number): string {
    return count > 0 ? `已加载 ${count} 条资讯，第 ${page} 页` : `暂无资讯，第 ${page} 页为空`
  }

  async function renderCompanyNews() {
    const code = getCode()
    const pageSize = 20
    emitCompanyNewsState({
      rows: companyNewsRows,
      currentPage: companyNewsCurrentPage,
      hasNext: companyNewsHasNext,
      total: companyNewsTotal,
      status: companyNewsLoadingStatus(companyNewsCurrentPage),
      error: false,
    })
    try {
      const data = await fetchRequest({
        url: `${server}/api/knowledge/docs`,
        params: {
          code,
          page: companyNewsCurrentPage,
          pageSize,
        },
      }) as any
      const list = Array.isArray(data?.list) ? data.list : []
      companyNewsTotal = Number.isFinite(Number(data?.total)) ? Number(data.total) : list.length
      companyNewsRows = list.map((item: any) => ({
        rawTime: formatKnowledgeTime(item.event_time || item.published_at || item.fetched_at),
        sourceType: normalizeKnowledgeType(item),
        sourceName: String(item.source_name || ''),
        title: String(item.title || ''),
        summary: String(item.summary || ''),
        contentPreview: String(item.content_preview || item.summary || ''),
        docId: String(item.doc_id || ''),
        sourceUrl: String(item.url || ''),
        accessMethod: String(item.access_method || ''),
      }))
      companyNewsHasNext = list.length >= pageSize
      emitCompanyNewsState({
        rows: companyNewsRows,
        currentPage: companyNewsCurrentPage,
        hasNext: companyNewsHasNext,
        total: companyNewsTotal,
        status: companyNewsLoadedStatus(companyNewsCurrentPage, companyNewsRows.length),
        error: false,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      companyNewsRows = []
      companyNewsHasNext = false
      companyNewsTotal = 0
      emitCompanyNewsState({
        rows: [],
        currentPage: companyNewsCurrentPage,
        hasNext: false,
        total: 0,
        status: message || '资讯加载失败',
        error: true,
      })
    }
  }

  function onCompanyNewsPageChange(event: Event) {
    const page = Number((event as CustomEvent<{ page?: number }>).detail?.page)
    if (!Number.isInteger(page) || page < 1 || page === companyNewsCurrentPage) {
      return
    }
    companyNewsCurrentPage = page
    void renderCompanyNews()
  }

  function onCompanyNewsOpenDoc(event: Event) {
    const row = (event as CustomEvent<CompanyNewsRow>).detail
    if (!row) {
      return
    }
    openCompanyNewsDocument(row)
  }

  return function initCompanyNews() {
    companyNewsCurrentPage = 1
    companyNewsRows = []
    companyNewsHasNext = false
    companyNewsTotal = 0
    if (!companyNewsEventsBound) {
      companyNewsEventsBound = true
      window.addEventListener('licai:company-news-page-change', onCompanyNewsPageChange as EventListener)
      window.addEventListener('licai:company-news-open-doc', onCompanyNewsOpenDoc as EventListener)
    }
    void renderCompanyNews()
  }
}

export function createCompanySharesInitializer(context: CompanyPagesRuntimeContext) {
  const { fetchRequest, fetchShareChange, rerenderMyChart, toTimestamp, dateRangeInit, getCode, getCache, getKlineCodes, getCodeNameMap } = context

  function emitCompanySharesState(patch: any): boolean {
    window.dispatchEvent(new CustomEvent('licai:company-shares-state', { detail: patch || {} }))
    return true
  }

  function mapCompanyRestrictionRows(data: any[]): any[] {
    if (!Array.isArray(data)) {
      return []
    }
    return data.map((item) => ({
      liftDate: String(item.LIFT_DATE || '').substring(0, 10),
      liftNumWan: (Number(item.LIFT_NUM || 0) / 1e4).toFixed(2),
      totalSharesRatio: String(item.TOTAL_SHARES_RATIO ?? ''),
      unlimitedASharesRatio: String(item.UNLIMITED_A_SHARES_RATIO ?? ''),
      liftType: String(item.LIFT_TYPE || ''),
    }))
  }

  function mapCompanyShareStructureRows(data: any[]): any[] {
    if (!Array.isArray(data)) {
      return []
    }
    return data.map((item) => ({
      changeDate: String(item.changeDate || ''),
      totalShares: item.totalShares ? (item.totalShares / 1e4).toFixed(2) : '--',
      changeShares: item.changeShares ? (item.changeShares / 1e4).toFixed(2) : '--',
      changeRatio: String(item.changeRatio ?? '--'),
      changeReason: String(item.changeReason || ''),
      limitedShares: item.limitedShares ? (item.limitedShares / 1e4).toFixed(2) : '--',
      limitedStateLegal: item.limitedStateLegal ? (item.limitedStateLegal / 1e4).toFixed(2) : '--',
      limitedOthers: item.limitedOthers ? (item.limitedOthers / 1e4).toFixed(2) : '--',
      limitedDomesticNostate: item.limitedDomesticNostate ? (item.limitedDomesticNostate / 1e4).toFixed(2) : '--',
      limitedDomesticNatural: item.limitedDomesticNatural ? (item.limitedDomesticNatural / 1e4).toFixed(2) : '--',
      unlimitedShares: item.unlimitedShares ? (item.unlimitedShares / 1e4).toFixed(2) : '--',
      listedAShares: item.listedAShares ? (item.listedAShares / 1e4).toFixed(2) : '--',
    }))
  }

  function companyRestriction() {
    const code = getCode()
    const request = {
      url: '/api/company/restriction',
      cacheKey: `companyRestriction-${code}`,
      cacheTtl: 360000,
      params: { code },
    }
    void fetchRequest(request).then((data: any) => {
      const rows = data?.result?.data || []
      emitCompanySharesState({ restrictionRows: mapCompanyRestrictionRows(rows) })
    })
  }

  function companyShareStructure() {
    const code = getCode()
    fetchShareChange(code, (data: any) => {
      const shareStructureRows = mapCompanyShareStructureRows(data)
      const kline: any[] = []
      for (const item of data) {
        ['freeShares', 'limitedAShares', 'limitedDomesticNatural', 'limitedDomesticNostate', 'limitedOthers', 'limitedShares', 'limitedStateLegal', 'listedAShares', 'totalShares', 'unlimitedShares', 'changeShares'].forEach((key) => {
          if (item[key]) {
            item[key] = (item[key] / 1e4).toFixed(2)
          } else {
            item[key] = '--'
          }
        })
        kline.push([toTimestamp(item.changeDate), item.totalShares])
      }
      const klineCode = 'shares'
      getCodeNameMap()[klineCode] = `${getCodeNameMap()[code]}(万股)`
      getCache()[klineCode] = kline.reverse()
      getKlineCodes().push(klineCode)
      rerenderMyChart()
      emitCompanySharesState({ shareStructureRows })
    })
  }

  return function initCompanyShares() {
    emitCompanySharesState({
      restrictionRows: [],
      shareStructureRows: [],
    })
    dateRangeInit()
    companyRestriction()
    companyShareStructure()
  }
}

export function createCompanyInitializer(context: CompanyPagesRuntimeContext) {
  const {
    dateRangeInit,
    codeSelectInit,
    klineOptionsInit,
    marketProcess,
    onKlineCodeSelectChange,
    klinePriceChange,
    rerenderMyChart,
    marklineFinanceReportDate,
    onRatioCheckChange,
    onAlignStartCheckChange,
    getCode,
  } = context

  return function initCompany() {
    const code = getCode()
    if (code === undefined) {
      console.log('initCompany,code === undefined')
      return
    }
    dateRangeInit()
    try {
      codeSelectInit([], 'codes', '对比...', false)
    } catch (error) {
      console.error('initCompany codeSelectInit failed:', error)
    }
    try {
      klineOptionsInit()
    } catch (error) {
      console.error('initCompany klineOptionsInit failed:', error)
    }
    document.getElementById('codes')?.addEventListener('change', onKlineCodeSelectChange)
    document.getElementById('klinePrice')?.addEventListener('change', klinePriceChange)
    document.getElementById('candlestick')?.addEventListener('change', () => rerenderMyChart())
    document.getElementById('marklineFinanceReportDate')?.addEventListener('change', marklineFinanceReportDate)
    requestAnimationFrame(() => {
      marketProcess()
      onKlineCodeSelectChange()
    })
    document.getElementById('ratio')?.addEventListener('change', (event: any) => {
      onRatioCheckChange(event.target.checked)
    })
    document.getElementById('alignStart')?.addEventListener('change', (event: any) => {
      onAlignStartCheckChange(event.target.checked)
    })
  }
}
