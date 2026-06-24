import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue'

type CompaniesHoldingRank =
  | 'HOULD_NUM'
  | 'TOTAL_SHARES'
  | 'HOLD_VALUE'
  | 'HOLDCHA_NUM'
  | 'HOLDCHA_RATIO'

type CompaniesHoldingStateEvent = CustomEvent<{
  dateOptions?: string[]
  selectedDate?: string
  selectedRank?: CompaniesHoldingRank
  rows?: CompaniesHoldingRow[]
  currentPage?: number
  hasNext?: boolean
}>

type CompaniesHoldingRow = {
  rank: number
  code: string
  name: string
  holdNum: number | string
  totalSharesWan: string
  holdValueYi: string
  holdChangeNumWan: string
  holdChangeRatio: number | string
}

const rankOptions: Array<{label: string, rank: CompaniesHoldingRank}> = [
  { label: '持有基金数', rank: 'HOULD_NUM' },
  { label: '持股总数(万股)', rank: 'TOTAL_SHARES' },
  { label: '持股市值(亿元)', rank: 'HOLD_VALUE' },
  { label: '持股变动数量(万股)', rank: 'HOLDCHA_NUM' },
  { label: '持股变动比例(%)', rank: 'HOLDCHA_RATIO' },
]

function isHoldingRank(value: unknown): value is CompaniesHoldingRank {
  return typeof value === 'string' && rankOptions.some((option) => option.rank === value)
}

function emitDateChange(date: string) {
  window.dispatchEvent(new CustomEvent('licai:companies-holding-date-change', {
    detail: { date },
  }))
}

function emitRankChange(rank: CompaniesHoldingRank) {
  window.dispatchEvent(new CustomEvent('licai:companies-holding-rank-change', {
    detail: { rank },
  }))
}

function emitPageChange(page: number) {
  window.dispatchEvent(new CustomEvent('licai:companies-holding-page-change', {
    detail: { page },
  }))
}

function signedClass(value: number | string): string {
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

function companiesHoldingPagination(currentPage: number, hasNext: boolean): Array<{
  active?: boolean
  disabled?: boolean
  key: string
  label: string
  page: number
}> {
  const items: Array<{
    active?: boolean
    disabled?: boolean
    key: string
    label: string
    page: number
  }> = [{
    disabled: currentPage < 11,
    key: 'prev-block',
    label: '<<',
    page: currentPage < 11 ? 1 : currentPage - 10,
  }]

  for (let i = 1; i < 11; i += 1) {
    let page = currentPage
    let label = String(page)
    if (currentPage < 9) {
      page = i
      label = String(page)
    } else if (i < 4) {
      page = i
      label = String(page)
    } else if (i === 4) {
      page = Math.floor(currentPage / 2)
      label = '...'
    } else {
      page = currentPage + i - 8
      label = String(page)
    }
    items.push({
      active: currentPage === page,
      disabled: page > currentPage && !hasNext,
      key: `page-${i}-${page}-${label}`,
      label,
      page,
    })
  }

  items.push({
    disabled: !hasNext,
    key: 'next-block',
    label: '>>',
    page: currentPage + 10,
  })
  return items
}

function rankHeader(
  label: string,
  rank: CompaniesHoldingRank,
  selectedRank: CompaniesHoldingRank,
  onClick: (rank: CompaniesHoldingRank) => void,
) {
  const selected = selectedRank === rank
  return h('th', [
    h('a', {
      href: '#',
      name: 'rank',
      'data-rank': rank,
      class: selected ? 'fw-semibold text-primary text-decoration-underline' : '',
      onClick: (event: Event) => {
        event.preventDefault()
        onClick(rank)
      },
    }, label),
  ])
}

const CompaniesHoldingPage = defineComponent({
  name: 'CompaniesHoldingPage',
  setup() {
    const dateOptions = ref<string[]>([])
    const selectedDate = ref('')
    const selectedRank = ref<CompaniesHoldingRank>('HOULD_NUM')
    const rows = ref<CompaniesHoldingRow[]>([])
    const currentPage = ref(1)
    const hasNext = ref(false)

    const onState = (event: Event) => {
      const detail = (event as CompaniesHoldingStateEvent).detail
      if (Array.isArray(detail?.dateOptions)) {
        dateOptions.value = detail.dateOptions
      }
      if (typeof detail?.selectedDate === 'string') {
        selectedDate.value = detail.selectedDate
      }
      if (isHoldingRank(detail?.selectedRank)) {
        selectedRank.value = detail.selectedRank
      }
      rows.value = Array.isArray(detail?.rows) ? detail.rows : []
      if (typeof detail?.currentPage === 'number' && Number.isFinite(detail.currentPage)) {
        currentPage.value = detail.currentPage
      }
      hasNext.value = Boolean(detail?.hasNext)
    }

    onMounted(() => {
      window.addEventListener('licai:companies-holding-state', onState)
    })

    onBeforeUnmount(() => {
      window.removeEventListener('licai:companies-holding-state', onState)
    })

    const pagination = () => {
      if (currentPage.value === 1 && rows.value.length === 0) {
        return null
      }
      return h('nav', { id: 'companiesHoldingRank-nav' }, [
        h('ul', { class: 'pagination justify-content-center' }, companiesHoldingPagination(currentPage.value, hasNext.value).map((item) => (
          h('li', {
            key: item.key,
            class: ['page-item', item.active ? 'active' : '', item.disabled ? 'disabled' : ''].filter(Boolean).join(' '),
          }, [
            h('a', {
              href: '#',
              class: 'page-link',
              'data-page': String(item.page),
              onClick: (event: Event) => {
                event.preventDefault()
                if (item.disabled || item.active) {
                  return
                }
                emitPageChange(item.page)
              },
            }, item.label),
          ])
        ))),
      ])
    }

    return () => h('div', { id: 'container', class: 'my-2' }, [
      h('div', { class: 'row mb-2' }, [
        h('div', { class: 'col' }),
        h('div', { class: 'col' }, [
          h('span', { class: 'text-center' }, [
            h('label', { for: 'date' }, '数据日期'),
            h('select', {
              id: 'date',
              class: 'form-select form-select-sm',
              value: selectedDate.value,
              onChange: (event: Event) => {
                const value = (event.target as HTMLSelectElement).value
                selectedDate.value = value
                emitDateChange(value)
              },
            }, dateOptions.value.map((option) => h('option', { value: option }, option))),
          ]),
        ]),
      ]),
      h('table', { id: 'companiesHoldingRank', class: 'table table-bordered table-hover' }, [
        h('thead', { class: 'table-primary sticky-top' }, [
          h('tr', [
            h('th', { scope: 'col' }, '序号'),
            h('th', '股票代码'),
            h('th', '股票简称'),
            ...rankOptions.map((option) => rankHeader(
              option.label,
              option.rank,
              selectedRank.value,
              (rank) => {
                selectedRank.value = rank
                emitRankChange(rank)
              },
            )),
          ]),
        ]),
        h('tbody', rows.value.map((row) => h('tr', { key: `${row.code}-${row.rank}-${currentPage.value}` }, [
          h('td', row.rank),
          h('td', [h('a', { href: `company.html?code=${encodeURIComponent(row.code)}` }, row.code)]),
          h('td', [h('a', { href: `company.html?code=${encodeURIComponent(row.code)}` }, row.name)]),
          h('td', row.holdNum),
          h('td', row.totalSharesWan),
          h('td', row.holdValueYi),
          h('td', { class: signedClass(row.holdChangeNumWan) }, row.holdChangeNumWan),
          h('td', { class: signedClass(row.holdChangeRatio) }, row.holdChangeRatio),
        ]))),
      ]),
      pagination(),
    ])
  },
})

const root = document.getElementById('companies-holding-vue-root')
if (root) {
  createApp(CompaniesHoldingPage).mount(root)
}

