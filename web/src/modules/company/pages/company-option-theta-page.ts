import { createApp, defineComponent, h, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

type ThetaTableRow = {
  key: string
  expiration: string
  daysToExpiry: string
  type: string
  strike: string
  distancePct: string
  mid: string
  intrinsic: string
  extrinsic: string
  dailyExtrinsic: string
  volume: string
  openInterest: string
}

type ThetaStateEvent = CustomEvent<{
  statusText?: string
  code?: string
  snapshotAt?: string
  spotPrice?: string
  observationCount?: number
  summaryText?: string
  tableRows?: ThetaTableRow[]
  expirationOptions?: Array<{ value: string; label: string }>
  strikeOptions?: Array<{ value: string; label: string }>
  selectedExpirations?: string[]
  selectedStrikes?: string[]
}>

type ThetaChartOptionEvent = CustomEvent<{
  id?: string
  option?: unknown
}>

declare const echarts: any

type MultiSelectOption = {
  value: string
  label: string
}

const OPTION_THETA_PREFS_KEY = 'company-option-theta-preferences-v1'

function labeledControl(label: string, target: string, control: ReturnType<typeof h>) {
  return [
    h('label', { class: 'form-label mb-1', for: target }, label),
    control,
  ]
}

function applyChartOption(chartId: string, option: unknown) {
  const chartDom = document.getElementById(chartId)
  if (!chartDom || typeof echarts === 'undefined') return
  echarts.dispose(chartDom)
  echarts.init(chartDom).setOption(option || { xAxis: { type: 'value' }, yAxis: { type: 'value' }, series: [] })
}

function statCard(label: string, value: string) {
  return h('div', { class: 'col-6 col-lg-4' }, [
    h('div', { class: 'border rounded p-2 h-100 bg-light' }, [
      h('div', { class: 'small text-muted' }, label),
      h('div', { class: 'fs-5 fw-semibold' }, value),
    ]),
  ])
}

function readThetaPreferences(): Record<string, { expirations?: string[]; strikes?: string[] }> {
  try {
    const raw = localStorage.getItem(OPTION_THETA_PREFS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeThetaPreferences(prefs: Record<string, { expirations?: string[]; strikes?: string[] }>) {
  localStorage.setItem(OPTION_THETA_PREFS_KEY, JSON.stringify(prefs))
}

function selectionSummary(selected: string[], options: MultiSelectOption[], emptyText: string): string {
  if (selected.length === 0) return emptyText
  if (selected.length <= 2) {
    return options.filter((option) => selected.includes(option.value)).map((option) => option.label).join(', ')
  }
  return `已选 ${selected.length} 项`
}

function renderMultiSelectDropdown(params: {
  buttonId: string
  menuShown: boolean
  summary: string
  searchValue: string
  searchId: string
  options: MultiSelectOption[]
  selectedValues: string[]
  onToggleMenu: () => void
  onSearchInput: (value: string) => void
  onToggleValue: (value: string) => void
  onSelectAll: () => void
  onClear: () => void
}) {
  const filteredOptions = params.options.filter((option) => option.label.toLowerCase().includes(params.searchValue.trim().toLowerCase()))
  return h('div', { class: 'dropdown w-100' }, [
    h('button', {
      id: params.buttonId,
      type: 'button',
      class: 'btn btn-sm btn-outline-secondary dropdown-toggle text-start w-100 d-flex justify-content-between align-items-center',
      onClick: (event: Event) => {
        event.stopPropagation()
        params.onToggleMenu()
      },
    }, [
      h('span', { class: 'text-truncate pe-2' }, params.summary),
      h('span', { class: 'badge text-bg-light' }, `${params.selectedValues.length}`),
    ]),
    h('div', {
      class: `dropdown-menu p-2 w-100${params.menuShown ? ' show' : ''}`,
      style: 'max-height: 360px; overflow: auto;',
      onClick: (event: Event) => event.stopPropagation(),
    }, [
      h('div', { class: 'd-flex gap-2 mb-2' }, [
        h('button', { type: 'button', class: 'btn btn-sm btn-outline-primary', onClick: params.onSelectAll }, '全选'),
        h('button', { type: 'button', class: 'btn btn-sm btn-outline-secondary', onClick: params.onClear }, '清空'),
      ]),
      h('input', {
        id: params.searchId,
        class: 'form-control form-control-sm mb-2',
        type: 'text',
        placeholder: '搜索',
        value: params.searchValue,
        onClick: (event: Event) => event.stopPropagation(),
        onInput: (event: Event) => params.onSearchInput((event.target as HTMLInputElement).value),
      }),
      filteredOptions.length > 0
        ? h('div', { class: 'd-flex flex-column gap-1' }, filteredOptions.map((option) => h('label', {
          class: 'form-check d-flex align-items-center gap-2 small mb-0',
        }, [
          h('input', {
            class: 'form-check-input mt-0',
            type: 'checkbox',
            checked: params.selectedValues.includes(option.value),
            onChange: () => params.onToggleValue(option.value),
          }),
          h('span', { class: 'text-wrap' }, option.label),
        ])))
        : h('div', { class: 'small text-muted' }, '没有匹配项'),
    ]),
  ])
}

function renderTable(rows: ThetaTableRow[]) {
  if (rows.length === 0) {
    return [
      h('thead', { class: 'table-info' }, [h('tr', [h('th', '当前期权链明细')])]),
      h('tbody', [h('tr', [h('td', { class: 'text-muted' }, '暂无符合筛选条件的合约')])]),
    ]
  }
  return [
    h('thead', { class: 'table-info theadFix' }, [
      h('tr', [
        h('th', '到期日'),
        h('th', { class: 'text-end' }, '剩余天数'),
        h('th', '方向'),
        h('th', { class: 'text-end' }, '行权价'),
        h('th', { class: 'text-end' }, '距当时股价'),
        h('th', { class: 'text-end' }, '中价'),
        h('th', { class: 'text-end' }, '内在价值'),
        h('th', { class: 'text-end' }, '时间价值'),
        h('th', { class: 'text-end' }, '平均每天时间价值'),
        h('th', { class: 'text-end' }, 'Volume'),
        h('th', { class: 'text-end' }, 'Open Int.'),
      ]),
    ]),
    h('tbody', rows.map((row) => h('tr', { key: row.key }, [
      h('td', row.expiration),
      h('td', { class: 'text-end' }, row.daysToExpiry),
      h('td', row.type),
      h('td', { class: 'text-end' }, row.strike),
      h('td', { class: ['text-end', row.distancePct.startsWith('-') ? 'text-danger' : 'text-success'].join(' ') }, row.distancePct),
      h('td', { class: 'text-end' }, row.mid),
      h('td', { class: 'text-end' }, row.intrinsic),
      h('td', { class: 'text-end fw-semibold' }, row.extrinsic),
      h('td', { class: 'text-end' }, row.dailyExtrinsic),
      h('td', { class: 'text-end' }, row.volume),
      h('td', { class: 'text-end' }, row.openInterest),
    ]))),
  ]
}

const CompanyOptionThetaPage = defineComponent({
  name: 'CompanyOptionThetaPage',
  setup() {
    const code = ref('MU.US')
    const statusText = ref('')
    const snapshotAt = ref('-')
    const spotPrice = ref('-')
    const observationCount = ref('0')
    const summaryText = ref('')
    const tableRows = ref<ThetaTableRow[]>([])
    const expirationOptions = ref<Array<{ value: string; label: string }>>([])
    const strikeOptions = ref<Array<{ value: string; label: string }>>([])
    const selectedExpirations = ref<string[]>([])
    const selectedStrikes = ref<string[]>([])
    const expirationMenuShown = ref(false)
    const strikeMenuShown = ref(false)
    const expirationSearch = ref('')
    const strikeSearch = ref('')
    const restoredPreferenceKey = ref('')

    const syncSelectElement = async (id: string, values: string[], fireChange = true) => {
      await nextTick()
      const select = document.getElementById(id) as HTMLSelectElement | null
      if (!select) return
      const selectedSet = new Set(values)
      Array.from(select.options).forEach((option) => {
        option.selected = selectedSet.has(option.value)
      })
      if (fireChange) {
        select.dispatchEvent(new Event('change', { bubbles: true }))
      }
    }

    const currentPreferenceKey = () => (code.value || 'DEFAULT').trim().toUpperCase()

    const persistSelections = () => {
      const key = currentPreferenceKey()
      const prefs = readThetaPreferences()
      prefs[key] = {
        expirations: selectedExpirations.value,
        strikes: selectedStrikes.value,
      }
      writeThetaPreferences(prefs)
    }

    const sanitizeSelections = (values: string[], options: MultiSelectOption[]) => {
      const valid = new Set(options.map((option) => option.value))
      return values.filter((value) => valid.has(value))
    }

    const applyStoredSelectionsIfNeeded = async () => {
      const key = currentPreferenceKey()
      if (!expirationOptions.value.length && !strikeOptions.value.length) return
      if (restoredPreferenceKey.value === key) return
      restoredPreferenceKey.value = key
      const stored = readThetaPreferences()[key] || {}
      const expirations = sanitizeSelections(stored.expirations || [], expirationOptions.value)
      const strikes = sanitizeSelections(stored.strikes || [], strikeOptions.value)
      if (expirations.length > 0 || strikes.length > 0) {
        selectedExpirations.value = expirations
        selectedStrikes.value = strikes
        await syncSelectElement('optionThetaExpirationFilter', expirations, false)
        await syncSelectElement('optionThetaStrikeFilter', strikes, false)
        const expirationSelect = document.getElementById('optionThetaExpirationFilter')
        const strikeSelect = document.getElementById('optionThetaStrikeFilter')
        expirationSelect?.dispatchEvent(new Event('change', { bubbles: true }))
        strikeSelect?.dispatchEvent(new Event('change', { bubbles: true }))
      }
    }

    const updateExpirations = async (values: string[]) => {
      selectedExpirations.value = sanitizeSelections(values, expirationOptions.value)
      persistSelections()
      await syncSelectElement('optionThetaExpirationFilter', selectedExpirations.value)
    }

    const updateStrikes = async (values: string[]) => {
      selectedStrikes.value = sanitizeSelections(values, strikeOptions.value)
      persistSelections()
      await syncSelectElement('optionThetaStrikeFilter', selectedStrikes.value)
    }

    const onState = (event: Event) => {
      const detail = (event as ThetaStateEvent).detail
      if (!detail) return
      if (typeof detail.code === 'string' && detail.code) code.value = detail.code
      if (typeof detail.statusText === 'string') statusText.value = detail.statusText
      if (typeof detail.snapshotAt === 'string') snapshotAt.value = detail.snapshotAt ? new Date(detail.snapshotAt).toLocaleString('zh-CN', { hour12: false }) : '-'
      if (typeof detail.spotPrice === 'string') spotPrice.value = detail.spotPrice
      if (detail.observationCount !== undefined) observationCount.value = String(detail.observationCount)
      if (typeof detail.summaryText === 'string') summaryText.value = detail.summaryText
      if (Array.isArray(detail.tableRows)) tableRows.value = detail.tableRows
      if (Array.isArray(detail.expirationOptions)) expirationOptions.value = detail.expirationOptions
      if (Array.isArray(detail.strikeOptions)) strikeOptions.value = detail.strikeOptions
      if (Array.isArray(detail.selectedExpirations)) selectedExpirations.value = sanitizeSelections(detail.selectedExpirations, expirationOptions.value)
      if (Array.isArray(detail.selectedStrikes)) selectedStrikes.value = sanitizeSelections(detail.selectedStrikes, strikeOptions.value)
      void applyStoredSelectionsIfNeeded()
    }

    const onChartOption = (event: Event) => {
      const detail = (event as ThetaChartOptionEvent).detail
      if (typeof detail?.id !== 'string') return
      applyChartOption(detail.id, detail.option)
    }

    const closeMenus = () => {
      expirationMenuShown.value = false
      strikeMenuShown.value = false
    }

    onMounted(() => {
      window.addEventListener('licai:company-option-theta-state', onState)
      window.addEventListener('licai:company-option-theta-chart-option', onChartOption)
      document.addEventListener('click', closeMenus)
    })

    onBeforeUnmount(() => {
      window.removeEventListener('licai:company-option-theta-state', onState)
      window.removeEventListener('licai:company-option-theta-chart-option', onChartOption)
      document.removeEventListener('click', closeMenus)
    })

    return () => h('div', { id: 'companyOptionThetaPage' }, [
      h('div', { class: 'row g-2 align-items-end my-2' }, [
        h('div', { class: 'col-12 col-md-4' }, labeledControl(
          '标的',
          'optionThetaCodeInput',
          h('input', {
            id: 'optionThetaCodeInput',
            class: 'form-control form-control-sm',
            type: 'text',
            value: code.value,
            onInput: (event: Event) => {
              code.value = (event.target as HTMLInputElement).value.toUpperCase()
            },
          }),
        )),
        h('div', { class: 'col-12 col-md-4 d-flex gap-2' }, [
          h('button', { id: 'optionThetaCollectBtn', type: 'button', class: 'btn btn-sm btn-outline-primary flex-fill' }, '刷新期权数据'),
          h('button', { id: 'optionThetaReloadBtn', type: 'button', class: 'btn btn-sm btn-outline-secondary flex-fill' }, '按当前筛选重算'),
        ]),
      ]),
      h('div', { class: 'row g-2 align-items-end my-2' }, [
        h('div', { class: 'col-6 col-md-2' }, labeledControl(
          '方向',
          'optionThetaTypeFilter',
          h('select', { id: 'optionThetaTypeFilter', class: 'form-select form-select-sm' }, [
            h('option', { value: 'all' }, 'Call + Put'),
            h('option', { value: 'call' }, 'Call'),
            h('option', { value: 'put' }, 'Put'),
          ]),
        )),
        h('div', { class: 'col-6 col-md-2' }, labeledControl(
          '到期区间',
          'optionThetaExpiryWindow',
          h('select', { id: 'optionThetaExpiryWindow', class: 'form-select form-select-sm' }, [
            h('option', { value: 'all' }, '全部'),
            h('option', { value: '0-21' }, '0-21 天'),
            h('option', { value: '22-60' }, '22-60 天'),
            h('option', { value: '61-120' }, '61-120 天'),
            h('option', { value: '121+' }, '121+ 天'),
          ]),
        )),
        h('div', { class: 'col-6 col-md-2' }, labeledControl(
          '最小 Volume',
          'optionThetaMinVolume',
          h('input', { id: 'optionThetaMinVolume', class: 'form-control form-control-sm text-end', type: 'number', min: '0', step: '1', value: '0' }),
        )),
        h('div', { class: 'col-6 col-md-2' }, labeledControl(
          '最小 OI',
          'optionThetaMinOpenInterest',
          h('input', { id: 'optionThetaMinOpenInterest', class: 'form-control form-control-sm text-end', type: 'number', min: '0', step: '1', value: '0' }),
        )),
      ]),
      h('div', { class: 'row g-2 my-2' }, [
        h('div', { class: 'col-12 col-xl-6' }, labeledControl(
          '图中到期日多选',
          'optionThetaExpirationFilter',
          h('div', [
            h('select', {
              id: 'optionThetaExpirationFilter',
              class: 'd-none',
              multiple: true,
            }, expirationOptions.value.map((option) => h('option', {
              value: option.value,
              selected: selectedExpirations.value.includes(option.value),
            }, option.label))),
            renderMultiSelectDropdown({
              buttonId: 'optionThetaExpirationFilterTrigger',
              menuShown: expirationMenuShown.value,
              summary: selectionSummary(selectedExpirations.value, expirationOptions.value, '全部到期日'),
              searchValue: expirationSearch.value,
              searchId: 'optionThetaExpirationSearch',
              options: expirationOptions.value,
              selectedValues: selectedExpirations.value,
              onToggleMenu: () => {
                expirationMenuShown.value = !expirationMenuShown.value
                strikeMenuShown.value = false
              },
              onSearchInput: (value) => {
                expirationSearch.value = value
              },
              onToggleValue: (value) => {
                const nextValues = selectedExpirations.value.includes(value)
                  ? selectedExpirations.value.filter((item) => item !== value)
                  : [...selectedExpirations.value, value]
                void updateExpirations(nextValues)
              },
              onSelectAll: () => {
                void updateExpirations(expirationOptions.value.map((option) => option.value))
              },
              onClear: () => {
                void updateExpirations([])
              },
            }),
          ]),
        )),
        h('div', { class: 'col-12 col-xl-6' }, labeledControl(
          '图中行权价多选',
          'optionThetaStrikeFilter',
          h('div', [
            h('select', {
              id: 'optionThetaStrikeFilter',
              class: 'd-none',
              multiple: true,
            }, strikeOptions.value.map((option) => h('option', {
              value: option.value,
              selected: selectedStrikes.value.includes(option.value),
            }, option.label))),
            renderMultiSelectDropdown({
              buttonId: 'optionThetaStrikeFilterTrigger',
              menuShown: strikeMenuShown.value,
              summary: selectionSummary(selectedStrikes.value, strikeOptions.value, '全部行权价'),
              searchValue: strikeSearch.value,
              searchId: 'optionThetaStrikeSearch',
              options: strikeOptions.value,
              selectedValues: selectedStrikes.value,
              onToggleMenu: () => {
                strikeMenuShown.value = !strikeMenuShown.value
                expirationMenuShown.value = false
              },
              onSearchInput: (value) => {
                strikeSearch.value = value
              },
              onToggleValue: (value) => {
                const nextValues = selectedStrikes.value.includes(value)
                  ? selectedStrikes.value.filter((item) => item !== value)
                  : [...selectedStrikes.value, value]
                void updateStrikes(nextValues)
              },
              onSelectAll: () => {
                void updateStrikes(strikeOptions.value.map((option) => option.value))
              },
              onClear: () => {
                void updateStrikes([])
              },
            }),
          ]),
        )),
      ]),
      h('div', { id: 'companyOptionThetaStatus', class: 'small text-muted my-2' }, statusText.value),
      h('div', { class: 'small text-muted mb-3' }, summaryText.value),
      h('div', { class: 'row g-2 mb-3' }, [
        statCard('快照时间', snapshotAt.value),
        statCard('当时股价', spotPrice.value),
        statCard('筛选后合约数', observationCount.value),
      ]),
      h('div', { class: 'row g-3' }, [
        h('div', { class: 'col-12' }, [
          h('div', { class: 'border rounded p-2 h-100' }, [
            h('div', { class: 'fw-semibold mb-1' }, '时间价值 vs 剩余天数'),
            h('div', { class: 'small text-muted mb-2' }, '纵轴改为平均每天时间价值，方便不同到期日直接横向比较。'),
            h('div', { id: 'optionThetaExtrinsicDaysChart', style: 'min-height: 360px; min-width: 300px;' }),
          ]),
        ]),
        h('div', { class: 'col-12' }, [
          h('div', { class: 'border rounded p-2 h-100' }, [
            h('div', { class: 'fw-semibold mb-1' }, '时间价值 vs 距当时股价%'),
            h('div', { class: 'small text-muted mb-2' }, '纵轴改为平均每天时间价值，更容易比较不同虚实值距离的衰减效率。'),
            h('div', { id: 'optionThetaExtrinsicDistanceChart', style: 'min-height: 360px; min-width: 300px;' }),
          ]),
        ]),
        h('div', { class: 'col-12' }, [
          h('div', { class: 'border rounded p-2' }, [
            h('div', { class: 'fw-semibold mb-1' }, '时间价值 vs 行权价'),
            h('div', { class: 'small text-muted mb-2' }, '适合横向比较同一到期日附近不同执行价的定价。'),
            h('div', { id: 'optionThetaExtrinsicStrikeChart', style: 'min-height: 320px; min-width: 300px;' }),
          ]),
        ]),
      ]),
      h('div', { class: 'border rounded p-2 mt-3' }, [
        h('div', { class: 'fw-semibold mb-1' }, '当前期权链明细'),
        h('div', { class: 'small text-muted mb-2' }, '这里的“距离当时股价%”“时间价值”和“平均每天时间价值”都基于本次采集时的股价，不会用后来的最新价回算。'),
        h('div', { class: 'table-responsive company-option-chain-wrap' }, [
          h('table', { id: 'optionThetaTable', class: 'table table-sm table-bordered table-hover align-middle' }, renderTable(tableRows.value)),
        ]),
      ]),
    ])
  },
})

const root = document.getElementById('company-option-theta-vue-root')
if (root) {
  createApp(CompanyOptionThetaPage).mount(root)
}
