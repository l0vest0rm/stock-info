type CompanyOptionThetaFetchRequest = (request: {
  url?: string
  params?: Record<string, unknown>
  cacheKey?: string
  cacheTtl?: number
}) => Promise<unknown>

type CompanyOptionThetaRuntimeContext = {
  getCode: () => string
  server: string
  fetchRequest: CompanyOptionThetaFetchRequest
  echartsColor: string[]
}

type OptionContract = {
  symbol: string
  expiration: string
  type: 'call' | 'put'
  strike: number
  bid: number
  ask: number
  last: number
  price: number
  volume: number
  openInterest: number
}

type OptionExpiration = {
  date: string
  strikeCount: number
}

type OptionObservation = {
  symbol: string
  expiration: string
  type: 'call' | 'put'
  strike: number
  daysToExpiry: number
  underlyingPrice: number
  distancePct: number
  mid: number
  intrinsic: number
  extrinsic: number
  dailyExtrinsic: number
  volume: number
  openInterest: number
}

type ThetaTableRow = {
  key: string
  expiration: string
  daysToExpiry: string
  type: string
  strike: string
  distancePct: string
  mid: string
  intrinsic: string
  extrinsic: string
  dailyExtrinsic: string
  volume: string
  openInterest: string
}

type ThetaStateEvent = CustomEvent<{
  statusText?: string
  code?: string
  snapshotAt?: string
  spotPrice?: string
  observationCount?: number
  summaryText?: string
  tableRows?: ThetaTableRow[]
  expirationOptions?: Array<{ value: string; label: string }>
  strikeOptions?: Array<{ value: string; label: string }>
  selectedExpirations?: string[]
  selectedStrikes?: string[]
}>

const EMPTY_CHART_OPTION = {
  xAxis: { type: 'value' },
  yAxis: { type: 'value' },
  series: [],
}

export function createCompanyOptionThetaInitializer(context: CompanyOptionThetaRuntimeContext) {
  const { server, fetchRequest, echartsColor } = context

  let currentCode = ''
  let currentSnapshotAt = ''
  let currentSpotPrice = 0
  let currentExpirations: OptionExpiration[] = []
  let currentStrikeValues: number[] = []
  let loadedObservations: OptionObservation[] = []

  function isLocalHost(): boolean {
    const host = window.location.hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0'
  }

  function normalizedUsCode(raw: unknown): string {
    const value = String(raw || '').trim().toUpperCase()
    if (!value) return ''
    return value.endsWith('.US') ? value : `${value}.US`
  }

  function safeNumber(value: unknown): number {
    const num = Number(value)
    return Number.isFinite(num) ? num : 0
  }

  function formatNumber(value: number, digits = 2): string {
    if (!Number.isFinite(value)) return '-'
    return value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: digits })
  }

  function formatPercent(value: number, digits = 2): string {
    if (!Number.isFinite(value)) return '-'
    return `${value.toFixed(digits)}%`
  }

  function formatDateTime(value: string): string {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return value
    return date.toLocaleString('zh-CN', { hour12: false })
  }

  function formatIsoDate(value: string): string {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return value
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  function currentCodeInput(): string {
    return normalizedUsCode((document.getElementById('optionThetaCodeInput') as HTMLInputElement | null)?.value || '')
  }

  function currentTypeFilter(): string {
    return (document.getElementById('optionThetaTypeFilter') as HTMLSelectElement | null)?.value || 'all'
  }

  function currentExpiryWindow(): string {
    return (document.getElementById('optionThetaExpiryWindow') as HTMLSelectElement | null)?.value || 'all'
  }

  function currentMinVolume(): number {
    return Math.max(0, Math.trunc(safeNumber((document.getElementById('optionThetaMinVolume') as HTMLInputElement | null)?.value || 0)))
  }

  function currentMinOpenInterest(): number {
    return Math.max(0, Math.trunc(safeNumber((document.getElementById('optionThetaMinOpenInterest') as HTMLInputElement | null)?.value || 0)))
  }

  function selectedValues(selectId: string): string[] {
    const select = document.getElementById(selectId) as HTMLSelectElement | null
    if (!select) return []
    return Array.from(select.selectedOptions).map((option) => option.value).filter(Boolean)
  }

  function matchesExpiryWindow(days: number, windowValue: string): boolean {
    if (days < 0) return false
    switch (windowValue) {
      case '0-21':
        return days <= 21
      case '22-60':
        return days >= 22 && days <= 60
      case '61-120':
        return days >= 61 && days <= 120
      case '121+':
        return days >= 121
      default:
        return true
    }
  }

  function expirationDays(expiration: string, snapshotAt: string): number {
    const expiry = new Date(expiration)
    const snapshot = new Date(snapshotAt)
    if (Number.isNaN(expiry.getTime()) || Number.isNaN(snapshot.getTime())) return -1
    const expiryStart = new Date(expiry.getFullYear(), expiry.getMonth(), expiry.getDate()).getTime()
    const snapshotStart = new Date(snapshot.getFullYear(), snapshot.getMonth(), snapshot.getDate()).getTime()
    return Math.round((expiryStart - snapshotStart) / (24 * 60 * 60 * 1000))
  }

  function intrinsicValue(type: 'call' | 'put', spot: number, strike: number): number {
    return type === 'call' ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0)
  }

  function dailyExtrinsicValue(extrinsic: number, daysToExpiry: number): number {
    if (!Number.isFinite(extrinsic) || daysToExpiry <= 0) return 0
    return extrinsic / daysToExpiry
  }

  function normalizeContracts(rawExpirations: any[], spot: number, snapshotAt: string): OptionObservation[] {
    const observations: OptionObservation[] = []
    for (const expirationItem of rawExpirations) {
      const expiration = String(expirationItem?.date || '')
      const daysToExpiry = expirationDays(expiration, snapshotAt)
      for (const optionType of ['call', 'put'] as const) {
        const rawContracts = Array.isArray(expirationItem?.[optionType === 'call' ? 'calls' : 'puts']) ? expirationItem[optionType === 'call' ? 'calls' : 'puts'] as OptionContract[] : []
        for (const raw of rawContracts) {
          const strike = safeNumber(raw?.strike)
          const bid = safeNumber(raw?.bid)
          const ask = safeNumber(raw?.ask)
          const last = safeNumber(raw?.last)
          const mid = safeNumber(raw?.price) || (bid > 0 && ask > 0 ? (bid + ask) / 2 : bid || ask || last)
          const intrinsic = intrinsicValue(optionType, spot, strike)
          observations.push({
            symbol: String(raw?.symbol || ''),
            expiration,
            type: optionType,
            strike,
            daysToExpiry,
            underlyingPrice: spot,
            distancePct: spot > 0 ? 100 * (strike / spot - 1) : 0,
            mid,
            intrinsic,
            extrinsic: Math.max(mid - intrinsic, 0),
            dailyExtrinsic: dailyExtrinsicValue(Math.max(mid - intrinsic, 0), daysToExpiry),
            volume: Math.trunc(safeNumber(raw?.volume)),
            openInterest: Math.trunc(safeNumber(raw?.openInterest)),
          })
        }
      }
    }
    return observations
  }

  function filteredObservations(): OptionObservation[] {
    const typeFilter = currentTypeFilter()
    const expiryWindow = currentExpiryWindow()
    const minVolume = currentMinVolume()
    const minOpenInterest = currentMinOpenInterest()
    return loadedObservations.filter((item) => {
      if (typeFilter !== 'all' && item.type !== typeFilter) return false
      if (!matchesExpiryWindow(item.daysToExpiry, expiryWindow)) return false
      if (item.volume < minVolume) return false
      if (item.openInterest < minOpenInterest) return false
      return true
    })
  }

  function buildSeriesByExpiration(observations: OptionObservation[], xKey: 'daysToExpiry' | 'distancePct' | 'strike'): any[] {
    const grouped = new Map<string, OptionObservation[]>()
    for (const item of observations) {
      const list = grouped.get(item.expiration) || []
      list.push(item)
      grouped.set(item.expiration, list)
    }
    return Array.from(grouped.entries())
      .sort((a, b) => (a[1][0]?.daysToExpiry || 0) - (b[1][0]?.daysToExpiry || 0))
      .map(([name, items]) => ({
        name: formatIsoDate(name),
        type: 'scatter',
        symbolSize: 9,
        data: items.map((item) => ({
          value: [item[xKey], item.extrinsic],
          contract: item,
        })),
      }))
  }

  function buildDailySeriesByExpiration(observations: OptionObservation[], xKey: 'daysToExpiry' | 'distancePct'): any[] {
    const grouped = new Map<string, OptionObservation[]>()
    for (const item of observations) {
      const list = grouped.get(item.expiration) || []
      list.push(item)
      grouped.set(item.expiration, list)
    }
    return Array.from(grouped.entries())
      .sort((a, b) => (a[1][0]?.daysToExpiry || 0) - (b[1][0]?.daysToExpiry || 0))
      .map(([name, items]) => ({
        name: formatIsoDate(name),
        type: 'scatter',
        symbolSize: 9,
        data: items.map((item) => ({
          value: [item[xKey], item.dailyExtrinsic],
          contract: item,
        })),
      }))
  }

  function chartTooltip(title: string, xFormatter: (item: OptionObservation) => string, yLabel = '时间价值', yFormatter?: (item: OptionObservation) => string) {
    return (params: any) => {
      const contract = params?.data?.contract as OptionObservation | undefined
      if (!contract) return ''
      return [
        `${title}: ${xFormatter(contract)}`,
        `${params.marker}${contract.type === 'call' ? 'Call' : 'Put'} ${formatNumber(contract.strike)} (${formatPercent(contract.distancePct)})`,
        `到期日: ${formatIsoDate(contract.expiration)}`,
        `${yLabel}: ${yFormatter ? yFormatter(contract) : formatNumber(contract.extrinsic)}`,
        `中价: ${formatNumber(contract.mid)}`,
        `当时股价: ${formatNumber(contract.underlyingPrice)}`,
        `Volume/OI: ${contract.volume}/${contract.openInterest}`,
      ].join('<br/>')
    }
  }

  function buildExtrinsicVsDaysChart(observations: OptionObservation[]) {
    return {
      color: echartsColor,
      legend: { top: 0 },
      tooltip: { trigger: 'item', formatter: chartTooltip('剩余天数', (item) => `${item.daysToExpiry} 天`, '平均每天时间价值', (item) => formatNumber(item.dailyExtrinsic, 4)) },
      grid: { left: '3%', right: '4%', top: 48, bottom: '8%', containLabel: true },
      xAxis: { type: 'value', name: '剩余天数' },
      yAxis: { type: 'value', name: '平均每天时间价值' },
      series: buildDailySeriesByExpiration(observations, 'daysToExpiry'),
    }
  }

  function buildExtrinsicVsDistanceChart(observations: OptionObservation[]) {
    return {
      color: echartsColor,
      legend: { top: 0 },
      tooltip: { trigger: 'item', formatter: chartTooltip('距离当时股价', (item) => formatPercent(item.distancePct), '平均每天时间价值', (item) => formatNumber(item.dailyExtrinsic, 4)) },
      grid: { left: '3%', right: '4%', top: 48, bottom: '8%', containLabel: true },
      xAxis: { type: 'value', name: '距离当时股价(%)' },
      yAxis: { type: 'value', name: '平均每天时间价值' },
      series: buildDailySeriesByExpiration(observations, 'distancePct'),
    }
  }

  function buildExtrinsicVsStrikeChart(observations: OptionObservation[]) {
    return {
      color: echartsColor,
      legend: { top: 0 },
      tooltip: { trigger: 'item', formatter: chartTooltip('行权价', (item) => formatNumber(item.strike)) },
      grid: { left: '3%', right: '4%', top: 48, bottom: '8%', containLabel: true },
      xAxis: { type: 'value', name: '行权价' },
      yAxis: { type: 'value', name: '时间价值' },
      series: buildSeriesByExpiration(observations, 'strike'),
    }
  }

  function buildTableRows(observations: OptionObservation[]): ThetaTableRow[] {
    return observations
      .slice()
      .sort((a, b) => a.daysToExpiry - b.daysToExpiry || Math.abs(a.distancePct) - Math.abs(b.distancePct))
      .map((item) => ({
        key: item.symbol || `${item.type}-${item.expiration}-${item.strike}`,
        expiration: formatIsoDate(item.expiration),
        daysToExpiry: String(item.daysToExpiry),
        type: item.type === 'call' ? 'Call' : 'Put',
        strike: formatNumber(item.strike),
        distancePct: formatPercent(item.distancePct),
        mid: formatNumber(item.mid),
        intrinsic: formatNumber(item.intrinsic),
        extrinsic: formatNumber(item.extrinsic),
        dailyExtrinsic: formatNumber(item.dailyExtrinsic, 4),
        volume: formatNumber(item.volume, 0),
        openInterest: formatNumber(item.openInterest, 0),
      }))
  }

  function expirationOptions() {
    return currentExpirations.map((item) => ({
      value: item.date,
      label: `${formatIsoDate(item.date)} (${expirationDays(item.date, currentSnapshotAt)}天, ${item.strikeCount}个价位)`,
    }))
  }

  function strikeOptions() {
    return currentStrikeValues.map((strike) => ({
      value: String(strike),
      label: formatNumber(strike),
    }))
  }

  function emitState(detail: ThetaStateEvent['detail']) {
    window.dispatchEvent(new CustomEvent('licai:company-option-theta-state', { detail }))
  }

  function emitChartOption(id: string, option: unknown) {
    window.dispatchEvent(new CustomEvent('licai:company-option-theta-chart-option', { detail: { id, option } }))
  }

  function renderAnalysis() {
    const observations = filteredObservations()
    emitState({
      code: currentCode,
      snapshotAt: currentSnapshotAt,
      spotPrice: currentSpotPrice > 0 ? formatNumber(currentSpotPrice) : '-',
      observationCount: observations.length,
      summaryText: currentSnapshotAt
        ? `当前先拉取并缓存完整到期日和行权价，再按你选择的到期日/行权价读取对应期权链缓存。所有“距离股价%”和“时间价值”都按这次快照当时的股价 ${formatNumber(currentSpotPrice)} 计算。`
        : '先加载期权日期和行权价。',
      tableRows: buildTableRows(observations),
      expirationOptions: expirationOptions(),
      strikeOptions: strikeOptions(),
      selectedExpirations: selectedValues('optionThetaExpirationFilter'),
      selectedStrikes: selectedValues('optionThetaStrikeFilter'),
    })
    emitChartOption('optionThetaExtrinsicDaysChart', observations.length > 0 ? buildExtrinsicVsDaysChart(observations) : EMPTY_CHART_OPTION)
    emitChartOption('optionThetaExtrinsicDistanceChart', observations.length > 0 ? buildExtrinsicVsDistanceChart(observations) : EMPTY_CHART_OPTION)
    emitChartOption('optionThetaExtrinsicStrikeChart', observations.length > 0 ? buildExtrinsicVsStrikeChart(observations) : EMPTY_CHART_OPTION)
    emitState({
      statusText: currentSnapshotAt
        ? `已载入 ${currentCode} 期权数据，快照时间 ${formatDateTime(currentSnapshotAt)}，共 ${currentExpirations.length} 个到期日、${currentStrikeValues.length} 个行权价，当前明细 ${observations.length} 条。`
        : '还没有期权数据。',
    })
  }

  async function loadSummary() {
    const code = currentCodeInput()
    if (!code) {
      emitState({ statusText: '请输入美股代码，例如 MU.US' })
      return
    }
    emitState({ statusText: `加载 ${code} 的到期日和行权价...` })
    const summary = await fetchRequest({
      url: `${server}/api/options/us/summary`,
      params: { code },
      cacheKey: `us-option-chain-summary-${code}`,
      cacheTtl: 30 * 60 * 1000,
    }) as any
    currentCode = code
    currentSnapshotAt = new Date(safeNumber(summary?.updatedAt) || Date.now()).toISOString()
    currentSpotPrice = safeNumber(summary?.currentPrice)
    currentExpirations = Array.isArray(summary?.expirations) ? summary.expirations.map((item: any) => ({
      date: String(item?.date || ''),
      strikeCount: Math.trunc(safeNumber(item?.strikeCount)),
    })).filter((item: OptionExpiration) => item.date) : []
    currentStrikeValues = Array.isArray(summary?.strikes) ? summary.strikes.map((value: unknown) => safeNumber(value)).filter((value: number) => value > 0).sort((a: number, b: number) => a - b) : []
    emitState({
      code: currentCode,
      snapshotAt: currentSnapshotAt,
      spotPrice: currentSpotPrice > 0 ? formatNumber(currentSpotPrice) : '-',
      expirationOptions: expirationOptions(),
      strikeOptions: strikeOptions(),
      selectedExpirations: selectedValues('optionThetaExpirationFilter'),
      selectedStrikes: selectedValues('optionThetaStrikeFilter'),
      statusText: `已加载 ${currentCode} 的 ${currentExpirations.length} 个到期日和 ${currentStrikeValues.length} 个行权价，准备读取明细...`,
    })
  }

  async function loadContractsAndRender() {
    if (!currentCode) {
      return
    }
    const selectedExpirations = selectedValues('optionThetaExpirationFilter')
    const selectedStrikes = selectedValues('optionThetaStrikeFilter')
    emitState({ statusText: `读取 ${currentCode} 期权明细...` })
    const payload = await fetchRequest({
      url: `${server}/api/options/us/contracts`,
      params: {
        code: currentCode,
        expirations: selectedExpirations.join('|'),
        strikes: selectedStrikes.join(','),
      },
      cacheKey: `us-option-chain-contracts-${currentCode}-${selectedExpirations.join('|')}-${selectedStrikes.join('|')}`,
      cacheTtl: 30 * 60 * 1000,
    }) as any
    loadedObservations = normalizeContracts(Array.isArray(payload?.expirations) ? payload.expirations : [], currentSpotPrice, currentSnapshotAt)
    renderAnalysis()
  }

  async function refreshAllData() {
    await loadSummary()
    await loadContractsAndRender()
  }

  function bindEvents() {
    document.getElementById('optionThetaCollectBtn')?.addEventListener('click', () => { void refreshAllData() })
    document.getElementById('optionThetaReloadBtn')?.addEventListener('click', () => { renderAnalysis() })
    for (const id of ['optionThetaTypeFilter', 'optionThetaExpiryWindow', 'optionThetaMinVolume', 'optionThetaMinOpenInterest']) {
      document.getElementById(id)?.addEventListener('change', renderAnalysis)
      document.getElementById(id)?.addEventListener('input', renderAnalysis)
    }
    document.getElementById('optionThetaExpirationFilter')?.addEventListener('change', () => { void loadContractsAndRender() })
    document.getElementById('optionThetaStrikeFilter')?.addEventListener('change', () => { void loadContractsAndRender() })
  }

  async function initCompanyOptionTheta() {
    if (!isLocalHost()) {
      emitState({ statusText: '时间损耗分析页面仅本地可用' })
      return
    }
    bindEvents()
    const code = normalizedUsCode(context.getCode()) || 'MU.US'
    const input = document.getElementById('optionThetaCodeInput') as HTMLInputElement | null
    if (input) input.value = code
    await refreshAllData()
  }

  return initCompanyOptionTheta
}
