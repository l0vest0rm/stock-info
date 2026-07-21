import {
  usCodeMap,
  coreKeys,
  incomeKeys,
  balanceKeys,
  cashflowKeys,
  isAstockCompany,
  isHkCompany,
  genReportDates
} from '../../finance-constants'
import { convertResponse, parseResponseData } from '../../api'
import { createBsTable } from '../../bs-table'
import { createCompanyTableRuntime } from '../../modules/company/runtime/company-table-runtime'
import { findInsertIndex, findTsIndex } from '../../chart'
import { toDateString, toTimeString, toTimestamp, zeroPad } from '../../date'
import { createDateRangeHelpers } from '../../date-range-ui'
import { escapeHtml, formatReportNumber, hash, queryString } from '../../format'
import { createLegacyControls } from './legacy-controls'
import { createLegacyDataServices } from './legacy-data-services'
import { loadLegacyPageInitializer } from './legacy-page-registry'
import { createLegacyRuntimeState, replaceArrayItems, replaceRecordItems } from './legacy-runtime-state'

// Declare echarts as global since it's loaded separately in HTML
declare const echarts: any

const server = ''
const reportAnalysisCacheVersion = 'v3'

const days: number[] = [7, 30, 60, 90, 180, 360]; // 计算最近表现

//echarts颜色大全，用于线条、柱状图等
//https://www.cnblogs.com/wuhairui/p/15561755.html
const echartsColor = ['#5470c6', '#73c0de', '#fac858', '#3ba272', '#fc8452', '#9a60b4', '#ea7ccc', '#000000', '#ee6666', '#FF3EFF']

//缓存
const runtimeState = createLegacyRuntimeState()
const cache = runtimeState.cache
//k线
const klineCodes = runtimeState.klineCodes

//选中的股票/基金代码s
const selectedCodes = runtimeState.selectedCodes
const markPoints = runtimeState.markPoints
const codeNameMap = runtimeState.codeNameMap
const securities = runtimeState.securities

function getCurrentCode(): string {
  return runtimeState.code
}

function setCurrentCode(nextCode: string): void {
  runtimeState.code = nextCode
}

const query: any = parseQuery(window.location.search)

const bsTable = createBsTable(fetchRequest)
const {
  changeDateRangeStart,
  dateRangeInit,
} = createDateRangeHelpers({
  getUrlParam,
  replaceUrlParam,
  renderLineChart,
  toDateString,
})
const {
  emitCompanyPageState,
  emitStockTableState,
  genratePerformanceTable,
  genrateRegressTable,
  generateMarketDataMap,
  generateMarketTable,
} = createCompanyTableRuntime({
  cache: cache as Record<string, unknown>,
  codeNameMap,
  days,
  selectedCodes,
})

function selectedOptionValues(element: Element | null): string[] {
  if (!element) {
    return []
  }
  const arr: string[] = []
  element.querySelectorAll('option').forEach((option) => {
    if (option.hasAttribute('selected')) {
      arr.push(option.value)
    }
  })
  return arr.filter((item, pos) => arr.indexOf(item) === pos)
}

//获取当前页面名字，比如company.html
function currentPage(): string {
  const arr = window.location.pathname.split('/')
  return arr[arr.length-1]
}

//替换url参数
export function replaceUrlParam(key: string, value: string): void {
  const url = new URL(window.location.href)
  url.searchParams.set(key, value)
  window.history.replaceState(null, '', url.toString()) // or pushState
}

interface FetchRequestOptions {
  url?: string
  cacheKey?: string
  cacheTtl?: number
  relay?: boolean
  silent?: boolean
  params?: Record<string, unknown>
  data?: unknown
  headers?: Record<string, string>
  accept?: string
}

export function fetchRequest(request: string | FetchRequestOptions): Promise<unknown> {
  return new Promise((resolve) => {
    const cacheKey = typeof request === 'object' ? request.cacheKey : undefined
    
    const handleResult = (data: unknown) => {
      if (cacheKey) {
        cache[cacheKey] = data
      }
      resolve(data)
    }
    
    if (cacheKey) {
      if (cache[cacheKey] !== undefined) {
        handleResult(cache[cacheKey])
        return
      }
    }

    const { url, config } = buildFetchConfig(request)
    
    if (!url) {
      handleResult(request)
      return
    }

    executeFetch(url, config, request, handleResult)
  })
}

function buildFetchConfig(request: string | FetchRequestOptions): { url: string; config: RequestInit } {
  let url = ''
  const config: RequestInit = { headers: {} }

  if (typeof request === 'string') {
    url = request
    config.method = 'GET'
    config.headers = {
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  } else if (request.params) {
    url = request.url + '?' + queryString(request.params)
    config.method = 'GET'
    config.headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...request.headers
    }
  } else if (request.data) {
    url = request.url || ''
    config.method = 'POST'
    config.body = JSON.stringify(request.data)
    config.headers = {
      'Content-Type': 'application/json',
      ...request.headers
    }
  } else if (request.url) {
    url = request.url
    config.method = 'GET'
    config.headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...request.headers
    }
  }

  return { url, config }
}

function executeFetch(url: string, config: RequestInit, request: string | FetchRequestOptions, callback: (data: unknown) => void): void {
  const accept = typeof request === 'object' ? request.accept || '' : ''
  const silent = typeof request === 'object' ? Boolean(request.silent) : false

  fetch(url, config)
    .then(resp => convertResponse(resp, accept))
    .then((resp: unknown) => {
      handleResponse(url, resp, accept, callback, silent)
    })
    .catch((error: Error) => {
      console.error('fetchRequest,fetch Failed', error)
      callback({ error: error.message })
    })
}

function handleResponse(url: string, resp: unknown, accept: string, callback: (data: unknown) => void, silent: boolean): void {
  handleServerResponse(resp, callback, silent)
}

function handleServerResponse(resp: unknown, callback: (data: unknown) => void, silent: boolean): void {
  const serverResp = resp as { code?: number; data?: unknown; msg?: string }
  switch (serverResp.code) {
    case 200:
      callback(parseResponseData(serverResp.data, ''))
      return
    case 401:
      window.location.href = `login.html?url=${encodeURIComponent(window.location.href)}`
      return
    case 403:
      alert('<a href="account.html" target="_blank">权限不够，点击去购买</a>')
      return
    case 402:
      alert('<a href="recharge.html" target="_blank">账户余额不足，点击去充值</a>')
      return
    default:
      if (silent) {
        console.warn('fetchRequest server error', serverResp)
        callback({ error: serverResp.msg || 'request failed', code: serverResp.code })
        return
      }
      alert(`${serverResp.code || ''} ${serverResp.msg || ''}`)
      return
  }
}


function parseQuery(queryString: string): Record<string, string> {
  const query: Record<string, string> = {}
  const pairs = (queryString[0] === '?' ? queryString.substring(1) : queryString).split('&')
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i].split('=')
    query[decodeURIComponent(pair[0])] = decodeURIComponent(pair[1] || '')
  }
  return query
}

function alert(message: string, type: string = 'warning'): void {
  const html = `<div class="alert alert-${type} alert-dismissible" role="alert">
     <div class="text-center">${message}</div>
     <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
  </div>`

  const alertElement = document.getElementById('alert')
  if (alertElement) {
    alertElement.innerHTML = html
  }
}

export function genFullCode(code: string): string {
  code = code.toUpperCase()
  if (code.indexOf('.') > 0) {
    if (code.endsWith('.HK')) {
      return code.padStart(8, '0')
    } else {
      return code
    }
  }
  //没有后缀的情况
  if (code.length < 6) {
    return code + '.HK'
  } else if (code.startsWith('0') || code.startsWith('1') || code.startsWith('3')) {
    return code + '.SZ'
  } else if (code.startsWith('8')) {
    return code + '.BJ'
  } else {
    return code + '.SH'
  }
}



function alignKlines(kline1: number[][], kline2: number[][], startTs: number, endTs: number): [number[][], number[][]] {
  const endIdx1 = findTsIndex(kline1, endTs)
  const endIdx2 = findTsIndex(kline2, endTs)
  let idx1 = findTsIndex(kline1, startTs)
  if (idx1 < 0) {
    idx1 = 0
    startTs = kline1[0][0]
  }
  let idx2 = findTsIndex(kline2, startTs)

  if (idx2 < 0) {
    idx2 = 0
    startTs = kline2[0][0]
    idx1 = findTsIndex(kline1, startTs)
  }

  if (idx1 < 0 || idx2 < 0) {
    throw new Error('startTs can not found in kline')
  }
  const ak1: number[][] = []
  const ak2: number[][] = []
  let ts = 0
  while (idx1 <= endIdx1 || idx2 <= endIdx2) {
    if (idx1 <= endIdx1 && idx2 <= endIdx2) {
      if (kline1[idx1][0] < kline2[idx2][0]) {
        ts = kline1[idx1][0]
        ak1.push([ts, kline1[idx1][1]])
        const k = idx2 - 1 < 0 ? 0: idx2 - 1
        ak2.push([ts, kline2[k][1]])
        idx1++
      } else if (kline1[idx1][0] > kline2[idx2][0]) {
        ts = kline2[idx2][0]
        const k = idx1 - 1 < 0 ? 0: idx1 - 1
        ak1.push([ts, kline1[k][1]])
        ak2.push([ts, kline2[idx2][1]])
        idx2++
      } else {
        ts = kline2[idx2][0]
        ak1.push([ts, kline1[idx1][1]])
        ak2.push([ts, kline2[idx2][1]])
        idx1++
        idx2++
      }
    } else if (idx1 <= endIdx1) {
      ts = kline1[idx1][0]
      ak1.push([ts, kline1[idx1][1]])
      ak2.push([ts, kline2[idx2 - 1][1]])
      idx1++
    } else if (idx2 <= endIdx2) {
      ts = kline2[idx2][0]
      ak1.push([ts, kline1[idx1 - 1][1]])
      ak2.push([ts, kline2[idx2][1]])
      idx2++
    }
  }
  return [ak1, ak2]
}

function average(kline: number[][]): number {
  let sum = 0.0
  for (let i = 0; i < kline.length; i++) {
    sum += kline[i][1]
  }
  return sum / kline.length
}
/**
 * 协方差
 * @param kline1 序列1
 * @param kline2 序列2
 */
function covariance(kline1: number[][], kline2: number[][]): number {
  // cov(A,B) = E(A*B) - avgA*avgB
  if (kline1.length !== kline2.length) {
    throw new Error(`kline1.length !== kline2.length,${kline1.length},${kline2.length}`)
  }
  const avg1 = average(kline1)
  const avg2 = average(kline2)
  let sum = 0
  for (let i = 0; i < kline1.length; i++) {
    sum += (kline1[i][1] - avg1) * (kline2[i][1] - avg2)
  }
  return sum / kline1.length
}

/**
 * 方差
 * @param kline 序列
 */
function variance(kline: number[][]): number {
  const epn = average(kline)
  let sum = 0
  for (let i = 0; i < kline.length; i++) {
    sum += (kline[i][1] - epn) * (kline[i][1] - epn)
  }
  return sum / kline.length
}
/**
 * 标准差
 * @param kline 序列
 */
function standardDeviation(kline: number[][]): number {
  return Math.sqrt(variance(kline))
}
/**
 * 相关系数
 * @param kline1
 * @param kline2
 */
function correlationCoefficient(kline1: number[][], kline2: number[][]): number {
  return covariance(kline1, kline2) / (standardDeviation(kline1) * standardDeviation(kline2))
}

//删除type类型kline
function deleteKline(type: string): void {
  for (let i=0;i < klineCodes.length;i++) {
    const parts = klineCodes[i].split('-')
    if (type === '' && parts.length === 1) {
      klineCodes.splice(i)
    } else if (type !== '' && type === parts[1]) {
      klineCodes.splice(i)
    }
  }
}

// 生成相关性系数表
function genrateCorrelationCoefficientTable(): void {
  if (selectedCodes.length < 2) {
    return
  }

  const rows = genrateCorrelationCoefficientRows()
  let html = `<thead class="table-info">
        <tr>
            <th>相关系数</th>`

  for (let i = 0; i < selectedCodes.length; i++) {
    html += `<th class="sortable">${codeNameMap[selectedCodes[i]]}(${selectedCodes[i]})</th>`
  }

  html += `</tr>
    </thead>
    <tbody>`

  for (let i = 0; i < rows.length; i++) {
    html += `<tr><td>${codeNameMap[selectedCodes[i]]}(${selectedCodes[i]})</td>`
    for (let j = 0; j < rows[i].length; j++) {
      let color = ''
      if (rows[i][j] > 0) {
        color = 'text-danger'
      } else if (rows[i][j] < 0) {
        color = 'text-success'
      }
      html += `<td class="${color}">${rows[i][j].toFixed(3)}</td>`
    }
    html += `</tr>`
  }
  html += `</tbody>`
  bsTable('correlation', {data: html})
}

// 生成相关性系数行s
function genrateCorrelationCoefficientRows(): number[][] {
  const startTs = new Date((document.getElementById('dateRange-start') as HTMLInputElement).value).getTime()
  const endTs = new Date((document.getElementById('dateRange-end') as HTMLInputElement).value).getTime()
  const rows: number[][] = []
  // 初始化矩阵
  for (let i = 0; i < selectedCodes.length; i++) {
    rows[i] = []
    for (let j = 0; j < selectedCodes.length; j++) {
      rows[i][j] = 1.0
    }
  }
  // 开始计算
  for (let i = 0; i < selectedCodes.length - 1; i++) {
    for (let j = i + 1; j < selectedCodes.length; j++) {
      const aks = alignKlines(cache[selectedCodes[i]] as number[][], cache[selectedCodes[j]] as number[][], startTs, endTs)
      const correlation = correlationCoefficient(aks[0], aks[1])
      rows[i][j] = correlation
      rows[j][i] = correlation
    }
  }

  return rows
}

function formatKlineValue(value: number) {
  if (value > 10) {
    return Math.round(100*value)/100
  } else if (value > 1.0) {
    return Math.round(1000*value)/1000
  } else {
    return Math.round(10000*value)/10000
  }
}

function resolveKlineRange(rawData: any[][], startTs: number, endTs: number) {
  let lastBeforeIdx = -1
  let firstInRangeIdx = -1
  let end = rawData.length
  const maxBaselineGap = 32 * 24 * 3600 * 1000

  for (let j = 0; j < rawData.length; j++) {
    const ts = rawData[j][0]
    if (ts <= startTs) {
      lastBeforeIdx = j
      continue
    }
    if (ts > endTs) {
      end = j
      break
    }
    if (firstInRangeIdx < 0) {
      firstInRangeIdx = j
    }
  }

  if (firstInRangeIdx < 0) {
    return { begin: 0, end, hasDataInRange: false }
  }

  let begin = firstInRangeIdx
  if (lastBeforeIdx >= 0 && rawData[firstInRangeIdx][0] - rawData[lastBeforeIdx][0] <= maxBaselineGap) {
    begin = lastBeforeIdx
  }
  return { begin, end, hasDataInRange: true }
}

export function rerenderMyChart(fq: string = ''): void {
  let startTs = 0
  let endTs = Date.now()
  if (document.getElementById('dateRange-start')) {
    startTs = new Date((document.getElementById('dateRange-start') as HTMLInputElement).value).getTime()
  }
  if (document.getElementById('dateRange-end')) {
    endTs = new Date((document.getElementById('dateRange-end') as HTMLInputElement).value).getTime()
  }
  renderLineChart(startTs, endTs, fq)
}

function renderLineChart(startTs: number, endTs: number, fq: string = '') {
  if (klineCodes.length < 1) {
    return
  }
  replaceArrayItems(klineCodes, klineCodes.filter((v, idx)=> klineCodes.indexOf(v) === idx))
  if (klineCodes.length === 1 && (document.getElementById('candlestick') as HTMLInputElement)?.checked && ['SZ', 'SH', 'SF', 'ZF', 'BJ', 'HK', 'US', 'KS'].includes(klineCodes[0].split('.')[1])) {
    rerenderCandlestick(klineCodes[0], startTs, endTs, fq)
  } else {
    renderKline(klineCodes, startTs, endTs, fq)
  }
}

function renderKline(codes: string[], startTs: number, endTs: number, fq: string = '') {
  const series: any = []
  let ts = 0
  let value = 0
  const codeNum = codes.length
  let xAxis: number[] = []
  for (const code of codes) {
    const cacheKey = `${code}${fq}`
    if (!cache[cacheKey] || (cache[cacheKey] as any[]).length < 1) {
      console.log('renderLineChart cache[code] wrong:', cacheKey)
      continue
    }
    const rawData = cache[cacheKey] as any[]
    const data = []
    let baseStart = -1
    let baseEnd = -1
    const arr: number[] = []
    const { begin, end, hasDataInRange } = resolveKlineRange(rawData, startTs, endTs)
    const isFund = code.endsWith('.OF')  ? true: false
    for (let j = begin; j < end; j++) {
      arr.push(rawData[j][1])
    }
    if (!hasDataInRange) {
      continue
    }

    baseEnd = rawData[end-1][1]
    arr.sort((a, b) => a - b)
    for (let j = begin; j < end; j++) {
      ts = rawData[j][0]
      value = rawData[j][1]
      if (baseStart < 0) {
        baseStart = value
      }

      // 考虑基金分红等情况
      if (isFund && rawData[j].length > 2) {
        value = baseStart + rawData[j][2] - baseStart
      }

      //相比昨日
      const change = j > 0 ? value/rawData[j-1][1] -1: 0
      // 和基数的比率
      const ratio = value / baseStart //截止比率
      const ratio2 = baseEnd/value //结束比率
      let quantile = 0
      const idx = findInsertIndex(arr, value)
      if (idx === arr.length - 1) {
        quantile = 100
      } else {
        quantile = idx * 100 / arr.length
      }
      if (codeNum > 1) {
        // 把起始数据作为标准1进行比较
        data.push([ts, ratio, value, ratio2, change, quantile])
      } else {
        data.push([ts, value, ratio, ratio2, change, quantile])
      }
      xAxis.push(ts)
    }
    //yAxisIndex: 1,
    series.push({
      name: `${codeNameMap[code]}(${code})`,
      type: 'line',
      showSymbol: false,
      emphasis: {
        scale: false,
      },
      data: data,
      endLabel: {
        show: true,
        color: 'white',
        padding: 4,
                fontWeight: 'bold',
        backgroundColor: 'inherit',
        formatter: function (param: any) {
          let ratio
          if (codeNum > 1) {
            ratio = param.value[1]
          } else {
            ratio = param.value[2]
          }
          return codeNameMap[code] + ': ' + (100*ratio-100).toFixed(2) + '%'
        }
      }
    })
  }

  const yAxis: any = [{
    type: 'value',
    scale: true,
    position: 'right',
    //boundaryGap: [0.1, 0.1],
    axisLabel: {
      formatter: '{value}'
    },
    splitLine: {
      show: false
    }
  }]
  if (series.length === 0) {
    myChartSetOption(series, [], yAxis)
    return
  }

  xAxis = xAxis.filter((v: number,i: number)=> xAxis.indexOf(v) === i).sort()
  addMarkPoints(series[0], xAxis)
  // @ts-ignore
  myChartSetOption(series, xAxis, yAxis)
}


function myChartSetOption(series: any, xAxis: any,  yAxis: any) {
  const id = 'kline'
  //let html = `<div id="${id}" style="min-height: 600px; min-width: 300px;"></div>`
  const chartDom: any = document.getElementById(id)
  // @ts-ignore
  echarts.dispose(chartDom)
  // @ts-ignore
  const myChart: any = echarts.init(chartDom)

  // @ts-ignore
  myChart.setOption({
    title: {
      text: ''
    },
    color: echartsColor,
    tooltip: {
      trigger: 'axis',
      axisPointer: {
        type: 'cross'
      },
      formatter: function (params: any) {
        params.sort((a: any,b: any)=> b.value[1] - a.value[1])
        let str = toTimeString(params[0].value[0])
        for (const param of params) { // get data sorted
          const name = param.seriesName
          let value, ratio
          if (series.length > 1) {
            ratio = (100*param.value[1]-100).toFixed(2)
            value = param.value[2]
          } else {
            ratio = (100*param.value[2]-100).toFixed(2)
            value = param.value[1]
          }
          const ratio2 = (100*param.value[3]-100).toFixed(2)
          const change = (100*param.value[4]).toFixed(2)
          const quantile = param.value[5].toFixed(2)
          str += `</br>${param.marker}${name}: ${formatKlineValue(value)}/当天:${change}%/比开始:${ratio}%/到结束:${ratio2}%/分位:${quantile}%`
        }

        //带上markLines
        str += markPoints2Str(params[0].axisValue, xAxis)
        return str
      }
    },
    legend: {
      middle: 10
    },
    xAxis: {
      type: 'time',
      splitLine: {
        show: false
      }
    },
    yAxis: yAxis,
    series: series
  })
}

//重新渲染蜡烛图
function rerenderCandlestick(code: string, startTs: number, endTs: number, fq: string = '') {
  const upColor = '#ec0000'
  const downColor = '#00da3c'
  const chartDom: any = document.getElementById('kline')
  // @ts-ignore
  echarts.dispose(chartDom)
  // @ts-ignore
  const myChart: any = echarts.init(chartDom)
  const cacheKey = `${code}${fq}`
  const data = splitCandlestickData(cache[cacheKey] as any[][], startTs, endTs)
  const series: any = [
    {
      name: 'K线图',
      type: 'candlestick',
      data: data.values,
      itemStyle: {
        color: upColor,
        color0: downColor,
        borderColor: 0,
        borderColor0: 0
      }
    },
    {
      name: 'Volume',
      type: 'bar',
      xAxisIndex: 1,
      yAxisIndex: 1,
      data: data.volumes
    }
  ]

  const legend: string[] = ['K线图']
  for (const ma of [5, 10, 20, 30, 60]) {
    const name = 'MA' + ma
    legend.push(name)
    series.push({
      name: name,
      type: 'line',
      showSymbol: false,
      data: calculateMA(data.values, ma),
      smooth: true,
      lineStyle: {
        opacity: 0.5
      }
    })
  }
  const option = {
    animation: false,
    legend: {
      middle: 10,
      data: legend
    },
    tooltip: {
      trigger: 'axis',
      axisPointer: {
        type: 'cross'
      },
      backgroundColor: 'rgba(255, 255, 255, 0.8)',
      extraCssText: 'width: 170px',
      position: function (pos: number[], params: any, el: any, elRect: any, size: any) {
        const obj: any = {
          top: 10
        }
        obj[['left', 'right'][+(pos[0] < size.viewSize[0] / 4)]] = 30
        return obj
      },
      formatter: function (params: any) {
        let str = `${params[0].axisValue}`
        for (let i = 0; i< params.length;i++) {
          if (i === 0) {
            let volume = params[i].value[5]
            if (volume > 1e8) {
              volume = (volume/1e8).toFixed(1) + '亿'
            } else if (volume > 1e4) {
              volume = (volume/1e4).toFixed(0) + '万'
            }

            const changeColor = params[i].value[8] > 0? 'danger': 'success'
            const compareStartColor = params[i].value[6] > 0? 'danger': 'success'
            const compareEndColor = params[i].value[7] > 0? 'danger': 'success'
            str += `<br>${params[i].marker}${params[i].seriesName}
            <br>开盘: ${params[i].value[1]}
            <br>收盘: ${params[i].value[2]}
            <br>最低: ${params[i].value[3]}
            <br>最高: ${params[i].value[4]}
            <br>当天: <span class="text-${changeColor}">${params[i].value[8]}%</span>
            <br>交易量: ${volume}
            <br>比开始: <span class="text-${compareStartColor}">${params[i].value[6]}%</span>
            <br>到结束: <span class="text-${compareEndColor}">${params[i].value[7]}%</span>
            <br>分位值: ${params[i].value[9]}%`
          } else {
            const valueColor = params[0].value[2] > params[i].value ? 'danger': 'success'
            const value = typeof params[i].value === 'number' ? params[i].value.toFixed(3): params[i].value
            str += `<br>${params[i].marker}${params[i].seriesName}: <span class="text-${valueColor}">${value}</span>`
          }
        }

        //带上markLines
        str += markPoints2Str(params[0].axisValue, data.categoryData)
        return str
      }
    },
    axisPointer: {
      link: { xAxisIndex: 'all' },
      label: {
        backgroundColor: '#777'
      }
    },
    visualMap: {
      show: false,
      seriesIndex: 1,
      dimension: 2,
      pieces: [
        {
          value: 1,
          color: upColor
        },
        {
          value: -1,
          color: downColor
        }
      ]
    },
    grid: [
      {
        left: '10%',
        right: '8%',
        height: '50%'
      },
      {
        left: '10%',
        right: '8%',
        bottom: '20%',
          height: '15%'
      }
    ],
    xAxis: [
      {
        type: 'category',
        data: data.categoryData,
        scale: true,
        boundaryGap: false,
        axisLine: { onZero: false },
        splitLine: { show: false },
        min: 'dataMin',
        max: 'dataMax',
        axisPointer: {
          z: 100
        }
      },
      {
        type: 'category',
        gridIndex: 1,
        data: data.categoryData,
        scale: true,
        boundaryGap: false,
        axisLine: { onZero: false },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { show: false },
        min: 'dataMin',
        max: 'dataMax'
      }
    ],
    yAxis: [
      {
        scale: true,
        position: 'right',
        splitArea: {
          show: true
        }
      },
      {
        scale: true,
        gridIndex: 1,
        splitNumber: 2,
        axisLabel: { show: false },
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { show: false }
      }
    ],
    series: series
  }

  addMarkPoints(option.series[0], data.categoryData)
  myChart.setOption(option)
}

function addMarkPoints(seriesI: any, xAxis: any) {
  if (!markPoints.length) {
    return
  }

  replaceArrayItems(markPoints, markPoints.filter((v1: any, i: number)=> i === markPoints.findIndex((v2: any)=> v1.x===v2.x && v1.name===v2.name)))
  markPoints.sort((a: any,b: any)=> a.x - b.x)
  const data = []
  const preIs: number[] = Array(6).fill(-10)
  let offset = 0
  let maxOffset = 0
  for (let i=0;i<markPoints.length;i++) {
    let x = typeof (xAxis as any[])[0]==='string'? toDateString((markPoints[i] as any).x): (markPoints[i] as any).x
    if (x < (xAxis as any[])[0]) {
      //不在数据范围
      continue
    }
    offset = 0
    maxOffset = 0
    for (let i=0;i< (xAxis as any[]).length;i++) {
      if (x <= (xAxis as any[])[i]) {
        x = (xAxis as any[])[i]
        for (let j=0;j< preIs.length;j++) {
          offset = (i-preIs[j])/(xAxis as any[]).length
          if (offset > 0.1) {
            offset = j
            break
          } else if (offset > maxOffset) {
            maxOffset = offset
            offset = j
          }
        }
        preIs[offset] = i
        break
      }
    }
    
    const markPoint = markPoints[i] as { name: string; color: string }
    data.push(
      {
        name: markPoint.name,
        coord: [x, 'max'],
        itemStyle: {
          color: markPoint.color
        },
        label: {
          color: markPoint.color,
          offset: [0, -15 - 15*offset]
        }
      }
    )
  }
  seriesI.markPoint = {
    symbol: "circle",
    symbolSize: 5,
    label: {
      formatter: '{b}',
      
    },
    data: data
}
}

function markPoints2Str(axisValue: string|number, xAxis: any) {
  let str = ''
  for (const markPoint of markPoints) {
    const typedMarkPoint = markPoint as { x: number; color: string; name: string }
    let x = typeof xAxis[0]==='string'? toDateString(typedMarkPoint.x): typedMarkPoint.x
    if (x <= xAxis[0]) {
      //不在数据范围
      continue
    }
    for (let i=0;i< xAxis.length;i++) {
      if (x <= xAxis[i]) {
        x = xAxis[i]
        break
      }
    }
    if (x === axisValue) {
      str += `<br><span style="display:inline-block;margin-right:4px;border-radius:10px;width:10px;height:10px;background-color:${typedMarkPoint.color};"></span>${typedMarkPoint.name}`
    }
  }
  return str
}

function splitCandlestickData(rawData: any[][], startTs: number, endTs: number) {
  const categoryData: string[] = []
  const values: any[] = []
  const volumes: any[] = []
  let baseStart = -1
  let baseEnd = -1
  const arr: number[] = []
  const { begin, end, hasDataInRange } = resolveKlineRange(rawData, startTs, endTs)
  if (!hasDataInRange) {
    return {
      categoryData: categoryData,
      values: values,
      volumes: volumes
    }
  }
  for (let j = begin; j < end; j++) {
    arr.push(rawData[j][1])
  }

  baseEnd = rawData[end-1][1]
  arr.sort((a, b) => a - b)
  for (let i = begin; i < end; i++) {
    const value = rawData[i][1]
    if (baseStart < 0) {
      baseStart = value
    }
    //相比昨日
    const change = i > 0 ? Math.round(10000*value/rawData[i-1][1]-10000)/100: 0
    // 和基数的比较
    const ratio = Math.round(10000*value / baseStart-10000)/100 //截止比率
    const ratio2 = Math.round(10000*baseEnd/value-10000)/100 //结束比率
    let quantile = 0
    const idx = findInsertIndex(arr, value)
    if (idx === arr.length - 1) {
      quantile = 100
    } else {
      quantile = Math.round(idx * 10000 / arr.length)/100
    }
    categoryData.push(toDateString(rawData[i][0]))
    //转成：开盘、收盘、最低、最高、交易量、和开始比、结束比、分位值
    values.push([rawData[i][2], rawData[i][1], rawData[i][3], rawData[i][4], rawData[i][5], ratio, ratio2,change, quantile])
    //收盘是否大于昨天收盘
    volumes.push([i, rawData[i][5], i > 0 && rawData[i][1] > rawData[i-1][1] ? 1 : -1])
  }

  return {
    categoryData: categoryData,
    values: values,
    volumes: volumes
  }
}

//num个线在index1
export function renderMultiChart(codes: string[], num: number, fq: string = '') {
  let startTs = new Date((document.getElementById('dateRange-start') as HTMLInputElement).value).getTime()
  const endTs = new Date((document.getElementById('dateRange-end') as HTMLInputElement).value).getTime()
  const ymin: number[] = [999999, 999999]
  const ymax: number[] = [-999999, -999999]
  const series = []
  let ts = 0
  let value = 0
  for (const code of codes) {
    const cacheKey = `${code}${fq}`
    const data = cache[cacheKey] as number[][]
    const ts = data[0][0]
    if (ts > startTs) {
      startTs = ts
    }
  }

  for (const code of codes) {
    const gridIndex: number = codes.length - series.length > num ? 0 : 1
    const data = []
    const cacheKey = `${code}${fq}`
    const cacheData = cache[cacheKey] as number[][]
    for (let j = 0; j < cacheData.length; j++) {
      ts = cacheData[j][0]
      if (ts < startTs) {
        continue
      }

      if (ts > endTs) {
        break
      }

      value = cacheData[j][1]
      if (value < ymin[gridIndex]) {
        ymin[gridIndex] = value
      }

      if (value > ymax[gridIndex]) {
        ymax[gridIndex] = value
      }
      data.push([ts, value.toFixed(4)])
    }
    series.push({
      name: `${codeNameMap[code]}(${code})`,
      type: 'line',
      xAxisIndex: gridIndex,
      yAxisIndex: gridIndex,
      showSymbol: false,
      emphasis: {
        scale: false,
      },
      data: data
    })
  }

  multiChartSetOption(series, ymin, ymax)
}

function multiChartSetOption(series: any, ymin: number[], ymax: number[]) {
  const id = 'kline'
  const chartDom: any = document.getElementById(id)
  // @ts-ignore
  echarts.dispose(chartDom)
  // @ts-ignore
  const myChart: any = echarts.init(chartDom)

  // @ts-ignore
  myChart.setOption({
    title: {
      text: ''
    },
    tooltip: {
      trigger: 'axis',
      axisPointer: {
        type: 'cross'
      }
    },
    axisPointer: {
      link: [
        {
          xAxisIndex: 'all'
        }
      ],
      label: {
        backgroundColor: '#777'
      }
    },
    legend: {
      middle: 10
    },
    grid: [
      {
        left: '10%',
        right: '8%',
        height: '50%'
      },
      {
        left: '10%',
        right: '8%',
        top: '50%',
        height: '50%'
      }
    ],
    xAxis: [{
      type: 'time',
      splitLine: { show: false },
    }, {
      type: 'time',
      gridIndex: 1,
      axisLine: { onZero: false },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: { show: false },
    }],
    yAxis: [{
      type: 'value',
      min: ymin[0].toFixed(3),
      max: ymax[0].toFixed(3),
      position: 'right',
      axisLabel: {
        formatter: '{value}'
      },
      splitLine: {
        show: false
      }
    }, {
      type: 'value',
      gridIndex: 1,
      min: ymin[1].toFixed(3),
      max: ymax[1].toFixed(3),
      position: 'right',
      axisLabel: {
        formatter: '{value}'
      },
      splitLine: {
        show: false
      }
    }],
    series: series
  })
}

export function cacheCodeName(code: string, name: string, save: boolean): boolean {
  if (code && code.endsWith('.HK') && name && !name.endsWith('HK')) {
    name = `${name}.HK`
  } else {
    name = name
  }
  if (codeNameMap[code] === name) {
    return false
  }
  codeNameMap[code] = name
  if (save) {
    localStorage.setItem('codeNameMap', JSON.stringify(codeNameMap))
  }
  return true
}

function calculateMA(data: number[][], window: number) {
  const result: any = [ ]
  if (data.length < window) {
    return result;
  }
  let sum = 0
  for (let i = 0; i < window; i++) {
      sum += data[i][1]
      if (i < window-1) {
        result.push('-')
      }
  }
  result.push(sum / window)
  const steps = data.length - window
  for (let i = 0; i < steps; i++) {
      sum -= data[i][1]
      sum += data[i + window][1]
      result.push(sum / window)
  }
  return result
}

export function onRatioCheckChange(checked: boolean) {
  if (checked) {
    if (selectedCodes.length < 2) {
      console.log('selected.length < 2')
      return
    }

    const ratioData: number[][] = []
    let c1 = selectedCodes[0]
    let c2 = selectedCodes[1]
    //用大的除以小的
    const data1 = cache[c1] as number[][]
    const data2 = cache[c2] as number[][]
    if (data1[data1.length - 1][1] < data2[data2.length - 1][1]) {
      c1 = selectedCodes[1]
      c2 = selectedCodes[0]
    }
    let i = 0;
    let j = 0;
    let k = 0;
    const cacheData1 = cache[c1] as number[][]
    const cacheData2 = cache[c2] as number[][]
    while (i < cacheData1.length && j < cacheData2.length) {
      if (cacheData1[i][0] < cacheData2[j][0]) {
        i++
        continue
      } else if (cacheData1[i][0] > cacheData2[j][0]) {
        j++
        continue
      }

      ratioData[k++] = [cacheData1[i][0], cacheData1[i][1] / cacheData2[j][1]]
      i++
      j++
    }
    (codeNameMap as any).ratio = 'ratio'
    klineCodes.push( 'ratio')
  } else {
    replaceArrayItems(klineCodes, klineCodes.filter(code => code !== 'ratio'))
  }

  rerenderMyChart()
}

//差值k线
export function diffKline(c1: string, c2: string) {
  const diffData: number[][] = []
  //用大的减去小的
  const data1 = cache[c1] as number[][]
  const data2 = cache[c2] as number[][]
  if (data1[data1.length - 1][1] < data2[data2.length - 1][1]) {
    c1 = selectedCodes[1]
    c2 = selectedCodes[0]
  }
  let i = 0;
  let j = 0;
  let k = 0;
  const cacheData1 = cache[c1] as number[][]
  const cacheData2 = cache[c2] as number[][]
  while (i < cacheData1.length && j < cacheData2.length) {
    if (cacheData1[i][0] < cacheData2[j][0]) {
      i++
      continue
    } else if (cacheData1[i][0] > cacheData2[j][0]) {
      j++
      continue
    }

    diffData[k++] = [cacheData1[i][0], cacheData1[i][1] - cacheData2[j][1]]
    i++
    j++
  }
  (codeNameMap as any).diff = 'diff'
  klineCodes.push('diff')
}

//k线求合
export function addKline(c1: string, c2: string) {
  const addData: number[][] = []
  let i = 0;
  let j = 0;
  let k = 0;
  const cacheData1 = cache[c1] as number[][]
  const cacheData2 = cache[c2] as number[][]
  while (i < cacheData1.length && j < cacheData2.length) {
    if (cacheData1[i][0] < cacheData2[j][0]) {
      i++
      continue
    } else if (cacheData1[i][0] > cacheData2[j][0]) {
      j++
      continue
    }

    addData[k++] = [cacheData1[i][0], cacheData1[i][1] + cacheData2[j][1]]
    i++
    j++
  }
  (codeNameMap as any).add = 'add'
  klineCodes.push('add')
}

function onFinanceCheckChange(selected: any[], type: string, checked: boolean) {
  if (!checked) {
    deleteKline(type)
    rerenderMyChart()
    return
  }

  for (const code of selected) {
    //非A股公司不处理
    if (!isAstockCompany(code) && !isHkCompany(code) && !code.endsWith('.US')) {
      continue
    }
    
    const data = cache[code] as number[][]
    if (!data || data.length === 0) {
      continue
    }
    
    // 对于市值和PE、PB、PS，都需要从财务数据计算
    const financeCacheKey = `${code}-fsi`
    const shareChangeCacheKey = `${code}-sc`
    
    const calculateValuation = () => {
      const financeData = cache[financeCacheKey]
      const shareChangeData = cache[shareChangeCacheKey]
      
      if (type === 'value') {
        // 计算市值 = 股价 × 总股本
        if (!shareChangeData || !Array.isArray(shareChangeData) || shareChangeData.length === 0) {
          console.log(`No share change data for ${code}`)
          return
        }
        
        const items: any[] = []
        for (let i = 0; i < data.length; i++) {
          const timestamp = data[i][0]
          const price = data[i][1]
          
          // 找到对应的总股本（最新的股本数据）
          let totalShares = null
          for (const share of shareChangeData) {
            const changeDate = new Date(share.changeDate).getTime()
            if (changeDate <= timestamp) {
              totalShares = share.totalShares
              break
            }
          }
          
          // 计算市值
          let value = null
          if (totalShares && totalShares > 0) {
            value = (price * totalShares) / 1e8 // 市值（亿元）
          }
          
          items.push([timestamp, value])
        }
        
        const key = `${code}-${type}`
        cache[key] = items
        codeNameMap[key] = `${codeNameMap[code]}-${type}`
        klineCodes.push(key)
      } else {
        // 计算PE、PB、PS
        if (!financeData || !Array.isArray(financeData) || financeData.length === 0) {
          console.log(`No finance data for ${code}`)
          return
        }
        
        const items: any[] = []
        
        // 遍历K线数据，根据财务数据计算估值指标
        for (let i = 0; i < data.length; i++) {
          const timestamp = data[i][0]
          const price = data[i][1]
          
          // 计算估值指标
          let value = null
          if (type === 'pettm') {
            if (shareChangeData && Array.isArray(shareChangeData) && shareChangeData.length > 0) {
              // 找到对应的总股本
              let totalShares = null
              for (const share of shareChangeData) {
                const changeDate = new Date(share.changeDate).getTime()
                if (changeDate <= timestamp) {
                  totalShares = share.totalShares
                  break
                }
              }
              
              // PE TTM = 市值 / 最近4个季度净利润之和
              if (totalShares && totalShares > 0) {
                const marketCap = price * totalShares
                // 累加最近4个季度的净利润
                const trailingProfits: number[] = []
                for (const finance of financeData) {
                  const reportDate = new Date(finance.reportDate).getTime()
                  const profit = Number(finance.parentNetprofit)
                  if (reportDate <= timestamp && Number.isFinite(profit) && trailingProfits.length < 4) {
                    trailingProfits.push(profit)
                  }
                }
                const totalNetProfit = trailingProfits.reduce((sum, profit) => sum + profit, 0)
                if (trailingProfits.length === 4 && totalNetProfit > 0) {
                  value = marketCap / totalNetProfit
                }
              }
            }
          } else if (type === 'pb') {
            // PB暂时无法计算，需要每股净资产数据
            value = null
          } else if (type === 'ps') {
            // PS暂时无法计算，需要营收和总股本数据
            value = null
          }
          
          items.push([timestamp, value])
        }
        
        const key = `${code}-${type}`
        cache[key] = items
        codeNameMap[key] = `${codeNameMap[code]}-${type}`
        klineCodes.push(key)
      }
    }
    
    // 检查数据是否都已缓存
    const financeCached = cache[financeCacheKey] !== undefined
    const shareChangeCached = cache[shareChangeCacheKey] !== undefined
    
    const needsFinance = type !== 'value'
    const needsShareChange = type === 'value' || type === 'pettm' // PE TTM也需要股本变动数据
    
    if ((needsFinance && financeCached && needsShareChange && shareChangeCached) ||
        (needsFinance && !needsShareChange && financeCached) ||
        (!needsFinance && needsShareChange && shareChangeCached)) {
      calculateValuation()
    } else {
      // 获取财务数据
      if (needsFinance && !financeCached) {
        fetchFinanceIncome(code, () => {
          if (!needsShareChange || shareChangeCached || cache[shareChangeCacheKey] !== undefined) {
            calculateValuation()
          }
        })
      }
      
      // 获取股本变动数据
      if (needsShareChange && !shareChangeCached) {
        fetchRequest(`${server}/api/finance/sharechange?code=${code}`).then((data: any) => {
          cache[shareChangeCacheKey] = data
          if (!needsFinance || financeCached || cache[financeCacheKey] !== undefined) {
            calculateValuation()
          }
        })
      }
    }
  }

  rerenderMyChart()
}



function onBonusCheckChange(selected: any[], checked: boolean) {
  if (!checked) {
    deleteKline('bs')
    rerenderMyChart()
    return
  }

  //计算实际需要处理的code
  const codes: any = []
  for (const code of selected) {
    //非A股和港股公司不处理
    if (!isAstockCompany(code) && !isHkCompany(code)) {
      continue
    }
    const cacheKey = `${code}-bs`
    if (cache[cacheKey]) {
      continue
    }
    codes.push(code)
  }

  if (codes.length === 0) {
    rerenderMyChart()
    return
  }

  const should = 2
  let done = 0
  const success = function (codes: string[]) {
    done++
    if (done === should) {
      rerenderMyChart()
      return
    }
  }

  fetchKlines(codes, 'normal', success)
  fetchDividendYields(codes, success)
}

function klineOptionsChange() {
  const vals = selectedOptionValues(document.getElementById('klineOptions'))
  const success = () => {
    for (const val of ['value', 'pettm', 'pb', 'ps', 'bonus']) {
      const checked = vals.includes(val)
      if (val === 'bonus') {
        onBonusCheckChange(selectedCodes, checked)
      } else {
        onFinanceCheckChange(selectedCodes, val, checked)
      }
    }
  }
  if (vals.length > 0) {
    fetchKlines(selectedCodes, '', function (_codes) {
      success()
    })
  } else {
    success()
  }
}

export function onKlineCodeSelectChange() {
  const nextSelectedCodes = selectedOptionValues(document.getElementById('codes'))
  if (nextSelectedCodes.length === 0) {
    console.log('codes none')
    return
  }

  replaceArrayItems(selectedCodes, nextSelectedCodes)
  klineCodes.length = 0 //清空
  changeCodeSpecHref()
  fetchKlines(selectedCodes, '', function (_codes) {
    klineCodes.push(...selectedCodes)
    klineOptionsChange()
    rerenderMyChart()
    genrateRegressTable()
    genratePerformanceTable(selectedCodes)
    generateMarketTable(selectedCodes)
    if (selectedCodes.length > 1) {
      genrateCorrelationCoefficientTable()
    }
  })

  /*fetchFundPositions(selectedCodes, 1, function (error, codes) {
    if (error !== null) {
      console.log(error)
      return
    }
    genratePositionTable(codes)
  })*/
}

function getUrlParam(sParam: string) {
  const sPageURL = window.location.search.substring(1)
  const sURLVariables = sPageURL.split('&')
  let sParameterName: string[]

  for (let i = 0; i < sURLVariables.length; i++) {
    sParameterName = sURLVariables[i].split('=')

    if (sParameterName[0] === sParam) {
      return typeof sParameterName[1] === undefined ? true : decodeURIComponent(sParameterName[1])
    }
  }
  return undefined
}

const legacyDataServices = createLegacyDataServices({
  cache: cache as Record<string, unknown>,
  codeNameMap,
  klineCodes,
  markPoints,
  server,
  usCodeMap,
  fetchRequest,
})

const fetchCodesData = legacyDataServices.fetchCodesData
const fetchFinanceIncome = legacyDataServices.fetchFinanceIncome
const fetchFinanceBalance = legacyDataServices.fetchFinanceBalance
const fetchFinanceCashflow = legacyDataServices.fetchFinanceCashflow
export const fetchKline = legacyDataServices.fetchKline
export const fetchKlines = legacyDataServices.fetchKlines
const fetchFundPosition = legacyDataServices.fetchFundPosition
export const fetchShareChanges = legacyDataServices.fetchShareChanges
export const fetchShareChange = legacyDataServices.fetchShareChange
const fetchDividendYields = legacyDataServices.fetchDividendYields
export const fetchShareAdditional = legacyDataServices.fetchShareAdditional
export const fetchShareBonus = legacyDataServices.fetchShareBonus
export const fetchDividendYield = legacyDataServices.fetchDividendYield
export const fetchReportUrl = legacyDataServices.fetchReportUrl
export const fetchCompanyInfo = legacyDataServices.fetchCompanyInfo
export const fetchCompanyFreeHolders = legacyDataServices.fetchCompanyFreeHolders
export const fetchCompanyOrgHolders = legacyDataServices.fetchCompanyOrgHolders
export const fetchFundInfo = legacyDataServices.fetchFundInfo
export const fetchCodeNames = legacyDataServices.fetchCodeNames

const legacyControls = createLegacyControls({
  server,
  securities,
  fetchRequest,
  replaceUrlParam,
  selectedOptionValues,
  currentPage,
  cacheCodeName,
  codeNameMap,
  getUrlParam,
})

const bsSelect = legacyControls.bsSelect
export const bsRadioButtons = legacyControls.bsRadioButtons
export const bsCards = legacyControls.bsCards
export const codeSelectInit = legacyControls.codeSelectInit

type FinanceChartPercentageLine = {
  key: string
  name: string
}

type FinanceChartOptions = {
  includeQuarterOnQuarter?: boolean
  percentageLines?: FinanceChartPercentageLine[]
}

//绘制财报柱状对比图
export function genFinanceChart(id: string, codes: string[], yKeys: string[], yKeyNames: string[], options: FinanceChartOptions = {}) {
  // @ts-ignore
  const  seasons = parseInt(document.getElementById('seasons').value)
  const xKey = 'reportDate'
  let yUnit = '(亿元)'
  let unit = 1e8
  const typedReportsMap = runtimeState.reportsMap as Record<string, any[]>
  const firstFiniteValue = codes
    .flatMap((code) => typedReportsMap[code] || [])
    .map((report) => Number(report?.[yKeys[0]]))
    .find((value) => Number.isFinite(value))
  if (firstFiniteValue !== undefined && Math.abs(firstFiniteValue) < 1e8) {
    unit = 1e6
    yUnit = '(百万)'
  }
  const data: any = {}
  const dataSourceMap: any = {}
  for (const code of codes) {
    data[code] = []
    for (let i=0;i< typedReportsMap[code].length;i++) {
      data[code][i] = {}
      for (const key of [xKey, ...yKeys, ...(options.percentageLines || []).map((line) => line.key)]) {
        if (key === 'reportDate') {
          data[code][i][key] = typedReportsMap[code][i][key]
        } else if (yKeys.includes(key)) {
          data[code][i][key] = typedReportsMap[code][i][key]/unit
        } else {
          const value = Number(typedReportsMap[code][i][key])
          data[code][i][key] = Number.isFinite(value) ? value : null
        }
      }
      if (typedReportsMap[code][i].dataSource) {
        if (!dataSourceMap[code]) dataSourceMap[code] = {}
        dataSourceMap[code][data[code][i][xKey]] = {
          type: typedReportsMap[code][i].dataSource,
          label: typedReportsMap[code][i].dataSourceLabel,
        }
      }
    }
  }
  genBarLineCompareChart(id, codes, data, codeNameMap, yKeys, yKeyNames, xKey, yUnit, seasons, dataSourceMap, options)
}

function getOffsetAndCompareText(data: any) {
  const offsetMap: any = {}
  const compareType: string = (document.getElementById('compareType') as any).dataset.id
  let compareText = '同比'
  //由于港股等有些研报是半年一发，所以同比数量也不一定是4，可能是2
  switch (compareType) {
    case 'yoy':
      compareText = '同比'
      break
    case 'qoq':
      compareText = '环比'
      break
    case 'yearly':
      compareText = '年比'
      break
    default:
      console.log('wrong compareType', compareType)
      break
  }

  for (const code in data) {
    if (compareType === 'yoy') {
      let months = parseInt(data[code][0].reportDate.substring(5, 7)) - parseInt(data[code][1].reportDate.substring(5, 7))
      if (months < 0) {
        months += 12
      }
      if (months === 3) {
        offsetMap[code] = 4
      } else if (months === 6) {
        offsetMap[code] = 2
      } else {
        console.log('wrong months', code, months)
        offsetMap[code] = 1
      }
    } else {
      offsetMap[code] = 1
    }
  }
  return {offsetMap, compareText, compareType}
}

//生成柱状图和折线图，柱状表示数量，折线表示同环比
function genBarLineCompareChart(id: string, codes: string[], data: any, codeNameMap: any, yKeys: string[], yKeyNames: string[], xKey: string, yUnit: string, seasons: number, dataSourceMap?: any, options: FinanceChartOptions = {}) {
  const {offsetMap, compareText, compareType} = getOffsetAndCompareText(data)
  const showAdditionalQoQ = Boolean(options.includeQuarterOnQuarter && compareType === 'yoy')
  let maxDate = ''
  let maxCode = ''
  const seasonsMap: any = {} //财报数
  for (const code of codes) {
    if (!maxDate || data[code][0][xKey] > maxDate) {
      maxDate = data[code][0][xKey]
      maxCode = code
    }
  }

  //计算每个code的数据季度数及offset
  for (const code of codes) {
    let codeSeasons = data[code].length
    if (codeSeasons > seasons) {
      codeSeasons = seasons
    }
    if (data[code][0][xKey] < maxDate) {
      seasonsMap[code] = codeSeasons - 1
    } else {
      seasonsMap[code] = codeSeasons
    }
  }

  const xAxisData: string[] = []
  for (let i = 0; i < seasonsMap[maxCode]; i++) {
    if (i >= data[maxCode].length) {
      //越界
      break
    }
    xAxisData.unshift(data[maxCode][i][xKey])
  }

  const legendData: string[] = []
  const series: any[] = []
  const seriesUnit: string[] = []
  for (const code of codes) {
    const num = yKeys.length
    const items: any[][] = []
    const qoqItems: any[][] = []
    for (let j=0;j< num;j++) {
      items[j*2] = []
      items[j*2+1] = []
      qoqItems[j] = []
    }
    for (let i = 0; i < seasonsMap[code]; i++) {
      if (i >= data[maxCode].length) {
        //越界
        break
      }

      for (let j=0;j< num;j++) {
        const current = data[code][i][yKeys[j]]
        const pre = i+offsetMap[code] < data[code].length? data[code][i+offsetMap[code]][yKeys[j]]: 0
        const ratio = pre > 0 ? 100*current/pre - 100: null
        const reportDate = data[code][i][xKey]
        const source = dataSourceMap?.[code]?.[reportDate]
        items[j*2].unshift({
          value: current,
          dataSource: source?.type,
          dataSourceLabel: source?.label,
        })
        items[j*2+1].unshift(ratio)
        if (showAdditionalQoQ) {
          const previousQuarter = i+1 < data[code].length ? data[code][i+1][yKeys[j]] : null
          qoqItems[j].unshift(previousQuarter > 0 ? 100*current/previousQuarter - 100 : null)
        }
      }
    }

    for (let i = 0; i < num; i++) {
      const codeName = codeNameMap[code] ? codeNameMap[code]: code
      const name1 = `${codeName}-${yKeyNames[i]}`
      const name2 = `${codeName}-${yKeyNames[i]}${compareText}`
      legendData.push(name1, name2)
      seriesUnit.push(`${yUnit}`, '%')
      //seriesUnit.push('%')
      series.push({
        name: name1,
        type: 'bar',
        data: items[i*2],
        label: {
          show: true,
          position: 'top',
          color: '#d9485f',
          fontWeight: 'bold',
          formatter: (params: any) => provisionalFinanceSourceLabel(params?.data)
        }
      })
      series.push({
        name: name2,
        type: 'line',
        yAxisIndex: 1,
        data: items[i*2+1]
      })
      if (showAdditionalQoQ) {
        const qoqName = `${codeName}-${yKeyNames[i]}环比`
        legendData.push(qoqName)
        seriesUnit.push('%')
        series.push({
          name: qoqName,
          type: 'line',
          yAxisIndex: 1,
          data: qoqItems[i],
          lineStyle: {
            type: 'dashed'
          }
        })
      }
    }

    for (const percentageLine of options.percentageLines || []) {
      const codeName = codeNameMap[code] ? codeNameMap[code]: code
      const name = `${codeName}-${percentageLine.name}`
      const values: Array<number | null> = []
      for (let i = 0; i < seasonsMap[code]; i++) {
        const rawValue = data[code][i]?.[percentageLine.key]
        const value = Number(rawValue)
        values.unshift(rawValue !== null && rawValue !== undefined && Number.isFinite(value) ? value : null)
      }
      legendData.push(name)
      seriesUnit.push('%')
      series.push({
        name,
        type: 'line',
        yAxisIndex: 1,
        data: values,
        lineStyle: {
          type: 'dotted'
        }
      })
    }
  }

  const yAxis: any[] = [
    {
      type: 'value',
      name: yUnit,
      axisLabel: {
        formatter: '{value}'
      }
    },
    {
      type: 'value',
      name: '百分比',
      axisLabel: {
        formatter: '{value}%'
      }
    }
  ]

  renderBarLineCombo(id, legendData, xAxisData, yAxis, series, seriesUnit, dataSourceMap, codes)
}

function renderBarLineCombo(id: string, legendData: string[], xAxisData: string[], yAxis: any[], series: any[], seriesUnit: string[], _dataSourceMap?: any, _codes?: string[]) {
  const chartDom: any = document.getElementById(id)
  // @ts-ignore
  echarts.dispose(chartDom)
  // @ts-ignore
  const myChart: any = echarts.init(chartDom);
  
  myChart.setOption({
    tooltip: {
      trigger: 'axis',
      axisPointer: {
        type: 'cross',
        crossStyle: {
          color: '#999'
        }
      },
      formatter: function (params: any, _ticket: string, _callback: (ticket: string, html: string) => void): string | HTMLElement | HTMLElement[] {
        const date = params[0].axisValue
        let str = `${date}</br>`
        for (let i = 0; i < params.length; i++) {
          const sourceText = provisionalFinanceSourceLabel(params[i].data)
          const sourceBadge = sourceText ? ` <span style="color:#d9485f;font-weight:bold;">[${sourceText}]</span>` : ''
          const value = Number(params[i].value)
          str += `${params[i].marker}${params[i].seriesName}${sourceBadge}: ${Number.isFinite(value) ? value.toFixed(2) : '-'}${seriesUnit[params[i].seriesIndex] || ''}</br>`
        }
        return str
      }
    },
    legend: {
      data: legendData
    },
    xAxis: [
      {
        type: 'category',
        data: xAxisData,
        axisPointer: {
          type: 'shadow'
        }
      }
    ],
    yAxis: yAxis,
    series: series
  })
}

function provisionalFinanceSourceLabel(value: any): string {
  if (!Number.isFinite(Number(value?.value))) return ''
  const source = value?.dataSource
  if (source === 'performance_report' || source === 'performance') return '快报'
  if (source === 'performance_forecast' || source === 'prediction') return '预告'
  return ''
}

async function codeInit() {
  const value = localStorage.getItem('codeNameMap')
  if (value !== null) {
    //以代码变量定义为准
    replaceRecordItems(codeNameMap, { ...JSON.parse(value), ...codeNameMap })
  }

  // @ts-ignore
  const codeStr: string = getUrlParam('code')
  if (codeStr) {
    replaceArrayItems(selectedCodes, codeStr.toUpperCase().split(','))
    setCurrentCode(selectedCodes[0])
    changeCodeSpecHref()
    const currentCode = getCurrentCode()

    const elem = document.getElementById('codeName')
    const callback = function (_data: any) {
      //修改标题
      document.getElementById('title')!.textContent = codeNameMap[currentCode]
      if (elem) {
        elem.textContent = `${codeNameMap[currentCode]}(${currentCode})`
      }
    }
  
    if (codeNameMap[currentCode]) {
      //修改标题
      document.getElementById('title')!.textContent = codeNameMap[currentCode]
      if (elem)
        {elem.textContent = `${codeNameMap[currentCode]}(${currentCode})`}
    } else {
      fetchCodeNames([currentCode], callback)
    }

    if (document.getElementById('currentPrice')) {
      const data = await fetchKline(currentCode, '') as number[][]
      if (!Array.isArray(data) || data.length === 0 || !Array.isArray(data[data.length - 1])) {
        console.warn('Kline data unavailable for current price', { code: currentCode, data })
        alert(`无法加载${currentCode}的K线数据`)
        return
      }
      const currentPrice = data[data.length-1][1]
      document.getElementById('currentPrice')!.textContent = currentPrice.toString()
      const thisYear = new Date().getFullYear()
      const arr: any = []
      let em = document.getElementById('priceChange')
      let idx = data.length-2
      arr.push([em, idx])

      em = document.getElementById('ytdPriceChange')
      let ts = new Date(thisYear, 0, 1).getTime()
      idx = findTsIndex(data, ts)
      if (idx < 0) {
        idx = 0
      }
      arr.push([em, idx])

      em = document.getElementById('last2NowPriceChange')
      ts = new Date(thisYear-1, 0, 1).getTime()
      idx = findTsIndex(data, ts)
      if (idx < 0) {
        idx = 0
      }
      arr.push([em, idx])

      arr.map((item: any)=>{
        const changeRatio = 100*currentPrice/data[item[1]][1] - 100
        item[0].textContent = changeRatio.toFixed(2) + '%'
        if (changeRatio > 0) {
          item[0].classList.add('text-danger')
        } else if (changeRatio < 0) {
          item[0].classList.add('text-success')
        }
      })
      
      // 计算并显示估值指标（包括市值）
      calculateAndDisplayValuation(currentCode, data, currentPrice)
    }
  }
}

export function changeCodeSpecHref() {
  // @ts-ignore
  const codeStr: string = getUrlParam('code')
  const elements = document.getElementsByName('codeSpec')
  if (!codeStr || !elements || elements.length === 0) {
    return
  }
  for (let i = 0; i < elements.length; i++) {
    //@ts-ignore
    let href: string = elements[i].getAttribute("href")
    if (href.indexOf('?') > -1) {
      href = href.split("?")[0]
    }
    elements[i].setAttribute("href", `${href}?code=${codeStr}`)
  }
}


export function renderFundInfoTable(code: string) {
  const cachekey = `${code}-fi`
  const info = cache[cachekey] as { name: string; manager: string; company: string; beginDate: string; updateDate: string; style: string; scale: string }
  codeNameMap[code] = info.name
  if (emitFundState({
    info: {
      code,
      name: info.name,
      manager: info.manager,
      company: info.company,
      beginDate: info.beginDate,
      updateDate: info.updateDate,
      style: info.style,
      scale: info.scale,
    },
    status: '基金信息已加载',
  })) {
    return
  }
  let html = '<tbody>'
  html += `<tr><td class="table-secondary">基金代码</td><td>${code}</td><td class="table-secondary">基金名称</td><td>${info.name}</td></tr>`
  html += `<tr><td class="table-secondary">基金经理</td><td>${info.manager}</td><td class="table-secondary">基金公司</td><td>${info.company}</td></tr>`
  html += `<tr><td class="table-secondary">基金成立日期</td><td>${info.beginDate}</td><td class="table-secondary">基金更新日期</td><td>${info.updateDate}</td></tr>`
  html += `<tr><td class="table-secondary">基金类型</td><td>${info.style}</td><td class="table-secondary">基金规模</td><td>${info.scale}</td></tr>`
  html === '</tbody>'
  document.getElementById('fundInfo')!.innerHTML = html
}


export function fillSelectOptions(options: any[], selectValue: number, tagid: string) {
  let html = ''
  const seleted = ' selected'
  let tag = ''
  for (let i = 0; i < options.length; i++) {
    if (options[i].value === selectValue) {
      tag = seleted
    } else {
      tag = ''
    }
    html += `<option value="${options[i].value}"${tag}>${options[i].text}</option>`
  }
  //@ts-ignore
  document.getElementById(tagid).innerHTML = html
}

//市场近期表现
export function marketProcess() {
  let codes: string[] = []
  if (selectedCodes.length === 0) {
    for (const item of securities) {
      cacheCodeName(item[0], item[1], true)
      if (item[2] === '0') {
        continue
      }
      codes.push(item[0])
    }
  } else {
    codes = selectedCodes
  }
  
  fetchKlines(codes, '', function () {
    generateMarketTable(codes)
  })
}

function emitFundState(patch: any): boolean {
  window.dispatchEvent(new CustomEvent('licai:fund-state', { detail: patch || {} }))
  return true
}

function setFundStatus(message: string): void {
  emitFundState({ status: message })
}

function getFundBaseKlineCodes(): string[] {
  const fq = (document.getElementById('klinePrice') as HTMLInputElement | null)?.value || ''
  return selectedCodes.map((code) => `${code}${fq}`)
}

export function klinePriceChange() {
  const fq = (document.getElementById('klinePrice') as HTMLInputElement).value
  setFundStatus('K线加载中...')
  fetchKlines(selectedCodes, fq, (codes)=> {
    try {
      klineCodes.length = 0
      codes.map(code => {
        klineCodes.push(code + fq)
        codeNameMap[code + fq] = codeNameMap[code]
      })
      try {
        rerenderMyChart()
      } catch (error) {
        console.error('klinePriceChange chart error:', error)
        setFundStatus(`K线图加载失败: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      try {
        genrateRegressTable()
      } catch (error) {
        console.error('klinePriceChange regress error:', error)
        setFundStatus(`年度回测加载失败: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      try {
        genratePerformanceTable(selectedCodes)
      } catch (error) {
        console.error('klinePriceChange performance error:', error)
        setFundStatus(`周期表现加载失败: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      if ((document.getElementById('positionCheck') as HTMLInputElement | null)?.checked) {
        positionCheckOnChange()
        return
      }
      setFundStatus(`K线已加载 ${selectedCodes.length} 个标的`)
    } catch (error) {
      console.error('klinePriceChange render error:', error)
      setFundStatus(`K线加载失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}

function reportDate2Quarter(str: string) {
  switch (str.substring(5, 10)) {
    case '03-31':
      return str.substring(0,4) + 'Q1'
    case '06-30':
      return str.substring(0,4) + 'Q2'
    case '09-30':
      return str.substring(0,4) + 'Q3'
    case '12-31':
      return str.substring(0,4) + 'Q4'
    default:
      return str
  }
}

//标记财报日期
export function marklineFinanceReportDate() {
  if ((document.getElementById('marklineFinanceReportDate') as HTMLInputElement).checked) {
    const success = function (codes: string[]) {
      const colors = ['blue', 'red', 'black']
      let colorIdx = 0
      for (const code of codes) {
        const reports = cache[`${code}-fsb`] as { reportDate: string; noticeDate: string }[]
        for (let i = 0; i < reports.length; i++) {
          markPoints.push({
            name: `财报公告: ${codeNameMap[code]}-${reportDate2Quarter(reports[i].reportDate)}`,
            x: toTimestamp(reports[i].noticeDate),
            color: colors[colorIdx]
          })
        }
        colorIdx = (colorIdx + 1)%colors.length
      }
      rerenderMyChart()
    }
    fetchCodesData(selectedCodes, fetchFinanceBalance, success)
  } else {
    //删除
    for (const code of selectedCodes) {
      const toDeleteIds = []
      for (let i=0;i < markPoints.length;i++) {
        const markPoint = markPoints[i] as { name: string }
        if (markPoint.name.startsWith(`财报公告: ${codeNameMap[code]}`)) {
          toDeleteIds.push(i)
        }
      }
      toDeleteIds.reverse().map(i => markPoints.splice(i, 1))
    }
    rerenderMyChart()
  }
}


export function positionCheckOnChange() {
  if (!(document.getElementById('positionCheck') as HTMLInputElement).checked) {
    replaceArrayItems(klineCodes, getFundBaseKlineCodes())
    rerenderMyChart()
    setFundStatus(`K线已加载 ${selectedCodes.length} 个标的`)
    return
  }
  setFundStatus('重仓股加载中...')
  fetchFundPosition(getCurrentCode(), 1, function (code) {
    const data = cache[`${code}-fp`] as any[]
    if (!data || data.length === 0 || !data[0] || !Array.isArray(data[0].data)) {
      setFundStatus(`K线已加载 ${selectedCodes.length} 个标的`)
      return
    }
    const codes: string[] = []
    for (const position of data[0].data) {
      codeNameMap[position[0]] = position[1]
      codes.push(position[0])
    }

    fetchKlines(codes, '', function () {
      try {
        replaceArrayItems(klineCodes, getFundBaseKlineCodes())
        klineCodes.push(...codes)
        rerenderMyChart()
        setFundStatus(`K线已加载 ${selectedCodes.length} 个标的，叠加 ${codes.length} 个重仓股`)
      } catch (error) {
        console.error('positionCheckOnChange render error:', error)
        setFundStatus(`重仓股加载失败: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  })
}












export function klineOptionsInit() {
  document.getElementById('klineOptions')!.addEventListener('change', klineOptionsChange)
  bsSelect('klineOptions', {
    placeholder: '财务指标...',
    noSearch: true,
    urlParam: 'klineOptions'
  })
}

//对齐开始日期
export function onAlignStartCheckChange(checked: boolean) {
  let startTs = 0
  if (checked) {
    startTs = new Date((document.getElementById('dateRange-start') as HTMLInputElement).value).getTime()
    ;(document.getElementById('alignStart') as any).dataset.ts = startTs.toString()
    for (const code of klineCodes) {
      const codeData = cache[code] as any[]
      if (codeData && codeData.length > 0 && codeData[0][0] > startTs) {
        startTs = codeData[0][0]
      }
    }
  } else {
    startTs = parseInt((document.getElementById('alignStart') as any).dataset.ts)
  }
  changeDateRangeStart('dateRange', startTs)
}

export function fetch2FormatFinanceData(codes: string[], callback: (codes: string[])=>void) {
  const should = 3
  let done = 0
  const success = function (codes: string[]) {
    done++
    if (done === should) {
      replaceRecordItems(runtimeState.reportsMap, formatFinanceData(codes))
      callback(codes)
    }
  }

  fetchCodesData(selectedCodes, fetchFinanceIncome, success)
  fetchCodesData(selectedCodes, fetchFinanceBalance, success)
  fetchCodesData(selectedCodes, fetchFinanceCashflow, success)
}

//将财报数据按照年或者季度进行格式化
function formatFinanceData(codes: string[]) {
  const compareType: string = (document.getElementById('compareType') as any).dataset.id
  const reportsMap: any = {}
  //利润表要考虑累加、资产负债表只取对应的报告就行了
  for (const code of codes) {
    const reports: any = []
    //利润表
    let cacheKey = `${code}-fsi`
    let reportYear = ''
    const cacheData = cache[cacheKey] as any[]
    for (const report of cacheData) {
      if (compareType ==='yearly' && report.reportDate.substring(0, 4) === reportYear && reports.length > 0) {
        //累加年度的
        const i = reports.length - 1
        const mergedSource = mergeFinancialDataSource(reports[i].dataSource, report.dataSource)
        reports[i].dataSource = mergedSource
        reports[i].dataSourceLabel = financialDataSourceLabel(mergedSource)
        for (const key in report) {
          if (['reportDate', 'noticeDate', 'dataSource', 'dataSourceLabel'].includes(key)) {
            continue
          }
          if (reports[i][key]) {
            reports[i][key] += report[key]
          } else {
            reports[i][key] = report[key]
          }
        }
      } else {
        reports.push({ ...report })
        reportYear = report.reportDate.substring(0, 4)
      }
    }

    //资产负债表balance
    cacheKey = `${code}-fsb`
    let idx = 0
    const balanceCacheData = cache[cacheKey] as any[]
    for (let i = 0; i < reports.length; i++) {
      for (let j= idx; j < balanceCacheData.length; j++) {
        if (reports[i].reportDate === balanceCacheData[j].reportDate) {
          //同日期的找到了
          for (const key in balanceCacheData[j]) {
            if (['dataSource', 'dataSourceLabel'].includes(key)) {
              continue
            }
            reports[i][key] = balanceCacheData[j][key]
          }
        }
      }
    }

    //现金流量表
    cacheKey = `${code}-fsc`
    idx = 0
    const cashCacheData = cache[cacheKey] as any[]
    for (let i = 0; i < reports.length; i++) {
      for (let j= idx; j < cashCacheData.length; j++) {
        //日期相同，或者年报年相同
        if (reports[i].reportDate === cashCacheData[j].reportDate || (compareType === 'yearly' && reports[i].reportDate.substring(0,4) === cashCacheData[j].reportDate.substring(0,4))) {
          //同时间的找到了
          for (const key in cashCacheData[j]) {
            if (['reportDate', 'noticeDate', 'dataSource', 'dataSourceLabel'].includes(key)) {
              continue
            }
            //存在就累加，不存在就赋值
            if (reports[i][key]) {
              reports[i][key] += cashCacheData[j][key]
            } else {
              reports[i][key] = cashCacheData[j][key]
            }
          }
        }
      }
    }

    //额外计算几个指标
    for (let i=0;i< reports.length;i++) {
      //银行可能只有operateIncome没有totalOperateIncome
      if (!reports[i].totalOperateIncome && reports[i].operateIncome) {
        reports[i].totalOperateIncome = reports[i].operateIncome
      }
      //总资产收益率
      reports[i].roa = 100*reports[i].netProfit/reports[i].totaAssets
      //净资产收益率
      reports[i].roe = 100*reports[i].netProfit/reports[i].totalEquity
      //毛利润率
      reports[i].grossProfitRatio = 100*reports[i].grossProfit/reports[i].totalOperateIncome
      //营业净利润率
      reports[i].netProfitRatio = 100*reports[i].netProfit/reports[i].totalOperateIncome
      //归母净利润率，与主图的归母净利润柱保持同一口径
      reports[i].parentNetprofitRatio = 100*reports[i].parentNetprofit/reports[i].totalOperateIncome
      //总资产周转率
      reports[i].totalAssetsTurnover = reports[i].totalOperateIncome/reports[i].totaAssets
      //资产负债率
      reports[i].assetLiabRatio = 100*reports[i].totalLiabilities/reports[i].totaAssets
      //权益乘数
      reports[i].equityMultiplier = 100/(100-reports[i].assetLiabRatio)
    }

    reportsMap[code] = reports
  }
  return reportsMap
}

function mergeFinancialDataSource(left: unknown, right: unknown): string {
  const sources = [String(left || ''), String(right || '')]
  if (sources.includes('performance_forecast') || sources.includes('prediction')) return 'performance_forecast'
  if (sources.includes('performance_report') || sources.includes('performance')) return 'performance_report'
  return 'financial_report'
}

function financialDataSourceLabel(source: unknown): string {
  if (source === 'performance_forecast' || source === 'prediction') return '业绩预告'
  if (source === 'performance_report' || source === 'performance') return '业绩快报'
  return '正式财报'
}

export function genFinanceChartTable(codes: string[]) {
  genFinanceChart('financeChart', codes, ['totalOperateIncome', 'parentNetprofit', 'deductParentNetprofit'], ['总营收', '归母净利润', '扣非归母净利润'], {
    includeQuarterOnQuarter: true,
    percentageLines: [
      { key: 'grossProfitRatio', name: '毛利率' },
      { key: 'parentNetprofitRatio', name: '归母净利率' },
    ],
  })
  genFinanceCoreTable(codes)
  genFinanceIncomeTable(codes)
  genFinanceBalanceTable(codes)
  genFinanceCashflowTable(codes)
}

type CompanyFinanceTableCellState = {
  growthClass: string
  growthText: string
  isEmpty: boolean
  ratioText: string
  valueText: string
}

type CompanyFinanceTableRowState = {
  cells: CompanyFinanceTableCellState[]
  chartKey: string
  label: string
  labelClass: string
}

type CompanyFinanceTableHeaderGroup = {
  className: string
  colspan: number
  text: string
}

type CompanyFinanceTableCodeHeader = {
  className: string
  code: string
  name: string
}

type CompanyFinanceTableState = {
  codeHeaders: CompanyFinanceTableCodeHeader[]
  headerGroups: CompanyFinanceTableHeaderGroup[]
  ratioByPercent: boolean
  rows: CompanyFinanceTableRowState[]
  tableId: string
  tableName: string
}

function emitCompanyFinanceState(patch: any): boolean {
  window.dispatchEvent(new CustomEvent('licai:company-finance-state', { detail: patch || {} }))
  return true
}

function companyFinanceTablePatchKey(tableId: string): string {
  switch (tableId) {
    case 'coreTable':
      return 'coreTable'
    case 'incomeTable':
      return 'incomeTable'
    case 'balanceTable':
      return 'balanceTable'
    case 'cashflowTable':
      return 'cashflowTable'
    default:
      return tableId
  }
}

function buildFinanceTableState(codes: string[], tableName: string, keys: string[][], ratioByKey: string | null, tableId: string): CompanyFinanceTableState {
  const typedReportsMap = runtimeState.reportsMap as Record<string, any[]>
  const {offsetMap} = getOffsetAndCompareText(typedReportsMap)
  // @ts-ignore
  const seasons = parseInt(document.getElementById('seasons').value)
  // @ts-ignore
  const yoyRatio = parseInt(document.getElementById('yoyRatio').value)
  // @ts-ignore
  const displayEmpty: boolean = document.getElementById('displayEmpty').checked
  let maxReportDate = ''
  for (const code of codes) {
    if (!maxReportDate || typedReportsMap[code][0].reportDate > maxReportDate) {
      maxReportDate = typedReportsMap[code][0].reportDate
    }
  }

  const rawRows: Array<Array<[any, any, any]>> = []
  const reportDates: string[] = []
  const tableColors = ['dark', 'success', 'danger', 'warning']
  for (const kr of keys) {
    const key = kr[0]
    const row: Array<[any, any, any]> = []
    for (let i = 0; i < seasons; i++) {
      for (const code of codes) {
        const item: [any, any, any] = ['-', '-', '-']
        if (i >= typedReportsMap[code].length || (i === 0 && typedReportsMap[code][0].reportDate < maxReportDate)) {
          row.push(item)
          continue
        }
        if (!reportDates[i]) {
          reportDates[i] = typedReportsMap[code][i].reportDate
        }
        item[0] = typedReportsMap[code][i][key]
        if (i + offsetMap[code] < typedReportsMap[code].length) {
          item[1] = typedReportsMap[code][i][key] / typedReportsMap[code][i + offsetMap[code]][key] - 1
        }
        if (ratioByKey) {
          item[2] = typedReportsMap[code][i][key] / typedReportsMap[code][i][ratioByKey]
        }
        row.push(item)
      }
    }
    rawRows.push(row)
  }

  const headerGroups = reportDates.filter(Boolean).map((date, index) => ({
    className: `table-${tableColors[index % 4]}`,
    colspan: codes.length,
    text: date,
  }))
  const colors = ['primary', 'success', 'danger', 'warning', 'info']
  const codeHeaders: CompanyFinanceTableCodeHeader[] = []
  for (let i = 0; i < seasons; i++) {
    for (let j = 0; j < codes.length; j++) {
      codeHeaders.push({
        className: `table-${colors[j % colors.length]}`,
        code: codes[j],
        name: codeNameMap[codes[j]],
      })
    }
  }

  const rows: CompanyFinanceTableRowState[] = []
  for (let i = 0; i < rawRows.length; i++) {
    if (!displayEmpty) {
      let valid = false
      for (const item of rawRows[i]) {
        if (item[0] && item[0] !== '-') {
          valid = true
          break
        }
      }
      if (!valid) {
        continue
      }
    }

    rows.push({
      chartKey: keys[i][0],
      label: keys[i][1],
      labelClass: keys[i][5] ? `text-${keys[i][5]}` : '',
      cells: rawRows[i].map((item) => {
        if (!item[0] || item[0] === '-') {
          return {
            growthClass: '',
            growthText: '-',
            isEmpty: true,
            ratioText: '',
            valueText: '-',
          }
        }
        let color = 'text-body'
        if (item[1] > yoyRatio / 100) {
          color = 'text-danger'
        } else if (item[1] < 0) {
          color = 'text-success'
        }
        return {
          growthClass: color,
          growthText: formatReportNumber(item[1], true),
          isEmpty: false,
          ratioText: ratioByKey ? formatReportNumber(item[2], true) : '',
          valueText: formatReportNumber(item[0], false),
        }
      }),
    })
  }

  return {
    codeHeaders,
    headerGroups,
    ratioByPercent: Boolean(ratioByKey),
    rows,
    tableId,
    tableName,
  }
}

function genFinanceCoreTable(codes: string[]) {
  genFinanceTable(codes, '核心指标', coreKeys, null, 'coreTable')
}

function genFinanceIncomeTable(codes: string[]) {
  genFinanceTable(codes, '利润表', incomeKeys, 'totalOperateIncome', 'incomeTable')
}

function genFinanceBalanceTable(codes: string[]) {
  genFinanceTable(codes, '资产负债表', balanceKeys, 'totaAssets', 'balanceTable')
}


function genFinanceCashflowTable(codes: string[]) {
  genFinanceTable(codes, '现金流量表', cashflowKeys, 'endCce', 'cashflowTable')
}

function genFinanceTable(codes: string[], tableName: string, keys: string[][], ratioByKey: string|null, tableId: string) {
  const state = buildFinanceTableState(codes, tableName, keys, ratioByKey, tableId)
  const patchKey = companyFinanceTablePatchKey(tableId)
  emitCompanyFinanceState({ [patchKey]: state })
}

export function fillReportDates(id: string, selectIdx: number) {
  const dates = genReportDates(3)
  let html = ''
  const seleted = ' selected'
  let tag = ''
  for (let i = 0; i < dates.length; i++) {
    if (i === selectIdx) {
      tag = seleted
    } else {
      tag = ''
    }
    html += `<option value="${dates[i]}"${tag}>${dates[i]}</option>`
  }
  //@ts-ignore
  document.getElementById(id).innerHTML = html
}

function follow(code: string) {
  let followArr: string[] = []
  const followStr = localStorage.getItem('follow')
    if (followStr) {
      followArr = followStr.split(',')
    }
    followArr.push(code)
    localStorage.setItem('follow', followArr.join(','))
}

function unFollow(code: string) {
  let followArr: string[] = []
  const followStr = localStorage.getItem('follow')
    if (followStr) {
      followArr = followStr.split(',')
    }
    const idx = followArr.indexOf(code)
    if (idx > -1) {
      followArr.splice(idx, 1)
    }

    localStorage.setItem('follow', followArr.join(','))
}



//星标点击
export function onStarClick() {
  document.querySelectorAll('img[name="star"]').forEach((elem: any)=>{
    if (elem.dataset.bound === '1') {
      return
    }
    elem.dataset.bound = '1'
    elem.addEventListener('click', (e: any)=>{
      e.preventDefault()
      if (elem.getAttribute('src') === 'images/star.png') {
        elem.setAttribute('src', 'images/star2.png')
        unFollow(elem.dataset.code)
      } else {
        elem.setAttribute('src', 'images/star.png')
        follow(elem.dataset.code)
      }
    })
  })
}
























//select下拉选择值
export function selectChangeValue(id: string, value: string) {
  //@ts-ignore
  const select: HTMLSelectElement = document.getElementById(id)
  select.value = value
  select.querySelectorAll('option').forEach((elem)=> {
    if (elem.value === value) {
      elem.setAttribute('selected', '')
    }
  })
}





//管理规模趋势


















//基础公共初始化，所有页面都调用
async function commonInit(): Promise<void> {
  await codeInit()
}

// 生成管理规模趋势图表
function genSimpleBarLineChart(id: string, codes: string[], data: any, yKeys: string[], yKeyNames: string[], xKey: string, yUnit: string, seasons: number) {
  const myChart = echarts.init(document.getElementById(id) as HTMLElement)
  const grid: any = {
    left: '3%',
    right: '4%',
    bottom: '3%',
    containLabel: true
  }
  const xAxis: any = {
    type: 'category',
    data: []
  }
  const yAxis: any = {
    type: 'value',
    axisLabel: {
      formatter: '{value}' + yUnit
    }
  }
  const legend: any = {
    data: yKeyNames,
    top: 'bottom'
  }
  const series: any = []

  for (let i=0;i<codes.length;i++) {
    for (let j=0;j<yKeys.length;j++) {
      const s: any = {
        name: yKeyNames[j],
        type: 'bar',
        data: []
      }
      for (let k=0;k<seasons;k++) {
        const item = data[codes[i]][k]
        if (!item) {
          s.data.push('-')
          continue
        }
        s.data.push(item[yKeys[j]] || '-')
        if (i===0) {
          xAxis.data.push(item[xKey])
        }
      }
      series.push(s)
    }
  }

  const option: any = {
    color: ['#5470c6', '#91cc75', '#fac858', '#ee6666', '#73c0de', '#3ba272', '#fc8452', '#9a60b4', '#ea7ccc'],
    tooltip: {
      trigger: 'axis',
      axisPointer: {
        type: 'shadow'
      }
    },
    legend: legend,
    grid: grid,
    xAxis: xAxis,
    yAxis: yAxis,
    series: series
  }

  myChart.setOption(option)
  window.addEventListener('resize', function() {
    myChart.resize()
  })
}

// 弹窗显示图表
function chartModalShow(event: any) {
  const key = event.relatedTarget.dataset.key
  const it = [...coreKeys, ...incomeKeys, ...balanceKeys, ...cashflowKeys].find((item)=> item[0] === key)
  if (!it) {
    console.log('chartModalShow not found key', key)
    return
  }
  genFinanceChart('singleChart', selectedCodes, [key], [it[1]])
}

// 财务图表表格变化处理
function financeCharTableOnChange() {
  fetch2FormatFinanceData(selectedCodes, genFinanceChartTable)
}

// 财务代码选择变化处理
function onFinanceCodeSelectChange() {
  replaceArrayItems(selectedCodes, selectedOptionValues(document.getElementById('codes')))
  if (selectedCodes.length === 0) {
    console.log('codes none')
    return
  }
  
  changeCodeSpecHref()
  financeCharTableOnChange()
}

// 计算并显示估值指标
function calculateAndDisplayValuation(code: string, data: number[][], currentPrice: number) {
  let stockValuation = ''
  const financeCacheKey = `${code}-fsi`
  const shareChangeCacheKey = `${code}-sc`
  
  const calculateValuation = () => {
    const financeData = cache[financeCacheKey]
    const shareChangeData = cache[shareChangeCacheKey]
    
    // 获取总股本（从股本变动数据）
    let totalShares = null
    if (shareChangeData && Array.isArray(shareChangeData) && shareChangeData.length > 0) {
      totalShares = shareChangeData[0].totalShares // 最新总股本（股）
    }
    
    // 计算市值 = 股价 × 总股本
    if (totalShares && totalShares > 0) {
      const marketCap = currentPrice * totalShares // 市值（元）
      document.getElementById('marketCap')!.textContent = (marketCap / 1e8).toFixed(2)
    } else {
      document.getElementById('marketCap')!.textContent = '暂无数据'
    }
    
    if (financeData && Array.isArray(financeData) && financeData.length > 0) {
      // 使用净利润计算PE TTM
      // PE TTM = 市值 / 最近4个季度的净利润之和
      if (totalShares && totalShares > 0 && financeData.length >= 4) {
        const marketCap = currentPrice * totalShares // 市值（元）
        const trailingProfits = financeData
          .slice(0, 4)
          .map((item) => Number(item.parentNetprofit))
          .filter((profit) => Number.isFinite(profit))
        const totalNetProfit = trailingProfits.reduce((sum, profit) => sum + profit, 0)

        if (trailingProfits.length === 4 && totalNetProfit > 0) {
          // 净利润单位是元，市值也是元，直接相除
          const pe = marketCap / totalNetProfit
          stockValuation += `<span class="px-1">PE(TTM): ${pe.toFixed(2)}</span>`
        }
      }
    }
    
    if (!stockValuation) {
      stockValuation = `<span class="px-1">PE: 暂无数据</span>`
    }
    
    document.getElementById('stockValuation')!.innerHTML = stockValuation
  }
  
  // 检查数据是否都已缓存
  const financeCached = cache[financeCacheKey] !== undefined
  const shareChangeCached = cache[shareChangeCacheKey] !== undefined
  
  if (financeCached && shareChangeCached) {
    calculateValuation()
  } else {
    // 获取财务数据
    if (!financeCached) {
      fetchFinanceIncome(code, () => {
        if (shareChangeCached || cache[shareChangeCacheKey] !== undefined) {
          calculateValuation()
        }
      })
    }
    
    // 获取股本变动数据
    if (!shareChangeCached) {
      fetchRequest(`${server}/api/finance/sharechange?code=${code}`).then((data: any) => {
        cache[shareChangeCacheKey] = data
        if (financeCached || cache[financeCacheKey] !== undefined) {
          calculateValuation()
        }
      })
    }
  }
}

// 基金公司筛选
function gsSelectInit(id: string, placeholder: string) {
  bsSelect(id, {
    placeholder: placeholder,
    cache: true,
    request: (_term: string)=> {
      return {
        url: '/api/fund/companies',
        params: {}
      }
    },
    transResults: (data: any, term: string)=>{
      const gs = data.data.data
      const result: any = []
      for (const item of gs) {
        if (term === undefined || term === '' || item[1].indexOf(term) > -1) {
          result.push({ id: item[0], name: item[1] })
        }
      }
      return result
    }
  })
}

async function loadEtfCodes() {
  try {
    const response = await fetch(`${server}/api/stock/etf-codes`)
    const result = await response.json()
    if (result.code === 200) {
      replaceArrayItems(runtimeState.etfCodes, result.data || [])
      for (const etf of runtimeState.etfCodes) {
        codeNameMap[etf.code] = etf.name
      }
    }
  } catch (error) {
    console.error('Failed to load ETF codes:', error)
  }
}

const legacyPageContext = {
  server,
  fetchRequest,
  bsSelect,
  selectedOptionValues,
  hash,
  generateMarketDataMap,
  fetchKlines,
  follow,
  unFollow,
  cacheCodeName,
  fetchKline,
  generateMarketTable,
  query,
  replaceUrlParam,
  getCode: getCurrentCode,
  fetchCompanyFreeHolders,
  fetchCompanyOrgHolders,
  getCache: () => cache,
  queryString,
  alert,
  gsSelectInit,
  getCodeNameMap: () => codeNameMap,
  getReportsMap: () => runtimeState.reportsMap,
  setSelectedCodes: (codes: string[]) => {
    replaceArrayItems(selectedCodes, codes)
  },
  fetch2FormatFinanceData,
  codeSelectInit,
  bsRadioButtons,
  parseResponseData,
  escapeHtml,
  echartsColor,
  echarts,
  zeroPad,
  fetchReportUrl,
  toDateString,
  selectChangeValue,
  cache,
  genFullCode,
  onStarClick,
  reportAnalysisCacheVersion,
  financeCharTableOnChange,
  onFinanceCodeSelectChange,
  getSelectedCodes: () => selectedCodes,
  coreKeys,
  incomeKeys,
  balanceKeys,
  cashflowKeys,
  fetchCodeNames,
  fetchFinanceIncome,
  fetchCodesData,
  fetchShareAdditional,
  fetchShareChange,
  toTimestamp,
  rerenderMyChart,
  dateRangeInit,
  klineOptionsInit,
  marketProcess,
  onKlineCodeSelectChange,
  klinePriceChange,
  marklineFinanceReportDate,
  onRatioCheckChange,
  onAlignStartCheckChange,
  getKlineCodes: () => klineCodes,
  fetchFundPosition,
  fetchFundInfo,
  renderFundInfoTable,
  fetchCompanyInfo,
  fillSelectOptions,
  bsTable,
  findTsIndex,
  positionCheckOnChange,
  emitFundState,
  loadEtfCodes,
  getEtfCodes: () => runtimeState.etfCodes,
  setKlineCodes: (codes: string[]) => {
    replaceArrayItems(klineCodes, codes)
  },
  genratePerformanceTable,
  genFinanceChart,
  genSimpleBarLineChart,
  runtimeState,
}

export async function runPageInit(page: string = currentPage()): Promise<void> {
  await commonInit()
  const initPage = await loadLegacyPageInitializer(page, legacyPageContext)
  if (!initPage) {
    console.log('wrong page', page)
    return
  }
  await initPage()
}
