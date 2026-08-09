import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue'
import { knowledgeDocModalStyles } from '../../knowledge/runtime/knowledge-doc-modal'

const companyReportStyles = `
${knowledgeDocModalStyles}
`

type CompanyReportRow = {
  rank: number
  publishDate: string
  title: string
  provenance: string
  reportHref: string
  reportInfoCode: string
  docId: string
  revenue2025: string
  revenueGrowth2025: string
  profit2025: string
  profitMargin2025: string
  growth2025: string
  profitEstimated2025: boolean
  pe2025: string
  revenue2026: string
  revenueGrowth2026: string
  profit2026: string
  profitMargin2026: string
  growth2026: string
  profitEstimated2026: boolean
  pe2026: string
  revenue2027: string
  revenueGrowth2027: string
  profit2027: string
  profitMargin2027: string
  growth2027: string
  profitEstimated2027: boolean
  pe2027: string
  revenue2028: string
  revenueGrowth2028: string
  profit2028: string
  profitMargin2028: string
  growth2028: string
  profitEstimated2028: boolean
  pe2028: string
  valuation: string
  orgName: string
  pages: string
}

function companyReportProvenanceLabel(value: unknown): string {
  return String(value || '').trim().toLowerCase() === 'web_search' ? '搜索发现' : '既有来源'
}

type CompanyReportStateEvent = CustomEvent<{
  rows?: CompanyReportRow[]
  currentPage?: number
  hasNext?: boolean
  status?: string
  error?: boolean
}>

function emitCompanyReportPageChange(page: number) {
  window.dispatchEvent(new CustomEvent('licai:company-report-page-change', {
    detail: { page },
  }))
}

function emitCompanyReportOpenDoc(docId: string) {
  window.dispatchEvent(new CustomEvent('licai:company-report-open-doc', {
    detail: { docId },
  }))
}

function growthTitle(label: string, growth: string): string {
  return `${label}同比增速：${growth === '-' ? '暂无' : `${growth}%`}`
}

function profitTitle(growth: string, margin: string, computed: boolean): string {
  return [
    computed ? '净利润按研报 EPS × 当前总股本推算' : '',
    growthTitle('净利润', growth),
    margin,
  ].filter(Boolean).join('；')
}

function growthCell(value: string, growth: string) {
  return [
    h('div', value),
    h('div', { class: 'small text-muted' }, growth === '-' ? '同比暂无' : `同比 ${growth}%`),
  ]
}

function companyReportPagination(currentPage: number, hasNext: boolean) {
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

const CompanyReportPage = defineComponent({
  name: 'CompanyReportPage',
  setup() {
    const rows = ref<CompanyReportRow[]>([])
    const currentPage = ref(1)
    const hasNext = ref(false)
    const statusText = ref('加载公司研报中...')
    const statusDanger = ref(false)

    const onState = (event: Event) => {
      const detail = (event as CompanyReportStateEvent).detail
      if (!detail) {
        return
      }
      if (Array.isArray(detail.rows)) {
        rows.value = detail.rows
      }
      if (typeof detail.currentPage === 'number' && Number.isFinite(detail.currentPage)) {
        currentPage.value = detail.currentPage
      }
      if (typeof detail.status === 'string') {
        statusText.value = detail.status
      }
      if (typeof detail.error === 'boolean') {
        statusDanger.value = detail.error
      }
      hasNext.value = Boolean(detail.hasNext)
    }

    onMounted(() => {
      window.addEventListener('licai:company-report-state', onState)
    })

    onBeforeUnmount(() => {
      window.removeEventListener('licai:company-report-state', onState)
    })

    const pagination = () => {
      if (currentPage.value === 1 && rows.value.length === 0) {
        return null
      }
      return h('nav', { id: 'companyReport-nav' }, [
        h('ul', { class: 'pagination justify-content-center' }, companyReportPagination(currentPage.value, hasNext.value).map((item) => (
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
                emitCompanyReportPageChange(item.page)
              },
            }, item.label),
          ])
        ))),
      ])
    }

    return () => h('div', [
      h('style', companyReportStyles),
      h('div', {
        id: 'companyReportStatus',
        class: `small mb-2 ${statusDanger.value ? 'text-danger' : 'text-muted'}`,
      }, statusText.value),
      h('div', { class: 'table-responsive' }, [
        h('table', { id: 'companyReport', class: 'table table-sm table-bordered table-hover text-nowrap' }, [
          h('thead', { class: 'table-info' }, [
            h('tr', [
              h('th', { scope: 'col' }, '编号'),
              h('th', { scope: 'col' }, '日期'),
              h('th', { scope: 'col' }, '报告名称'),
              h('th', { scope: 'col' }, '来源'),
              h('th', { scope: 'col' }, '2025营收'),
              h('th', { scope: 'col' }, '2025净利润'),
              h('th', { scope: 'col' }, '2025PE'),
              h('th', { scope: 'col' }, '2026营收'),
              h('th', { scope: 'col' }, '2026净利润'),
              h('th', { scope: 'col' }, '2026PE'),
              h('th', { scope: 'col' }, '2027营收'),
              h('th', { scope: 'col' }, '2027净利润'),
              h('th', { scope: 'col' }, '2027PE'),
              h('th', { scope: 'col' }, '2028营收'),
              h('th', { scope: 'col' }, '2028净利润'),
              h('th', { scope: 'col' }, '2028PE'),
              h('th', { scope: 'col' }, '估值信息'),
              h('th', { scope: 'col' }, '机构'),
              h('th', { scope: 'col' }, '页数'),
            ]),
          ]),
          h('tbody', rows.value.length > 0
            ? rows.value.map((row) => h('tr', { key: `${row.publishDate}-${row.title}-${row.rank}` }, [
              h('td', row.rank),
              h('td', row.publishDate),
              h('td', row.reportInfoCode
                ? h('a', {
                  href: `#${row.reportInfoCode}`,
                  name: 'infoCode',
                  'data-code': row.reportInfoCode,
                }, row.title)
                : row.reportHref
                  ? h('a', {
                    href: row.reportHref,
                    target: '_blank',
                    rel: 'noreferrer noopener',
                  }, row.title)
                  : row.docId
                    ? h('a', {
                      href: `#knowledge:${row.docId}`,
                      onClick: (event: Event) => {
                        event.preventDefault()
                        emitCompanyReportOpenDoc(row.docId)
                      },
                    }, row.title)
                  : h('span', row.title)),
              h('td', companyReportProvenanceLabel(row.provenance)),
              h('td', { title: growthTitle('营收', row.revenueGrowth2025) }, growthCell(row.revenue2025, row.revenueGrowth2025)),
              h('td', { title: profitTitle(row.growth2025, row.profitMargin2025, row.profitEstimated2025) }, growthCell(row.profit2025, row.growth2025)),
              h('td', row.pe2025),
              h('td', { title: growthTitle('营收', row.revenueGrowth2026) }, growthCell(row.revenue2026, row.revenueGrowth2026)),
              h('td', { title: profitTitle(row.growth2026, row.profitMargin2026, row.profitEstimated2026) }, growthCell(row.profit2026, row.growth2026)),
              h('td', row.pe2026),
              h('td', { title: growthTitle('营收', row.revenueGrowth2027) }, growthCell(row.revenue2027, row.revenueGrowth2027)),
              h('td', { title: profitTitle(row.growth2027, row.profitMargin2027, row.profitEstimated2027) }, growthCell(row.profit2027, row.growth2027)),
              h('td', row.pe2027),
              h('td', { title: growthTitle('营收', row.revenueGrowth2028) }, growthCell(row.revenue2028, row.revenueGrowth2028)),
              h('td', { title: profitTitle(row.growth2028, row.profitMargin2028, row.profitEstimated2028) }, growthCell(row.profit2028, row.growth2028)),
              h('td', row.pe2028),
              h('td', row.valuation),
              h('td', row.orgName),
              h('td', row.pages),
            ]))
            : [
              h('tr', { key: 'company-report-empty' }, [
                h('td', {
                  colSpan: 19,
                  class: `text-center ${statusDanger.value ? 'text-danger' : 'text-muted'}`,
                }, statusText.value || '暂无公司研报'),
              ]),
            ]),
        ]),
      ]),
      pagination(),
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

const root = document.getElementById('company-report-vue-root')
if (root) {
  createApp(CompanyReportPage).mount(root)
}
