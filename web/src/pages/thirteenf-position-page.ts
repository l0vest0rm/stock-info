import { computed, createApp, defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue'

type SortDirection = 'asc' | 'desc'
type ThirteenFPositionSortKey =
  | 'rank'
  | 'code'
  | 'name'
  | 'positionPctOld'
  | 'positionPctNew'
  | 'positionPctDiff'
  | 'valueOld'
  | 'valueNew'
  | 'valueDiff'
  | 'valueDiffPct'
  | 'sharesOld'
  | 'sharesNew'
  | 'sharesDiff'
  | 'sharesDiffPct'

type ThirteenFPositionOption = {
  value: string
  text: string
}

type ThirteenFPositionRow = {
  rank: number
  code: string
  modalKey: string
  name: string
  positionPctOld: string
  positionPctNew: string
  positionPctDiff: string
  valueOld: string
  valueNew: string
  valueDiff: string
  valueDiffPct: string
  sharesOld: string
  sharesNew: string
  sharesDiff: string
  sharesDiffPct: string
}

type ThirteenFPositionStateEvent = CustomEvent<{
  companyName?: string
  status?: string
  reportDateOptions?: ThirteenFPositionOption[]
  selectedReportDate1?: string
  selectedReportDate2?: string
  date1Label?: string
  date2Label?: string
  rows?: ThirteenFPositionRow[]
}>

const sortableColumns: Array<{ key: ThirteenFPositionSortKey, label: string }> = [
  { key: 'rank', label: '序号' },
  { key: 'code', label: '持仓代码' },
  { key: 'name', label: '持仓名称' },
  { key: 'positionPctOld', label: '持仓占比%' },
  { key: 'positionPctNew', label: '持仓占比%' },
  { key: 'positionPctDiff', label: '持仓占比变化%' },
  { key: 'valueOld', label: '价值(万)' },
  { key: 'valueNew', label: '价值(万)' },
  { key: 'valueDiff', label: '价值变化(万)' },
  { key: 'valueDiffPct', label: '价值变化%' },
  { key: 'sharesOld', label: '股数' },
  { key: 'sharesNew', label: '股数' },
  { key: 'sharesDiff', label: '股数变化' },
  { key: 'sharesDiffPct', label: '股数变化%' },
]

function parseSortableValue(value: string): number | string {
  if (value === '新增') {
    return Number.POSITIVE_INFINITY
  }
  if (value === '清仓') {
    return Number.NEGATIVE_INFINITY
  }
  const matched = String(value || '').replace(/,/g, '').match(/-?\d+(\.\d+)?/)
  if (!matched) {
    return String(value || '')
  }
  const numeric = Number(matched[0])
  return Number.isFinite(numeric) ? numeric : String(value || '')
}

function compareThirteenFPositionRows(
  left: ThirteenFPositionRow,
  right: ThirteenFPositionRow,
  key: ThirteenFPositionSortKey,
  direction: SortDirection,
): number {
  const leftValue = parseSortableValue(left[key])
  const rightValue = parseSortableValue(right[key])
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
  if (value === '新增') {
    return 'text-danger'
  }
  if (value === '清仓') {
    return 'text-success'
  }
  const numeric = Number(String(value || '').replace(/,/g, ''))
  if (!Number.isFinite(numeric) || numeric === 0) {
    return ''
  }
  return numeric > 0 ? 'text-danger' : 'text-success'
}

const ThirteenFPositionPage = defineComponent({
  name: 'ThirteenFPositionPage',
  setup() {
    const companyName = ref('资管公司13f持仓比较')
    const statusText = ref('加载中...')
    const reportDateOptions = ref<ThirteenFPositionOption[]>([])
    const selectedReportDate1 = ref('')
    const selectedReportDate2 = ref('')
    const date1Label = ref('')
    const date2Label = ref('')
    const rows = ref<ThirteenFPositionRow[]>([])
    const sortKey = ref<ThirteenFPositionSortKey>('rank')
    const sortDirection = ref<SortDirection>('asc')

    const sortedRows = computed(() => rows.value.slice().sort((left, right) => {
      return compareThirteenFPositionRows(left, right, sortKey.value, sortDirection.value)
    }))

    const onState = (event: Event) => {
      const detail = (event as ThirteenFPositionStateEvent).detail
      if (!detail) {
        return
      }
      if (typeof detail.companyName === 'string' && detail.companyName) {
        companyName.value = detail.companyName
      }
      if (typeof detail.status === 'string') {
        statusText.value = detail.status
      }
      if (Array.isArray(detail.reportDateOptions)) {
        reportDateOptions.value = detail.reportDateOptions
      }
      if (typeof detail.selectedReportDate1 === 'string') {
        selectedReportDate1.value = detail.selectedReportDate1
      }
      if (typeof detail.selectedReportDate2 === 'string') {
        selectedReportDate2.value = detail.selectedReportDate2
      }
      if (typeof detail.date1Label === 'string') {
        date1Label.value = detail.date1Label
      }
      if (typeof detail.date2Label === 'string') {
        date2Label.value = detail.date2Label
      }
      if (Array.isArray(detail.rows)) {
        rows.value = detail.rows
      }
    }

    const updateSort = (key: ThirteenFPositionSortKey) => {
      if (sortKey.value === key) {
        sortDirection.value = sortDirection.value === 'asc' ? 'desc' : 'asc'
        return
      }
      sortKey.value = key
      sortDirection.value = key === 'rank' ? 'asc' : 'desc'
    }

    const sortClass = (key: ThirteenFPositionSortKey) => {
      const classes = ['sortable']
      if (sortKey.value === key) {
        classes.push(sortDirection.value)
      }
      return classes.join(' ')
    }

    onMounted(() => {
      window.addEventListener('licai:13f-position-state', onState)
    })

    onBeforeUnmount(() => {
      window.removeEventListener('licai:13f-position-state', onState)
    })

    return () => h('div', { id: 'container', class: 'py-3' }, [
      h('div', { class: 'text-center fs-5 fw-bold mb-3' }, companyName.value),
      h('div', { class: 'col-2 d-none' }, [
        h('div', { id: 'compareType', 'data-id': 'qoq' }),
      ]),
      h('div', { id: 'managementTrendChart', style: 'min-height: 600px; min-width: 300px;' }),
      h('div', { class: 'row mb-2 align-items-end' }, [
        h('div', { class: 'col' }),
        h('div', { class: 'col' }, [
          h('label', { class: 'form-label', for: 'reportDate1' }, '老季度'),
          h('select', {
            id: 'reportDate1',
            class: 'form-select form-select-sm',
            value: selectedReportDate1.value,
            onChange: (event: Event) => {
              selectedReportDate1.value = (event.target as HTMLSelectElement).value
            },
          }, reportDateOptions.value.map((option) => h('option', { value: option.value }, option.text))),
        ]),
        h('div', { class: 'col' }, [
          h('label', { class: 'form-label', for: 'reportDate2' }, '新季度'),
          h('select', {
            id: 'reportDate2',
            class: 'form-select form-select-sm',
            value: selectedReportDate2.value,
            onChange: (event: Event) => {
              selectedReportDate2.value = (event.target as HTMLSelectElement).value
            },
          }, reportDateOptions.value.map((option) => h('option', { value: option.value }, option.text))),
        ]),
        h('div', { class: 'col text-end small text-muted' }, statusText.value),
      ]),
      h('table', { id: 'positionCompareTable', class: 'table table-bordered table-hover text-end' }, [
        h('thead', { class: 'table-success theadFix' }, [
          h('tr', [
            h('th', {
              class: sortClass('rank'),
              style: 'cursor: pointer;',
              onClick: () => updateSort('rank'),
            }, sortableColumns[0].label),
            h('th', {
              class: sortClass('code'),
              style: 'cursor: pointer;',
              onClick: () => updateSort('code'),
            }, sortableColumns[1].label),
            h('th', {
              class: sortClass('name'),
              style: 'cursor: pointer;',
              onClick: () => updateSort('name'),
            }, sortableColumns[2].label),
            h('th', {
              class: sortClass('positionPctOld'),
              style: 'cursor: pointer;',
              onClick: () => updateSort('positionPctOld'),
            }, ['持仓占比%', h('br'), h('span', date1Label.value)]),
            h('th', {
              class: sortClass('positionPctNew'),
              style: 'cursor: pointer;',
              onClick: () => updateSort('positionPctNew'),
            }, ['持仓占比%', h('br'), h('span', date2Label.value)]),
            h('th', {
              class: sortClass('positionPctDiff'),
              style: 'cursor: pointer;',
              onClick: () => updateSort('positionPctDiff'),
            }, '持仓占比变化%'),
            h('th', {
              class: sortClass('valueOld'),
              style: 'cursor: pointer;',
              onClick: () => updateSort('valueOld'),
            }, ['价值(万)', h('br'), h('span', date1Label.value)]),
            h('th', {
              class: sortClass('valueNew'),
              style: 'cursor: pointer;',
              onClick: () => updateSort('valueNew'),
            }, ['价值(万)', h('br'), h('span', date2Label.value)]),
            h('th', {
              class: sortClass('valueDiff'),
              style: 'cursor: pointer;',
              onClick: () => updateSort('valueDiff'),
            }, '价值变化(万)'),
            h('th', {
              class: sortClass('valueDiffPct'),
              style: 'cursor: pointer;',
              onClick: () => updateSort('valueDiffPct'),
            }, '价值变化%'),
            h('th', {
              class: sortClass('sharesOld'),
              style: 'cursor: pointer;',
              onClick: () => updateSort('sharesOld'),
            }, ['股数', h('br'), h('span', date1Label.value)]),
            h('th', {
              class: sortClass('sharesNew'),
              style: 'cursor: pointer;',
              onClick: () => updateSort('sharesNew'),
            }, ['股数', h('br'), h('span', date2Label.value)]),
            h('th', {
              class: sortClass('sharesDiff'),
              style: 'cursor: pointer;',
              onClick: () => updateSort('sharesDiff'),
            }, '股数变化'),
            h('th', {
              class: sortClass('sharesDiffPct'),
              style: 'cursor: pointer;',
              onClick: () => updateSort('sharesDiffPct'),
            }, '股数变化%'),
          ]),
        ]),
        h('tbody', sortedRows.value.length > 0
          ? sortedRows.value.map((row) => h('tr', { key: `${row.code}-${row.rank}` }, [
            h('td', row.rank),
            h('td', row.code),
            h('td', [
              h('a', {
                'data-bs-toggle': 'modal',
                'data-bs-target': '#componentChangeModal',
                'data-key': row.modalKey,
                href: '#',
                onClick: (event: Event) => event.preventDefault(),
              }, row.name),
            ]),
            h('td', row.positionPctOld),
            h('td', row.positionPctNew),
            h('td', { class: deltaClass(row.positionPctDiff) }, row.positionPctDiff),
            h('td', row.valueOld),
            h('td', row.valueNew),
            h('td', { class: deltaClass(row.valueDiff) }, row.valueDiff),
            h('td', { class: deltaClass(row.valueDiffPct) }, row.valueDiffPct),
            h('td', row.sharesOld),
            h('td', row.sharesNew),
            h('td', { class: deltaClass(row.sharesDiff) }, row.sharesDiff),
            h('td', { class: deltaClass(row.sharesDiffPct) }, row.sharesDiffPct),
          ]))
          : [h('tr', [h('td', { colSpan: 14, class: 'text-muted text-center' }, '暂无数据')])]),
      ]),
      h('div', { class: 'modal fade', id: 'componentChangeModal', tabIndex: '-1', 'aria-labelledby': 'thirteenfPositionModalTitle', 'aria-hidden': 'true' }, [
        h('div', { class: 'modal-dialog modal-xl' }, [
          h('div', { class: 'modal-content' }, [
            h('div', { class: 'modal-header' }, [
              h('h1', { class: 'modal-title fs-5', id: 'thirteenfPositionModalTitle' }, `${companyName.value}(持仓成分股变动历史)`),
              h('button', { type: 'button', class: 'btn-close', 'data-bs-dismiss': 'modal', 'aria-label': 'Close' }),
            ]),
            h('div', { class: 'modal-body', id: 'singleChart', style: 'min-height: 200px;' }),
          ]),
        ]),
      ]),
    ])
  },
})

const root = document.getElementById('thirteenf-position-vue-root')
if (root) {
  createApp(ThirteenFPositionPage).mount(root)
}

