type CompaniesChangeRow = {
  code: string
  industry: string
  mainNetRatio10Days: string
  mainNetRatio5Days: string
  mainNetRatioToday: string
  name: string
  price: string
  rank10Days: string
  rank5Days: string
  rankToday: string
  changeRate10Days: string
  changeRate5Days: string
  changeRateToday: string
}

type CompaniesChangeSortKey =
  | 'f2'
  | 'f3'
  | 'f184'
  | 'f109'
  | 'f165'
  | 'f160'
  | 'f175'

type SortDirection = 'asc' | 'desc'

type CompaniesChangeFetchRequest = (request: {
  url?: string
  params?: Record<string, unknown>
} | string) => Promise<unknown>

type CompaniesChangeRuntimeContext = {
  fetchRequest: CompaniesChangeFetchRequest
}

export function createCompaniesChangeInitializer(context: CompaniesChangeRuntimeContext) {
  const { fetchRequest } = context

  let rows: CompaniesChangeRow[] = []
  let currentPage = 1
  let hasNext = false
  let total = 0
  let loading = false
  let sortBy: CompaniesChangeSortKey = 'f184'
  let sortDirection: SortDirection = 'desc'

  function emitState() {
    window.dispatchEvent(new CustomEvent('licai:companies-change-state', {
      detail: {
        rows,
        currentPage,
        hasNext,
        total,
        loading,
        sortBy,
        sortDirection,
      },
    }))
  }

  function formatNumber(value: unknown, digits = 2, scale = 1): string {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return '--'
    }
    return (value / scale).toFixed(digits)
  }

  function fullCode(code: string): string {
    if (code.startsWith('8')) {
      return `${code}.BJ`
    }
    if (code.startsWith('0') || code.startsWith('1') || code.startsWith('3')) {
      return `${code}.SZ`
    }
    return `${code}.SH`
  }

  async function refresh() {
    loading = true
    emitState()
    const data = await fetchRequest({
      url: '/api/companies/change',
      params: {
        fid: sortBy,
        po: sortDirection === 'desc' ? '1' : '0',
        pn: String(currentPage),
        pz: '50',
      },
    }) as any
    const list = Array.isArray(data?.diff) ? data.diff : []
    const pageSize = 50
    total = typeof data?.total === 'number' ? data.total : 0
    hasNext = currentPage * pageSize < total
    rows = list.map((item: any, index: number) => ({
      code: fullCode(String(item?.f12 || '')),
      industry: String(item?.f100 || '--'),
      mainNetRatio10Days: formatNumber(item?.f175, 2, 100),
      mainNetRatio5Days: formatNumber(item?.f165, 2, 100),
      mainNetRatioToday: formatNumber(item?.f184, 2, 100),
      name: String(item?.f14 || ''),
      price: formatNumber(item?.f2, 2, 100),
      rank10Days: String(item?.f264 ?? '--'),
      rank5Days: String(item?.f263 ?? '--'),
      rankToday: String(item?.f225 ?? '--'),
      changeRate10Days: formatNumber(item?.f160, 2, 100),
      changeRate5Days: formatNumber(item?.f109, 2, 100),
      changeRateToday: formatNumber(item?.f3, 2, 100),
    }))
    loading = false
    emitState()
  }

  function onPageChange(event: Event) {
    const page = Number((event as CustomEvent<{ page?: number }>).detail?.page)
    if (!Number.isInteger(page) || page < 1 || page === currentPage) {
      return
    }
    currentPage = page
    void refresh()
  }

  function onSortChange(event: Event) {
    const nextSortBy = String((event as CustomEvent<{ sortBy?: CompaniesChangeSortKey }>).detail?.sortBy || '')
    if (!nextSortBy) {
      return
    }
    if (sortBy === nextSortBy) {
      sortDirection = sortDirection === 'asc' ? 'desc' : 'asc'
    } else {
      sortBy = nextSortBy as CompaniesChangeSortKey
      sortDirection = 'desc'
    }
    currentPage = 1
    void refresh()
  }

  function initCompaniesChange() {
    window.addEventListener('licai:companies-change-page-change', onPageChange as EventListener)
    window.addEventListener('licai:companies-change-sort-change', onSortChange as EventListener)
    emitState()
    void refresh()
  }

  return initCompaniesChange
}
