import { cellColor } from '../../../table'

type CompanyPageTableCellState = {
  className: string
  href?: string
  target?: string
  text: string
}

type CompanyPageTableRowState = {
  cells: CompanyPageTableCellState[]
  rowKey: string
}

type CompanyPageTableState = {
  columns: Array<{ key: string, label: string, sortable?: boolean }>
  rows: CompanyPageTableRowState[]
  tableId: string
}

type CompanyTableRuntimeContext = {
  cache: Record<string, unknown>
  codeNameMap: Record<string, string>
  days: number[]
  selectedCodes: string[]
}

function companyPageTableCell(value: any, color: boolean, href?: string): CompanyPageTableCellState {
  return {
    className: color ? cellColor(value) : '',
    href,
    target: href ? '_blank' : undefined,
    text: String(value),
  }
}

export function createCompanyTableRuntime(context: CompanyTableRuntimeContext) {
  const { cache, codeNameMap, days, selectedCodes } = context

  function emitCompanyPageState(patch: any): boolean {
    const snapshotHost = window as typeof window & { __licaiCompanyPageState?: Record<string, unknown> }
    snapshotHost.__licaiCompanyPageState = {
      ...(snapshotHost.__licaiCompanyPageState || {}),
      ...(patch || {}),
    }
    window.dispatchEvent(new CustomEvent('licai:company-page-state', { detail: patch || {} }))
    return true
  }

  function emitStockTableState(patch: any): boolean {
    window.dispatchEvent(new CustomEvent('licai:stock-table-state', { detail: patch || {} }))
    return true
  }

  function generateMarketDataMap(codes: string[], rangeDays: number[]) {
    const dataMap: any = {}
    for (const code of codes) {
      if (!cache[code]) {
        continue
      }

      const kline = cache[code] as number[][]
      const row: any[] = []
      const high: Record<number, number> = {}
      const low: Record<number, number> = {}
      const lastDayTs = kline[kline.length - 1][0]
      for (let j = kline.length - 1; j >= 0; j -= 1) {
        if (j === kline.length - 1) {
          row.push(kline[j][1])
        } else if (j === kline.length - 2) {
          row.push(((row[0] - kline[j][1]) * 100 / kline[j][1]).toFixed(2))
        }

        for (let k = 0; k < rangeDays.length; k += 1) {
          if (!(rangeDays[k] in high)) {
            high[rangeDays[k]] = 0
          }
          if (!(rangeDays[k] in low)) {
            low[rangeDays[k]] = 9999999
          }

          const ts = lastDayTs - 24 * 3600 * 1000 * rangeDays[k]
          if (ts < kline[j][0]) {
            if (kline[j][1] > high[rangeDays[k]]) {
              high[rangeDays[k]] = kline[j][1]
            }
            if (kline[j][1] < low[rangeDays[k]]) {
              low[rangeDays[k]] = kline[j][1]
            }
          } else if (row.length <= 2 + k * 2) {
            row.push(((row[0] - high[rangeDays[k]]) * 100 / high[rangeDays[k]]).toFixed(2))
            row.push(((row[0] - low[rangeDays[k]]) * 100 / low[rangeDays[k]]).toFixed(2))
          }
        }
      }

      dataMap[code] = row
    }

    return dataMap
  }

  function genratePerformanceRows(codes: string[]) {
    const rows = []
    for (const code of codes) {
      let j = 0
      const row: (string | number)[] = [code, codeNameMap[code]]
      const codeData = cache[code] as number[][]
      if (!codeData || !codeData.length) {
        console.error('[Performance] No data for code:', code)
        continue
      }
      const lastDayTs = codeData[codeData.length - 1][0]
      const currentPrice = codeData[codeData.length - 1][1]
      for (let i = codeData.length - 1; i >= 0; i -= 1) {
        if (i === codeData.length - 1) {
          row.push(codeData[i][1])
        } else if (i === codeData.length - 2) {
          row.push((currentPrice - codeData[i][1]) * 100 / codeData[i][1])
        }

        const ts = lastDayTs - 24 * 3600 * 1000 * days[j]
        if (codeData[i][0] < ts) {
          row.push((currentPrice - codeData[i][1]) * 100 / codeData[i][1])
          j += 1
        }

        if (j === days.length) {
          break
        }
      }

      for (let k = 2; k < row.length; k += 1) {
        if (typeof row[k] === 'number') {
          row[k] = (row[k] as number).toFixed(2)
        }
      }

      for (let k = row.length; k < 4 + days.length; k += 1) {
        row.push('-')
      }

      rows.push(row)
    }

    return rows
  }

  function buildCompanyPerformanceTableState(codes: string[]): CompanyPageTableState {
    const rows = genratePerformanceRows(codes)
    const columns = [
      { key: 'code', label: '周期表现' },
      { key: 'name', label: '名称简称' },
      { key: 'latestPrice', label: '最新价格' },
      { key: 'latestChangePct', label: '最新涨跌幅(%)', sortable: true },
      ...days.map((day) => ({ key: `vs${day}`, label: `相比${day}日(%)`, sortable: true })),
    ]
    return {
      columns,
      rows: rows.map((row: any[]) => ({
        rowKey: String(row[0] || ''),
        cells: row.map((cell, index) => companyPageTableCell(cell, index > 2)),
      })),
      tableId: 'performance',
    }
  }

  function getYearsTs(years: number): number[] {
    const yearsTs: number[] = []
    const date = new Date()
    for (let i = 0; i < years; i += 1) {
      yearsTs.push(new Date(date.getFullYear() - i, date.getMonth(), date.getDate()).getTime())
    }
    return yearsTs
  }

  function genrateRegressRows(yearsTs: number[]): any[] {
    const rows: any[] = []
    for (const code of selectedCodes) {
      if (!cache[code] || !Array.isArray(cache[code]) || (cache[code] as any[]).length === 0) {
        const row = [code, codeNameMap[code] || code]
        for (let k = row.length; k < 2 + yearsTs.length; k += 1) {
          row.push('-')
        }
        rows.push(row)
        continue
      }

      const row = [code, codeNameMap[code]]
      let maxDrop = 0.0
      let minPrice = 9999999.9
      const cacheData = cache[code] as number[][]
      let yearEndPrice = cacheData[cacheData.length - 1][1]
      let j = 0
      for (let i = cacheData.length - 1; i >= 0; i -= 1) {
        const ts = yearsTs[j]
        if (cacheData[i][0] < ts) {
          const profit = yearEndPrice * 100.0 / cacheData[i][1] - 100.0
          maxDrop = maxDrop * 100.0

          row.push(`${profit.toFixed(2)}/${maxDrop.toFixed(2)}`)
          maxDrop = 0.0
          yearEndPrice = minPrice = cacheData[i][1]
          j += 1
        }

        if (j === yearsTs.length) {
          break
        }

        const value = cacheData[i][1]
        if (value < minPrice) {
          minPrice = value
        }

        if ((value - minPrice) / value > maxDrop) {
          maxDrop = (value - minPrice) / value
        }
      }

      for (let k = row.length; k < 2 + yearsTs.length; k += 1) {
        row.push('-')
      }

      rows.push(row)
    }

    return rows
  }

  function buildCompanyRegressTableState(): CompanyPageTableState {
    const years = 10
    const yearsTs = getYearsTs(years)
    const rows = genrateRegressRows(yearsTs)
    const columns = [
      { key: 'code', label: '年度回测' },
      { key: 'name', label: '名称简称' },
      ...yearsTs.map((yearTs, index) => ({ key: `year-${index}`, label: `${new Date(yearTs).getFullYear()}年收益/回撤(%)`, sortable: true })),
    ]
    return {
      columns,
      rows: rows.map((row: any[]) => ({
        rowKey: String(row[0] || ''),
        cells: row.map((cell) => companyPageTableCell(cell, false)),
      })),
      tableId: 'regress',
    }
  }

  function buildCompanyMarketTableState(codes: string[]): CompanyPageTableState {
    const dataMap = generateMarketDataMap(codes, days)
    const rows: any[] = []
    for (const code of codes) {
      let row = [code, codeNameMap[code]]
      row = row.concat(dataMap[code] || [])
      for (let k = row.length; k < 4 + days.length * 2; k += 1) {
        row.push('-')
      }
      rows.push(row)
    }
    const columns = [
      { key: 'code', label: '市场表现' },
      { key: 'name', label: '名称简称' },
      { key: 'latestPrice', label: '最新价' },
      { key: 'latestChangePct', label: '最新涨幅(%)', sortable: true },
      ...days.flatMap((day) => ([
        { key: `high${day}`, label: `比${day}日高(%)`, sortable: true },
        { key: `low${day}`, label: `比${day}日低(%)`, sortable: true },
      ])),
    ]
    return {
      columns,
      rows: rows.map((row: any[]) => ({
        rowKey: String(row[0] || ''),
        cells: row.map((cell, index) => companyPageTableCell(cell, index > 2, index === 0 ? `company.html?code=${encodeURIComponent(String(row[0] || ''))}` : undefined)),
      })),
      tableId: 'market',
    }
  }

  function genratePerformanceTable(codes: string[]) {
    emitStockTableState({ performanceTable: buildCompanyPerformanceTableState(codes) })
    emitCompanyPageState({ performanceTable: buildCompanyPerformanceTableState(codes) })
  }

  function genrateRegressTable(): void {
    emitCompanyPageState({ regressTable: buildCompanyRegressTableState() })
  }

  function generateMarketTable(codes: string[]) {
    emitCompanyPageState({ marketTable: buildCompanyMarketTableState(codes) })
  }

  return {
    emitCompanyPageState,
    emitStockTableState,
    genratePerformanceTable,
    genrateRegressTable,
    generateMarketDataMap,
    generateMarketTable,
  }
}
