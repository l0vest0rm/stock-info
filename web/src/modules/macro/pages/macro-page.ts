import { createApp, defineComponent, h, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

declare const echarts: any

type Quality = 'fresh' | 'stale' | 'missing'
type MacroIndicator = {
  id: string; name: string; category: string; region: string; frequency: string; unit: string
  transmission: string; interpretation: string; latest: number | null; previous: number | null
  change: number | null; latestDate: string | null; ageDays: number | null; quality: Quality
}
type Dashboard = {
  generatedAt: string
  source: { id: string; name: string; url: string }
  indicators: MacroIndicator[]
  status: { state: string; total: number; fresh: number; stale: number; missing: number; error?: string | null }
}
type SeriesResponse = Array<{ definition: MacroIndicator; points: Array<{ date: string; value: number }> }>
type MacroEvent = {
  id?: string; eventId?: string; scheduledAt?: string | number; region?: string; importance?: string
  title?: string; actual?: number | string | null; consensus?: number | string | null; previous?: number | string | null
  metadata?: { timePrecision?: string }
}
type EventsResponse = { events: MacroEvent[]; status?: string; message?: string }
type RevisionSummary = { observationDate: string; firstValue: number; latestValue: number; delta: number; revisionCount: number; firstSeenAt: number; latestSeenAt: number }
type SignalContribution = { factor: string; seriesId?: string; contribution: number; signal: number | null; weight: number; quality: Quality; freshnessWeight: number }
type SignalMarket = {
  market: string; score: number | null; confidence: number; confidenceLevel: 'high' | 'medium' | 'low' | 'unavailable'
  coverage: { configured: number; available: number; fresh: number; stale: number; missing: number; configuredWeight: number; availableWeight: number; effectiveWeight: number }
  contributions: SignalContribution[]
}
type IndustrySignal = { id: string; market: string; name: string; score: number | null; coverage: { available: number; configured: number }; contributions: Array<{ seriesId: string; contribution: number }> }
type SourceHealth = { sourceId: string; displayName: string; state: 'healthy' | 'degraded' | 'failed' | 'disabled'; lastSuccessAt: number | null; lastError: string | null; nextRetryAt: number | null }

const categoryLabels: Record<string, string> = {
  all: '全部', growth: '增长', inflation: '通胀', rates: '利率', liquidity: '流动性', credit: '信用', fx: '汇率与资金',
}
const transmissionLabels: Record<string, string> = {
  earnings: '盈利', discount: '折现率', risk: '风险溢价', flow: '资金流', funding: '融资成本',
}
const regionLabels: Record<string, string> = { global: '全球', us: '美国', cn: '中国', hk: '香港', kr: '韩国' }
const marketCards = [
  { region: 'us', title: '美股', subtitle: '盈利 × 美联储 × 实际利率', focus: '实际利率、就业、通胀与美元金融条件' },
  { region: 'cn', title: 'A股', subtitle: '国内信用 × 政策 × 人民币', focus: '首版已接人民币价格信号，社融与政策数据待接入' },
  { region: 'hk', title: '港股', subtitle: '中国盈利 × 美元利率 × 离岸流动性', focus: '已接港元、HIBOR和全球利率，中国增长数据依赖官方源' },
  { region: 'kr', title: '韩国', subtitle: '半导体 × 出口 × 韩元', focus: '首版已接韩元和全球金融条件，ECOS/KOSIS待接入' },
]
const macroDimensions = [
  { key: 'growth', label: '增长', categories: ['growth'], description: '收入与盈利周期' },
  { key: 'inflation', label: '通胀', categories: ['inflation'], description: '政策约束与利润率' },
  { key: 'liquidity', label: '流动性', categories: ['rates', 'liquidity'], description: '折现率与融资条件' },
  { key: 'credit', label: '信用', categories: ['credit'], description: '融资可得性与违约风险' },
  { key: 'external', label: '外部风险', categories: ['fx'], description: '美元、汇率与跨境资金' },
]
const heatmapFactors = [
  { key: 'growth', label: '增长' }, { key: 'inflation', label: '通胀' }, { key: 'rates', label: '利率' },
  { key: 'liquidity', label: '流动性' }, { key: 'credit', label: '信用' }, { key: 'fx', label: '汇率/资金' },
]

const style = `
.macro-page{background:#f4f7f8;box-sizing:border-box;color:#172b2a;min-height:calc(100vh - 8rem);max-width:100vw;overflow-x:hidden;width:100%}.macro-shell{box-sizing:border-box;max-width:1440px;min-width:0;margin:0 auto;padding:1.25rem}
.macro-hero{background:radial-gradient(circle at 88% 20%,rgba(103,232,192,.24),transparent 22rem),linear-gradient(135deg,#082f2d,#123a67);border-radius:1.4rem;color:#f8fafc;padding:1.5rem}
.macro-eyebrow{color:#8fe3c7;font-size:.78rem;font-weight:800;letter-spacing:.12em}.macro-hero h1{font-size:clamp(1.65rem,3vw,2.5rem);margin:.35rem 0}.macro-hero p{color:#d8e6e4;max-width:52rem;margin:0}
.macro-status{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.16);border-radius:1rem;padding:1rem;min-width:15rem}.macro-grid{display:grid;gap:1rem}.macro-market-grid{grid-template-columns:repeat(4,minmax(0,1fr))}
  .macro-market-card,.macro-panel,.macro-indicator{background:#fff;border:1px solid #dfe9e8;border-radius:1rem;box-shadow:0 .5rem 1.3rem rgba(15,52,51,.05)}.macro-market-card{padding:1rem}.macro-market-card h2{font-size:1.15rem;margin:0;color:#123a67}.macro-market-score{font-size:1.65rem;font-weight:850;line-height:1;margin:.8rem 0 .25rem}.macro-market-score.support{color:#087f5b}.macro-market-score.pressure{color:#b42318}.macro-market-score.observe{color:#64748b}.macro-driver-list{border-top:1px solid #edf2f1;display:grid;gap:.35rem;margin-top:.8rem;padding-top:.65rem}.macro-driver{display:flex;font-size:.76rem;gap:.4rem;justify-content:space-between}.macro-driver span:last-child{font-variant-numeric:tabular-nums;font-weight:750}.macro-driver-support{color:#087f5b}.macro-driver-pressure{color:#b42318}
.macro-market-subtitle{color:#0f766e;font-size:.85rem;font-weight:700;margin:.4rem 0}.macro-market-focus{color:#64748b;font-size:.85rem;min-height:2.6rem}.macro-pill{border-radius:999px;display:inline-flex;font-size:.75rem;font-weight:700;padding:.28rem .58rem}
.macro-pill-fresh{background:#dcfce7;color:#166534}.macro-pill-stale{background:#fef3c7;color:#92400e}.macro-pill-missing{background:#fee2e2;color:#991b1b}.macro-pill-pending{background:#e2e8f0;color:#475569}.macro-panel{padding:1rem}.macro-panel-title{color:#123a67;font-size:1.05rem;font-weight:800;margin:0}
.macro-tabs{display:flex;flex-wrap:wrap;gap:.45rem}.macro-tab{background:#fff;border:1px solid #cbdad8;border-radius:999px;color:#49615f;padding:.38rem .78rem}.macro-tab.active{background:#0f766e;border-color:#0f766e;color:#fff}.macro-indicator-grid{grid-template-columns:repeat(3,minmax(0,1fr))}
.macro-indicator{cursor:pointer;padding:1rem;text-align:left;transition:transform .15s,border-color .15s;width:100%}.macro-indicator:hover,.macro-indicator.active{border-color:#0f766e;transform:translateY(-1px)}.macro-indicator-name{color:#304b49;font-size:.86rem;font-weight:750}.macro-value{color:#0b3b2e;font-size:1.55rem;font-weight:800;line-height:1.2;margin:.45rem 0}
.macro-change-up{color:#b42318}.macro-change-down{color:#087f5b}.macro-meta{color:#71817f;font-size:.78rem}.macro-chart{height:360px;width:100%}.macro-note{background:#f8fafc;border-left:3px solid #14b8a6;color:#526462;font-size:.86rem;padding:.75rem}.macro-error{background:#fff1f2;border:1px solid #fecdd3;border-radius:.8rem;color:#9f1239;padding:1rem}
  .macro-dimension-grid{grid-template-columns:repeat(5,minmax(0,1fr))}.macro-dimension{background:rgba(255,255,255,.09);border:1px solid rgba(255,255,255,.14);border-radius:.85rem;padding:.8rem}.macro-dimension-label{font-size:.78rem;color:#b8d7d3}.macro-dimension-state{font-size:1rem;font-weight:800;margin:.18rem 0}.macro-dimension-detail{font-size:.72rem;color:#cfe0df}.macro-source-health{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:1rem}.macro-source-item{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.13);border-radius:.6rem;color:#d8e6e4;font-size:.72rem;padding:.45rem .6rem}.macro-source-item strong{color:#fff}.macro-source-item.failed{border-color:rgba(253,186,116,.6);color:#fde68a}
.macro-section-head{display:flex;justify-content:space-between;align-items:start;gap:1rem;margin-bottom:1rem}.macro-pending-box{background:#f8fafc;border:1px dashed #a9bbb9;border-radius:.8rem;color:#526462;padding:1rem}.macro-pending-box strong{color:#334155}.macro-heat-wrap{overflow-x:auto}.macro-heatmap{border-collapse:separate;border-spacing:.35rem;min-width:720px;width:100%}.macro-heatmap th{color:#64748b;font-size:.75rem;text-align:center;padding:.35rem}.macro-heatmap th:first-child{text-align:left}.macro-heatmap td{border-radius:.55rem;font-size:.75rem;font-weight:750;height:3.3rem;min-width:5.8rem;text-align:center}.macro-heat-live{background:#d1fae5;color:#166534}.macro-heat-partial{background:#fef3c7;color:#92400e}.macro-heat-pending{background:#eef2f5;color:#64748b}.macro-heat-error{background:#fee2e2;color:#991b1b}.macro-heat-support{background:#dcfce7;color:#166534}.macro-heat-pressure{background:#fee2e2;color:#991b1b}.macro-event-list{display:grid;gap:.65rem}.macro-event{border-left:3px solid #cbd5e1;background:#f8fafc;padding:.7rem .85rem}.macro-event-time{font-variant-numeric:tabular-nums;color:#0f766e;font-size:.78rem;font-weight:750}.macro-research-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.macro-research-card{border:1px solid #dfe9e8;border-radius:.85rem;padding:1rem;min-height:12rem}.macro-research-card h3{color:#123a67;font-size:.95rem;font-weight:800}.macro-field{background:#fff;border:1px solid #cbdad8;border-radius:.5rem;padding:.48rem .65rem;width:100%}.macro-watch-list{display:grid;gap:.45rem;max-height:15rem;overflow:auto}.macro-watch-row{align-items:center;background:#f8fafc;border-radius:.55rem;display:flex;gap:.55rem;padding:.55rem}.macro-table{font-size:.82rem;margin:0}.macro-stage{background:linear-gradient(135deg,#f8fafc,#edf7f5);border:1px solid #dbe8e6;border-radius:.75rem;padding:.85rem}.macro-stage-number{align-items:center;background:#0f766e;border-radius:999px;color:#fff;display:inline-flex;font-size:.7rem;font-weight:800;height:1.45rem;justify-content:center;width:1.45rem}
.macro-sector-grid{display:grid;gap:.65rem;grid-template-columns:repeat(3,minmax(0,1fr))}.macro-sector{background:#f8fafc;border-radius:.7rem;padding:.75rem}.macro-sector-score{font-size:1.15rem;font-weight:800}.macro-sector-support{color:#087f5b}.macro-sector-pressure{color:#b42318}
@media(max-width:991px){.macro-market-grid{grid-template-columns:repeat(2,1fr)}.macro-indicator-grid{grid-template-columns:repeat(2,1fr)}.macro-dimension-grid{grid-template-columns:repeat(3,1fr)}.macro-research-grid{grid-template-columns:1fr 1fr}.macro-sector-grid{grid-template-columns:repeat(2,1fr)}}@media(max-width:575px){.macro-shell{padding:.75rem}.macro-market-grid,.macro-indicator-grid,.macro-dimension-grid,.macro-research-grid,.macro-sector-grid{grid-template-columns:1fr}.macro-chart{height:300px}.macro-section-head{display:block}.macro-section-head>*+*{margin-top:.55rem}}
`

function formatValue(value: number | null, unit: string): string {
  if (value === null) return '--'
  return `${value.toLocaleString('zh-CN', { maximumFractionDigits: Math.abs(value) >= 100 ? 1 : 2 })}${unit === '%' ? '%' : ''}`
}
function qualityLabel(quality: Quality): string {
  return quality === 'fresh' ? '数据正常' : quality === 'stale' ? '数据过期' : '数据缺失'
}
function marketVerdict(score: number | null, confidenceLevel: SignalMarket['confidenceLevel'] | undefined): { label: string; className: string; detail: string } {
  if (score === null || confidenceLevel === 'unavailable') return { label: '证据不足', className: 'observe', detail: '等待已验证数据覆盖' }
  if (confidenceLevel === 'low') return { label: '低置信观察', className: 'observe', detail: '覆盖不足或含较多过期数据' }
  if (score >= 0.35) return { label: '宏观支持', className: 'support', detail: '综合传导偏正向' }
  if (score <= -0.35) return { label: '宏观压力', className: 'pressure', detail: '综合传导偏负向' }
  return { label: '中性观察', className: 'observe', detail: '支持与压力暂时均衡' }
}
function formatScore(value: number | null | undefined): string {
  return value === null || value === undefined ? '--' : `${value >= 0 ? '+' : ''}${value.toFixed(2)}`
}
function eventImportanceLabel(value: string | undefined): string {
  return value === 'high' ? '高重要性' : value === 'medium' ? '中等重要性' : value === 'low' ? '低重要性' : '待分类'
}

const MacroPage = defineComponent({
  name: 'MacroPage',
  setup() {
    const dashboard = ref<Dashboard | null>(null)
    const loading = ref(true)
    const error = ref('')
    const activeCategory = ref('all')
    const selectedId = ref('DFII10')
    const events = ref<MacroEvent[]>([])
    const eventStatus = ref('loading')
    const eventMessage = ref('')
    const watchedIds = ref<string[]>([])
    const alertEnabled = ref(false)
    const alertThreshold = ref('')
    const alertNotice = ref('')
    const revisions = ref<RevisionSummary[]>([])
    const signalMarkets = ref<SignalMarket[]>([])
    const industrySignals = ref<IndustrySignal[]>([])
    const sourceHealth = ref<SourceHealth[]>([])
    const replayFrom = ref(dateYearsAgo(1))
    const replayTo = ref(localDateInput())
    const scenarioResult = ref<any>(null)
    const researchMarket = ref('us')
    const correlationResult = ref<any>(null)
    const backtestResult = ref<any>(null)
    const backtestMode = ref('point-in-time')
    const researchBusy = ref(false)
    let chart: any = null

    const filteredIndicators = () => (dashboard.value?.indicators ?? []).filter((item) => activeCategory.value === 'all' || item.category === activeCategory.value)
    const dimensionState = (categories: string[]) => {
      const items = (dashboard.value?.indicators ?? []).filter((item) => categories.includes(item.category))
      const usable = items.filter((item) => item.quality === 'fresh').length
      const impaired = items.filter((item) => item.quality === 'stale').length
      if (usable > 0) return { label: '可观测', className: 'macro-pill-fresh', detail: `${usable}/${items.length} 项数据正常` }
      if (impaired > 0) return { label: '数据过期', className: 'macro-pill-stale', detail: `${impaired} 项需更新` }
      return { label: '待接入', className: 'macro-pill-pending', detail: '尚无可计算信号' }
    }
    const marketSignal = (region: string) => signalMarkets.value.find((item) => item.market === region)
    const driverLabel = (entry: SignalContribution) => dashboard.value?.indicators.find((item) => item.id === entry.seriesId)?.name ?? entry.seriesId ?? entry.factor.split('/').at(-1) ?? entry.factor
    const sourceIssues = () => sourceHealth.value.filter((item) => item.state === 'failed' || item.state === 'degraded')
    const heatCell = (region: string, category: string) => {
      const signal = marketSignal(region)
      const contributions = signal?.contributions.filter((item) => item.factor.startsWith(`${category}/`) && item.freshnessWeight > 0) ?? []
      if (contributions.length) {
        const score = contributions.reduce((sum, item) => sum + item.contribution, 0)
        return { className: score >= 0 ? 'macro-heat-support' : 'macro-heat-pressure', label: `${score >= 0 ? '+' : ''}${score.toFixed(2)}` }
      }
      const items = (dashboard.value?.indicators ?? []).filter((item) => item.category === category && (item.region === region || item.region === 'global'))
      const fresh = items.filter((item) => item.quality === 'fresh').length
      const stale = items.filter((item) => item.quality === 'stale').length
      if (fresh > 0 && fresh === items.length) return { className: 'macro-heat-live', label: `${fresh} 项正常` }
      if (fresh > 0) return { className: 'macro-heat-partial', label: `${fresh}/${items.length} 项正常` }
      if (stale > 0) return { className: 'macro-heat-error', label: `${stale} 项过期` }
      return { className: 'macro-heat-pending', label: '待接入' }
    }
    const toggleWatch = async (id: string) => {
      const enabled = !watchedIds.value.includes(id)
      watchedIds.value = enabled ? [...watchedIds.value, id] : watchedIds.value.filter((item) => item !== id)
      localStorage.setItem('macro-watched-series', JSON.stringify(watchedIds.value))
      try { await api('/api/macro/watch', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ ownerKey:'local', seriesId:id, enabled }) }) } catch (err) { alertNotice.value = err instanceof Error ? err.message : String(err) }
    }
    const saveAlert = async () => {
      localStorage.setItem('macro-alert-config', JSON.stringify({ enabled: alertEnabled.value, threshold: alertThreshold.value }))
      const threshold = Number(alertThreshold.value)
      if (!selectedId.value || !Number.isFinite(threshold)) { alertNotice.value = '请选择指标并填写有效阈值。'; return }
      try {
        await api('/api/macro/watch', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ ownerKey:'local', seriesId:selectedId.value, enabled:alertEnabled.value, alertRules:[{operator:'gte',threshold}] }) })
        const evaluated = await api('/api/macro/alerts/evaluate?owner=local')
        alertNotice.value = `规则已保存并执行；当前触发 ${evaluated.triggered?.length ?? 0} 项，通知渠道尚未配置。`
      } catch (err) { alertNotice.value = err instanceof Error ? err.message : String(err) }
    }
    const api = async (url: string, init?: RequestInit): Promise<any> => {
      const response = await fetch(url, init); const body = await response.json()
      if (!response.ok || body.code !== 200) throw new Error(body.msg || `请求失败：${url}`)
      return body.data
    }
    const loadWatches = async () => {
      try { const rows = await api('/api/macro/watch?owner=local'); if (Array.isArray(rows) && rows.length) watchedIds.value = rows.filter((item:any)=>item.enabled).map((item:any)=>item.seriesId) } catch { /* localStorage remains the offline preference. */ }
    }
    const loadSignals = async () => {
      try { const data = await api('/api/macro/signals'); signalMarkets.value = Array.isArray(data.markets) ? data.markets : [] } catch { signalMarkets.value = [] }
    }
    const loadIndustries = async () => {
      try { const data = await api('/api/macro/research/industries?markets=us,cn,hk,kr'); industrySignals.value = Array.isArray(data.sectors) ? data.sectors : [] } catch { industrySignals.value = [] }
    }
    const loadSourceHealth = async () => {
      try { const data = await api('/api/macro/status'); sourceHealth.value = Array.isArray(data.sources) ? data.sources : [] } catch { sourceHealth.value = [] }
    }
    const loadRevisions = async (id: string) => {
      try { const data = await api(`/api/macro/revisions?id=${encodeURIComponent(id)}&from=${dateYearsAgo(3)}`); revisions.value = Array.isArray(data.revisions) ? data.revisions : [] } catch { revisions.value = [] }
    }
    const runScenario = async () => {
      researchBusy.value = true
      try { scenarioResult.value = await api(`/api/macro/research/scenario?ids=${encodeURIComponent(watchedIds.value.length ? watchedIds.value.slice(0,5).join(',') : selectedId.value)}&from=${replayFrom.value}&to=${replayTo.value}&asOf=${encodeURIComponent(`${replayTo.value}T23:59:59Z`)}`) } catch (err) { scenarioResult.value = { error:err instanceof Error?err.message:String(err) } } finally { researchBusy.value = false }
    }
    const runCorrelation = async () => {
      researchBusy.value = true
      try { correlationResult.value = await api(`/api/macro/research/correlation?seriesId=${encodeURIComponent(selectedId.value)}&market=${researchMarket.value}&window=20&from=${dateYearsAgo(5)}`) } catch (err) { correlationResult.value = { error:err instanceof Error?err.message:String(err) } } finally { researchBusy.value = false }
    }
    const runBacktest = async () => {
      researchBusy.value = true
      try { backtestResult.value = await api(`/api/macro/research/backtest?seriesId=${encodeURIComponent(selectedId.value)}&market=${researchMarket.value}&transform=zscore&operator=gte&threshold=1&horizon=20&from=${dateYearsAgo(10)}&vintageMode=${backtestMode.value}`) } catch (err) { backtestResult.value = { error:err instanceof Error?err.message:String(err) } } finally { researchBusy.value = false }
    }
    const loadEvents = async () => {
      try {
        const from = localDateInput()
        const toDate = new Date(); toDate.setDate(toDate.getDate() + 7)
        const response = await fetch(`/api/macro/events?from=${from}&to=${localDateInput(toDate)}&regions=us,cn,hk,kr`)
        const body = await response.json()
        if (!response.ok || body.code !== 200) throw new Error(body.msg || '加载经济日历失败')
        const data = body.data as EventsResponse
        events.value = data.events ?? []; eventStatus.value = data.status ?? (events.value.length ? 'ready' : 'empty'); eventMessage.value = data.message ?? ''
      } catch (err) {
        eventStatus.value = 'error'; eventMessage.value = err instanceof Error ? err.message : String(err)
      }
    }
    const renderChart = async (id: string) => {
      selectedId.value = id
      try {
        void loadRevisions(id)
        const response = await fetch(`/api/macro/series?ids=${encodeURIComponent(id)}&from=${dateYearsAgo(3)}`)
        const body = await response.json()
        if (!response.ok || body.code !== 200) throw new Error(body.msg || '加载序列失败')
        const series = (body.data as SeriesResponse)[0]
        await nextTick()
        const element = document.getElementById('macro-series-chart')
        if (!element || typeof echarts === 'undefined') return
        chart = echarts.getInstanceByDom(element) || echarts.init(element)
        chart.setOption({
          animationDuration:350, grid:{left:52,right:24,top:32,bottom:48}, tooltip:{trigger:'axis'},
          xAxis:{type:'category',data:series?.points.map((point)=>point.date)??[],boundaryGap:false}, yAxis:{type:'value',name:series?.definition.unit??''},
          dataZoom:[{type:'inside'},{type:'slider',height:18,bottom:8}],
          series:[{name:series?.definition.name??id,type:'line',data:series?.points.map((point)=>point.value)??[],showSymbol:false,lineStyle:{color:'#0f766e',width:2},areaStyle:{color:'rgba(20,184,166,.10)'}}],
        }, true)
      } catch (err) { error.value = err instanceof Error ? err.message : String(err) }
    }
    const loadDashboard = async () => {
      loading.value = true; error.value = ''
      try {
        const response = await fetch('/api/macro/dashboard?regions=us,cn,hk,kr')
        const body = await response.json()
        if (!response.ok || body.code !== 200) throw new Error(body.msg || '加载宏观数据失败')
        dashboard.value = body.data as Dashboard
        const first = dashboard.value.indicators.find((item) => item.id === selectedId.value) ?? dashboard.value.indicators[0]
        if (first) await renderChart(first.id)
      } catch (err) { error.value = err instanceof Error ? err.message : String(err) } finally { loading.value = false }
    }
    const onResize = () => chart?.resize()
    onMounted(() => {
      window.addEventListener('resize', onResize)
      try {
        const storedWatch = JSON.parse(localStorage.getItem('macro-watched-series') ?? '[]')
        if (Array.isArray(storedWatch)) watchedIds.value = storedWatch.filter((item): item is string => typeof item === 'string')
        const storedAlert = JSON.parse(localStorage.getItem('macro-alert-config') ?? '{}')
        alertEnabled.value = storedAlert.enabled === true; alertThreshold.value = typeof storedAlert.threshold === 'string' ? storedAlert.threshold : ''
      } catch { /* Ignore malformed local preferences. */ }
      void Promise.all([loadDashboard(), loadEvents(), loadSignals(), loadIndustries(), loadWatches(), loadSourceHealth()])
    })
    onBeforeUnmount(() => { window.removeEventListener('resize', onResize); chart?.dispose() })

    return () => h('main', { class:'macro-page' }, [h('style', style), h('div', { class:'macro-shell' }, [
      h('section', { class:'macro-hero' }, [
        h('div',{class:'d-lg-flex justify-content-between align-items-center gap-4'},[
          h('div', [h('div',{class:'macro-eyebrow'},'GLOBAL MACRO RADAR'),h('h1','全球宏观雷达'),h('p','从盈利、折现率、风险溢价和资金流四条路径，观察全球宏观变化对美股、A股、港股和韩国市场的影响。')]),
          h('div',{class:'macro-status mt-3 mt-lg-0'},dashboard.value?[h('div',{class:'small text-uppercase opacity-75'},'数据健康'),h('div',{class:'fs-4 fw-bold my-1'},dashboard.value.status.state==='healthy'?'正常':'需要关注'),h('div',{class:'small opacity-75'},`${dashboard.value.status.fresh} 正常 · ${dashboard.value.status.stale} 过期 · ${dashboard.value.status.missing} 缺失`),dashboard.value.status.error?h('div',{class:'small text-warning mt-1'},dashboard.value.status.error):null,h('div',{class:'small opacity-75 mt-1'},`生成于 ${new Date(dashboard.value.generatedAt).toLocaleString('zh-CN')}`)]:h('div',loading.value?'正在加载数据…':'暂无数据')),
        ]),
        h('div',{class:'macro-grid macro-dimension-grid mt-4'},macroDimensions.map((dimension)=>{const state=dimensionState(dimension.categories);return h('div',{class:'macro-dimension',key:dimension.key},[h('div',{class:'d-flex justify-content-between align-items-center'},[h('div',{class:'macro-dimension-label'},dimension.label),h('span',{class:`macro-pill ${state.className}`},state.label)]),h('div',{class:'macro-dimension-state'},dimension.description),h('div',{class:'macro-dimension-detail'},state.detail)])})),
        sourceIssues().length?h('div',{class:'macro-source-health'},sourceIssues().map((item)=>h('div',{class:'macro-source-item failed',key:item.sourceId},[h('strong',item.displayName),h('span',` · ${item.lastError??'需要检查'}`)]))):null,
      ]),
      error.value?h('div',{class:'macro-error mt-3'},[error.value,h('button',{class:'btn btn-sm btn-outline-danger ms-3',onClick:loadDashboard},'重试')]):null,
      h('section',{class:'mt-4'},[
        h('div',{class:'d-flex justify-content-between align-items-end mb-2'},[h('div',[h('h2',{class:'macro-panel-title'},'市场传导框架'),h('div',{class:'macro-meta mt-1'},'同一宏观冲击在不同市场具有不同权重')]),h('span',{class:'macro-pill macro-pill-pending'},'权重配置可审计')]),
        h('div',{class:'macro-grid macro-market-grid'},marketCards.map((market)=>{const signal=marketSignal(market.region);const verdict=marketVerdict(signal?.score??null,signal?.confidenceLevel);const drivers=signal?.contributions.filter((item)=>item.freshnessWeight>0).slice(0,2)??[];return h('article',{class:'macro-market-card',key:market.region},[h('div',{class:'d-flex justify-content-between align-items-center'},[h('h2',market.title),h('span',{class:`macro-pill ${verdict.className==='support'?'macro-pill-fresh':verdict.className==='pressure'?'macro-pill-missing':'macro-pill-pending'}`},verdict.label)]),h('div',{class:'macro-market-subtitle'},market.subtitle),h('div',{class:`macro-market-score ${verdict.className}`},formatScore(signal?.score)),h('div',{class:'macro-meta'},signal?`置信度 ${Math.round(signal.confidence*100)}% · 新鲜 ${signal.coverage.fresh}/${signal.coverage.configured} · 过期 ${signal.coverage.stale}`:verdict.detail),h('div',{class:'macro-market-focus'},verdict.detail),drivers.length?h('div',{class:'macro-driver-list'},drivers.map((driver)=>h('div',{class:'macro-driver',key:`${market.region}-${driver.factor}`},[h('span',driverLabel(driver)),h('span',{class:driver.contribution>=0?'macro-driver-support':'macro-driver-pressure'},formatScore(driver.contribution))]))):h('div',{class:'macro-driver-list macro-meta'},'尚无可用的因子贡献')])})),
      ]),
      h('section',{class:'macro-panel mt-4'},[
        h('div',{class:'macro-section-head'},[h('div',[h('h2',{class:'macro-panel-title'},'市场 × 因子热力图'),h('div',{class:'macro-meta mt-1'},'有历史数据时展示60期标准化信号×配置敏感度；否则展示覆盖状态')]),h('span',{class:`macro-pill ${signalMarkets.value.length?'macro-pill-fresh':'macro-pill-pending'}`},signalMarkets.value.length?'可审计因子贡献':'数据不足')]),
        h('div',{class:'macro-heat-wrap'},[
          h('table',{class:'macro-heatmap'},[
            h('thead',[h('tr',[h('th','市场 / 因子'),...heatmapFactors.map((factor)=>h('th',{key:factor.key},factor.label))])]),
            h('tbody',marketCards.map((market)=>h('tr',{key:market.region},[
              h('th',market.title),
              ...heatmapFactors.map((factor)=>{const cell=heatCell(market.region,factor.key);return h('td',{class:cell.className,key:factor.key},cell.label)}),
            ]))),
          ]),
        ]),
      ]),
      h('section',{class:'macro-panel mt-4'},[
        h('div',{class:'macro-section-head'},[h('div',[h('h2',{class:'macro-panel-title'},'未来 7 天经济日历'),h('div',{class:'macro-meta mt-1'},'实际值、市场一致预期、前值与修订值仅展示上游返回内容')]),h('span',{class:`macro-pill ${eventStatus.value==='ready'?'macro-pill-fresh':eventStatus.value==='error'?'macro-pill-missing':'macro-pill-pending'}`},eventStatus.value==='ready'?`${events.value.length} 项事件`:eventStatus.value==='error'?'加载失败':'数据源待接入')]),
        events.value.length?h('div',{class:'macro-event-list'},events.value.map((event,index)=>h('article',{class:'macro-event',key:event.id??event.eventId??index},[h('div',{class:'d-flex justify-content-between gap-2'},[h('div',{class:'macro-event-time'},event.scheduledAt?(event.metadata?.timePrecision==='date_only'?`${new Date(event.scheduledAt).toLocaleDateString('zh-CN')}（时间待官方确认）`:new Date(event.scheduledAt).toLocaleString('zh-CN')):'时间待确认'),h('span',{class:`macro-pill ${event.importance==='high'?'macro-pill-missing':event.importance==='medium'?'macro-pill-stale':'macro-pill-pending'}`},eventImportanceLabel(event.importance))]),h('div',{class:'fw-bold mt-1'},event.title??'未命名事件'),h('div',{class:'macro-meta mt-1'},`${regionLabels[event.region??'']??event.region??'全球'} · 实际 ${event.actual??'--'} · 预期 ${event.consensus??'--'} · 前值 ${event.previous??'--'}`)]))):h('div',{class:'macro-pending-box'},[h('strong',eventStatus.value==='error'?'经济日历暂不可用':'官方日历源待接入'),h('div',{class:'small mt-1'},eventMessage.value||'当前接口未返回已验证事件，页面不会猜测发布时间。')]),
      ]),
      h('section',{class:'macro-panel mt-4'},[
        h('div',{class:'d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3'},[h('div',[h('h2',{class:'macro-panel-title'},'核心观测指标'),h('div',{class:'macro-meta mt-1'},dashboard.value?`来源：${dashboard.value.source.name}`:'加载中')]),h('div',{class:'macro-tabs'},Object.entries(categoryLabels).map(([key,label])=>h('button',{class:`macro-tab${activeCategory.value===key?' active':''}`,onClick:()=>{activeCategory.value=key}},label)))]),
        loading.value?h('div',{class:'py-5 text-center text-muted'},'正在读取宏观序列…'):h('div',{class:'macro-grid macro-indicator-grid'},filteredIndicators().map((item)=>h('button',{class:`macro-indicator${selectedId.value===item.id?' active':''}`,onClick:()=>void renderChart(item.id),key:item.id},[
          h('div',{class:'d-flex justify-content-between gap-2'},[h('div',{class:'macro-indicator-name'},item.name),h('span',{class:`macro-pill macro-pill-${item.quality}`},qualityLabel(item.quality))]),h('div',{class:'macro-value'},formatValue(item.latest,item.unit)),
          h('div',{class:item.change===null?'macro-meta':item.change>0?'macro-change-up small fw-bold':item.change<0?'macro-change-down small fw-bold':'macro-meta'},item.change===null?'暂无前值':`较前值 ${item.change>0?'+':''}${item.change.toFixed(3)}`),
          h('div',{class:'macro-meta mt-2'},`${regionLabels[item.region]??item.region} · ${categoryLabels[item.category]??item.category} · ${transmissionLabels[item.transmission]??item.transmission}`),h('div',{class:'macro-meta'},`数据期 ${item.latestDate??'--'} · ${item.ageDays??'--'} 天前`),
        ]))),
      ]),
      h('section',{class:'macro-panel mt-4'},[
        h('div',{class:'d-flex justify-content-between align-items-start gap-3 mb-2'},[h('div',[h('h2',{class:'macro-panel-title'},dashboard.value?.indicators.find((item)=>item.id===selectedId.value)?.name??'指标走势'),h('div',{class:'macro-meta mt-1'},'最近三年；拖动底部滑块调整区间')]),h('span',{class:'macro-pill macro-pill-pending'},selectedId.value)]),
        h('div',{id:'macro-series-chart',class:'macro-chart'}),h('div',{class:'macro-note mt-2'},dashboard.value?.indicators.find((item)=>item.id===selectedId.value)?.interpretation??'点击上方指标查看解释。'),
      ]),
      h('section',{class:'macro-grid macro-research-grid mt-4'},[
        h('article',{class:'macro-panel'},[
          h('div',{class:'macro-section-head'},[h('div',[h('h2',{class:'macro-panel-title'},'首次值与修订'),h('div',{class:'macro-meta mt-1'},`${selectedId.value} · 仅统计同一统计期发生值变化的记录`)]),h('span',{class:`macro-pill ${revisions.value.length?'macro-pill-stale':'macro-pill-fresh'}`},`${revisions.value.length} 个统计期有修订`)]),
          revisions.value.length?h('table',{class:'table macro-table mt-3'},[h('thead',[h('tr',[h('th','统计期'),h('th','首次值'),h('th','最新值'),h('th','变化')])]),h('tbody',revisions.value.slice(0,6).map((item)=>h('tr',{key:item.observationDate},[h('td',item.observationDate),h('td',String(item.firstValue)),h('td',String(item.latestValue)),h('td',formatScore(item.delta))]))) ]):h('div',{class:'macro-pending-box'},[h('strong','尚未检测到修订'),h('div',{class:'small mt-1'},'首次值会保留，后续值变化才会显示在这里。')]),
        ]),
        h('article',{class:'macro-panel'},[
          h('div',{class:'macro-section-head'},[h('div',[h('h2',{class:'macro-panel-title'},'关注指标'),h('div',{class:'macro-meta mt-1'},'服务端保存；离线时保留本机副本')]),h('span',{class:'macro-pill macro-pill-fresh'},`${watchedIds.value.length} 项`)]),
          h('div',{class:'macro-watch-list'},(dashboard.value?.indicators??[]).map((item)=>h('label',{class:'macro-watch-row',key:item.id},[h('input',{type:'checkbox',checked:watchedIds.value.includes(item.id),onChange:()=>toggleWatch(item.id)}),h('span',{class:'small flex-grow-1'},item.name),h('span',{class:`macro-pill macro-pill-${item.quality}`},qualityLabel(item.quality))]))),
        ]),
        h('article',{class:'macro-panel'},[
          h('div',{class:'macro-section-head'},[h('div',[h('h2',{class:'macro-panel-title'},'预警配置'),h('div',{class:'macro-meta mt-1'},'服务端执行阈值判断；通知渠道单独配置')]),h('span',{class:'macro-pill macro-pill-fresh'},'规则执行可用')]),
          h('label',{class:'d-flex gap-2 align-items-center small mb-3'},[h('input',{type:'checkbox',checked:alertEnabled.value,onChange:(event:Event)=>{alertEnabled.value=(event.target as HTMLInputElement).checked}}),'启用关注指标阈值规则']),
          h('label',{class:'small fw-bold mb-1'},'绝对变化阈值'),h('input',{class:'macro-field',type:'number',placeholder:'例如 0.5',value:alertThreshold.value,onInput:(event:Event)=>{alertThreshold.value=(event.target as HTMLInputElement).value}}),
          h('div',{class:'macro-meta mt-2'},'当前规则作用于已选择指标，阈值单位与该指标一致。'),h('button',{class:'btn btn-sm btn-success mt-3',onClick:()=>void saveAlert()},'保存并立即检查'),alertNotice.value?h('div',{class:'macro-note mt-3'},alertNotice.value):null,
        ]),
      ]),
      h('section',{class:'macro-panel mt-4'},[
        h('div',{class:'macro-section-head'},[h('div',[h('h2',{class:'macro-panel-title'},'研究工具'),h('div',{class:'macro-meta mt-1'},'使用指定时点可见的宏观 vintage，并只使用东方财富指数K线')]),h('span',{class:`macro-pill ${researchBusy.value?'macro-pill-stale':'macro-pill-fresh'}`},researchBusy.value?'计算中':'第三阶段可用')]),
        h('div',{class:'macro-grid macro-research-grid'},[
          h('article',{class:'macro-research-card'},[h('div',{class:'d-flex justify-content-between'},[h('h3','历史情景回放'),h('span',{class:'macro-stage-number'},'1')]),h('div',{class:'row g-2'},[h('div',{class:'col-6'},[h('label',{class:'small fw-bold mb-1'},'开始'),h('input',{class:'macro-field',type:'date',value:replayFrom.value,onInput:(event:Event)=>{replayFrom.value=(event.target as HTMLInputElement).value}})]),h('div',{class:'col-6'},[h('label',{class:'small fw-bold mb-1'},'结束/当时可见'),h('input',{class:'macro-field',type:'date',value:replayTo.value,onInput:(event:Event)=>{replayTo.value=(event.target as HTMLInputElement).value}})])]),h('button',{class:'btn btn-sm btn-outline-success mt-3',onClick:()=>void runScenario()},'运行回放'),scenarioResult.value?h('div',{class:'macro-note mt-3'},scenarioResult.value.error??`返回 ${scenarioResult.value.results?.length??0} 项变化`):null]),
          h('article',{class:'macro-research-card'},[h('div',{class:'d-flex justify-content-between'},[h('h3','滚动相关性 / 市场敏感度'),h('span',{class:'macro-stage-number'},'2')]),h('select',{class:'macro-field mb-2',value:researchMarket.value,onChange:(event:Event)=>{researchMarket.value=(event.target as HTMLSelectElement).value}},marketCards.map((item)=>h('option',{value:item.region},item.title))),h('div',{class:'macro-meta'},'20期窗口，宏观数据按日期与东方财富指数对齐。韩国使用已验证的 KOSPI 100.KS11。'),h('button',{class:'btn btn-sm btn-outline-success mt-3',onClick:()=>void runCorrelation()},'计算相关性'),correlationResult.value?h('div',{class:'macro-note mt-3'},correlationResult.value.error??`有效输出 ${correlationResult.value.points?.filter((item:any)=>item.value!==null).length??0} 期`):null]),
          h('article',{class:'macro-research-card'},[h('div',{class:'d-flex justify-content-between'},[h('h3','宏观状态与市场回测'),h('span',{class:'macro-stage-number'},'3')]),h('select',{class:'macro-field mb-2',value:backtestMode.value,onChange:(event:Event)=>{backtestMode.value=(event.target as HTMLSelectElement).value}},[h('option',{value:'point-in-time'},'点时：严格无前视（默认）'),h('option',{value:'retrospective'},'回顾性：含当前修订，仅供探索')]),h('div',{class:'macro-meta'},backtestMode.value==='retrospective'?'使用当前修订值和统计期日期，只适合探索关系，不能作为可交易证据。':'按本系统首次可用时间确认样本；历史回填不会冒充当时已知数据。'),h('button',{class:'btn btn-sm btn-outline-success mt-3',onClick:()=>void runBacktest()},'运行回测'),backtestResult.value?h('div',{class:'macro-note mt-3'},backtestResult.value.error??(backtestResult.value.trades?.length?`${backtestResult.value.lookAheadSafe?'无前视':'回顾性'} · 样本 ${backtestResult.value.trades.length} · 平均 ${formatResearch(backtestResult.value.averageReturnPct)} · 胜率 ${formatResearch(backtestResult.value.winRatePct)}`:'当前没有足够的严格点时样本；系统会随每日同步积累，不应用回顾性结果替代。')):null]),
        ]),
        h('div',{class:'d-flex justify-content-between align-items-end mt-4 mb-2'},[h('div',[h('h3',{class:'macro-panel-title'},'行业敏感度'),h('div',{class:'macro-meta mt-1'},'60期标准化宏观信号 × 可审计行业暴露；随上方市场选择联动')]),h('span',{class:'macro-pill macro-pill-fresh'},'第三阶段')]),
        h('div',{class:'macro-sector-grid'},industrySignals.value.filter((item)=>item.market===researchMarket.value).map((item)=>h('article',{class:'macro-sector',key:item.id},[h('div',{class:'d-flex justify-content-between gap-2'},[h('strong',item.name),h('span',{class:`macro-sector-score ${item.score===null?'':item.score>=0?'macro-sector-support':'macro-sector-pressure'}`},item.score===null?'--':`${item.score>=0?'+':''}${item.score.toFixed(2)}`)]),h('div',{class:'macro-meta mt-1'},`覆盖 ${item.coverage.available}/${item.coverage.configured} 项 · ${item.contributions.slice(0,2).map((entry)=>entry.seriesId).join('、')||'等待数据'}`)]))),
      ]),
      h('section',{class:'macro-panel mt-4'},[h('h2',{class:'macro-panel-title'},'覆盖范围与下一步'),h('div',{class:'row g-3 mt-1'},[
        h('div',{class:'col-md-6'},[h('div',{class:'fw-bold text-success mb-2'},'已实现'),h('ul',{class:'small text-secondary mb-0'},[h('li','NY Fed SOFR、BLS 通胀/就业、HKMA 港汇与HIBOR'),h('li','不可覆盖的 vintage、数据源健康、关注和阈值规则'),h('li','因子贡献、行业敏感度、情景回放、滚动相关性与无前视回测'),h('li','标普500、沪深300、恒生指数、KOSPI的东方财富研究基准')])]),
        h('div',{class:'col-md-6'},[h('div',{class:'fw-bold text-secondary mb-2'},'需要外部条件'),h('ul',{class:'small text-secondary mb-0'},[h('li','FRED、韩国 ECOS/KOSIS 需要配置 API 密钥并核实系列代码'),h('li','国家统计局、人民银行和韩国出口尚无已验证稳定结构化契约'),h('li','官方日历当前区间无已导入事件时保持空白，不猜测日期'),h('li','告警规则可执行，邮件/短信等通知渠道尚未授权配置')])]),
      ])]),
    ])])
  },
})

function dateYearsAgo(years: number): string { const date=new Date(); date.setUTCFullYear(date.getUTCFullYear()-years); return date.toISOString().slice(0,10) }
function localDateInput(date=new Date()): string { const local=new Date(date.getTime()-date.getTimezoneOffset()*60_000); return local.toISOString().slice(0,10) }
function formatResearch(value: number | null | undefined): string { return value===null||value===undefined?'--':`${value.toFixed(2)}%` }
const root=document.getElementById('macro-vue-root'); if(root) createApp(MacroPage).mount(root)
