interface EChartsOption {
  [key: string]: any
}

type CompanyOptionFetchRequest = (request: {
  url?: string
  params?: Record<string, unknown>
  cacheKey?: string
  cacheTtl?: number
}) => Promise<unknown>

type CompanyOptionRuntimeContext = {
  getCode: () => string
  query: Record<string, any>
  server: string
  fetchRequest: CompanyOptionFetchRequest
  escapeHtml: (value: unknown) => string
  zeroPad: (num: number, places: number) => string
  echartsColor: string[]
  echarts: {
    dispose: (dom: HTMLElement) => void
    init: (dom: HTMLElement) => { setOption: (option: EChartsOption) => void }
  }
}

interface CompanyOptionContract {
  symbol: string
  type: 'call' | 'put'
  expiration: string
  strike: number
  last: number
  bid: number
  ask: number
  price: number
  volume: number
  openInterest: number
}

interface CompanyOptionExpiration {
  date: string
  calls: CompanyOptionContract[]
  puts: CompanyOptionContract[]
}

interface CompanyOptionChain {
  code: string
  symbol: string
  currentPrice: number
  expirations: CompanyOptionExpiration[]
}

interface CompanyOptionLeg extends CompanyOptionContract {
  id: number
  side: 'buy' | 'sell'
  quantity: number
}

interface CompanyOptionCompareLeg {
  side: 'buy' | 'sell'
  quantity: number
  type: 'call' | 'put'
  strike: number
  expiration?: string
}

interface CompanyOptionCompareStrategy {
  name: string
  expiration?: string
  legs: CompanyOptionCompareLeg[]
}

interface CompanyOptionCompareResolvedLeg {
  input: CompanyOptionCompareLeg
  contract: CompanyOptionContract
  premium: number
  signedQty: number
}

interface CompanyOptionCompareResult {
  strategy: CompanyOptionCompareStrategy
  legs: CompanyOptionCompareResolvedLeg[]
  debitPerShare: number
  maxLossPerShare: number | null
  maxLossPrice: number | null
  unlimitedLoss: boolean
  contracts: number
  initialCash: number
  breakevens: number[]
  scenarioPrices: number[]
  scenarioPLPerShare: number[]
  scenarioPLTotal: number[]
  error?: string
}

export function createCompanyOptionInitializer(context: CompanyOptionRuntimeContext) {
  const {
    query,
    server,
    fetchRequest,
    escapeHtml,
    zeroPad,
    echartsColor,
    echarts,
  } = context

  let companyOptionChain: CompanyOptionChain | null = null
  let companyOptionLegs: CompanyOptionLeg[] = []
  let companyOptionLegSeq = 1
  let companyOptionCompareStrategies: CompanyOptionCompareStrategy[] = []
  let companyOptionCompareInitialized = false

  function currentCode(): string {
    return context.getCode()
  }

  function initCompanyOption() {
    const page = document.getElementById('companyOptionPage')
    const code = currentCode()
    if (!page || !code.endsWith('.US')) {
      if (page) {
        page.innerHTML = ''
      }
      return
    }

    setCompanyOptionStatus('加载期权链...')
    fetchRequest({
      url: `${server}/api/options/us`,
      params: {code},
      cacheKey: `us-option-chain-${code}`,
      cacheTtl: 30 * 60 * 1000
    }).then((data: any) => {
      companyOptionChain = data as CompanyOptionChain
      companyOptionLegs = []
      renderCompanyOptionPage()
    })

    document.getElementById('optionExpirationFilter')?.addEventListener('change', renderCompanyOptionChainTable)
    document.getElementById('optionTypeFilter')?.addEventListener('change', renderCompanyOptionChainTable)
    document.getElementById('optionChainTable')?.addEventListener('click', onCompanyOptionChainClick)
    document.getElementById('optionStrategyTable')?.addEventListener('click', onCompanyOptionStrategyClick)
    document.getElementById('optionStrategyTable')?.addEventListener('change', onCompanyOptionStrategyChange)
    document.getElementById('optionStrategyTable')?.addEventListener('input', onCompanyOptionStrategyChange)
    document.getElementById('optionAddCurrentStrategyBtn')?.addEventListener('click', onCompanyOptionAddCurrentStrategy)
    document.getElementById('optionCopyCompareLinkBtn')?.addEventListener('click', onCompanyOptionCopyCompareLink)
    document.getElementById('optionCompareCapital')?.addEventListener('change', onCompanyOptionCompareInputChange)
    document.getElementById('optionComparePrices')?.addEventListener('change', onCompanyOptionCompareInputChange)
    document.getElementById('optionCompareTable')?.addEventListener('click', onCompanyOptionCompareTableClick)
  }

  function renderCompanyOptionPage() {
    if (!companyOptionChain || !Array.isArray(companyOptionChain.expirations) || companyOptionChain.expirations.length === 0) {
      setCompanyOptionStatus('没有可用的美股期权链数据')
      renderCompanyOptionStrategy()
      return
    }

    const priceElem = document.getElementById('currentPrice')
    if (priceElem && companyOptionChain.currentPrice > 0) {
      priceElem.textContent = companyOptionChain.currentPrice.toString()
    }
    const expirationFilterRenderedByVue = renderCompanyOptionExpirationFilter()
    if (expirationFilterRenderedByVue) {
      requestAnimationFrame(renderCompanyOptionChainTable)
    } else {
      renderCompanyOptionChainTable()
    }
    renderCompanyOptionStrategy()
    const compareControlsRenderedByVue = initCompanyOptionCompareFromQuery()
    if (compareControlsRenderedByVue) {
      requestAnimationFrame(renderCompanyOptionCompare)
    } else {
      renderCompanyOptionCompare()
    }
    setCompanyOptionStatus(`${companyOptionChain.symbol} 共 ${companyOptionChain.expirations.length} 个到期日，当前价 ${companyOptionFormatNumber(companyOptionChain.currentPrice)}`)
  }

  function renderCompanyOptionExpirationFilter(): boolean {
    const select = document.getElementById('optionExpirationFilter') as HTMLSelectElement | null
    if (!select || !companyOptionChain) {
      return false
    }
    const options = [
      {value: 'all', text: '全部到期日'},
      ...companyOptionChain.expirations.map((item) => ({
        value: item.date,
        text: companyOptionExpirationOptionText(item.date),
      })),
    ]
    const selected = companyOptionChain.expirations[0]?.date || 'all'
    emitCompanyOptionExpirations(options, selected)
    return true
  }

  function renderCompanyOptionChainTable() {
    const table = document.getElementById('optionChainTable') as HTMLTableElement | null
    if (!table || !companyOptionChain) {
      return
    }
    const expirationFilter = (document.getElementById('optionExpirationFilter') as HTMLSelectElement | null)?.value || 'all'
    const typeFilter = (document.getElementById('optionTypeFilter') as HTMLSelectElement | null)?.value || 'all'
    const currentPrice = companyOptionCurrentPrice()
    const options: CompanyOptionContract[] = []

    for (const expiration of companyOptionChain.expirations) {
      if (expirationFilter !== 'all' && expiration.date !== expirationFilter) {
        continue
      }
      if (typeFilter === 'all' || typeFilter === 'call') {
        for (const option of expiration.calls) {
          options.push(option)
        }
      }
      if (typeFilter === 'all' || typeFilter === 'put') {
        for (const option of expiration.puts) {
          options.push(option)
        }
      }
    }
    const closestSymbols = companyOptionClosestSymbols(options, currentPrice)
    const chainRows = options.map((option) => companyOptionChainRowData(option, currentPrice, closestSymbols.has(option.symbol)))

    emitCompanyOptionChainRows(chainRows)
    requestAnimationFrame(() => companyOptionScrollToClosestRow(table))
  }

  function companyOptionClosestSymbols(options: CompanyOptionContract[], currentPrice: number): Set<string> {
    const symbols = new Set<string>()
    if (currentPrice <= 0) {
      return symbols
    }
    for (const optionType of ['call', 'put'] as const) {
      const closest = options
        .filter((option) => option.type === optionType)
        .sort((a, b) => Math.abs(a.strike - currentPrice) - Math.abs(b.strike - currentPrice))[0]
      if (closest) {
        symbols.add(closest.symbol)
      }
    }
    return symbols
  }

  function companyOptionScrollToClosestRow(table: HTMLTableElement) {
    const wrap = table.closest('.company-option-chain-wrap') as HTMLElement | null
    if (!wrap) {
      return
    }
    requestAnimationFrame(() => {
      const row = table.querySelector('tbody tr.table-warning') as HTMLElement | null
      const head = table.querySelector('thead') as HTMLElement | null
      if (!row) {
        return
      }
      const wrapRect = wrap.getBoundingClientRect()
      const rowRect = row.getBoundingClientRect()
      const headHeight = head?.getBoundingClientRect().height || 0
      const visibleHeight = wrap.clientHeight - headHeight
      const targetTop = headHeight + Math.max(0, (visibleHeight - rowRect.height) / 2)
      wrap.scrollTop += rowRect.top - wrapRect.top - targetTop
    })
  }

  function companyOptionChainRowData(option: CompanyOptionContract, currentPrice: number, isClosest: boolean) {
    const distance = currentPrice > 0 ? 100 * option.strike / currentPrice - 100 : 0
    const inTheMoney = option.type === 'call' ? option.strike < currentPrice : option.strike > currentPrice
    const rowClass = isClosest ? 'table-warning fw-semibold' : (inTheMoney ? 'table-light' : '')
    return {
      symbol: option.symbol,
      rowClass,
      type: option.type === 'call' ? 'Call' : 'Put',
      strike: companyOptionFormatNumber(option.strike),
      distance: distance.toFixed(2),
      price: companyOptionFormatNumber(option.price),
      bid: companyOptionFormatNumber(option.bid),
      ask: companyOptionFormatNumber(option.ask),
      last: companyOptionFormatNumber(option.last),
      volume: String(option.volume || 0),
      openInterest: String(option.openInterest || 0),
    }
  }

  function companyOptionChainRow(row: ReturnType<typeof companyOptionChainRowData>): string {
    return `<tr class="${escapeHtml(row.rowClass)}">
      <td>${escapeHtml(row.type)}</td>
      <td class="text-end">${escapeHtml(row.strike)}</td>
      <td class="text-end">${escapeHtml(row.distance)}</td>
      <td class="text-end">${escapeHtml(row.price)}</td>
      <td class="text-end">${escapeHtml(row.bid)}</td>
      <td class="text-end">${escapeHtml(row.ask)}</td>
      <td class="text-end">${escapeHtml(row.last)}</td>
      <td class="text-end">${escapeHtml(row.volume)}</td>
      <td class="text-end">${escapeHtml(row.openInterest)}</td>
      <td><button type="button" class="btn btn-sm btn-outline-primary" data-action="add-option-leg" data-symbol="${escapeHtml(row.symbol)}">加入</button></td>
    </tr>`
  }

  function onCompanyOptionChainClick(event: Event) {
    const target = event.target as HTMLElement
    const button = target.closest('button[data-action="add-option-leg"]') as HTMLButtonElement | null
    if (!button || !companyOptionChain) {
      return
    }
    const option = findCompanyOptionContract(button.dataset.symbol || '')
    if (!option) {
      return
    }
    companyOptionLegs.push({
      ...option,
      id: companyOptionLegSeq++,
      side: 'buy',
      quantity: 1
    })
    renderCompanyOptionStrategy()
  }

  function findCompanyOptionContract(symbol: string): CompanyOptionContract | null {
    if (!companyOptionChain) {
      return null
    }
    for (const expiration of companyOptionChain.expirations) {
      for (const option of expiration.calls.concat(expiration.puts)) {
        if (option.symbol === symbol) {
          return option
        }
      }
    }
    return null
  }

  function onCompanyOptionStrategyClick(event: Event) {
    const target = event.target as HTMLElement
    const button = target.closest('button[data-action="remove-option-leg"]') as HTMLButtonElement | null
    if (!button) {
      return
    }
    const id = parseInt(button.dataset.id || '', 10)
    companyOptionLegs = companyOptionLegs.filter((leg) => leg.id !== id)
    renderCompanyOptionStrategy()
  }

  function onCompanyOptionStrategyChange(event: Event) {
    const target = event.target as HTMLElement
    const input = target.closest('[data-action="update-option-leg"]') as HTMLInputElement | HTMLSelectElement | null
    if (!input) {
      return
    }
    const id = parseInt(input.dataset.id || '', 10)
    const field = input.dataset.field || ''
    const leg = companyOptionLegs.find((item) => item.id === id)
    if (!leg) {
      return
    }
    if (field === 'side') {
      leg.side = input.value === 'sell' ? 'sell' : 'buy'
    } else if (field === 'quantity') {
      const quantity = parseInt(input.value, 10)
      leg.quantity = Number.isFinite(quantity) && quantity > 0 ? quantity : 1
    }
    if (event.type === 'input') {
      renderCompanyOptionStrategySummary()
      renderCompanyOptionPayoffChart()
      return
    }
    renderCompanyOptionStrategy()
  }

  function renderCompanyOptionStrategy() {
    const table = document.getElementById('optionStrategyTable') as HTMLTableElement | null
    if (!table) {
      return
    }
    if (companyOptionLegs.length === 0) {
      emitCompanyOptionStrategyLegs([])
      setCompanyOptionStrategySummary('')
      renderCompanyOptionPayoffChart()
      return
    }
    emitCompanyOptionStrategyLegs(companyOptionStrategyLegRows())
    renderCompanyOptionStrategySummary()
    renderCompanyOptionPayoffChart()
  }

  function companyOptionStrategyLegRows() {
    return companyOptionLegs.map((leg) => ({
      id: leg.id,
      side: leg.side,
      quantity: leg.quantity,
      type: leg.type,
      expiration: leg.expiration,
      strike: companyOptionFormatNumber(leg.strike),
      price: companyOptionFormatNumber(leg.price),
    }))
  }

  function renderCompanyOptionStrategySummary() {
    const premium = companyOptionLegs.reduce((sum, leg) => sum + (leg.side === 'buy' ? -1 : 1) * leg.price * leg.quantity * 100, 0)
    const currentPrice = companyOptionCurrentPrice()
    const breakEvenText = companyOptionBreakEvenPoints(companyOptionPayoffData(currentPrice))
      .map((price) => {
        const ratio = currentPrice > 0 ? 100 * (price / currentPrice - 1) : 0
        const direction = ratio > 0 ? '需涨' : (ratio < 0 ? '需跌' : '当前价')
        const ratioText = Math.abs(ratio).toFixed(2)
        return `${companyOptionFormatNumber(price)} (${direction}${direction === '当前价' ? '' : ' ' + ratioText + '%'})`
      })
    setCompanyOptionStrategySummary(`净权利金: ${companyOptionFormatNumber(premium)}${breakEvenText.length > 0 ? '；盈亏平衡: ' + breakEvenText.join('，') : ''}`)
  }

  function renderCompanyOptionPayoffChart() {
    const currentPrice = companyOptionCurrentPrice()
    if (companyOptionLegs.length === 0 || currentPrice <= 0) {
      setCompanyOptionChartOption('optionsLineChart', {
        xAxis: {type: 'value'},
        yAxis: {type: 'value'},
        series: []
      })
      return
    }

    const data = companyOptionPayoffData(currentPrice)
    const returnData = companyOptionPayoffReturnData(data)
    const breakEvenPoints = companyOptionBreakEvenPoints(data)
    const breakEvenMarkLines = breakEvenPoints.map((price) => ({
      name: '盈亏平衡',
      xAxis: price,
      lineStyle: {color: 'rgba(220,53,69,0.45)', type: 'dashed', width: 1},
      label: {show: false}
    }))
    const breakEvenMarkPoints = breakEvenPoints.map((price) => ({
      name: '盈亏平衡',
      coord: [price, 0],
      value: companyOptionFormatNumber(price),
      symbol: 'pin',
      symbolOffset: [0, -28],
      itemStyle: {color: '#dc3545'}
    }))

    setCompanyOptionChartOption('optionsLineChart', {
      color: echartsColor,
      tooltip: {
        trigger: 'axis',
        formatter: (params: any) => {
          const point = params[0].value
          return `股价 ${companyOptionFormatNumber(point[0])}<br/>收益率 ${companyOptionFormatPercent(point[1])}`
        }
      },
      grid: {
        left: '3%',
        right: '4%',
        bottom: '6%',
        containLabel: true
      },
      xAxis: {
        type: 'value',
        name: '到期股价',
        axisLabel: {formatter: (value: number) => companyOptionFormatNumber(value)}
      },
      yAxis: {
        type: 'value',
        name: '收益率',
        axisLabel: {formatter: (value: number) => companyOptionFormatPercent(value)}
      },
      series: [{
        name: '到期收益率',
        type: 'line',
        showSymbol: false,
        data: returnData,
        markLine: {
          symbol: 'none',
          data: [
            {yAxis: 0, lineStyle: {color: '#999', type: 'dashed'}},
            {xAxis: currentPrice, lineStyle: {color: '#999', type: 'dotted'}},
            ...breakEvenMarkLines
          ]
        },
        markPoint: {
          symbolSize: 56,
          label: {
            formatter: (params: any) => `盈亏平衡\n${params.value}`,
            color: '#dc3545',
            backgroundColor: 'rgba(255,255,255,0.92)',
            borderColor: '#dc3545',
            borderWidth: 1,
            borderRadius: 3,
            padding: [3, 5],
            lineHeight: 16
          },
          data: breakEvenMarkPoints
        }
      }]
    })
  }

  function companyOptionPayoffReturnData(data: number[][]): number[][] {
    const base = companyOptionPayoffReturnBase(data)
    if (base <= 0) {
      return data.map((point) => [point[0], 0])
    }
    return data.map((point) => [point[0], Number((100 * point[1] / base).toFixed(4))])
  }

  function companyOptionPayoffReturnBase(data: number[][]): number {
    let maxLoss = 0
    for (const point of data) {
      if (point[1] < 0) {
        maxLoss = Math.max(maxLoss, -point[1])
      }
    }
    if (maxLoss > 0) {
      return maxLoss
    }
    const netPremium = companyOptionLegs.reduce((sum, leg) => sum + (leg.side === 'buy' ? -1 : 1) * leg.price * leg.quantity * 100, 0)
    return Math.abs(netPremium)
  }

  function companyOptionPayoffData(currentPrice: number): number[][] {
    if (companyOptionLegs.length === 0 || currentPrice <= 0) {
      return []
    }
    const strikes = companyOptionLegs.map((leg) => leg.strike)
    const minBase = Math.min(currentPrice, ...strikes)
    const maxBase = Math.max(currentPrice, ...strikes)
    const minPrice = Math.max(0, minBase * 0.5)
    const maxPrice = maxBase * 1.5
    const steps = 80
    const data: number[][] = []
    for (let i = 0; i <= steps; i++) {
      const price = minPrice + (maxPrice - minPrice) * i / steps
      data.push([Number(price.toFixed(2)), Number(companyOptionPayoff(price).toFixed(2))])
    }
    return data
  }

  function companyOptionBreakEvenPoints(data: number[][]): number[] {
    const points: number[] = []
    for (let i = 1; i < data.length; i++) {
      const prev = data[i - 1]
      const curr = data[i]
      const prevPrice = prev[0]
      const prevPayoff = prev[1]
      const currPrice = curr[0]
      const currPayoff = curr[1]
      if (prevPayoff === 0) {
        points.push(prevPrice)
        continue
      }
      if (prevPayoff * currPayoff < 0) {
        const price = prevPrice + (currPrice - prevPrice) * (0 - prevPayoff) / (currPayoff - prevPayoff)
        points.push(Number(price.toFixed(2)))
      }
      if (i === data.length - 1 && currPayoff === 0) {
        points.push(currPrice)
      }
    }
    return points.filter((price, idx) => points.findIndex((item) => Math.abs(item - price) < 0.01) === idx)
  }

  function companyOptionPayoff(underlyingPrice: number): number {
    let total = 0
    for (const leg of companyOptionLegs) {
      const intrinsic = leg.type === 'call' ? Math.max(underlyingPrice - leg.strike, 0) : Math.max(leg.strike - underlyingPrice, 0)
      const oneContractPayoff = leg.side === 'buy' ? intrinsic - leg.price : leg.price - intrinsic
      total += oneContractPayoff * leg.quantity * 100
    }
    return total
  }

  function companyOptionCurrentPrice(): number {
    if (companyOptionChain?.currentPrice) {
      return companyOptionChain.currentPrice
    }
    const text = document.getElementById('currentPrice')?.textContent || ''
    const value = parseFloat(text.replace(/,/g, ''))
    return Number.isFinite(value) ? value : 0
  }

  function companyOptionFormatExpirationDate(value: string): string {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) {
      return value
    }
    return `${date.getFullYear()}-${zeroPad(date.getMonth() + 1, 2)}-${zeroPad(date.getDate(), 2)}`
  }

  function companyOptionExpirationOptionText(value: string): string {
    const formattedDate = companyOptionFormatExpirationDate(value)
    const days = companyOptionDaysUntilExpiration(value)
    if (days === null) {
      return formattedDate
    }
    if (days < 0) {
      return `${formattedDate}（已到期）`
    }
    if (days === 0) {
      return `${formattedDate}（今天）`
    }
    return `${formattedDate}（剩 ${days} 天）`
  }

  function companyOptionDaysUntilExpiration(value: string): number | null {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) {
      return null
    }
    const today = new Date()
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
    const expiration = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
    return Math.round((expiration - start) / (24 * 60 * 60 * 1000))
  }

  function companyOptionFormatNumber(value: number): string {
    if (!Number.isFinite(value)) {
      return '-'
    }
    return value.toLocaleString('en-US', {maximumFractionDigits: 2})
  }

  function initCompanyOptionCompareFromQuery(): boolean {
    if (companyOptionCompareInitialized || !companyOptionChain) {
      return false
    }
    companyOptionCompareInitialized = true

    const capital = companyOptionPositiveNumber(query.capital) > 0 ? String(query.capital) : '100000000'
    const prices = query.prices || companyOptionDefaultScenarioPrices(companyOptionCurrentPrice()).map((price) => Number(price.toFixed(2))).join(',')
    const compareControlsRenderedByVue = setCompanyOptionCompareControls({
      capital,
      prices,
      strategyName: '',
      strategyNamePlaceholder: '当前组合',
    })
    companyOptionCompareStrategies = companyOptionDecodeCompareStrategies(query.strategies || query.strategy || '')
    return compareControlsRenderedByVue
  }

  function onCompanyOptionAddCurrentStrategy() {
    if (companyOptionLegs.length === 0) {
      setCompanyOptionCompareStatus('请先从期权链加入合约')
      return
    }
    const nameInput = document.getElementById('optionCompareStrategyName') as HTMLInputElement | null
    const name = (nameInput?.value || '').trim() || companyOptionDefaultStrategyName(companyOptionLegs)
    companyOptionCompareStrategies.push({
      name: name,
      legs: companyOptionLegs.map((leg) => ({
        side: leg.side,
        quantity: leg.quantity,
        type: leg.type,
        strike: leg.strike,
        expiration: leg.expiration
      }))
    })
    setCompanyOptionCompareControls({strategyName: ''})
    renderCompanyOptionCompare()
    companyOptionReplaceCompareUrl()
  }

  function onCompanyOptionCopyCompareLink() {
    const url = companyOptionReplaceCompareUrl()
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(() => {
        setCompanyOptionCompareStatus('已复制对比链接')
      }).catch(() => {
        setCompanyOptionCompareStatus(url)
      })
      return
    }
    setCompanyOptionCompareStatus(url)
  }

  function onCompanyOptionCompareInputChange() {
    renderCompanyOptionCompare()
    companyOptionReplaceCompareUrl()
  }

  function onCompanyOptionCompareTableClick(event: Event) {
    const target = event.target as HTMLElement
    const button = target.closest('button[data-action="remove-compare-strategy"]') as HTMLButtonElement | null
    if (!button) {
      return
    }
    const index = parseInt(button.dataset.index || '', 10)
    if (!Number.isFinite(index)) {
      return
    }
    companyOptionCompareStrategies = companyOptionCompareStrategies.filter((_, itemIndex) => itemIndex !== index)
    renderCompanyOptionCompare()
    companyOptionReplaceCompareUrl()
  }

  function renderCompanyOptionCompare() {
    const table = document.getElementById('optionCompareTable') as HTMLTableElement | null
    if (!table || !companyOptionChain) {
      return
    }
    const capital = companyOptionCompareCapital()
    const scenarioPrices = companyOptionCompareScenarioPrices()

    if (companyOptionCompareStrategies.length === 0) {
      if (!emitCompanyOptionCompareTable({scenarioPrices: [], rows: []})) {
        table.innerHTML = `<thead class="table-info"><tr><th>策略对比</th></tr></thead><tbody><tr><td class="text-muted">通过 URL 参数载入策略，或把右侧当前组合加入对比</td></tr></tbody>`
      }
      setCompanyOptionChartOption('optionCompareChart', {xAxis: {type: 'value'}, yAxis: {type: 'value'}, series: []})
      setCompanyOptionCompareStatus('对比口径: 买入按 Ask，卖出按 Bid；每张期权按 100 股计算')
      return
    }

    const results = companyOptionCompareStrategies.map((strategy) => companyOptionAnalyzeCompareStrategy(strategy, capital, scenarioPrices))
    if (!emitCompanyOptionCompareTable(companyOptionCompareTableView(results, scenarioPrices))) {
      const priceHeads = scenarioPrices.map((price) => `<th class="text-end">${companyOptionFormatNumber(price)}</th>`).join('')
      const rows = results.map((result, index) => companyOptionCompareRow(result, index)).join('')
      table.innerHTML = `<thead class="table-info">
        <tr>
          <th>策略</th>
          <th>腿</th>
          <th class="text-end">净成本/股</th>
          <th class="text-end">盈亏平衡</th>
          <th class="text-end">最大亏损/股</th>
          <th class="text-end">组数</th>
          <th class="text-end">初始现金</th>
          ${priceHeads}
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>`
    }
    renderCompanyOptionCompareChart(results)
    setCompanyOptionCompareStatus(`对比 ${results.length} 个策略，资金量 ${companyOptionFormatCompactMoney(capital)}`)
  }

  function companyOptionCompareTableView(results: CompanyOptionCompareResult[], scenarioPrices: number[]) {
    return {
      scenarioPrices: scenarioPrices.map((price) => companyOptionFormatNumber(price)),
      rows: results.map((result, index) => companyOptionCompareTableRow(result, index)),
    }
  }

  function companyOptionCompareTableRow(result: CompanyOptionCompareResult, index: number) {
    if (result.error) {
      return {
        index,
        name: result.strategy.name || `策略${index + 1}`,
        error: result.error,
        errorColSpan: 6 + result.scenarioPrices.length,
        legs: [],
        debitPerShare: '',
        breakevens: [],
        maxLoss: '',
        contracts: '',
        initialCash: '',
        scenarioCells: [],
      }
    }
    const legs = result.legs.map((leg) => {
      const side = leg.input.side === 'buy' ? '买' : '卖'
      const optionType = leg.input.type === 'call' ? 'Call' : 'Put'
      return `${side}${leg.input.quantity} ${optionType} ${companyOptionFormatNumber(leg.input.strike)} @ ${companyOptionFormatNumber(leg.premium)}`
    })
    const maxLoss = result.unlimitedLoss ? '无限' : (result.maxLossPerShare === null ? '-' : `${companyOptionFormatNumber(result.maxLossPerShare)} @ ${companyOptionFormatNumber(result.maxLossPrice || 0)}`)
    const breakevens = result.breakevens.length > 0 ? result.breakevens.map(companyOptionFormatNumber) : ['-']
    const scenarioCells = result.scenarioPLTotal.map((value) => ({
      text: companyOptionFormatCompactMoney(value),
      className: value >= 0 ? 'text-success' : 'text-danger',
    }))
    return {
      index,
      name: result.strategy.name || `策略${index + 1}`,
      legs,
      debitPerShare: companyOptionFormatNumber(result.debitPerShare),
      breakevens,
      maxLoss,
      contracts: String(result.contracts),
      initialCash: companyOptionFormatCompactMoney(result.initialCash),
      scenarioCells,
    }
  }

  function companyOptionCompareRow(result: CompanyOptionCompareResult, index: number): string {
    if (result.error) {
      return `<tr class="table-danger">
        <td>${escapeHtml(result.strategy.name || `策略${index + 1}`)}</td>
        <td colspan="${6 + result.scenarioPrices.length}">${escapeHtml(result.error)}</td>
        <td><button type="button" class="btn btn-sm btn-outline-danger" data-action="remove-compare-strategy" data-index="${index}">移除</button></td>
      </tr>`
    }
    const legs = result.legs.map((leg) => {
      const side = leg.input.side === 'buy' ? '买' : '卖'
      const optionType = leg.input.type === 'call' ? 'Call' : 'Put'
      return `${side}${leg.input.quantity} ${optionType} ${companyOptionFormatNumber(leg.input.strike)} @ ${companyOptionFormatNumber(leg.premium)}`
    }).join('<br>')
    const maxLoss = result.unlimitedLoss ? '无限' : (result.maxLossPerShare === null ? '-' : `${companyOptionFormatNumber(result.maxLossPerShare)} @ ${companyOptionFormatNumber(result.maxLossPrice || 0)}`)
    const breakevens = result.breakevens.length > 0 ? result.breakevens.map(companyOptionFormatNumber).join('<br>') : '-'
    const scenarioCells = result.scenarioPLTotal.map((value) => {
      const className = value >= 0 ? 'text-success' : 'text-danger'
      return `<td class="text-end ${className}">${companyOptionFormatCompactMoney(value)}</td>`
    }).join('')
    return `<tr>
      <td>${escapeHtml(result.strategy.name || `策略${index + 1}`)}</td>
      <td class="small">${legs}</td>
      <td class="text-end">${companyOptionFormatNumber(result.debitPerShare)}</td>
      <td class="text-end">${breakevens}</td>
      <td class="text-end">${maxLoss}</td>
      <td class="text-end">${result.contracts}</td>
      <td class="text-end">${companyOptionFormatCompactMoney(result.initialCash)}</td>
      ${scenarioCells}
      <td><button type="button" class="btn btn-sm btn-outline-danger" data-action="remove-compare-strategy" data-index="${index}">移除</button></td>
    </tr>`
  }

  function renderCompanyOptionCompareChart(results: CompanyOptionCompareResult[]) {
    if (!companyOptionChain) {
      return
    }
    const validResults = results.filter((result) => !result.error)
    if (validResults.length === 0) {
      setCompanyOptionChartOption('optionCompareChart', {xAxis: {type: 'value'}, yAxis: {type: 'value'}, series: []})
      return
    }
    const axisPrices = companyOptionCompareChartPrices(validResults)
    const currentPrice = companyOptionCurrentPrice()
    setCompanyOptionChartOption('optionCompareChart', {
      color: echartsColor,
      tooltip: {
        trigger: 'axis',
        formatter: (params: any) => {
          if (!Array.isArray(params) || params.length === 0) {
            return ''
          }
          const price = params[0].value[0]
          const lines = [`股价 ${companyOptionFormatNumber(price)}`]
          const sortedParams = params.slice().sort((a: any, b: any) => {
            const aValue = Array.isArray(a.value) ? a.value[1] : Number.NEGATIVE_INFINITY
            const bValue = Array.isArray(b.value) ? b.value[1] : Number.NEGATIVE_INFINITY
            return bValue - aValue
          })
          for (const item of sortedParams) {
            lines.push(`${item.marker}${item.seriesName}: ${companyOptionFormatPercent(item.value[1])}`)
          }
          return lines.join('<br/>')
        }
      },
      legend: {top: 0},
      grid: {left: '3%', right: '4%', top: 48, bottom: '6%', containLabel: true},
      xAxis: {
        type: 'value',
        name: '到期股价',
        axisLabel: {formatter: (value: number) => companyOptionFormatNumber(value)}
      },
      yAxis: {
        type: 'value',
        name: '收益率',
        axisLabel: {formatter: (value: number) => companyOptionFormatPercent(value)}
      },
      series: validResults.map((result) => ({
        name: result.strategy.name || '策略',
        type: 'line',
        showSymbol: false,
        data: axisPrices.map((price) => [price, Number(companyOptionCompareReturnRate(result, price).toFixed(4))]),
        markLine: {
          symbol: 'none',
          data: [
            {yAxis: 0, lineStyle: {color: '#999', type: 'dashed'}},
            {xAxis: currentPrice, lineStyle: {color: '#999', type: 'dotted'}}
          ]
        }
      }))
    })
  }

  function companyOptionCompareReturnRate(result: CompanyOptionCompareResult, underlyingPrice: number): number {
    const capital = companyOptionCompareCapital()
    if (capital <= 0) {
      return 0
    }
    const plTotal = companyOptionComparePLPerShare(result.legs, result.debitPerShare, underlyingPrice) * result.contracts * 100
    return 100 * plTotal / capital
  }

  function companyOptionAnalyzeCompareStrategy(strategy: CompanyOptionCompareStrategy, capital: number, scenarioPrices: number[]): CompanyOptionCompareResult {
    const emptyResult: CompanyOptionCompareResult = {
      strategy: strategy,
      legs: [],
      debitPerShare: 0,
      maxLossPerShare: null,
      maxLossPrice: null,
      unlimitedLoss: false,
      contracts: 1,
      initialCash: 0,
      breakevens: [],
      scenarioPrices: scenarioPrices,
      scenarioPLPerShare: [],
      scenarioPLTotal: []
    }
    const resolvedLegs: CompanyOptionCompareResolvedLeg[] = []
    for (const input of strategy.legs) {
      const expiration = companyOptionFindExpiration(input.expiration || strategy.expiration || '')
      if (!expiration) {
        return {...emptyResult, error: `找不到到期日: ${input.expiration || strategy.expiration || ''}`}
      }
      const contract = companyOptionFindContractInExpiration(expiration, input.type, input.strike)
      if (!contract) {
        return {...emptyResult, error: `${companyOptionFormatExpirationDate(expiration.date)} 找不到 ${input.type} ${companyOptionFormatNumber(input.strike)}`}
      }
      const signedQty = input.side === 'buy' ? input.quantity : -input.quantity
      resolvedLegs.push({
        input: {...input, expiration: expiration.date},
        contract: contract,
        premium: companyOptionComparePremium(contract, input.side),
        signedQty: signedQty
      })
    }

    const debit = companyOptionCompareDebitPerShare(resolvedLegs)
    const unlimitedLoss = companyOptionCompareHasUnlimitedLoss(resolvedLegs)
    const evaluationPrices = companyOptionCompareEvaluationPrices(resolvedLegs, scenarioPrices)
    let minPL = Number.POSITIVE_INFINITY
    let minPrice = 0
    for (const price of evaluationPrices) {
      const pl = companyOptionComparePLPerShare(resolvedLegs, debit, price)
      if (pl < minPL) {
        minPL = pl
        minPrice = price
      }
    }
    const maxLossPerShare = !unlimitedLoss && minPL < 0 ? -minPL : null
    const maxLossPrice = maxLossPerShare === null ? null : minPrice
    let contracts = 1
    if (capital > 0) {
      if (maxLossPerShare !== null && maxLossPerShare > 0) {
        contracts = Math.floor(capital / (maxLossPerShare * 100))
      } else if (debit > 0 && !unlimitedLoss) {
        contracts = Math.floor(capital / (debit * 100))
      }
    }
    contracts = Math.max(1, contracts)
    const scenarioPLPerShare = scenarioPrices.map((price) => companyOptionComparePLPerShare(resolvedLegs, debit, price))
    const scenarioPLTotal = scenarioPLPerShare.map((pl) => pl * contracts * 100)

    return {
      strategy: strategy,
      legs: resolvedLegs,
      debitPerShare: debit,
      maxLossPerShare: maxLossPerShare,
      maxLossPrice: maxLossPrice,
      unlimitedLoss: unlimitedLoss,
      contracts: contracts,
      initialCash: debit * contracts * 100,
      breakevens: companyOptionCompareBreakevens(resolvedLegs, debit),
      scenarioPrices: scenarioPrices,
      scenarioPLPerShare: scenarioPLPerShare,
      scenarioPLTotal: scenarioPLTotal
    }
  }

  function companyOptionComparePremium(contract: CompanyOptionContract, side: 'buy' | 'sell'): number {
    if (side === 'buy') {
      return contract.ask > 0 ? contract.ask : (contract.price > 0 ? contract.price : contract.last)
    }
    return contract.bid > 0 ? contract.bid : (contract.price > 0 ? contract.price : contract.last)
  }

  function companyOptionCompareDebitPerShare(legs: CompanyOptionCompareResolvedLeg[]): number {
    return legs.reduce((sum, leg) => sum + leg.signedQty * leg.premium, 0)
  }

  function companyOptionComparePLPerShare(legs: CompanyOptionCompareResolvedLeg[], debit: number, underlyingPrice: number): number {
    let value = -debit
    for (const leg of legs) {
      const intrinsic = leg.input.type === 'call' ? Math.max(underlyingPrice - leg.input.strike, 0) : Math.max(leg.input.strike - underlyingPrice, 0)
      value += leg.signedQty * intrinsic
    }
    return value
  }

  function companyOptionCompareHasUnlimitedLoss(legs: CompanyOptionCompareResolvedLeg[]): boolean {
    const callSlope = legs.reduce((sum, leg) => sum + (leg.input.type === 'call' ? leg.signedQty : 0), 0)
    return callSlope < 0
  }

  function companyOptionCompareEvaluationPrices(legs: CompanyOptionCompareResolvedLeg[], prices: number[]): number[] {
    const points = [0]
    for (const leg of legs) {
      points.push(leg.input.strike)
    }
    points.push(...prices)
    return companyOptionUniqueSortedNumbers(points)
  }

  function companyOptionCompareBreakevens(legs: CompanyOptionCompareResolvedLeg[], debit: number): number[] {
    const strikes = companyOptionUniqueSortedNumbers(legs.map((leg) => leg.input.strike))
    const points = [0, ...strikes]
    const breakevens: number[] = []
    for (let i = 1; i < points.length; i++) {
      companyOptionAppendBreakevenOnSegment(breakevens, legs, debit, points[i - 1], points[i])
    }
    const last = points[points.length - 1]
    const leftPL = companyOptionComparePLPerShare(legs, debit, last)
    if (Math.abs(leftPL) < 0.0001) {
      companyOptionAppendUniqueNumber(breakevens, last)
    }
    const slope = companyOptionCompareSlope(legs, last + 1)
    if (Math.abs(slope) > 0.0001) {
      const price = last - leftPL / slope
      if (price >= last) {
        companyOptionAppendUniqueNumber(breakevens, price)
      }
    }
    return breakevens.map((price) => Number(price.toFixed(2)))
  }

  function companyOptionAppendBreakevenOnSegment(breakevens: number[], legs: CompanyOptionCompareResolvedLeg[], debit: number, left: number, right: number) {
    const leftPL = companyOptionComparePLPerShare(legs, debit, left)
    const rightPL = companyOptionComparePLPerShare(legs, debit, right)
    if (Math.abs(leftPL) < 0.0001) {
      companyOptionAppendUniqueNumber(breakevens, left)
    }
    if (leftPL * rightPL < 0) {
      companyOptionAppendUniqueNumber(breakevens, left + (0 - leftPL) * (right - left) / (rightPL - leftPL))
    }
  }

  function companyOptionCompareSlope(legs: CompanyOptionCompareResolvedLeg[], price: number): number {
    let slope = 0
    for (const leg of legs) {
      if (leg.input.type === 'call' && price > leg.input.strike) {
        slope += leg.signedQty
      }
      if (leg.input.type === 'put' && price < leg.input.strike) {
        slope -= leg.signedQty
      }
    }
    return slope
  }

  function companyOptionFindExpiration(value: string): CompanyOptionExpiration | null {
    if (!companyOptionChain || companyOptionChain.expirations.length === 0) {
      return null
    }
    const normalized = value.trim().toLowerCase()
    if (normalized === '' || normalized === 'all') {
      return companyOptionChain.expirations[0]
    }
    for (const expiration of companyOptionChain.expirations) {
      if (expiration.date.toLowerCase() === normalized || companyOptionFormatExpirationDate(expiration.date).toLowerCase() === normalized) {
        return expiration
      }
    }
    const matches = companyOptionChain.expirations.filter((expiration) => expiration.date.toLowerCase().includes(normalized) || companyOptionFormatExpirationDate(expiration.date).includes(normalized))
    return matches.length === 1 ? matches[0] : null
  }

  function companyOptionFindContractInExpiration(expiration: CompanyOptionExpiration, optionType: 'call' | 'put', strike: number): CompanyOptionContract | null {
    const options = optionType === 'call' ? expiration.calls : expiration.puts
    for (const option of options) {
      if (Math.abs(option.strike - strike) < 0.0001) {
        return option
      }
    }
    return null
  }

  function companyOptionCompareCapital(): number {
    const input = document.getElementById('optionCompareCapital') as HTMLInputElement | null
    const value = companyOptionPositiveNumber(input?.value || '')
    return value > 0 ? value : 100000000
  }

  function companyOptionCompareScenarioPrices(): number[] {
    const input = document.getElementById('optionComparePrices') as HTMLInputElement | null
    const values = (input?.value || '').split(',').map((item) => companyOptionPositiveNumber(item)).filter((value) => value > 0)
    if (values.length > 0) {
      return companyOptionUniqueSortedNumbers(values)
    }
    return companyOptionDefaultScenarioPrices(companyOptionCurrentPrice())
  }

  function companyOptionDefaultScenarioPrices(currentPrice: number): number[] {
    return companyOptionUniqueSortedNumbers([currentPrice * 0.8, currentPrice, 1100, 1200, 1300, 1500, 1625, 1750, 2000].filter((price) => price > 0))
  }

  function companyOptionCompareChartPrices(results: CompanyOptionCompareResult[]): number[] {
    const seed: number[] = [companyOptionCurrentPrice(), ...companyOptionCompareScenarioPrices()]
    for (const result of results) {
      for (const leg of result.legs) {
        seed.push(leg.input.strike)
      }
      seed.push(...result.breakevens)
    }
    const validSeed = seed.filter((value) => value > 0)
    const minBase = Math.min(...validSeed)
    const maxBase = Math.max(...validSeed)
    const minPrice = Math.max(0, minBase * 0.7)
    const maxPrice = Math.max(maxBase * 1.2, minPrice + 1)
    const points: number[] = []
    for (let i = 0; i <= 100; i++) {
      points.push(Number((minPrice + (maxPrice - minPrice) * i / 100).toFixed(2)))
    }
    points.push(...validSeed)
    return companyOptionUniqueSortedNumbers(points)
  }

  function companyOptionDefaultStrategyName(legs: CompanyOptionLeg[]): string {
    return `${companyOptionExpirationSummary(legs.map((leg) => leg.expiration))} ${companyOptionLegNameSummary(legs)}`.trim()
  }

  function companyOptionDecodeCompareStrategies(value: string): CompanyOptionCompareStrategy[] {
    if (!value.trim()) {
      return []
    }
    try {
      const decoded = companyOptionBase64UrlDecode(value.trim())
      const parsed = JSON.parse(decoded)
      if (!Array.isArray(parsed)) {
        return []
      }
      const strategies: CompanyOptionCompareStrategy[] = []
      for (const item of parsed) {
        const strategy = companyOptionNormalizeCompareStrategy(item)
        if (strategy) {
          strategies.push(strategy)
        }
      }
      return strategies
    } catch (error) {
      console.error('Failed to decode option strategies:', error)
      setCompanyOptionCompareStatus('策略参数解析失败')
      return []
    }
  }

  function companyOptionNormalizeCompareStrategy(item: any): CompanyOptionCompareStrategy | null {
    if (!item || !Array.isArray(item.legs)) {
      return null
    }
    const legs: CompanyOptionCompareLeg[] = []
    for (const rawLeg of item.legs) {
      const side = rawLeg?.side === 'sell' ? 'sell' : 'buy'
      const optionType = rawLeg?.type === 'put' ? 'put' : (rawLeg?.type === 'call' ? 'call' : '')
      const quantity = parseInt(String(rawLeg?.quantity || ''), 10)
      const strike = companyOptionPositiveNumber(String(rawLeg?.strike || ''))
      if (!optionType || !Number.isFinite(quantity) || quantity <= 0 || strike <= 0) {
        continue
      }
      legs.push({
        side: side,
        quantity: quantity,
        type: optionType,
        strike: strike,
        expiration: typeof rawLeg?.expiration === 'string' ? rawLeg.expiration : undefined
      })
    }
    if (legs.length === 0) {
      return null
    }
    return {
      name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : companyOptionDefaultCompareName(legs),
      expiration: typeof item.expiration === 'string' ? item.expiration : undefined,
      legs: legs
    }
  }

  function companyOptionDefaultCompareName(legs: CompanyOptionCompareLeg[]): string {
    return `${companyOptionExpirationSummary(legs.map((leg) => leg.expiration || ''))} ${companyOptionLegNameSummary(legs)}`.trim()
  }

  function companyOptionExpirationSummary(expirations: string[]): string {
    const values = expirations
      .map((expiration) => expiration.trim())
      .filter((expiration) => expiration !== '')
      .map(companyOptionFormatExpirationDate)
    const unique = values.filter((value, index) => values.indexOf(value) === index)
    return unique.join('/')
  }

  function companyOptionLegNameSummary(legs: CompanyOptionCompareLeg[]): string {
    return legs.map((leg) => `${leg.side === 'buy' ? 'B' : 'S'}${leg.quantity}${leg.type === 'call' ? 'C' : 'P'}${companyOptionFormatNumber(leg.strike)}`).join(' ')
  }

  function companyOptionReplaceCompareUrl(): string {
    const url = new URL(window.location.href)
    url.searchParams.set('code', currentCode())
    url.searchParams.set('v', 'breakeven-summary')
    url.searchParams.set('capital', String(companyOptionCompareCapital()))
    url.searchParams.set('prices', companyOptionCompareScenarioPrices().join(','))
    if (companyOptionCompareStrategies.length > 0) {
      url.searchParams.set('strategies', companyOptionBase64UrlEncode(JSON.stringify(companyOptionCompareStrategies)))
    } else {
      url.searchParams.delete('strategies')
    }
    window.history.replaceState(null, '', url.toString())
    return url.toString()
  }

  function companyOptionBase64UrlEncode(value: string): string {
    const binary = encodeURIComponent(value).replace(/%([0-9A-F]{2})/g, (_match: string, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
  }

  function companyOptionBase64UrlDecode(value: string): string {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - base64.length % 4) % 4)
    const binary = atob(padded)
    let escaped = ''
    for (let i = 0; i < binary.length; i++) {
      escaped += `%${binary.charCodeAt(i).toString(16).padStart(2, '0')}`
    }
    return decodeURIComponent(escaped)
  }

  function companyOptionUniqueSortedNumbers(values: number[]): number[] {
    const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
    const result: number[] = []
    for (const value of sorted) {
      if (result.length === 0 || Math.abs(value - result[result.length - 1]) > 0.0001) {
        result.push(value)
      }
    }
    return result
  }

  function companyOptionAppendUniqueNumber(values: number[], value: number) {
    if (!Number.isFinite(value)) {
      return
    }
    for (const existing of values) {
      if (Math.abs(existing - value) < 0.0001) {
        return
      }
    }
    values.push(value)
  }

  function companyOptionPositiveNumber(value: unknown): number {
    const parsed = parseFloat(String(value ?? '').replace(/,/g, '').trim())
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
  }

  function companyOptionFormatCompactMoney(value: number): string {
    if (!Number.isFinite(value)) {
      return '-'
    }
    const abs = Math.abs(value)
    if (abs >= 100000000) {
      return `${(value / 100000000).toLocaleString('en-US', {maximumFractionDigits: 2})}亿`
    }
    if (abs >= 10000) {
      return `${(value / 10000).toLocaleString('en-US', {maximumFractionDigits: 2})}万`
    }
    return companyOptionFormatNumber(value)
  }

  function companyOptionFormatPercent(value: number): string {
    if (!Number.isFinite(value)) {
      return '-'
    }
    return `${value.toLocaleString('en-US', {maximumFractionDigits: 2})}%`
  }

  function emitCompanyOptionExpirations(options: {value: string, text: string}[], selected: string): boolean {
    window.dispatchEvent(new CustomEvent('licai:company-option-expirations', {detail: {options, selected}}))
    return true
  }

  function emitCompanyOptionChainRows(rows: ReturnType<typeof companyOptionChainRowData>[]): boolean {
    window.dispatchEvent(new CustomEvent('licai:company-option-chain-rows', {detail: {rows}}))
    return true
  }

  function emitCompanyOptionCompareControls(detail: {capital?: string, prices?: string, strategyName?: string, strategyNamePlaceholder?: string}): boolean {
    window.dispatchEvent(new CustomEvent('licai:company-option-compare-controls', {detail}))
    return true
  }

  function emitCompanyOptionStrategySummary(text: string): boolean {
    window.dispatchEvent(new CustomEvent('licai:company-option-strategy-summary', {detail: {text}}))
    return true
  }

  function emitCompanyOptionStrategyLegs(legs: ReturnType<typeof companyOptionStrategyLegRows>): boolean {
    window.dispatchEvent(new CustomEvent('licai:company-option-strategy-legs', {detail: {legs}}))
    return true
  }

  function emitCompanyOptionCompareTable(detail: ReturnType<typeof companyOptionCompareTableView> | {scenarioPrices: string[], rows: unknown[]}): boolean {
    window.dispatchEvent(new CustomEvent('licai:company-option-compare-table', {detail}))
    return true
  }

  function emitCompanyOptionChartOption(id: string, option: EChartsOption): boolean {
    window.dispatchEvent(new CustomEvent('licai:company-option-chart-option', {detail: {id, option}}))
    return true
  }

  function setCompanyOptionChartOption(id: string, option: EChartsOption) {
    emitCompanyOptionChartOption(id, option)
  }

  function setCompanyOptionStrategySummary(text: string) {
    emitCompanyOptionStrategySummary(text)
  }

  function setCompanyOptionCompareControls(detail: {capital?: string, prices?: string, strategyName?: string, strategyNamePlaceholder?: string}): boolean {
    emitCompanyOptionCompareControls(detail)
    return true
  }

  function emitCompanyOptionStatus(kind: 'page' | 'compare', text: string): boolean {
    window.dispatchEvent(new CustomEvent('licai:company-option-status', {detail: {kind, text}}))
    return true
  }

  function setCompanyOptionCompareStatus(text: string) {
    emitCompanyOptionStatus('compare', text)
  }

  function setCompanyOptionStatus(text: string) {
    emitCompanyOptionStatus('page', text)
  }

  return initCompanyOption
}
