import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue'

type FundRankSortKey =
  | 'rzdf'
  | 'zzf'
  | '1yzf'
  | '3yzf'
  | '6yzf'
  | '1nzf'
  | '2nzf'
  | '3nzf'
  | 'jnzf'
  | 'lnzf'

type SortDirection = 'asc' | 'desc'
type FundCompanyOption = {
  value: string
  label: string
}

type FundRankRow = {
  rank: number
  code: string
  name: string
  navDate: string
  unitNav: string
  accumNav: string
  dailyChange: string
  weekChange: string
  monthChange: string
  quarterChange: string
  halfYearChange: string
  yearChange: string
  twoYearChange: string
  threeYearChange: string
  thisYearChange: string
  sinceSetupChange: string
  setupDate: string
  manager: string
  company: string
  style: string
  scale: string
  updateDate: string
}

type FundsStateEvent = CustomEvent<{
  rows?: FundRankRow[]
  companyOptions?: FundCompanyOption[]
  selectedCompany?: string
  selectedFundStyle?: string
  selectedPage?: number
  sortBy?: FundRankSortKey
  sortDirection?: SortDirection
  status?: string
  totalPages?: number
}>

const fundStyleOptions = [
  ['all', '全部'],
  ['gp', '股票型'],
  ['hh', '混合型'],
  ['zq', '债券型'],
  ['zs', '指数型'],
  ['ct', '场内交易'],
  ['qdii', 'QDII'],
  ['lof', 'LOF'],
  ['fof', 'FOF'],
] as const

function emitFundsSortChange(sortBy: FundRankSortKey) {
  window.dispatchEvent(new CustomEvent('licai:funds-sort-change', {
    detail: { sortBy },
  }))
}

function emitFundsFilterChange(detail: { fundStyle?: string, company?: string }) {
  window.dispatchEvent(new CustomEvent('licai:funds-filter-change', { detail }))
}

function emitFundsPageChange(page: number) {
  window.dispatchEvent(new CustomEvent('licai:funds-page-change', {
    detail: { page },
  }))
}

function signedClass(value: string): string {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
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

const FundsPage = defineComponent({
  name: 'FundsPage',
  setup() {
    const rows = ref<FundRankRow[]>([])
    const companyOptions = ref<FundCompanyOption[]>([{ value: '0', label: '全部' }])
    const selectedCompany = ref('0')
    const fundStyle = ref('all')
    const selectedPage = ref(1)
    const totalPages = ref(1)
    const sortBy = ref<FundRankSortKey>('3yzf')
    const sortDirection = ref<SortDirection>('desc')
    const statusText = ref('加载中...')

    const onState = (event: Event) => {
      const detail = (event as FundsStateEvent).detail
      if (!detail) {
        return
      }
      if (Array.isArray(detail.rows)) {
        rows.value = detail.rows
      }
      if (Array.isArray(detail.companyOptions)) {
        companyOptions.value = detail.companyOptions
      }
      if (typeof detail.selectedCompany === 'string') {
        selectedCompany.value = detail.selectedCompany
      }
      if (typeof detail.selectedFundStyle === 'string') {
        fundStyle.value = detail.selectedFundStyle
      }
      if (typeof detail.selectedPage === 'number' && Number.isFinite(detail.selectedPage)) {
        selectedPage.value = detail.selectedPage
      }
      if (typeof detail.totalPages === 'number' && Number.isFinite(detail.totalPages)) {
        totalPages.value = detail.totalPages
      }
      if (typeof detail.sortBy === 'string') {
        sortBy.value = detail.sortBy
      }
      if (detail.sortDirection === 'asc' || detail.sortDirection === 'desc') {
        sortDirection.value = detail.sortDirection
      }
      if (typeof detail.status === 'string') {
        statusText.value = detail.status
      }
    }

    onMounted(() => {
      window.addEventListener('licai:funds-state', onState)
    })

    onBeforeUnmount(() => {
      window.removeEventListener('licai:funds-state', onState)
    })

    const sortClass = (key: FundRankSortKey) => {
      const classes = ['sortable']
      if (sortBy.value === key) {
        classes.push(sortDirection.value)
      }
      return classes.join(' ')
    }

    const sortableHeader = (label: string, key: FundRankSortKey) => h('th', {
      class: sortClass(key),
      'data-st': key,
      style: 'cursor: pointer;',
      onClick: () => emitFundsSortChange(key),
    }, label)

    const paginationItems = () => {
      const pages: Array<number | 'ellipsis'> = []
      const total = totalPages.value
      const current = selectedPage.value
      if (total <= 7) {
        for (let page = 1; page <= total; page += 1) {
          pages.push(page)
        }
        return pages
      }
      pages.push(1)
      if (current > 4) {
        pages.push('ellipsis')
      }
      const start = Math.max(2, current - 1)
      const end = Math.min(total - 1, current + 1)
      for (let page = start; page <= end; page += 1) {
        pages.push(page)
      }
      if (current < total - 3) {
        pages.push('ellipsis')
      }
      pages.push(total)
      return pages
    }

    return () => h('div', { id: 'container', class: 'py-3' }, [
      h('div', { class: 'row g-2 mb-2 align-items-end' }, [
        h('div', { class: 'col-md-3' }, [
          h('label', { for: 'fundStyle', class: 'form-label form-label-sm mb-1' }, '基金类型'),
          h('select', {
            id: 'fundStyle',
            class: 'form-select form-select-sm',
            value: fundStyle.value,
            onChange: (event: Event) => {
              const nextValue = (event.target as HTMLSelectElement).value
              fundStyle.value = nextValue
              emitFundsFilterChange({ fundStyle: nextValue, company: selectedCompany.value })
            },
          }, fundStyleOptions.map(([value, label]) => h('option', { value }, label))),
        ]),
        h('div', { class: 'col-md-4' }, [
          h('label', { for: 'gs', class: 'form-label form-label-sm mb-1' }, '基金公司'),
          h('select', {
            id: 'gs',
            class: 'form-select form-select-sm',
            value: selectedCompany.value,
            onChange: (event: Event) => {
              const nextValue = (event.target as HTMLSelectElement).value
              selectedCompany.value = nextValue
              emitFundsFilterChange({ fundStyle: fundStyle.value, company: nextValue })
            },
          }, companyOptions.value.map((option) => h('option', { value: option.value }, option.label))),
        ]),
        h('div', { class: 'col-md-5 d-flex justify-content-md-end align-items-end' }, [
          h('div', { class: 'small text-muted text-md-end' }, statusText.value),
        ]),
      ]),
      h('table', { id: 'fundRankTable', class: 'table table-bordered table-hover' }, [
        h('thead', { class: 'table-info theadFix' }, [
          h('tr', [
            h('th', { scope: 'col' }, '#'),
            h('th', '基金代码'),
            h('th', '基金简称'),
            h('th', '净值日期'),
            h('th', '单位净值'),
            h('th', '累计净值'),
            sortableHeader('日增长率', 'rzdf'),
            sortableHeader('近1周', 'zzf'),
            sortableHeader('近1月', '1yzf'),
            sortableHeader('近3月', '3yzf'),
            sortableHeader('近6月', '6yzf'),
            sortableHeader('近1年', '1nzf'),
            sortableHeader('近2年', '2nzf'),
            sortableHeader('近3年', '3nzf'),
            sortableHeader('今年来', 'jnzf'),
            sortableHeader('成立来', 'lnzf'),
            h('th', '成立日期'),
            h('th', '基金经理'),
            h('th', '基金公司'),
            h('th', '基金类型'),
            h('th', '基金规模(亿元)'),
            h('th', '更新日期'),
          ]),
        ]),
        h('tbody', rows.value.length > 0
          ? rows.value.map((row) => h('tr', { key: `${row.code}-${row.rank}-${selectedPage.value}` }, [
            h('td', row.rank),
            h('td', row.code),
            h('td', [h('a', { href: `fund.html?code=${encodeURIComponent(`${row.code}.OF`)}` }, row.name)]),
            h('td', row.navDate),
            h('td', row.unitNav),
            h('td', row.accumNav),
            h('td', { class: signedClass(row.dailyChange) }, row.dailyChange),
            h('td', { class: signedClass(row.weekChange) }, row.weekChange),
            h('td', { class: signedClass(row.monthChange) }, row.monthChange),
            h('td', { class: signedClass(row.quarterChange) }, row.quarterChange),
            h('td', { class: signedClass(row.halfYearChange) }, row.halfYearChange),
            h('td', { class: signedClass(row.yearChange) }, row.yearChange),
            h('td', { class: signedClass(row.twoYearChange) }, row.twoYearChange),
            h('td', { class: signedClass(row.threeYearChange) }, row.threeYearChange),
            h('td', { class: signedClass(row.thisYearChange) }, row.thisYearChange),
            h('td', { class: signedClass(row.sinceSetupChange) }, row.sinceSetupChange),
            h('td', row.setupDate),
            h('td', row.manager),
            h('td', row.company),
            h('td', row.style),
            h('td', row.scale),
            h('td', row.updateDate),
          ]))
          : [h('tr', [h('td', { colSpan: 22, class: 'text-muted text-center' }, '暂无数据')])]),
      ]),
      totalPages.value > 1
        ? h('nav', { class: 'mt-3', 'aria-label': '基金分页' }, [
          h('ul', { class: 'pagination pagination-sm justify-content-center mb-0 flex-wrap' }, [
            h('li', { class: `page-item${selectedPage.value <= 1 ? ' disabled' : ''}` }, [
              h('button', {
                type: 'button',
                class: 'page-link',
                disabled: selectedPage.value <= 1,
                onClick: () => emitFundsPageChange(selectedPage.value - 1),
              }, '上一页'),
            ]),
            ...paginationItems().map((item, index) => item === 'ellipsis'
              ? h('li', { key: `ellipsis-${index}`, class: 'page-item disabled' }, [
                h('span', { class: 'page-link' }, '...'),
              ])
              : h('li', { key: `page-${item}`, class: `page-item${item === selectedPage.value ? ' active' : ''}` }, [
                h('button', {
                  type: 'button',
                  class: 'page-link',
                  'aria-current': item === selectedPage.value ? 'page' : undefined,
                  onClick: () => emitFundsPageChange(item),
                }, String(item)),
              ])),
            h('li', { class: `page-item${selectedPage.value >= totalPages.value ? ' disabled' : ''}` }, [
              h('button', {
                type: 'button',
                class: 'page-link',
                disabled: selectedPage.value >= totalPages.value,
                onClick: () => emitFundsPageChange(selectedPage.value + 1),
              }, '下一页'),
            ]),
          ]),
        ])
        : null,
    ])
  },
})

const root = document.getElementById('funds-vue-root')
if (root) {
  createApp(FundsPage).mount(root)
}
