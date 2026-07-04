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

const companyPageStyles = `
.company-page-tables {
  display: grid;
  gap: 1rem;
  margin-top: 1rem;
}

.company-table-card {
  padding: 1rem;
}

.company-table-header {
  align-items: flex-start;
  display: flex;
  flex-wrap: wrap;
  gap: .65rem;
  justify-content: space-between;
  margin-bottom: .9rem;
}

.company-table-title {
  color: #123a67;
  font-size: 1.08rem;
  font-weight: 700;
  margin: 0;
}

.company-table-copy {
  color: #66788a;
  font-size: .92rem;
  margin: .3rem 0 0;
}

.company-table-count {
  align-items: center;
  background: rgba(15, 118, 110, 0.12);
  border-radius: 999px;
  color: #0f766e;
  display: inline-flex;
  font-size: .82rem;
  font-weight: 700;
  min-height: 2rem;
  padding: 0 .8rem;
}

.company-table-scroll {
  overflow-x: auto;
}

.company-table-scroll table {
  background: #fff;
  border-radius: 1rem;
  overflow: hidden;
}

.company-table-scroll th {
  background: #eef6f5;
  border-bottom-width: 1px;
  color: #123a67;
  font-size: .86rem;
  white-space: nowrap;
}

.company-table-scroll td {
  font-size: .92rem;
  vertical-align: middle;
}

.company-table-scroll a {
  color: #0f766e;
  text-decoration: none;
}

.company-table-scroll a:hover,
.company-table-scroll a:focus {
  text-decoration: underline;
}

.company-table-mobile-list {
  display: grid;
  gap: .85rem;
}

.company-table-mobile-card {
  background: #fff;
  border: 1px solid rgba(18, 58, 103, 0.1);
  border-radius: 1rem;
  padding: .95rem;
}

.company-table-mobile-heading {
  color: #123a67;
  display: flex;
  flex-wrap: wrap;
  gap: .45rem .7rem;
  justify-content: space-between;
  margin-bottom: .8rem;
}

.company-table-mobile-code {
  color: #0f766e;
  font-size: .82rem;
  font-weight: 700;
}

.company-table-mobile-name {
  font-size: 1rem;
  font-weight: 700;
}

.company-table-mobile-grid {
  display: grid;
  gap: .65rem .85rem;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.company-table-mobile-metric {
  background: #f8fbfd;
  border-radius: .85rem;
  padding: .65rem .7rem;
}

.company-table-mobile-label {
  color: #66788a;
  font-size: .75rem;
  line-height: 1.35;
  margin-bottom: .25rem;
}

.company-table-mobile-value {
  color: #123a67;
  font-size: .9rem;
  font-weight: 700;
  line-height: 1.35;
  word-break: break-word;
}

@media (max-width: 767.98px) {
  .company-table-card {
    padding: .9rem;
  }

  .company-table-mobile-grid {
    grid-template-columns: 1fr;
  }
}
`

function companyTableTitle(table: CompanyTableState | null): string {
  if (!table) {
    return '数据表'
  }
  return table.columns[0]?.label || '数据表'
}

function companyTableCopy(table: CompanyTableState | null): string {
  switch (table?.tableId) {
    case 'performance':
      return '看当前价格相对近几个观察窗口的偏离程度。'
    case 'regress':
      return '按年度回看收益与最大回撤，适合快速看波动特征。'
    case 'market':
      return '把当前位置放到近阶段高低区间里，便于判断冷热。'
    default:
      return '支持排序，手机端自动切成卡片视图。'
  }
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
      const rows = sortedRows.value
      return h('section', { class: 'company-table-card' }, [
        h('div', { class: 'company-table-header' }, [
          h('div', [
            h('h2', { class: 'company-table-title' }, companyTableTitle(table)),
            h('p', { class: 'company-table-copy' }, companyTableCopy(table)),
          ]),
          h('div', { class: 'company-table-count' }, `${rows.length} 条记录`),
        ]),
        h('div', { class: 'company-table-mobile-list d-md-none' }, rows.map((row) => h('article', {
          key: `${table.tableId}-${row.rowKey}`,
          class: 'company-table-mobile-card',
        }, [
          h('div', { class: 'company-table-mobile-heading' }, [
            h('div', [
              h('div', { class: 'company-table-mobile-code' }, row.cells[0]?.text || row.rowKey),
              h('div', { class: 'company-table-mobile-name' }, row.cells[1]?.text || ''),
            ]),
          ]),
          h('div', { class: 'company-table-mobile-grid' }, table.columns.slice(2).map((column, index) => h('div', {
            key: `${row.rowKey}-${column.key}`,
            class: 'company-table-mobile-metric',
          }, [
            h('div', { class: 'company-table-mobile-label' }, column.label),
            h('div', { class: 'company-table-mobile-value' }, row.cells[index + 2]?.text || '-'),
          ]))),
        ]))),
        h('div', { class: 'company-table-scroll d-none d-md-block' }, [
          h('table', {
            id: table.tableId,
            class: 'table table-sm table-bordered table-hover mb-0',
          }, [
            h('thead', { class: 'table-info theadFix' }, [
              h('tr', table.columns.map((column) => h('th', {
                class: headerClass(column),
                onClick: () => updateSort(column),
                scope: 'col',
                style: column.sortable ? 'cursor: pointer;' : '',
              }, column.label))),
            ]),
            h('tbody', rows.map((row) => h('tr', { key: row.rowKey }, row.cells.map((cell) => h('td', {
              class: cell.className || '',
            }, cell.href
              ? [h('a', { href: cell.href, target: cell.target || '_self' }, cell.text)]
              : cell.text))))),
          ]),
        ]),
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
      h('style', companyPageStyles),
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
