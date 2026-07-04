import { createApp, defineComponent, h, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

type CompanyOptionStatusKind = 'page' | 'compare'

type CompanyOptionStatusEvent = CustomEvent<{
  kind: CompanyOptionStatusKind
  text: string
}>

type CompanyOptionExpirationOption = {
  value: string
  text: string
}

type CompanyOptionExpirationsEvent = CustomEvent<{
  options: CompanyOptionExpirationOption[]
  selected?: string
}>

type CompanyOptionCompareControlsEvent = CustomEvent<{
  capital?: string
  prices?: string
  strategyName?: string
  strategyNamePlaceholder?: string
}>

type CompanyOptionCompareScenarioCell = {
  text: string
  className: string
}

type CompanyOptionCompareRow = {
  index: number
  name: string
  error?: string
  errorColSpan?: number
  legs: string[]
  debitPerShare: string
  breakevens: string[]
  maxLoss: string
  contracts: string
  initialCash: string
  scenarioCells: CompanyOptionCompareScenarioCell[]
}

type CompanyOptionCompareTableEvent = CustomEvent<{
  scenarioPrices?: string[]
  rows?: CompanyOptionCompareRow[]
}>

type CompanyOptionChainRow = {
  symbol: string
  rowClass: string
  type: string
  strike: string
  distance: string
  price: string
  bid: string
  ask: string
  last: string
  volume: string
  openInterest: string
}

type CompanyOptionChainRowsEvent = CustomEvent<{
  rows?: CompanyOptionChainRow[]
}>

function labeledControl(label: string, target: string, control: ReturnType<typeof h>) {
  return [
    h('label', { class: 'form-label mb-1', for: target }, label),
    control,
  ]
}

function lineNodes(lines: string[]) {
  const nodes: Array<string | ReturnType<typeof h>> = []
  for (let index = 0; index < lines.length; index++) {
    if (index > 0) {
      nodes.push(h('br'))
    }
    nodes.push(lines[index])
  }
  return nodes
}

function renderCompareTable(scenarioPrices: string[], rows: CompanyOptionCompareRow[]) {
  if (rows.length === 0) {
    return [
      h('thead', { class: 'table-info' }, [
        h('tr', [h('th', '策略对比')]),
      ]),
      h('tbody', [
        h('tr', [h('td', { class: 'text-muted' }, '通过 URL 参数载入策略，或把右侧当前组合加入对比')]),
      ]),
    ]
  }

  return [
    h('thead', { class: 'table-info' }, [
      h('tr', [
        h('th', '策略'),
        h('th', '腿'),
        h('th', { class: 'text-end' }, '净成本/股'),
        h('th', { class: 'text-end' }, '盈亏平衡'),
        h('th', { class: 'text-end' }, '最大亏损/股'),
        h('th', { class: 'text-end' }, '组数'),
        h('th', { class: 'text-end' }, '初始现金'),
        ...scenarioPrices.map((price) => h('th', { class: 'text-end' }, price)),
        h('th'),
      ]),
    ]),
    h('tbody', rows.map((row) => {
      if (row.error) {
        return h('tr', { key: row.index, class: 'table-danger' }, [
          h('td', row.name),
          h('td', { colSpan: row.errorColSpan || 6 + scenarioPrices.length }, row.error),
          h('td', [
            h('button', {
              type: 'button',
              class: 'btn btn-sm btn-outline-danger',
              'data-action': 'remove-compare-strategy',
              'data-index': String(row.index),
            }, '移除'),
          ]),
        ])
      }
      return h('tr', { key: row.index }, [
        h('td', row.name),
        h('td', { class: 'small' }, lineNodes(row.legs)),
        h('td', { class: 'text-end' }, row.debitPerShare),
        h('td', { class: 'text-end' }, lineNodes(row.breakevens)),
        h('td', { class: 'text-end' }, row.maxLoss),
        h('td', { class: 'text-end' }, row.contracts),
        h('td', { class: 'text-end' }, row.initialCash),
        ...row.scenarioCells.map((cell) => h('td', { class: `text-end ${cell.className}` }, cell.text)),
        h('td', [
          h('button', {
            type: 'button',
            class: 'btn btn-sm btn-outline-danger',
            'data-action': 'remove-compare-strategy',
            'data-index': String(row.index),
          }, '移除'),
        ]),
      ])
    })),
  ]
}

function renderChainTable(rows: CompanyOptionChainRow[]) {
  if (rows.length === 0) {
    return [
      h('thead', { class: 'table-info theadFix' }, [
        h('tr', [
          h('th', '方向'),
          h('th', { class: 'text-end' }, '行权价'),
          h('th', { class: 'text-end' }, '距离(%)'),
          h('th', { class: 'text-end' }, '中价'),
          h('th', { class: 'text-end' }, 'Bid'),
          h('th', { class: 'text-end' }, 'Ask'),
          h('th', { class: 'text-end' }, 'Last'),
          h('th', { class: 'text-end' }, 'Volume'),
          h('th', { class: 'text-end' }, 'Open Int.'),
          h('th'),
        ]),
      ]),
      h('tbody', [
        h('tr', [
          h('td', { class: 'text-muted text-center', colSpan: 10 }, '请选择到期日后加载合约'),
        ]),
      ]),
    ]
  }
  return [
    h('thead', { class: 'table-info theadFix' }, [
      h('tr', [
        h('th', '方向'),
        h('th', { class: 'text-end' }, '行权价'),
        h('th', { class: 'text-end' }, '距离(%)'),
        h('th', { class: 'text-end' }, '中价'),
        h('th', { class: 'text-end' }, 'Bid'),
        h('th', { class: 'text-end' }, 'Ask'),
        h('th', { class: 'text-end' }, 'Last'),
        h('th', { class: 'text-end' }, 'Volume'),
        h('th', { class: 'text-end' }, 'Open Int.'),
        h('th'),
      ]),
    ]),
    h('tbody', rows.map((row) => h('tr', { key: row.symbol, class: row.rowClass }, [
      h('td', row.type),
      h('td', { class: 'text-end' }, row.strike),
      h('td', { class: 'text-end' }, row.distance),
      h('td', { class: 'text-end' }, row.price),
      h('td', { class: 'text-end' }, row.bid),
      h('td', { class: 'text-end' }, row.ask),
      h('td', { class: 'text-end' }, row.last),
      h('td', { class: 'text-end' }, row.volume),
      h('td', { class: 'text-end' }, row.openInterest),
      h('td', [
        h('button', {
          type: 'button',
          class: 'btn btn-sm btn-outline-primary',
          'data-action': 'add-option-leg',
          'data-symbol': row.symbol,
        }, '加入'),
      ]),
    ]))),
  ]
}

const CompanyOptionPage = defineComponent({
  name: 'CompanyOptionPage',
  setup() {
    const statusText = ref('')
    const compareStatusText = ref('')
    const expirationOptions = ref<CompanyOptionExpirationOption[]>([
      {value: '', text: '请选择到期日'},
    ])
    const selectedExpiration = ref('')
    const optionType = ref('all')
    const compareCapital = ref('')
    const comparePrices = ref('')
    const compareStrategyName = ref('')
    const compareStrategyNamePlaceholder = ref('')
    const compareScenarioPrices = ref<string[]>([])
    const compareRows = ref<CompanyOptionCompareRow[]>([])
    const chainRows = ref<CompanyOptionChainRow[]>([])

    const onStatus = (event: Event) => {
      const detail = (event as CompanyOptionStatusEvent).detail
      if (!detail) {
        return
      }
      if (detail.kind === 'compare') {
        compareStatusText.value = detail.text
      } else {
        statusText.value = detail.text
      }
    }

    const onExpirations = (event: Event) => {
      const detail = (event as CompanyOptionExpirationsEvent).detail
      if (!detail || !Array.isArray(detail.options)) {
        return
      }
      expirationOptions.value = detail.options
      selectedExpiration.value = detail.selected || detail.options[0]?.value || ''
      nextTick(() => {
        if (selectedExpiration.value) {
          document.getElementById('optionExpirationFilter')?.dispatchEvent(new Event('change', { bubbles: true }))
        }
      })
    }

    const onCompareControls = (event: Event) => {
      const detail = (event as CompanyOptionCompareControlsEvent).detail
      if (!detail) {
        return
      }
      if (typeof detail.capital === 'string') {
        compareCapital.value = detail.capital
      }
      if (typeof detail.prices === 'string') {
        comparePrices.value = detail.prices
      }
      if (typeof detail.strategyName === 'string') {
        compareStrategyName.value = detail.strategyName
      }
      if (typeof detail.strategyNamePlaceholder === 'string') {
        compareStrategyNamePlaceholder.value = detail.strategyNamePlaceholder
      }
    }

    const onCompareTable = (event: Event) => {
      const detail = (event as CompanyOptionCompareTableEvent).detail
      compareScenarioPrices.value = Array.isArray(detail?.scenarioPrices) ? detail.scenarioPrices : []
      compareRows.value = Array.isArray(detail?.rows) ? detail.rows : []
    }

    const onChainRows = (event: Event) => {
      const detail = (event as CompanyOptionChainRowsEvent).detail
      chainRows.value = Array.isArray(detail?.rows) ? detail.rows : []
    }

    onMounted(() => {
      window.addEventListener('licai:company-option-status', onStatus)
      window.addEventListener('licai:company-option-expirations', onExpirations)
      window.addEventListener('licai:company-option-compare-controls', onCompareControls)
      window.addEventListener('licai:company-option-compare-table', onCompareTable)
      window.addEventListener('licai:company-option-chain-rows', onChainRows)
    })

    onBeforeUnmount(() => {
      window.removeEventListener('licai:company-option-status', onStatus)
      window.removeEventListener('licai:company-option-expirations', onExpirations)
      window.removeEventListener('licai:company-option-compare-controls', onCompareControls)
      window.removeEventListener('licai:company-option-compare-table', onCompareTable)
      window.removeEventListener('licai:company-option-chain-rows', onChainRows)
    })

    return () => h('div', { id: 'companyOptionPage' }, [
      h('div', { class: 'row g-2 align-items-end my-2' }, [
        h('div', { class: 'col-12 col-md-3' }, labeledControl(
          '到期日',
          'optionExpirationFilter',
          h('select', {
            id: 'optionExpirationFilter',
            class: 'form-select form-select-sm',
            value: selectedExpiration.value,
            onChange: (event: Event) => {
              selectedExpiration.value = (event.target as HTMLSelectElement).value
            },
          }, expirationOptions.value.map((option) => h('option', { value: option.value }, option.text))),
        )),
        h('div', { class: 'col-12 col-md-2' }, labeledControl(
          '方向',
          'optionTypeFilter',
          h('select', {
            id: 'optionTypeFilter',
            class: 'form-select form-select-sm',
            value: optionType.value,
            onChange: (event: Event) => {
              optionType.value = (event.target as HTMLSelectElement).value
            },
          }, [
            h('option', { value: 'all' }, 'Call + Put'),
            h('option', { value: 'call' }, 'Call'),
            h('option', { value: 'put' }, 'Put'),
          ]),
        )),
        h('div', { class: 'col-12 col-md-7' }, [
          h('div', { class: 'small text-muted' }, '合约乘数按美股标准 100 股计算'),
        ]),
      ]),
      h('div', { id: 'companyOptionStatus', class: 'small text-muted my-2' }, statusText.value),
      h('div', { class: 'row g-3' }, [
        h('div', { class: 'col-12 col-xl-8' }, [
          h('div', { class: 'table-responsive company-option-chain-wrap' }, [
            h('table', { id: 'optionChainTable', class: 'table table-sm table-bordered table-hover align-middle' }, renderChainTable(chainRows.value)),
          ]),
        ]),
        h('div', { class: 'col-12 col-xl-4' }, [
          h('div', { class: 'table-responsive' }, [
            h('table', { id: 'optionStrategyTable', class: 'table table-sm table-bordered align-middle' }, [
              h('thead', { class: 'table-info' }, [
                h('tr', [h('th', '已选组合')]),
              ]),
              h('tbody', [
                h('tr', [h('td', { class: 'text-muted' }, '从左侧期权链加入合约')]),
              ]),
            ]),
          ]),
          h('div', { id: 'optionStrategyPremium', class: 'small text-end text-muted mb-2' }),
          h('div', { id: 'optionsLineChart', style: 'min-height: 420px; min-width: 300px;' }),
        ]),
      ]),
      h('div', { id: 'companyOptionCompare', class: 'mt-3' }, [
        h('div', { class: 'row g-2 align-items-end' }, [
          h('div', { class: 'col-12 col-md-2' }, labeledControl(
            '资金量',
            'optionCompareCapital',
            h('input', {
              id: 'optionCompareCapital',
              class: 'form-control form-control-sm text-end',
              type: 'number',
              min: '1',
              step: '10000',
              value: compareCapital.value,
              onInput: (event: Event) => {
                compareCapital.value = (event.target as HTMLInputElement).value
              },
            }),
          )),
          h('div', { class: 'col-12 col-md-5' }, labeledControl(
            '情景股价',
            'optionComparePrices',
            h('input', {
              id: 'optionComparePrices',
              class: 'form-control form-control-sm',
              type: 'text',
              value: comparePrices.value,
              onInput: (event: Event) => {
                comparePrices.value = (event.target as HTMLInputElement).value
              },
            }),
          )),
          h('div', { class: 'col-12 col-md-3' }, labeledControl(
            '组合名称',
            'optionCompareStrategyName',
            h('input', {
              id: 'optionCompareStrategyName',
              class: 'form-control form-control-sm',
              type: 'text',
              value: compareStrategyName.value,
              placeholder: compareStrategyNamePlaceholder.value,
              onInput: (event: Event) => {
                compareStrategyName.value = (event.target as HTMLInputElement).value
              },
            }),
          )),
          h('div', { class: 'col-12 col-md-2 d-flex gap-2' }, [
            h('button', { id: 'optionAddCurrentStrategyBtn', type: 'button', class: 'btn btn-sm btn-outline-primary flex-fill' }, '加入对比'),
            h('button', { id: 'optionCopyCompareLinkBtn', type: 'button', class: 'btn btn-sm btn-outline-secondary flex-fill' }, '复制链接'),
          ]),
        ]),
        h('div', { id: 'optionCompareStatus', class: 'small text-muted my-2' }, compareStatusText.value),
        h('div', { class: 'table-responsive' }, [
          h('table', { id: 'optionCompareTable', class: 'table table-sm table-bordered align-middle' }, renderCompareTable(compareScenarioPrices.value, compareRows.value)),
        ]),
        h('div', { id: 'optionCompareChart', style: 'min-height: 420px; min-width: 300px;' }),
      ]),
    ])
  },
})

const root = document.getElementById('company-option-vue-root')
if (root) {
  createApp(CompanyOptionPage).mount(root)
}
