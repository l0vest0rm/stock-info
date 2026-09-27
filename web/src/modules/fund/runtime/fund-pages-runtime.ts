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
  getCode: () => string
  getCache: () => Record<string, unknown>
  getCodeNameMap: () => Record<string, string>
  getSelectedCodes: () => string[]
  setSelectedCodes: (codes: string[]) => void
  setKlineCodes: (codes: string[]) => void
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

  function loadFundAssetAllocation() {
    const code = getCode()
    emitFundPositionState({ allocationStatus: '加载资产配置...', allocationSummary: '', allocationRows: [] })
    void context.fetchRequest({
      url: `${server}/api/fund/asset-allocation`,
      params: { code },
      cacheKey: `${code}-fund-asset-allocation`,
      cacheTtl: 360000,
    }).then((data: any) => {
      const rows = Array.isArray(data?.rows) ? data.rows : []
      const latest = rows[0]
      const previous = rows[1]
      const summaryParts: string[] = []
      if (latest) {
        summaryParts.push(`截至 ${latest.reportDate}`)
        if (latest.netAssetsBillion != null) summaryParts.push(`净资产 ${Number(latest.netAssetsBillion).toFixed(2)} 亿元`)
        if (previous && latest.netAssetsBillion != null && previous.netAssetsBillion) {
          const change = (Number(latest.netAssetsBillion) / Number(previous.netAssetsBillion) - 1) * 100
          summaryParts.push(`较上期${change >= 0 ? '增加' : '减少'} ${Math.abs(change).toFixed(2)}%`)
        }
        if (latest.stockPct != null && previous?.stockPct != null) {
          const change = Number(latest.stockPct) - Number(previous.stockPct)
          summaryParts.push(`股票配置较上期${change >= 0 ? '增加' : '减少'} ${Math.abs(change).toFixed(2)} 个百分点`)
        }
      }
      emitFundPositionState({
        allocationStatus: rows.length ? `共 ${rows.length} 期定期报告` : '暂无资产配置数据',
        allocationSummary: summaryParts.join('，'),
        allocationRows: rows,
      })
      renderFundAssetAllocationChart(rows)
    }).catch(() => {
      emitFundPositionState({ allocationStatus: '资产配置加载失败', allocationSummary: '', allocationRows: [] })
    })
  }

  function renderFundAssetAllocationChart(rows: any[]) {
    const chartDom = document.getElementById('assetAllocationChart')
    if (!chartDom || !Array.isArray(rows) || rows.length === 0) return
    const periods = rows.slice(0, 5).reverse()
    const chart = echarts.getInstanceByDom(chartDom) || echarts.init(chartDom)
    chart.setOption({
      tooltip: { trigger: 'axis' },
      legend: { data: ['股票占比', '债券占比', '现金占比', '净资产'] },
      grid: { left: 60, right: 70, bottom: 45 },
      xAxis: { type: 'category', data: periods.map((row: any) => row.reportDate) },
      yAxis: [
        { type: 'value', name: '占净比', min: 0, axisLabel: { formatter: '{value}%' } },
        { type: 'value', name: '净资产（亿元）', min: 0 },
      ],
      series: [
        { name: '股票占比', type: 'bar', data: periods.map((row: any) => row.stockPct), itemStyle: { color: '#5470c6' } },
        { name: '债券占比', type: 'bar', data: periods.map((row: any) => row.bondPct), itemStyle: { color: '#91cc75' } },
        { name: '现金占比', type: 'bar', data: periods.map((row: any) => row.cashPct), itemStyle: { color: '#fac858' } },
        { name: '净资产', type: 'line', yAxisIndex: 1, data: periods.map((row: any) => row.netAssetsBillion), itemStyle: { color: '#ee6666' } },
      ],
    })
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
    const data = cache[`${code}-fp`] as Array<{ updateDate: string, data: any[], sourceCode?: string, sourceName?: string, sourceKind?: string }> | undefined
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
    const data = getCache()[`${code}-fp`] as Array<{ updateDate: string, data: any[], sourceCode?: string, sourceName?: string, sourceKind?: string }>
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
      const data = getCache()[`${resolvedCode}-fp`] as Array<{ updateDate: string, data: any[], sourceCode?: string, sourceName?: string, sourceKind?: string }>
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
    loadFundAssetAllocation()
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
    ;['dateRange-start', 'dateRange-end'].forEach((id) => {
      document.getElementById(id)?.addEventListener('change', () => {
        delete context.getCache()[`${code}${(document.getElementById('klinePrice') as HTMLInputElement).value}`]
        klinePriceChange()
      })
    })
    klinePriceChange()
    document.getElementById('positionCheck')!.addEventListener('change', positionCheckOnChange)
  }
}
