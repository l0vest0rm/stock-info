import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref } from 'vue'

type KnowledgeRun = {
  finishedAt?: unknown
  startedAt?: unknown
  reason?: string
  durationMs?: unknown
  error?: string
  running?: boolean
  success?: boolean
  docs?: unknown
  newDocs?: unknown
  extractedItems?: unknown
  extractionErrors?: unknown
}

type KnowledgeNewsSource = {
  key?: string
  name?: string
  enabled?: boolean
  scheduleEvery?: number
  scheduleMinutesText?: string
  discoveryMethod?: string
  lastRun?: KnowledgeRun
}

type KnowledgeBacklogSource = {
  key?: string
  name?: string
  url?: string
  category?: string
  registered?: boolean
  status?: string
  registeredDiscoveryMethod?: string
  access?: string
  crawlPlan?: string
  reason?: string
  nextStep?: string
}

type KnowledgeNewsSourcesEvent = CustomEvent<{
  sources?: KnowledgeNewsSource[]
  preserveDrafts?: boolean
}>

type KnowledgeBacklogEvent = CustomEvent<{
  sources?: KnowledgeBacklogSource[]
}>

type KnowledgeMainSourceState = {
  company?: KnowledgeNewsSource
  industry?: KnowledgeNewsSource
  news?: KnowledgeNewsSource
  sec?: KnowledgeNewsSource
  companyScheduleText?: string
  industryScheduleText?: string
}

type KnowledgeMainSourcesEvent = CustomEvent<{
  mainSources?: KnowledgeMainSourceState
}>

type KnowledgeConfigFormState = {
  enabled: string
  scheduleMinutes: string
  hours: string
  topic: string
  outputDir: string
  pageSize: string
  scanPages: string
  workers: string
  maxChars: string
  commandPath: string
  runOnStart: boolean
  webHelperFallback: boolean
  force: boolean
  clean: boolean
  skipSummary: boolean
  skipArticle: boolean
  companyEnabled: boolean
  industryEnabled: boolean
  newsEnabled: boolean
  secEnabled: boolean
  newsScheduleMinutes: string
  secScheduleMinutes: string
}

type KnowledgeConfigFormStateEvent = CustomEvent<{
  formState?: Partial<KnowledgeConfigFormState>
}>

type KnowledgeConfigUiState = {
  savePending: boolean
  saveButtonText: string
  outputText: string
  pendingRunTargets: string[]
}

type KnowledgeConfigUiStateEvent = CustomEvent<{
  uiState?: Partial<KnowledgeConfigUiState>
}>

function field(label: string, control: ReturnType<typeof h>, colClass = 'col-6') {
  return h('div', { class: colClass }, [
    h('label', { class: 'form-label small' }, label),
    control,
  ])
}

function section(title: string, body: ReturnType<typeof h> | ReturnType<typeof h>[], className = 'border rounded p-3 h-100') {
  return h('div', { class: className }, [
    h('div', { class: 'fw-semibold mb-3' }, title),
    ...(Array.isArray(body) ? body : [body]),
  ])
}

function textInput(id: string, attrs: Record<string, unknown> = {}) {
  return h('input', { id, class: 'form-control form-control-sm', ...attrs })
}

function numberInput(id: string, attrs: Record<string, unknown> = {}) {
  return textInput(id, { type: 'number', min: '1', ...attrs })
}

function checkbox(id: string, label: string, attrs: Record<string, unknown> = {}) {
  return h('label', { class: 'form-check-label small' }, [
    h('input', { id, class: 'form-check-input', type: 'checkbox', ...attrs }),
    ` ${label}`,
  ])
}

function defaultKnowledgeConfigFormState(): KnowledgeConfigFormState {
  return {
    enabled: 'true',
    scheduleMinutes: '30',
    hours: '24',
    topic: 'ai',
    outputDir: '',
    pageSize: '50',
    scanPages: '50',
    workers: '1',
    maxChars: '3000',
    commandPath: 'bin/licai',
    runOnStart: false,
    webHelperFallback: false,
    force: false,
    clean: false,
    skipSummary: false,
    skipArticle: false,
    companyEnabled: false,
    industryEnabled: false,
    newsEnabled: false,
    secEnabled: false,
    newsScheduleMinutes: '30',
    secScheduleMinutes: '30',
  }
}

function defaultKnowledgeConfigUiState(): KnowledgeConfigUiState {
  return {
    savePending: false,
    saveButtonText: '保存',
    outputText: '',
    pendingRunTargets: [],
  }
}

function normalizeKnowledgeNewsSource(source: KnowledgeNewsSource, draft?: KnowledgeNewsSource): KnowledgeNewsSource {
  const scheduleMinutes = Math.max(1, Math.round(Number(source.scheduleEvery || draft?.scheduleEvery || 0) / 60000))
  return {
    ...source,
    scheduleMinutesText: draft?.scheduleMinutesText ?? String(scheduleMinutes),
  }
}

function mergeKnowledgeNewsSourceDrafts(
  currentSources: KnowledgeNewsSource[],
  nextSources: KnowledgeNewsSource[],
): KnowledgeNewsSource[] {
  const draftMap = new Map(
    currentSources.map((source) => [String(source.key || ''), source]),
  )
  return nextSources.map((source) => {
    const key = String(source.key || '')
    const draft = draftMap.get(key)
    if (!draft) {
      return normalizeKnowledgeNewsSource(source)
    }
    return normalizeKnowledgeNewsSource({
      ...source,
      enabled: draft.enabled,
      discoveryMethod: draft.discoveryMethod,
      scheduleEvery: draft.scheduleEvery,
    }, draft)
  })
}

function runStatusCells(prefix: string) {
  return [
    h('td', { id: `${prefix}RunTime`, class: 'text-muted' }, '未调度'),
    h('td', { id: `${prefix}RunResult`, class: 'text-muted' }, '-'),
    h('td', { id: `${prefix}RunCounts`, class: 'text-muted' }, '-'),
  ]
}

function formatRunTime(value: unknown): string {
  if (!value) {
    return '-'
  }
  const date = new Date(String(value))
  if (Number.isNaN(date.getTime())) {
    return '-'
  }
  return date.toLocaleString('zh-CN', { hour12: false })
}

function formatRunDuration(value: unknown): string {
  const ms = Number(value || 0)
  if (!Number.isFinite(ms) || ms <= 0) {
    return '-'
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`
  }
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`
}

function sourceRunStatusCells(source: KnowledgeNewsSource) {
  const run = source.lastRun
  if (!run) {
    if (source.enabled) {
      return [
        h('td', { class: 'text-muted' }, '等待首次补跑'),
        h('td', [
          h('span', { class: 'badge bg-secondary' }, '暂无记录'),
          h('div', { class: 'small text-muted' }, '等待手工触发或下次自动调度'),
        ]),
        h('td', { class: 'text-muted' }, '-'),
      ]
    }
    return [
      h('td', { class: 'text-muted' }, '未启用'),
      h('td', { class: 'text-muted' }, '-'),
      h('td', { class: 'text-muted' }, '-'),
    ]
  }

  const resultNode = run.running
    ? h('span', { class: 'badge bg-info text-dark' }, '运行中')
    : run.success
      ? h('span', { class: 'badge bg-success' }, '成功')
      : h('span', { class: 'badge bg-danger' }, '失败')
  const countText = [
    `文档 ${Number(run.docs || 0)}`,
    `新增 ${Number(run.newDocs || 0)}`,
    `条目 ${Number(run.extractedItems || 0)}`,
    `错误 ${Number(run.extractionErrors || 0)}`,
  ].join(' / ')

  return [
    h('td', [
      formatRunTime(run.finishedAt || run.startedAt),
      run.reason ? h('div', { class: 'small text-muted' }, run.reason) : null,
    ]),
    h('td', [
      resultNode,
      h('div', { class: 'small text-muted' }, `耗时 ${formatRunDuration(run.durationMs)}`),
      run.error ? h('div', { class: 'small text-danger text-truncate', style: 'max-width: 180px', title: run.error }, run.error) : null,
    ]),
    h('td', [h('span', { class: 'small' }, countText)]),
  ]
}

function sourceRunStatusCellsWithIds(prefix: string, source: KnowledgeNewsSource | undefined) {
  const run = source?.lastRun
  if (!run) {
    if (source?.enabled) {
      return [
        h('td', { id: `${prefix}RunTime`, class: 'text-muted' }, '等待首次补跑'),
        h('td', { id: `${prefix}RunResult` }, [
          h('span', { class: 'badge bg-secondary' }, '暂无记录'),
          h('div', { class: 'small text-muted' }, '启动或新配置后自动触发'),
        ]),
        h('td', { id: `${prefix}RunCounts`, class: 'text-muted' }, '-'),
      ]
    }
    return [
      h('td', { id: `${prefix}RunTime`, class: 'text-muted' }, '未启用'),
      h('td', { id: `${prefix}RunResult`, class: 'text-muted' }, '-'),
      h('td', { id: `${prefix}RunCounts`, class: 'text-muted' }, '-'),
    ]
  }

  const resultNode = run.running
    ? h('span', { class: 'badge bg-info text-dark' }, '运行中')
    : run.success
      ? h('span', { class: 'badge bg-success' }, '成功')
      : h('span', { class: 'badge bg-danger' }, '失败')
  const countText = [
    `文档 ${Number(run.docs || 0)}`,
    `新增 ${Number(run.newDocs || 0)}`,
    `条目 ${Number(run.extractedItems || 0)}`,
    `错误 ${Number(run.extractionErrors || 0)}`,
  ].join(' / ')

  return [
    h('td', { id: `${prefix}RunTime` }, [
      formatRunTime(run.finishedAt || run.startedAt),
      run.reason ? h('div', { class: 'small text-muted' }, run.reason) : null,
    ]),
    h('td', { id: `${prefix}RunResult` }, [
      resultNode,
      h('div', { class: 'small text-muted' }, `耗时 ${formatRunDuration(run.durationMs)}`),
      run.error ? h('div', { class: 'small text-danger text-truncate', style: 'max-width: 180px', title: run.error }, run.error) : null,
    ]),
    h('td', { id: `${prefix}RunCounts` }, [h('span', { class: 'small' }, countText)]),
  ]
}

function renderNewsSourceRows(
  sources: KnowledgeNewsSource[],
  pendingRunTargets: Set<string>,
  onSourceChange: (key: string, patch: Partial<KnowledgeNewsSource>) => void,
) {
  const methods = ['sitemap', 'feed', 'site_html', 'site_api', 'site_crawl', 'web_search']
  return sources.map((source) => {
    const key = String(source.key || '')
    const name = String(source.name || key)
    const scheduleMinutes = Math.max(1, Math.round(Number(source.scheduleEvery || 0) / 60000))
    const scheduleMinutesText = source.scheduleMinutesText ?? String(scheduleMinutes)
    const discoveryMethod = source.discoveryMethod || 'feed'
    const running = Boolean(source.lastRun?.running) || pendingRunTargets.has(key)
    return h('tr', { key, 'data-source-key': key }, [
      h('td', [
        name,
        h('input', { type: 'hidden', 'data-field': 'key', value: key }),
        h('input', { type: 'hidden', 'data-field': 'name', value: String(source.name || '') }),
      ]),
      h('td', [h('input', {
        class: 'form-check-input',
        'data-field': 'enabled',
        type: 'checkbox',
        checked: Boolean(source.enabled),
        onChange: (event: Event) => onSourceChange(key, {
          enabled: (event.target as HTMLInputElement).checked,
        }),
      })]),
      h('td', [
        h('select', {
          class: 'form-select form-select-sm',
          'data-field': 'discoveryMethod',
          value: discoveryMethod,
          onChange: (event: Event) => onSourceChange(key, {
            discoveryMethod: (event.target as HTMLSelectElement).value,
          }),
        }, (
          methods.map((method) => h('option', { value: method }, method))
        )),
      ]),
      h('td', [h('input', {
        class: 'form-control form-control-sm',
        'data-field': 'scheduleMinutes',
        type: 'number',
        min: '1',
        value: scheduleMinutesText,
        onInput: (event: Event) => {
          const nextText = (event.target as HTMLInputElement).value
          const nextMinutes = Number(nextText)
          onSourceChange(key, {
            scheduleMinutesText: nextText,
            ...(Number.isFinite(nextMinutes) && nextMinutes > 0
              ? { scheduleEvery: Math.round(nextMinutes) * 60000 }
              : {}),
          })
        },
      })]),
      ...sourceRunStatusCells(source),
      h('td', [
        h('button', {
          class: 'btn btn-outline-primary btn-sm',
          type: 'button',
          'data-knowledge-manual-run': key,
          'data-knowledge-run-name': name,
          disabled: running,
        }, running ? '运行中' : '手工触发'),
      ]),
    ])
  })
}

function renderBacklogRows(sources: KnowledgeBacklogSource[]) {
  if (sources.length === 0) {
    return [
      h('tr', [
        h('td', { colSpan: 7, class: 'text-muted text-center' }, '推荐清单里的来源都已接入调度'),
      ]),
    ]
  }
  return sources.map((source) => {
    const key = String(source.key || '')
    const name = String(source.name || source.key || '')
    const url = String(source.url || '')
    return h('tr', { key: `${key}-${url}` }, [
      h('td', [
        url ? h('a', { href: url, target: '_blank' }, name) : name,
        h('div', { class: 'small text-muted' }, key),
      ]),
      h('td', source.category || '-'),
      h('td', [
        h('span', { class: `badge ${source.registered ? 'bg-warning text-dark' : 'bg-secondary'}` }, source.status || '未注册'),
        source.registeredDiscoveryMethod ? h('div', { class: 'small text-muted' }, source.registeredDiscoveryMethod) : null,
      ]),
      h('td', source.access || '-'),
      h('td', source.crawlPlan || '-'),
      h('td', source.reason || '-'),
      h('td', source.nextStep || '-'),
    ])
  })
}

const KnowledgeConfigPage = defineComponent({
  name: 'KnowledgeConfigPage',
  setup() {
    const newsSources = ref<KnowledgeNewsSource[]>([])
    const backlogSources = ref<KnowledgeBacklogSource[]>([])
    const mainSources = ref<KnowledgeMainSourceState>({
      companyScheduleText: '跟随全局',
      industryScheduleText: '跟随全局',
    })
    const formState = ref<KnowledgeConfigFormState>(defaultKnowledgeConfigFormState())
    const uiState = ref<KnowledgeConfigUiState>(defaultKnowledgeConfigUiState())

    const onNewsSources = (event: Event) => {
      const detail = (event as KnowledgeNewsSourcesEvent).detail
      const nextSources = Array.isArray(detail?.sources)
        ? detail.sources.map((source) => normalizeKnowledgeNewsSource(source))
        : []
      newsSources.value = detail?.preserveDrafts
        ? mergeKnowledgeNewsSourceDrafts(newsSources.value, nextSources)
        : nextSources
    }

    const onBacklog = (event: Event) => {
      const detail = (event as KnowledgeBacklogEvent).detail
      backlogSources.value = Array.isArray(detail?.sources) ? detail.sources : []
    }

    const onMainSources = (event: Event) => {
      const detail = (event as KnowledgeMainSourcesEvent).detail
      mainSources.value = detail?.mainSources || {
        companyScheduleText: '跟随全局',
        industryScheduleText: '跟随全局',
      }
    }

    const onFormState = (event: Event) => {
      const detail = (event as KnowledgeConfigFormStateEvent).detail
      formState.value = {
        ...formState.value,
        ...(detail?.formState || {}),
      }
    }

    const updateFormState = (key: keyof KnowledgeConfigFormState, value: string | boolean) => {
      formState.value = {
        ...formState.value,
        [key]: value,
      }
    }

    const updateNewsSource = (key: string, patch: Partial<KnowledgeNewsSource>) => {
      newsSources.value = newsSources.value.map((source) => {
        if (String(source.key || '') !== key) {
          return source
        }
        return {
          ...source,
          ...patch,
        }
      })
    }

    const onUiState = (event: Event) => {
      const detail = (event as KnowledgeConfigUiStateEvent).detail
      uiState.value = {
        ...uiState.value,
        ...(detail?.uiState || {}),
      }
    }

    onMounted(() => {
      window.addEventListener('licai:knowledge-config-news-sources', onNewsSources)
      window.addEventListener('licai:knowledge-config-backlog', onBacklog)
      window.addEventListener('licai:knowledge-config-main-sources', onMainSources)
      window.addEventListener('licai:knowledge-config-form-state', onFormState)
      window.addEventListener('licai:knowledge-config-ui-state', onUiState)
    })

    onBeforeUnmount(() => {
      window.removeEventListener('licai:knowledge-config-news-sources', onNewsSources)
      window.removeEventListener('licai:knowledge-config-backlog', onBacklog)
      window.removeEventListener('licai:knowledge-config-main-sources', onMainSources)
      window.removeEventListener('licai:knowledge-config-form-state', onFormState)
      window.removeEventListener('licai:knowledge-config-ui-state', onUiState)
    })

    return () => {
      const pendingRunTargets = new Set(uiState.value.pendingRunTargets || [])
      const webNewsRunning = Boolean(mainSources.value.news?.lastRun?.running) || pendingRunTargets.has('web_news')
      const secRunning = Boolean(mainSources.value.sec?.lastRun?.running) || pendingRunTargets.has('sec_filing')
      return h('div', { id: 'container', class: 'py-3' }, [
      h('div', { class: 'd-flex align-items-center justify-content-between mb-3' }, [
        h('h5', { class: 'mb-0' }, '采集配置'),
        h('button', {
          id: 'knowledgeConfigSaveBtn',
          class: 'btn btn-primary btn-sm',
          type: 'button',
          disabled: uiState.value.savePending,
        }, uiState.value.saveButtonText),
      ]),
      h('div', { class: 'row g-3' }, [
        h('div', { class: 'col-lg-6' }, [
          section('调度', h('div', { class: 'row g-2' }, [
            field('状态', h('select', {
              id: 'knowledgeCfgEnabled',
              class: 'form-select form-select-sm',
              value: formState.value.enabled,
              onChange: (event: Event) => updateFormState('enabled', (event.target as HTMLSelectElement).value),
            }, [
              h('option', { value: 'true' }, '启用'),
              h('option', { value: 'false' }, '停用'),
            ])),
            field('周期（分钟）', numberInput('knowledgeCfgScheduleMinutes', {
              value: formState.value.scheduleMinutes,
              onInput: (event: Event) => updateFormState('scheduleMinutes', (event.target as HTMLInputElement).value),
            })),
            field('最近小时数', numberInput('knowledgeCfgHours', {
              value: formState.value.hours,
              onInput: (event: Event) => updateFormState('hours', (event.target as HTMLInputElement).value),
            })),
            field('主题', textInput('knowledgeCfgTopic', {
              value: formState.value.topic,
              onInput: (event: Event) => updateFormState('topic', (event.target as HTMLInputElement).value),
            })),
            field('输出目录', textInput('knowledgeCfgOutputDir', {
              value: formState.value.outputDir,
              onInput: (event: Event) => updateFormState('outputDir', (event.target as HTMLInputElement).value),
            }), 'col-12'),
          ])),
        ]),
        h('div', { class: 'col-lg-6' }, [
          section('抓取', h('div', { class: 'row g-2' }, [
            field('页大小', numberInput('knowledgeCfgPageSize', {
              value: formState.value.pageSize,
              onInput: (event: Event) => updateFormState('pageSize', (event.target as HTMLInputElement).value),
            }), 'col-4'),
            field('最大扫描页数', numberInput('knowledgeCfgScanPages', {
              value: formState.value.scanPages,
              onInput: (event: Event) => updateFormState('scanPages', (event.target as HTMLInputElement).value),
            }), 'col-4'),
            field('并发', numberInput('knowledgeCfgWorkers', {
              value: formState.value.workers,
              onInput: (event: Event) => updateFormState('workers', (event.target as HTMLInputElement).value),
            }), 'col-4'),
            field('抽取长度', numberInput('knowledgeCfgMaxChars', {
              value: formState.value.maxChars,
              onInput: (event: Event) => updateFormState('maxChars', (event.target as HTMLInputElement).value),
            })),
            field('后台执行程序', textInput('knowledgeCfgCommandPath', {
              value: formState.value.commandPath,
              onInput: (event: Event) => updateFormState('commandPath', (event.target as HTMLInputElement).value),
            })),
            h('div', { class: 'col-12 d-flex flex-wrap gap-3 pt-2' }, [
              checkbox('knowledgeCfgRunOnStart', '启动运行', {
                checked: formState.value.runOnStart,
                onChange: (event: Event) => updateFormState('runOnStart', (event.target as HTMLInputElement).checked),
              }),
              checkbox('knowledgeCfgWebHelperFallback', 'web-helper 兜底', {
                checked: formState.value.webHelperFallback,
                onChange: (event: Event) => updateFormState('webHelperFallback', (event.target as HTMLInputElement).checked),
              }),
              checkbox('knowledgeCfgForce', '强制重抽', {
                checked: formState.value.force,
                onChange: (event: Event) => updateFormState('force', (event.target as HTMLInputElement).checked),
              }),
              checkbox('knowledgeCfgClean', '清空输出', {
                checked: formState.value.clean,
                onChange: (event: Event) => updateFormState('clean', (event.target as HTMLInputElement).checked),
              }),
              checkbox('knowledgeCfgSkipSummary', '跳过总结', {
                checked: formState.value.skipSummary,
                onChange: (event: Event) => updateFormState('skipSummary', (event.target as HTMLInputElement).checked),
              }),
              checkbox('knowledgeCfgSkipArticle', '跳过文章', {
                checked: formState.value.skipArticle,
                onChange: (event: Event) => updateFormState('skipArticle', (event.target as HTMLInputElement).checked),
              }),
            ]),
          ])),
        ]),
        h('div', { class: 'col-12' }, [
          section('研报、通用新闻与官方披露', h('div', { class: 'table-responsive' }, [
            h('table', { class: 'table table-sm table-bordered align-middle mb-0' }, [
              h('thead', { class: 'table-info' }, [
                h('tr', [
                  h('th', { scope: 'col' }, '来源'),
                  h('th', { scope: 'col' }, '启用'),
                  h('th', { scope: 'col' }, '采集周期（分钟）'),
                  h('th', { scope: 'col' }, '最近调度'),
                  h('th', { scope: 'col' }, '结果'),
                  h('th', { scope: 'col' }, '数量'),
                  h('th', { scope: 'col', class: 'text-nowrap' }, '操作'),
                ]),
              ]),
              h('tbody', [
                h('tr', [
                  h('td', '公司研报'),
                  h('td', [h('input', {
                    id: 'knowledgeCfgCompanyEnabled',
                    class: 'form-check-input',
                    type: 'checkbox',
                    checked: formState.value.companyEnabled,
                    onChange: (event: Event) => updateFormState('companyEnabled', (event.target as HTMLInputElement).checked),
                  })]),
                  h('td', [h('span', { id: 'knowledgeCfgCompanyScheduleText', class: 'text-muted small' }, mainSources.value.companyScheduleText || '跟随全局')]),
                  ...sourceRunStatusCellsWithIds('knowledgeCfgCompany', mainSources.value.company),
                  h('td', { class: 'text-muted' }, '-'),
                ]),
                h('tr', [
                  h('td', '行业研报'),
                  h('td', [h('input', {
                    id: 'knowledgeCfgIndustryEnabled',
                    class: 'form-check-input',
                    type: 'checkbox',
                    checked: formState.value.industryEnabled,
                    onChange: (event: Event) => updateFormState('industryEnabled', (event.target as HTMLInputElement).checked),
                  })]),
                  h('td', [h('span', { id: 'knowledgeCfgIndustryScheduleText', class: 'text-muted small' }, mainSources.value.industryScheduleText || '跟随全局')]),
                  ...sourceRunStatusCellsWithIds('knowledgeCfgIndustry', mainSources.value.industry),
                  h('td', { class: 'text-muted' }, '-'),
                ]),
                h('tr', [
                  h('td', '通用新闻搜索'),
                  h('td', [h('input', {
                    id: 'knowledgeCfgNewsEnabled',
                    class: 'form-check-input',
                    type: 'checkbox',
                    checked: formState.value.newsEnabled,
                    onChange: (event: Event) => updateFormState('newsEnabled', (event.target as HTMLInputElement).checked),
                  })]),
                  h('td', [h('input', {
                    id: 'knowledgeCfgNewsScheduleMinutes',
                    class: 'form-control form-control-sm',
                    type: 'number',
                    min: '1',
                    value: formState.value.newsScheduleMinutes,
                    onInput: (event: Event) => updateFormState('newsScheduleMinutes', (event.target as HTMLInputElement).value),
                  })]),
                  ...sourceRunStatusCellsWithIds('knowledgeCfgNews', mainSources.value.news),
                  h('td', [
                    h('button', {
                      id: 'knowledgeConfigWebSearchBtn',
                      class: 'btn btn-outline-primary btn-sm',
                      type: 'button',
                      'data-knowledge-manual-run': 'web_news',
                      'data-knowledge-run-name': '通用新闻搜索',
                      disabled: webNewsRunning,
                    }, webNewsRunning ? '运行中' : '手工触发'),
                  ]),
                ]),
                h('tr', [
                  h('td', 'SEC 披露'),
                  h('td', [h('input', {
                    id: 'knowledgeCfgSECEnabled',
                    class: 'form-check-input',
                    type: 'checkbox',
                    checked: formState.value.secEnabled,
                    onChange: (event: Event) => updateFormState('secEnabled', (event.target as HTMLInputElement).checked),
                  })]),
                  h('td', [h('input', {
                    id: 'knowledgeCfgSECScheduleMinutes',
                    class: 'form-control form-control-sm',
                    type: 'number',
                    min: '1',
                    value: formState.value.secScheduleMinutes,
                    onInput: (event: Event) => updateFormState('secScheduleMinutes', (event.target as HTMLInputElement).value),
                  })]),
                  ...sourceRunStatusCellsWithIds('knowledgeCfgSEC', mainSources.value.sec),
                  h('td', [
                    h('button', {
                      id: 'knowledgeConfigSECBtn',
                      class: 'btn btn-outline-primary btn-sm',
                      type: 'button',
                      'data-knowledge-manual-run': 'sec_filing',
                      'data-knowledge-run-name': 'SEC 披露',
                      disabled: secRunning,
                    }, secRunning ? '运行中' : '手工触发'),
                  ]),
                ]),
              ]),
            ]),
          ]), 'border rounded p-3'),
        ]),
        h('div', { class: 'col-12' }, [
          section('独立新闻源', h('div', { class: 'table-responsive' }, [
            h('table', { class: 'table table-sm table-bordered align-middle mb-0' }, [
              h('thead', { class: 'table-info' }, [
                h('tr', [
                  h('th', { scope: 'col' }, '网站'),
                  h('th', { scope: 'col' }, '启用'),
                  h('th', { scope: 'col' }, '获取方式'),
                  h('th', { scope: 'col' }, '采集周期（分钟）'),
                  h('th', { scope: 'col' }, '最近调度'),
                  h('th', { scope: 'col' }, '结果'),
                  h('th', { scope: 'col' }, '数量'),
                  h('th', { scope: 'col', class: 'text-nowrap' }, '操作'),
                ]),
              ]),
              h('tbody', { id: 'knowledgeCfgNewsSources' }, renderNewsSourceRows(newsSources.value, pendingRunTargets, updateNewsSource)),
            ]),
          ]), 'border rounded p-3'),
        ]),
        h('div', { class: 'col-12' }, [
          section('推荐但未采集', h('div', { class: 'table-responsive' }, [
            h('table', { class: 'table table-sm table-bordered align-middle mb-0' }, [
              h('thead', { class: 'table-warning' }, [
                h('tr', [
                  h('th', { scope: 'col' }, '网站'),
                  h('th', { scope: 'col' }, '分类'),
                  h('th', { scope: 'col' }, '状态'),
                  h('th', { scope: 'col' }, '访问条件'),
                  h('th', { scope: 'col' }, '采集策略'),
                  h('th', { scope: 'col' }, '未采集原因'),
                  h('th', { scope: 'col' }, '下一步'),
                ]),
              ]),
              h('tbody', { id: 'knowledgeCfgNewsBacklog' }, renderBacklogRows(backlogSources.value)),
            ]),
          ]), 'border rounded p-3'),
        ]),
        h('div', { class: 'col-12' }, [
          h('textarea', {
            id: 'knowledgeConfigOutput',
            class: 'form-control form-control-sm font-monospace',
            rows: '4',
            readonly: true,
            value: uiState.value.outputText,
          }),
        ]),
      ])
      ])
    }
  },
})

const root = document.getElementById('knowledge-config-vue-root')
if (root) {
  createApp(KnowledgeConfigPage).mount(root)
}

