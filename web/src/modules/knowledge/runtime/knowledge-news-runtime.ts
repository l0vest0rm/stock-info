import { createKnowledgeDocModalController, knowledgeDisplayTime } from './knowledge-doc-modal'

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
  displayTime: string
  sourceType: string
  target: string
  targetCode: string
  sourceName: string
  title: string
  docId: string
  sourceUrl: string
  contentUrl: string
  accessMethod: string
  stockLinks: Array<{ name: string; code: string }>
  tags: string[]
  favorited: boolean
  isFiltered: boolean
  document: Record<string, unknown>
}

export function createKnowledgeNewsInitializer(context: KnowledgeNewsRuntimeContext) {
  const { server, fetchRequest } = context

  let knowledgeNewsRows: KnowledgeNewsTableRow[] = []
  let knowledgeNewsCurrentPage = 1
  let knowledgeNewsHasNext = false
  let knowledgeNewsEventsBound = false
  let knowledgeNewsSourceNameOptions: Array<{value: string; label: string}> = [
    { value: 'all', label: '全部来源站点' }
  ]
  let knowledgeNewsIndustryOptions: Array<{value: string; label: string}> = []
  let knowledgeNewsSelectedSourceType = 'all'
  let knowledgeNewsSelectedSourceName = 'all'
  let knowledgeNewsSelectedIndustry = ''
  let knowledgeNewsSelectedTags: string[] = []
  let knowledgeNewsCurrentDocId = ''
  let knowledgeNewsCurrentDocFiltered = false
  let knowledgeNewsRenderRequestId = 0
  const knowledgeDocModal = createKnowledgeDocModalController({
    server,
    fetchRequest,
    onKeepFilteredDocument: keepFilteredDocument,
  })

  function isLocalKnowledgeNewsHost() {
    const hostname = window.location.hostname.toLowerCase()
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
  }

  function readKnowledgeDocStateFromUrl() {
    const url = new URL(window.location.href)
    return {
      docId: url.searchParams.get('docId')?.trim() || '',
      filtered: url.searchParams.get('docScope') === 'filtered',
    }
  }

  function syncKnowledgeDocStateToUrl(docId: string, filtered: boolean, mode: 'push' | 'replace' = 'push') {
    const current = readKnowledgeDocStateFromUrl()
    if (current.docId === docId && current.filtered === filtered) {
      return
    }
    const url = new URL(window.location.href)
    if (docId) {
      url.searchParams.set('docId', docId)
      if (filtered) {
        url.searchParams.set('docScope', 'filtered')
      } else {
        url.searchParams.delete('docScope')
      }
    } else {
      url.searchParams.delete('docId')
      url.searchParams.delete('docScope')
    }
    const method = mode === 'replace' ? 'replaceState' : 'pushState'
    window.history[method](window.history.state, '', url.toString())
  }

  function clearKnowledgeDocState(mode: 'push' | 'replace' = 'push') {
    knowledgeNewsCurrentDocId = ''
    knowledgeNewsCurrentDocFiltered = false
    syncKnowledgeDocStateToUrl('', false, mode)
  }

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
      case 'filtered_review':
        return '过滤Review'
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
        industryOptions: knowledgeNewsIndustryOptions,
        selectedSourceType: knowledgeNewsSelectedSourceType,
        selectedSourceName: knowledgeNewsSelectedSourceName,
        selectedIndustry: knowledgeNewsSelectedIndustry,
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

  function knowledgeNewsDedupeKey(item: any): string {
    return String(item?.doc_id || '')
  }

  function dedupeKnowledgeNewsItems(items: any[]): any[] {
    const seen = new Set<string>()
    const deduped: any[] = []
    for (const item of items) {
      const key = knowledgeNewsDedupeKey(item)
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      deduped.push(item)
    }
    return deduped
  }

  function mapKnowledgeNewsRow(item: any): KnowledgeNewsTableRow {
    const docId = String(item.doc_id || '')
    const tags = normalizeKnowledgeNewsTags(item.tags)
    const stockLinks = Array.isArray(item.stock_links)
      ? item.stock_links
        .map((link: any) => ({
          name: String(link?.name || '').trim(),
          code: String(link?.code || '').trim(),
        }))
        .filter((link: { name: string; code: string }) => link.name || link.code)
      : []
    return {
      displayTime: knowledgeDisplayTime(item),
      sourceType: knowledgeReportTypeText(item),
      target: knowledgeTargetText(item),
      targetCode: String(item.target_code || ''),
      sourceName: String(item.source_name || ''),
      title: String(item.title || ''),
      docId,
      sourceUrl: String(item.url || ''),
      contentUrl: String(item.content_url || ''),
      accessMethod: String(item.access_method || ''),
      stockLinks,
      tags,
      favorited: Boolean(item.favorited),
      isFiltered: item.source_type === 'filtered_review' || Boolean(item.filter),
      document: item && typeof item === 'object' ? item : {},
    }
  }

  async function fetchKnowledgeNewsPage(params: Record<string, unknown>) {
    return fetchRequest({
      url: `${server}/api/knowledge/docs`,
      params,
    }) as Promise<any>
  }

  async function renderKnowledgeNews() {
    const requestId = ++knowledgeNewsRenderRequestId
    const sourceType = (document.getElementById('knowledgeSourceType') as HTMLInputElement).value
    const source = (document.getElementById('knowledgeSourceName') as HTMLInputElement | null)?.value || 'all'
    const industry = sourceType === 'industry_report'
      ? ((document.getElementById('knowledgeIndustry') as HTMLInputElement | null)?.value || '').trim()
      : ''
    const selectedTags = Array.from(document.querySelectorAll<HTMLInputElement>('#knowledgeTagFilters input[name="knowledgeTagFilter"]:checked'))
      .map((input) => input.value)
      .filter(Boolean)
    const queryInput = document.getElementById('knowledgeQuery') as HTMLInputElement | null
    const query = isLocalKnowledgeNewsHost() ? (queryInput?.value || '') : ''
    const pageSize = 50
    knowledgeNewsSelectedTags = selectedTags
    knowledgeNewsSelectedSourceType = sourceType
    knowledgeNewsSelectedSourceName = source
    knowledgeNewsSelectedIndustry = industry

    const data = sourceType === 'filtered_review'
      ? await fetchRequest({
        url: `${server}/api/knowledge/filtered`,
        params: { q: query, page: knowledgeNewsCurrentPage, pageSize, status: 'pending' },
      }) as any
      : await fetchKnowledgeNewsPage({
        sourceType,
        source,
        industry,
        tags: selectedTags.join(','),
        q: query,
        page: knowledgeNewsCurrentPage,
        pageSize
      })
    if (requestId !== knowledgeNewsRenderRequestId) {
      return
    }
    const list = data && data.list ? dedupeKnowledgeNewsItems(data.list) : []
    knowledgeNewsRows = list.map((item: any): KnowledgeNewsTableRow => mapKnowledgeNewsRow(item))
    knowledgeNewsHasNext = typeof data?.has_next === 'boolean'
      ? data.has_next
      : list.length >= pageSize
    emitKnowledgeNewsTableState()
    emitKnowledgeNewsFiltersState()
    restoreKnowledgeDocumentFromUrl('replace')
  }

  function openExternalUrl(url: string) {
    const link = document.createElement('a')
    link.href = url
    link.target = '_blank'
    link.rel = 'noreferrer noopener'
    document.body.appendChild(link)
    link.click()
    link.remove()
  }

  async function keepFilteredDocument(docID: string) {
    await fetchRequest({
      url: `${server}/api/knowledge/filtered/keep`,
      data: { id: docID },
    })
    await renderKnowledgeNews()
  }

  async function showKnowledgeDocument(doc: Record<string, unknown> | string, filtered: boolean = false) {
    const data = doc && typeof doc === 'object' ? doc : null
    const docID = String((data?.doc_id as string) || doc || '')
    if (!docID) {
      return
    }
    knowledgeNewsCurrentDocId = docID
    knowledgeNewsCurrentDocFiltered = filtered
    syncKnowledgeDocStateToUrl(docID, filtered)
    if (data) {
      await knowledgeDocModal.openDocument(data, filtered)
      return
    }
    await knowledgeDocModal.openByDocId(docID, filtered)
  }

  async function onKnowledgeNewsOpenDoc(event: Event) {
    const detail = (event as CustomEvent<{docId?: string; filtered?: boolean; row?: { document?: Record<string, unknown> }}>).detail
    await showKnowledgeDocument(detail?.row?.document || detail?.docId || '', Boolean(detail?.filtered))
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

  function restoreKnowledgeDocumentFromUrl(mode: 'push' | 'replace' = 'replace') {
    const { docId, filtered } = readKnowledgeDocStateFromUrl()
    if (!docId) {
      knowledgeDocModal.hide()
      clearKnowledgeDocState(mode)
      return
    }
    if (knowledgeNewsCurrentDocId === docId && knowledgeNewsCurrentDocFiltered === filtered) {
      syncKnowledgeDocStateToUrl(docId, filtered, mode)
      return
    }
    syncKnowledgeDocStateToUrl(docId, filtered, mode)
    const matchedRow = knowledgeNewsRows.find((row) => row.docId === docId && row.isFiltered === filtered)
    void showKnowledgeDocument(matchedRow?.document || docId, filtered)
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

  async function loadKnowledgeIndustryOptions() {
    const data = await fetchRequest({
      url: `${server}/api/knowledge/industries`,
    }) as any
    const list = data && data.list ? data.list : []
    knowledgeNewsIndustryOptions = list
      .map((item: any) => {
        const name = String(item?.name || '').trim()
        return {
          value: name,
          label: `${name}${item?.count ? ` (${item.count})` : ''}`,
        }
      })
      .filter((option: {value: string}) => option.value)
    emitKnowledgeNewsFiltersState()
  }

  function initKnowledgeNews() {
    document.getElementById('knowledgeSearchBtn')?.addEventListener('click', renderKnowledgeNewsFirstPage)
    document.getElementById('knowledgeSourceType')?.addEventListener('change', (event) => {
      knowledgeNewsSelectedSourceType = (event.target as HTMLSelectElement).value
      knowledgeNewsSelectedIndustry = ''
      emitKnowledgeNewsFiltersState()
      void loadKnowledgeSourceOptions(true).then(renderKnowledgeNewsFirstPage)
    })
    document.getElementById('knowledgeSourceName')?.addEventListener('change', renderKnowledgeNewsFirstPage)
    document.getElementById('knowledgeTagFilters')?.addEventListener('change', renderKnowledgeNewsFirstPage)
    const queryInput = document.getElementById('knowledgeQuery') as HTMLInputElement | null
    if (queryInput && !isLocalKnowledgeNewsHost()) {
      queryInput.closest('[data-knowledge-query-control]')?.classList.add('d-none')
      queryInput.value = ''
    }
    queryInput?.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Enter') {
        renderKnowledgeNewsFirstPage()
      }
    })
    document.getElementById('knowledgeDocModal')?.addEventListener('hidden.bs.modal', () => {
      clearKnowledgeDocState('replace')
    })
    knowledgeDocModal.bindLifecycle()
    if (!knowledgeNewsEventsBound) {
      knowledgeNewsEventsBound = true
      window.addEventListener('licai:knowledge-news-open-doc', (event) => {
        void onKnowledgeNewsOpenDoc(event)
      })
      window.addEventListener('licai:knowledge-news-page-change', onKnowledgeNewsPageChange as EventListener)
      window.addEventListener('licai:knowledge-news-industry-change', (event) => {
        const detail = (event as CustomEvent<{industry?: string}>).detail
        knowledgeNewsSelectedIndustry = String(detail?.industry || '').trim()
        renderKnowledgeNewsFirstPage()
      })
      window.addEventListener('popstate', () => {
        restoreKnowledgeDocumentFromUrl('replace')
      })
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
    void loadKnowledgeIndustryOptions()
  }

  return initKnowledgeNews
}
