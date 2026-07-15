import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue'
import { knowledgeDocModalStyles } from '../runtime/knowledge-doc-modal'

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
  document?: Record<string, unknown>
}

type KnowledgeNewsTableStateEvent = CustomEvent<{
  rows?: KnowledgeNewsTableRow[]
  currentPage?: number
  hasNext?: boolean
}>

type KnowledgeNewsFilterOption = {
  value: string
  label: string
}

type KnowledgeNewsFiltersStateEvent = CustomEvent<{
  sourceNameOptions?: KnowledgeNewsFilterOption[]
  selectedSourceName?: string
  selectedTags?: string[]
}>

const knowledgeNewsTargetStyle = `
#knowledgeNews .knowledge-news-target-cell {
  max-width: 220px;
  position: relative;
  width: 220px;
}

#knowledgeNews .knowledge-news-title-link {
  color: var(--bs-body-color);
  text-decoration: none;
}

#knowledgeNews .knowledge-news-title-link:hover,
#knowledgeNews .knowledge-news-title-link:focus {
  text-decoration: underline;
}

#knowledgeNews .knowledge-news-title-read,
#knowledgeNews .knowledge-news-title-read .knowledge-news-title-link {
  color: #6c757d;
}

#knowledgeNews .knowledge-news-target-text {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

#knowledgeNews .knowledge-news-target-link {
  color: inherit;
  text-decoration: none;
}

#knowledgeNews .knowledge-news-target-link:hover,
#knowledgeNews .knowledge-news-target-link:focus {
  text-decoration: underline;
}

#knowledgeNews .knowledge-news-target-tooltip {
  background: #fff;
  border: 1px solid rgba(0, 0, 0, .175);
  border-radius: .375rem;
  box-shadow: 0 .5rem 1rem rgba(0, 0, 0, .15);
  color: #212529;
  display: none;
  left: 0;
  line-height: 1.5;
  margin-top: .25rem;
  max-width: min(720px, 70vw);
  padding: .5rem .75rem;
  position: absolute;
  top: 100%;
  white-space: normal;
  width: max-content;
  z-index: 1080;
}

#knowledgeNews .knowledge-news-target-cell:hover .knowledge-news-target-tooltip,
#knowledgeNews .knowledge-news-target-cell:focus-within .knowledge-news-target-tooltip {
  display: block;
}

#knowledgeTagFilters .knowledge-news-tag-menu {
  max-height: min(360px, 60vh);
  min-width: 180px;
  overflow-y: auto;
}

${knowledgeDocModalStyles}
`

const knowledgeNewsTagClassMap: Record<string, string> = {
  unread: 'text-bg-warning',
  pdf: 'text-bg-danger',
}

const knowledgeNewsTagLabelMap: Record<string, string> = {
  unread: '未读',
  pdf: 'PDF',
}

function emitKnowledgeNewsOpenDoc(row: KnowledgeNewsTableRow) {
  window.dispatchEvent(new CustomEvent('licai:knowledge-news-open-doc', {
    detail: { docId: row.docId, row },
  }))
}

function emitKnowledgeNewsOpenFilteredDoc(row: KnowledgeNewsTableRow) {
  window.dispatchEvent(new CustomEvent('licai:knowledge-news-open-doc', {
    detail: { docId: row.docId, filtered: true, row },
  }))
}

function knowledgeNewsLocalFileUrl(docId: string) {
  return `/api/knowledge/file?id=${encodeURIComponent(docId)}`
}

function openExternalUrlWithoutReferrer(url: string) {
  const trimmed = String(url || '').trim()
  if (!trimmed) {
    return
  }
  const link = document.createElement('a')
  link.href = trimmed
  link.target = '_blank'
  link.rel = 'noreferrer noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
}

function knowledgeNewsRemotePdfUrl(row: KnowledgeNewsTableRow) {
  const url = String(row.sourceUrl || '').trim()
  if (!url) {
    return ''
  }
  const lowerAccessMethod = String(row.accessMethod || '').toLowerCase()
  if (lowerAccessMethod.includes('remote_pdf') || lowerAccessMethod === 'pdf') {
    return url
  }
  return ''
}

function onKnowledgeNewsTitleClick(event: Event, row: KnowledgeNewsTableRow) {
  event.preventDefault()
  if (row.isFiltered) {
    emitKnowledgeNewsOpenFilteredDoc(row)
    return
  }
  const localFileUrl = row.accessMethod === 'local_file' && row.docId
    ? knowledgeNewsLocalFileUrl(row.docId)
    : ''
  if (localFileUrl) {
    window.open(localFileUrl, '_blank', 'noopener')
    return
  }
  const remotePdfUrl = knowledgeNewsRemotePdfUrl(row)
  if (remotePdfUrl) {
    openExternalUrlWithoutReferrer(remotePdfUrl)
    return
  }
  if (row.docId) {
    emitKnowledgeNewsOpenDoc(row)
  }
}

function emitKnowledgeNewsPageChange(page: number) {
  window.dispatchEvent(new CustomEvent('licai:knowledge-news-page-change', {
    detail: { page },
  }))
}

function knowledgeNewsPagination(currentPage: number, hasNext: boolean): Array<{
  active?: boolean
  disabled?: boolean
  key: string
  label: string
  page: number
}> {
  const items: Array<{
    active?: boolean
    disabled?: boolean
    key: string
    label: string
    page: number
  }> = [{
    disabled: currentPage < 11,
    key: 'prev-block',
    label: '<<',
    page: currentPage < 11 ? 1 : currentPage - 10,
  }]

  for (let i = 1; i < 11; i += 1) {
    let page = currentPage
    let label = String(page)
    if (currentPage < 9) {
      page = i
      label = String(page)
    } else if (i < 4) {
      page = i
      label = String(page)
    } else if (i === 4) {
      page = Math.floor(currentPage / 2)
      label = '...'
    } else {
      page = currentPage + i - 8
      label = String(page)
    }
    items.push({
      active: currentPage === page,
      disabled: page > currentPage && !hasNext,
      key: `page-${i}-${page}-${label}`,
      label,
      page,
    })
  }

  items.push({
    disabled: !hasNext,
    key: 'next-block',
    label: '>>',
    page: currentPage + 10,
  })
  return items
}

function knowledgeNewsTitleContent(row: KnowledgeNewsTableRow) {
  const title = row.docId
    ? h('a', {
      href: '#',
      class: 'knowledge-news-title-link',
      onClick: (event: Event) => {
        onKnowledgeNewsTitleClick(event, row)
      },
    }, row.title)
    : row.title
  const tags = row.tags.slice()
  return [
    title,
    ...tags.map((tag) => h('span', {
      key: tag,
      class: `ms-2 badge ${knowledgeNewsTagClassMap[tag] || 'text-bg-secondary'}`,
    }, knowledgeNewsTagLabelMap[tag] || tag)),
  ]
}

function knowledgeNewsTargetCell(row: KnowledgeNewsTableRow) {
  const links = row.stockLinks.filter((item) => item.code)
  const fallbackLink = row.targetCode
    ? [{ code: row.targetCode, name: row.target || row.targetCode }]
    : []
  const resolvedLinks = (links.length > 0 ? links : fallbackLink)
    .map((item) => ({
      code: item.code,
      label: item.name && item.code ? `${item.name} (${item.code})` : (item.name || item.code),
    }))
    .filter((item) => item.label)
  return h('td', { class: 'knowledge-news-target-cell' }, [
    resolvedLinks.length > 0
      ? h('span', { class: 'knowledge-news-target-text', title: row.target }, resolvedLinks.flatMap((item, index) => {
        const parts = [
          h('a', {
            href: `company.html?code=${encodeURIComponent(item.code)}`,
            class: 'knowledge-news-target-link',
            target: '_blank',
            rel: 'noopener',
          }, item.label),
        ]
        if (index < resolvedLinks.length - 1) {
          parts.push(' / ')
        }
        return parts
      }))
      : h('span', { class: 'knowledge-news-target-text', title: row.target }, row.target),
    row.target && row.target !== '-'
      ? h('div', { class: 'knowledge-news-target-tooltip' }, row.target)
      : null,
  ])
}

function knowledgeNewsSelectedTagText(options: KnowledgeNewsFilterOption[], selectedTags: string[]) {
  if (selectedTags.length === 0) {
    return '标签'
  }
  const labels = selectedTags
    .map((tag) => options.find((option) => option.value === tag)?.label || knowledgeNewsTagLabelMap[tag] || tag)
    .filter(Boolean)
  if (labels.length <= 2) {
    return labels.join('、')
  }
  return `标签 ${labels.length}`
}

const KnowledgeNewsTable = defineComponent({
  name: 'KnowledgeNewsTable',
  setup() {
    const rows = ref<KnowledgeNewsTableRow[]>([])
    const currentPage = ref(1)
    const hasNext = ref(false)

    const onState = (event: Event) => {
      const detail = (event as KnowledgeNewsTableStateEvent).detail
      rows.value = Array.isArray(detail?.rows) ? detail.rows : []
      if (typeof detail?.currentPage === 'number' && Number.isFinite(detail.currentPage)) {
        currentPage.value = detail.currentPage
      }
      hasNext.value = Boolean(detail?.hasNext)
    }

    onMounted(() => {
      window.addEventListener('licai:knowledge-news-table-state', onState)
      window.dispatchEvent(new CustomEvent('licai:knowledge-news-state-request'))
    })

    onBeforeUnmount(() => {
      window.removeEventListener('licai:knowledge-news-table-state', onState)
    })

    const pagination = () => {
      if (currentPage.value === 1 && rows.value.length === 0) {
        return null
      }
      return h('nav', { id: 'knowledgeNews-nav' }, [
        h('ul', { class: 'pagination justify-content-center' }, knowledgeNewsPagination(currentPage.value, hasNext.value).map((item) => (
          h('li', {
            key: item.key,
            class: ['page-item', item.active ? 'active' : '', item.disabled ? 'disabled' : ''].filter(Boolean).join(' '),
          }, [
            h('a', {
              href: '#',
              class: 'page-link',
              'data-page': String(item.page),
              onClick: (event: Event) => {
                event.preventDefault()
                if (item.disabled || item.active) {
                  return
                }
                emitKnowledgeNewsPageChange(item.page)
              },
            }, item.label),
          ])
        ))),
      ])
    }

    return () => h('div', [
      h('style', knowledgeNewsTargetStyle),
      h('table', { id: 'knowledgeNews', class: 'table table-sm table-bordered table-hover align-middle' }, [
        h('thead', { class: 'table-info' }, [
          h('tr', [
            h('th', { scope: 'col' }, '时间'),
            h('th', { scope: 'col' }, '类型'),
            h('th', { scope: 'col', style: 'width: 220px;' }, '目标'),
            h('th', { scope: 'col' }, '来源'),
            h('th', { scope: 'col' }, '标题'),
          ]),
        ]),
        h('tbody', rows.value.map((row) => h('tr', { key: `${row.docId}-${row.title}` }, [
          h('td', row.displayTime),
          h('td', row.sourceType),
          knowledgeNewsTargetCell(row),
          h('td', row.sourceName),
          h('td', knowledgeNewsTitleContent(row)),
        ]))),
      ]),
      pagination(),
    ])
  },
})

const KnowledgeNewsPage = defineComponent({
  name: 'KnowledgeNewsPage',
  setup() {
    const isLocalKnowledgeHost = (() => {
      const hostname = window.location.hostname.toLowerCase()
      return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
    })()
    const sourceNameOptions = ref<KnowledgeNewsFilterOption[]>([
      { value: 'all', label: '全部来源站点' },
    ])
    const selectedSourceName = ref('all')
    const selectedTags = ref<string[]>([])
    const tagFilterOptions: KnowledgeNewsFilterOption[] = [
      { value: 'pdf', label: 'PDF' },
    ]

    const onFiltersState = (event: Event) => {
      const detail = (event as KnowledgeNewsFiltersStateEvent).detail
      if (Array.isArray(detail?.sourceNameOptions) && detail.sourceNameOptions.length > 0) {
        sourceNameOptions.value = detail.sourceNameOptions
      }
      if (typeof detail?.selectedSourceName === 'string') {
        selectedSourceName.value = detail.selectedSourceName
      }
      if (Array.isArray(detail?.selectedTags)) {
        selectedTags.value = detail.selectedTags
      }
    }

    onMounted(() => {
      window.addEventListener('licai:knowledge-news-filters-state', onFiltersState)
      window.dispatchEvent(new CustomEvent('licai:knowledge-news-state-request'))
    })

    onBeforeUnmount(() => {
      window.removeEventListener('licai:knowledge-news-filters-state', onFiltersState)
    })

    return () => h('div', [
      h('div', { id: 'container', class: 'py-3' }, [
        h('div', { class: 'd-flex flex-wrap align-items-center gap-2 mb-3' }, [
          h('select', { id: 'knowledgeSourceType', class: 'form-select form-select-sm', style: 'width: 160px;' }, [
            h('option', { value: 'all', selected: true }, '全部来源'),
            h('option', { value: 'web_news' }, '新闻'),
            h('option', { value: 'local_news' }, '本地新闻'),
            h('option', { value: 'sec_filing' }, 'SEC披露'),
            h('option', { value: 'research_report' }, '全部研报'),
            h('option', { value: 'company_report' }, '公司研报'),
            h('option', { value: 'industry_report' }, '行业研报'),
            isLocalKnowledgeHost ? h('option', { value: 'filtered_review' }, '过滤Review') : null,
          ]),
          h('select', { id: 'knowledgeSourceName', class: 'form-select form-select-sm', style: 'width: 180px;' }, [
            ...sourceNameOptions.value.map((option) => h('option', {
              value: option.value,
              selected: selectedSourceName.value === option.value,
            }, option.label)),
          ]),
          h('div', { id: 'knowledgeTagFilters', class: 'dropdown' }, [
            h('button', {
              type: 'button',
              class: [
                'btn',
                'btn-sm',
                'dropdown-toggle',
                selectedTags.value.length > 0 ? 'btn-primary' : 'btn-outline-secondary',
              ].join(' '),
              'data-bs-toggle': 'dropdown',
              'data-bs-auto-close': 'outside',
              'aria-expanded': 'false',
            }, knowledgeNewsSelectedTagText(tagFilterOptions, selectedTags.value)),
            h('div', { class: 'dropdown-menu p-2 knowledge-news-tag-menu' }, [
              ...tagFilterOptions.map((option) => h('label', {
                key: option.value,
                class: 'dropdown-item d-flex align-items-center gap-2 mb-0',
              }, [
                h('input', {
                  type: 'checkbox',
                  class: 'form-check-input mt-0',
                  name: 'knowledgeTagFilter',
                  value: option.value,
                  checked: selectedTags.value.includes(option.value),
                }),
                h('span', option.label),
              ])),
            ]),
          ]),
          h('div', { 'data-knowledge-query-control': 'true', class: 'd-flex gap-2' }, [
            h('input', { id: 'knowledgeQuery', class: 'form-control form-control-sm', style: 'max-width: 360px;', placeholder: '标题、来源、目标、链接搜索' }),
          ]),
          h('button', { id: 'knowledgeSearchBtn', class: 'btn btn-primary btn-sm' }, '查询'),
        ]),
        h('div', { id: 'knowledgeNewsTableRoot' }),
      ]),
      h('div', { class: 'modal fade', id: 'knowledgeDocModal', tabindex: '-1', 'aria-labelledby': 'knowledgeDocModalTitle', 'aria-hidden': 'true' }, [
        h('div', { class: 'modal-dialog modal-xl modal-dialog-scrollable' }, [
          h('div', { class: 'modal-content' }, [
            h('div', { class: 'modal-header' }, [
              h('button', {
                type: 'button',
                class: 'btn btn-sm btn-outline-warning d-none',
                id: 'knowledgeDocFavoriteBtn',
              }, '收藏'),
              h('h1', { class: 'modal-title fs-5', id: 'knowledgeDocModalTitle' }),
              h('button', { type: 'button', class: 'btn-close', 'data-bs-dismiss': 'modal', 'aria-label': 'Close' }),
            ]),
            h('div', { class: 'modal-body' }, [
              h('div', { id: 'knowledgeDocContent', class: 'lh-lg' }),
              h('div', { id: 'knowledgeDocMeta', class: 'small text-muted mt-4 pt-3 border-top' }),
            ]),
          ]),
        ]),
      ]),
    ])
  },
})

const root = document.getElementById('knowledge-news-vue-root')
if (root) {
  createApp(KnowledgeNewsPage).mount(root)
  const tableRoot = document.getElementById('knowledgeNewsTableRoot')
  if (tableRoot) {
    createApp(KnowledgeNewsTable).mount(tableRoot)
  }
}
