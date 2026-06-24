type CompanyNoticeFetchRequest = (request: {
  url?: string
  params?: Record<string, unknown>
  data?: unknown
  cacheKey?: string
  cacheTtl?: number
} | string) => Promise<unknown>

type CompanyNoticeRuntimeContext = {
  getCode: () => string
  server: string
  fetchRequest: CompanyNoticeFetchRequest
  queryString: (obj: Record<string, unknown>) => string
  alert: (message: string, type?: string) => void
}

export function createCompanyNoticeInitializer(context: CompanyNoticeRuntimeContext) {
  const { server, fetchRequest, queryString, alert } = context

  let companyNoticeCurrentPage = 1
  let companyNoticeEventsBound = false

  function currentCode(): string {
    return context.getCode()
  }

  function emitCompanyNoticeState(patch: any): void {
    window.dispatchEvent(new CustomEvent('licai:company-notice-state', { detail: patch || {} }))
  }

  function mapCompanyNoticeRows(data: any[]): any[] {
    if (!Array.isArray(data)) {
      return []
    }
    const rows: any[] = []
    for (const item of data) {
      rows.push({
        noticeDate: String(item.notice_date || '').substring(0, 10),
        noticeType: String(item.columns?.[0]?.column_name || ''),
        title: String(item.title || ''),
        artCode: String(item.art_code || ''),
      })
    }
    return rows
  }

  function companyNoticeRequestUrl(noticeTypeValue: string, page: string): string {
    const code = currentCode()
    const arr = noticeTypeValue.split('-')
    const as = code.split('.')
    const params = {
      stock: as[0] || '',
      type: as[1] || '',
      fNode: arr[0] || '',
      sNode: arr[1] || '',
      page,
      pageSize: 50,
    }
    return `${server}/api/company/notices?${queryString(params)}`
  }

  function openCompanyNoticePdf(artCode: string) {
    void fetch(`${server}/api/notice/pdf?artCode=${encodeURIComponent(artCode)}`)
      .then((res) => res.json())
      .then((result: any) => {
        if (result.code === 200 && result.data) {
          window.open(`${result.data}#zoom=150`)
        } else {
          alert('获取PDF链接失败')
        }
      })
      .catch((err) => {
        console.error('获取PDF链接失败:', err)
        alert('获取PDF链接失败')
      })
  }

  function renderCompanyNoticeTable() {
    const noticeType = (document.getElementById('noticeType') as HTMLSelectElement | null)?.value || '0-0'
    const pageSize = 50
    void fetchRequest(companyNoticeRequestUrl(noticeType, String(companyNoticeCurrentPage))).then((data: any) => {
      const rows = Array.isArray(data) ? data : []
      emitCompanyNoticeState({
        selectedNoticeType: noticeType,
        rows: mapCompanyNoticeRows(rows),
        currentPage: companyNoticeCurrentPage,
        hasNext: rows.length >= pageSize,
      })
    })
  }

  function initCompanyNotice() {
    const code = currentCode()
    if (!code) {
      alert('缺少股票代码参数，请使用 ?code=000001.SZ 格式访问')
      return
    }
    companyNoticeCurrentPage = 1
    emitCompanyNoticeState({
      selectedNoticeType: '0-0',
      currentPage: companyNoticeCurrentPage,
      hasNext: false,
      rows: [],
    })
    renderCompanyNoticeTable()
    if (!companyNoticeEventsBound) {
      companyNoticeEventsBound = true
      window.addEventListener('licai:company-notice-type-change', ((event: CustomEvent<{ noticeType?: string }>) => {
        const noticeType = event.detail?.noticeType || '0-0'
        const select = document.getElementById('noticeType') as HTMLSelectElement | null
        if (select) {
          select.value = noticeType
        }
        companyNoticeCurrentPage = 1
        renderCompanyNoticeTable()
      }) as EventListener)
      window.addEventListener('licai:company-notice-page-change', ((event: CustomEvent<{ page?: number }>) => {
        const page = Number(event.detail?.page || 1)
        if (!Number.isFinite(page) || page < 1) {
          return
        }
        companyNoticeCurrentPage = page
        renderCompanyNoticeTable()
      }) as EventListener)
      window.addEventListener('licai:company-notice-open-pdf', ((event: CustomEvent<{ artCode?: string }>) => {
        const artCode = String(event.detail?.artCode || '')
        if (!artCode) {
          return
        }
        openCompanyNoticePdf(artCode)
      }) as EventListener)
    }
  }

  return initCompanyNotice
}
