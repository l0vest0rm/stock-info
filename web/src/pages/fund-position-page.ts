import { computed, createApp, defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue'

type SortDirection = 'asc' | 'desc'
type FundPositionSortKey =
  | 'rank'
  | 'code'
  | 'name'
  | 'currentPositionPct'
  | 'previousPositionPct'
  | 'positionPctDiff'
  | 'currentShares'
  | 'previousShares'
  | 'sharesDiffPct'
  | 'currentPrice'
  | 'previousPrice'
  | 'priceDiffPct'

type FundPositionCompareRow = {
  rank: number
  code: string
  name: string
  currentPositionPct: string
  previousPositionPct: string
  positionPctDiff: string
  currentShares: string
  previousShares: string
  sharesDiffPct: string
  currentPrice: string
  previousPrice: string
  priceDiffPct: string
}

type FundConstituentRow = {
  rank: number
  securityCode: string
  securityName: string
  price: string
  quantity: string
  navPct: string
}

type FundPositionStateEvent = CustomEvent<{
  currentDateLabel?: string
  previousDateLabel?: string
  sourceLabel?: string
  constituentStatus?: string
  constituentLabel?: string
  constituentRows?: FundConstituentRow[]
  rows?: FundPositionCompareRow[]
}>

const sortableColumns: Array<{ key: FundPositionSortKey, label: string }> = [
  { key: 'rank', label: '序号' },
  { key: 'code', label: '成分股代码' },
  { key: 'name', label: '股票简称' },
  { key: 'currentPositionPct', label: '净值占比(%)' },
  { key: 'previousPositionPct', label: '净值占比(%)' },
  { key: 'positionPctDiff', label: '净值占比变化(%)' },
  { key: 'currentShares', label: '持股数(万股)' },
  { key: 'previousShares', label: '持股数(万股)' },
  { key: 'sharesDiffPct', label: '持股数变化(%)' },
  { key: 'currentPrice', label: '股价' },
  { key: 'previousPrice', label: '股价' },
  { key: 'priceDiffPct', label: '股价变化(%)' },
]

function parseSortableValue(value: string): number | string {
  if (value === '新进') {
    return Number.POSITIVE_INFINITY
  }
  if (value === '退出') {
    return Number.NEGATIVE_INFINITY
  }
  const matched = String(value || '').replace(/,/g, '').match(/-?\d+(\.\d+)?/)
  if (!matched) {
    return String(value || '')
  }
  const numeric = Number(matched[0])
  return Number.isFinite(numeric) ? numeric : String(value || '')
}

function compareFundPositionRows(
  left: FundPositionCompareRow,
  right: FundPositionCompareRow,
  key: FundPositionSortKey,
  direction: SortDirection,
): number {
  const leftValue = key === 'rank' ? left.rank : parseSortableValue(left[key])
  const rightValue = key === 'rank' ? right.rank : parseSortableValue(right[key])
  let result = 0
  if (typeof leftValue === 'number' && typeof rightValue === 'number') {
    result = leftValue - rightValue
  } else {
    result = String(leftValue).localeCompare(String(rightValue))
  }
  if (result === 0) {
    result = left.rank - right.rank
  }
  return direction === 'asc' ? result : -result
}

function deltaClass(value: string) {
  if (value === '新进') {
    return 'text-danger'
  }
  if (value === '退出') {
    return 'text-success'
  }
  const numeric = Number(String(value || '').replace(/,/g, ''))
  if (!Number.isFinite(numeric) || numeric === 0) {
    return ''
  }
  return numeric > 0 ? 'text-danger' : 'text-success'
}

const FundPositionPage = defineComponent({
  name: 'FundPositionPage',
  setup() {
    const currentDateLabel = ref('')
    const previousDateLabel = ref('')
    const sourceLabel = ref('')
    const constituentStatus = ref('加载ETF成分股...')
    const constituentLabel = ref('')
    const constituentRows = ref<FundConstituentRow[]>([])
    const rows = ref<FundPositionCompareRow[]>([])
    const sortKey = ref<FundPositionSortKey>('currentPositionPct')
    const sortDirection = ref<SortDirection>('desc')

    const sortedRows = computed(() => rows.value.slice().sort((left, right) => {
      return compareFundPositionRows(left, right, sortKey.value, sortDirection.value)
    }))

    const sortedConstituentRows = computed(() => constituentRows.value.slice().sort((left, right) => {
      const leftValue = parseSortableValue(left.navPct)
      const rightValue = parseSortableValue(right.navPct)
      if (typeof leftValue === 'number' && typeof rightValue === 'number') {
        const result = rightValue - leftValue
        if (result !== 0) {
          return result
        }
      } else {
        const result = String(rightValue).localeCompare(String(leftValue))
        if (result !== 0) {
          return result
        }
      }
      return left.rank - right.rank
    }))

    const onState = (event: Event) => {
      const detail = (event as FundPositionStateEvent).detail
      if (!detail) {
        return
      }
      if (typeof detail.currentDateLabel === 'string') {
        currentDateLabel.value = detail.currentDateLabel
      }
      if (typeof detail.previousDateLabel === 'string') {
        previousDateLabel.value = detail.previousDateLabel
      }
      if (typeof detail.sourceLabel === 'string') {
        sourceLabel.value = detail.sourceLabel
      }
      if (typeof detail.constituentStatus === 'string') {
        constituentStatus.value = detail.constituentStatus
      }
      if (typeof detail.constituentLabel === 'string') {
        constituentLabel.value = detail.constituentLabel
      }
      if (Array.isArray(detail.constituentRows)) {
        constituentRows.value = detail.constituentRows
      }
      if (Array.isArray(detail.rows)) {
        rows.value = detail.rows
      }
    }

    const updateSort = (key: FundPositionSortKey) => {
      if (sortKey.value === key) {
        sortDirection.value = sortDirection.value === 'asc' ? 'desc' : 'asc'
        return
      }
      sortKey.value = key
      sortDirection.value = key === 'rank' ? 'asc' : 'desc'
    }

    const sortClass = (key: FundPositionSortKey) => {
      const classes = ['sortable']
      if (sortKey.value === key) {
        classes.push(sortDirection.value)
      }
      return classes.join(' ')
    }

    onMounted(() => {
      window.addEventListener('licai:fund-position-state', onState)
    })

    onBeforeUnmount(() => {
      window.removeEventListener('licai:fund-position-state', onState)
    })

    return () => h('div', { id: 'container', class: 'py-3' }, [
      h('div', { class: 'row mb-2' }, [
        h('div', { class: 'col' }),
        h('div', { class: 'col' }, [
          h('span', { class: 'text-center' }, [
            h('label', { for: 'reportDate1' }, '新季度报'),
            h('select', { id: 'reportDate1', name: 'reportDate' }),
          ]),
        ]),
        h('div', { class: 'col' }, [
          h('span', { class: 'text-center' }, [
            h('label', { for: 'reportDate2' }, '对比老季度报'),
            h('select', { id: 'reportDate2', name: 'reportDate' }),
          ]),
        ]),
      ]),
      h('div', { class: 'd-flex justify-content-between align-items-center mx-3' }, [
        h('h5', { class: 'mb-0' }, '基金持仓对比'),
        h('span', { class: 'small text-muted' }, rows.value.length ? `已对比 ${rows.value.length} 项持仓` : sourceLabel.value ? '暂无持仓数据' : '加载中...'),
      ]),
      sourceLabel.value
        ? h('div', { class: 'mx-3 mt-2 small text-muted' }, sourceLabel.value)
        : null,
      h('div', { class: 'd-flex justify-content-between align-items-center mx-3 mt-4' }, [
        h('h5', { class: 'mb-0' }, 'ETF成分股信息'),
        h('span', { class: 'small text-muted' }, constituentStatus.value),
      ]),
      constituentLabel.value
        ? h('div', { class: 'mx-3 mt-2 small text-muted' }, constituentLabel.value)
        : null,
      h('table', { class: 'table table-bordered table-hover px-3 text-end' }, [
        h('thead', { class: 'table-info' }, [
          h('tr', [
            h('th', '证券代码'),
            h('th', '证券简称'),
            h('th', '股价'),
            h('th', '股票数量'),
            h('th', '净值占比(%)'),
          ]),
        ]),
        h('tbody', sortedConstituentRows.value.length
          ? sortedConstituentRows.value.map((row) => h('tr', [
            h('td', row.securityCode),
            h('td', row.securityName),
            h('td', row.price),
            h('td', row.quantity),
            h('td', row.navPct),
          ]))
          : [
            h('tr', [
              h('td', { colspan: 5, class: 'text-center text-muted' }, constituentStatus.value || '暂无ETF成分股数据'),
            ]),
          ]),
      ]),
      h('table', { id: 'positionTable', class: 'table table-bordered table-hover px-3 text-end' }, [
        h('thead', { class: 'table-info' }, [
          h('tr', [
            h('th', { class: sortClass('rank'), style: 'cursor: pointer;', onClick: () => updateSort('rank') }, sortableColumns[0].label),
            h('th', { class: sortClass('code'), style: 'cursor: pointer;', onClick: () => updateSort('code') }, sortableColumns[1].label),
            h('th', { class: sortClass('name'), style: 'cursor: pointer;', onClick: () => updateSort('name') }, sortableColumns[2].label),
            h('th', { class: sortClass('currentPositionPct'), style: 'cursor: pointer;', onClick: () => updateSort('currentPositionPct') }, `${currentDateLabel.value || '新季度'}净值占比(%)`),
            h('th', { class: sortClass('previousPositionPct'), style: 'cursor: pointer;', onClick: () => updateSort('previousPositionPct') }, `${previousDateLabel.value || '老季度'}净值占比(%)`),
            h('th', { class: sortClass('positionPctDiff'), style: 'cursor: pointer;', onClick: () => updateSort('positionPctDiff') }, '净值占比变化(%)'),
            h('th', { class: sortClass('currentShares'), style: 'cursor: pointer;', onClick: () => updateSort('currentShares') }, `${currentDateLabel.value || '新季度'}持股数(万股)`),
            h('th', { class: sortClass('previousShares'), style: 'cursor: pointer;', onClick: () => updateSort('previousShares') }, `${previousDateLabel.value || '老季度'}持股数(万股)`),
            h('th', { class: sortClass('sharesDiffPct'), style: 'cursor: pointer;', onClick: () => updateSort('sharesDiffPct') }, '持股数变化(%)'),
            h('th', { class: sortClass('currentPrice'), style: 'cursor: pointer;', onClick: () => updateSort('currentPrice') }, `${currentDateLabel.value || '新季度'}股价`),
            h('th', { class: sortClass('previousPrice'), style: 'cursor: pointer;', onClick: () => updateSort('previousPrice') }, `${previousDateLabel.value || '老季度'}股价`),
            h('th', { class: sortClass('priceDiffPct'), style: 'cursor: pointer;', onClick: () => updateSort('priceDiffPct') }, '股价变化(%)'),
          ]),
        ]),
        h('tbody', sortedRows.value.map((row) => h('tr', [
          h('td', row.rank),
          h('td', row.code),
          h('td', row.name),
          h('td', { class: deltaClass(row.currentPositionPct) }, row.currentPositionPct),
          h('td', { class: deltaClass(row.previousPositionPct) }, row.previousPositionPct),
          h('td', { class: deltaClass(row.positionPctDiff) }, row.positionPctDiff),
          h('td', { class: deltaClass(row.currentShares) }, row.currentShares),
          h('td', { class: deltaClass(row.previousShares) }, row.previousShares),
          h('td', { class: deltaClass(row.sharesDiffPct) }, row.sharesDiffPct),
          h('td', { class: deltaClass(row.currentPrice) }, row.currentPrice),
          h('td', { class: deltaClass(row.previousPrice) }, row.previousPrice),
          h('td', { class: deltaClass(row.priceDiffPct) }, row.priceDiffPct),
        ]))),
      ]),
      h('div', { class: 'row mt-3' }, [
        h('div', { class: 'col' }, [
          h('div', { id: 'positionPie', style: 'min-height: 600px; min-width: 300px;' }),
        ]),
        h('div', { class: 'col' }, [
          h('div', { id: 'positionIndustryPie', style: 'min-height: 600px; min-width: 300px;' }),
        ]),
      ]),
      h('h5', { class: 'mx-3 mt-4' }, '持仓走势'),
      h('div', { class: 'row mb-2' }, [
        h('div', { class: 'col-3' }, [
          h('div', { id: 'dateRange', class: 'mb-2' }),
        ]),
        h('div', { class: 'col-3' }, [
          h('select', { class: 'form-select form-select-sm', id: 'klinePrice' }, [
            h('option', { value: '' }, '股价前复权'),
            h('option', { value: 'normal' }, '股价不复权'),
            h('option', { value: 'after' }, '股价后复权'),
          ]),
        ]),
      ]),
      h('div', { id: 'kline', style: 'min-height: 600px; min-width: 300px;' }),
      h('h5', { class: 'mx-3' }, '基金份额变化'),
      h('table', { id: 'fundShareChangeTable', class: 'table table-bordered table-hover text-end' }, [
        h('thead', { class: 'table-info' }, [
          h('tr', [
            h('th', '日期'),
            h('th', '期间申购(亿份)'),
            h('th', '期间赎回(亿份)'),
            h('th', '期末总份额(亿份)'),
            h('th', '期末净资产(亿元)'),
            h('th', '份额变动率%'),
            h('th', '净资产变动率%'),
          ]),
        ]),
        h('tbody'),
      ]),
    ])
  },
})

const root = document.getElementById('fund-position-vue-root')
if (root) {
  createApp(FundPositionPage).mount(root)
}
