import { computed, createApp, defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue'

type SortDirection = 'asc' | 'desc'

type StockTableColumn = {
  key: string
  label: string
  sortable?: boolean
}

type StockTableCell = {
  className?: string
  href?: string
  target?: string
  text: string
}

type StockTableRow = {
  cells: StockTableCell[]
  rowKey: string
}

type StockTableState = {
  columns: StockTableColumn[]
  rows: StockTableRow[]
  tableId: string
}

type StockTableStateEvent = CustomEvent<{
  performanceTable?: StockTableState
}>

function parseSortableValue(value: string): number | string {
  const matched = String(value || '').replace(/,/g, '').match(/-?\d+(\.\d+)?/)
  if (!matched) {
    return String(value || '')
  }
  const numeric = Number(matched[0])
  return Number.isFinite(numeric) ? numeric : String(value || '')
}

const StockPerformanceTable = defineComponent({
  name: 'StockPerformanceTable',
  props: {
    table: {
      type: Object as () => StockTableState | null,
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

    const updateSort = (column: StockTableColumn) => {
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

    const headerClass = (column: StockTableColumn) => {
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
        class: 'table table-striped table-bordered table-hover table-sm',
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

const StockTablePage = defineComponent({
  name: 'StockTablePage',
  setup() {
    const performanceTable = ref<StockTableState | null>(null)

    const onState = (event: Event) => {
      const detail = (event as StockTableStateEvent).detail
      if (!detail) {
        return
      }
      if (detail.performanceTable) {
        performanceTable.value = detail.performanceTable
      }
    }

    onMounted(() => {
      window.addEventListener('licai:stock-table-state', onState)
    })

    onBeforeUnmount(() => {
      window.removeEventListener('licai:stock-table-state', onState)
    })

    return () => h('div', { class: 'table-container' }, [
      h(StockPerformanceTable, { table: performanceTable.value }),
    ])
  },
})

const root = document.getElementById('stock-table-vue-root')
if (root) {
  createApp(StockTablePage).mount(root)
}

