import { createApp, defineComponent, h, onMounted, ref } from 'vue'
import informationProcessingLabels from '../../../config/information-processing-labels.json'

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
  information_id?: string
  entity: string
  information_type: string
  category: string
  period: string | null
  statement: string
  doc_id?: string
  title?: string
  source_name?: string | null
  source_type?: string | null
  report_type?: string | null
  published_at?: string | null
  event_time?: string | null
  processed_at?: number
}

type SourceDocument = {
  title: string | null
  url: string | null
  source_name: string | null
  source_type: string | null
  report_type: string | null
  published_at: string | null
  fetched_at: string | null
  event_time: string | null
  summary: string | null
  content_preview: string | null
  content_url: string | null
}

const outcomeLabels: Record<string, string> = {
  extracted: '已提取',
  no_information: '无可提取信息',
  needs_review: '待复核',
}

const informationTypeLabels: Record<string, string> = {
  fact: '事实', guidance: '指引', forecast: '预测', opinion: '观点', event: '事件', relationship: '关系',
}

const categoryLabels: Record<string, string> = informationProcessingLabels.categories

type InformationAggregation = { value: string, count: number }

const InformationProcessingPage = defineComponent({
  setup() {
    const activeView = ref<'browse' | 'review'>('browse')
    const entityQuery = ref('')
    const entities = ref<Array<{ name: string, count: number }>>([])
    const records = ref<InformationRecord[]>([])
    const recordPage = ref(1)
    const recordsHasNext = ref(false)
    const recordsTotal = ref(0)
    const recordsLoading = ref(false)
    const selectedInformationType = ref('')
    const selectedCategory = ref('')
    const informationTypes = ref<InformationAggregation[]>([])
    const categories = ref<InformationAggregation[]>([])
    const aggregationEntity = ref('')
    const reviewLoaded = ref(false)
    const query = ref('')
    const outcome = ref('')
    const documents = ref<ProcessedDocument[]>([])
    const selected = ref<any>(null)
    const page = ref(1)
    const hasNext = ref(false)
    const total = ref(0)
    const loading = ref(false)
    const error = ref('')

    async function loadInformationRecords(nextPage = recordPage.value) {
      recordsLoading.value = true; error.value = ''
      try {
        const params = new URLSearchParams({ page: String(nextPage), pageSize: '20' })
        if (entityQuery.value.trim()) params.set('entity', entityQuery.value.trim())
        if (selectedInformationType.value) params.set('information_type', selectedInformationType.value)
        if (selectedCategory.value) params.set('category', selectedCategory.value)
        const response = await fetch(`/api/knowledge/information-records?${params}`)
        const payload = await response.json()
        if (!response.ok || payload?.code !== 200) throw new Error(payload?.msg || '无法读取已整理信息')
        records.value = payload.data.list || []
        recordPage.value = payload.data.page || nextPage
        recordsHasNext.value = Boolean(payload.data.has_next)
        recordsTotal.value = Number(payload.data.total || 0)
        informationTypes.value = Array.isArray(payload.data.information_types) ? payload.data.information_types : []
        categories.value = Array.isArray(payload.data.categories) ? payload.data.categories : []
        aggregationEntity.value = String(payload.data.entity || '')
      } catch (cause) {
        error.value = cause instanceof Error ? cause.message : String(cause)
      } finally { recordsLoading.value = false }
    }

    async function loadEntities() {
      try {
        const response = await fetch('/api/knowledge/information-filters')
        const payload = await response.json()
        if (response.ok && payload?.code === 200) entities.value = payload.data.entities || []
      } catch { /* The typed exact-entity search remains available without suggestions. */ }
    }

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

    async function openDocument(docId: string, entity?: string) {
      try {
        const response = await fetch(`/api/knowledge/documents/${encodeURIComponent(docId)}/structured`)
        const payload = await response.json()
        if (!response.ok || payload?.code !== 200) throw new Error(payload?.msg || '无法读取提取详情')
        selected.value = { ...payload.data, visibleEntity: entity || '', originalContent: null, originalContentError: '' }
        void loadOriginalContent(payload.data)
      } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
    }

    async function loadOriginalContent(data: any) {
      const contentUrl = String(data?.document?.content_url || '').trim()
      if (!contentUrl) return
      try {
        const response = await fetch(contentUrl, { credentials: 'omit', cache: 'reload' })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const originalContent = await response.text()
        if (selected.value === null || selected.value.document?.content_url !== contentUrl) return
        selected.value = { ...selected.value, originalContent }
      } catch (cause) {
        if (selected.value === null || selected.value.document?.content_url !== contentUrl) return
        const detail = cause instanceof Error ? cause.message : String(cause)
        selected.value = { ...selected.value, originalContentError: `原文正文加载失败：${detail}` }
      }
    }

    function switchView(view: 'browse' | 'review') {
      activeView.value = view
      if (view === 'review' && !reviewLoaded.value) {
        reviewLoaded.value = true
        void loadDocuments(1)
      }
    }

    onMounted(() => {
      void loadInformationRecords(1)
      void loadEntities()
    })
    return () => h('main', { class: 'container py-4', style: 'max-width:1100px' }, [
      h('div', { class: 'mb-4' }, [
        h('h1', { class: 'h3 mb-2' }, '信息整理'),
        h('p', { class: 'text-secondary mb-0' }, '查看已经整理出的信息条目，或复核单篇原文的处理结果。'),
      ]),
      h('div', { class: 'btn-group mb-3', role: 'group', 'aria-label': '信息整理视图' }, [
        h('button', { class: `btn ${activeView.value === 'browse' ? 'btn-primary' : 'btn-outline-primary'}`, onClick: () => switchView('browse') }, '信息查看'),
        h('button', { class: `btn ${activeView.value === 'review' ? 'btn-primary' : 'btn-outline-primary'}`, onClick: () => switchView('review') }, '处理复核'),
      ]),
      activeView.value === 'browse' ? renderInformationBrowse({
        entityQuery, entities, records, recordPage, recordsHasNext, recordsTotal, recordsLoading, selectedInformationType, selectedCategory, informationTypes, categories, aggregationEntity,
        load: (nextPage?: number) => { void loadInformationRecords(nextPage) },
        search: () => {
          selectedInformationType.value = ''
          selectedCategory.value = ''
          void loadInformationRecords(1)
        },
        selectInformationType: (value: string) => {
          selectedInformationType.value = selectedInformationType.value === value ? '' : value
          void loadInformationRecords(1)
        },
        selectCategory: (value: string) => {
          selectedCategory.value = selectedCategory.value === value ? '' : value
          void loadInformationRecords(1)
        },
        open: (docId: string, entity: string) => { void openDocument(docId, entity) },
      }) : renderProcessingReview({ query, outcome, documents, page, hasNext, total, loading, load: (nextPage?: number) => { void loadDocuments(nextPage) }, open: (docId: string) => { void openDocument(docId) } }),
      error.value ? h('div', { class: 'alert alert-danger mt-3' }, error.value) : null,
      selected.value ? renderDetail(selected.value, () => { selected.value = null }) : null,
    ])
  },
})

function renderInformationBrowse(state: {
  entityQuery: { value: string }
  entities: { value: Array<{ name: string, count: number }> }
  records: { value: InformationRecord[] }
  recordPage: { value: number }
  recordsHasNext: { value: boolean }
  recordsTotal: { value: number }
  recordsLoading: { value: boolean }
  selectedInformationType: { value: string }
  selectedCategory: { value: string }
  informationTypes: { value: InformationAggregation[] }
  categories: { value: InformationAggregation[] }
  aggregationEntity: { value: string }
  load: (nextPage?: number) => void
  search: () => void
  selectInformationType: (value: string) => void
  selectCategory: (value: string) => void
  open: (docId: string, entity: string) => void
}) {
  return h('section', [
    h('form', { class: 'row g-2 align-items-end mb-3', onSubmit: (event: Event) => { event.preventDefault(); state.search() } }, [
      h('label', { class: 'col-md-9 form-label' }, ['公司主体', h('input', { class: 'form-control mt-1', list: 'information-entity-options', value: state.entityQuery.value, placeholder: '输入已提取的公司主体，如：中际旭创', onInput: (event: Event) => { state.entityQuery.value = (event.target as HTMLInputElement).value } }), h('div', { class: 'form-text' }, '按提取记录的主体精确匹配，只展示该主体的条目。')]),
      h('div', { class: 'col-md-3' }, h('button', { class: 'btn btn-primary w-100', disabled: state.recordsLoading.value }, state.recordsLoading.value ? '查询中…' : '查询信息')),
    ]),
    h('datalist', { id: 'information-entity-options' }, state.entities.value.map((item) => h('option', { value: item.name }, `${item.name}（${item.count}）`))),
    state.entityQuery.value.trim() && state.aggregationEntity.value === state.entityQuery.value.trim() ? renderInformationAggregation(state) : null,
    h('div', { class: 'd-flex justify-content-between align-items-center mb-2' }, [h('h2', { class: 'h5 mb-0' }, state.entityQuery.value.trim() ? `${state.entityQuery.value.trim()} 的信息条目` : '最新信息条目'), h('small', { class: 'text-secondary' }, `共 ${state.recordsTotal.value} 条`)]),
    state.records.value.length === 0 && !state.recordsLoading.value
      ? h('div', { class: 'alert alert-info' }, state.entityQuery.value.trim() ? '没有找到该主体的已提取条目。请从下拉建议中选择完整主体名称。' : '暂无已整理的信息条目。')
      : h('div', { class: 'vstack gap-2 mb-3' }, state.records.value.map((record) => renderBrowseRecord(record, state.open))),
    h('div', { class: 'd-flex gap-2 mb-5' }, [
      h('button', { class: 'btn btn-outline-secondary btn-sm', disabled: state.recordPage.value <= 1 || state.recordsLoading.value, onClick: () => state.load(state.recordPage.value - 1) }, '上一页'),
      h('button', { class: 'btn btn-outline-secondary btn-sm', disabled: !state.recordsHasNext.value || state.recordsLoading.value, onClick: () => state.load(state.recordPage.value + 1) }, '下一页'),
    ]),
  ])
}

function renderInformationAggregation(state: {
  selectedInformationType: { value: string }
  selectedCategory: { value: string }
  informationTypes: { value: InformationAggregation[] }
  categories: { value: InformationAggregation[] }
  recordsLoading: { value: boolean }
  selectInformationType: (value: string) => void
  selectCategory: (value: string) => void
}) {
  const filterButton = (label: string, count: number, active: boolean, onClick: () => void) => h('button', {
    type: 'button',
    class: `btn btn-sm ${active ? 'btn-primary' : 'btn-outline-secondary'}`,
    disabled: state.recordsLoading.value,
    onClick,
  }, `${label} ${count}`)
  return h('section', { class: 'border rounded p-3 bg-light mb-3' }, [
    h('div', { class: 'd-flex justify-content-between align-items-center gap-2 mb-2' }, [
      h('h2', { class: 'h6 mb-0' }, '聚合概览'),
      h('small', { class: 'text-secondary' }, '全量统计；点击标签筛选'),
    ]),
    h('div', { class: 'mb-2' }, [
      h('div', { class: 'small text-secondary mb-1' }, '类型'),
      h('div', { class: 'd-flex flex-wrap gap-2' }, state.informationTypes.value.map((item) => filterButton(informationTypeLabels[item.value] || item.value, Number(item.count || 0), state.selectedInformationType.value === item.value, () => state.selectInformationType(item.value)))),
    ]),
    h('div', [
      h('div', { class: 'small text-secondary mb-1' }, '分类'),
      h('div', { class: 'd-flex flex-wrap gap-2' }, state.categories.value.map((item) => filterButton(categoryLabels[item.value] || item.value, Number(item.count || 0), state.selectedCategory.value === item.value, () => state.selectCategory(item.value)))),
    ]),
  ])
}

function renderBrowseRecord(record: InformationRecord, open: (docId: string, entity: string) => void) {
  const source = [record.source_name, record.report_type || record.source_type, record.published_at ? formatSourceTime(record.published_at) : ''].filter(Boolean).join(' · ')
  return h('article', { class: 'border rounded p-3 bg-light' }, [
    h('div', { class: 'd-flex justify-content-between align-items-start gap-3' }, [
      h('div', { class: 'flex-grow-1' }, [renderRecord(record, false), source ? h('p', { class: 'small text-secondary mb-0 mt-2' }, source) : null, record.title ? h('p', { class: 'small text-secondary mb-0 text-break' }, `来源：${record.title}`) : null]),
      record.doc_id ? h('button', { class: 'btn btn-sm btn-outline-primary flex-shrink-0', onClick: () => open(record.doc_id!, record.entity) }, '查看来源') : null,
    ]),
  ])
}

function renderProcessingReview(state: {
  query: { value: string }
  outcome: { value: string }
  documents: { value: ProcessedDocument[] }
  page: { value: number }
  hasNext: { value: boolean }
  total: { value: number }
  loading: { value: boolean }
  load: (nextPage?: number) => void
  open: (docId: string) => void
}) {
  return h('section', [
      h('form', { class: 'row g-2 align-items-end mb-3', onSubmit: (event: Event) => { event.preventDefault(); state.load(1) } }, [
        h('label', { class: 'col-md-7 form-label' }, ['搜索', h('input', { class: 'form-control mt-1', value: state.query.value, placeholder: '标题、对象、主题或陈述', onInput: (event: Event) => { state.query.value = (event.target as HTMLInputElement).value } })]),
        h('label', { class: 'col-md-3 form-label' }, ['处理结果', h('select', { class: 'form-select mt-1', value: state.outcome.value, onChange: (event: Event) => { state.outcome.value = (event.target as HTMLSelectElement).value } }, [
          h('option', { value: '' }, '全部'), ...Object.entries(outcomeLabels).map(([value, label]) => h('option', { value }, label)),
        ])]),
        h('div', { class: 'col-md-2' }, h('button', { class: 'btn btn-primary w-100', disabled: state.loading.value }, state.loading.value ? '筛选中…' : '筛选')),
      ]),
      h('div', { class: 'd-flex justify-content-between align-items-center mb-2' }, [h('h2', { class: 'h5 mb-0' }, '处理记录'), h('small', { class: 'text-secondary' }, `共 ${state.total.value} 条`)]),
      state.documents.value.length === 0 && !state.loading.value ? h('div', { class: 'alert alert-info' }, '暂无符合条件的处理记录。')
        : h('div', { class: 'list-group mb-3' }, state.documents.value.map((item) => h('article', { class: 'list-group-item' }, [
          h('div', { class: 'd-flex justify-content-between gap-3' }, [
            h('div', { class: 'flex-grow-1' }, [h('h3', { class: 'h6 mb-1' }, item.title), h('p', { class: 'mb-1 text-secondary small' }, `${Number(item.record_count || 0)} 条信息记录`), h('small', { class: 'text-secondary' }, formatTime(item.processed_at))]),
            h('div', { class: 'text-end flex-shrink-0' }, [h('span', { class: 'badge text-bg-secondary d-block mb-2' }, outcomeLabels[item.outcome] || item.outcome), h('button', { class: 'btn btn-sm btn-outline-primary', onClick: () => state.open(item.doc_id) }, '查看详情')]),
          ]),
        ]))),
      h('div', { class: 'd-flex gap-2 mb-5' }, [h('button', { class: 'btn btn-outline-secondary btn-sm', disabled: state.page.value <= 1 || state.loading.value, onClick: () => state.load(state.page.value - 1) }, '上一页'), h('button', { class: 'btn btn-outline-secondary btn-sm', disabled: !state.hasNext.value || state.loading.value, onClick: () => state.load(state.page.value + 1) }, '下一页')]),
  ])
}

function renderDetail(data: any, close: () => void) {
  const result = data.result || {}
  const visibleEntity = String(data.visibleEntity || '').trim()
  const records = (Array.isArray(data.records) ? data.records as InformationRecord[] : []).filter((record) => !visibleEntity || record.entity === visibleEntity)
  const document = (data.document || null) as SourceDocument | null
  const originalContent = typeof data.originalContent === 'string' ? data.originalContent : null
  const originalContentError = String(data.originalContentError || '')
  return h('div', [
    h('div', { class: 'modal fade show', style: 'display:block', tabindex: '-1', role: 'dialog', 'aria-modal': 'true' }, [h('div', { class: 'modal-dialog modal-xl modal-dialog-scrollable' }, [h('div', { class: 'modal-content' }, [
      h('div', { class: 'modal-header' }, [h('h2', { class: 'modal-title fs-5' }, visibleEntity ? `${visibleEntity} 的来源信息` : '信息提取详情'), h('button', { type: 'button', class: 'btn-close', 'aria-label': '关闭', onClick: close })]),
      h('div', { class: 'modal-body' }, [
        document ? renderSourceDocument(document, result, originalContent, originalContentError) : null,
        h('p', { class: 'small text-secondary mt-3' }, `处理结果：${outcomeLabels[result.outcome] || result.outcome || '-'}`),
        h('h3', { class: 'h6 mt-3' }, visibleEntity ? `该主体的信息记录（${records.length}）` : `信息记录（${records.length}）`),
        records.length ? h('div', { class: 'vstack gap-2' }, records.map(renderRecord)) : h('p', { class: 'small text-secondary mb-0' }, result.outcome === 'no_information' ? '该原文没有可提取的信息。' : '没有可展示的信息记录。'),
      ]),
    ])])]), h('div', { class: 'modal-backdrop fade show' }),
  ])
}

function renderSourceDocument(document: SourceDocument, result: any, originalContent: string | null, originalContentError: string) {
  const times = [
    document.published_at ? `发布时间：${formatSourceTime(document.published_at)}` : '',
    document.event_time ? `事件时间：${formatSourceTime(document.event_time)}` : '',
    document.fetched_at ? `抓取时间：${formatSourceTime(document.fetched_at)}` : '',
    result.created_at ? `提取时间：${formatTime(result.created_at)}` : '',
  ].filter(Boolean)
  const sourceMeta = [document.source_name, document.report_type || document.source_type].filter(Boolean).join(' · ')
  return h('section', { class: 'border rounded p-3 bg-light' }, [
    h('h3', { class: 'h6 mb-1' }, '原始文档'),
    h('p', { class: 'mb-1 fw-semibold text-break' }, document.title || '未提供标题'),
    sourceMeta ? h('p', { class: 'small text-secondary mb-1' }, sourceMeta) : null,
    times.length ? h('p', { class: 'small text-secondary mb-2' }, times.join(' · ')) : null,
    document.url ? h('a', { class: 'small', href: document.url, target: '_blank', rel: 'noreferrer noopener' }, '打开来源原文') : null,
    document.summary ? h('p', { class: 'small mb-2 mt-2 text-break' }, `摘要：${document.summary}`) : null,
    h('h4', { class: 'h6 mt-3 mb-2' }, '原文正文（缓存内容）'),
    originalContent !== null
      ? h('pre', { class: 'mb-0 p-3 border rounded bg-white text-break', style: 'white-space:pre-wrap; max-height:420px; overflow:auto' }, originalContent)
      : originalContentError
        ? h('p', { class: 'small text-danger mb-0' }, originalContentError)
        : document.content_preview
          ? h('p', { class: 'small mb-0 text-break' }, document.content_preview)
          : h('p', { class: 'small text-secondary mb-0' }, document.content_url ? '原文正文加载中…' : '没有已缓存的原文正文。'),
  ])
}

function renderRecord(record: InformationRecord, showEntity = true) {
  const meta = [showEntity && record.entity ? `对象：${record.entity}` : '', informationTypeLabels[record.information_type] || record.information_type, record.category ? `主题：${record.category}` : '', record.period ? `期间：${record.period}` : ''].filter(Boolean).join(' · ')
  return h('article', { class: 'border rounded p-3 bg-light' }, [h('p', { class: 'small text-secondary mb-2' }, meta), h('p', { class: 'mb-0 text-break' }, record.statement || '未提供陈述文本')])
}

function formatTime(value: unknown): string {
  const timestamp = Number(value)
  return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toLocaleString('zh-CN') : '-'
}

function formatSourceTime(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return '-'
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed
  const timestamp = Date.parse(trimmed)
  return Number.isNaN(timestamp) ? trimmed.replace('T', ' ').replace(/\.\d+/, '').replace(/Z$/, '') : formatTime(timestamp)
}

const root = document.getElementById('information-processing-vue-root')
if (root) createApp(InformationProcessingPage).mount(root)
