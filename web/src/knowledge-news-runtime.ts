type KnowledgeNewsFetchRequest = (request: {
  url?: string
  params?: Record<string, unknown>
  data?: unknown
  cacheKey?: string
  cacheTtl?: number
}) => Promise<unknown>

type KnowledgeNewsRuntimeContext = {
  server: string
  fetchRequest: KnowledgeNewsFetchRequest
  escapeHtml: (value: unknown) => string
}

type KnowledgeNewsTableRow = {
  rawTime: string
  fetchedTime: string
  sourceType: string
  target: string
  sourceName: string
  title: string
  docId: string
  sourceUrl: string
  discoveryMethod: string
  accessMethod: string
  isLocalNews: boolean
  tags: string[]
  recommendationLevel: string
  recommendationScore: number
  recommendationReasons: string[]
  rankScore: number
  rankReasons: string[]
  favorited: boolean
}

export function createKnowledgeNewsInitializer(context: KnowledgeNewsRuntimeContext) {
  const { server, fetchRequest, escapeHtml } = context

  let knowledgeNewsRows: KnowledgeNewsTableRow[] = []
  let knowledgeNewsCurrentPage = 1
  let knowledgeNewsHasNext = false
  let knowledgeNewsEventsBound = false
  let knowledgeNewsSourceNameOptions: Array<{value: string; label: string}> = [
    { value: 'all', label: '全部来源站点' }
  ]
  let knowledgeNewsSelectedSourceName = 'all'
  let knowledgeNewsSelectedTags: string[] = []

  function knowledgeSourceTypeText(value: string): string {
    switch (value) {
      case 'web_news':
      case 'news':
      case 'local_news':
        return '新闻'
      case 'sec_filing':
        return 'SEC披露'
      case 'research_report':
        return '研报'
      case 'company_report':
        return '公司研报'
      case 'industry_report':
        return '行业研报'
      default:
        return value || '-'
    }
  }

  function knowledgeReportTypeText(item: any): string {
    const reportType = item && item.report_type ? item.report_type : item?.source_type
    return knowledgeSourceTypeText(reportType)
  }

  function knowledgeTargetText(item: any): string {
    const name = item && item.target_name ? String(item.target_name) : ''
    const code = item && item.target_code ? String(item.target_code) : ''
    if (name && code) {
      return `${name} (${code})`
    }
    return name || code || ''
  }

  function formatKnowledgeTime(value: string): string {
    const raw = String(value || '').trim()
    if (!raw) {
      return '-'
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      return raw
    }
    const hasTimeZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)
    if (!hasTimeZone) {
      return raw.replace('T', ' ').replace(/\.\d+$/, '').substring(0, 19)
    }
    const date = new Date(raw)
    if (Number.isNaN(date.getTime())) {
      return raw.replace('T', ' ').replace(/\+.*/, '').replace(/Z$/i, '').substring(0, 19)
    }
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).formatToParts(date)
    const pick = (type: string) => parts.find((part) => part.type === type)?.value || ''
    return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}:${pick('second')}`
  }

  function emitKnowledgeNewsTableState() {
    window.dispatchEvent(new CustomEvent('licai:knowledge-news-table-state', {
      detail: {
        rows: knowledgeNewsRows,
        currentPage: knowledgeNewsCurrentPage,
        hasNext: knowledgeNewsHasNext,
      },
    }))
  }

  function emitKnowledgeNewsFiltersState() {
    window.dispatchEvent(new CustomEvent('licai:knowledge-news-filters-state', {
      detail: {
        sourceNameOptions: knowledgeNewsSourceNameOptions,
        selectedSourceName: knowledgeNewsSelectedSourceName,
        selectedTags: knowledgeNewsSelectedTags,
      }
    }))
  }

  function normalizeKnowledgeNewsTags(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return []
    }
    const tags: string[] = []
    const seen = new Set<string>()
    for (const item of value) {
      const tag = String(item || '').trim()
      if (!tag || seen.has(tag)) {
        continue
      }
      seen.add(tag)
      tags.push(tag)
    }
    return tags
  }

  function mapKnowledgeNewsRow(item: any): KnowledgeNewsTableRow {
    const docId = String(item.doc_id || '')
    const tags = normalizeKnowledgeNewsTags(item.tags)
    return {
      rawTime: formatKnowledgeTime(item.event_time || item.published_at),
      fetchedTime: formatKnowledgeTime(item.fetched_at),
      sourceType: knowledgeReportTypeText(item),
      target: knowledgeTargetText(item),
      sourceName: String(item.source_name || ''),
      title: String(item.title || ''),
      docId,
      sourceUrl: String(item.url || ''),
      discoveryMethod: String(item.discovery_method || item.metadata?.discovery_method || ''),
      accessMethod: String(item.access_method || ''),
      isLocalNews: item.source_type === 'local_news',
      tags,
      recommendationLevel: String(item.recommendation?.level || ''),
      recommendationScore: Number(item.recommendation?.score || 0),
      recommendationReasons: Array.isArray(item.recommendation?.reasons)
        ? item.recommendation.reasons.map((reason: unknown) => String(reason || '').trim()).filter(Boolean)
        : [],
      rankScore: Number(item.rankScore || 0),
      rankReasons: Array.isArray(item.rankReasons)
        ? item.rankReasons.map((reason: unknown) => String(reason || '').trim()).filter(Boolean)
        : [],
      favorited: Boolean(item.favorited),
    }
  }

  async function fetchKnowledgeNewsPage(params: Record<string, unknown>) {
    return fetchRequest({
      url: `${server}/api/knowledge/docs`,
      params,
    }) as Promise<any>
  }

  async function renderKnowledgeNews() {
    const sourceType = (document.getElementById('knowledgeSourceType') as HTMLInputElement).value
    const source = (document.getElementById('knowledgeSourceName') as HTMLInputElement | null)?.value || 'all'
    const selectedTags = Array.from(document.querySelectorAll<HTMLInputElement>('#knowledgeTagFilters input[name="knowledgeTagFilter"]:checked'))
      .map((input) => input.value)
      .filter(Boolean)
    const query = (document.getElementById('knowledgeQuery') as HTMLInputElement).value
    const pageSize = 50
    knowledgeNewsSelectedTags = selectedTags
    knowledgeNewsSelectedSourceName = source

    const data = await fetchKnowledgeNewsPage({
      sourceType,
      source,
      tags: selectedTags.join(','),
      q: query,
      page: knowledgeNewsCurrentPage,
      pageSize
    })
    const list = data && data.list ? data.list : []
    knowledgeNewsRows = list.map((item: any): KnowledgeNewsTableRow => mapKnowledgeNewsRow(item))
    knowledgeNewsHasNext = list.length >= pageSize
    emitKnowledgeNewsTableState()
    emitKnowledgeNewsFiltersState()
  }

  async function showKnowledgeDocument(docID: string) {
    if (!docID) {
      return
    }
    const data = await fetchRequest({
      url: `${server}/api/knowledge/doc`,
      params: { id: docID }
    }) as any
    const title = data && data.title ? data.title : ''
    const content = data && data.content ? data.content : ''
    const url = data && data.url ? data.url : ''
    const meta = [
      knowledgeReportTypeText(data),
      knowledgeTargetText(data),
      data.source_name,
      `原始时间 ${formatKnowledgeTime(data.event_time || data.published_at)}`,
      `抓取时间 ${formatKnowledgeTime(data.fetched_at)}`,
      `获取方式 ${data.discovery_method || data.metadata?.discovery_method || '-'}`,
      `原文获取 ${data.access_method || '-'}`
    ].filter((value) => value && value !== '-').map(escapeHtml).join(' / ')
    document.getElementById('knowledgeDocModalTitle')!.textContent = title
    const favoriteButton = document.getElementById('knowledgeDocFavoriteBtn') as HTMLButtonElement | null
    if (favoriteButton) {
      favoriteButton.className = 'btn btn-sm btn-outline-warning d-none'
    }
    document.getElementById('knowledgeDocMeta')!.innerHTML = `${meta}${url ? ` <a class="ms-2" href="${escapeHtml(url)}" target="_blank">打开原文</a>` : ''}`
    const contentElem = document.getElementById('knowledgeDocContent')!
    if ((window as any).marked) {
      contentElem.innerHTML = (window as any).marked.parse(content)
    } else {
      contentElem.innerHTML = `<pre class="text-wrap">${escapeHtml(content)}</pre>`
    }
    const modal = document.getElementById('knowledgeDocModal')
    const bsModal = new (window as any).bootstrap.Modal(modal)
    bsModal.show()
  }

  async function onKnowledgeNewsOpenDoc(event: Event) {
    const detail = (event as CustomEvent<{docId?: string}>).detail
    await showKnowledgeDocument(detail?.docId || '')
  }

  function onKnowledgeNewsPageChange(event: Event) {
    const detail = (event as CustomEvent<{page?: number}>).detail
    const page = Number(detail?.page)
    if (!Number.isInteger(page) || page < 1 || page === knowledgeNewsCurrentPage) {
      return
    }
    knowledgeNewsCurrentPage = page
    emitKnowledgeNewsTableState()
    renderKnowledgeNews()
  }

  function renderKnowledgeNewsFirstPage() {
    knowledgeNewsCurrentPage = 1
    renderKnowledgeNews()
  }

  async function loadKnowledgeSourceOptions(reset: boolean = false) {
    const select = document.getElementById('knowledgeSourceName') as HTMLSelectElement | null
    const sourceType = (document.getElementById('knowledgeSourceType') as HTMLInputElement | null)?.value || 'all'
    if (!select) {
      return
    }
    const current = reset ? 'all' : select.value
    const data = await fetchRequest({
      url: `${server}/api/knowledge/sources`,
      params: { sourceType }
    }) as any
    const list = data && data.list ? data.list : []
    const options = [{ value: 'all', label: '全部来源站点' }]
    for (const item of list) {
      options.push({
        value: item.key || item.name || '',
        label: `${item.name || item.key || ''}${item.count ? ` (${item.count})` : ''}`
      })
    }
    knowledgeNewsSourceNameOptions = options
    knowledgeNewsSelectedSourceName = options.some((option) => option.value === current) ? current : 'all'
    emitKnowledgeNewsFiltersState()
  }

  function initKnowledgeNews() {
    document.getElementById('knowledgeSearchBtn')?.addEventListener('click', renderKnowledgeNewsFirstPage)
    document.getElementById('knowledgeSourceType')?.addEventListener('change', () => {
      void loadKnowledgeSourceOptions(true).then(renderKnowledgeNewsFirstPage)
    })
    document.getElementById('knowledgeSourceName')?.addEventListener('change', renderKnowledgeNewsFirstPage)
    document.getElementById('knowledgeTagFilters')?.addEventListener('change', renderKnowledgeNewsFirstPage)
    document.getElementById('knowledgeQuery')?.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Enter') {
        renderKnowledgeNewsFirstPage()
      }
    })
    if (!knowledgeNewsEventsBound) {
      knowledgeNewsEventsBound = true
      window.addEventListener('licai:knowledge-news-open-doc', (event) => {
        void onKnowledgeNewsOpenDoc(event)
      })
      window.addEventListener('licai:knowledge-news-page-change', onKnowledgeNewsPageChange as EventListener)
      window.addEventListener('licai:knowledge-news-state-request', () => {
        if (knowledgeNewsRows.length === 0) {
          void renderKnowledgeNews()
          return
        }
        emitKnowledgeNewsTableState()
        emitKnowledgeNewsFiltersState()
      })
    }
    renderKnowledgeNewsFirstPage()
    void loadKnowledgeSourceOptions()
  }

  return initKnowledgeNews
}
