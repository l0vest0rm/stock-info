import { computed, createApp, defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue'

type CompaniesFollowForecastDisplay = {
  year: number
  profit: string
  growth: string
  pe: string
}

type CompaniesFollowTableRow = {
  code: string
  name: string
  price: string
  changeRatio: string
  high90: string
  low90: string
  high180: string
  low180: string
  marketValueYi: string
  peTtm: string
  forecasts: CompaniesFollowForecastDisplay[]
}

type CompaniesFollowSortKey =
  | 'name'
  | 'price'
  | 'changeRatio'
  | 'high90'
  | 'low90'
  | 'high180'
  | 'low180'
  | 'marketValueYi'
  | 'peTtm'
  | 'profit0'
  | 'growth0'
  | 'pe0'
  | 'profit1'
  | 'growth1'
  | 'pe1'
  | 'profit2'
  | 'growth2'
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

function forecastValue(row: CompaniesFollowTableRow, key: CompaniesFollowSortKey): string {
  switch (key) {
    case 'profit0':
      return row.forecasts[0]?.profit || '-'
    case 'growth0':
      return row.forecasts[0]?.growth || '-'
    case 'pe0':
      return row.forecasts[0]?.pe || '-'
    case 'profit1':
      return row.forecasts[1]?.profit || '-'
    case 'growth1':
      return row.forecasts[1]?.growth || '-'
    case 'pe1':
      return row.forecasts[1]?.pe || '-'
    case 'profit2':
      return row.forecasts[2]?.profit || '-'
    case 'growth2':
      return row.forecasts[2]?.growth || '-'
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

    const columnValue = (row: CompaniesFollowTableRow, key: CompaniesFollowSortKey): string => {
      switch (key) {
        case 'name':
          return row.name
        case 'price':
          return row.price
        case 'changeRatio':
          return row.changeRatio
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

    const headerCell = (label: string, key: CompaniesFollowSortKey, id?: string) => h('th', {
      id,
      class: sortClass(key),
      onClick: () => updateSort(key),
      style: 'cursor: pointer;',
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

    onMounted(() => {
      window.addEventListener('licai:companies-follow-status', onStatus)
      window.addEventListener('licai:companies-follow-years', onYears)
      window.addEventListener('licai:companies-follow-rows', onRows)
    })

    onBeforeUnmount(() => {
      window.removeEventListener('licai:companies-follow-status', onStatus)
      window.removeEventListener('licai:companies-follow-years', onYears)
      window.removeEventListener('licai:companies-follow-rows', onRows)
    })

    const forecastCells = (row: CompaniesFollowTableRow) => {
      const cells: ReturnType<typeof h>[] = []
      for (const forecast of row.forecasts) {
        cells.push(
          h('td', [
            h('input', {
              class: 'form-control form-control-sm text-end companies-follow-profit',
              type: 'number',
              step: '0.01',
              'data-code': row.code,
              'data-year': String(forecast.year),
              value: forecast.profit === '-' ? '' : forecast.profit,
            }),
          ]),
          h('td', { class: signedClass(forecast.growth) }, forecast.growth),
          h('td', forecast.pe),
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
          h('button', { id: 'companiesFollowSaveForecast', type: 'button', class: 'btn btn-sm btn-outline-primary text-nowrap' }, '保存预测'),
        ]),
      ]),
      h('div', {
        id: 'companiesFollowForecastStatus',
        class: `text-end small mb-2 ${statusDanger.value ? 'text-danger' : 'text-muted'}`,
      }, statusText.value),
      h('div', { class: 'table-responsive' }, [
        h('table', { id: 'companiesFollowTable', class: 'table table-bordered table-hover' }, [
          h('thead', { class: 'table-success theadFix' }, [
            h('tr', [
              headerCell('股票名称', 'name'),
              headerCell('股价', 'price'),
              headerCell('涨跌幅%', 'changeRatio'),
              headerCell('比90日高%', 'high90'),
              headerCell('比90日低%', 'low90'),
              headerCell('比180日高%', 'high180'),
              headerCell('比180日低%', 'low180'),
              headerCell('总市值(亿)', 'marketValueYi'),
              headerCell('市盈率TTM', 'peTtm'),
              headerCell(`${years.value[0]}净利润(亿)`, 'profit0', 'companiesFollowProfitYear0'),
              headerCell(`${years.value[0]}增速%`, 'growth0', 'companiesFollowGrowthYear0'),
              headerCell(`${years.value[0]}PE`, 'pe0', 'companiesFollowPEYear0'),
              headerCell(`${years.value[1]}净利润(亿)`, 'profit1', 'companiesFollowProfitYear1'),
              headerCell(`${years.value[1]}增速%`, 'growth1', 'companiesFollowGrowthYear1'),
              headerCell(`${years.value[1]}PE`, 'pe1', 'companiesFollowPEYear1'),
              headerCell(`${years.value[2]}净利润(亿)`, 'profit2', 'companiesFollowProfitYear2'),
              headerCell(`${years.value[2]}增速%`, 'growth2', 'companiesFollowGrowthYear2'),
              headerCell(`${years.value[2]}PE`, 'pe2', 'companiesFollowPEYear2'),
            ]),
          ]),
          h('tbody', sortedRows.value.map((row) => h('tr', { key: row.code }, [
            h('td', [h('a', { href: `company.html?code=${row.code}`, target: '_blank' }, row.name)]),
            h('td', { class: signedClass(row.price) }, row.price),
            h('td', { class: signedClass(row.changeRatio) }, row.changeRatio),
            h('td', { class: signedClass(row.high90) }, row.high90),
            h('td', { class: signedClass(row.low90) }, row.low90),
            h('td', { class: signedClass(row.high180) }, row.high180),
            h('td', { class: signedClass(row.low180) }, row.low180),
            h('td', row.marketValueYi),
            h('td', row.peTtm),
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

