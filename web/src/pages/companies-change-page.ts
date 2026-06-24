import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue'

type CompaniesChangeRow = {
  code: string
  industry: string
  mainNetRatio10Days: string
  mainNetRatio5Days: string
  mainNetRatioToday: string
  name: string
  price: string
  rank10Days: string
  rank5Days: string
  rankToday: string
  changeRate10Days: string
  changeRate5Days: string
  changeRateToday: string
}

type CompaniesChangeSortKey =
  | 'f2'
  | 'f3'
  | 'f184'
  | 'f109'
  | 'f165'
  | 'f160'
  | 'f175'

type SortDirection = 'asc' | 'desc'

type CompaniesChangeStateEvent = CustomEvent<{
  rows?: CompaniesChangeRow[]
  currentPage?: number
  hasNext?: boolean
  total?: number
  loading?: boolean
  sortBy?: CompaniesChangeSortKey
  sortDirection?: SortDirection
}>

function emitPageChange(page: number) {
  window.dispatchEvent(new CustomEvent('licai:companies-change-page-change', {
    detail: { page },
  }))
}

function emitSortChange(sortBy: CompaniesChangeSortKey) {
  window.dispatchEvent(new CustomEvent('licai:companies-change-sort-change', {
    detail: { sortBy },
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

function paginationItems(currentPage: number, hasNext: boolean) {
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

const CompaniesChangePage = defineComponent({
  name: 'CompaniesChangePage',
  setup() {
    const rows = ref<CompaniesChangeRow[]>([])
    const currentPage = ref(1)
    const hasNext = ref(false)
    const total = ref(0)
    const loading = ref(false)
    const sortBy = ref<CompaniesChangeSortKey>('f184')
    const sortDirection = ref<SortDirection>('desc')

    const onState = (event: Event) => {
      const detail = (event as CompaniesChangeStateEvent).detail
      rows.value = Array.isArray(detail?.rows) ? detail.rows : []
      if (typeof detail?.currentPage === 'number' && Number.isFinite(detail.currentPage)) {
        currentPage.value = detail.currentPage
      }
      hasNext.value = Boolean(detail?.hasNext)
      if (typeof detail?.total === 'number' && Number.isFinite(detail.total)) {
        total.value = detail.total
      }
      loading.value = Boolean(detail?.loading)
      if (typeof detail?.sortBy === 'string') {
        sortBy.value = detail.sortBy
      }
      if (detail?.sortDirection === 'asc' || detail?.sortDirection === 'desc') {
        sortDirection.value = detail.sortDirection
      }
    }

    onMounted(() => {
      window.addEventListener('licai:companies-change-state', onState)
    })

    onBeforeUnmount(() => {
      window.removeEventListener('licai:companies-change-state', onState)
    })

    const sortClass = (key: CompaniesChangeSortKey) => {
      const classes = ['sortable']
      if (sortBy.value === key) {
        classes.push(sortDirection.value)
      }
      return classes.join(' ')
    }

    const sortableHeader = (label: string, key: CompaniesChangeSortKey) => h('th', {
      class: sortClass(key),
      onClick: () => emitSortChange(key),
      style: 'cursor: pointer;',
    }, label)

    return () => h('div', { id: 'container', class: 'my-2' }, [
      h('div', { class: 'd-flex justify-content-between align-items-center mb-2' }, [
        h('div', { class: 'small text-muted' }, '点击表头可排序，按 50 条分页展示。'),
        h('div', { class: 'small text-muted' }, loading.value ? '加载中...' : `共 ${total.value} 条`),
      ]),
      h('div', { class: 'table-responsive' }, [
        h('table', { id: 'companiesChangeTable', class: 'table table-bordered table-hover table-sm align-middle' }, [
          h('thead', { class: 'table-success theadFix' }, [
            h('tr', [
              h('th', '股票代码'),
              h('th', '股票名称'),
              sortableHeader('最新价', 'f2'),
              h('th', '所属板块'),
              sortableHeader('主力净占比', 'f184'),
              h('th', '今日排名'),
              sortableHeader('今日涨跌', 'f3'),
              sortableHeader('主力净占比', 'f165'),
              h('th', '5日排名'),
              sortableHeader('5日涨跌', 'f109'),
              sortableHeader('主力净占比', 'f175'),
              h('th', '10日排名'),
              sortableHeader('10日涨跌', 'f160'),
            ]),
          ]),
          h('tbody', rows.value.map((row) => h('tr', { key: row.code }, [
            h('td', [h('a', { href: `company.html?code=${encodeURIComponent(row.code)}`, target: '_blank' }, row.code)]),
            h('td', row.name),
            h('td', row.price),
            h('td', row.industry),
            h('td', { class: signedClass(row.mainNetRatioToday) }, row.mainNetRatioToday),
            h('td', row.rankToday),
            h('td', { class: signedClass(row.changeRateToday) }, row.changeRateToday),
            h('td', { class: signedClass(row.mainNetRatio5Days) }, row.mainNetRatio5Days),
            h('td', row.rank5Days),
            h('td', { class: signedClass(row.changeRate5Days) }, row.changeRate5Days),
            h('td', { class: signedClass(row.mainNetRatio10Days) }, row.mainNetRatio10Days),
            h('td', row.rank10Days),
            h('td', { class: signedClass(row.changeRate10Days) }, row.changeRate10Days),
          ]))),
        ]),
      ]),
      h('nav', { id: 'companiesChangeTable-nav' }, [
        h('ul', { class: 'pagination justify-content-center' }, paginationItems(currentPage.value, hasNext.value).map((item) => (
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
                emitPageChange(item.page)
              },
            }, item.label),
          ])
        ))),
      ]),
    ])
  },
})

const root = document.getElementById('companies-change-vue-root')
if (root) {
  createApp(CompaniesChangePage).mount(root)
}
