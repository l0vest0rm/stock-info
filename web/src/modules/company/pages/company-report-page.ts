import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue'
import { knowledgeDocModalStyles } from '../../knowledge/runtime/knowledge-doc-modal'

const companyReportStyles = `
${knowledgeDocModalStyles}

.company-report-discovery-actions {
  flex: 0 0 auto;
}

.company-report-discovery-trigger {
  white-space: nowrap;
}

.company-report-discovery-effort {
  flex: 0 0 5.5rem;
  width: 5.5rem;
}
`

type CompanyReportRow = {
  rank: number
  publishDate: string
  title: string
  provenance: string
  reportHref: string
  reportInfoCode: string
  docId: string
  revenue2025: string
  revenueGrowth2025: string
  profit2025: string
  profitMargin2025: string
  growth2025: string
  profitEstimated2025: boolean
  pe2025: string
  revenue2026: string
  revenueGrowth2026: string
  profit2026: string
  profitMargin2026: string
  growth2026: string
  profitEstimated2026: boolean
  pe2026: string
  revenue2027: string
  revenueGrowth2027: string
  profit2027: string
  profitMargin2027: string
  growth2027: string
  profitEstimated2027: boolean
  pe2027: string
  revenue2028: string
  revenueGrowth2028: string
  profit2028: string
  profitMargin2028: string
  growth2028: string
  profitEstimated2028: boolean
  pe2028: string
  valuation: string
  targetPrice: string
  orgName: string
  pages: string
  llmRawResponse?: unknown | null
}

function companyReportProvenanceLabel(value: unknown): string {
  return String(value || '').trim().toLowerCase() === 'web_search' ? '搜索发现' : '既有来源'
}

function companyReportRawResponseTitle(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined
  }
  if (value === null) {
    return '模型原始返回：未找到该报告对应的完整模型输出（任务或 artifact 缺失）'
  }
  let rendered = ''
  try {
    rendered = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  } catch {
    rendered = String(value)
  }
  return `模型原始返回：\n${rendered || '（空）'}`
}

type CompanyReportStateEvent = CustomEvent<{
  rows?: CompanyReportRow[]
  currentPage?: number
  hasNext?: boolean
  status?: string
  error?: boolean
  discoveryEnabled?: boolean
  discoveryTaskId?: string | null
  discoveryStatus?: string
  discoveryMessage?: string
  discoveryBusy?: boolean
  discoveryCreatedAt?: number | null
  discoveryStartedAt?: number | null
  discoveryCompletedAt?: number | null
  discoveryUpdatedAt?: number | null
  discoveryLastSuccessfulAt?: number | null
  discoveryModel?: string | null
  discoveryReasoningEffort?: string | null
}>

function emitCompanyReportPageChange(page: number) {
  window.dispatchEvent(new CustomEvent('licai:company-report-page-change', {
    detail: { page },
  }))
}

function emitCompanyReportOpenDoc(docId: string) {
  window.dispatchEvent(new CustomEvent('licai:company-report-open-doc', {
    detail: { docId },
  }))
}

type CompanyReportDiscoveryReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'pro'

const companyReportDiscoveryReasoningOptions: Array<{ value: CompanyReportDiscoveryReasoningEffort, label: string }> = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '超高' },
  { value: 'pro', label: '专业' },
]

function emitCompanyReportDiscovery(reasoningEffort: CompanyReportDiscoveryReasoningEffort = 'xhigh') {
  window.dispatchEvent(new CustomEvent('licai:company-report-discover', {
    detail: { reasoningEffort },
  }))
}

function formatCompanyReportElapsedSeconds(value: number): string {
  const totalSeconds = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0))
  const seconds = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  const minutes = totalMinutes % 60
  const hours = Math.floor(totalMinutes / 60)
  const pad = (part: number) => String(part).padStart(2, '0')
  return hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(totalMinutes)}:${pad(seconds)}`
}

function formatCompanyReportDiscoveryExecution(model: unknown, reasoningEffort: unknown): string {
  const modelText = typeof model === 'string' ? model.trim() : ''
  const effortText = typeof reasoningEffort === 'string' ? reasoningEffort.trim() : ''
  return [
    modelText ? `模型 ${modelText}` : '',
    effortText ? `推理 ${effortText}` : '',
  ].filter(Boolean).join('，')
}

function formatCompanyReportDiscoveryTimestamp(value: number | null): string {
  if (!Number.isFinite(value)) {
    return ''
  }
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(value))
  const pick = (type: string) => parts.find((part) => part.type === type)?.value || ''
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}:${pick('second')}`
}

function growthTitle(label: string, growth: string): string {
  return `${label}同比增速：${growth === '-' ? '暂无' : `${growth}%`}`
}

function profitTitle(growth: string, margin: string, computed: boolean): string {
  return [
    computed ? '净利润按研报 EPS × 当前总股本推算' : '',
    growthTitle('净利润', growth),
    margin,
  ].filter(Boolean).join('；')
}

function growthCell(value: string, growth: string) {
  return [
    h('div', value),
    h('div', { class: 'small text-muted' }, growth === '-' ? '同比暂无' : `同比 ${growth}%`),
  ]
}

function companyReportPagination(currentPage: number, hasNext: boolean) {
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

const CompanyReportPage = defineComponent({
  name: 'CompanyReportPage',
  setup() {
    const rows = ref<CompanyReportRow[]>([])
    const currentPage = ref(1)
    const hasNext = ref(false)
    const statusText = ref('加载公司研报中...')
    const statusDanger = ref(false)
    const discoveryEnabled = ref(false)
    const discoveryTaskId = ref<string | null>(null)
    const discoveryStatus = ref('idle')
    const discoveryMessage = ref('')
    const discoveryBusy = ref(false)
    const discoveryElapsedSeconds = ref(0)
    const discoveryElapsedStartAt = ref<number | null>(null)
    const discoveryElapsedEndAt = ref<number | null>(null)
    const discoveryLastSuccessfulAt = ref<number | null>(null)
    const discoveryModel = ref<string | null>(null)
    const discoveryReasoningEffort = ref<string | null>(null)
    const selectedDiscoveryReasoningEffort = ref<CompanyReportDiscoveryReasoningEffort>('xhigh')
    let discoveryElapsedTimer: number | null = null

    const clearDiscoveryElapsedTimer = () => {
      if (discoveryElapsedTimer !== null) {
        window.clearInterval(discoveryElapsedTimer)
        discoveryElapsedTimer = null
      }
    }

    const updateDiscoveryElapsed = () => {
      const startAt = discoveryElapsedStartAt.value
      if (!Number.isFinite(startAt)) {
        discoveryElapsedSeconds.value = 0
        return
      }
      const endAt = discoveryBusy.value ? Date.now() : discoveryElapsedEndAt.value || Date.now()
      discoveryElapsedSeconds.value = Math.max(0, Math.floor((endAt - startAt) / 1000))
    }

    const syncDiscoveryElapsedTimer = () => {
      if (!discoveryEnabled.value || !discoveryBusy.value || !Number.isFinite(discoveryElapsedStartAt.value)) {
        clearDiscoveryElapsedTimer()
        updateDiscoveryElapsed()
        return
      }
      updateDiscoveryElapsed()
      if (discoveryElapsedTimer === null) {
        discoveryElapsedTimer = window.setInterval(updateDiscoveryElapsed, 1000)
      }
    }

    const optionalTimestamp = (value: unknown): number | null => {
      if (value === null || value === undefined || value === '') {
        return null
      }
      const parsed = typeof value === 'number' ? value : Number(value)
      return Number.isFinite(parsed) ? parsed : null
    }

    const onState = (event: Event) => {
      const detail = (event as CompanyReportStateEvent).detail
      if (!detail) {
        return
      }
      const wasBusy = discoveryBusy.value
      const wasTaskId = discoveryTaskId.value
      if (Array.isArray(detail.rows)) {
        rows.value = detail.rows
      }
      if (typeof detail.currentPage === 'number' && Number.isFinite(detail.currentPage)) {
        currentPage.value = detail.currentPage
      }
      if (typeof detail.status === 'string') {
        statusText.value = detail.status
      }
      if (typeof detail.error === 'boolean') {
        statusDanger.value = detail.error
      }
      if (typeof detail.hasNext === 'boolean') {
        hasNext.value = detail.hasNext
      }
      if (typeof detail.discoveryEnabled === 'boolean') {
        discoveryEnabled.value = detail.discoveryEnabled
      }
      if (detail.discoveryTaskId !== undefined) {
        discoveryTaskId.value = typeof detail.discoveryTaskId === 'string' ? detail.discoveryTaskId : null
      }
      if (typeof detail.discoveryStatus === 'string') {
        discoveryStatus.value = detail.discoveryStatus
      }
      if (typeof detail.discoveryMessage === 'string') {
        discoveryMessage.value = detail.discoveryMessage
      }
      if (typeof detail.discoveryBusy === 'boolean') {
        discoveryBusy.value = detail.discoveryBusy
      }
      if (detail.discoveryLastSuccessfulAt !== undefined) {
        discoveryLastSuccessfulAt.value = optionalTimestamp(detail.discoveryLastSuccessfulAt)
      }
      if (detail.discoveryModel !== undefined) {
        discoveryModel.value = typeof detail.discoveryModel === 'string' ? detail.discoveryModel : null
      }
      if (detail.discoveryReasoningEffort !== undefined) {
        discoveryReasoningEffort.value = typeof detail.discoveryReasoningEffort === 'string' ? detail.discoveryReasoningEffort : null
      }

      const hasDiscoveryPatch = detail.discoveryEnabled !== undefined
        || detail.discoveryTaskId !== undefined
        || detail.discoveryStatus !== undefined
        || detail.discoveryMessage !== undefined
        || detail.discoveryBusy !== undefined
        || detail.discoveryCreatedAt !== undefined
        || detail.discoveryStartedAt !== undefined
        || detail.discoveryCompletedAt !== undefined
        || detail.discoveryUpdatedAt !== undefined
        || detail.discoveryLastSuccessfulAt !== undefined
        || detail.discoveryModel !== undefined
        || detail.discoveryReasoningEffort !== undefined
      if (!hasDiscoveryPatch) {
        return
      }

      const statusBusy = ['queued', 'running'].includes(discoveryStatus.value)
      const nextBusy = typeof detail.discoveryBusy === 'boolean' ? detail.discoveryBusy : statusBusy
      const createdAt = optionalTimestamp(detail.discoveryCreatedAt)
      const startedAt = optionalTimestamp(detail.discoveryStartedAt)
      const completedAt = optionalTimestamp(detail.discoveryCompletedAt)
      const updatedAt = optionalTimestamp(detail.discoveryUpdatedAt)
      const terminal = ['completed', 'failed', 'blocked'].includes(discoveryStatus.value)
      const timingStart = terminal
        ? startedAt || discoveryElapsedStartAt.value || createdAt
        : startedAt || updatedAt || createdAt
      if (timingStart !== null) {
        discoveryElapsedStartAt.value = timingStart
      } else if (nextBusy && (!wasBusy || wasTaskId !== discoveryTaskId.value || discoveryElapsedStartAt.value === null)) {
        // The click dispatches a busy state before the POST response has a
        // durable timestamp. Replace this fallback with task timestamps as
        // soon as the queued task is returned.
        discoveryElapsedStartAt.value = Date.now()
      }
      if (!nextBusy) {
        discoveryElapsedEndAt.value = completedAt || updatedAt || Date.now()
      } else {
        discoveryElapsedEndAt.value = null
      }
      syncDiscoveryElapsedTimer()
    }

    onMounted(() => {
      window.addEventListener('licai:company-report-state', onState)
    })

    onBeforeUnmount(() => {
      window.removeEventListener('licai:company-report-state', onState)
      clearDiscoveryElapsedTimer()
    })

    const pagination = () => {
      if (currentPage.value === 1 && rows.value.length === 0) {
        return null
      }
      return h('nav', { id: 'companyReport-nav' }, [
        h('ul', { class: 'pagination justify-content-center' }, companyReportPagination(currentPage.value, hasNext.value).map((item) => (
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
                emitCompanyReportPageChange(item.page)
              },
            }, item.label),
          ])
        ))),
      ])
    }

    return () => h('div', [
      h('style', companyReportStyles),
      h('div', { class: 'd-flex justify-content-between align-items-center gap-2 mb-2 flex-wrap' }, [
        h('div', {
          id: 'companyReportStatus',
          class: `small ${statusDanger.value ? 'text-danger' : 'text-muted'}`,
        }, statusText.value),
        discoveryEnabled.value
          ? h('div', { class: 'd-flex flex-wrap align-items-center justify-content-end gap-2 flex-shrink-0' }, [
            h('div', { class: 'company-report-discovery-actions d-flex align-items-center gap-2' }, [
              h('button', {
                type: 'button',
                class: 'btn btn-sm btn-outline-primary company-report-discovery-trigger',
                disabled: discoveryBusy.value,
                onClick: () => emitCompanyReportDiscovery(selectedDiscoveryReasoningEffort.value),
              }, discoveryBusy.value
                ? '正在搜索近期研报…'
                : discoveryStatus.value === 'completed' ? '再次搜索研报' : '搜索近期研报'),
              h('select', {
                class: 'form-select form-select-sm company-report-discovery-effort',
                'aria-label': '近期研报搜索推理深度',
                value: selectedDiscoveryReasoningEffort.value,
                disabled: discoveryBusy.value,
                onChange: (event: Event) => {
                  const value = (event.target as HTMLSelectElement).value
                  if (companyReportDiscoveryReasoningOptions.some((option) => option.value === value)) {
                    selectedDiscoveryReasoningEffort.value = value as CompanyReportDiscoveryReasoningEffort
                  }
                },
              }, companyReportDiscoveryReasoningOptions.map((option) => h('option', { value: option.value }, option.label))),
            ]),
            discoveryLastSuccessfulAt.value !== null
              ? h('span', { class: 'small text-muted' }, `上次成功：${formatCompanyReportDiscoveryTimestamp(discoveryLastSuccessfulAt.value)}`)
              : null,
            discoveryMessage.value
              ? h('span', {
                class: `small ${['failed', 'blocked'].includes(discoveryStatus.value) ? 'text-danger' : 'text-muted'}`,
              }, [
                discoveryMessage.value,
                formatCompanyReportDiscoveryExecution(discoveryModel.value, discoveryReasoningEffort.value),
                discoveryElapsedStartAt.value !== null && !discoveryBusy.value && ['completed', 'failed', 'blocked'].includes(discoveryStatus.value)
                  ? `用时 ${formatCompanyReportElapsedSeconds(discoveryElapsedSeconds.value)}`
                  : discoveryBusy.value
                    ? `已用时 ${formatCompanyReportElapsedSeconds(discoveryElapsedSeconds.value)}`
                    : '',
              ].filter(Boolean).join('；'))
              : null,
          ])
          : null,
      ]),
      h('div', { class: 'table-responsive' }, [
        h('table', { id: 'companyReport', class: 'table table-sm table-bordered table-hover text-nowrap' }, [
          h('thead', { class: 'table-info' }, [
            h('tr', [
              h('th', { scope: 'col' }, '编号'),
              h('th', { scope: 'col' }, '日期'),
              h('th', { scope: 'col' }, '报告名称'),
              h('th', { scope: 'col' }, '来源'),
              h('th', { scope: 'col' }, '2025营收'),
              h('th', { scope: 'col' }, '2025净利润'),
              h('th', { scope: 'col' }, '2025PE'),
              h('th', { scope: 'col' }, '2026营收'),
              h('th', { scope: 'col' }, '2026净利润'),
              h('th', { scope: 'col' }, '2026PE'),
              h('th', { scope: 'col' }, '2027营收'),
              h('th', { scope: 'col' }, '2027净利润'),
              h('th', { scope: 'col' }, '2027PE'),
              h('th', { scope: 'col' }, '2028营收'),
              h('th', { scope: 'col' }, '2028净利润'),
              h('th', { scope: 'col' }, '2028PE'),
              h('th', { scope: 'col' }, '估值信息'),
              h('th', { scope: 'col' }, '目标价'),
              h('th', { scope: 'col' }, '机构'),
              h('th', { scope: 'col' }, '页数'),
            ]),
          ]),
          h('tbody', rows.value.length > 0
            ? rows.value.map((row) => {
              const rawResponseTitle = companyReportRawResponseTitle(row.llmRawResponse)
              return h('tr', {
                key: `${row.publishDate}-${row.title}-${row.rank}`,
                ...(rawResponseTitle ? { title: rawResponseTitle, 'aria-label': rawResponseTitle } : {}),
              }, [
                h('td', row.rank),
                h('td', row.publishDate),
                h('td', row.reportInfoCode
                  ? h('a', {
                    href: `#${row.reportInfoCode}`,
                    name: 'infoCode',
                    'data-code': row.reportInfoCode,
                  }, row.title)
                  : row.reportHref
                    ? h('a', {
                      href: row.reportHref,
                      target: '_blank',
                      rel: 'noreferrer noopener',
                    }, row.title)
                    : row.docId
                      ? h('a', {
                        href: `#knowledge:${row.docId}`,
                        onClick: (event: Event) => {
                          event.preventDefault()
                          emitCompanyReportOpenDoc(row.docId)
                        },
                      }, row.title)
                      : h('span', row.title)),
                h('td', companyReportProvenanceLabel(row.provenance)),
                h('td', { title: growthTitle('营收', row.revenueGrowth2025) }, growthCell(row.revenue2025, row.revenueGrowth2025)),
                h('td', { title: profitTitle(row.growth2025, row.profitMargin2025, row.profitEstimated2025) }, growthCell(row.profit2025, row.growth2025)),
                h('td', row.pe2025),
                h('td', { title: growthTitle('营收', row.revenueGrowth2026) }, growthCell(row.revenue2026, row.revenueGrowth2026)),
                h('td', { title: profitTitle(row.growth2026, row.profitMargin2026, row.profitEstimated2026) }, growthCell(row.profit2026, row.growth2026)),
                h('td', row.pe2026),
                h('td', { title: growthTitle('营收', row.revenueGrowth2027) }, growthCell(row.revenue2027, row.revenueGrowth2027)),
                h('td', { title: profitTitle(row.growth2027, row.profitMargin2027, row.profitEstimated2027) }, growthCell(row.profit2027, row.growth2027)),
                h('td', row.pe2027),
                h('td', { title: growthTitle('营收', row.revenueGrowth2028) }, growthCell(row.revenue2028, row.revenueGrowth2028)),
                h('td', { title: profitTitle(row.growth2028, row.profitMargin2028, row.profitEstimated2028) }, growthCell(row.profit2028, row.growth2028)),
                h('td', row.pe2028),
                h('td', row.valuation),
                h('td', row.targetPrice),
                h('td', row.orgName),
                h('td', row.pages),
              ])
            })
            : [
              h('tr', { key: 'company-report-empty' }, [
                h('td', {
                  colSpan: 20,
                  class: `text-center ${statusDanger.value ? 'text-danger' : 'text-muted'}`,
                }, statusText.value || '暂无公司研报'),
              ]),
            ]),
        ]),
      ]),
      pagination(),
      h('div', { class: 'modal fade', id: 'knowledgeDocModal', tabindex: '-1', 'aria-labelledby': 'knowledgeDocModalTitle', 'aria-hidden': 'true' }, [
        h('div', { class: 'modal-dialog modal-xl modal-dialog-scrollable' }, [
          h('div', { class: 'modal-content' }, [
            h('div', { class: 'modal-header' }, [
              h('button', {
                type: 'button',
                class: 'btn btn-sm btn-outline-warning d-none',
                id: 'knowledgeDocFavoriteBtn',
              }, '收藏'),
              h('h1', { class: 'modal-title fs-5', id: 'knowledgeDocModalTitle' }),
              h('button', { type: 'button', class: 'btn-close', 'data-bs-dismiss': 'modal', 'aria-label': 'Close' }),
            ]),
            h('div', { class: 'modal-body' }, [
              h('div', { id: 'knowledgeDocContent', class: 'lh-lg' }),
              h('div', { id: 'knowledgeDocMeta', class: 'small text-muted mt-4 pt-3 border-top' }),
            ]),
          ]),
        ]),
      ]),
    ])
  },
})

const root = document.getElementById('company-report-vue-root')
if (root) {
  createApp(CompanyReportPage).mount(root)
}
