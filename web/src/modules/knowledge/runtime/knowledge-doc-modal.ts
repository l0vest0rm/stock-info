type KnowledgeDocFetchRequest = (request: {
  url?: string
  params?: Record<string, unknown>
  data?: unknown
  cacheKey?: string
  cacheTtl?: number
}) => Promise<unknown>

type KnowledgeDocModalContext = {
  server: string
  fetchRequest: KnowledgeDocFetchRequest
  onKeepFilteredDocument?: (docId: string) => Promise<void>
}

const defaultEscapeHtml = (value: unknown): string => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;')

export const knowledgeDocModalStyles = `
#knowledgeDocContent > *:first-child {
  margin-top: 0;
}

#knowledgeDocContent > *:last-child {
  margin-bottom: 0;
}

#knowledgeDocContent p,
#knowledgeDocContent ul,
#knowledgeDocContent ol,
#knowledgeDocContent pre,
#knowledgeDocContent blockquote {
  margin-bottom: 1rem;
}

#knowledgeDocContent h1,
#knowledgeDocContent h2,
#knowledgeDocContent h3,
#knowledgeDocContent h4,
#knowledgeDocContent h5,
#knowledgeDocContent h6 {
  margin: 1.25rem 0 0.75rem;
}
`

export function formatKnowledgeTime(value: string): string {
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
    hour12: false,
  }).formatToParts(date)
  const pick = (type: string) => parts.find((part) => part.type === type)?.value || ''
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}:${pick('second')}`
}

export function knowledgeDisplayTime(item: any): string {
  const primary = formatKnowledgeTime(item.event_time || item.published_at)
  if (primary !== '-') {
    return primary
  }
  return formatKnowledgeTime(item.fetched_at)
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

function knowledgeOriginalUrl(data: any) {
  return String(data && data.url ? data.url : '').trim()
}

async function fetchKnowledgeDocumentContent(data: any) {
  const inlineContent = typeof data?.content === 'string' ? data.content : ''
  if (inlineContent) {
    return inlineContent
  }
  const contentUrl = String(data && data.content_url ? data.content_url : '').trim()
  if (!contentUrl) {
    return String(data && data.title ? data.title : '')
  }
  let response: Response
  try {
    response = await fetch(contentUrl, { credentials: 'omit', cache: 'reload' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`正文加载失败: ${message}`)
  }
  if (!response.ok) {
    let detail = ''
    const contentType = response.headers.get('content-type') || ''
    try {
      if (contentType.includes('application/json')) {
        const json = await response.json() as { msg?: string }
        detail = String(json?.msg || '').trim()
      } else {
        detail = (await response.text()).trim()
      }
    } catch {
      detail = ''
    }
    throw new Error(detail ? `正文加载失败: ${detail}` : `正文加载失败: HTTP ${response.status}`)
  }
  return response.text()
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
    },
  })
  const nodes: Text[] = []
  while (walker.nextNode()) {
    nodes.push(walker.currentNode as Text)
  }
  for (const node of nodes) {
    const value = node.nodeValue || ''
    const match = aliases.find((item) => value.includes(item.alias))
    if (!match) {
      continue
    }
    const index = value.indexOf(match.alias)
    const fragment = document.createDocumentFragment()
    if (index > 0) {
      fragment.append(document.createTextNode(value.slice(0, index)))
    }
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

function renderKnowledgeDocContent(content: string) {
  const marked = (window as any).marked
  const normalizedContent = normalizeMarkdownHeadings(content)
  if (!marked || typeof marked.parse !== 'function') {
    return `<pre class="text-wrap">${defaultEscapeHtml(normalizedContent)}</pre>`
  }
  return marked.parse(normalizedContent, {
    gfm: true,
    breaks: true,
  })
}

export function createKnowledgeDocModalController(context: KnowledgeDocModalContext) {
  const { server, fetchRequest, onKeepFilteredDocument } = context
  let modalInstance: any = null
  let currentDocId = ''
  let currentFiltered = false

  function getModalElements() {
    return {
      modal: document.getElementById('knowledgeDocModal'),
      title: document.getElementById('knowledgeDocModalTitle'),
      content: document.getElementById('knowledgeDocContent'),
      meta: document.getElementById('knowledgeDocMeta'),
      favoriteButton: document.getElementById('knowledgeDocFavoriteBtn') as HTMLButtonElement | null,
    }
  }

  function ensureModal() {
    const { modal } = getModalElements()
    if (!modal) {
      throw new Error('knowledge document modal is missing')
    }
    if (!modalInstance) {
      modalInstance = new (window as any).bootstrap.Modal(modal)
    }
    return modalInstance
  }

  function clearCurrent() {
    currentDocId = ''
    currentFiltered = false
  }

  function bindLifecycle() {
    const { modal } = getModalElements()
    if (!modal || (modal as any).__knowledgeDocModalBound) {
      return
    }
    ;(modal as any).__knowledgeDocModalBound = true
    modal.addEventListener('hidden.bs.modal', () => {
      clearCurrent()
    })
  }

  async function openByDocId(docId: string, filtered: boolean = false) {
    const trimmedDocId = String(docId || '').trim()
    if (!trimmedDocId) {
      return
    }
    const data = await fetchRequest({
      url: filtered ? `${server}/api/knowledge/filtered/doc` : `${server}/api/knowledge/doc`,
      params: { id: trimmedDocId },
    }) as any
    const { title, content, meta, favoriteButton } = getModalElements()
    if (!title || !content || !meta) {
      throw new Error('knowledge document modal elements are missing')
    }
    const originalUrl = knowledgeOriginalUrl(data)
    const metaText = [
      knowledgeReportTypeText(data),
      knowledgeTargetText(data),
      data.source_name,
      `时间 ${knowledgeDisplayTime(data)}`,
    ].filter((value) => value && value !== '-').map(defaultEscapeHtml).join(' / ')
    title.textContent = data && data.title ? data.title : ''
    if (favoriteButton) {
      if (filtered && onKeepFilteredDocument) {
        favoriteButton.className = 'btn btn-sm btn-outline-success me-2'
        favoriteButton.textContent = '保留'
        favoriteButton.onclick = () => { void onKeepFilteredDocument(trimmedDocId) }
      } else {
        favoriteButton.className = 'btn btn-sm btn-outline-warning d-none'
        favoriteButton.onclick = null
      }
    }
    meta.innerHTML = `${metaText}${originalUrl ? ` <a class="ms-2" href="${defaultEscapeHtml(originalUrl)}" target="_blank" rel="noreferrer noopener">打开原文</a>` : ''}`
    content.innerHTML = '<div class="text-muted">正文加载中...</div>'
    currentDocId = trimmedDocId
    currentFiltered = filtered
    ensureModal().show()
    try {
      const loadedContent = await fetchKnowledgeDocumentContent(data)
      if (currentDocId !== trimmedDocId || currentFiltered !== filtered) {
        return
      }
      content.innerHTML = renderKnowledgeDocContent(loadedContent)
      linkStockReferences(content, data.stock_links || [])
    } catch (error) {
      if (currentDocId !== trimmedDocId || currentFiltered !== filtered) {
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      content.innerHTML = `<div class="alert alert-danger mb-0" role="alert">${defaultEscapeHtml(message)}</div>`
    }
  }

  async function keepFiltered(docId: string) {
    if (!onKeepFilteredDocument) {
      return
    }
    await onKeepFilteredDocument(docId)
  }

  return {
    bindLifecycle,
    keepFiltered,
    openByDocId,
  }
}
