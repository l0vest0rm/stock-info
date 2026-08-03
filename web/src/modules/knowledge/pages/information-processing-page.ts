import { createApp, defineComponent, h, onMounted, ref } from 'vue'

type ProcessedDocument = {
  doc_id: string
  title: string
  source_name: string | null
  source_type: string
  report_type: string | null
  published_at: string | null
  outcome: string
  record_count: number
  processed_at: number
}

type InformationRecord = {
  entity: string
  information_type: string
  category: string
  period: string | null
  statement: string
}

const outcomeLabels: Record<string, string> = {
  extracted: '已提取',
  no_information: '无可提取信息',
  needs_review: '待复核',
}

const informationTypeLabels: Record<string, string> = {
  fact: '事实', guidance: '指引', forecast: '预测', opinion: '观点', event: '事件', relationship: '关系',
}

const InformationProcessingPage = defineComponent({
  setup() {
    const query = ref('')
    const outcome = ref('')
    const documents = ref<ProcessedDocument[]>([])
    const selected = ref<any>(null)
    const page = ref(1)
    const hasNext = ref(false)
    const total = ref(0)
    const loading = ref(false)
    const error = ref('')

    async function loadDocuments(nextPage = page.value) {
      loading.value = true; error.value = ''
      try {
        const params = new URLSearchParams({ page: String(nextPage), pageSize: '20' })
        if (query.value.trim()) params.set('q', query.value.trim())
        if (outcome.value) params.set('outcome', outcome.value)
        const response = await fetch(`/api/knowledge/processed-documents?${params}`)
        const payload = await response.json()
        if (!response.ok || payload?.code !== 200) throw new Error(payload?.msg || '无法读取已处理信息')
        documents.value = payload.data.list || []
        page.value = payload.data.page || nextPage
        hasNext.value = Boolean(payload.data.has_next)
        total.value = Number(payload.data.total || 0)
      } catch (cause) {
        error.value = cause instanceof Error ? cause.message : String(cause)
      } finally { loading.value = false }
    }

    async function openDocument(docId: string) {
      try {
        const response = await fetch(`/api/knowledge/documents/${encodeURIComponent(docId)}/structured`)
        const payload = await response.json()
        if (!response.ok || payload?.code !== 200) throw new Error(payload?.msg || '无法读取提取详情')
        selected.value = payload.data
      } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
    }

    onMounted(() => { void loadDocuments(1) })
    return () => h('main', { class: 'container py-4', style: 'max-width:1100px' }, [
      h('div', { class: 'mb-4' }, [
        h('h1', { class: 'h3 mb-2' }, '信息提取'),
        h('p', { class: 'text-secondary mb-0' }, '每篇原文只提取可复用的信息记录：主体、信息性质、主题、期间和简明陈述。'),
      ]),
      h('form', { class: 'row g-2 align-items-end mb-3', onSubmit: (event: Event) => { event.preventDefault(); void loadDocuments(1) } }, [
        h('label', { class: 'col-md-7 form-label' }, ['搜索', h('input', { class: 'form-control mt-1', value: query.value, placeholder: '标题、对象、主题或陈述', onInput: (event: Event) => { query.value = (event.target as HTMLInputElement).value } })]),
        h('label', { class: 'col-md-3 form-label' }, ['处理结果', h('select', { class: 'form-select mt-1', value: outcome.value, onChange: (event: Event) => { outcome.value = (event.target as HTMLSelectElement).value } }, [
          h('option', { value: '' }, '全部'), ...Object.entries(outcomeLabels).map(([value, label]) => h('option', { value }, label)),
        ])]),
        h('div', { class: 'col-md-2' }, h('button', { class: 'btn btn-primary w-100', disabled: loading.value }, loading.value ? '筛选中…' : '筛选')),
      ]),
      error.value ? h('div', { class: 'alert alert-danger' }, error.value) : null,
      h('div', { class: 'd-flex justify-content-between align-items-center mb-2' }, [h('h2', { class: 'h5 mb-0' }, '处理记录'), h('small', { class: 'text-secondary' }, `共 ${total.value} 条`)]),
      documents.value.length === 0 && !loading.value ? h('div', { class: 'alert alert-info' }, '暂无符合条件的处理记录。')
        : h('div', { class: 'list-group mb-3' }, documents.value.map((item) => h('article', { class: 'list-group-item' }, [
          h('div', { class: 'd-flex justify-content-between gap-3' }, [
            h('div', { class: 'flex-grow-1' }, [h('h3', { class: 'h6 mb-1' }, item.title), h('p', { class: 'mb-1 text-secondary small' }, `${Number(item.record_count || 0)} 条信息记录`), h('small', { class: 'text-secondary' }, formatTime(item.processed_at))]),
            h('div', { class: 'text-end flex-shrink-0' }, [h('span', { class: 'badge text-bg-secondary d-block mb-2' }, outcomeLabels[item.outcome] || item.outcome), h('button', { class: 'btn btn-sm btn-outline-primary', onClick: () => { void openDocument(item.doc_id) } }, '查看详情')]),
          ]),
        ]))),
      h('div', { class: 'd-flex gap-2 mb-5' }, [h('button', { class: 'btn btn-outline-secondary btn-sm', disabled: page.value <= 1 || loading.value, onClick: () => { void loadDocuments(page.value - 1) } }, '上一页'), h('button', { class: 'btn btn-outline-secondary btn-sm', disabled: !hasNext.value || loading.value, onClick: () => { void loadDocuments(page.value + 1) } }, '下一页')]),
      selected.value ? renderDetail(selected.value, () => { selected.value = null }) : null,
    ])
  },
})

function renderDetail(data: any, close: () => void) {
  const result = data.result || {}
  const records = Array.isArray(data.records) ? data.records as InformationRecord[] : []
  return h('div', [
    h('div', { class: 'modal fade show', style: 'display:block', tabindex: '-1', role: 'dialog', 'aria-modal': 'true' }, [h('div', { class: 'modal-dialog modal-xl modal-dialog-scrollable' }, [h('div', { class: 'modal-content' }, [
      h('div', { class: 'modal-header' }, [h('h2', { class: 'modal-title fs-5' }, '信息提取详情'), h('button', { type: 'button', class: 'btn-close', 'aria-label': '关闭', onClick: close })]),
      h('div', { class: 'modal-body' }, [
        h('p', { class: 'small text-secondary' }, `处理结果：${outcomeLabels[result.outcome] || result.outcome || '-'}`),
        h('h3', { class: 'h6 mt-3' }, `信息记录（${records.length}）`),
        records.length ? h('div', { class: 'vstack gap-2' }, records.map(renderRecord)) : h('p', { class: 'small text-secondary mb-0' }, result.outcome === 'no_information' ? '该原文没有可提取的信息。' : '没有可展示的信息记录。'),
      ]),
    ])])]), h('div', { class: 'modal-backdrop fade show' }),
  ])
}

function renderRecord(record: InformationRecord) {
  const meta = [record.entity ? `对象：${record.entity}` : '', informationTypeLabels[record.information_type] || record.information_type, record.category ? `主题：${record.category}` : '', record.period ? `期间：${record.period}` : ''].filter(Boolean).join(' · ')
  return h('article', { class: 'border rounded p-3 bg-light' }, [h('p', { class: 'small text-secondary mb-2' }, meta), h('p', { class: 'mb-0 text-break' }, record.statement || '未提供陈述文本')])
}

function formatTime(value: unknown): string {
  const timestamp = Number(value)
  return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toLocaleString('zh-CN') : '-'
}

const root = document.getElementById('information-processing-vue-root')
if (root) createApp(InformationProcessingPage).mount(root)
