type SectorFlowRow = {
  boardCode: string
  boardName: string
  changeRate: string
  leadingStockCode: string
  leadingStockName: string
  latestPrice: string
  mainNetInflowWan: string
  mainNetRatio: string
  largeNetInflowWan: string
  largeNetRatio: string
  mediumNetInflowWan: string
  mediumNetRatio: string
  smallNetInflowWan: string
  smallNetRatio: string
  superNetInflowWan: string
  superNetRatio: string
}

type SectorFlowSortKey =
  | 'f2'
  | 'f3'
  | 'f62'
  | 'f184'
  | 'f66'
  | 'f69'
  | 'f72'
  | 'f75'
  | 'f78'
  | 'f81'
  | 'f84'
  | 'f87'

type SortDirection = 'asc' | 'desc'

type SectorFlowFetchRequest = (request: {
  url?: string
  params?: Record<string, unknown>
} | string) => Promise<unknown>

type SectorFlowRuntimeContext = {
  fetchRequest: SectorFlowFetchRequest
}

export function createSectorFlowInitializer(context: SectorFlowRuntimeContext) {
  const { fetchRequest } = context

  let rows: SectorFlowRow[] = []
  let currentPage = 1
  let hasNext = false
  let total = 0
  let loading = false
  let sortBy: SectorFlowSortKey = 'f62'
  let sortDirection: SortDirection = 'desc'

  function emitState() {
    window.dispatchEvent(new CustomEvent('licai:sector-flow-state', {
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

  function formatAmountWan(value: unknown): string {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return '--'
    }
    return (value / 10000).toFixed(2)
  }

  async function refresh() {
    loading = true
    emitState()
    const data = await fetchRequest({
      url: '/api/sector/flow',
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
    rows = list.map((item: any) => ({
      boardCode: String(item?.f12 || ''),
      boardName: String(item?.f14 || ''),
      changeRate: formatNumber(item?.f3, 2, 100),
      leadingStockCode: String(item?.f205 || ''),
      leadingStockName: String(item?.f204 || ''),
      latestPrice: formatNumber(item?.f2, 2, 100),
      mainNetInflowWan: formatAmountWan(item?.f62),
      mainNetRatio: formatNumber(item?.f184, 2, 100),
      largeNetInflowWan: formatAmountWan(item?.f72),
      largeNetRatio: formatNumber(item?.f75, 2, 100),
      mediumNetInflowWan: formatAmountWan(item?.f78),
      mediumNetRatio: formatNumber(item?.f81, 2, 100),
      smallNetInflowWan: formatAmountWan(item?.f84),
      smallNetRatio: formatNumber(item?.f87, 2, 100),
      superNetInflowWan: formatAmountWan(item?.f66),
      superNetRatio: formatNumber(item?.f69, 2, 100),
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
    const nextSortBy = String((event as CustomEvent<{ sortBy?: SectorFlowSortKey }>).detail?.sortBy || '')
    if (!nextSortBy) {
      return
    }
    if (sortBy === nextSortBy) {
      sortDirection = sortDirection === 'asc' ? 'desc' : 'asc'
    } else {
      sortBy = nextSortBy as SectorFlowSortKey
      sortDirection = 'desc'
    }
    currentPage = 1
    void refresh()
  }

  function initSectorFlow() {
    window.addEventListener('licai:sector-flow-page-change', onPageChange as EventListener)
    window.addEventListener('licai:sector-flow-sort-change', onSortChange as EventListener)
    emitState()
    void refresh()
  }

  return initSectorFlow
}
