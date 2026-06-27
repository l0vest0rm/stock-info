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
  sourceName: string
  title: string
  docId: string
  sourceUrl: string
  accessMethod: string
  isLocalNews: boolean
  tags: string[]
  favorited: boolean
  isFiltered: boolean
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
  let knowledgeNewsCurrentDocId = ''
  let knowledgeNewsCurrentDocFiltered = false
  let knowledgeNewsModalInstance: any = null

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

  function knowledgeDisplayTime(item: any): string {
    const primary = formatKnowledgeTime(item.event_time || item.published_at)
    if (primary !== '-') {
      return primary
    }
    return formatKnowledgeTime(item.fetched_at)
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
      displayTime: knowledgeDisplayTime(item),
      sourceType: knowledgeReportTypeText(item),
      target: knowledgeTargetText(item),
      sourceName: String(item.source_name || ''),
      title: String(item.title || ''),
      docId,
      sourceUrl: String(item.url || ''),
      accessMethod: String(item.access_method || ''),
      isLocalNews: item.source_type === 'local_news',
      tags,
      favorited: Boolean(item.favorited),
      isFiltered: item.source_type === 'filtered_review' || Boolean(item.filter),
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

    const data = sourceType === 'filtered_review'
      ? await fetchRequest({
        url: `${server}/api/knowledge/filtered`,
        params: { q: query, page: knowledgeNewsCurrentPage, pageSize, status: 'pending' },
      }) as any
      : await fetchKnowledgeNewsPage({
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

  function openExternalUrl(url: string) {
    const link = document.createElement('a')
    link.href = url
    link.target = '_blank'
    link.rel = 'noreferrer noopener'
    document.body.appendChild(link)
    link.click()
    link.remove()
  }

  function knowledgeNewsOriginalUrl(data: any) {
    const url = String(data && data.url ? data.url : '').trim()
    if (!url) {
      return ''
    }
    return url
  }

  async function keepFilteredDocument(docID: string) {
    await fetchRequest({
      url: `${server}/api/knowledge/filtered/keep`,
      data: { id: docID },
    })
    await renderKnowledgeNews()
  }

  function stockHref(code: string) {
    return `company.html?code=${encodeURIComponent(code)}`
  }

  function linkStockReferences(root: HTMLElement, stockLinks: any[]) {
    const links = Array.isArray(stockLinks) ? stockLinks : []
    const aliases = links.flatMap((item) => {
      const code = String(item?.code || '').trim()
      const values = Array.isArray(item?.aliases) ? item.aliases : []
      return values
        .map((alias: unknown) => String(alias || '').trim())
        .filter((alias: string) => alias && code)
        .map((alias: string) => ({ alias, code }))
    }).sort((a, b) => b.alias.length - a.alias.length)
    if (aliases.length === 0) {
      return
    }
    const ignored = new Set(['A', 'SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE'])
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement
        if (!parent || ignored.has(parent.tagName)) {
          return NodeFilter.FILTER_REJECT
        }
        const value = node.nodeValue || ''
        return aliases.some((item) => value.includes(item.alias))
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT
      }
    })
    const nodes: Text[] = []
    while (walker.nextNode()) {
      nodes.push(walker.currentNode as Text)
    }
    for (const node of nodes) {
      const value = node.nodeValue || ''
      const match = aliases.find((item) => value.includes(item.alias))
      if (!match) continue
      const index = value.indexOf(match.alias)
      const fragment = document.createDocumentFragment()
      if (index > 0) fragment.append(document.createTextNode(value.slice(0, index)))
      const link = document.createElement('a')
      link.href = stockHref(match.code)
      link.target = '_blank'
      link.rel = 'noopener'
      link.textContent = match.alias
      fragment.append(link)
      if (index + match.alias.length < value.length) {
        fragment.append(document.createTextNode(value.slice(index + match.alias.length)))
      }
      node.replaceWith(fragment)
    }
  }

  function renderKnowledgeDocContent(content: string) {
    const marked = (window as any).marked
    const normalizedContent = normalizeMarkdownHeadings(content)
    if (!marked || typeof marked.parse !== 'function') {
      return `<pre class="text-wrap">${escapeHtml(normalizedContent)}</pre>`
    }
    return marked.parse(normalizedContent, {
      gfm: true,
      breaks: true,
    })
  }

  function normalizeMarkdownHeadings(content: string): string {
    return String(content || '')
      .split(/\r?\n/)
      .map((line) => {
        const match = line.match(/^(\s{0,3})(#{1,6})([^\s#].*)$/)
        if (!match) {
          return line
        }
        const [, indent, hashes, rest] = match
        const trimmed = rest.trim()
        if (!trimmed || trimmed.includes('#') || trimmed.length > 80) {
          return line
        }
        return `${indent}${hashes} ${trimmed}`
      })
      .join('\n')
  }

  async function showKnowledgeDocument(docID: string, filtered: boolean = false) {
    if (!docID) {
      return
    }
    const data = await fetchRequest({
      url: filtered ? `${server}/api/knowledge/filtered/doc` : `${server}/api/knowledge/doc`,
      params: { id: docID }
    }) as any
    const title = data && data.title ? data.title : ''
    const content = data && data.content ? data.content : ''
    const url = knowledgeNewsOriginalUrl(data)
    const meta = [
      knowledgeReportTypeText(data),
      knowledgeTargetText(data),
      data.source_name,
      `时间 ${knowledgeDisplayTime(data)}`,
    ].filter((value) => value && value !== '-').map(escapeHtml).join(' / ')
    document.getElementById('knowledgeDocModalTitle')!.textContent = title
    const favoriteButton = document.getElementById('knowledgeDocFavoriteBtn') as HTMLButtonElement | null
    if (favoriteButton) {
      favoriteButton.className = filtered ? 'btn btn-sm btn-outline-success me-2' : 'btn btn-sm btn-outline-warning d-none'
      favoriteButton.textContent = '保留'
      favoriteButton.onclick = filtered ? () => { void keepFilteredDocument(docID) } : null
    }
    document.getElementById('knowledgeDocMeta')!.innerHTML = `${meta}${url ? ` <a class="ms-2" href="${escapeHtml(url)}" target="_blank" rel="noreferrer noopener">打开原文</a>` : ''}`
    const contentElem = document.getElementById('knowledgeDocContent')!
    contentElem.innerHTML = renderKnowledgeDocContent(content)
    linkStockReferences(contentElem, data.stock_links || [])
    const modal = document.getElementById('knowledgeDocModal')
    if (!knowledgeNewsModalInstance) {
      knowledgeNewsModalInstance = new (window as any).bootstrap.Modal(modal)
    }
    knowledgeNewsCurrentDocId = docID
    knowledgeNewsCurrentDocFiltered = filtered
    syncKnowledgeDocStateToUrl(docID, filtered)
    knowledgeNewsModalInstance.show()
  }

  async function onKnowledgeNewsOpenDoc(event: Event) {
    const detail = (event as CustomEvent<{docId?: string; filtered?: boolean; sourceUrl?: string}>).detail
    await showKnowledgeDocument(detail?.docId || '', Boolean(detail?.filtered))
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
      if (knowledgeNewsModalInstance) {
        knowledgeNewsModalInstance.hide()
      }
      clearKnowledgeDocState(mode)
      return
    }
    if (knowledgeNewsCurrentDocId === docId && knowledgeNewsCurrentDocFiltered === filtered) {
      syncKnowledgeDocStateToUrl(docId, filtered, mode)
      return
    }
    syncKnowledgeDocStateToUrl(docId, filtered, mode)
    void showKnowledgeDocument(docId, filtered)
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
    document.getElementById('knowledgeDocModal')?.addEventListener('hidden.bs.modal', () => {
      clearKnowledgeDocState('replace')
    })
    if (!knowledgeNewsEventsBound) {
      knowledgeNewsEventsBound = true
      window.addEventListener('licai:knowledge-news-open-doc', (event) => {
        void onKnowledgeNewsOpenDoc(event)
      })
      window.addEventListener('licai:knowledge-news-page-change', onKnowledgeNewsPageChange as EventListener)
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
    restoreKnowledgeDocumentFromUrl('replace')
  }

  return initKnowledgeNews
}
