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
  isReport: boolean
  stockLinks: Array<{ name: string; code: string }>
  tags: string[]
  informationTags: string[]
  informationCategories: string[]
  modelTargets: Array<{ name: string; code: string }>
  favorited: boolean
  isFiltered: boolean
  isCompanyReport: boolean
  reportPages: number | null
  analysisState: 'idle' | 'loading' | 'done' | 'failed'
  analysisCalled: boolean
  analysisError: string
  latestPrice: number | null
  forecasts: Array<{
    year: number
    revenue: number | null
    revenue_growth: number | null
    net_profit: number | null
    profit_growth: number | null
    current_pe: number | null
    peg: number | null
  }>
  peg2028: number | null
  recommended: boolean
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
  let knowledgeNewsInformationTagOptions: Array<{value: string; label: string}> = []
  let knowledgeNewsEntityOptions: Array<{value: string; label: string}> = []
  let knowledgeNewsSelectedInformationTags: string[] = []
  let knowledgeNewsSelectedEntity = ''
  let knowledgeNewsPredicateOptions: Array<{value: string; label: string}> = []
  let knowledgeNewsSelectedPredicate = ''
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
    if (name || code) {
      return name || code
    }
    const modelTargets = Array.isArray(item?.model_targets) ? item.model_targets : []
    return modelTargets.map((target: any) => {
      const targetName = String(target?.name || '').trim()
      const targetCode = String(target?.code || '').trim()
      return targetName && targetCode ? `${targetName} (${targetCode})` : (targetName || targetCode)
    }).filter(Boolean).join(' / ')
  }

  function emitKnowledgeNewsTableState() {
    window.dispatchEvent(new CustomEvent('licai:knowledge-news-table-state', {
      detail: {
        rows: knowledgeNewsRows.map((row) => ({ ...row })),
        currentPage: knowledgeNewsCurrentPage,
        hasNext: knowledgeNewsHasNext,
        companyReportMode: knowledgeNewsSelectedSourceType === 'company_report',
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
        informationTagOptions: knowledgeNewsInformationTagOptions,
        entityOptions: knowledgeNewsEntityOptions,
        selectedInformationTags: knowledgeNewsSelectedInformationTags,
        selectedEntity: knowledgeNewsSelectedEntity,
        predicateOptions: knowledgeNewsPredicateOptions,
        selectedPredicate: knowledgeNewsSelectedPredicate,
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
    const modelTargets = Array.isArray(item.model_targets)
      ? item.model_targets
        .map((target: any) => ({
          name: String(target?.name || '').trim(),
          code: String(target?.code || '').trim(),
        }))
        .filter((target: { name: string; code: string }) => target.name && target.code)
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
      isReport: item.source_type === 'research_report'
        || ['company_report', 'industry_report', 'research_report'].includes(String(item.report_type || '')),
      stockLinks,
      tags,
      informationTags: normalizeKnowledgeNewsTags(item.information_tags),
      informationCategories: normalizeKnowledgeNewsTags(item.information_categories),
      modelTargets,
      favorited: Boolean(item.favorited),
      isFiltered: item.source_type === 'filtered_review' || Boolean(item.filter),
      isCompanyReport: item.source_type === 'research_report' && item.report_type === 'company_report',
      reportPages: Number.isInteger(Number(item.report_pages)) && Number(item.report_pages) > 0
        ? Number(item.report_pages)
        : null,
      analysisState: 'idle',
      analysisCalled: false,
      analysisError: '',
      latestPrice: null,
      forecasts: [],
      peg2028: null,
      recommended: false,
      document: item && typeof item === 'object' ? item : {},
    }
  }

  async function enrichKnowledgeCompanyReports(requestId: number) {
    const pendingRows = knowledgeNewsRows.filter((row) => row.isCompanyReport && row.docId)
    let nextIndex = 0
    async function worker() {
      while (nextIndex < pendingRows.length) {
        const row = pendingRows[nextIndex]
        nextIndex += 1
        row.analysisState = 'loading'
        emitKnowledgeNewsTableState()
        try {
          const response = await fetch(`${server}/api/knowledge/report-analysis`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: row.docId }),
          })
          const payload = await response.json() as { code?: number; data?: any; msg?: string }
          if (!response.ok || payload.code !== 200) {
            throw new Error(payload.msg || `研报分析请求失败：${response.status}`)
          }
          const data = payload.data
          if (requestId !== knowledgeNewsRenderRequestId) {
            return
          }
          row.reportPages = Number.isInteger(Number(data?.report_pages)) && Number(data.report_pages) > 0
            ? Number(data.report_pages)
            : row.reportPages
          row.analysisCalled = Boolean(data?.analysis_called)
          row.latestPrice = Number.isFinite(Number(data?.latest_price)) ? Number(data.latest_price) : null
          row.forecasts = Array.isArray(data?.forecasts) ? data.forecasts : []
          row.peg2028 = Number.isFinite(Number(data?.peg_2028)) ? Number(data.peg_2028) : null
          row.recommended = Boolean(data?.recommended)
          row.analysisState = 'done'
        } catch (error) {
          if (requestId !== knowledgeNewsRenderRequestId) {
            return
          }
          row.analysisState = 'failed'
          row.analysisError = error instanceof Error ? error.message : String(error)
        }
        emitKnowledgeNewsTableState()
      }
    }
    await Promise.all([worker(), worker()])
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
    const selectedInformationTags = Array.from(document.querySelectorAll<HTMLInputElement>('#knowledgeInformationTagFilters input[name="knowledgeInformationTagFilter"]:checked'))
      .map((input) => input.value)
      .filter(Boolean)
    const informationEntity = ((document.getElementById('knowledgeEntity') as HTMLInputElement | null)?.value || '').trim()
    const informationCategory = ((document.getElementById('knowledgePredicate') as HTMLInputElement | null)?.value || '').trim()
    const queryInput = document.getElementById('knowledgeQuery') as HTMLInputElement | null
    const query = isLocalKnowledgeNewsHost() ? (queryInput?.value || '') : ''
    const pageSize = 50
    knowledgeNewsSelectedTags = selectedTags
    knowledgeNewsSelectedSourceType = sourceType
    knowledgeNewsSelectedSourceName = source
    knowledgeNewsSelectedIndustry = industry
    knowledgeNewsSelectedInformationTags = selectedInformationTags
    knowledgeNewsSelectedEntity = informationEntity
    knowledgeNewsSelectedPredicate = informationCategory

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
        informationTags: selectedInformationTags.join(','),
        informationEntity,
        informationCategory,
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
    if (sourceType === 'company_report') {
      void enrichKnowledgeCompanyReports(requestId)
    }
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

  async function loadKnowledgeInformationFilterOptions() {
    const data = await fetchRequest({
      url: `${server}/api/knowledge/information-filters`,
    }) as any
    const informationTypeLabels: Record<string, string> = {
      fact: '事实', guidance: '指引', forecast: '预测', opinion: '观点', event: '事件', relationship: '关系',
    }
    const informationTypes = Array.isArray(data?.information_types) ? data.information_types : []
    const entities = Array.isArray(data?.entities) ? data.entities : []
    const categories = Array.isArray(data?.categories) ? data.categories : []
    knowledgeNewsInformationTagOptions = [
      { value: 'processed', label: '已模型整理' },
      ...informationTypes.map((item: any) => ({
        value: `information_type:${String(item?.value || '').trim()}`,
        label: informationTypeLabels[String(item?.value || '').trim()] || String(item?.value || '').trim(),
      })),
    ].filter((option) => option.value && option.label)
    knowledgeNewsEntityOptions = entities.map((item: any) => {
      const name = String(item?.name || '').trim()
      const count = Number(item?.count || 0)
      return { value: name, label: count > 0 ? `${name} (${count})` : name }
    }).filter((option: {value: string}) => option.value)
    knowledgeNewsPredicateOptions = categories.map((item: any) => {
      const value = String(item?.value || '').trim()
      const count = Number(item?.count || 0)
      return { value, label: count > 0 ? `${value} (${count})` : value }
    }).filter((option: {value: string}) => option.value)
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
    document.getElementById('knowledgeInformationTagFilters')?.addEventListener('change', renderKnowledgeNewsFirstPage)
    document.getElementById('knowledgeEntity')?.addEventListener('change', renderKnowledgeNewsFirstPage)
    document.getElementById('knowledgePredicate')?.addEventListener('change', renderKnowledgeNewsFirstPage)
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
    void loadKnowledgeInformationFilterOptions()
  }

  return initKnowledgeNews
}
