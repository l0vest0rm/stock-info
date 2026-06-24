import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue'
import filterGroups from '../config/companies-filter-options.json'

type CompaniesFilterSortKey =
  | 'NEW_PRICE'
  | 'CHANGE_RATE'
  | 'CHANGERATE_10DAYS'
  | 'CHANGERATE_TY'
  | 'TOTAL_MARKET_CAP'
  | 'ALLCORP_NUM'
  | 'PE9'
  | 'PBNEWMRQ'
  | 'NETPROFIT_YOY_RATIO'
  | 'ZXGXL'

type SortDirection = 'asc' | 'desc'

type CompaniesFilterRow = {
  rank: number
  code: string
  name: string
  followed: boolean
  price: string
  changeRate: string
  changeRate10Days: string
  changeRateThisYear: string
  totalMarketCapYi: string
  allCorpNum: string
  peTtm: string
  pbMrq: string
  netprofitYoyRatio: string
  dividendYield: string
  roe: string
  reportCount: string
  high180: string
  low180: string
}

type CompaniesFilterStateEvent = CustomEvent<{
  rows?: CompaniesFilterRow[]
  currentPage?: number
  hasNext?: boolean
  sortBy?: CompaniesFilterSortKey
  sortDirection?: SortDirection
}>

type PerfModalTableCell = {
  className?: string
  href?: string
  target?: string
  text: string
}

type PerfModalTableRow = {
  cells: PerfModalTableCell[]
  rowKey: string
}

type PerfModalTableState = {
  columns: Array<{ key: string, label: string }>
  rows: PerfModalTableRow[]
  tableId: string
}

type CompanyPageStateEvent = CustomEvent<{
  marketTable?: PerfModalTableState
}>

type CompaniesFilterPerfStateEvent = CustomEvent<{
  loading?: boolean
  code?: string
}>

type FilterGroup = {
  label: string
  options: Array<{
    value: string
    label: string
  }>
}

function filterSelect() {
  return h('select', { id: 'companiesFilter', class: 'd-none', multiple: true }, (
    (filterGroups as FilterGroup[]).map((group) => h('optgroup', { label: group.label }, (
      group.options.map((option) => h('option', { value: option.value }, option.label))
    )))
  ))
}

function tableHeader(label: string, dataSt?: string, className?: string) {
  return h('th', { class: className, 'data-st': dataSt }, label)
}

function emitSortChange(sortBy: CompaniesFilterSortKey) {
  window.dispatchEvent(new CustomEvent('licai:companies-filter-sort-change', {
    detail: { sortBy },
  }))
}

function emitPageChange(page: number) {
  window.dispatchEvent(new CustomEvent('licai:companies-filter-page-change', {
    detail: { page },
  }))
}

function emitFollowToggle(code: string, followed: boolean) {
  window.dispatchEvent(new CustomEvent('licai:companies-filter-follow-toggle', {
    detail: { code, followed },
  }))
}

function signedClass(value: string): string {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    return ''
  }
  if (numeric > 0) {
    return 'text-danger'
  }
  if (numeric < 0) {
    return 'text-success'
  }
  return ''
}

function roeClass(value: string): string {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    return ''
  }
  return numeric > 15 ? 'text-danger' : ''
}

function companiesFilterPagination(currentPage: number, hasNext: boolean) {
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

const CompaniesFilterPage = defineComponent({
  name: 'CompaniesFilterPage',
  setup() {
    const rows = ref<CompaniesFilterRow[]>([])
    const currentPage = ref(1)
    const hasNext = ref(false)
    const sortBy = ref<CompaniesFilterSortKey>('ALLCORP_NUM')
    const sortDirection = ref<SortDirection>('desc')
    const perfModalLoading = ref(false)
    const perfModalCode = ref('')
    const perfModalTable = ref<PerfModalTableState | null>(null)

    const onState = (event: Event) => {
      const detail = (event as CompaniesFilterStateEvent).detail
      rows.value = Array.isArray(detail?.rows) ? detail.rows : []
      if (typeof detail?.currentPage === 'number' && Number.isFinite(detail.currentPage)) {
        currentPage.value = detail.currentPage
      }
      hasNext.value = Boolean(detail?.hasNext)
      if (typeof detail?.sortBy === 'string') {
        sortBy.value = detail.sortBy
      }
      if (detail?.sortDirection === 'asc' || detail?.sortDirection === 'desc') {
        sortDirection.value = detail.sortDirection
      }
    }

    const onPerfState = (event: Event) => {
      const detail = (event as CompaniesFilterPerfStateEvent).detail
      if (typeof detail?.loading === 'boolean') {
        perfModalLoading.value = detail.loading
      }
      if (typeof detail?.code === 'string') {
        perfModalCode.value = detail.code
      }
      if (detail?.loading) {
        perfModalTable.value = null
      }
    }

    const onCompanyPageState = (event: Event) => {
      const detail = (event as CompanyPageStateEvent).detail
      if (!detail?.marketTable) {
        return
      }
      perfModalTable.value = detail.marketTable
      perfModalLoading.value = false
    }

    onMounted(() => {
      window.addEventListener('licai:companies-filter-state', onState)
      window.addEventListener('licai:companies-filter-perf-state', onPerfState)
      window.addEventListener('licai:company-page-state', onCompanyPageState)
    })

    onBeforeUnmount(() => {
      window.removeEventListener('licai:companies-filter-state', onState)
      window.removeEventListener('licai:companies-filter-perf-state', onPerfState)
      window.removeEventListener('licai:company-page-state', onCompanyPageState)
    })

    const sortClass = (key: CompaniesFilterSortKey) => {
      const classes = ['sortable']
      if (sortBy.value === key) {
        classes.push(sortDirection.value)
      }
      return classes.join(' ')
    }

    const sortableHeader = (label: string, key: CompaniesFilterSortKey) => h('th', {
      class: sortClass(key),
      'data-st': key,
      onClick: () => emitSortChange(key),
      style: 'cursor: pointer;',
    }, label)

    const pagination = () => {
      if (currentPage.value === 1 && rows.value.length === 0) {
        return null
      }
      return h('nav', { id: 'companiesFilterTable-nav' }, [
        h('ul', { class: 'pagination justify-content-center' }, companiesFilterPagination(currentPage.value, hasNext.value).map((item) => (
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
                emitPageChange(item.page)
              },
            }, item.label),
          ])
        ))),
      ])
    }

    const renderPerfModalBody = () => {
      if (perfModalLoading.value) {
        return h('div', { class: 'small text-muted py-3 text-center' }, `加载 ${perfModalCode.value || ''} 的市场表现...`)
      }
      if (!perfModalTable.value) {
        return h('div', { class: 'small text-muted py-3 text-center' }, '打开个股后加载市场表现')
      }
      return h('div', { class: 'table-responsive' }, [
        h('table', { id: perfModalTable.value.tableId, class: 'table table-sm table-bordered table-hover align-middle' }, [
          h('thead', { class: 'table-info theadFix' }, [
            h('tr', perfModalTable.value.columns.map((column) => h('th', { key: column.key }, column.label))),
          ]),
          h('tbody', perfModalTable.value.rows.map((row) => h('tr', { key: row.rowKey }, row.cells.map((cell, index) => h('td', {
            key: `${row.rowKey}-${index}`,
            class: cell.className || '',
          }, cell.href
            ? [h('a', { href: cell.href, target: cell.target || '_self' }, cell.text)]
            : cell.text))))),
        ]),
      ])
    }

    return () => h('div', { id: 'container', class: 'my-2' }, [
      h('div', { class: 'row mb-2' }, [
        h('div', { class: 'col' }),
        h('div', { class: 'col-5' }, [filterSelect()]),
        h('div', { class: 'col-2' }, [
          h('div', { class: 'form-check form-check-inline' }, [
            h('input', { id: 'researchReport', class: 'form-check-input', type: 'checkbox', checked: true }),
            h('label', { class: 'form-check-label', for: 'researchReport' }, '有研报'),
          ]),
          h('div', { class: 'form-check form-check-inline' }, [
            h('input', { id: 'roe', class: 'form-check-input', type: 'checkbox', checked: true }),
            h('label', { class: 'form-check-label', for: 'roe' }, 'ROE>10'),
          ]),
        ]),
      ]),
      h('table', { id: 'companiesFilterTable', class: 'table table-bordered table-hover' }, [
        h('thead', { class: 'table-success theadFix' }, [
          h('tr', [
            h('th', '序号'),
            tableHeader('股票代码', 'SECUCODE'),
            tableHeader('股票名称', 'SECURITY_NAME_ABBR'),
            sortableHeader('股价', 'NEW_PRICE'),
            sortableHeader('涨跌幅%', 'CHANGE_RATE'),
            sortableHeader('10日涨跌幅%', 'CHANGERATE_10DAYS'),
            sortableHeader('今年涨跌幅%', 'CHANGERATE_TY'),
            sortableHeader('总市值(亿)', 'TOTAL_MARKET_CAP'),
            sortableHeader('机构持股家数', 'ALLCORP_NUM'),
            sortableHeader('市盈率TTM', 'PE9'),
            sortableHeader('市净率MRQ', 'PBNEWMRQ'),
            sortableHeader('净利增长率%', 'NETPROFIT_YOY_RATIO'),
            sortableHeader('最新股息率%', 'ZXGXL'),
            h('th', '净资产收益率%'),
            h('th', '研报数'),
            h('th', '比180日高%'),
            h('th', '比180日低%'),
          ]),
        ]),
        h('tbody', rows.value.map((row) => h('tr', { key: `${row.code}-${row.rank}-${currentPage.value}` }, [
          h('td', row.rank),
          h('td', [h('a', { href: `company.html?code=${encodeURIComponent(row.code)}`, target: '_blank' }, row.code)]),
          h('td', [
            row.name,
            h('a', {
              class: 'ps-1',
              href: '#',
              onClick: (event: Event) => {
                event.preventDefault()
                row.followed = !row.followed
                emitFollowToggle(row.code, row.followed)
              },
            }, [
              h('img', {
                name: 'star',
                'data-code': row.code,
                src: row.followed ? 'images/star.png' : 'images/star2.png',
              }),
            ]),
          ]),
          h('td', row.price),
          h('td', { class: signedClass(row.changeRate) }, row.changeRate),
          h('td', { class: signedClass(row.changeRate10Days) }, row.changeRate10Days),
          h('td', [
            h('a', {
              class: signedClass(row.changeRateThisYear),
              href: '#',
              'data-bs-toggle': 'modal',
              'data-bs-target': '#perfModal',
              'data-key': row.code,
            }, row.changeRateThisYear),
          ]),
          h('td', row.totalMarketCapYi),
          h('td', row.allCorpNum),
          h('td', row.peTtm),
          h('td', row.pbMrq),
          h('td', { class: signedClass(row.netprofitYoyRatio) }, row.netprofitYoyRatio),
          h('td', row.dividendYield),
          h('td', { class: roeClass(row.roe) }, row.roe),
          h('td', row.reportCount),
          h('td', { class: signedClass(row.high180) }, row.high180),
          h('td', { class: signedClass(row.low180) }, row.low180),
        ]))),
      ]),
      pagination(),
      h('div', { id: 'perfModal', class: 'modal fade', tabindex: '-1', 'aria-labelledby': 'exampleModalLabel', 'aria-hidden': 'true' }, [
        h('div', { class: 'modal-dialog modal-xl' }, [
            h('div', { class: 'modal-content' }, [
              h('div', { class: 'modal-header' }, [
                h('h1', { id: 'exampleModalLabel', class: 'modal-title fs-5' }, '指标图表'),
                h('button', { type: 'button', class: 'btn-close', 'data-bs-dismiss': 'modal', 'aria-label': 'Close' }),
              ]),
              h('div', { id: 'singleChart', class: 'modal-body', style: 'min-height: 200px;' }, [renderPerfModalBody()]),
            ]),
          ]),
        ]),
    ])
  },
})

const root = document.getElementById('companies-filter-vue-root')
if (root) {
  createApp(CompaniesFilterPage).mount(root)
}
