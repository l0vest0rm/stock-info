import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue'

type SectorFlowRow = {
  boardCode: string
  boardName: string
  changeRate: string
  leadingStockCode: string
  leadingStockName: string
  latestPrice: string
  mainNetInflowWan: string
  mainNetRatio: string
  largeNetInflowWan: string
  largeNetRatio: string
  mediumNetInflowWan: string
  mediumNetRatio: string
  smallNetInflowWan: string
  smallNetRatio: string
  superNetInflowWan: string
  superNetRatio: string
}

type SectorFlowSortKey =
  | 'f2'
  | 'f3'
  | 'f62'
  | 'f184'
  | 'f66'
  | 'f69'
  | 'f72'
  | 'f75'
  | 'f78'
  | 'f81'
  | 'f84'
  | 'f87'

type SortDirection = 'asc' | 'desc'

type SectorFlowStateEvent = CustomEvent<{
  rows?: SectorFlowRow[]
  currentPage?: number
  hasNext?: boolean
  total?: number
  loading?: boolean
  sortBy?: SectorFlowSortKey
  sortDirection?: SortDirection
}>

function emitPageChange(page: number) {
  window.dispatchEvent(new CustomEvent('licai:sector-flow-page-change', {
    detail: { page },
  }))
}

function emitSortChange(sortBy: SectorFlowSortKey) {
  window.dispatchEvent(new CustomEvent('licai:sector-flow-sort-change', {
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

const SectorFlowPage = defineComponent({
  name: 'SectorFlowPage',
  setup() {
    const rows = ref<SectorFlowRow[]>([])
    const currentPage = ref(1)
    const hasNext = ref(false)
    const total = ref(0)
    const loading = ref(false)
    const sortBy = ref<SectorFlowSortKey>('f62')
    const sortDirection = ref<SortDirection>('desc')

    const onState = (event: Event) => {
      const detail = (event as SectorFlowStateEvent).detail
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
      window.addEventListener('licai:sector-flow-state', onState)
    })

    onBeforeUnmount(() => {
      window.removeEventListener('licai:sector-flow-state', onState)
    })

    const sortClass = (key: SectorFlowSortKey) => {
      const classes = ['sortable']
      if (sortBy.value === key) {
        classes.push(sortDirection.value)
      }
      return classes.join(' ')
    }

    const sortableHeader = (label: string, key: SectorFlowSortKey) => h('th', {
      class: sortClass(key),
      onClick: () => emitSortChange(key),
      style: 'cursor: pointer;',
    }, label)

    return () => h('div', { id: 'container', class: 'my-2' }, [
      h('div', { class: 'd-flex justify-content-between align-items-center mb-2' }, [
        h('div', { class: 'small text-muted' }, '板块资金流，点击表头可排序，按 50 条分页展示。'),
        h('div', { class: 'small text-muted' }, loading.value ? '加载中...' : `共 ${total.value} 条`),
      ]),
      h('div', { class: 'table-responsive' }, [
        h('table', { id: 'sectorFlowTable', class: 'table table-bordered table-hover table-sm align-middle' }, [
          h('thead', { class: 'table-success theadFix' }, [
            h('tr', [
              h('th', '板块代码'),
              h('th', '板块名称'),
              sortableHeader('最新价', 'f2'),
              sortableHeader('涨跌幅%', 'f3'),
              sortableHeader('主力净流入(万)', 'f62'),
              sortableHeader('主力净占比%', 'f184'),
              sortableHeader('超大单净流入(万)', 'f66'),
              sortableHeader('超大单净占比%', 'f69'),
              sortableHeader('大单净流入(万)', 'f72'),
              sortableHeader('大单净占比%', 'f75'),
              sortableHeader('中单净流入(万)', 'f78'),
              sortableHeader('中单净占比%', 'f81'),
              sortableHeader('小单净流入(万)', 'f84'),
              sortableHeader('小单净占比%', 'f87'),
              h('th', '领涨股'),
            ]),
          ]),
          h('tbody', rows.value.map((row) => h('tr', { key: row.boardCode }, [
            h('td', row.boardCode),
            h('td', row.boardName),
            h('td', row.latestPrice),
            h('td', { class: signedClass(row.changeRate) }, row.changeRate),
            h('td', { class: signedClass(row.mainNetInflowWan) }, row.mainNetInflowWan),
            h('td', { class: signedClass(row.mainNetRatio) }, row.mainNetRatio),
            h('td', { class: signedClass(row.superNetInflowWan) }, row.superNetInflowWan),
            h('td', { class: signedClass(row.superNetRatio) }, row.superNetRatio),
            h('td', { class: signedClass(row.largeNetInflowWan) }, row.largeNetInflowWan),
            h('td', { class: signedClass(row.largeNetRatio) }, row.largeNetRatio),
            h('td', { class: signedClass(row.mediumNetInflowWan) }, row.mediumNetInflowWan),
            h('td', { class: signedClass(row.mediumNetRatio) }, row.mediumNetRatio),
            h('td', { class: signedClass(row.smallNetInflowWan) }, row.smallNetInflowWan),
            h('td', { class: signedClass(row.smallNetRatio) }, row.smallNetRatio),
            h('td', row.leadingStockCode && row.leadingStockName
              ? `${row.leadingStockName}(${row.leadingStockCode})`
              : '--'),
          ]))),
        ]),
      ]),
      h('nav', { id: 'sectorFlowTable-nav' }, [
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

const root = document.getElementById('sector-flow-vue-root')
if (root) {
  createApp(SectorFlowPage).mount(root)
}
