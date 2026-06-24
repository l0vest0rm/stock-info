import { computed, createApp, defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue'

type SortDirection = 'asc' | 'desc'

type IndexPositionDateOption = {
  label: string
  value: string
}

type IndexPositionCell = {
  className?: string
  href?: string
  target?: string
  text: string
}

type IndexPositionColumn = {
  key: string
  label: string
  sortable?: boolean
}

type IndexPositionRow = {
  cells: IndexPositionCell[]
  rowKey: string
}

type IndexPositionTableState = {
  columns: IndexPositionColumn[]
  rows: IndexPositionRow[]
}

type IndexPositionStateEvent = CustomEvent<{
  dateOptions?: IndexPositionDateOption[]
  selectedDate1?: string
  selectedDate2?: string
  table?: IndexPositionTableState | null
  status?: string
}>

type IndexPositionSnapshot = {
  dateOptions?: IndexPositionDateOption[]
  selectedDate1?: string
  selectedDate2?: string
  table?: IndexPositionTableState | null
  status?: string
}

function parseSortableValue(value: string): number | string {
  const matched = String(value || '').replace(/,/g, '').match(/-?\d+(\.\d+)?/)
  if (!matched) {
    return String(value || '')
  }
  const numeric = Number(matched[0])
  return Number.isFinite(numeric) ? numeric : String(value || '')
}

const IndexPositionTable = defineComponent({
  name: 'IndexPositionTable',
  props: {
    table: {
      type: Object as () => IndexPositionTableState | null,
      required: true,
    },
  },
  setup(props) {
    const sortKey = ref('currentWeight')
    const sortDirection = ref<SortDirection>('desc')

    const sortedRows = computed(() => {
      const table = props.table
      if (!table) {
        return []
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

    const updateSort = (column: IndexPositionColumn) => {
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

    const headerClass = (column: IndexPositionColumn) => {
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
      return h('table', {
        id: 'position',
        class: 'table table-bordered table-hover',
        width: '100%',
      }, [
        h('thead', { class: 'table-danger' }, [
          h('tr', (table?.columns || []).map((column) => h('th', {
            class: headerClass(column),
            scope: 'col',
            style: column.sortable ? 'cursor: pointer;' : '',
            onClick: () => updateSort(column),
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

const IndexPositionPage = defineComponent({
  name: 'IndexPositionPage',
  setup() {
    const dateOptions = ref<IndexPositionDateOption[]>([])
    const selectedDate1 = ref('')
    const selectedDate2 = ref('')
    const table = ref<IndexPositionTableState | null>(null)
    const statusText = ref('加载中...')

    const onState = (event: Event) => {
      const detail = (event as IndexPositionStateEvent).detail as IndexPositionSnapshot | undefined
      if (!detail) {
        return
      }
      if (Array.isArray(detail.dateOptions)) {
        dateOptions.value = detail.dateOptions
      }
      if (typeof detail.selectedDate1 === 'string') {
        selectedDate1.value = detail.selectedDate1
      }
      if (typeof detail.selectedDate2 === 'string') {
        selectedDate2.value = detail.selectedDate2
      }
      if ('table' in detail) {
        table.value = detail.table || null
      }
      if (typeof detail.status === 'string') {
        statusText.value = detail.status
      }
    }

    onMounted(() => {
      window.addEventListener('licai:index-position-state', onState)
      const snapshot = (window as typeof window & { __licaiIndexPositionState?: IndexPositionSnapshot }).__licaiIndexPositionState
      if (snapshot) {
        onState(new CustomEvent('licai:index-position-state', { detail: snapshot }))
      }
    })

    onBeforeUnmount(() => {
      window.removeEventListener('licai:index-position-state', onState)
    })

    return () => h('div', { id: 'container', class: 'py-3' }, [
      h('div', { class: 'row mb-2' }, [
        h('div', { class: 'col' }),
        h('div', { class: 'col' }, [
          h('span', { class: 'text-center' }, [
            h('label', { for: 'reportDate1' }, '选择新调仓'),
            h('select', {
              id: 'reportDate1',
              value: selectedDate1.value,
              onChange: (event: Event) => {
                selectedDate1.value = (event.target as HTMLSelectElement).value
              },
            }, dateOptions.value.map((option) => h('option', {
              key: `date1-${option.value}`,
              value: option.value,
            }, option.label))),
          ]),
        ]),
        h('div', { class: 'col' }, [
          h('span', { class: 'text-center' }, [
            h('label', { for: 'reportDate2' }, '选择老调仓'),
            h('select', {
              id: 'reportDate2',
              value: selectedDate2.value,
              onChange: (event: Event) => {
                selectedDate2.value = (event.target as HTMLSelectElement).value
              },
            }, dateOptions.value.map((option) => h('option', {
              key: `date2-${option.value}`,
              value: option.value,
            }, option.label))),
          ]),
        ]),
      ]),
      statusText.value
        ? h('div', { class: 'small text-muted mb-2 text-center' }, statusText.value)
        : null,
      h(IndexPositionTable, { table: table.value }),
      h('div', { class: 'row mb-2' }, [
        h('div', { class: 'col' }, [
          h('div', {
            id: 'positionPie',
            style: 'min-height: 600px; min-width: 300px;',
          }),
        ]),
        h('div', { class: 'col' }, [
          h('div', {
            id: 'positionIndustryPie',
            style: 'min-height: 600px; min-width: 300px;',
          }),
        ]),
      ]),
    ])
  },
})

const root = document.getElementById('index-position-vue-root')
if (root) {
  createApp(IndexPositionPage).mount(root)
}
