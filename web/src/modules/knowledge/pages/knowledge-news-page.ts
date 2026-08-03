import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue'
import { knowledgeDocModalStyles } from '../runtime/knowledge-doc-modal'

type KnowledgeNewsTableRow = {
  displayTime: string
  sourceType: string
  target: string
  targetCode: string
  sourceName: string
  title: string
  docId: string
  sourceUrl: string
  contentUrl: string
  accessMethod: string
  isReport: boolean
  stockLinks: Array<{ name: string; code: string }>
  tags: string[]
  informationTags: string[]
  informationCategories: string[]
  modelTargets: Array<{ name: string; code: string }>
  favorited: boolean
  isFiltered: boolean
  isCompanyReport: boolean
  reportPages: number | null
  analysisState: 'idle' | 'loading' | 'done' | 'failed'
  analysisCalled: boolean
  analysisError: string
  latestPrice: number | null
  forecasts: Array<{
    year: number
    revenue: number | null
    revenue_growth: number | null
    net_profit: number | null
    profit_growth: number | null
    current_pe: number | null
    peg: number | null
  }>
  peg2028: number | null
  recommended: boolean
  document?: Record<string, unknown>
}

type KnowledgeNewsTableStateEvent = CustomEvent<{
  rows?: KnowledgeNewsTableRow[]
  currentPage?: number
  hasNext?: boolean
  companyReportMode?: boolean
}>

type KnowledgeNewsFilterOption = {
  value: string
  label: string
}

type KnowledgeNewsFiltersStateEvent = CustomEvent<{
  sourceNameOptions?: KnowledgeNewsFilterOption[]
  industryOptions?: KnowledgeNewsFilterOption[]
  selectedSourceType?: string
  selectedSourceName?: string
  selectedIndustry?: string
  selectedTags?: string[]
  informationTagOptions?: KnowledgeNewsFilterOption[]
  entityOptions?: KnowledgeNewsFilterOption[]
  selectedInformationTags?: string[]
  selectedEntity?: string
  predicateOptions?: KnowledgeNewsFilterOption[]
  selectedPredicate?: string
}>

const knowledgeNewsTargetStyle = `
#knowledgeNews .knowledge-news-target-cell {
  max-width: 220px;
  position: relative;
  width: 220px;
}

#knowledgeNews.knowledge-news-company-report-table th,
#knowledgeNews.knowledge-news-company-report-table td {
  white-space: nowrap;
}

#knowledgeNews .knowledge-news-forecast-cell {
  font-size: .78rem;
  line-height: 1.45;
  min-width: 150px;
}

#knowledgeNews .knowledge-news-forecast-cell .metric-label {
  color: #6c757d;
}

#knowledgeNews .knowledge-news-recommended-cell {
  background: #d1e7dd;
  box-shadow: inset 4px 0 #198754;
}

#knowledgeNews .knowledge-news-title-link {
  color: var(--bs-body-color);
  text-decoration: none;
}

#knowledgeNews .knowledge-news-title-link:hover,
#knowledgeNews .knowledge-news-title-link:focus {
  text-decoration: underline;
}

#knowledgeNews .knowledge-news-title-read,
#knowledgeNews .knowledge-news-title-read .knowledge-news-title-link {
  color: #6c757d;
}

#knowledgeNews .knowledge-news-target-text {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

#knowledgeNews .knowledge-news-target-link {
  color: inherit;
  text-decoration: none;
}

#knowledgeNews .knowledge-news-target-link:hover,
#knowledgeNews .knowledge-news-target-link:focus {
  text-decoration: underline;
}

#knowledgeNews .knowledge-news-target-tooltip {
  background: #fff;
  border: 1px solid rgba(0, 0, 0, .175);
  border-radius: .375rem;
  box-shadow: 0 .5rem 1rem rgba(0, 0, 0, .15);
  color: #212529;
  display: none;
  left: 0;
  line-height: 1.5;
  margin-top: .25rem;
  max-width: min(720px, 70vw);
  padding: .5rem .75rem;
  position: absolute;
  top: 100%;
  white-space: normal;
  width: max-content;
  z-index: 1080;
}

#knowledgeNews .knowledge-news-target-cell:hover .knowledge-news-target-tooltip,
#knowledgeNews .knowledge-news-target-cell:focus-within .knowledge-news-target-tooltip {
  display: block;
}

#knowledgeTagFilters .knowledge-news-tag-menu,
#knowledgeInformationTagFilters .knowledge-news-tag-menu {
  max-height: min(360px, 60vh);
  min-width: 180px;
  overflow-y: auto;
}

${knowledgeDocModalStyles}
`

const knowledgeNewsTagClassMap: Record<string, string> = {
  unread: 'text-bg-warning',
  pdf: 'text-bg-danger',
}

const knowledgeNewsTagLabelMap: Record<string, string> = {
  unread: '未读',
  pdf: 'PDF',
}

const knowledgeNewsInformationTagLabelMap: Record<string, string> = {
  processed: '已模型整理',
  'information_type:fact': '事实',
  'information_type:guidance': '指引',
  'information_type:forecast': '预测',
  'information_type:opinion': '观点',
  'information_type:event': '事件',
  'information_type:relationship': '关系',
}

function emitKnowledgeNewsOpenDoc(row: KnowledgeNewsTableRow) {
  window.dispatchEvent(new CustomEvent('licai:knowledge-news-open-doc', {
    detail: { docId: row.docId, row },
  }))
}

function emitKnowledgeNewsOpenFilteredDoc(row: KnowledgeNewsTableRow) {
  window.dispatchEvent(new CustomEvent('licai:knowledge-news-open-doc', {
    detail: { docId: row.docId, filtered: true, row },
  }))
}

function knowledgeNewsLocalFileUrl(docId: string) {
  return `/api/knowledge/file?id=${encodeURIComponent(docId)}`
}

function openExternalUrlWithoutReferrer(url: string) {
  const trimmed = String(url || '').trim()
  if (!trimmed) {
    return
  }
  const link = document.createElement('a')
  link.href = trimmed
  link.target = '_blank'
  link.rel = 'noreferrer noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
}

function knowledgeNewsRemotePdfUrl(row: KnowledgeNewsTableRow) {
  const url = String(row.sourceUrl || '').trim()
  if (!url) {
    return ''
  }
  const lowerAccessMethod = String(row.accessMethod || '').toLowerCase()
  if (row.isReport || lowerAccessMethod.includes('remote_pdf') || lowerAccessMethod === 'pdf') {
    return url
  }
  return ''
}

function onKnowledgeNewsTitleClick(event: Event, row: KnowledgeNewsTableRow) {
  event.preventDefault()
  if (row.isFiltered) {
    emitKnowledgeNewsOpenFilteredDoc(row)
    return
  }
  const localFileUrl = row.accessMethod === 'local_file' && row.docId
    ? knowledgeNewsLocalFileUrl(row.docId)
    : ''
  if (localFileUrl) {
    window.open(localFileUrl, '_blank', 'noopener')
    return
  }
  const remotePdfUrl = knowledgeNewsRemotePdfUrl(row)
  if (remotePdfUrl) {
    openExternalUrlWithoutReferrer(remotePdfUrl)
    return
  }
  if (row.docId) {
    emitKnowledgeNewsOpenDoc(row)
  }
}

function emitKnowledgeNewsPageChange(page: number) {
  window.dispatchEvent(new CustomEvent('licai:knowledge-news-page-change', {
    detail: { page },
  }))
}

function knowledgeNewsPagination(currentPage: number, hasNext: boolean): Array<{
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

function knowledgeNewsTitleContent(row: KnowledgeNewsTableRow) {
  const title = row.docId
    ? h('a', {
      href: '#',
      class: 'knowledge-news-title-link',
      onClick: (event: Event) => {
        onKnowledgeNewsTitleClick(event, row)
      },
    }, row.title)
    : row.title
  const sourceUrl = String(row.sourceUrl || '').trim()
  const sourceLink = /^https?:\/\//i.test(sourceUrl)
    ? h('a', {
      href: sourceUrl,
      class: 'ms-2 small',
      target: '_blank',
      rel: 'noreferrer noopener',
    }, '原文')
    : null
  const tags = row.tags.slice()
  const informationTags = row.informationTags.filter((tag) => tag !== 'processed')
  const categories = row.informationCategories
  return [
    title,
    sourceLink,
    ...tags.map((tag) => h('span', {
      key: tag,
      class: `ms-2 badge ${knowledgeNewsTagClassMap[tag] || 'text-bg-secondary'}`,
    }, knowledgeNewsTagLabelMap[tag] || tag)),
    ...informationTags.map((tag) => h('span', {
      key: tag,
      class: 'ms-2 badge text-bg-info',
    }, knowledgeNewsInformationTagLabelMap[tag] || tag)),
    ...categories.map((category) => h('span', {
      key: category,
      class: 'ms-2 badge text-bg-light border text-dark',
      title: '模型提取谓词',
    }, category)),
  ]
}

function knowledgeNewsTargetCell(row: KnowledgeNewsTableRow) {
  const links = row.stockLinks.filter((item) => item.code)
  const modelLinks = !row.targetCode ? row.modelTargets : []
  const fallbackLink = row.targetCode
    ? [{ code: row.targetCode, name: row.target || row.targetCode }]
    : []
  const resolvedLinks = (modelLinks.length > 0 ? modelLinks : (links.length > 0 ? links : fallbackLink))
    .map((item) => ({
      code: item.code,
      label: item.name && item.code ? `${item.name} (${item.code})` : (item.name || item.code),
    }))
    .filter((item) => item.label)
  return h('td', { class: 'knowledge-news-target-cell' }, [
    resolvedLinks.length > 0
      ? h('span', { class: 'knowledge-news-target-text', title: row.target }, resolvedLinks.flatMap((item, index) => {
        const parts = [
          h('a', {
            href: `company.html?code=${encodeURIComponent(item.code)}`,
            class: 'knowledge-news-target-link',
            target: '_blank',
            rel: 'noopener',
          }, item.label),
        ]
        if (index < resolvedLinks.length - 1) {
          parts.push(' / ')
        }
        return parts
      }))
      : h('span', { class: 'knowledge-news-target-text', title: row.target }, row.target),
    row.target && row.target !== '-'
      ? h('div', { class: 'knowledge-news-target-tooltip' }, row.target)
      : null,
  ])
}

const knowledgeNewsForecastYears = [
  new Date().getFullYear(),
  new Date().getFullYear() + 1,
  new Date().getFullYear() + 2,
]

function formatKnowledgeNewsMetric(value: number | null, suffix = ''): string {
  return value === null || !Number.isFinite(value) ? '-' : `${value.toFixed(2)}${suffix}`
}

function knowledgeNewsForecastCell(row: KnowledgeNewsTableRow, year: number) {
  const forecast = row.forecasts.find((item) => item.year === year)
  if (row.analysisState === 'loading' || row.analysisState === 'idle') {
    return h('td', { class: 'knowledge-news-forecast-cell text-muted' }, '后台处理中...')
  }
  if (!forecast) {
    return h('td', { class: 'knowledge-news-forecast-cell text-muted' }, '-')
  }
  const recommended = year === 2028 && row.recommended
  return h('td', {
    class: [
      'knowledge-news-forecast-cell',
      recommended ? 'knowledge-news-recommended-cell' : '',
    ].filter(Boolean).join(' '),
  }, [
    h('div', [h('span', { class: 'metric-label' }, '营收 '), `${formatKnowledgeNewsMetric(forecast.revenue)} 亿`]),
    h('div', [h('span', { class: 'metric-label' }, '营收增速 '), formatKnowledgeNewsMetric(forecast.revenue_growth, '%')]),
    h('div', [h('span', { class: 'metric-label' }, '利润 '), `${formatKnowledgeNewsMetric(forecast.net_profit)} 亿`]),
    h('div', [h('span', { class: 'metric-label' }, '利润增速 '), formatKnowledgeNewsMetric(forecast.profit_growth, '%')]),
    h('div', [h('span', { class: 'metric-label' }, '现价 PE '), formatKnowledgeNewsMetric(forecast.current_pe)]),
    h('div', { class: recommended ? 'fw-semibold text-success' : '' }, [
        h('span', { class: 'metric-label' }, 'PEG '),
        formatKnowledgeNewsMetric(forecast.peg),
        recommended ? ' · 推荐' : '',
      ]),
  ])
}

function knowledgeNewsAnalysisStatus(row: KnowledgeNewsTableRow) {
  if (row.analysisState === 'failed') {
    return h('span', { class: 'text-danger', title: row.analysisError }, '失败')
  }
  if (row.analysisState === 'loading' || row.analysisState === 'idle') {
    return h('span', { class: 'text-muted', title: '后台依次下载、转换并分析研报' }, '下载/转换/分析中')
  }
  if (!row.analysisCalled) {
    return h('span', { class: 'text-warning', title: '没有可供模型分析的研报正文' }, '无正文')
  }
  if (!knowledgeNewsHasForecastMetrics(row.forecasts)) {
    return h('span', { class: 'text-muted', title: '研报正文中没有明确的未来年度公司业绩预测' }, '已分析·无年度预测')
  }
  return h('span', {
    class: 'text-success',
    title: row.latestPrice === null ? '' : `当前价格 ${row.latestPrice.toFixed(2)}`,
  }, '已调用')
}

function knowledgeNewsHasForecastMetrics(forecasts: KnowledgeNewsTableRow['forecasts']): boolean {
  return forecasts.some((forecast) => [
    forecast.revenue,
    forecast.revenue_growth,
    forecast.net_profit,
    forecast.profit_growth,
    forecast.current_pe,
    forecast.peg,
  ].some((value) => value !== null && Number.isFinite(value)))
}

function knowledgeNewsSelectedTagText(options: KnowledgeNewsFilterOption[], selectedTags: string[], emptyLabel = '标签') {
  if (selectedTags.length === 0) {
    return emptyLabel
  }
  const labels = selectedTags
    .map((tag) => options.find((option) => option.value === tag)?.label || knowledgeNewsTagLabelMap[tag] || tag)
    .filter(Boolean)
  if (labels.length <= 2) {
    return labels.join('、')
  }
  return `标签 ${labels.length}`
}

const KnowledgeNewsTable = defineComponent({
  name: 'KnowledgeNewsTable',
  setup() {
    const rows = ref<KnowledgeNewsTableRow[]>([])
    const currentPage = ref(1)
    const hasNext = ref(false)
    const companyReportMode = ref(false)

    const onState = (event: Event) => {
      const detail = (event as KnowledgeNewsTableStateEvent).detail
      rows.value = Array.isArray(detail?.rows) ? detail.rows : []
      if (typeof detail?.currentPage === 'number' && Number.isFinite(detail.currentPage)) {
        currentPage.value = detail.currentPage
      }
      hasNext.value = Boolean(detail?.hasNext)
      companyReportMode.value = Boolean(detail?.companyReportMode)
    }

    onMounted(() => {
      window.addEventListener('licai:knowledge-news-table-state', onState)
      window.dispatchEvent(new CustomEvent('licai:knowledge-news-state-request'))
    })

    onBeforeUnmount(() => {
      window.removeEventListener('licai:knowledge-news-table-state', onState)
    })

    const pagination = () => {
      if (currentPage.value === 1 && rows.value.length === 0) {
        return null
      }
      return h('nav', { id: 'knowledgeNews-nav' }, [
        h('ul', { class: 'pagination justify-content-center' }, knowledgeNewsPagination(currentPage.value, hasNext.value).map((item) => (
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
                emitKnowledgeNewsPageChange(item.page)
              },
            }, item.label),
          ])
        ))),
      ])
    }

    return () => h('div', [
      h('style', knowledgeNewsTargetStyle),
      h('div', { class: 'table-responsive' }, [
      h('table', {
        id: 'knowledgeNews',
        class: [
          'table table-sm table-bordered table-hover align-middle',
          companyReportMode.value ? 'knowledge-news-company-report-table' : '',
        ].filter(Boolean).join(' '),
      }, [
        h('thead', { class: 'table-info' }, [
          h('tr', [
            h('th', { scope: 'col' }, '时间'),
            h('th', { scope: 'col' }, '类型'),
            h('th', { scope: 'col', style: 'width: 220px;' }, '目标'),
            h('th', { scope: 'col' }, '来源'),
            h('th', { scope: 'col' }, '标题'),
            ...(companyReportMode.value ? [
              h('th', { scope: 'col' }, '研报页数'),
              h('th', { scope: 'col' }, '模型分析'),
              ...knowledgeNewsForecastYears.map((year) => h('th', { scope: 'col', key: year }, `${year} 预测`)),
            ] : []),
          ]),
        ]),
        h('tbody', rows.value.map((row) => h('tr', { key: `${row.docId}-${row.title}` }, [
          h('td', row.displayTime),
          h('td', row.sourceType),
          knowledgeNewsTargetCell(row),
          h('td', row.sourceName),
          h('td', knowledgeNewsTitleContent(row)),
          ...(companyReportMode.value ? [
            h('td', row.reportPages === null ? '-' : String(row.reportPages)),
            h('td', knowledgeNewsAnalysisStatus(row)),
            ...knowledgeNewsForecastYears.map((year) => knowledgeNewsForecastCell(row, year)),
          ] : []),
        ]))),
      ]),
      ]),
      pagination(),
    ])
  },
})

const KnowledgeNewsPage = defineComponent({
  name: 'KnowledgeNewsPage',
  setup() {
    const isLocalKnowledgeHost = (() => {
      const hostname = window.location.hostname.toLowerCase()
      return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
    })()
    const sourceNameOptions = ref<KnowledgeNewsFilterOption[]>([
      { value: 'all', label: '全部来源站点' },
    ])
    const industryOptions = ref<KnowledgeNewsFilterOption[]>([])
    const selectedSourceType = ref('all')
    const selectedSourceName = ref('all')
    const selectedIndustry = ref('')
    const selectedTags = ref<string[]>([])
    const informationTagOptions = ref<KnowledgeNewsFilterOption[]>([])
    const entityOptions = ref<KnowledgeNewsFilterOption[]>([])
    const selectedInformationTags = ref<string[]>([])
    const selectedEntity = ref('')
    const predicateOptions = ref<KnowledgeNewsFilterOption[]>([])
    const selectedPredicate = ref('')
    const tagFilterOptions: KnowledgeNewsFilterOption[] = [
      { value: 'pdf', label: 'PDF' },
    ]

    const onFiltersState = (event: Event) => {
      const detail = (event as KnowledgeNewsFiltersStateEvent).detail
      if (Array.isArray(detail?.sourceNameOptions) && detail.sourceNameOptions.length > 0) {
        sourceNameOptions.value = detail.sourceNameOptions
      }
      if (Array.isArray(detail?.industryOptions)) {
        industryOptions.value = detail.industryOptions
      }
      if (typeof detail?.selectedSourceType === 'string') {
        selectedSourceType.value = detail.selectedSourceType
      }
      if (typeof detail?.selectedSourceName === 'string') {
        selectedSourceName.value = detail.selectedSourceName
      }
      if (typeof detail?.selectedIndustry === 'string') {
        selectedIndustry.value = detail.selectedIndustry
      }
      if (Array.isArray(detail?.selectedTags)) {
        selectedTags.value = detail.selectedTags
      }
      if (Array.isArray(detail?.informationTagOptions)) {
        informationTagOptions.value = detail.informationTagOptions
      }
      if (Array.isArray(detail?.entityOptions)) {
        entityOptions.value = detail.entityOptions
      }
      if (Array.isArray(detail?.selectedInformationTags)) {
        selectedInformationTags.value = detail.selectedInformationTags
      }
      if (typeof detail?.selectedEntity === 'string') {
        selectedEntity.value = detail.selectedEntity
      }
      if (Array.isArray(detail?.predicateOptions)) {
        predicateOptions.value = detail.predicateOptions
      }
      if (typeof detail?.selectedPredicate === 'string') {
        selectedPredicate.value = detail.selectedPredicate
      }
    }

    onMounted(() => {
      window.addEventListener('licai:knowledge-news-filters-state', onFiltersState)
      window.dispatchEvent(new CustomEvent('licai:knowledge-news-state-request'))
    })

    onBeforeUnmount(() => {
      window.removeEventListener('licai:knowledge-news-filters-state', onFiltersState)
    })

    return () => h('div', [
      h('div', { id: 'container', class: 'py-3' }, [
        h('div', { class: 'd-flex flex-wrap align-items-center gap-2 mb-3' }, [
          h('select', { id: 'knowledgeSourceType', class: 'form-select form-select-sm', style: 'width: 160px;' }, [
            h('option', { value: 'all', selected: true }, '全部来源'),
            h('option', { value: 'web_news' }, '新闻'),
            h('option', { value: 'local_news' }, '本地新闻'),
            h('option', { value: 'sec_filing' }, 'SEC披露'),
            h('option', { value: 'research_report' }, '全部研报'),
            h('option', { value: 'company_report' }, '公司研报'),
            h('option', { value: 'industry_report' }, '行业研报'),
            isLocalKnowledgeHost ? h('option', { value: 'filtered_review' }, '过滤Review') : null,
          ]),
          h('select', { id: 'knowledgeSourceName', class: 'form-select form-select-sm', style: 'width: 180px;' }, [
            ...sourceNameOptions.value.map((option) => h('option', {
              value: option.value,
              selected: selectedSourceName.value === option.value,
            }, option.label)),
          ]),
          selectedSourceType.value === 'industry_report'
            ? h('div', { class: 'd-flex align-items-center' }, [
              h('input', {
                id: 'knowledgeIndustry',
                type: 'search',
                list: 'knowledgeIndustryOptions',
                class: 'form-control form-control-sm',
                style: 'width: 200px;',
                value: selectedIndustry.value,
                placeholder: '搜索或选择行业',
                'aria-label': '搜索或选择行业',
                onChange: (event: Event) => {
                  window.dispatchEvent(new CustomEvent('licai:knowledge-news-industry-change', {
                    detail: { industry: (event.target as HTMLInputElement).value.trim() },
                  }))
                },
              }),
              h('datalist', { id: 'knowledgeIndustryOptions' }, industryOptions.value.map((option) => h('option', {
                key: option.value,
                value: option.value,
              }, option.label))),
            ])
            : null,
          h('div', { id: 'knowledgeTagFilters', class: 'dropdown' }, [
            h('button', {
              type: 'button',
              class: [
                'btn',
                'btn-sm',
                'dropdown-toggle',
                selectedTags.value.length > 0 ? 'btn-primary' : 'btn-outline-secondary',
              ].join(' '),
              'data-bs-toggle': 'dropdown',
              'data-bs-auto-close': 'outside',
              'aria-expanded': 'false',
            }, knowledgeNewsSelectedTagText(tagFilterOptions, selectedTags.value)),
            h('div', { class: 'dropdown-menu p-2 knowledge-news-tag-menu' }, [
              ...tagFilterOptions.map((option) => h('label', {
                key: option.value,
                class: 'dropdown-item d-flex align-items-center gap-2 mb-0',
              }, [
                h('input', {
                  type: 'checkbox',
                  class: 'form-check-input mt-0',
                  name: 'knowledgeTagFilter',
                  value: option.value,
                  checked: selectedTags.value.includes(option.value),
                }),
                h('span', option.label),
              ])),
            ]),
          ]),
          h('div', { id: 'knowledgeInformationTagFilters', class: 'dropdown' }, [
            h('button', {
              type: 'button',
              class: [
                'btn',
                'btn-sm',
                'dropdown-toggle',
                selectedInformationTags.value.length > 0 ? 'btn-primary' : 'btn-outline-info',
              ].join(' '),
              'data-bs-toggle': 'dropdown',
              'data-bs-auto-close': 'outside',
              'aria-expanded': 'false',
            }, knowledgeNewsSelectedTagText(informationTagOptions.value, selectedInformationTags.value, '模型标签')),
            h('div', { class: 'dropdown-menu p-2 knowledge-news-tag-menu' }, [
              ...informationTagOptions.value.map((option) => h('label', {
                key: option.value,
                class: 'dropdown-item d-flex align-items-center gap-2 mb-0',
              }, [
                h('input', {
                  type: 'checkbox',
                  class: 'form-check-input mt-0',
                  name: 'knowledgeInformationTagFilter',
                  value: option.value,
                  checked: selectedInformationTags.value.includes(option.value),
                }),
                h('span', option.label),
              ])),
            ]),
          ]),
          h('div', { class: 'd-flex align-items-center' }, [
            h('input', {
              id: 'knowledgeEntity',
              type: 'search',
              list: 'knowledgeEntityOptions',
              class: 'form-control form-control-sm',
              style: 'width: 190px;',
              value: selectedEntity.value,
              placeholder: '信息对象',
              'aria-label': '按信息对象过滤',
            }),
            h('datalist', { id: 'knowledgeEntityOptions' }, entityOptions.value.map((option) => h('option', {
              key: option.value,
              value: option.value,
            }, option.label))),
          ]),
          h('div', { class: 'd-flex align-items-center' }, [
            h('input', {
              id: 'knowledgePredicate',
              type: 'search',
              list: 'knowledgePredicateOptions',
              class: 'form-control form-control-sm',
              style: 'width: 220px;',
              value: selectedPredicate.value,
              placeholder: '信息主题，如 target_price',
              'aria-label': '按信息主题过滤',
            }),
            h('datalist', { id: 'knowledgePredicateOptions' }, predicateOptions.value.map((option) => h('option', {
              key: option.value,
              value: option.value,
            }, option.label))),
          ]),
          h('div', { 'data-knowledge-query-control': 'true', class: 'd-flex gap-2' }, [
            h('input', { id: 'knowledgeQuery', class: 'form-control form-control-sm', style: 'max-width: 360px;', placeholder: '标题、来源、目标、链接搜索' }),
          ]),
          h('button', { id: 'knowledgeSearchBtn', class: 'btn btn-primary btn-sm' }, '查询'),
        ]),
        h('div', { id: 'knowledgeNewsTableRoot' }),
      ]),
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

const root = document.getElementById('knowledge-news-vue-root')
if (root) {
  createApp(KnowledgeNewsPage).mount(root)
  const tableRoot = document.getElementById('knowledgeNewsTableRoot')
  if (tableRoot) {
    createApp(KnowledgeNewsTable).mount(tableRoot)
  }
}
