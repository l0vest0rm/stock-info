import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue'

type FinanceTableCell = {
  valueText: string
  growthText: string
  ratioText: string
  growthClass: string
  isEmpty: boolean
}

type FinanceTableRow = {
  chartKey: string
  label: string
  labelClass: string
  cells: FinanceTableCell[]
}

type FinanceTableHeaderGroup = {
  className: string
  colspan: number
  text: string
}

type FinanceTableCodeHeader = {
  className: string
  code: string
  name: string
}

type FinanceTableState = {
  codeHeaders: FinanceTableCodeHeader[]
  headerGroups: FinanceTableHeaderGroup[]
  ratioByPercent: boolean
  rows: FinanceTableRow[]
  tableId: string
  tableName: string
}

type CompanyFinanceStateEvent = CustomEvent<{
  balanceTable?: FinanceTableState
  cashflowTable?: FinanceTableState
  coreTable?: FinanceTableState
  incomeTable?: FinanceTableState
}>

type FinanceTabKey = 'core' | 'income' | 'balance' | 'cashflow'

function renderFinanceTable(table: FinanceTableState | null) {
  if (!table) {
    return h('div', { class: 'small text-muted text-center py-4' }, '加载中...')
  }
  return h('table', {
    id: table.tableId,
    class: 'table table-sm table-bordered table-hover text-center w-auto mx-auto',
  }, [
    h('thead', { class: 'theadFix' }, [
      h('tr', [
      h('th', {
          rowspan: '2',
          scope: 'col',
          class: 'table-warning text-end',
        }, [
          table.tableName,
          table.ratioByPercent ? '(占比%)' : '',
          h('br'),
          '增长率%',
        ]),
        ...table.headerGroups.map((group) => h('th', {
          colspan: String(group.colspan),
          scope: 'col',
          class: group.className,
        }, group.text)),
      ]),
      h('tr', { class: 'fs-6' }, table.codeHeaders.map((header) => h('th', {
        scope: 'col',
        class: header.className,
      }, header.name))),
    ]),
    h('tbody', table.rows.map((row) => h('tr', { key: `${table.tableId}-${row.chartKey}` }, [
      h('td', {
        class: ['text-end', 'align-middle', row.labelClass].filter(Boolean).join(' '),
      }, [
        h('a', {
          'data-bs-target': '#chartModal',
          'data-bs-toggle': 'modal',
          'data-key': row.chartKey,
        }, row.label),
      ]),
      ...row.cells.map((cell, index) => {
        if (cell.isEmpty) {
          return h('td', { key: `${row.chartKey}-cell-${index}`, class: 'align-middle' }, '-')
        }
        const pieces: Array<string | ReturnType<typeof h>> = [cell.valueText]
        if (cell.ratioText) {
          pieces.push(`(${cell.ratioText}%)`)
        }
        pieces.push(h('br'))
        pieces.push(h('span', { class: cell.growthClass }, `${cell.growthText}%`))
        return h('td', { key: `${row.chartKey}-cell-${index}` }, pieces)
      }),
    ]))),
  ])
}

const CompanyFinancePage = defineComponent({
  name: 'CompanyFinancePage',
  setup() {
    const activeTab = ref<FinanceTabKey>('core')
    const coreTable = ref<FinanceTableState | null>(null)
    const incomeTable = ref<FinanceTableState | null>(null)
    const balanceTable = ref<FinanceTableState | null>(null)
    const cashflowTable = ref<FinanceTableState | null>(null)

    const onState = (event: Event) => {
      const detail = (event as CompanyFinanceStateEvent).detail
      if (!detail) {
        return
      }
      if (detail.coreTable) {
        coreTable.value = detail.coreTable
      }
      if (detail.incomeTable) {
        incomeTable.value = detail.incomeTable
      }
      if (detail.balanceTable) {
        balanceTable.value = detail.balanceTable
      }
      if (detail.cashflowTable) {
        cashflowTable.value = detail.cashflowTable
      }
    }

    onMounted(() => {
      window.addEventListener('licai:company-finance-state', onState)
    })

    onBeforeUnmount(() => {
      window.removeEventListener('licai:company-finance-state', onState)
    })

    const tabButton = (key: FinanceTabKey, label: string, target: string) => h('li', {
      class: 'nav-item',
      role: 'presentation',
    }, [
      h('button', {
        type: 'button',
        class: ['nav-link', 'border', 'border-primary', 'p-1', activeTab.value === key ? 'active' : ''].filter(Boolean).join(' '),
        'aria-selected': activeTab.value === key ? 'true' : 'false',
        'data-bs-target': target,
        'data-bs-toggle': 'pill',
        onClick: () => {
          activeTab.value = key
        },
        role: 'tab',
      }, label),
    ])

    const tabPane = (key: FinanceTabKey, id: string, table: FinanceTableState | null) => h('div', {
      class: ['tab-pane', 'fade', activeTab.value === key ? 'show active' : ''].filter(Boolean).join(' '),
      id,
      role: 'tabpanel',
      tabindex: '0',
    }, [renderFinanceTable(table)])

    return () => h('div', { class: 'company-finance-page' }, [
      h('div', { class: 'row' }, [
        h('div', { class: 'col-4' }),
        h('div', { class: 'col-4' }, [
          h('ul', { class: 'nav nav-pills mb-2 nav-justified', role: 'tablist' }, [
            tabButton('core', '核心表', '#pills-coreTable'),
            tabButton('income', '利润表', '#pills-incomeTable'),
            tabButton('balance', '资产负债表', '#pills-balanceTable'),
            tabButton('cashflow', '现金流量表', '#pills-cashflowTable'),
          ]),
        ]),
        h('div', { class: 'col-4' }),
      ]),
      h('div', { class: 'tab-content' }, [
        tabPane('core', 'pills-coreTable', coreTable.value),
        tabPane('income', 'pills-incomeTable', incomeTable.value),
        tabPane('balance', 'pills-balanceTable', balanceTable.value),
        tabPane('cashflow', 'pills-cashflowTable', cashflowTable.value),
      ]),
    ])
  },
})

const root = document.getElementById('company-finance-vue-root')
if (root) {
  createApp(CompanyFinancePage).mount(root)
}

