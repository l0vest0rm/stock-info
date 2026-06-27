type CompanyReportPredictFetchRequest = (request: {
  url?: string
  params?: Record<string, unknown>
  data?: unknown
  cacheKey?: string
  cacheTtl?: number
}) => Promise<unknown>

type CompanyReportPredictRuntimeContext = {
  server: string
  fetchRequest: CompanyReportPredictFetchRequest
  fetchReportUrl: (qtype: string, code: string, callback: (url: string | null) => void) => void
  toDateString: (ts: number) => string
  selectChangeValue: (id: string, value: string) => void
  alert: (message: string, type?: string) => void
}

export function createCompanyReportPredictInitializer(context: CompanyReportPredictRuntimeContext) {
  const { server, fetchRequest, fetchReportUrl, toDateString, selectChangeValue, alert } = context

  function emitCompanyReportPredictState(patch: any): void {
    window.dispatchEvent(new CustomEvent('licai:company-report-predict-state', { detail: patch || {} }))
  }

  function mapCompanyReportPredictRows(incomes: string[], netProfits: string[], years: string[]): any[] {
    const rows: any[] = []
    if (incomes.length > 0) {
      rows.push({
        key: 'ic',
        label: '营收',
        cells: years.map((year, index) => ({
          id: `ic-${year}`,
          value: String(incomes[index] ?? ''),
        })),
      })
    }
    if (netProfits.length > 0) {
      rows.push({
        key: 'np',
        label: '净利',
        cells: years.map((year, index) => ({
          id: `np-${year}`,
          value: String(netProfits[index] ?? ''),
        })),
      })
    }
    return rows
  }

  function genCompanyReportPredictTable(incomes: string[], netProfits: string[], unit: string, years: string[]) {
    emitCompanyReportPredictState({
      rows: mapCompanyReportPredictRows(incomes, netProfits, years),
    })
    selectChangeValue('unit', unit)
  }

  function genCompanyReportPredictTableByDetail(detail: any) {
    const detailMap = typeof detail === 'string' ? JSON.parse(detail) : detail
    const incomes: string[] = []
    const netProfits: string[] = []
    const unit = detailMap.u ? detailMap.u : 'm'
    let years: string[] = []
    for (const key in detailMap) {
      if (key.startsWith('ic-') || key.startsWith('np-')) {
        years.push(key.substring(3))
      }
    }
    years = years.filter((value, index) => years.indexOf(value) === index)
    years.sort()
    for (const year of years) {
      const incomeKey = `ic-${year}`
      const profitKey = `np-${year}`
      if (incomeKey in detailMap) {
        incomes.push(detailMap[incomeKey])
      }
      if (profitKey in detailMap) {
        netProfits.push(detailMap[profitKey])
      }
    }
    genCompanyReportPredictTable(incomes, netProfits, unit, years)
  }

  function formatCompanyReportPredict() {
    const content = ((document.getElementById('content') as HTMLTextAreaElement | null)?.value || '').trim()
    const lines = content.split('\n')
    const years: string[] = []
    let incomes: string[] = []
    let netProfits: string[] = []
    let unit = ''
    const arr: string[][] = []
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim()
      if (!unit) {
        if (line.includes('百万')) {
          unit = 'm'
        } else if (line.includes('十亿')) {
          unit = 'b'
        } else if (line.includes('亿元')) {
          unit = 'y'
        } else if (line.includes('千元')) {
          unit = 'k'
        }
      }
      if (line.includes('%') || line.length < 2) {
        continue
      }
      const item: string[] = line.replace(/,/g, '').split(/\s+/)
      if (i === 0) {
        item.forEach((year) => {
          const normalized = year.toUpperCase().replace(/[a-zA-Z-]*(20)?(2[0-9])+[a-zA-Z]*/, '20$2')
          if (normalized.startsWith('20')) {
            years.push(normalized)
          }
        })
        continue
      }
      for (let index = 0; index < item.length; index += 1) {
        if (/^[\(-]?[\d,\.]+\)?$/.test(item[index])) {
          const value = item[index]
          if (value && value.startsWith('(') && value.endsWith(')')) {
            item[index] = `-${value.substring(1, value.length - 1)}`
          }
        }
      }
      if (item.length < 2 && arr.length > 0) {
        arr[arr.length - 1].push(item[0])
      } else {
        arr.push(item)
      }
    }

    if (!unit) {
      unit = 'm'
    }

    for (const item of arr) {
      let key = item[0]
      for (let i = 1; i < item.length; i += 1) {
        if (/^[\(-]?[\d,\.]+\)?$/.test(item[i])) {
          key = key.toLowerCase()
          if (incomes.length === 0 && (key.includes('revenue') || key.includes('收入') || key.includes('总收入') || key.includes('营收') || key.includes('销售收入'))) {
            incomes = item.slice(i)
          } else if (key.includes('营业收入') || key.includes('营业总收入')) {
            incomes = item.slice(i)
          } else if (netProfits.length === 0 && (key.includes('净利润') || key.includes('net profit'))) {
            netProfits = item.slice(i)
          } else if ((key.includes('归母') || key.includes('归属母公司')) && key.includes('净利') && !key.includes('同比') && !key.includes('增长率')) {
            netProfits = item.slice(i)
          }
          break
        }
        key += ` ${item[i]}`
      }
    }

    genCompanyReportPredictTable(incomes, netProfits, unit, years)
  }

  function saveCompanyReportPredict() {
    const detailMap: any = {}
    detailMap.u = (document.getElementById('unit') as HTMLSelectElement | null)?.value || ''
    document.querySelectorAll("input[name='subject']").forEach((elem) => {
      const input = elem as HTMLInputElement
      if (input.value) {
        detailMap[input.id] = input.value
      } else {
        delete detailMap[input.id]
      }
    })

    const query = new URLSearchParams(window.location.search)
    const infoText = query.get('info') || '{}'
    const body = JSON.parse(infoText)
    body.url = ((document.getElementById('iframe') as HTMLIFrameElement | null)?.src || '').split('#')[0]
    body.detail = detailMap

    void fetchRequest({
      url: `${server}/api/company/report/update`,
      data: body,
    }).then((data: any) => {
      alert(JSON.stringify(data))
    })
  }

  function initCompanyReportPredict() {
    const queryString = window.location.search.substring(1)
    const localQuery = queryString.split('&').reduce((acc: any, item) => {
      const [key, value] = item.split('=')
      acc[key] = decodeURIComponent(value)
      return acc
    }, {})

    const info = JSON.parse(localQuery.info)
    let zoom = '#zoom=125'
    let qtype = '0'
    if (info.code.endsWith('.HK') || info.code.endsWith('.US')) {
      zoom = ''
      qtype = 'dataeye'
    }

    if (info.url) {
      (document.getElementById('iframe') as HTMLIFrameElement | null)?.setAttribute('src', `${info.url}${zoom}`)
      document.getElementById('reportUrl')?.setAttribute('href', `${info.url}${zoom}`)
    } else {
      fetchReportUrl(qtype, info.infoCode, (url: string | null) => {
        (document.getElementById('iframe') as HTMLIFrameElement | null)?.setAttribute('src', `${url}${zoom}`)
        document.getElementById('reportUrl')?.setAttribute('href', `${url}${zoom}`)
      })
    }

    const reportDate = document.getElementById('reportDate') as HTMLInputElement | null
    if (reportDate) {
      reportDate.value = toDateString(info.ts * 1000)
      const updateReport = () => {
        void fetchRequest({
          url: `${server}/api/company/report-ts/update`,
          data: {
            code: info.infoCode,
            type: qtype,
            ts: new Date(reportDate.value).getTime() / 1000,
          },
        }).then((res: any) => {
          if (res.ok) {
            location.reload()
          }
        })
      }
      reportDate.addEventListener('change', updateReport)
      document.getElementById('updateReport')?.addEventListener('click', updateReport)
    }

    if (info.detail) {
      genCompanyReportPredictTableByDetail(info.detail)
    }

    document.getElementById('format')?.addEventListener('click', formatCompanyReportPredict)
    document.getElementById('save')?.addEventListener('click', saveCompanyReportPredict)
  }

  return initCompanyReportPredict
}
