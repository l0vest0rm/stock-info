type ThirteenFPositionFetchRequest = (request: {
  url?: string
  params?: Record<string, unknown>
  data?: unknown
  cacheKey?: string
  cacheTtl?: number
}) => Promise<unknown>

type ThirteenFPositionRuntimeContext = {
  server: string
  fetchRequest: ThirteenFPositionFetchRequest
  fetchKline: (code: string, fq: string) => Promise<any>
  fetchCodeNames: (codes: string[], callback: () => void) => void
  bsTable: (tableId: string, config: any) => void
  genSimpleBarLineChart: (id: string, codes: string[], data: any, yKeys: string[], yKeyNames: string[], xKey: string, yUnit: string, seasons: number) => void
  getCodeNameMap: () => Record<string, string>
  echarts: {
    init: (dom: HTMLElement) => { setOption: (option: any) => void, resize: () => void }
  }
}

export function createThirteenFPositionInitializer(context: ThirteenFPositionRuntimeContext) {
  const { server, fetchRequest, fetchKline, fetchCodeNames, bsTable, genSimpleBarLineChart, echarts } = context

  function emitThirteenFPositionState(patch: any): void {
    window.dispatchEvent(new CustomEvent('licai:13f-position-state', { detail: patch || {} }))
  }

  function setThirteenFPositionStatus(message: string): void {
    emitThirteenFPositionState({ status: message })
  }

  function getThirteenFPositionSelectedText(select: HTMLSelectElement | null): string {
    if (!select) {
      return ''
    }
    return select.options[select.selectedIndex]?.textContent || ''
  }

  function managementTrend(name: string, items: any) {
    const seasons = items.length
    const xKey = 'reportDate'
    const yKey = 'value'
    const yUnit = '(亿元)'
    const code = 'code'
    const yKeys = [yKey]
    const data: any = {}
    data[code] = []
    for (let i = items.length - 1; i >= 0; i--) {
      data[code][items.length - 1 - i] = {}
      data[code][items.length - 1 - i][xKey] = items[i][0]
      const value = items[i][2] ? items[i][2].replace(/,/g, '') : '0'
      data[code][items.length - 1 - i][yKey] = (parseInt(value, 10) / 1e5).toFixed(2)
    }
    genSimpleBarLineChart('managementTrendChart', [code], data, yKeys, ['资产价值'], xKey, yUnit, seasons)
  }

  function gen13fKey(item: any) {
    const codeNameMap = context.getCodeNameMap()
    let key = item[1]
    if (codeNameMap[item[0]]) {
      key = codeNameMap[item[0]]
    }
    if (item[8]) {
      key += '-' + item[8]
    }
    return key
  }

  function fetch13fPosition(filingId: string, callback: (data: any) => void) {
    void fetchRequest({
      url: `${server}/api/13f/position/${filingId}`,
      cacheKey: `13f-${filingId}`,
      cacheTtl: 360000,
    }).then((data: any) => {
      callback(data)
    })
  }

  function position13fCompare(data1: any, data2: any) {
    let key = ''
    const positionMap: any = {}
    const codeNameMap = context.getCodeNameMap()

    for (const item of data2) {
      key = gen13fKey(item)
      positionMap[key] = [0, item[0], key]
      positionMap[key][3] = 0
      positionMap[key][4] = item[5]
      positionMap[key][6] = 0
      positionMap[key][7] = item[4]
      positionMap[key][10] = 0
      positionMap[key][11] = item[6]
    }

    for (const item of data1) {
      key = gen13fKey(item)
      if (!positionMap[key]) {
        positionMap[key] = [0, item[0], key]
        positionMap[key][4] = 0
        positionMap[key][7] = 0
        positionMap[key][11] = 0
      }
      positionMap[key][3] = item[5]
      positionMap[key][6] = item[4]
      positionMap[key][10] = item[6]
    }

    let idx = 0
    const rows: any[] = []
    const missingCodes: string[] = []
    for (const name in positionMap) {
      idx += 1
      const item = positionMap[name]
      if (item[1] && codeNameMap[item[1]] === undefined) {
        missingCodes.push(item[1])
      }
      item[0] = idx
      for (const i of [3, 6, 10]) {
        if (i !== 3) {
          item[i + 2] = i === 6 ? (item[i + 1] - item[i]).toFixed(1) : item[i + 1] - item[i]
          if (item[i + 1] === 0) {
            item[i + 3] = '清仓'
          } else if (item[i] === 0) {
            item[i + 3] = '新增'
          } else {
            item[i + 3] = (100 * item[i + 1] / item[i] - 100).toFixed(2)
          }
        } else {
          item[i + 2] = (item[i + 1] - item[i]).toFixed(2)
        }
      }

      rows.push({
        rank: idx,
        code: item[1],
        modalKey: name,
        name,
        positionPctOld: String(item[3]),
        positionPctNew: String(item[4]),
        positionPctDiff: String(item[5]),
        valueOld: String(item[6]),
        valueNew: String(item[7]),
        valueDiff: String(item[8]),
        valueDiffPct: String(item[9]),
        sharesOld: String(item[10]),
        sharesNew: String(item[11]),
        sharesDiff: String(item[12]),
        sharesDiffPct: String(item[13]),
      })
    }

    emitThirteenFPositionState({
      rows,
      status: `已对比 ${rows.length} 项持仓`,
    })

    const dedupedCodes = missingCodes.filter((item, pos) => missingCodes.indexOf(item) === pos)
    while (dedupedCodes.length > 0) {
      const cut = dedupedCodes.splice(0, 100)
      fetchCodeNames(cut, () => {})
    }
  }

  function fetchAndCompare13f() {
    const e1 = document.getElementById('reportDate1') as HTMLSelectElement | null
    const e2 = document.getElementById('reportDate2') as HTMLSelectElement | null
    setThirteenFPositionStatus('对比中...')

    emitThirteenFPositionState({
      selectedReportDate1: e1?.value || '',
      selectedReportDate2: e2?.value || '',
      date1Label: getThirteenFPositionSelectedText(e1),
      date2Label: getThirteenFPositionSelectedText(e2),
    })

    let data1: any
    let data2: any
    const success = () => {
      if (!data1 || !data2) {
        return
      }
      position13fCompare(data1, data2)
    }

    if (e1) {
      fetch13fPosition(e1.value, (data: any) => {
        data1 = data
        success()
      })
    }
    if (e2) {
      fetch13fPosition(e2.value, (data: any) => {
        data2 = data
        success()
      })
    }
  }

  function quarter2ts(str: string) {
    const quarter = str.substring(str.length - 2)
    let suffix = ''
    switch (quarter) {
      case 'Q1':
        suffix = '03-31'
        break
      case 'Q2':
        suffix = '06-30'
        break
      case 'Q3':
        suffix = '09-30'
        break
      case 'Q4':
        suffix = '12-31'
        break
      default:
        console.log('quarter2ts wrong quarter', quarter)
        return undefined
    }
    return new Date(`${str.substring(0, str.length - 2)}-${suffix}`).getTime()
  }

  function componentKlineChart(code: string, klineData: any, positionData: any) {
    const codeNameMap = context.getCodeNameMap()
    const legendData = [`${codeNameMap[code]}-股价`, `${codeNameMap[code]}-持仓量`]
    const seriesData: any = [[], []]
    for (const item of positionData) {
      seriesData[1].push([quarter2ts(item[0]), item[1]])
    }

    const startTs = new Date(new Date().getFullYear() - 3, 0, 1).getTime() + 3600 * 1000 * 8
    for (const item of klineData) {
      if (item[0] < startTs) {
        continue
      }
      seriesData[0].push([item[0], item[1]])
    }

    const myChart = echarts.init(document.getElementById('financeChart') as HTMLElement)
    myChart.setOption({
      tooltip: {
        trigger: 'axis',
        axisPointer: {
          type: 'cross',
          label: {
            backgroundColor: '#6a7985',
          },
        },
      },
      legend: {
        data: legendData,
      },
      grid: {
        left: '3%',
        right: '4%',
        bottom: '3%',
        containLabel: true,
      },
      xAxis: {
        type: 'time',
        boundaryGap: false,
      },
      yAxis: [
        {
          type: 'value',
          scale: true,
          position: 'right',
          axisLabel: { formatter: '{value}' },
        },
        {
          type: 'value',
          scale: true,
          position: 'left',
          axisLabel: { formatter: '{value}' },
          splitLine: { show: false },
        },
      ],
      series: legendData.map((item, index) => ({
        name: item,
        type: 'line',
        yAxisIndex: index,
        showSymbol: index > 0,
        emphasis: { scale: false },
        data: seriesData[index],
      })),
    })
    window.addEventListener('resize', () => {
      myChart.resize()
    })
  }

  async function componentChanageAndKlineChart(code: string, positionData: any) {
    const data = await fetchKline(code, '')
    componentKlineChart(code, data, positionData.reverse())
  }

  function componentChangeModalShow(event: any) {
    const key = event.relatedTarget.dataset.key
    const singleChart = document.getElementById('singleChart')
    if (singleChart) {
      singleChart.innerHTML = `<div id="financeChart" style="min-height: 600px; min-width: 300px;"></div>
  <table id="componentChangeTable" class="table table-bordered table-hover text-end">
    <thead class="table-success theadFix">
      <tr>
        <th class="sortable">持仓代码</th>
        <th class="sortable">持仓名称</th>
        <th class="sortable">季度</th>
        <th class="sortable">持仓占比%</th>
        <th class="sortable">价值(千)</th>
        <th class="sortable">价值变化%</th>
        <th class="sortable">股数</th>
        <th class="sortable">股数变化%</th>
      </tr>
    </thead>
  </table>`
    }

    const dates: string[][] = []
    document.getElementById('reportDate1')?.querySelectorAll('option').forEach((elem: any) => {
      dates.push([elem.value, elem.textContent])
    })
    const latestDates = dates.slice(0, 10)
    const should = latestDates.length
    let done = 0
    const dataMap: any = {}
    let code = ''

    const success = async () => {
      done += 1
      if (done !== should) {
        return
      }
      const rows: any = []
      const positionData: any = []
      for (const date of latestDates) {
        for (const item of dataMap[date[1]]) {
          const name = gen13fKey(item)
          if (name !== key) {
            continue
          }
          if (!code) {
            code = item[0]
          }
          rows.push([item[0], name, date[1], item[5], item[4], 0, item[6], 0])
          positionData.push([date[1], item[6], item[4]])
        }
      }

      for (let i = 0; i < rows.length - 1; i++) {
        rows[i][5] = (100 * rows[i][4] / rows[i + 1][4] - 100).toFixed(2)
        rows[i][7] = (100 * rows[i][6] / rows[i + 1][6] - 100).toFixed(2)
      }

      await componentChanageAndKlineChart(code, positionData)
      bsTable('componentChangeTable', {
        data: rows,
        cell(cell, columnIdx) {
          let clss = ''
          if ([5, 7].includes(columnIdx)) {
            if (cell > 0) {
              clss = 'text-danger'
            } else if (cell < 0) {
              clss = 'text-success'
            }
          }
          return {
            cell,
            class: clss,
          }
        },
      })
    }

    for (const date of latestDates) {
      fetch13fPosition(date[0], (data: any) => {
        dataMap[date[1]] = data
        void success()
      })
    }
  }

  return function init13fPosition() {
    const params = new URLSearchParams(window.location.search)
    const id = params.get('id') || ''
    const companyName = params.get('name') || '资管公司13f持仓比较'

    emitThirteenFPositionState({
      companyName,
      status: '加载季度数据...',
    })
    document.querySelectorAll('[name="company13f"]').forEach((elem: any) => {
      elem.textContent = companyName
    })

    void fetchRequest({
      url: `${server}/api/13f/quarters/${id}`,
      cacheKey: `13f-${id}`,
      cacheTtl: 3600,
    }).then((data: any) => {
      managementTrend(companyName, data)
      const options = data.map((item: any) => ({
        value: String(item[6]),
        text: String(item[0]),
      }))
      emitThirteenFPositionState({
        reportDateOptions: options,
        selectedReportDate1: String(data[1]?.[6] || ''),
        selectedReportDate2: String(data[0]?.[6] || ''),
        date1Label: String(data[1]?.[0] || ''),
        date2Label: String(data[0]?.[0] || ''),
        status: '季度已加载，开始对比...',
      })

      const startCompare = () => {
        document.getElementById('reportDate1')?.addEventListener('change', fetchAndCompare13f)
        document.getElementById('reportDate2')?.addEventListener('change', fetchAndCompare13f)
        fetchAndCompare13f()
      }
      requestAnimationFrame(startCompare)
      document.getElementById('componentChangeModal')?.addEventListener('shown.bs.modal', componentChangeModalShow)
    })
  }
}
