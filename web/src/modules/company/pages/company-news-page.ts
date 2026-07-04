import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue'
import { knowledgeDocModalStyles } from '../../knowledge/runtime/knowledge-doc-modal'

const companyNewsStyles = `
#companyNewsFeed {
  --company-news-bg: linear-gradient(180deg, #f7f0e8 0%, #fcfaf7 18%, #f4f6f8 100%);
  --company-news-card: rgba(255, 255, 255, 0.94);
  --company-news-border: rgba(122, 101, 79, 0.14);
  --company-news-title: #1f2d3d;
  --company-news-meta: #7b8794;
  --company-news-text: #415161;
  --company-news-accent: #db6b2d;
  --company-news-accent-soft: rgba(219, 107, 45, 0.12);
  --company-news-divider: rgba(31, 45, 61, 0.08);
  background: var(--company-news-bg);
  border: 1px solid rgba(255, 255, 255, 0.6);
  border-radius: 28px;
  box-shadow: 0 24px 60px rgba(86, 61, 38, 0.08);
  padding: 24px;
}

#companyNewsFeed .company-news-list {
  display: grid;
  gap: 10px;
}

#companyNewsFeed .company-news-card {
  backdrop-filter: blur(8px);
  background: var(--company-news-card);
  border: 1px solid var(--company-news-border);
  border-radius: 18px;
  box-shadow: 0 8px 18px rgba(31, 45, 61, 0.05);
  overflow: hidden;
  padding: 14px 16px 12px;
  position: relative;
}

#companyNewsFeed .company-news-card::before {
  background: linear-gradient(180deg, rgba(219, 107, 45, 0.15), rgba(219, 107, 45, 0));
  content: "";
  height: 100%;
  left: 0;
  position: absolute;
  top: 0;
  width: 4px;
}

#companyNewsFeed .company-news-card-header {
  align-items: center;
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}

#companyNewsFeed .company-news-avatar {
  align-items: center;
  background: linear-gradient(135deg, #e8762f, #b84a1b);
  border-radius: 999px;
  color: #fff;
  display: inline-flex;
  flex: 0 0 auto;
  font-size: 12px;
  font-weight: 700;
  height: 24px;
  justify-content: center;
  width: 24px;
}

#companyNewsFeed .company-news-meta-main {
  min-width: 0;
  flex: 1 1 auto;
}

#companyNewsFeed .company-news-author-row {
  align-items: center;
  display: flex;
  flex-wrap: nowrap;
  gap: 6px;
  min-width: 0;
  white-space: nowrap;
}

#companyNewsFeed .company-news-author {
  color: var(--company-news-title);
  font-size: 13px;
  font-weight: 700;
  flex: 0 0 auto;
}

#companyNewsFeed .company-news-time,
#companyNewsFeed .company-news-source,
#companyNewsFeed .company-news-separator {
  color: var(--company-news-meta);
  font-size: 12px;
}

#companyNewsFeed .company-news-time,
#companyNewsFeed .company-news-source {
  overflow: hidden;
  text-overflow: ellipsis;
}

#companyNewsFeed .company-news-badge {
  background: var(--company-news-accent-soft);
  border-radius: 999px;
  color: var(--company-news-accent);
  display: inline-flex;
  font-size: 10px;
  font-weight: 700;
  padding: 2px 6px;
}

#companyNewsFeed .company-news-card-title {
  color: var(--company-news-title);
  display: inline-block;
  font-size: 18px;
  font-weight: 700;
  line-height: 1.35;
  margin-bottom: 6px;
  text-decoration: none;
}

#companyNewsFeed .company-news-card-title:hover,
#companyNewsFeed .company-news-card-title:focus {
  color: #a64f24;
}

#companyNewsFeed .company-news-card-text {
  color: var(--company-news-text);
  font-size: 14px;
  line-height: 1.7;
  margin: 0;
  white-space: pre-wrap;
}

#companyNewsFeed .company-news-open {
  color: var(--company-news-accent);
  display: inline;
  font-size: 13px;
  font-weight: 700;
  margin-left: 6px;
  text-decoration: none;
  white-space: nowrap;
}

#companyNewsFeed .company-news-open:hover,
#companyNewsFeed .company-news-open:focus {
  color: #a64f24;
}

#companyNewsFeed .company-news-empty {
  background: rgba(255, 255, 255, 0.72);
  border: 1px dashed var(--company-news-border);
  border-radius: 18px;
  color: var(--company-news-meta);
  padding: 32px 18px;
  text-align: center;
}

#companyNews-nav {
  margin-top: 18px;
}

@media (max-width: 768px) {
  #companyNewsFeed {
    border-radius: 20px;
    padding: 16px;
  }

  #companyNewsFeed .company-news-card {
    padding: 12px 14px 10px;
  }

  #companyNewsFeed .company-news-card-title {
    font-size: 16px;
  }

  #companyNewsFeed .company-news-author-row {
    flex-wrap: wrap;
    white-space: normal;
  }
}

${knowledgeDocModalStyles}
`

type CompanyNewsRow = {
  rawTime: string
  sourceType: string
  sourceName: string
  title: string
  summary: string
  contentPreview: string
  docId: string
  sourceUrl: string
  accessMethod: string
}

type CompanyNewsStateEvent = CustomEvent<{
  rows?: CompanyNewsRow[]
  currentPage?: number
  hasNext?: boolean
  total?: number
  status?: string
  error?: boolean
}>

function emitCompanyNewsPageChange(page: number) {
  window.dispatchEvent(new CustomEvent('licai:company-news-page-change', {
    detail: { page },
  }))
}

function emitCompanyNewsOpen(row: CompanyNewsRow) {
  window.dispatchEvent(new CustomEvent('licai:company-news-open-doc', {
    detail: row,
  }))
}

function sourceInitial(row: CompanyNewsRow): string {
  const source = String(row.sourceName || row.sourceType || '').trim()
  if (!source) {
    return '讯'
  }
  return source.slice(0, 1).toUpperCase()
}

function companyNewsPagination(currentPage: number, hasNext: boolean) {
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

const CompanyNewsPage = defineComponent({
  name: 'CompanyNewsPage',
  setup() {
    const rows = ref<CompanyNewsRow[]>([])
    const currentPage = ref(1)
    const hasNext = ref(false)
    const onState = (event: Event) => {
      const detail = (event as CompanyNewsStateEvent).detail
      if (!detail) {
        return
      }
      if (Array.isArray(detail.rows)) {
        rows.value = detail.rows
      }
      if (typeof detail.currentPage === 'number' && Number.isFinite(detail.currentPage)) {
        currentPage.value = detail.currentPage
      }
      if (typeof detail.hasNext === 'boolean') {
        hasNext.value = detail.hasNext
      }
    }

    onMounted(() => {
      window.addEventListener('licai:company-news-state', onState)
    })

    onBeforeUnmount(() => {
      window.removeEventListener('licai:company-news-state', onState)
    })

    const pagination = () => {
      if (currentPage.value === 1 && rows.value.length === 0) {
        return null
      }
      return h('nav', { id: 'companyNews-nav' }, [
        h('ul', { class: 'pagination justify-content-center' }, companyNewsPagination(currentPage.value, hasNext.value).map((item) => (
          h('li', {
            key: item.key,
            class: ['page-item', item.active ? 'active' : '', item.disabled ? 'disabled' : ''].filter(Boolean).join(' '),
          }, [
            h('a', {
              href: '#',
              class: 'page-link',
              onClick: (event: Event) => {
                event.preventDefault()
                if (item.disabled || item.active) {
                  return
                }
                emitCompanyNewsPageChange(item.page)
              },
            }, item.label),
          ])
        ))),
      ])
    }

    return () => h('div', [
      h('style', companyNewsStyles),
      h('section', { id: 'companyNewsFeed' }, [
        rows.value.length > 0
          ? h('div', { class: 'company-news-list' }, rows.value.map((row) => h('article', {
              key: `${row.docId}-${row.rawTime}-${row.title}`,
              class: 'company-news-card',
            }, [
              h('div', { class: 'company-news-card-header' }, [
                h('div', { class: 'company-news-avatar', 'aria-hidden': 'true' }, sourceInitial(row)),
                h('div', { class: 'company-news-meta-main' }, [
                  h('div', { class: 'company-news-author-row' }, [
                    h('span', { class: 'company-news-author' }, row.sourceName || row.sourceType || '资讯源'),
                    h('span', { class: 'company-news-badge' }, row.sourceType),
                    h('span', { class: 'company-news-separator', 'aria-hidden': 'true' }, '·'),
                    h('span', { class: 'company-news-time' }, row.rawTime),
                    row.sourceName
                      ? h('span', { class: 'company-news-separator', 'aria-hidden': 'true' }, '·')
                      : null,
                    row.sourceName
                      ? h('span', { class: 'company-news-source' }, row.sourceName)
                      : null,
                  ]),
                ]),
              ]),
              h('a', {
                href: row.sourceUrl || '#',
                class: 'company-news-card-title',
                onClick: (event: Event) => {
                  event.preventDefault()
                  emitCompanyNewsOpen(row)
                },
              }, row.title),
              h('p', { class: 'company-news-card-text' }, [
                row.contentPreview || row.summary || '暂无内容预览',
                h('a', {
                  href: row.sourceUrl || '#',
                  class: 'company-news-open',
                  onClick: (event: Event) => {
                    event.preventDefault()
                    emitCompanyNewsOpen(row)
                  },
                }, '查看全文'),
              ]),
            ])))
          : h('div', { class: 'company-news-empty' }, '暂无资讯'),
        pagination(),
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

const root = document.getElementById('company-news-vue-root')
if (root) {
  createApp(CompanyNewsPage).mount(root)
}
