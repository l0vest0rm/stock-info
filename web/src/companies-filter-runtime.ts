type CompaniesFilterSortKey =
  | 'NEW_PRICE'
  | 'CHANGE_RATE'
  | 'CHANGERATE_10DAYS'
  | 'CHANGERATE_TY'
  | 'TOTAL_MARKET_CAP'
  | 'ALLCORP_NUM'
  | 'PE9'
  | 'PBNEWMRQ'
  | 'NETPROFIT_YOY_RATIO'
  | 'ZXGXL'

type SortDirection = 'asc' | 'desc'

type CompaniesFilterRow = {
  rank: number
  code: string
  name: string
  followed: boolean
  price: string
  changeRate: string
  changeRate10Days: string
  changeRateThisYear: string
  totalMarketCapYi: string
  allCorpNum: string
  peTtm: string
  pbMrq: string
  netprofitYoyRatio: string
  dividendYield: string
  roe: string
  reportCount: string
  high180: string
  low180: string
}

type CompaniesFilterFetchRequest = (request: {
  url?: string
  params?: Record<string, unknown>
  data?: unknown
  cacheKey?: string
  cacheTtl?: number
} | string) => Promise<unknown>

type CompaniesFilterRuntimeContext = {
  server: string
  fetchRequest: CompaniesFilterFetchRequest
  bsSelect: (id: string, options: any) => void
  selectedOptionValues: (element: Element | null) => string[]
  hash: (value: string, seed?: number) => number
  generateMarketDataMap: (codes: string[], days: number[]) => Record<string, any>
  fetchKlines: (codes: string[], fq: string, callback: (codes: string[]) => void) => void
  follow: (code: string) => void
  unFollow: (code: string) => void
  cacheCodeName: (code: string, name: string, overwrite?: boolean) => void
  fetchKline: (code: string, fq: string) => Promise<any>
  generateMarketTable: (codes: string[]) => void
}

const companiesFilterSortKeys: CompaniesFilterSortKey[] = [
  'NEW_PRICE',
  'CHANGE_RATE',
  'CHANGERATE_10DAYS',
  'CHANGERATE_TY',
  'TOTAL_MARKET_CAP',
  'ALLCORP_NUM',
  'PE9',
  'PBNEWMRQ',
  'NETPROFIT_YOY_RATIO',
  'ZXGXL',
]

export function createCompaniesFilterInitializer(context: CompaniesFilterRuntimeContext) {
  const {
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
  } = context

  let companiesFilterRows: CompaniesFilterRow[] = []
  let companiesFilterCurrentPage = 1
  let companiesFilterHasNext = false
  let companiesFilterSortBy: CompaniesFilterSortKey = 'ALLCORP_NUM'
  let companiesFilterSortDirection: SortDirection = 'desc'
  let companiesFilterReportCntMap: any = {}
  let companiesFilterEventsBound = false

  function emitCompaniesFilterState() {
    window.dispatchEvent(new CustomEvent('licai:companies-filter-state', {
      detail: {
        rows: companiesFilterRows,
        currentPage: companiesFilterCurrentPage,
        hasNext: companiesFilterHasNext,
        sortBy: companiesFilterSortBy,
        sortDirection: companiesFilterSortDirection,
      },
    }))
  }

  function isCompaniesFilterSortKey(value: unknown): value is CompaniesFilterSortKey {
    return typeof value === 'string' && companiesFilterSortKeys.includes(value as CompaniesFilterSortKey)
  }

  function onCompaniesFilterSortChange(event: Event) {
    const detail = (event as CustomEvent<{ sortBy?: CompaniesFilterSortKey }>).detail
    if (!isCompaniesFilterSortKey(detail?.sortBy)) {
      return
    }
    if (companiesFilterSortBy === detail.sortBy) {
      companiesFilterSortDirection = companiesFilterSortDirection === 'asc' ? 'desc' : 'asc'
    } else {
      companiesFilterSortBy = detail.sortBy
      companiesFilterSortDirection = 'asc'
    }
    companiesFilterCurrentPage = 1
    emitCompaniesFilterState()
    refreshCompaniesFilterTable(companiesFilterReportCntMap)
  }

  function onCompaniesFilterPageChange(event: Event) {
    const detail = (event as CustomEvent<{ page?: number }>).detail
    const page = Number(detail?.page)
    if (!Number.isInteger(page) || page < 1 || page === companiesFilterCurrentPage) {
      return
    }
    companiesFilterCurrentPage = page
    emitCompaniesFilterState()
    refreshCompaniesFilterTable(companiesFilterReportCntMap)
  }

  function onCompaniesFilterFollowToggle(event: Event) {
    const detail = (event as CustomEvent<{ code?: string, followed?: boolean }>).detail
    const code = String(detail?.code || '')
    if (!code) {
      return
    }
    if (detail?.followed) {
      follow(code)
    } else {
      unFollow(code)
    }
  }

  async function perfModalShow(event: any) {
    const key = event.relatedTarget.dataset.key
    window.dispatchEvent(new CustomEvent('licai:companies-filter-perf-state', {
      detail: {
        loading: true,
        code: key,
      },
    }))
    await fetchKline(key, '')
    generateMarketTable([key])
  }

  function refreshCompaniesFilterTable(cntMap: any) {
    let filter = ''
    const filterMap: any = {}
    const vals = selectedOptionValues(document.getElementById('companiesFilter'))
    if (vals.length > 0) {
      for (const val of vals) {
        const arr = val.split('|')
        filterMap[arr[0]] = arr[1]
      }
      for (const key in filterMap) {
        filter += filterMap[key].replace(/#/g, '"')
      }
    }

    const keys: string[] = [
      'SECUCODE',
      'SECURITY_NAME_ABBR',
      'NEW_PRICE',
      'CHANGE_RATE',
      'CHANGERATE_10DAYS',
      'CHANGERATE_TY',
      'TOTAL_MARKET_CAP',
      'ALLCORP_NUM',
      'PE9',
      'PBNEWMRQ',
      'NETPROFIT_YOY_RATIO',
      'ZXGXL',
    ]
    const pageSize = 50
    const sr = companiesFilterSortDirection === 'asc' ? 1 : -1
    const page = String(companiesFilterCurrentPage)
    const sty = keys.join(',')
    void fetchRequest({
      url: '/api/companies/filter',
      cacheKey: hash(`fetchCompaniesFilter-${companiesFilterSortBy}-${sr}-${sty}-${page}-${filter}`),
      cacheTtl: 3600,
      params: {
        st: companiesFilterSortBy,
        sr,
        ps: pageSize,
        p: page,
        sty,
        filter,
      },
    }).then((data: any) => {
      let followArr: string[] = []
      const followStr = localStorage.getItem('follow')
      if (followStr) {
        followArr = followStr.split(',')
      }
      const rows: CompaniesFilterRow[] = []
      let rowIdx = ((data && data.currentpage) ? data.currentpage : companiesFilterCurrentPage) - 1
      rowIdx = rowIdx * 50 + 1
      let codes: string[] = []
      const list = data && Array.isArray(data.data) ? data.data : []
      list.forEach((item: any) => codes.push(item.SECUCODE))
      const dataMap = generateMarketDataMap(codes, [180])
      codes = []
      for (const item of list) {
        cacheCodeName(item.SECUCODE, item.SECURITY_NAME_ABBR, true)
        const totalMarketCapYi = String(Math.round(item.TOTAL_MARKET_CAP / 1e7) / 10)
        const peTtm = typeof item.PE9 === 'number' ? item.PE9.toFixed(2) : '--'
        const pbMrq = typeof item.PBNEWMRQ === 'number' ? item.PBNEWMRQ.toFixed(2) : '--'
        const netprofitYoyRatio = typeof item.NETPROFIT_YOY_RATIO === 'number' ? item.NETPROFIT_YOY_RATIO.toFixed(2) : '--'
        const dividendYield = typeof item.ZXGXL === 'number' ? item.ZXGXL.toFixed(2) : '--'
        const roe = (item.PBNEWMRQ * 100 / item.PE9).toFixed(2)
        const cnt = cntMap[item.SECUCODE] ? cntMap[item.SECUCODE] : 0
        if ((document.getElementById('roe') as HTMLInputElement).checked && parseFloat(roe) < 10) {
          continue
        }
        if ((document.getElementById('researchReport') as HTMLInputElement).checked && cnt < 1) {
          continue
        }
        let high180 = '-'
        let low180 = '-'
        if (dataMap[item.SECUCODE]) {
          high180 = String(dataMap[item.SECUCODE][2])
          low180 = String(dataMap[item.SECUCODE][3])
        } else {
          codes.push(item.SECUCODE)
        }
        rows.push({
          rank: rowIdx,
          code: String(item.SECUCODE),
          name: String(item.SECURITY_NAME_ABBR || ''),
          followed: followArr.includes(item.SECUCODE),
          price: String(item.NEW_PRICE),
          changeRate: String(item.CHANGE_RATE),
          changeRate10Days: String(item.CHANGERATE_10DAYS),
          changeRateThisYear: String(item.CHANGERATE_TY),
          totalMarketCapYi,
          allCorpNum: String(item.ALLCORP_NUM),
          peTtm,
          pbMrq,
          netprofitYoyRatio,
          dividendYield,
          roe,
          reportCount: String(cnt),
          high180,
          low180,
        })
        rowIdx += 1
      }
      if (codes.length) {
        setTimeout(() => {
          fetchKlines(codes, '', () => {
            refreshCompaniesFilterTable(cntMap)
          })
        }, 0)
      }
      companiesFilterRows = rows
      companiesFilterHasNext = rows.length >= 1
      emitCompaniesFilterState()
    })
  }

  async function refreshCompaniesFilter() {
    companiesFilterCurrentPage = 1
    const data = await fetchRequest(`${server}/api/companies/report/cnt?days=90`)
    companiesFilterReportCntMap = data || {}
    refreshCompaniesFilterTable(companiesFilterReportCntMap)
  }

  function initCompaniesFilter() {
    bsSelect('companiesFilter', {
      placeholder: '条件筛选...',
      urlParam: 'filter',
    })
    document.getElementById('companiesFilter')?.addEventListener('change', () => {
      void refreshCompaniesFilter()
    })
    document.getElementById('researchReport')?.addEventListener('change', () => {
      void refreshCompaniesFilter()
    })
    document.getElementById('roe')?.addEventListener('change', () => {
      void refreshCompaniesFilter()
    })
    document.getElementById('perfModal')?.addEventListener('show.bs.modal', perfModalShow)
    if (!companiesFilterEventsBound) {
      companiesFilterEventsBound = true
      window.addEventListener('licai:companies-filter-sort-change', onCompaniesFilterSortChange as EventListener)
      window.addEventListener('licai:companies-filter-page-change', onCompaniesFilterPageChange as EventListener)
      window.addEventListener('licai:companies-filter-follow-toggle', onCompaniesFilterFollowToggle as EventListener)
    }
    emitCompaniesFilterState()
    void refreshCompaniesFilter()
  }

  return initCompaniesFilter
}
