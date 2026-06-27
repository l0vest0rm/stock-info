type KnowledgeConfigFetchRequest = (request: {
  url?: string
  params?: Record<string, unknown>
  data?: unknown
  cacheKey?: string
  cacheTtl?: number
}) => Promise<unknown>

type KnowledgeConfigRuntimeContext = {
  server: string
  fetchRequest: KnowledgeConfigFetchRequest
  parseResponseData: (data: unknown, accept: string) => unknown
  escapeHtml: (value: unknown) => string
  alert: (message: string, type?: string) => void
}

export function createKnowledgeConfigInitializer(context: KnowledgeConfigRuntimeContext) {
  const { server, fetchRequest, parseResponseData, escapeHtml, alert } = context

  let knowledgeIngestConfig: any = null
  let knowledgeConfigPendingRunTargets: string[] = []
  let knowledgeConfigUiRevision = 0

  function knowledgeConfigNumber(id: string, fallback: number = 0): number {
    const elem = document.getElementById(id) as HTMLInputElement | null
    const value = parseInt(elem?.value || '')
    return Number.isFinite(value) ? value : fallback
  }

  function knowledgeConfigChecked(id: string): boolean {
    return Boolean((document.getElementById(id) as HTMLInputElement | null)?.checked)
  }

  function setKnowledgeConfigOutput(value: string) {
    renderKnowledgeConfigUiState({ outputText: value })
  }

  function buildKnowledgeConfigFormState(cfg: any): any {
    return {
      enabled: cfg.enabled ? 'true' : 'false',
      scheduleMinutes: String(Math.max(1, Math.round((cfg.scheduleEvery || 0) / 60000))),
      hours: String(cfg.hours || 24),
      topic: String(cfg.topic || 'ai'),
      outputDir: String(cfg.outputDir || ''),
      pageSize: String(cfg.pageSize || 50),
      scanPages: String(cfg.scanPages || 50),
      workers: String(cfg.workers || 1),
      maxChars: String(cfg.maxChars || 3000),
      commandPath: String(cfg.commandPath || 'bin/licai'),
      runOnStart: Boolean(cfg.runOnStart),
      webHelperFallback: Boolean(cfg.webHelperFallback),
      force: Boolean(cfg.force),
      clean: Boolean(cfg.clean),
      skipSummary: Boolean(cfg.skipSummary),
      skipArticle: Boolean(cfg.skipArticle),
      companyEnabled: Boolean(cfg.companyEnabled),
      industryEnabled: Boolean(cfg.industryEnabled),
      newsEnabled: Boolean(cfg.newsEnabled),
      secEnabled: Boolean(cfg.secEnabled),
      newsScheduleMinutes: String(Math.max(1, Math.round(((cfg.newsScheduleEvery || cfg.scheduleEvery || 0) / 60000)))),
      secScheduleMinutes: String(Math.max(1, Math.round(((cfg.secScheduleEvery || cfg.scheduleEvery || 0) / 60000)))),
    }
  }

  function renderKnowledgeConfigFormState(cfg: any) {
    const formState = buildKnowledgeConfigFormState(cfg || {})
    emitKnowledgeConfigFormState(formState)
  }

  function renderKnowledgeConfigUiState(uiState: any) {
    if (uiState && (
      Object.prototype.hasOwnProperty.call(uiState, 'outputText') ||
      Object.prototype.hasOwnProperty.call(uiState, 'pendingRunTargets')
    )) {
      knowledgeConfigUiRevision += 1
    }
    if (uiState && Object.prototype.hasOwnProperty.call(uiState, 'pendingRunTargets')) {
      knowledgeConfigPendingRunTargets = Array.isArray(uiState.pendingRunTargets)
        ? Array.from(new Set(uiState.pendingRunTargets.map((target: unknown) => String(target || '')).filter(Boolean)))
        : []
    }
    emitKnowledgeConfigUiState(uiState || {})
  }

  function addKnowledgeConfigPendingRunTarget(target: string) {
    if (!target) {
      return
    }
    renderKnowledgeConfigUiState({
      pendingRunTargets: Array.from(new Set([...knowledgeConfigPendingRunTargets, target])),
    })
  }

  function removeKnowledgeConfigPendingRunTarget(target: string) {
    if (!target) {
      return
    }
    renderKnowledgeConfigUiState({
      pendingRunTargets: knowledgeConfigPendingRunTargets.filter((item) => item !== target),
    })
  }

  function formatKnowledgeRunTime(value: unknown): string {
    if (!value) {
      return '-'
    }
    const date = new Date(String(value))
    if (Number.isNaN(date.getTime())) {
      return '-'
    }
    return date.toLocaleString('zh-CN', { hour12: false })
  }

  function formatKnowledgeRunDuration(value: unknown): string {
    const ms = Number(value || 0)
    if (!Number.isFinite(ms) || ms <= 0) {
      return '-'
    }
    if (ms < 1000) {
      return `${Math.round(ms)}ms`
    }
    return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`
  }

  function renderKnowledgeMainSourceConfig(sources: any[], cfg: any) {
    const sourceMap = new Map((sources || []).map((source) => [String(source.key || ''), source]))
    const scheduleMinutes = Math.max(1, Math.round((cfg.scheduleEvery || 0) / 60000))
    const scheduleText = `${scheduleMinutes} 分钟`
    emitKnowledgeConfigMainSources({
      company: sourceMap.get('company_report'),
      industry: sourceMap.get('industry_report'),
      news: sourceMap.get('web_news'),
      sec: sourceMap.get('sec_filing'),
      companyScheduleText: scheduleText,
      industryScheduleText: scheduleText
    })
  }

  function renderKnowledgeNewsSourceConfig(sources: any[], options?: { preserveDrafts?: boolean }) {
    emitKnowledgeConfigNewsSources(sources || [], options)
  }

  function renderKnowledgeNewsBacklog(sources: any[]) {
    emitKnowledgeConfigBacklog(sources || [])
  }

  function emitKnowledgeConfigMainSources(mainSources: any): boolean {
    window.dispatchEvent(new CustomEvent('licai:knowledge-config-main-sources', { detail: { mainSources } }))
    return true
  }

  function emitKnowledgeConfigFormState(formState: any): boolean {
    window.dispatchEvent(new CustomEvent('licai:knowledge-config-form-state', { detail: { formState } }))
    return true
  }

  function emitKnowledgeConfigUiState(uiState: any): boolean {
    window.dispatchEvent(new CustomEvent('licai:knowledge-config-ui-state', { detail: { uiState } }))
    return true
  }

  function emitKnowledgeConfigNewsSources(sources: any[], options?: { preserveDrafts?: boolean }): boolean {
    window.dispatchEvent(new CustomEvent('licai:knowledge-config-news-sources', {
      detail: {
        sources,
        preserveDrafts: Boolean(options?.preserveDrafts),
      },
    }))
    return true
  }

  function emitKnowledgeConfigBacklog(sources: any[]): boolean {
    window.dispatchEvent(new CustomEvent('licai:knowledge-config-backlog', { detail: { sources } }))
    return true
  }

  function collectKnowledgeNewsSourceConfig(): any[] {
    return Array.from(document.querySelectorAll('#knowledgeCfgNewsSources tr')).map((row) => {
      const elem = row as HTMLTableRowElement
      const getInput = (field: string) => elem.querySelector(`[data-field="${field}"]`) as HTMLInputElement | null
      const key = getInput('key')?.value.trim() || ''
      const name = getInput('name')?.value.trim() || key
      const scheduleMinutes = parseInt(getInput('scheduleMinutes')?.value || '30')
      const discoveryMethod = (getInput('discoveryMethod') as HTMLSelectElement | null)?.value || 'feed'
      return {
        key,
        name,
        enabled: Boolean(getInput('enabled')?.checked),
        scheduleEvery: (Number.isFinite(scheduleMinutes) ? scheduleMinutes : 30) * 60000,
        discoveryMethod
      }
    }).filter((source) => source.key)
  }

  async function loadKnowledgeConfig(options?: { skipOutput?: boolean, preserveNewsSourceDrafts?: boolean }) {
    const uiRevisionAtStart = knowledgeConfigUiRevision
    const data = await fetchRequest({ url: `${server}/api/knowledge/ingest-config` }) as any
    const cfg = data?.config || {}
    knowledgeIngestConfig = cfg
    renderKnowledgeConfigFormState(cfg)
    renderKnowledgeMainSourceConfig(data?.sources || [], cfg)
    renderKnowledgeNewsSourceConfig(data?.newsSources || cfg.newsSources || [], {
      preserveDrafts: Boolean(options?.preserveNewsSourceDrafts),
    })
    renderKnowledgeNewsBacklog(data?.newsSourceBacklog || [])
    if (uiRevisionAtStart !== knowledgeConfigUiRevision) {
      return
    }
    renderKnowledgeConfigUiState({
      savePending: false,
      saveButtonText: '保存',
      pendingRunTargets: [],
    })
    if (!options?.skipOutput) {
      setKnowledgeConfigOutput(JSON.stringify({ sources: data?.sources || [], newsSources: data?.newsSources || cfg.newsSources || [], newsSourceBacklog: data?.newsSourceBacklog || [] }, null, 2))
    }
  }

  function buildKnowledgeConfigPayload(): any {
    const cfg = { ...(knowledgeIngestConfig || {}) }
    cfg.enabled = (document.getElementById('knowledgeCfgEnabled') as HTMLSelectElement).value === 'true'
    cfg.scheduleEvery = knowledgeConfigNumber('knowledgeCfgScheduleMinutes', 30) * 60000
    cfg.hours = knowledgeConfigNumber('knowledgeCfgHours', 24)
    cfg.topic = (document.getElementById('knowledgeCfgTopic') as HTMLInputElement).value.trim() || 'ai'
    cfg.outputDir = (document.getElementById('knowledgeCfgOutputDir') as HTMLInputElement).value.trim()
    cfg.pageSize = knowledgeConfigNumber('knowledgeCfgPageSize', 50)
    cfg.scanPages = knowledgeConfigNumber('knowledgeCfgScanPages', 50)
    cfg.workers = knowledgeConfigNumber('knowledgeCfgWorkers', 1)
    cfg.maxChars = knowledgeConfigNumber('knowledgeCfgMaxChars', 3000)
    cfg.commandPath = (document.getElementById('knowledgeCfgCommandPath') as HTMLInputElement).value.trim() || 'bin/licai'
    cfg.runOnStart = knowledgeConfigChecked('knowledgeCfgRunOnStart')
    cfg.webHelperFallback = knowledgeConfigChecked('knowledgeCfgWebHelperFallback')
    cfg.force = knowledgeConfigChecked('knowledgeCfgForce')
    cfg.clean = knowledgeConfigChecked('knowledgeCfgClean')
    cfg.skipSummary = knowledgeConfigChecked('knowledgeCfgSkipSummary')
    cfg.skipArticle = knowledgeConfigChecked('knowledgeCfgSkipArticle')
    cfg.companyEnabled = knowledgeConfigChecked('knowledgeCfgCompanyEnabled')
    cfg.industryEnabled = knowledgeConfigChecked('knowledgeCfgIndustryEnabled')
    cfg.newsEnabled = knowledgeConfigChecked('knowledgeCfgNewsEnabled')
    cfg.secEnabled = knowledgeConfigChecked('knowledgeCfgSECEnabled')
    cfg.newsScheduleEvery = knowledgeConfigNumber('knowledgeCfgNewsScheduleMinutes', Math.max(1, Math.round((cfg.scheduleEvery || 1800000) / 60000))) * 60000
    cfg.secScheduleEvery = knowledgeConfigNumber('knowledgeCfgSECScheduleMinutes', Math.max(1, Math.round((cfg.scheduleEvery || 1800000) / 60000))) * 60000
    delete cfg.companyLimit
    delete cfg.industryLimit
    delete cfg.newsLimit
    delete cfg.secLimit
    cfg.newsSources = collectKnowledgeNewsSourceConfig()
    return cfg
  }

  async function saveKnowledgeConfig() {
    renderKnowledgeConfigUiState({
      savePending: true,
      saveButtonText: '保存中...',
      outputText: '保存中...',
    })
    try {
      const data = await fetchRequest({
        url: `${server}/api/knowledge/ingest-config`,
        data: buildKnowledgeConfigPayload()
      }) as any
      knowledgeIngestConfig = data?.config || knowledgeIngestConfig
      renderKnowledgeConfigFormState(knowledgeIngestConfig || {})
      renderKnowledgeMainSourceConfig(data?.sources || [], knowledgeIngestConfig || {})
      renderKnowledgeNewsSourceConfig(data?.newsSources || knowledgeIngestConfig?.newsSources || [])
      renderKnowledgeNewsBacklog(data?.newsSourceBacklog || [])
      renderKnowledgeConfigUiState({
        savePending: false,
        saveButtonText: '保存',
        outputText: '保存成功，调度器已热重载；输出目录等服务级配置仍建议重启服务后完全生效。\n\n' + JSON.stringify({ sources: data?.sources || [], newsSources: data?.newsSources || [], newsSourceBacklog: data?.newsSourceBacklog || [] }, null, 2),
      })
    } catch (error) {
      renderKnowledgeConfigUiState({
        savePending: false,
        saveButtonText: '保存',
        outputText: `保存失败：${error instanceof Error ? error.message : String(error)}`,
      })
      throw error
    } finally {
      renderKnowledgeConfigUiState({
        savePending: false,
        saveButtonText: '保存',
      })
    }
  }

  async function triggerKnowledgeManualRun(target: string, runName: string, button?: HTMLButtonElement | null) {
    const triggerButton = button || document.querySelector(`[data-knowledge-manual-run="${target}"]`) as HTMLButtonElement | null
    if (!target) {
      return
    }
    const label = runName || target
    addKnowledgeConfigPendingRunTarget(target)
    setKnowledgeConfigOutput(`正在触发 ${label}...`)
    let refreshed = false
    try {
      const response = await fetch(`${server}/api/knowledge/ingest-run`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ target })
      })
      const contentType = response.headers.get('Content-Type')?.split(';')[0] || ''
      const payload = contentType === 'application/json' ? await response.json() : await response.text()
      if (!response.ok) {
        let message = `${response.status} ${response.statusText}`
        if (typeof payload === 'string' && payload.trim() !== '') {
          message = `${response.status} ${payload.trim()}`
        } else if (payload && typeof payload === 'object') {
          const serverPayload = payload as { code?: number; msg?: string }
          message = `${serverPayload.code || response.status} ${serverPayload.msg || response.statusText}`
        }
        throw new Error(message)
      }
      const serverPayload = payload as { code?: number; msg?: string; data?: unknown }
      if (serverPayload?.code !== 200) {
        throw new Error(`${serverPayload?.code || ''} ${serverPayload?.msg || 'request failed'}`.trim())
      }
      const data = parseResponseData(serverPayload.data, '') as any
      await loadKnowledgeConfig({ skipOutput: true, preserveNewsSourceDrafts: true })
      refreshed = true
      setKnowledgeConfigOutput(
        `已触发 ${label}，后台运行中。这里使用的是当前已保存配置，未保存的表单改动不会参与这次运行。\n\n` +
        JSON.stringify(data || {}, null, 2)
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const hint = message.includes('405') || message.includes('Method Not Allowed')
        ? '\n\n当前运行的 licai-server 还没加载这个新接口，重启服务后再试。'
        : ''
      setKnowledgeConfigOutput(`触发 ${label} 失败：${message}${hint}`)
      alert(`触发 ${label} 失败：${message}${hint}`, 'danger')
    } finally {
      if (!refreshed) {
        removeKnowledgeConfigPendingRunTarget(target)
      }
    }
  }

  function initKnowledgeConfig() {
    document.getElementById('knowledgeConfigSaveBtn')?.addEventListener('click', () => void saveKnowledgeConfig())
    document.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null
      const button = target?.closest('[data-knowledge-manual-run]') as HTMLButtonElement | null
      if (!button) {
        return
      }
      const runTarget = button.dataset.knowledgeManualRun || ''
      const runName = button.dataset.knowledgeRunName || runTarget
      void triggerKnowledgeManualRun(runTarget, runName, button)
    })
    void loadKnowledgeConfig()
  }

  return initKnowledgeConfig
}
