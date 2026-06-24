import { genReportDates } from './finance-constants'

type CompaniesHoldingRank = 'HOULD_NUM' | 'TOTAL_SHARES' | 'HOLD_VALUE' | 'HOLDCHA_NUM' | 'HOLDCHA_RATIO'

type CompaniesHoldingTableRow = {
  rank: number
  code: string
  name: string
  holdNum: number | string
  totalSharesWan: string
  holdValueYi: string
  holdChangeNumWan: string
  holdChangeRatio: number | string
}

type CompaniesHoldingFetchRequest = (request: {
  url?: string
  params?: Record<string, unknown>
  data?: unknown
  cacheKey?: string
  cacheTtl?: number
}) => Promise<unknown>

type CompaniesHoldingRuntimeContext = {
  fetchRequest: CompaniesHoldingFetchRequest
  query: Record<string, any>
}

const companiesHoldingRanks: CompaniesHoldingRank[] = ['HOULD_NUM', 'TOTAL_SHARES', 'HOLD_VALUE', 'HOLDCHA_NUM', 'HOLDCHA_RATIO']
const defaultCompaniesHoldingRank: CompaniesHoldingRank = 'HOULD_NUM'

export function createCompaniesHoldingInitializer(context: CompaniesHoldingRuntimeContext) {
  const { fetchRequest, query } = context

  let companiesHoldingDateOptions: string[] = []
  let companiesHoldingSelectedDate = ''
  let companiesHoldingRows: CompaniesHoldingTableRow[] = []
  let companiesHoldingCurrentPage = 1
  let companiesHoldingHasNext = false
  let companiesHoldingEventsBound = false

  function isCompaniesHoldingRank(value: unknown): value is CompaniesHoldingRank {
    return typeof value === 'string' && companiesHoldingRanks.includes(value as CompaniesHoldingRank)
  }

  function emitCompaniesHoldingState(): void {
    window.dispatchEvent(new CustomEvent('licai:companies-holding-state', {
      detail: {
        dateOptions: companiesHoldingDateOptions.slice(),
        selectedDate: companiesHoldingSelectedDate,
        selectedRank: isCompaniesHoldingRank(query.rank) ? query.rank : defaultCompaniesHoldingRank,
        rows: companiesHoldingRows,
        currentPage: companiesHoldingCurrentPage,
        hasNext: companiesHoldingHasNext,
      },
    }))
  }

  function onCompaniesHoldingDateChange(event: Event): void {
    const detail = (event as CustomEvent<{ date?: string }>).detail
    if (!detail?.date || !companiesHoldingDateOptions.includes(detail.date) || detail.date === companiesHoldingSelectedDate) {
      return
    }
    companiesHoldingSelectedDate = detail.date
    query.date = detail.date
    companiesHoldingCurrentPage = 1
    emitCompaniesHoldingState()
    refreshCompaniesHoldingRankTable()
  }

  function onCompaniesHoldingRankChange(event: Event): void {
    const detail = (event as CustomEvent<{ rank?: CompaniesHoldingRank }>).detail
    if (!isCompaniesHoldingRank(detail?.rank) || detail.rank === query.rank) {
      return
    }
    query.rank = detail.rank
    companiesHoldingCurrentPage = 1
    emitCompaniesHoldingState()
    refreshCompaniesHoldingRankTable()
  }

  function onCompaniesHoldingPageChange(event: Event): void {
    const detail = (event as CustomEvent<{ page?: number }>).detail
    const page = Number(detail?.page)
    if (!Number.isInteger(page) || page < 1 || page === companiesHoldingCurrentPage) {
      return
    }
    companiesHoldingCurrentPage = page
    emitCompaniesHoldingState()
    refreshCompaniesHoldingRankTable()
  }

  function refreshCompaniesHoldingRankTable() {
    const date = companiesHoldingSelectedDate || companiesHoldingDateOptions[0] || ''
    const rank: CompaniesHoldingRank = isCompaniesHoldingRank(query.rank) ? query.rank : defaultCompaniesHoldingRank
    const pageSize = 50
    const page = String(companiesHoldingCurrentPage)
    void fetchRequest({
      url: '/api/companies/holding/rank',
      cacheKey: `fetchCompaniesHoldingRank-${date}-${rank}-${page}`,
      cacheTtl: 360000,
      params: {
        type: 1,
        date,
        rank,
        page,
      },
    }).then((data: any) => {
      const items = Array.isArray(data) ? data : []
      companiesHoldingRows = items.map((item: any, index: number): CompaniesHoldingTableRow => ({
        rank: index + 1,
        code: item.SECUCODE,
        name: item.SECURITY_NAME_ABBR,
        holdNum: item.HOULD_NUM,
        totalSharesWan: (item.FREE_SHARES / 1e4).toFixed(2),
        holdValueYi: (item.FREE_MARKET_CAP / 1e8).toFixed(2),
        holdChangeNumWan: (item.HOLDCHA_NUM / 1e4).toFixed(2),
        holdChangeRatio: item.HOLDCHA_RATIO,
      }))
      companiesHoldingHasNext = items.length >= pageSize
      emitCompaniesHoldingState()
    })
  }

  function initCompaniesHolding() {
    companiesHoldingDateOptions = genReportDates(3)
    companiesHoldingSelectedDate = query.date && companiesHoldingDateOptions.includes(query.date)
      ? query.date
      : companiesHoldingDateOptions[0]
    query.date = companiesHoldingSelectedDate
    if (!isCompaniesHoldingRank(query.rank)) {
      query.rank = defaultCompaniesHoldingRank
    }
    companiesHoldingCurrentPage = 1
    emitCompaniesHoldingState()
    refreshCompaniesHoldingRankTable()
    if (companiesHoldingEventsBound) {
      return
    }
    companiesHoldingEventsBound = true
    window.addEventListener('licai:companies-holding-date-change', onCompaniesHoldingDateChange as EventListener)
    window.addEventListener('licai:companies-holding-rank-change', onCompaniesHoldingRankChange as EventListener)
    window.addEventListener('licai:companies-holding-page-change', onCompaniesHoldingPageChange as EventListener)
  }

  return initCompaniesHolding
}
