import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue'
import categoryOptions from '../../../config/fund-notice-categories.json'

type FundNoticeRow = {
  id: string
  title: string
  category: string
  publishDate: string
  detailUrl: string
  pdfUrl: string
}

type FundNoticeState = {
  category?: string
  rows?: FundNoticeRow[]
  totalCount?: number
  page?: number
  pageSize?: number
  loading?: boolean
  error?: string
}

function emit(name: string, detail: Record<string, unknown>): void {
  window.dispatchEvent(new CustomEvent(name, { detail }))
}

const FundNoticePage = defineComponent({
  name: 'FundNoticePage',
  setup() {
    const category = ref('0')
    const rows = ref<FundNoticeRow[]>([])
    const totalCount = ref(0)
    const page = ref(1)
    const pageSize = ref(20)
    const loading = ref(true)
    const error = ref('')

    const onState = (event: Event) => {
      const detail = (event as CustomEvent<FundNoticeState>).detail || {}
      if (typeof detail.category === 'string') category.value = detail.category
      if (Array.isArray(detail.rows)) rows.value = detail.rows
      if (typeof detail.totalCount === 'number') totalCount.value = detail.totalCount
      if (typeof detail.page === 'number') page.value = detail.page
      if (typeof detail.pageSize === 'number') pageSize.value = detail.pageSize
      if (typeof detail.loading === 'boolean') loading.value = detail.loading
      if (typeof detail.error === 'string') error.value = detail.error
    }

    onMounted(() => window.addEventListener('licai:fund-notice-state', onState))
    onBeforeUnmount(() => window.removeEventListener('licai:fund-notice-state', onState))

    return () => {
      const totalPages = Math.max(1, Math.ceil(totalCount.value / pageSize.value))
      const categoryLabel = (value: string) => categoryOptions.find((option) => option.value === value)?.label || '其他公告'
      return h('div', { class: 'container py-3' }, [
        h('div', { class: 'd-flex flex-wrap gap-2 mb-3', role: 'group', 'aria-label': '公告类型' }, categoryOptions.map((option) => h('button', {
          type: 'button',
          class: ['btn btn-sm', category.value === option.value ? 'btn-success' : 'btn-outline-success'],
          disabled: loading.value,
          onClick: () => emit('licai:fund-notice-category-change', { category: option.value }),
        }, option.label))),
        error.value ? h('div', { class: 'alert alert-danger' }, error.value) : null,
        h('div', { class: 'table-responsive' }, [
          h('table', { class: 'table table-sm table-bordered table-hover align-middle' }, [
            h('thead', { class: 'table-info' }, [h('tr', [
              h('th', '公告日期'),
              h('th', '公告类型'),
              h('th', '公告标题'),
            ])]),
            h('tbody', loading.value
              ? [h('tr', [h('td', { colSpan: 3, class: 'text-center text-muted py-4' }, '基金公告加载中...')])]
              : rows.value.length === 0
                ? [h('tr', [h('td', { colSpan: 3, class: 'text-center text-muted py-4' }, '暂无公告')])]
                : rows.value.map((row) => h('tr', { key: row.id }, [
                    h('td', { class: 'text-nowrap' }, row.publishDate),
                    h('td', { class: 'text-nowrap' }, categoryLabel(row.category)),
                    h('td', [
                      h('a', { href: row.detailUrl, target: '_blank', rel: 'noreferrer noopener' }, row.title),
                      row.pdfUrl ? h('a', { href: row.pdfUrl, target: '_blank', rel: 'noreferrer noopener', class: 'ms-2 small' }, 'PDF') : null,
                    ]),
                  ]))),
          ]),
        ]),
        totalCount.value > 0 ? h('div', { class: 'd-flex justify-content-between align-items-center' }, [
          h('span', { class: 'small text-muted' }, `共 ${totalCount.value} 条，第 ${page.value}/${totalPages} 页`),
          h('div', { class: 'btn-group btn-group-sm' }, [
            h('button', { type: 'button', class: 'btn btn-outline-secondary', disabled: loading.value || page.value <= 1, onClick: () => emit('licai:fund-notice-page-change', { page: page.value - 1 }) }, '上一页'),
            h('button', { type: 'button', class: 'btn btn-outline-secondary', disabled: loading.value || page.value >= totalPages, onClick: () => emit('licai:fund-notice-page-change', { page: page.value + 1 }) }, '下一页'),
          ]),
        ]) : null,
      ])
    }
  },
})

const root = document.getElementById('fund-notice-vue-root')
if (root) createApp(FundNoticePage).mount(root)
