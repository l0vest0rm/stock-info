import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue'
import noticeTypeOptions from '../../../config/company-notice-categories.json'

const query = new URLSearchParams(window.location.search)
const pageCode = query.get('code') || `${query.get('stock') || ''}.${query.get('type') || ''}`
const categoryFilterSupported = /^\d{6}(?:\.(SH|SZ|BJ))?$/i.test(pageCode)

type CompanyNoticeRow = {
  noticeDate: string
  noticeType: string
  title: string
  artCode: string
  pdfUrl: string
}

type CompanyNoticeStateEvent = CustomEvent<{
  selectedNoticeType?: string
  rows?: CompanyNoticeRow[]
  currentPage?: number
  hasNext?: boolean
}>

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
    const selectedNoticeType = ref('')
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
      categoryFilterSupported ? h('div', { class: 'row my-2' }, [
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
      ]) : null,
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
              href: row.pdfUrl,
              name: 'pdf',
              'data-code': row.artCode,
              target: '_blank',
              rel: 'noreferrer noopener',
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
