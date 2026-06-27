import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue'

type PortfolioActionMode = 'position' | 'transfer'

type PortfolioUiState = {
  action: PortfolioActionMode
  candidateStatus: string
  candidateStatusError: boolean
  showZeroQuantity: boolean
  generateCandidatesPending: boolean
  addPositionPending: boolean
  confirmCandidatesPending: boolean
  accountOptions: string[]
  selectedAccount: string
  selectedTransferFromAccount: string
  selectedTransferCurrency: string
  stockOptions: string[]
  stockNameInput: string
  quantityInput: string
  amountInput: string
}

type PortfolioUiStateEvent = CustomEvent<{
  uiState?: Partial<PortfolioUiState>
}>

type HeaderCell = {
  label: string
  sort?: string
}

function sortableHeader(cells: HeaderCell[]) {
  return h('thead', { class: 'table-info theadFix' }, [
    h('tr', cells.map((cell) => h('th', {
      class: `text-center${cell.sort ? ' sortable' : ''}`,
      'data-sort': cell.sort,
    }, cell.label))),
  ])
}

function dataTable(id: string, headers: HeaderCell[]) {
  return h('table', { id, class: 'table table-striped table-bordered table-hover table-sm' }, [
    sortableHeader(headers),
    h('tbody'),
  ])
}

function labeledControl(label: string, target: string, control: ReturnType<typeof h>, style: Record<string, string>) {
  return h('div', { style }, [
    h('label', { class: 'form-label', for: target }, label),
    control,
  ])
}

function defaultPortfolioUiState(): PortfolioUiState {
  return {
    action: 'position',
    candidateStatus: '',
    candidateStatusError: false,
    showZeroQuantity: false,
    generateCandidatesPending: false,
    addPositionPending: false,
    confirmCandidatesPending: false,
    accountOptions: [],
    selectedAccount: '',
    selectedTransferFromAccount: '',
    selectedTransferCurrency: 'CNY',
    stockOptions: [],
    stockNameInput: '',
    quantityInput: '',
    amountInput: '',
  }
}

const positionHeaders = [
  { label: '账户', sort: 'account' },
  { label: '赛道', sort: 'sector' },
  { label: '股票名称', sort: 'stockName' },
  { label: '币种', sort: 'currency' },
  { label: '目标持仓数量', sort: 'quantity' },
  { label: '交易金额' },
  { label: '持仓市值', sort: 'marketValue' },
  { label: '每股成本', sort: 'costPerShare' },
  { label: '当前价格', sort: 'currentPrice' },
  { label: '折合人民币市值(¥)', sort: 'rmbValue' },
  { label: '持仓占比(%)', sort: 'proportion' },
  { label: '风险敞口加权占比(%)', sort: 'exposureProportion' },
  { label: '盈亏比例(%)', sort: 'profitLossRatio' },
]

const PortfolioPage = defineComponent({
  name: 'PortfolioPage',
  setup() {
    const uiState = ref<PortfolioUiState>(defaultPortfolioUiState())

    const onUiState = (event: Event) => {
      const detail = (event as PortfolioUiStateEvent).detail
      uiState.value = {
        ...uiState.value,
        ...(detail?.uiState || {}),
      }
    }

    const updateUiState = (patch: Partial<PortfolioUiState>) => {
      uiState.value = {
        ...uiState.value,
        ...patch,
      }
    }

    onMounted(() => {
      window.addEventListener('licai:portfolio-ui-state', onUiState)
    })

    onBeforeUnmount(() => {
      window.removeEventListener('licai:portfolio-ui-state', onUiState)
    })

    return () => {
      const transferMode = uiState.value.action === 'transfer'
      const candidateStatusClass = uiState.value.candidateStatusError ? 'small text-danger' : 'small text-muted'
      return h('div', { id: 'container', class: 'm-3' }, [
      h('h2', { class: 'mt-4 text-center' }, '总资产趋势'),
      h('div', { class: 'row' }, [
        h('div', { class: 'col-3' }, [
          h('div', { id: 'dateRange', class: 'mb-2' }),
        ]),
        h('div', { class: 'col-9' }, [
          h('select', { id: 'codes', class: 'form-select', multiple: true }),
        ]),
      ]),
      h('div', { id: 'kline', style: 'min-height: 600px; min-width: 300px;' }),

      h('h2', { class: 'mt-4 text-center' }, '股票持仓'),
      dataTable('stockPositionTable', [
        { label: '赛道', sort: 'sector' },
        { label: '股票名称', sort: 'stockName' },
        { label: '币种', sort: 'currency' },
        { label: '持仓数量', sort: 'quantity' },
        { label: '持仓市值', sort: 'marketValue' },
        { label: '每股成本', sort: 'costPerShare' },
        { label: '当前价格', sort: 'currentPrice' },
        { label: '折合人民币市值(¥)', sort: 'rmbValue' },
        { label: '持仓占比(%)', sort: 'proportion' },
        { label: '风险敞口加权占比(%)', sort: 'exposureProportion' },
        { label: '盈亏比例(%)', sort: 'profitLossRatio' },
      ]),

      h('h2', { class: 'mt-4 text-center' }, '赛道统计'),
      dataTable('sectorTable', [
        { label: '赛道', sort: 'sector' },
        { label: '持仓市值(人民币)', sort: 'marketValue' },
        { label: '持仓占比(%)', sort: 'proportion' },
      ]),

      h('h2', { class: 'mt-4 text-center' }, '账户总资产'),
      dataTable('accountTotalTable', [
        { label: '账户', sort: 'account' },
        { label: '币种', sort: 'currency' },
        { label: '现金', sort: 'cash' },
        { label: '持仓', sort: 'holdings' },
        { label: '原币总资产', sort: 'originalTotalAsset' },
        { label: '总资产(¥)', sort: 'totalAsset' },
        { label: '占比(%)', sort: 'proportion' },
      ]),

      h('h2', { class: 'mt-4 text-center' }, '持仓明细'),
      h('div', { class: 'mb-3 d-flex flex-wrap align-items-end gap-2' }, [
        h('div', { class: 'form-check' }, [
          h('input', {
            id: 'showZeroQuantity',
            name: 'showZeroQuantity',
            class: 'form-check-input',
            type: 'checkbox',
            checked: uiState.value.showZeroQuantity,
            onChange: (event: Event) => updateUiState({ showZeroQuantity: (event.target as HTMLInputElement).checked }),
          }),
          h('label', { class: 'form-check-label', for: 'showZeroQuantity' }, '显示持仓数量为0的股票'),
        ]),
        h('button', {
          id: 'portfolioGenerateCandidates',
          type: 'button',
          class: 'btn btn-primary btn-sm',
          disabled: uiState.value.generateCandidatesPending,
        }, uiState.value.generateCandidatesPending ? '生成中...' : '生成候选交易'),
        h('span', { id: 'portfolioCandidateStatus', class: candidateStatusClass }, uiState.value.candidateStatus),
      ]),
      h('div', { class: 'mb-3 d-flex flex-nowrap align-items-end gap-2 overflow-auto' }, [
        labeledControl('操作类型', 'portfolioAddAction', h('select', {
          id: 'portfolioAddAction',
          class: 'form-select form-select-sm',
          value: uiState.value.action,
          onChange: (event: Event) => updateUiState({ action: ((event.target as HTMLSelectElement).value === 'transfer' ? 'transfer' : 'position') }),
        }, [
          h('option', { value: 'position' }, '新增持仓'),
          h('option', { value: 'transfer' }, '账户转账'),
        ]), { minWidth: '120px' }),
        h('div', { style: { minWidth: '140px' } }, [
          h('label', { id: 'portfolioNewAccountLabel', class: 'form-label', for: 'portfolioNewAccount' }, transferMode ? '转入账户' : '账户'),
          h('select', {
            id: 'portfolioNewAccount',
            class: 'form-select form-select-sm',
            value: uiState.value.selectedAccount,
            onChange: (event: Event) => updateUiState({ selectedAccount: (event.target as HTMLSelectElement).value }),
          }, uiState.value.accountOptions.map((account) => h('option', { value: account }, account))),
        ]),
        h('div', { id: 'portfolioStockInputGroup', class: transferMode ? 'd-none' : '', style: { minWidth: '180px' } }, [
          h('label', { class: 'form-label', for: 'portfolioNewStockName' }, '新增股票'),
          h('input', {
            id: 'portfolioNewStockName',
            class: 'form-control form-control-sm',
            list: 'portfolioStockOptions',
            value: uiState.value.stockNameInput,
            onInput: (event: Event) => updateUiState({ stockNameInput: (event.target as HTMLInputElement).value }),
          }),
          h('datalist', { id: 'portfolioStockOptions' }, uiState.value.stockOptions.map((name) => h('option', { value: name }))),
        ]),
        h('div', { id: 'portfolioTransferFromGroup', class: transferMode ? '' : 'd-none', style: { minWidth: '140px' } }, [
          h('label', { class: 'form-label', for: 'portfolioTransferFromAccount' }, '转出账户'),
          h('select', {
            id: 'portfolioTransferFromAccount',
            class: 'form-select form-select-sm',
            value: uiState.value.selectedTransferFromAccount,
            onChange: (event: Event) => updateUiState({ selectedTransferFromAccount: (event.target as HTMLSelectElement).value }),
          }, uiState.value.accountOptions.map((account) => h('option', { value: account }, account))),
        ]),
        h('div', { id: 'portfolioTransferCurrencyGroup', class: transferMode ? '' : 'd-none', style: { minWidth: '90px' } }, [
          h('label', { class: 'form-label', for: 'portfolioTransferCurrency' }, '币种'),
          h('select', {
            id: 'portfolioTransferCurrency',
            class: 'form-select form-select-sm',
            value: uiState.value.selectedTransferCurrency,
            onChange: (event: Event) => updateUiState({ selectedTransferCurrency: (event.target as HTMLSelectElement).value }),
          }, [
            h('option', { value: 'CNY' }, 'CNY'),
            h('option', { value: 'USD' }, 'USD'),
            h('option', { value: 'HKD' }, 'HKD'),
            h('option', { value: 'USDT' }, 'USDT'),
          ]),
        ]),
        h('div', { style: { minWidth: '130px' } }, [
          h('label', { id: 'portfolioNewQuantityLabel', class: 'form-label', for: 'portfolioNewQuantity' }, transferMode ? '转账金额' : '目标数量'),
          h('input', {
            id: 'portfolioNewQuantity',
            class: 'form-control form-control-sm',
            type: 'number',
            step: '0.0001',
            value: uiState.value.quantityInput,
            onInput: (event: Event) => updateUiState({ quantityInput: (event.target as HTMLInputElement).value }),
          }),
        ]),
        h('div', { id: 'portfolioTradeAmountGroup', class: transferMode ? 'd-none' : '', style: { minWidth: '130px' } }, [
          h('label', { class: 'form-label', for: 'portfolioNewAmount' }, '成交金额'),
          h('input', {
            id: 'portfolioNewAmount',
            class: 'form-control form-control-sm',
            type: 'number',
            step: '0.01',
            value: uiState.value.amountInput,
            onInput: (event: Event) => updateUiState({ amountInput: (event.target as HTMLInputElement).value }),
          }),
        ]),
        h('div', { style: { minWidth: '72px' } }, [
          h('button', {
            id: 'portfolioAddPosition',
            type: 'button',
            class: 'btn btn-outline-primary btn-sm w-100 text-nowrap',
            disabled: uiState.value.addPositionPending,
          }, uiState.value.addPositionPending ? '处理中...' : '新增'),
        ]),
      ]),
      dataTable('portfolioTable', positionHeaders),

      h('h2', { class: 'mt-4 text-center' }, '候选交易记录'),
      h('div', { class: 'mb-2' }, [
        h('button', {
          id: 'portfolioConfirmCandidates',
          type: 'button',
          class: 'btn btn-success btn-sm',
          disabled: uiState.value.confirmCandidatesPending,
        }, uiState.value.confirmCandidatesPending ? '写入中...' : '确认写入交易记录'),
      ]),
      dataTable('portfolioCandidateTable', [
        { label: '日期' },
        { label: '类型' },
        { label: '账户' },
        { label: '股票/现金' },
        { label: '币种' },
        { label: '数量变化' },
        { label: '交易金额' },
        { label: '手续费' },
        { label: '现金影响' },
        { label: '备注' },
      ]),
    ])
    }
  },
})

const root = document.getElementById('portfolio-vue-root')
if (root) {
  createApp(PortfolioPage).mount(root)
}

