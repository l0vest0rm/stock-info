type FetchRequest = (request: {
  url?: string
  params?: Record<string, unknown>
  data?: unknown
  cacheKey?: string
  cacheTtl?: number
} | string) => Promise<unknown>

type Callback = (data: unknown) => void

type FundPagesRuntimeContext = {
  server: string
  echarts: any
  fetchRequest: FetchRequest
  fetchFundPosition: (code: string, seasons: number, callback: (code: string) => void) => void
  fetchFundInfo: (code: string, callback: (data: unknown) => void) => void
  renderFundInfoTable: (data: unknown) => void
  fetchCodesData: (codes: string[], fetcher: (code: string, callback: Callback) => void, callback: (codes: string[]) => void) => void
  fetchCompanyInfo: (code: string, callback: (data: unknown) => void) => void
  fillSelectOptions: (options: any[], value: number, id: string) => void
  fetchKlines: (codes: string[], fq: string, callback: (codes: string[]) => void) => void
  rerenderMyChart: () => void
  bsTable: (tableId: string, config: any) => void
  toTimestamp: (date: string) => number
  findTsIndex: (data: number[][], ts: number) => number
  dateRangeInit: () => void
  klinePriceChange: () => void
  positionCheckOnChange: () => void
  emitFundState: (patch: any) => boolean
  genFullCode: (code: string) => string
  getCode: () => string
  getCache: () => Record<string, unknown>
  getCodeNameMap: () => Record<string, string>
  getSelectedCodes: () => string[]
  setSelectedCodes: (codes: string[]) => void
  setKlineCodes: (codes: string[]) => void
}

function date2String(date: number): string {
  return new Date(date).toLocaleDateString('zh-CN')
}

function echartsPie(echarts: any, id: string, title: string, unit: string, data: any[]) {
  const chartDom = document.getElementById(id)
  if (!chartDom) {
    return
  }
  const myChart = echarts.init(chartDom)
  myChart.setOption({
    title: { text: title, left: 'center' },
    tooltip: { trigger: 'item', formatter: '{a} <br/>{b}: {c} ({d}%)' },
    legend: { orient: 'vertical', left: 'left', data: data.map((item) => item.name) },
    series: [{
      name: unit,
      type: 'pie',
      radius: '50%',
      data,
      emphasis: {
        itemStyle: {
          shadowBlur: 10,
          shadowOffsetX: 0,
          shadowColor: 'rgba(0, 0, 0, 0.5)',
        },
      },
    }],
  })
  window.addEventListener('resize', () => {
    myChart.resize()
  })
}

export function createFundPositionInitializer(context: FundPagesRuntimeContext) {
  const {
    server,
    echarts,
    fetchFundPosition,
    fillSelectOptions,
    fetchKlines,
    bsTable,
    toTimestamp,
    findTsIndex,
    dateRangeInit,
    getCode,
    getCache,
    getCodeNameMap,
    setSelectedCodes,
    setKlineCodes,
  } = context

  function emitFundPositionState(patch: any): boolean {
    window.dispatchEvent(new CustomEvent('licai:fund-position-state', { detail: patch || {} }))
    return true
  }

  function mapFundPositionCompareRows(positionMap: any): any[] {
    const rows: any[] = []
    let idx = 0
    for (const key in positionMap) {
      idx += 1
      const position = positionMap[key]
      rows.push({
        rank: idx,
        code: String(position[0] ?? ''),
        name: String(position[1] ?? ''),
        currentPositionPct: String(position[2] ?? ''),
        previousPositionPct: String(position[3] ?? ''),
        positionPctDiff: String(position[4] ?? ''),
        currentShares: String(position[5] ?? ''),
        previousShares: String(position[6] ?? ''),
        sharesDiffPct: String(position[7] ?? ''),
        currentPrice: String(position[8] ?? ''),
        previousPrice: String(position[9] ?? ''),
        priceDiffPct: String(position[10] ?? ''),
      })
    }
    return rows
  }

  function generateFundPositionCompareTable(positionMap: any, currentDate: string, previousDate: string) {
    emitFundPositionState({
      currentDateLabel: currentDate,
      previousDateLabel: previousDate,
      rows: mapFundPositionCompareRows(positionMap),
    })
  }

  function buildFundPositionTrendCodes(fundCode: string, positions: any[]): string[] {
    const codeNameMap = getCodeNameMap()
    const currentFundName = codeNameMap[fundCode] || fundCode
    codeNameMap[fundCode] = currentFundName
    const codes = [fundCode]
    for (let i = 0; i < positions.length && codes.length < 11; i += 1) {
      const position = positions[i]
      if (!Array.isArray(position) || position.length < 2) {
        continue
      }
      const stockCode = String(position[0] || '').trim()
      const stockName = String(position[1] || '').trim()
      if (!stockCode) {
        continue
      }
      codeNameMap[stockCode] = stockName || stockCode
      codes.push(stockCode)
    }
    return codes
  }

  function fundPositionSourceCode(period: { sourceCode?: string } | undefined, fallbackCode: string): string {
    const sourceCode = String(period?.sourceCode || '').trim()
    return sourceCode || fallbackCode
  }

  function fundPositionSourceLabel(period: { sourceCode?: string, sourceName?: string, sourceKind?: string } | undefined): string {
    if (!period || period.sourceKind !== 'target-etf') {
      return ''
    }
    const sourceCode = String(period.sourceCode || '').trim()
    const sourceName = String(period.sourceName || '').trim()
    const display = sourceName && sourceCode ? `${sourceName} (${sourceCode})` : sourceName || sourceCode
    return display ? `联接基金直投股票持仓为空，已展示目标ETF ${display} 的股票持仓。` : '联接基金直投股票持仓为空，已展示目标ETF股票持仓。'
  }

  function loadFundConstituents() {
    const code = getCode()
    emitFundPositionState({
      constituentStatus: '加载ETF成分股...',
      constituentLabel: '',
      constituentRows: [],
    })
    void context.fetchRequest({
      url: `${server}/api/fund/constituents`,
      params: { code },
      cacheKey: `${code}-fund-constituents`,
      cacheTtl: 360000,
    }).then((data: any) => {
      const rows = Array.isArray(data?.rows)
        ? data.rows.map((item: any) => ({
          rank: Number(item?.rank || 0),
          securityCode: String(item?.securityCode || ''),
          securityName: String(item?.securityName || ''),
          price: String(item?.price ?? '-'),
          quantity: String(item?.quantity ?? '-'),
          navPct: String(item?.navPct ?? '-'),
        }))
        : []
      const tradeDate = String(data?.tradeDate || '').trim()
      const navPerCreationUnit = String(data?.navPerCreationUnit || '').trim()
      const unitNav = String(data?.unitNav || '').trim()
      const priceSourceNote = String(data?.priceSourceNote || '').trim()
      const labelParts = []
      if (tradeDate) {
        labelParts.push(`清单日期 ${tradeDate}`)
      }
      if (navPerCreationUnit) {
        labelParts.push(`最小申赎单位净值 ${navPerCreationUnit}`)
      }
      if (unitNav) {
        labelParts.push(`基金份额净值 ${unitNav}`)
      }
      if (priceSourceNote) {
        labelParts.push(priceSourceNote)
      }
      emitFundPositionState({
        constituentStatus: rows.length ? `已加载 ${rows.length} 项ETF成分股` : '暂无ETF成分股数据',
        constituentLabel: labelParts.join('，'),
        constituentRows: rows,
      })
    }).catch(() => {
      emitFundPositionState({
        constituentStatus: 'ETF成分股加载失败',
        constituentLabel: '',
        constituentRows: [],
      })
    })
  }

  function refreshFundPositionTrendChart() {
    const code = getCode()
    const cache = getCache()
    const data = cache[`${code}-fp`] as Array<{ updateDate: string, data: any[] }> | undefined
    if (!data || data.length === 0) {
      return
    }
    let p1 = parseInt((document.getElementById('reportDate1') as HTMLSelectElement | null)?.value || '0')
    if (!Number.isFinite(p1) || p1 < 0 || p1 >= data.length) {
      p1 = 0
    }
    if (!data[p1] || !Array.isArray(data[p1].data)) {
      return
    }
    const sourceCode = fundPositionSourceCode(data[p1], code)
    const codes = buildFundPositionTrendCodes(sourceCode, data[p1].data)
    if (codes.length === 0) {
      return
    }
    setSelectedCodes(codes)
    const fq = (document.getElementById('klinePrice') as HTMLInputElement | null)?.value || ''
    fetchKlines(codes, fq, (loadedCodes) => {
      setKlineCodes(loadedCodes.map((item) => item + fq))
      loadedCodes.forEach((item) => {
        const codeNameMap = getCodeNameMap()
        if (!codeNameMap[item + fq]) {
          codeNameMap[item + fq] = codeNameMap[item] || item
        }
      })
      context.rerenderMyChart()
    })
  }

  function genFundPositionPie(code: string, index: number) {
    const data = getCache()[`${code}-fp`] as Array<{ updateDate: string, data: any[] }>
    if (!data || data.length === 0 || index >= data.length || !data[index] || !Array.isArray(data[index].data)) {
      return
    }
    const positions = data[index].data
    const pieData: any[] = []
    let others = 0
    for (const position of positions) {
      if (position[2] > 2) {
        pieData.push({ value: position[2], name: position[1] })
      } else {
        others += position[2]
      }
    }
    pieData.push({ value: others, name: '其他' })
    echartsPie(echarts, 'positionPie', '净值占比', '净值占比', pieData)
  }

  function fundPositionCompare() {
    const code = getCode()
    let p1 = parseInt((document.getElementById('reportDate1') as HTMLSelectElement).value)
    if (!p1) {
      p1 = 0
    }
    let p2 = parseInt((document.getElementById('reportDate2') as HTMLSelectElement).value)
    if (!p2) {
      p2 = 1
    }
    fetchFundPosition(code, 12, (resolvedCode: string) => {
      const data = getCache()[`${resolvedCode}-fp`] as Array<{ updateDate: string, data: any[] }>
      if (!data || data.length === 0) {
        emitFundPositionState({
          currentDateLabel: '',
          previousDateLabel: '',
          sourceLabel: '暂无基金股票持仓数据。',
          rows: [],
        })
        return
      }
      if (p1 >= data.length) {
        p1 = 0
      }
      if (p2 >= data.length) {
        p2 = data.length > 1 ? 1 : 0
      }
      genFundPositionPie(resolvedCode, p1)
      if (!(document.getElementById('reportDate1') as HTMLSelectElement).value) {
        const options: any[] = []
        for (let i = 0; i < data.length; i += 1) {
          options.push({ value: i, text: data[i].updateDate })
        }
        fillSelectOptions(options, p1, 'reportDate1')
        fillSelectOptions(options, p2, 'reportDate2')
      }
      if (!data[p1] || !Array.isArray(data[p1].data)) {
        emitFundPositionState({
          currentDateLabel: data[p1]?.updateDate || '',
          previousDateLabel: data[p2]?.updateDate || '',
          sourceLabel: fundPositionSourceLabel(data[p1]),
          rows: [],
        })
        return
      }
      if (!data[p2] || !Array.isArray(data[p2].data)) {
        data[p2] = { updateDate: data[p1].updateDate, data: [] }
      }
      refreshFundPositionTrendChart()
      const positionMap: any = {}
      const klineCodes: string[] = []
      for (const position of data[p1].data) {
        const stockCode = position[0]
        klineCodes.push(stockCode)
        positionMap[stockCode] = [position[0], position[1], position[2], 0, position[2], position[3], 0, '新进']
      }
      for (const position of data[p2].data) {
        const stockCode = position[0]
        if (!(stockCode in positionMap)) {
          klineCodes.push(stockCode)
          positionMap[stockCode] = [position[0], position[1], 0, 0, 0, 0]
        }
        positionMap[stockCode][3] = position[2]
        positionMap[stockCode][6] = position[3]
        positionMap[stockCode][4] = (positionMap[stockCode][2] - positionMap[stockCode][3]).toFixed(2)
        positionMap[stockCode][7] = positionMap[stockCode][5] === 0
          ? '退出'
          : ((positionMap[stockCode][5] - positionMap[stockCode][6]) * 100 / positionMap[stockCode][6]).toFixed(2)
      }
      for (const key in positionMap) {
        for (let i = positionMap[key].length; i < 8; i += 1) {
          positionMap[key][i] = '-'
        }
      }
      fetchKlines(klineCodes, '', (loadedCodes) => {
        for (const stockCode of loadedCodes) {
          let selectedOption = (document.getElementById('reportDate1') as HTMLSelectElement).options[(document.getElementById('reportDate1') as HTMLSelectElement).selectedIndex]
          const ts1 = toTimestamp(selectedOption.text)
          selectedOption = (document.getElementById('reportDate2') as HTMLSelectElement).options[(document.getElementById('reportDate2') as HTMLSelectElement).selectedIndex]
          const ts2 = toTimestamp(selectedOption.text)
          const cacheData = getCache()[stockCode] as number[][]
          if (!cacheData || cacheData.length === 0) {
            positionMap[stockCode][8] = '-'
            positionMap[stockCode][9] = '-'
            positionMap[stockCode][10] = '-'
            continue
          }
          let idx = findTsIndex(cacheData, ts1)
          if (idx >= cacheData.length) {
            idx = cacheData.length - 1
          }
          positionMap[stockCode][8] = cacheData[idx] ? cacheData[idx][1] : '-'
          idx = findTsIndex(cacheData, ts2)
          if (idx >= cacheData.length) {
            idx = cacheData.length - 1
          }
          positionMap[stockCode][9] = cacheData[idx] ? cacheData[idx][1] : '-'
          if (typeof positionMap[stockCode][8] === 'number' && typeof positionMap[stockCode][9] === 'number' && positionMap[stockCode][9] !== 0) {
            positionMap[stockCode][10] = (100 * positionMap[stockCode][8] / positionMap[stockCode][9] - 100).toFixed(2)
          } else {
            positionMap[stockCode][10] = '-'
          }
        }
        generateFundPositionCompareTable(positionMap, data[p1].updateDate, data[p2].updateDate)
        emitFundPositionState({
          sourceLabel: fundPositionSourceLabel(data[p1]),
        })
      })
    })
  }

  return function initFundPosition() {
    const code = getCode()
    if (!code) {
      console.log('initFundPosition,code === undefined')
      return
    }
    dateRangeInit()
    loadFundConstituents()
    fundPositionCompare()
    bsTable('fundShareChangeTable', {
      request: (_sortBy: string, _asc: boolean, _page: string): any => ({
        url: `${server}/api/fund/share-change`,
        params: { code },
      }),
      transResults: (data: any): any => {
        if (!data || !Array.isArray(data)) {
          console.error('[Fund Share Change] Invalid data:', data)
          return []
        }
        return data.map((item: any) => [item.date, item.purchase, item.redeem, item.totalShare, item.netAsset, item.shareChange, item.change])
      },
    })
    document.querySelectorAll("select[name='reportDate']").forEach((elem) => {
      elem.addEventListener('change', fundPositionCompare)
    })
    document.getElementById('klinePrice')!.addEventListener('change', refreshFundPositionTrendChart)
  }
}

export function createFundInitializer(context: FundPagesRuntimeContext) {
  const {
    emitFundState,
    dateRangeInit,
    fetchFundInfo,
    renderFundInfoTable,
    klinePriceChange,
    positionCheckOnChange,
    getCode,
  } = context

  return function initFund() {
    const code = getCode()
    if (code === undefined) {
      console.log('initFund,code === undefined')
      return
    }
    emitFundState({ status: '加载基金信息...' })
    dateRangeInit()
    fetchFundInfo(code, renderFundInfoTable)
    document.getElementById('klinePrice')!.addEventListener('change', klinePriceChange)
    klinePriceChange()
    document.getElementById('positionCheck')!.addEventListener('change', positionCheckOnChange)
  }
}

export function createIndexPositionInitializer(context: FundPagesRuntimeContext) {
  const {
    server,
    echarts,
    fetchRequest,
    fetchCodesData,
    fetchCompanyInfo,
    bsTable,
    genFullCode,
    getCache,
    getCodeNameMap,
  } = context

  function emitIndexPositionState(patch: any): boolean {
    const snapshotHost = window as typeof window & { __licaiIndexPositionState?: Record<string, unknown> }
    snapshotHost.__licaiIndexPositionState = {
      ...(snapshotHost.__licaiIndexPositionState || {}),
      ...(patch || {}),
    }
    window.dispatchEvent(new CustomEvent('licai:index-position-state', { detail: patch || {} }))
    return true
  }

  function buildEmptyIndexPositionTableState(): any {
    return {
      columns: [
        { key: 'code', label: '成分股代码' },
        { key: 'name', label: '股票简称' },
        { key: 'currentWeight', label: '新调仓权重(%)', sortable: true },
        { key: 'previousWeight', label: '老调仓权重(%)', sortable: true },
        { key: 'weightDelta', label: '权重变化(%)', sortable: true },
      ],
      rows: [],
    }
  }

  function buildIndexPositionDateOptions(dates: number[]): any[] {
    return dates.map((date) => ({ label: date2String(date), value: String(date) }))
  }

  function renderIndexPositionDateState(dates: number[]): void {
    if (dates.length === 0) {
      emitIndexPositionState({
        dateOptions: [],
        selectedDate1: '',
        selectedDate2: '',
        table: buildEmptyIndexPositionTableState(),
        status: '暂无调仓数据',
      })
      return
    }
    const selectedDate1 = dates.length > 0 ? String(dates[0]) : ''
    const selectedDate2 = dates.length > 1 ? String(dates[1]) : selectedDate1
    emitIndexPositionState({
      dateOptions: buildIndexPositionDateOptions(dates),
      selectedDate1,
      selectedDate2,
      status: '',
    })
  }

  function fetchIndexPositionDates(code: string, callback: (code: string, dates: number[]) => void) {
    void fetchRequest({ url: `${server}/api/index/positionDates?code=${code}` }).then((data: any) => {
      callback(code, data)
    })
  }

  function fetchIndexPosition(code: string, date: number, callback: (code: string, date: number) => void) {
    void fetchRequest({
      url: `${server}/api/index/position?code=${code}&date=${date}`,
      cacheKey: `${code}-ip-${date}`,
      cacheTtl: 360000,
    }).then(() => {
      callback(code, date)
    })
  }

  function fetchIndexPositions(code: string, dates: number[], callback: (error: Error | null, code: string, dates: number[]) => void) {
    const should = dates.length
    let done = 0
    const success = () => {
      done += 1
      if (done === should) {
        callback(null, code, dates)
      }
    }
    for (const date of dates) {
      fetchIndexPosition(code, date, success)
    }
  }

  function buildIndexPositionTableState(positionMap: any, currentDate: number, previousDate: number): any {
    return {
      columns: [
        { key: 'code', label: '成分股代码' },
        { key: 'name', label: '股票简称' },
        { key: 'currentWeight', label: `${date2String(currentDate)}权重(%)`, sortable: true },
        { key: 'previousWeight', label: `${date2String(previousDate)}权重(%)`, sortable: true },
        { key: 'weightDelta', label: '权重变化(%)', sortable: true },
      ],
      rows: Object.keys(positionMap).map((key) => {
        const row = positionMap[key]
        const deltaValue = String(row[4] ?? '')
        let deltaClass = ''
        if (deltaValue !== '新增' && deltaValue !== '剔除') {
          const numeric = Number(deltaValue)
          if (numeric > 0) {
            deltaClass = 'text-danger'
          } else if (numeric < 0) {
            deltaClass = 'text-primary'
          }
        }
        return {
          rowKey: String(row[0] || key),
          cells: [
            { href: `company.html?code=${encodeURIComponent(String(row[0] || ''))}`, target: '_blank', text: String(row[0] || '') },
            { text: String(row[1] || '') },
            { text: String(row[2] ?? '') },
            { text: String(row[3] ?? '') },
            { className: deltaClass, text: deltaValue },
          ],
        }
      }),
    }
  }

  function generateIndexPositionCompareTable(positionMap: any, currentDate: number, previousDate: number) {
    emitIndexPositionState({
      selectedDate1: String(currentDate || ''),
      selectedDate2: String(previousDate || ''),
      table: buildIndexPositionTableState(positionMap, currentDate, previousDate),
    })
  }

  function genIndexPositionPie(code: string, positions: any[]) {
    const pie: any[] = []
    let other = 100
    const codes: string[] = []
    const percentMap: any = {}
    for (const position of positions) {
      const companyCode = genFullCode(position.code)
      codes.push(companyCode)
      percentMap[companyCode] = position.weight
      pie.push({ name: position.name, value: position.weight })
      other -= position.weight
    }
    pie.push({ name: '其它', value: other.toFixed(2) })
    pie.sort((a, b) => b.value - a.value)
    echartsPie(echarts, 'positionPie', `${getCodeNameMap()[code]}(${code})`, '占比', pie)

    fetchCodesData(codes, (stockCode: string, succ: (data: unknown) => void) => {
      fetchCompanyInfo(stockCode, succ)
    }, (loadedCodes: string[]) => {
      const catPercentMap: any = {}
      for (const stockCode of loadedCodes) {
        const companyInfo = getCache()[`${stockCode}-ci`] as { industry?: string }
        const industry = companyInfo?.industry ? companyInfo.industry.split('-')[0] : '未知'
        catPercentMap[industry] = (catPercentMap[industry] || 0) + percentMap[stockCode]
      }
      const industryPie: any[] = []
      let remaining = 100
      for (const cat in catPercentMap) {
        industryPie.push({ name: cat, value: catPercentMap[cat].toFixed(2) })
        remaining -= catPercentMap[cat]
      }
      industryPie.push({ name: '其它', value: remaining.toFixed(2) })
      industryPie.sort((a, b) => b.value - a.value)
      echartsPie(echarts, 'positionIndustryPie', '行业持仓占比', '占比', industryPie)
    })
  }

  function indexPositionCompare(code: string) {
    if (code === undefined) {
      console.log('indexPositionCompare,code === undefined')
      return
    }
    const reportDate1Elem = document.getElementById('reportDate1') as HTMLSelectElement | null
    const reportDate2Elem = document.getElementById('reportDate2') as HTMLSelectElement | null
    const date1 = reportDate1Elem ? parseInt(reportDate1Elem.value) : 0
    const date2 = reportDate2Elem ? parseInt(reportDate2Elem.value) : 0
    if (!date1 || !date2) {
      emitIndexPositionState({
        table: buildEmptyIndexPositionTableState(),
        status: '暂无调仓数据',
      })
      return
    }
    fetchIndexPositions(code, [date1, date2], () => {
      const positionMap: any = {}
      let cacheKey = `${code}-ip-${date1}`
      const positions = getCache()[cacheKey] as any[]
      genIndexPositionPie(code, positions)
      for (const position of positions) {
        positionMap[position.code] = [position.code, position.name, position.weight, 0, '新增']
      }
      cacheKey = `${code}-ip-${date2}`
      const positions2 = getCache()[cacheKey] as any[]
      for (const position of positions2) {
        if (position.code in positionMap) {
          positionMap[position.code][3] = position.weight
          positionMap[position.code][4] = (positionMap[position.code][2] - positionMap[position.code][3]).toFixed(2)
        } else {
          positionMap[position.code] = [position.code, position.name, 0, position.weight, '剔除']
        }
      }
      generateIndexPositionCompareTable(positionMap, date1, date2)
      emitIndexPositionState({ status: '' })
    })
  }

  return function initIndexPosition() {
    const code = new URLSearchParams(window.location.search).get('code') || ''
    fetchIndexPositionDates(code, (resolvedCode, dates) => {
      renderIndexPositionDateState(dates)
      if (dates.length === 0) {
        return
      }
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          indexPositionCompare(resolvedCode)
        })
      })
    })
    document.getElementById('reportDate1')?.addEventListener('change', () => {
      indexPositionCompare(code)
    })
    document.getElementById('reportDate2')?.addEventListener('change', () => {
      indexPositionCompare(code)
    })
  }
}
