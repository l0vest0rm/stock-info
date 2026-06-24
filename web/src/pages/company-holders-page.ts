import { computed, createApp, defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue'

type SortDirection = 'asc' | 'desc'
type FreeHolderSortKey =
  | 'rank'
  | 'holderName'
  | 'holderType'
  | 'shareType'
  | 'ratioCurrent'
  | 'ratioPrevious'
  | 'ratioDiff'
  | 'sharesCurrent'
  | 'sharesPrevious'
  | 'sharesDiffPct'

type OrgHolderSortKey =
  | 'rank'
  | 'fundCode'
  | 'name'
  | 'sharesCurrent'
  | 'sharesPrevious'
  | 'sharesDiffPct'
  | 'ratioCurrent'
  | 'ratioPrevious'
  | 'ratioDiff'
  | 'netValueCurrent'
  | 'netValuePrevious'
  | 'netValueDiff'

type ReportDateOption = {
  value: string
  text: string
}

type CompanyFreeHolderRow = {
  rank: number
  holderName: string
  holderType: string
  shareType: string
  ratioCurrent: string
  ratioPrevious: string
  ratioDiff: string
  sharesCurrent: string
  sharesPrevious: string
  sharesDiffPct: string
}

type CompanyOrgHolderRow = {
  rank: number
  fundCode: string
  fundHref: string
  name: string
  sharesCurrent: string
  sharesPrevious: string
  sharesDiffPct: string
  ratioCurrent: string
  ratioPrevious: string
  ratioDiff: string
  netValueCurrent: string
  netValuePrevious: string
  netValueDiff: string
}

type CompanyHoldersStateEvent = CustomEvent<{
  reportDateOptions?: ReportDateOption[]
  selectedReportDate1?: string
  selectedReportDate2?: string
  freeRows?: CompanyFreeHolderRow[]
  orgRows?: CompanyOrgHolderRow[]
}>

function parseSortableValue(value: string): number | string {
  const matched = String(value || '').replace(/,/g, '').match(/-?\d+(\.\d+)?/)
  if (!matched) {
    return String(value || '')
  }
  const numeric = Number(matched[0])
  return Number.isFinite(numeric) ? numeric : String(value || '')
}

function compareRows<T extends Record<string, unknown>>(
  left: T,
  right: T,
  key: string,
  direction: SortDirection,
  rankKey: keyof T,
): number {
  const leftValue = key === 'rank' ? Number(left[rankKey]) : parseSortableValue(String(left[key] ?? ''))
  const rightValue = key === 'rank' ? Number(right[rankKey]) : parseSortableValue(String(right[key] ?? ''))
  let result = 0
  if (typeof leftValue === 'number' && typeof rightValue === 'number') {
    result = leftValue - rightValue
  } else {
    result = String(leftValue).localeCompare(String(rightValue))
  }
  if (result === 0) {
    result = Number(left[rankKey]) - Number(right[rankKey])
  }
  return direction === 'asc' ? result : -result
}

function deltaClass(value: string) {
  const numeric = Number(String(value || '').replace(/,/g, ''))
  if (!Number.isFinite(numeric) || numeric === 0) {
    return ''
  }
  return numeric > 0 ? 'text-danger' : 'text-success'
}

const CompanyHoldersPage = defineComponent({
  name: 'CompanyHoldersPage',
  setup() {
    const reportDateOptions = ref<ReportDateOption[]>([])
    const selectedReportDate1 = ref('')
    const selectedReportDate2 = ref('')
    const freeRows = ref<CompanyFreeHolderRow[]>([])
    const orgRows = ref<CompanyOrgHolderRow[]>([])
    const freeSortKey = ref<FreeHolderSortKey>('rank')
    const freeSortDirection = ref<SortDirection>('asc')
    const orgSortKey = ref<OrgHolderSortKey>('sharesCurrent')
    const orgSortDirection = ref<SortDirection>('desc')

    const sortedFreeRows = computed(() => freeRows.value.slice().sort((left, right) => {
      return compareRows(left, right, freeSortKey.value, freeSortDirection.value, 'rank')
    }))
    const sortedOrgRows = computed(() => orgRows.value.slice().sort((left, right) => {
      return compareRows(left, right, orgSortKey.value, orgSortDirection.value, 'rank')
    }))

    const onState = (event: Event) => {
      const detail = (event as CompanyHoldersStateEvent).detail
      if (!detail) {
        return
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
      if (Array.isArray(detail.freeRows)) {
        freeRows.value = detail.freeRows
      }
      if (Array.isArray(detail.orgRows)) {
        orgRows.value = detail.orgRows
      }
    }

    const updateFreeSort = (key: FreeHolderSortKey) => {
      if (freeSortKey.value === key) {
        freeSortDirection.value = freeSortDirection.value === 'asc' ? 'desc' : 'asc'
        return
      }
      freeSortKey.value = key
      freeSortDirection.value = key === 'rank' ? 'asc' : 'desc'
    }

    const updateOrgSort = (key: OrgHolderSortKey) => {
      if (orgSortKey.value === key) {
        orgSortDirection.value = orgSortDirection.value === 'asc' ? 'desc' : 'asc'
        return
      }
      orgSortKey.value = key
      orgSortDirection.value = key === 'rank' ? 'asc' : 'desc'
    }

    const sortClass = (activeKey: string, currentKey: string, currentDirection: SortDirection) => {
      const classes = ['sortable']
      if (activeKey === currentKey) {
        classes.push(currentDirection)
      }
      return classes.join(' ')
    }

    onMounted(() => {
      window.addEventListener('licai:company-holders-state', onState)
    })

    onBeforeUnmount(() => {
      window.removeEventListener('licai:company-holders-state', onState)
    })

    return () => h('div', { class: 'company-holders-page' }, [
      h('div', { class: 'row my-2' }, [
        h('div', { class: 'col' }),
        h('div', { class: 'col' }, [
          h('span', { class: 'text-center' }, [
            h('label', { for: 'reportDate1' }, '新季度报'),
            h('select', {
              id: 'reportDate1',
              name: 'reportDate',
              class: 'form-select form-select-sm',
              value: selectedReportDate1.value,
              onChange: (event: Event) => {
                selectedReportDate1.value = (event.target as HTMLSelectElement).value
              },
            }, reportDateOptions.value.map((option) => h('option', { value: option.value }, option.text))),
          ]),
        ]),
        h('div', { class: 'col' }, [
          h('span', { class: 'text-center' }, [
            h('label', { for: 'reportDate2' }, '对比老季度报'),
            h('select', {
              id: 'reportDate2',
              name: 'reportDate',
              class: 'form-select form-select-sm',
              value: selectedReportDate2.value,
              onChange: (event: Event) => {
                selectedReportDate2.value = (event.target as HTMLSelectElement).value
              },
            }, reportDateOptions.value.map((option) => h('option', { value: option.value }, option.text))),
          ]),
        ]),
      ]),
      h('div', { class: 'd-flex justify-content-between align-items-center px-1' }, [
        h('span', { class: 'small text-muted' }, freeRows.value.length ? `十大流通股东 ${freeRows.value.length} 行` : '十大流通股东加载中...'),
        h('span', { class: 'small text-muted' }, orgRows.value.length ? `机构持仓 ${orgRows.value.length} 行` : '机构持仓加载中...'),
      ]),
      h('table', { id: 'freeHoldersTable', class: 'table table-bordered table-hover px-3' }, [
        h('thead', { class: 'table-info' }, [
          h('tr', [
            h('th', { class: sortClass(freeSortKey.value, 'rank', freeSortDirection.value), style: 'cursor: pointer;', onClick: () => updateFreeSort('rank') }, '#'),
            h('th', { class: sortClass(freeSortKey.value, 'holderName', freeSortDirection.value), style: 'cursor: pointer;', onClick: () => updateFreeSort('holderName') }, '十大流通股东(名称)'),
            h('th', { class: sortClass(freeSortKey.value, 'holderType', freeSortDirection.value), style: 'cursor: pointer;', onClick: () => updateFreeSort('holderType') }, '股东性质'),
            h('th', { class: sortClass(freeSortKey.value, 'shareType', freeSortDirection.value), style: 'cursor: pointer;', onClick: () => updateFreeSort('shareType') }, '股份类型'),
            h('th', { class: sortClass(freeSortKey.value, 'ratioCurrent', freeSortDirection.value), style: 'cursor: pointer;', onClick: () => updateFreeSort('ratioCurrent') }, ['持股比例(%)', h('br'), selectedReportDate1.value]),
            h('th', { class: sortClass(freeSortKey.value, 'ratioPrevious', freeSortDirection.value), style: 'cursor: pointer;', onClick: () => updateFreeSort('ratioPrevious') }, ['持股比例(%)', h('br'), selectedReportDate2.value]),
            h('th', { class: sortClass(freeSortKey.value, 'ratioDiff', freeSortDirection.value), style: 'cursor: pointer;', onClick: () => updateFreeSort('ratioDiff') }, '比例变化(%)'),
            h('th', { class: sortClass(freeSortKey.value, 'sharesCurrent', freeSortDirection.value), style: 'cursor: pointer;', onClick: () => updateFreeSort('sharesCurrent') }, ['持股数(股)', h('br'), selectedReportDate1.value]),
            h('th', { class: sortClass(freeSortKey.value, 'sharesPrevious', freeSortDirection.value), style: 'cursor: pointer;', onClick: () => updateFreeSort('sharesPrevious') }, ['持股数(股)', h('br'), selectedReportDate2.value]),
            h('th', { class: sortClass(freeSortKey.value, 'sharesDiffPct', freeSortDirection.value), style: 'cursor: pointer;', onClick: () => updateFreeSort('sharesDiffPct') }, '持股数变化(%)'),
          ]),
        ]),
        h('tbody', sortedFreeRows.value.map((row) => h('tr', [
          h('td', row.rank),
          h('td', row.holderName),
          h('td', row.holderType),
          h('td', row.shareType),
          h('td', row.ratioCurrent),
          h('td', row.ratioPrevious),
          h('td', { class: deltaClass(row.ratioDiff) }, row.ratioDiff),
          h('td', row.sharesCurrent),
          h('td', row.sharesPrevious),
          h('td', { class: deltaClass(row.sharesDiffPct) }, row.sharesDiffPct),
        ]))),
      ]),
      h('table', { id: 'orgHoldersTable', class: 'table table-bordered table-hover px-3' }, [
        h('thead', { class: 'table-info' }, [
          h('tr', [
            h('th', { class: sortClass(orgSortKey.value, 'rank', orgSortDirection.value), style: 'cursor: pointer;', onClick: () => updateOrgSort('rank') }, '#'),
            h('th', { class: sortClass(orgSortKey.value, 'fundCode', orgSortDirection.value), style: 'cursor: pointer;', onClick: () => updateOrgSort('fundCode') }, '机构持仓表(代码)'),
            h('th', { class: sortClass(orgSortKey.value, 'name', orgSortDirection.value), style: 'cursor: pointer;', onClick: () => updateOrgSort('name') }, '名称'),
            h('th', { class: sortClass(orgSortKey.value, 'sharesCurrent', orgSortDirection.value), style: 'cursor: pointer;', onClick: () => updateOrgSort('sharesCurrent') }, ['持股数(股)', h('br'), selectedReportDate1.value]),
            h('th', { class: sortClass(orgSortKey.value, 'sharesPrevious', orgSortDirection.value), style: 'cursor: pointer;', onClick: () => updateOrgSort('sharesPrevious') }, ['持股数(股)', h('br'), selectedReportDate2.value]),
            h('th', { class: sortClass(orgSortKey.value, 'sharesDiffPct', orgSortDirection.value), style: 'cursor: pointer;', onClick: () => updateOrgSort('sharesDiffPct') }, '持股数变化(%)'),
            h('th', { class: sortClass(orgSortKey.value, 'ratioCurrent', orgSortDirection.value), style: 'cursor: pointer;', onClick: () => updateOrgSort('ratioCurrent') }, ['持股比例(%)', h('br'), selectedReportDate1.value]),
            h('th', { class: sortClass(orgSortKey.value, 'ratioPrevious', orgSortDirection.value), style: 'cursor: pointer;', onClick: () => updateOrgSort('ratioPrevious') }, ['持股比例(%)', h('br'), selectedReportDate2.value]),
            h('th', { class: sortClass(orgSortKey.value, 'ratioDiff', orgSortDirection.value), style: 'cursor: pointer;', onClick: () => updateOrgSort('ratioDiff') }, '比例变化(%)'),
            h('th', { class: sortClass(orgSortKey.value, 'netValueCurrent', orgSortDirection.value), style: 'cursor: pointer;', onClick: () => updateOrgSort('netValueCurrent') }, ['净值占比(%)', h('br'), selectedReportDate1.value]),
            h('th', { class: sortClass(orgSortKey.value, 'netValuePrevious', orgSortDirection.value), style: 'cursor: pointer;', onClick: () => updateOrgSort('netValuePrevious') }, ['净值占比(%)', h('br'), selectedReportDate2.value]),
            h('th', { class: sortClass(orgSortKey.value, 'netValueDiff', orgSortDirection.value), style: 'cursor: pointer;', onClick: () => updateOrgSort('netValueDiff') }, '净值占比变化(%)'),
          ]),
        ]),
        h('tbody', sortedOrgRows.value.map((row) => h('tr', [
          h('td', row.rank),
          h('td', row.fundCode ? h('a', { href: row.fundHref, target: '_blank' }, row.fundCode) : ''),
          h('td', row.name),
          h('td', row.sharesCurrent),
          h('td', row.sharesPrevious),
          h('td', { class: deltaClass(row.sharesDiffPct) }, row.sharesDiffPct),
          h('td', row.ratioCurrent),
          h('td', row.ratioPrevious),
          h('td', { class: deltaClass(row.ratioDiff) }, row.ratioDiff),
          h('td', row.netValueCurrent),
          h('td', row.netValuePrevious),
          h('td', { class: deltaClass(row.netValueDiff) }, row.netValueDiff),
        ]))),
      ]),
    ])
  },
})

const root = document.getElementById('company-holders-vue-root')
if (root) {
  createApp(CompanyHoldersPage).mount(root)
}

