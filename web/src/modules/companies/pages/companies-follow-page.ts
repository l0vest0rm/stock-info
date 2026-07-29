import { computed, createApp, defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue'

type CompaniesFollowForecastDisplay = {
  year: number
  revenue: string
  revenueGrowth: string
  profit: string
  profitGrowth: string
  pe: string
  savedAt: string
}

type CompaniesFollowTableRow = {
  code: string
  track: string
  name: string
  price: string
  changeRatio: string
  positionPct: number
  costPrice: number | null
  suggestedPositionPct: number
  actionType: 'build' | 'add' | 'hold' | 'reduce' | 'exit' | 'watch'
  action: string
  riskLevel: 'high' | 'down' | 'weak' | 'stable' | 'unavailable'
  risk: string
  riskScore: number
  riskDetail: string
  stopLoss: string
  stopTriggered: boolean
  operationAdvice: string
  high90: string
  low90: string
  high180: string
  low180: string
  marketValueYi: string
  peTtm: string
  forecasts: CompaniesFollowForecastDisplay[]
}

type CompaniesFollowSortKey =
  | 'track'
  | 'name'
  | 'price'
  | 'changeRatio'
  | 'positionPct'
  | 'costPrice'
  | 'action'
  | 'suggestedPositionPct'
  | 'stopLoss'
  | 'high90'
  | 'low90'
  | 'high180'
  | 'low180'
  | 'marketValueYi'
  | 'peTtm'
  | 'revenue0'
  | 'profit0'
  | 'pe0'
  | 'revenue1'
  | 'profit1'
  | 'pe1'
  | 'revenue2'
  | 'profit2'
  | 'pe2'

type SortDirection = 'asc' | 'desc'

type CompaniesFollowStatusEvent = CustomEvent<{
  message?: string
  danger?: boolean
}>

type CompaniesFollowYearsEvent = CustomEvent<{
  years?: number[]
}>

type CompaniesFollowRowsEvent = CustomEvent<{
  rows?: CompaniesFollowTableRow[]
}>

type CompaniesFollowPolicyEvent = CustomEvent<{
  accountRiskPct?: number
  maxStockPositionPct?: number
}>

const PE_COLUMN_STYLE = {
  backgroundColor: '#fff3cd',
}

function parseNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value !== 'string') {
    return null
  }
  const normalized = value.replace(/,/g, '').trim()
  if (!normalized || normalized === '-') {
    return null
  }
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

function signedClass(value: string): string {
  const numeric = parseNumber(value)
  if (numeric === null) {
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

function actionBadgeClass(action: CompaniesFollowTableRow['actionType']): string {
  switch (action) {
    case 'exit':
      return 'badge text-bg-danger'
    case 'reduce':
      return 'badge text-bg-warning'
    case 'build':
    case 'add':
      return 'badge text-bg-success'
    case 'hold':
      return 'badge text-bg-primary'
    default:
      return 'badge text-bg-secondary'
  }
}

function forecastSavedDateTitle(savedAt: string): string {
  if (!savedAt) {
    return '编辑保存日期：尚未保存'
  }
  const date = new Date(savedAt)
  if (!Number.isFinite(date.getTime())) {
    return '编辑保存日期：尚未保存'
  }
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `编辑保存日期：${year}-${month}-${day}`
}

function forecastValue(row: CompaniesFollowTableRow, key: CompaniesFollowSortKey): string {
  switch (key) {
    case 'revenue0':
      return row.forecasts[0]?.revenue || '-'
    case 'profit0':
      return row.forecasts[0]?.profit || '-'
    case 'pe0':
      return row.forecasts[0]?.pe || '-'
    case 'revenue1':
      return row.forecasts[1]?.revenue || '-'
    case 'profit1':
      return row.forecasts[1]?.profit || '-'
    case 'pe1':
      return row.forecasts[1]?.pe || '-'
    case 'revenue2':
      return row.forecasts[2]?.revenue || '-'
    case 'profit2':
      return row.forecasts[2]?.profit || '-'
    case 'pe2':
      return row.forecasts[2]?.pe || '-'
    default:
      return ''
  }
}

const CompaniesFollowPage = defineComponent({
  name: 'CompaniesFollowPage',
  setup() {
    const years = ref([new Date().getFullYear(), new Date().getFullYear() + 1, new Date().getFullYear() + 2])
    const statusText = ref('')
    const statusDanger = ref(false)
    const rows = ref<CompaniesFollowTableRow[]>([])
    const sortKey = ref<CompaniesFollowSortKey>('high180')
    const sortDirection = ref<SortDirection>('asc')
    const tooltipText = ref('')
    const tooltipLeft = ref(0)
    const tooltipTop = ref(0)
    const accountRiskPct = ref(0.8)
    const maxStockPositionPct = ref(10)

    const showForecastTooltip = (event: Event, text: string) => {
      const target = event.currentTarget
      if (!(target instanceof HTMLElement)) {
        return
      }
      const rect = target.getBoundingClientRect()
      tooltipText.value = text
      tooltipLeft.value = Math.max(100, Math.min(window.innerWidth - 100, rect.left + rect.width / 2))
      tooltipTop.value = rect.bottom + 6
    }

    const hideForecastTooltip = () => {
      tooltipText.value = ''
    }

    const columnValue = (row: CompaniesFollowTableRow, key: CompaniesFollowSortKey): string => {
      switch (key) {
        case 'track':
          return row.track
        case 'name':
          return row.name
        case 'price':
          return row.price
        case 'changeRatio':
          return row.changeRatio
        case 'positionPct':
          return String(row.positionPct)
        case 'costPrice':
          return row.costPrice === null ? '-' : String(row.costPrice)
        case 'action':
          return String(row.riskScore)
        case 'suggestedPositionPct':
          return String(row.suggestedPositionPct)
        case 'stopLoss':
          return row.stopTriggered ? String(Number.MAX_SAFE_INTEGER) : row.stopLoss
        case 'high90':
          return row.high90
        case 'low90':
          return row.low90
        case 'high180':
          return row.high180
        case 'low180':
          return row.low180
        case 'marketValueYi':
          return row.marketValueYi
        case 'peTtm':
          return row.peTtm
        default:
          return forecastValue(row, key)
      }
    }

    const sortedRows = computed(() => {
      return rows.value.slice().sort((left, right) => {
        const leftValue = columnValue(left, sortKey.value)
        const rightValue = columnValue(right, sortKey.value)
        const leftNumeric = parseNumber(leftValue)
        const rightNumeric = parseNumber(rightValue)
        let result = 0
        if (leftNumeric !== null && rightNumeric !== null) {
          result = leftNumeric === rightNumeric ? 0 : (leftNumeric > rightNumeric ? 1 : -1)
        } else {
          result = leftValue.localeCompare(rightValue, 'zh-Hans-CN')
        }
        if (result === 0) {
          return left.name.localeCompare(right.name, 'zh-Hans-CN')
        }
        return sortDirection.value === 'asc' ? result : -result
      })
    })

    const updateSort = (key: CompaniesFollowSortKey) => {
      if (sortKey.value === key) {
        sortDirection.value = sortDirection.value === 'asc' ? 'desc' : 'asc'
        return
      }
      sortKey.value = key
      sortDirection.value = key === 'name' ? 'asc' : 'desc'
    }

    const sortClass = (key: CompaniesFollowSortKey) => {
      const classes = ['sortable']
      if (sortKey.value === key) {
        classes.push(sortDirection.value)
      }
      return classes.join(' ')
    }

    const headerCell = (label: string, key: CompaniesFollowSortKey, id?: string, style?: Record<string, string>) => h('th', {
      id,
      class: sortClass(key),
      onClick: () => updateSort(key),
      style: {
        cursor: 'pointer',
        ...style,
      },
    }, label)

    const onStatus = (event: Event) => {
      const detail = (event as CompaniesFollowStatusEvent).detail
      statusText.value = detail?.message || ''
      statusDanger.value = Boolean(detail?.danger)
    }

    const onYears = (event: Event) => {
      const detail = (event as CompaniesFollowYearsEvent).detail
      if (Array.isArray(detail?.years) && detail.years.length === 3) {
        years.value = detail.years
      }
    }

    const onRows = (event: Event) => {
      const detail = (event as CompaniesFollowRowsEvent).detail
      rows.value = Array.isArray(detail?.rows) ? detail.rows : []
    }

    const onPolicy = (event: Event) => {
      const detail = (event as CompaniesFollowPolicyEvent).detail
      if (typeof detail?.accountRiskPct === 'number') accountRiskPct.value = detail.accountRiskPct
      if (typeof detail?.maxStockPositionPct === 'number') maxStockPositionPct.value = detail.maxStockPositionPct
    }

    const emitPolicyChange = (key: 'accountRiskPct' | 'maxStockPositionPct', event: Event) => {
      const target = event.currentTarget as HTMLInputElement
      const value = Number(target.value)
      if (!Number.isFinite(value)) return
      if (key === 'accountRiskPct') accountRiskPct.value = value
      else maxStockPositionPct.value = value
      window.dispatchEvent(new CustomEvent('licai:companies-follow-policy-change', {
        detail: {
          accountRiskPct: accountRiskPct.value,
          maxStockPositionPct: maxStockPositionPct.value,
        },
      }))
    }

    onMounted(() => {
      window.addEventListener('licai:companies-follow-status', onStatus)
      window.addEventListener('licai:companies-follow-years', onYears)
      window.addEventListener('licai:companies-follow-rows', onRows)
      window.addEventListener('licai:companies-follow-policy', onPolicy)
    })

    onBeforeUnmount(() => {
      window.removeEventListener('licai:companies-follow-status', onStatus)
      window.removeEventListener('licai:companies-follow-years', onYears)
      window.removeEventListener('licai:companies-follow-rows', onRows)
      window.removeEventListener('licai:companies-follow-policy', onPolicy)
    })

    const forecastCells = (row: CompaniesFollowTableRow) => {
      const cells: ReturnType<typeof h>[] = []
      for (const forecast of row.forecasts) {
        const savedDateTitle = forecastSavedDateTitle(forecast.savedAt)
        const revenueGrowthTitle = `营收同比增速：${forecast.revenueGrowth === '-' ? '暂无' : `${forecast.revenueGrowth}%`}`
        const profitGrowthTitle = `净利润同比增速：${forecast.profitGrowth === '-' ? '暂无' : `${forecast.profitGrowth}%`}；${savedDateTitle}`
        const tooltipEvents = (text: string) => ({
          onMouseenter: (event: MouseEvent) => showForecastTooltip(event, text),
          onMouseleave: hideForecastTooltip,
        })
        cells.push(
          h('td', {
            tabindex: 0,
            'aria-label': `${forecast.year}年营收，${revenueGrowthTitle}`,
            onFocus: (event: FocusEvent) => showForecastTooltip(event, revenueGrowthTitle),
            onBlur: hideForecastTooltip,
            ...tooltipEvents(revenueGrowthTitle),
          }, forecast.revenue),
          h('td', tooltipEvents(profitGrowthTitle), [
            h('input', {
              class: 'form-control form-control-sm text-end companies-follow-profit',
              type: 'number',
              step: '0.01',
              'data-code': row.code,
              'data-year': String(forecast.year),
              'aria-label': `${forecast.year}年净利润，${savedDateTitle}`,
              onFocus: (event: FocusEvent) => showForecastTooltip(event, profitGrowthTitle),
              onBlur: hideForecastTooltip,
              value: forecast.profit === '-' ? '' : forecast.profit,
            }),
          ]),
          h('td', { style: PE_COLUMN_STYLE }, forecast.pe),
        )
      }
      return cells
    }

    return () => h('div', { id: 'container', class: 'my-2' }, [
      h('div', { class: 'row mb-2' }, [
        h('div', { class: 'col' }),
        h('div', { class: 'col-10' }, [
          h('select', { id: 'codes', class: 'form-select', multiple: true }),
        ]),
        h('div', { class: 'col' }, [
          h('button', { id: 'companiesFollowSaveForecast', type: 'button', class: 'btn btn-sm btn-outline-primary text-nowrap' }, '保存配置'),
        ]),
      ]),
      h('div', {
        id: 'companiesFollowForecastStatus',
        class: `text-end small mb-2 ${statusDanger.value ? 'text-danger' : 'text-muted'}`,
      }, statusText.value),
      h('div', { class: 'row g-2 align-items-end mb-2' }, [
        h('div', { class: 'col-auto' }, [
          h('label', { class: 'form-label small mb-1', for: 'companiesFollowAccountRiskPct' }, '单笔风险预算%'),
          h('input', {
            id: 'companiesFollowAccountRiskPct',
            class: 'form-control form-control-sm',
            type: 'number',
            min: '0.1',
            max: '5',
            step: '0.1',
            value: accountRiskPct.value,
            onInput: (event: Event) => emitPolicyChange('accountRiskPct', event),
          }),
        ]),
        h('div', { class: 'col-auto' }, [
          h('label', { class: 'form-label small mb-1', for: 'companiesFollowMaxStockPositionPct' }, '单股最大仓位%'),
          h('input', {
            id: 'companiesFollowMaxStockPositionPct',
            class: 'form-control form-control-sm',
            type: 'number',
            min: '0.1',
            max: '100',
            step: '0.1',
            value: maxStockPositionPct.value,
            onInput: (event: Event) => emitPolicyChange('maxStockPositionPct', event),
          }),
        ]),
        h('div', { class: 'col small text-muted pb-1' }, '风险仓位 = 单笔风险预算 ÷ 止损距离，并受单股最大仓位限制。'),
      ]),
      h('div', { class: 'alert alert-light border py-2 small mb-2', role: 'note' }, [
        h('strong', '操作建议口径：'),
        '动作分为建仓、加仓、持有、减仓、清仓、观察；原因再区分趋势确认、仓位控制、止盈保护和止损破位。仅以收盘确认，实际止损线只能上移。',
      ]),
      tooltipText.value ? h('div', {
        id: 'companiesFollowValuationTooltip',
        role: 'tooltip',
        style: {
          position: 'fixed',
          left: `${tooltipLeft.value}px`,
          top: `${tooltipTop.value}px`,
          zIndex: '1080',
          transform: 'translateX(-50%)',
          padding: '0.35rem 0.55rem',
          borderRadius: '0.3rem',
          background: 'rgba(33, 37, 41, 0.96)',
          color: '#fff',
          fontSize: '0.8rem',
          lineHeight: '1.2',
          whiteSpace: 'nowrap',
          pointerEvents: 'none',
          boxShadow: '0 0.25rem 0.5rem rgba(0, 0, 0, 0.2)',
        },
      }, tooltipText.value) : null,
      h('div', { class: 'table-responsive' }, [
        h('table', {
          id: 'companiesFollowTable',
          class: 'table table-bordered table-hover',
          style: { minWidth: '2980px' },
        }, [
          h('thead', { class: 'table-success theadFix' }, [
            h('tr', [
              headerCell('赛道', 'track'),
              headerCell('股票名称', 'name'),
              headerCell('股价', 'price'),
              headerCell('涨跌幅%', 'changeRatio'),
              headerCell('当前持仓%', 'positionPct'),
              headerCell('成本价', 'costPrice'),
              headerCell('建议', 'action'),
              headerCell('建议后仓位%', 'suggestedPositionPct'),
              headerCell('今日参考止损', 'stopLoss'),
              h('th', { style: { minWidth: '220px' } }, '操作建议'),
              headerCell('比90日高%', 'high90'),
              headerCell('比90日低%', 'low90'),
              headerCell('比180日高%', 'high180'),
              headerCell('比180日低%', 'low180'),
              headerCell('总市值(亿)', 'marketValueYi'),
              headerCell('市盈率TTM', 'peTtm', undefined, PE_COLUMN_STYLE),
              headerCell(`${years.value[0]}营收(亿)`, 'revenue0', 'companiesFollowRevenueYear0'),
              headerCell(`${years.value[0]}净利润(亿)`, 'profit0', 'companiesFollowProfitYear0'),
              headerCell(`${years.value[0]}PE`, 'pe0', 'companiesFollowPEYear0', PE_COLUMN_STYLE),
              headerCell(`${years.value[1]}营收(亿)`, 'revenue1', 'companiesFollowRevenueYear1'),
              headerCell(`${years.value[1]}净利润(亿)`, 'profit1', 'companiesFollowProfitYear1'),
              headerCell(`${years.value[1]}PE`, 'pe1', 'companiesFollowPEYear1', PE_COLUMN_STYLE),
              headerCell(`${years.value[2]}营收(亿)`, 'revenue2', 'companiesFollowRevenueYear2'),
              headerCell(`${years.value[2]}净利润(亿)`, 'profit2', 'companiesFollowProfitYear2'),
              headerCell(`${years.value[2]}PE`, 'pe2', 'companiesFollowPEYear2', PE_COLUMN_STYLE),
            ]),
          ]),
          h('tbody', sortedRows.value.map((row) => h('tr', { key: row.code }, [
            h('td', [h('input', {
              class: 'form-control form-control-sm companies-follow-track',
              type: 'text',
              'data-code': row.code,
              value: row.track === '-' ? '' : row.track,
            })]),
            h('td', [h('a', { href: `company.html?code=${row.code}`, target: '_blank' }, row.name)]),
            h('td', { class: signedClass(row.price) }, row.price),
            h('td', { class: signedClass(row.changeRatio) }, row.changeRatio),
            h('td', [h('input', {
              class: 'form-control form-control-sm text-end companies-follow-position',
              type: 'number',
              min: '0',
              max: '100',
              step: '0.1',
              'data-code': row.code,
              'aria-label': `${row.name}当前持仓百分比`,
              value: row.positionPct || '',
            })]),
            h('td', [h('input', {
              class: 'form-control form-control-sm text-end companies-follow-cost',
              type: 'number',
              min: '0',
              step: '0.01',
              'data-code': row.code,
              'aria-label': `${row.name}持仓成本价`,
              value: row.costPrice || '',
            })]),
            h('td', { title: row.riskDetail, style: { whiteSpace: 'nowrap' } }, [
              h('span', { class: actionBadgeClass(row.actionType) }, row.action),
            ]),
            h('td', { class: 'fw-semibold' }, row.suggestedPositionPct.toFixed(1)),
            h('td', {
              class: row.stopTriggered ? 'text-danger fw-semibold' : '',
              title: '今日技术参考线；实际设定后只能上移',
              style: { whiteSpace: 'nowrap' },
            }, row.stopLoss),
            h('td', { class: 'small', style: { minWidth: '220px' } }, row.operationAdvice),
            h('td', { class: signedClass(row.high90) }, row.high90),
            h('td', { class: signedClass(row.low90) }, row.low90),
            h('td', { class: signedClass(row.high180) }, row.high180),
            h('td', { class: signedClass(row.low180) }, row.low180),
            h('td', row.marketValueYi),
            h('td', { style: PE_COLUMN_STYLE }, row.peTtm),
            ...forecastCells(row),
          ]))),
        ]),
      ]),
    ])
  },
})

const root = document.getElementById('companies-follow-vue-root')
if (root) {
  createApp(CompaniesFollowPage).mount(root)
}
