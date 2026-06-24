import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue'

type CompanyNoticeRow = {
  noticeDate: string
  noticeType: string
  title: string
  artCode: string
}

type CompanyNoticeStateEvent = CustomEvent<{
  selectedNoticeType?: string
  rows?: CompanyNoticeRow[]
  currentPage?: number
  hasNext?: boolean
}>

type NoticeTypeOption = {
  value: string
  label: string
}

const noticeTypeOptions: NoticeTypeOption[] = [
  { value: '0-0', label: '全部' },
  { value: '1-0', label: '财务报告-全部' },
  { value: '1-1', label: '财务报告-定期报告' },
  { value: '1-13', label: '财务报告-利润分配' },
  { value: '1-5', label: '财务报告-业绩预告' },
  { value: '1-6', label: '财务报告-业绩快报' },
  { value: '2-0', label: '融资公告-全部' },
  { value: '3-0', label: '风险提示-全部' },
  { value: '4-0', label: '信息变更-全部' },
  { value: '5-0', label: '重大事项-全部' },
  { value: '6-0', label: '资产充足-全部' },
  { value: '7-0', label: '持股变动-全部' },
]

function emitNoticeTypeChange(noticeType: string) {
  window.dispatchEvent(new CustomEvent('licai:company-notice-type-change', {
    detail: { noticeType },
  }))
}

function emitPageChange(page: number) {
  window.dispatchEvent(new CustomEvent('licai:company-notice-page-change', {
    detail: { page },
  }))
}

function emitOpenPdf(artCode: string) {
  window.dispatchEvent(new CustomEvent('licai:company-notice-open-pdf', {
    detail: { artCode },
  }))
}

function companyNoticePagination(currentPage: number, hasNext: boolean) {
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

const CompanyNoticePage = defineComponent({
  name: 'CompanyNoticePage',
  setup() {
    const selectedNoticeType = ref('0-0')
    const rows = ref<CompanyNoticeRow[]>([])
    const currentPage = ref(1)
    const hasNext = ref(false)

    const onState = (event: Event) => {
      const detail = (event as CompanyNoticeStateEvent).detail
      if (!detail) {
        return
      }
      if (typeof detail.selectedNoticeType === 'string') {
        selectedNoticeType.value = detail.selectedNoticeType
      }
      if (Array.isArray(detail.rows)) {
        rows.value = detail.rows
      }
      if (typeof detail.currentPage === 'number' && Number.isFinite(detail.currentPage)) {
        currentPage.value = detail.currentPage
      }
      hasNext.value = Boolean(detail.hasNext)
    }

    onMounted(() => {
      window.addEventListener('licai:company-notice-state', onState)
    })

    onBeforeUnmount(() => {
      window.removeEventListener('licai:company-notice-state', onState)
    })

    const pagination = () => {
      if (currentPage.value === 1 && rows.value.length === 0) {
        return null
      }
      return h('nav', { id: 'companyNoticeTable-nav' }, [
        h('ul', { class: 'pagination justify-content-center' }, companyNoticePagination(currentPage.value, hasNext.value).map((item) => (
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

    return () => h('div', { class: 'company-notice-page' }, [
      h('div', { class: 'row my-2' }, [
        h('div', { class: 'col-2' }),
        h('div', { class: 'col-8' }, [
          h('span', { class: 'text-center' }, [
            h('label', { for: 'noticeType' }, '公告类型'),
            h('select', {
              id: 'noticeType',
              class: 'form-select form-select-sm',
              value: selectedNoticeType.value,
              onChange: (event: Event) => {
                const value = (event.target as HTMLSelectElement).value
                selectedNoticeType.value = value
                emitNoticeTypeChange(value)
              },
            }, noticeTypeOptions.map((option) => h('option', { value: option.value }, option.label))),
          ]),
        ]),
        h('div', { class: 'col-2' }),
      ]),
      h('table', { id: 'companyNoticeTable', class: 'table table-sm table-bordered table-hover' }, [
        h('thead', { class: 'table-info' }, [
          h('tr', [
            h('th', { scope: 'col' }, '公告日期'),
            h('th', { scope: 'col' }, '公告类型'),
            h('th', { scope: 'col' }, '公告标题'),
          ]),
        ]),
        h('tbody', rows.value.map((row) => h('tr', { key: `${row.artCode}-${row.noticeDate}` }, [
          h('td', row.noticeDate),
          h('td', row.noticeType),
          h('td', [
            h('a', {
              href: `#${row.artCode}`,
              name: 'pdf',
              'data-code': row.artCode,
              onClick: (event: Event) => {
                event.preventDefault()
                emitOpenPdf(row.artCode)
              },
            }, row.title),
          ]),
        ]))),
      ]),
      pagination(),
    ])
  },
})

const root = document.getElementById('company-notice-vue-root')
if (root) {
  createApp(CompanyNoticePage).mount(root)
}

