import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue'

type CompanyReportRow = {
  rank: number
  publishDate: string
  title: string
  reportHref: string
  reportInfoCode: string
  profit2025: string
  growth2025: string
  pe2025: string
  profit2026: string
  growth2026: string
  pe2026: string
  profit2027: string
  growth2027: string
  pe2027: string
  profit2028: string
  growth2028: string
  pe2028: string
  orgName: string
  pages: string
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
      h('div', {
        id: 'companyReportStatus',
        class: `small mb-2 ${statusDanger.value ? 'text-danger' : 'text-muted'}`,
      }, statusText.value),
      h('table', { id: 'companyReport', class: 'table table-sm table-bordered table-hover' }, [
        h('thead', { class: 'table-info' }, [
          h('tr', [
            h('th', { scope: 'col' }, '编号'),
            h('th', { scope: 'col' }, '日期'),
            h('th', { scope: 'col' }, '报告名称'),
            h('th', { scope: 'col' }, '2025净利润'),
            h('th', { scope: 'col' }, '2025增长率%'),
            h('th', { scope: 'col' }, '2025PE'),
            h('th', { scope: 'col' }, '2026净利润'),
            h('th', { scope: 'col' }, '2026增长率%'),
            h('th', { scope: 'col' }, '2026PE'),
            h('th', { scope: 'col' }, '2027净利润'),
            h('th', { scope: 'col' }, '2027增长率%'),
            h('th', { scope: 'col' }, '2027PE'),
            h('th', { scope: 'col' }, '2028净利润'),
            h('th', { scope: 'col' }, '2028增长率%'),
            h('th', { scope: 'col' }, '2028PE'),
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
                }, row.title)
                : h('span', row.title)),
            h('td', row.profit2025),
            h('td', row.growth2025),
            h('td', row.pe2025),
            h('td', row.profit2026),
            h('td', row.growth2026),
            h('td', row.pe2026),
            h('td', row.profit2027),
            h('td', row.growth2027),
            h('td', row.pe2027),
            h('td', row.profit2028),
            h('td', row.growth2028),
            h('td', row.pe2028),
            h('td', row.orgName),
            h('td', row.pages),
          ]))
          : [
              h('tr', { key: 'company-report-empty' }, [
                h('td', {
                  colSpan: 17,
                  class: `text-center ${statusDanger.value ? 'text-danger' : 'text-muted'}`,
                }, statusText.value || '暂无公司研报'),
              ]),
            ]),
      ]),
      pagination(),
    ])
  },
})

const root = document.getElementById('company-report-vue-root')
if (root) {
  createApp(CompanyReportPage).mount(root)
}
