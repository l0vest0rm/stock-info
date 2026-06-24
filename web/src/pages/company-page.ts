import { computed, createApp, defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue'

type SortDirection = 'asc' | 'desc'

type CompanyTableColumn = {
  key: string
  label: string
  sortable?: boolean
}

type CompanyTableCell = {
  className?: string
  href?: string
  target?: string
  text: string
}

type CompanyTableRow = {
  cells: CompanyTableCell[]
  rowKey: string
}

type CompanyTableState = {
  columns: CompanyTableColumn[]
  rows: CompanyTableRow[]
  tableId: string
}

type CompanyPageStateEvent = CustomEvent<{
  marketTable?: CompanyTableState
  performanceTable?: CompanyTableState
  regressTable?: CompanyTableState
}>

type CompanyPageSnapshot = {
  marketTable?: CompanyTableState
  performanceTable?: CompanyTableState
  regressTable?: CompanyTableState
}

function parseSortableValue(value: string): number | string {
  const matched = String(value || '').replace(/,/g, '').match(/-?\d+(\.\d+)?/)
  if (!matched) {
    return String(value || '')
  }
  const numeric = Number(matched[0])
  return Number.isFinite(numeric) ? numeric : String(value || '')
}

const CompanyMetricTable = defineComponent({
  name: 'CompanyMetricTable',
  props: {
    table: {
      type: Object as () => CompanyTableState | null,
      required: true,
    },
  },
  setup(props) {
    const sortKey = ref('')
    const sortDirection = ref<SortDirection>('desc')

    const sortedRows = computed(() => {
      const table = props.table
      if (!table || !sortKey.value) {
        return table?.rows || []
      }
      const columnIndex = table.columns.findIndex((column) => column.key === sortKey.value)
      if (columnIndex < 0) {
        return table.rows
      }
      return table.rows.slice().sort((left, right) => {
        const leftValue = parseSortableValue(left.cells[columnIndex]?.text || '')
        const rightValue = parseSortableValue(right.cells[columnIndex]?.text || '')
        let result = 0
        if (typeof leftValue === 'number' && typeof rightValue === 'number') {
          result = leftValue - rightValue
        } else {
          result = String(leftValue).localeCompare(String(rightValue))
        }
        if (result === 0) {
          result = String(left.rowKey).localeCompare(String(right.rowKey))
        }
        return sortDirection.value === 'asc' ? result : -result
      })
    })

    const updateSort = (column: CompanyTableColumn) => {
      if (!column.sortable) {
        return
      }
      if (sortKey.value === column.key) {
        sortDirection.value = sortDirection.value === 'asc' ? 'desc' : 'asc'
        return
      }
      sortKey.value = column.key
      sortDirection.value = 'desc'
    }

    const headerClass = (column: CompanyTableColumn) => {
      const classes = []
      if (column.sortable) {
        classes.push('sortable')
      }
      if (sortKey.value === column.key) {
        classes.push(sortDirection.value)
      }
      return classes.join(' ')
    }

    return () => {
      const table = props.table
      if (!table) {
        return h('div', { class: 'small text-muted py-2' }, '加载中...')
      }
      return h('table', {
        id: table.tableId,
        class: 'table table-sm table-bordered table-hover',
      }, [
        h('thead', { class: 'table-info theadFix' }, [
          h('tr', table.columns.map((column) => h('th', {
            class: headerClass(column),
            onClick: () => updateSort(column),
            scope: 'col',
            style: column.sortable ? 'cursor: pointer;' : '',
          }, column.label))),
        ]),
        h('tbody', sortedRows.value.map((row) => h('tr', { key: row.rowKey }, row.cells.map((cell) => h('td', {
          class: cell.className || '',
        }, cell.href
          ? [h('a', { href: cell.href, target: cell.target || '_self' }, cell.text)]
          : cell.text))))),
      ])
    }
  },
})

const CompanyPage = defineComponent({
  name: 'CompanyPage',
  setup() {
    const performanceTable = ref<CompanyTableState | null>(null)
    const regressTable = ref<CompanyTableState | null>(null)
    const marketTable = ref<CompanyTableState | null>(null)

    const onState = (event: Event) => {
      const detail = (event as CompanyPageStateEvent).detail as CompanyPageSnapshot | undefined
      if (!detail) {
        return
      }
      if (detail.performanceTable) {
        performanceTable.value = detail.performanceTable
      }
      if (detail.regressTable) {
        regressTable.value = detail.regressTable
      }
      if (detail.marketTable) {
        marketTable.value = detail.marketTable
      }
    }

    onMounted(() => {
      window.addEventListener('licai:company-page-state', onState)
      const snapshot = (window as typeof window & { __licaiCompanyPageState?: CompanyPageSnapshot }).__licaiCompanyPageState
      if (snapshot) {
        onState(new CustomEvent('licai:company-page-state', { detail: snapshot }))
      }
    })

    onBeforeUnmount(() => {
      window.removeEventListener('licai:company-page-state', onState)
    })

    return () => h('div', { class: 'company-page-tables' }, [
      h(CompanyMetricTable, { table: performanceTable.value }),
      h(CompanyMetricTable, { table: regressTable.value }),
      h(CompanyMetricTable, { table: marketTable.value }),
    ])
  },
})

const root = document.getElementById('company-page-vue-root')
if (root) {
  createApp(CompanyPage).mount(root)
}
