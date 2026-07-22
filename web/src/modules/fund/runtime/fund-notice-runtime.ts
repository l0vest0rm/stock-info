type FundNoticeFetchRequest = (request: string | { url: string; params?: Record<string, unknown> }) => Promise<unknown>

type FundNoticeRuntimeContext = {
  getCode: () => string
  server: string
  fetchRequest: FundNoticeFetchRequest
}

export function createFundNoticeInitializer(context: FundNoticeRuntimeContext) {
  let currentCategory = '0'
  let currentPage = 1
  let eventsBound = false

  function emitState(patch: Record<string, unknown>): void {
    window.dispatchEvent(new CustomEvent('licai:fund-notice-state', { detail: patch }))
  }

  function loadNotices(): void {
    emitState({ loading: true, error: '', category: currentCategory, page: currentPage })
    void context.fetchRequest({
      url: `${context.server}/api/fund/notices`,
      params: {
        code: context.getCode(),
        category: currentCategory,
        page: currentPage,
        pageSize: 20,
      },
    }).then((data: any) => {
      if (!data || !Array.isArray(data.rows)) {
        emitState({ loading: false, error: String(data?.error || '基金公告加载失败'), rows: [], totalCount: 0 })
        return
      }
      emitState({
        loading: false,
        error: '',
        rows: data.rows,
        totalCount: Number(data.totalCount || 0),
        page: Number(data.page || currentPage),
        pageSize: Number(data.pageSize || 20),
      })
    })
  }

  return function initFundNotice(): void {
    if (!context.getCode()) {
      emitState({ loading: false, error: '缺少基金代码参数，请使用 ?code=005827.OF 格式访问', rows: [] })
      return
    }
    currentCategory = '0'
    currentPage = 1
    loadNotices()
    if (eventsBound) return
    eventsBound = true
    window.addEventListener('licai:fund-notice-category-change', ((event: CustomEvent<{ category?: string }>) => {
      currentCategory = event.detail?.category || '0'
      currentPage = 1
      loadNotices()
    }) as EventListener)
    window.addEventListener('licai:fund-notice-page-change', ((event: CustomEvent<{ page?: number }>) => {
      const nextPage = Number(event.detail?.page)
      if (!Number.isInteger(nextPage) || nextPage < 1) return
      currentPage = nextPage
      loadNotices()
    }) as EventListener)
  }
}
