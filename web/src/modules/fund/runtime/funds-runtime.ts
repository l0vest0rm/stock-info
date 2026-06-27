type FundsFetchRequest = (request: {
  url?: string
  params?: Record<string, unknown>
  data?: unknown
  cacheKey?: string
  cacheTtl?: number
}) => Promise<unknown>

type FundRankSortKey = 'rzdf' | 'zzf' | '1yzf' | '3yzf' | '6yzf' | '1nzf' | '2nzf' | '3nzf' | 'jnzf' | 'lnzf'
type FundRankSortDirection = 'asc' | 'desc'
type FundCompanyOption = {
  value: string
  label: string
}

type FundRankRow = {
  rank: number
  code: string
  name: string
  navDate: string
  unitNav: string
  accumNav: string
  dailyChange: string
  weekChange: string
  monthChange: string
  quarterChange: string
  halfYearChange: string
  yearChange: string
  twoYearChange: string
  threeYearChange: string
  thisYearChange: string
  sinceSetupChange: string
  setupDate: string
  manager: string
  company: string
  style: string
  scale: string
  updateDate: string
}

type FundsRuntimeContext = {
  fetchRequest: FundsFetchRequest
}

export function createFundsInitializer(context: FundsRuntimeContext) {
  const { fetchRequest } = context

  let fundsCurrentSortBy: FundRankSortKey = '3yzf'
  let fundsCurrentSortDirection: FundRankSortDirection = 'desc'
  let fundsCurrentFundStyle = 'all'
  let fundsCurrentCompany = '0'
  let fundsCurrentPage = 1
  let fundsTotalPages = 1
  let fundsCompanyOptions: FundCompanyOption[] = [{ value: '0', label: '全部' }]
  let fundsVueEventsBound = false

  function emitFundsState(patch: any): void {
    window.dispatchEvent(new CustomEvent('licai:funds-state', { detail: patch || {} }))
  }

  function stripFundRankHTML(value: unknown): string {
    const text = String(value || '')
    if (!text.includes('<')) {
      return text
    }
    const div = document.createElement('div')
    div.innerHTML = text
    return div.textContent || div.innerText || ''
  }

  function mapFundRankRows(rows: any[]): FundRankRow[] {
    return Array.isArray(rows) ? rows.map((row) => ({
      rank: Number(row?.[0]) || 0,
      code: String(row?.[1] || ''),
      name: stripFundRankHTML(row?.[2]),
      navDate: String(row?.[3] || ''),
      unitNav: String(row?.[4] || ''),
      accumNav: String(row?.[5] || ''),
      dailyChange: String(row?.[6] || ''),
      weekChange: String(row?.[7] || ''),
      monthChange: String(row?.[8] || ''),
      quarterChange: String(row?.[9] || ''),
      halfYearChange: String(row?.[10] || ''),
      yearChange: String(row?.[11] || ''),
      twoYearChange: String(row?.[12] || ''),
      threeYearChange: String(row?.[13] || ''),
      thisYearChange: String(row?.[14] || ''),
      sinceSetupChange: String(row?.[15] || ''),
      setupDate: String(row?.[16] || ''),
      manager: String(row?.[17] || ''),
      company: String(row?.[18] || ''),
      style: String(row?.[19] || ''),
      scale: String(row?.[20] || ''),
      updateDate: String(row?.[21] || ''),
    })) : []
  }

  function emitFundsLoadingState(status: string) {
    emitFundsState({
      companyOptions: fundsCompanyOptions,
      selectedCompany: fundsCurrentCompany,
      selectedFundStyle: fundsCurrentFundStyle,
      selectedPage: fundsCurrentPage,
      sortBy: fundsCurrentSortBy,
      sortDirection: fundsCurrentSortDirection,
      status,
      totalPages: fundsTotalPages,
    })
  }

  function sanitizePage(page: number): number {
    if (!Number.isFinite(page) || page < 1) {
      return 1
    }
    return Math.floor(page)
  }

  function normalizeFundCompanyOptions(data: unknown): FundCompanyOption[] {
    const source = Array.isArray(data)
      ? data
      : Array.isArray((data as any)?.data?.data)
        ? (data as any).data.data
        : Array.isArray((data as any)?.data)
          ? (data as any).data
          : []
    const options = source
      .filter((item) => Array.isArray(item) && item.length >= 2)
      .map((item) => ({
        value: String(item[0] || '0'),
        label: String(item[1] || ''),
      }))
      .filter((item) => item.value !== '')
    return [{ value: '0', label: '全部' }, ...options]
  }

  async function loadFundCompanies(): Promise<void> {
    const result = await fetchRequest({
      url: '/api/fund/companies',
      cacheKey: 'fundCompanies',
      cacheTtl: 360000,
      params: {},
    })
    fundsCompanyOptions = normalizeFundCompanyOptions(result)
    if (!fundsCompanyOptions.some((item) => item.value === fundsCurrentCompany)) {
      fundsCurrentCompany = '0'
    }
    emitFundsState({
      companyOptions: fundsCompanyOptions,
      selectedCompany: fundsCurrentCompany,
    })
  }

  async function refreshFundsVueTable(page: number, sortBy?: FundRankSortKey, asc?: boolean): Promise<void> {
    const selectedFundStyle = fundsCurrentFundStyle
    const selectedCompany = fundsCurrentCompany
    const selectedRankBy = (sortBy || fundsCurrentSortBy) as FundRankSortKey
    const sortDirection: FundRankSortDirection = typeof asc === 'boolean'
      ? (asc ? 'asc' : 'desc')
      : fundsCurrentSortDirection
    const selectedPage = sanitizePage(page || fundsCurrentPage)
    fundsCurrentSortBy = selectedRankBy
    fundsCurrentSortDirection = sortDirection
    fundsCurrentPage = selectedPage
    emitFundsLoadingState('加载中...')
    const result = await fetchRequest({
      url: '/api/fund/rank',
      cacheKey: `fundRankTable-${selectedFundStyle}-${selectedCompany}-${selectedRankBy}-${sortDirection}-${selectedPage}`,
      cacheTtl: 360000,
      params: {
        ft: selectedFundStyle,
        gs: selectedCompany,
        sc: selectedRankBy,
        st: sortDirection,
        pi: String(selectedPage),
        pn: 50,
      },
    }) as any
    const data = result?.rows ? result : result?.data || {}
    const rows = mapFundRankRows(data.rows || [])
    fundsTotalPages = sanitizePage(Number(data.allPages) || 1)
    fundsCurrentPage = sanitizePage(Number(data.pageIndex) || selectedPage)
    emitFundsState({
      companyOptions: fundsCompanyOptions,
      rows,
      selectedCompany,
      selectedFundStyle,
      selectedPage: fundsCurrentPage,
      sortBy: selectedRankBy,
      sortDirection,
      status: `已加载 ${rows.length} 条，第 ${fundsCurrentPage}/${fundsTotalPages} 页`,
      totalPages: fundsTotalPages,
    })
  }

  function refreshFundRankTable() {
    fundsCurrentSortDirection = 'desc'
    refreshFundRankTableWithPage(1)
  }

  function refreshFundRankTableWithPage(initialPage: number, sortBy?: FundRankSortKey, asc?: boolean) {
    void refreshFundsVueTable(initialPage, sortBy, asc)
  }

  function onFundsSortChange(event: Event) {
    const detail = (event as CustomEvent<{ sortBy?: FundRankSortKey }>).detail
    if (!detail?.sortBy) {
      return
    }
    const nextAsc = fundsCurrentSortBy === detail.sortBy
      ? fundsCurrentSortDirection !== 'asc'
      : false
    fundsCurrentSortBy = detail.sortBy
    fundsCurrentSortDirection = nextAsc ? 'asc' : 'desc'
    refreshFundRankTableWithPage(fundsCurrentPage, detail.sortBy, nextAsc)
  }

  function onFundsFilterChange(event: Event) {
    const detail = (event as CustomEvent<{ fundStyle?: string, company?: string }>).detail
    if (!detail) {
      return
    }
    if (typeof detail.fundStyle === 'string') {
      fundsCurrentFundStyle = detail.fundStyle || 'all'
    }
    if (typeof detail.company === 'string') {
      fundsCurrentCompany = detail.company || '0'
    }
    refreshFundRankTableWithPage(1)
  }

  function onFundsPageChange(event: Event) {
    const detail = (event as CustomEvent<{ page?: number }>).detail
    const nextPage = sanitizePage(Number(detail?.page) || 1)
    refreshFundRankTableWithPage(Math.min(nextPage, fundsTotalPages))
  }

  function initFunds() {
    if (!fundsVueEventsBound) {
      fundsVueEventsBound = true
      window.addEventListener('licai:funds-sort-change', onFundsSortChange as EventListener)
      window.addEventListener('licai:funds-filter-change', onFundsFilterChange as EventListener)
      window.addEventListener('licai:funds-page-change', onFundsPageChange as EventListener)
    }
    emitFundsLoadingState('加载中...')
    void loadFundCompanies().finally(() => {
      refreshFundRankTable()
    })
  }

  return initFunds
}
