type CompanyDividendFetchRequest = (request: {
  url?: string
  params?: Record<string, unknown>
  data?: unknown
  cacheKey?: string
  cacheTtl?: number
}) => Promise<unknown>

type CompanyDividendRuntimeContext = {
  getCode: () => string
  server: string
  fetchRequest: CompanyDividendFetchRequest
  fetchKline: (code: string, fq: string) => Promise<any>
  fetchShareAdditional: (code: string, callback: (data: any) => void) => void
  findTsIndex: (rows: any[], ts: number) => number
  toTimestamp: (value: string) => number
}

export function createCompanyDividendInitializer(context: CompanyDividendRuntimeContext) {
  const { server, fetchRequest, fetchKline, fetchShareAdditional, findTsIndex, toTimestamp } = context

  function currentCode(): string {
    return context.getCode()
  }

  function emitCompanyDividendState(patch: any): void {
    window.dispatchEvent(new CustomEvent('licai:company-dividend-state', { detail: patch || {} }))
  }

  function mapCompanyBonusRows(rows: any[]): any[] {
    return rows.map((row: any[]) => ({
      noticeDate: String(row[0] || ''),
      plan: String(row[1] || ''),
      progress: String(row[2] || ''),
      recordDate: String(row[3] || ''),
      divDate: String(row[4] || ''),
      recordPrice: String(row[5] || ''),
      recordYield: String(row[6] || ''),
      latestYield: String(row[7] || ''),
      bonusTotal: String(row[8] || ''),
    }))
  }

  function mapCompanyShareAdditionalRows(rows: any[]): any[] {
    return rows.map((row: any[]) => ({
      noticeDate: String(row[0] || ''),
      issueNum: String(row[1] || ''),
      netRaiseFunds: String(row[2] || ''),
      issuePrice: String(row[3] || ''),
      issueWay: String(row[4] || ''),
      recordDate: String(row[5] || ''),
      noticeDateClose: String(row[6] || ''),
      recordDateClose: String(row[7] || ''),
    }))
  }

  async function companyBonusTable() {
    const code = currentCode()
    let kline: any
    let dividend: any
    let dividendYield: any
    const should = 3
    let done = 0

    const success = () => {
      done += 1
      if (done < should) {
        return
      }
      if (!dividend || dividend.length < 1) {
        emitCompanyDividendState({ bonusRows: [] })
        return
      }

      const rows: any[] = []
      for (const item of dividend) {
        const ts = item.recordDate
          ? toTimestamp(item.recordDate)
          : item.divDate
            ? toTimestamp(item.divDate)
            : toTimestamp(item.noticeDate) + 3600 * 1000 * 24 * 90
        const idx = findTsIndex(kline, ts)
        if (idx < 0) {
          continue
        }
        const bonusRatio = (100 * item.bonus / kline[idx][1]).toFixed(2)
        const bonusRatioToday = (100 * item.bonus / kline[kline.length - 1][1]).toFixed(2)
        const bonusTotal = Number(item.bonusTotal)
        rows.push([
          item.noticeDate,
          item.plan,
          item.progress,
          item.recordDate || '',
          item.divDate || '',
          kline[idx][1],
          bonusRatio,
          bonusRatioToday,
          Number.isFinite(bonusTotal) ? (bonusTotal / 1e8).toFixed(2) : '',
        ])
      }

      if (dividendYield?.currentYield > 0) {
        const yieldElem = document.getElementById('currentBonusRatio')
        if (yieldElem) {
          yieldElem.textContent = `股息率: ${dividendYield.currentYield.toFixed(2)}%`
        }
      }
      emitCompanyDividendState({ bonusRows: mapCompanyBonusRows(rows) })
    }

    void fetch(`/api/finance/sharebonus?code=${encodeURIComponent(code)}`)
      .then((response) => response.json())
      .then((data: any) => {
        dividend = data.data
        success()
      })
    void fetchRequest({
      url: `${server}/api/finance/dividendyield`,
      cacheKey: `${code}-dy`,
      cacheTtl: 360000,
      params: { code },
    }).then((data: any) => {
      dividendYield = data
      success()
    })

    kline = await fetchKline(code, 'normal')
    success()
  }

  async function companyShareAdditionalTable() {
    const code = currentCode()
    let kline: any
    let shareAdditional: any
    const should = 2
    let done = 0

    const success = () => {
      done += 1
      if (done < should) {
        return
      }
      if (!shareAdditional || shareAdditional.length < 1) {
        emitCompanyDividendState({ shareAdditionalRows: [] })
        return
      }
      const rows: any[] = []
      for (const item of shareAdditional) {
        const idx1 = findTsIndex(kline, toTimestamp(item.NOTICE_DATE))
        const idx2 = findTsIndex(kline, toTimestamp(item.REG_DATE))
        rows.push([
          item.NOTICE_DATE.substring(0, 10),
          (item.ISSUE_NUM / 1e8).toFixed(4),
          (item.NET_RAISE_FUNDS / 1e8).toFixed(2),
          item.ISSUE_PRICE,
          item.ISSUE_WAY_EXPLAIN,
          item.REG_DATE.substring(0, 10),
          kline[idx1][1],
          kline[idx2][1],
        ])
      }
      emitCompanyDividendState({ shareAdditionalRows: mapCompanyShareAdditionalRows(rows) })
    }

    fetchShareAdditional(code, (data: any) => {
      shareAdditional = data
      success()
    })

    kline = await fetchKline(code, 'normal')
    success()
  }

  function initCompanyDividend() {
    void companyBonusTable()
    void companyShareAdditionalTable()
  }

  return initCompanyDividend
}
