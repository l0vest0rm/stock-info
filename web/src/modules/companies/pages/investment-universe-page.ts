import { ObservationInformationPanel } from '../components/observation-information-panel'
import { portfolioSecurityCode } from '../../../../../shared/active-portfolio'
import { ActivePortfolioPanel } from '../components/active-portfolio-panel'
import { ObservationResearchPanel } from '../components/observation-research-panel'
import { useValuationDashboard } from '../composables/use-valuation-dashboard'
import { VALUATION_FRESHNESS_MS, type DashboardRow as ScreenRow } from '../../../../../shared/valuation-dashboard'
import { computed, createApp, defineComponent, h, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { InvestmentOpportunity, OpportunityKind, OpportunityMetric } from '../../../../../shared/investment-opportunity'
import type { ValuationAssessment } from '../../../../../shared/valuation-assessment'
import universeJson from '../../../../../config/investment-universe.json'
import researchJson from '../../../../../config/investment-universe-research.json'
import opportunityPolicy from '../../../../../config/investment-opportunity-policy.json'
import { renderDailyPanel } from './investment-daily-panel'

type ForwardReport = {
  title?: string; orgSName?: string; orgName?: string; publishDate?: string;
  reportCarrier?: string; reportUrl?: string; reportLocked?: boolean; targetPrice?: number;
  forecasts?: { year: number; eps?: number; netProfit?: number; pe?: number; computedPe?: number; computedPeAsOf?: number }[];
}

type Security = {
  ticker: string
  market: 'CN' | 'HK' | 'US' | 'KR'
  exchange: string | null
  securityType: string
  sourceCode: string
  identityVerified: boolean
}
type EvidenceRecord = {
  source: string
  kind: 'primary'
  security: string
  documentId: string
  title: string
  publishedAt: string
  url: string
}
type FactorExposure = {
  factor: string
  weight: 'primary' | 'secondary'
  direction: 'positive' | 'negative' | 'mixed'
}
type Company = {
  id: string
  displayName: string
  primarySectorId: string
  primaryTrackId: string
  positioning: string
  classificationStatus: string
  watchStatus: string
  researchPriority: string
  /** Derived by scripts/sync-investment-universe-valuation.mjs. */
  researchBasis?: string[]
  preferredMarket: 'CN' | 'US' | 'HK'
  preferredTicker: string
  securities: Security[]
  themeTags: string[]
  /** Derived by scripts/sync-investment-universe-valuation.mjs. */
  factorExposures: FactorExposure[]
  evidenceRefs: EvidenceRecord[]
  lastEvidenceDate: string | null
  valuationAsOf: string | null
  /** Derived by the native valuation sync command; see backend/src/coverage.rs. */
  valuationArchetype: string
}
type ResearchForecastYear = {
  year: number
  epsYuan: number | null
  epsYuanRange: { low: number | null; high: number | null }
  netProfitYi: number | null
  netProfitYiRange: { low: number | null; high: number | null }
  brokerCount: number
}
type ResearchForecast = {
  asOf: string
  method: string
  source: { publisher: string; title: string; url: string; sourceType: string }
  forecastYears: ResearchForecastYear[]
}
type ResearchBrokerReport = {
  institution: string
  analyst: string
  publishedAt: string
  title: string | null
  rating: string | null
  sourceUrl: string
  forecastYears: { year: number; epsYuan: number | null; netProfitYi: number | null }[]
}
type ResearchNews = {
  publishedAt: string
  title: string
  summary: string
  verification: 'full_text_checked' | 'headline_only'
  source: { publisher: string; url: string; sourceType: string }
}
type ResearchGuidance = {
  period: string
  metric: string
  value: { low?: number; high?: number; central?: number; plusMinus?: number }
  unit: string
  publishedAt: string
  sourceUrl: string
}
type ResearchIndustrySignal = {
  trackId: string
  publishedAt: string
  title: string
  summary: string
  implication: string
  verification: string
  source: { publisher: string; url: string; sourceType: string }
}
type ResearchEntry = {
  companyId: string
  checkedAt: string | null
  forecastStatus: string
  forecast: ResearchForecast | null
  analystReports: ResearchBrokerReport[]
  managementGuidance: ResearchGuidance[]
  keyJudgments: { type: string; text: string; attribution: string; publishedAt: string | null; sourceUrl: string | null }[]
  news: ResearchNews[]
  industrySignals: ResearchIndustrySignal[]
  gaps: string[]
}
type ResearchSnapshot = {
  asOf: string
  coverage: { totalCompanies: number; companiesWithForecast: number; companiesWithNewsOrAnnouncements: number }
  companies: ResearchEntry[]
}

type Track = { id: string; sectorId: string; name: string; researchFocus: string; risksToReview: string }
type Sector = {
  id: string
  name: string
  description: string
  portfolioIllustration: { targetSlots: number; targetEquityWeightPct: number; selectionNote: string }
}
type Universe = {
  asOf: string
  scope: {
    watchlistLimit: number
    automaticMonitoringEnabled: boolean
    baselineCounts: { sectors: number; tracks: number; companies: number; securities: number }
    targetHoldings: { min: number; illustrative: number; max: number }
  }
  strategyPreferences: {
    illustrative25HoldingSlots: { CN: number; US: number; HK: number }
    illustrativeEquityAllocationPct: { CN: number; US: number; HK: number }
  }
  sectors: Sector[]
  tracks: Track[]
  companies: Company[]
}

const opportunityLabels: Record<OpportunityKind, string> = { historical_discount: '历史折价', earnings_delivery: '盈利兑现', forward_gap: '未来预期差', drawdown: '显著回撤' }
const opportunityStageLabels: Record<InvestmentOpportunity['stage'], string> = { research_candidate: '优先研究', clue: '线索待验证', blocked: '风险阻断', no_signal: '未触发', insufficient_data: '数据不足' }
const evidenceLabels = { triggered: '已触发', not_triggered: '未触发', insufficient_data: '未覆盖 / 样本不足', not_applicable: '方法不适用' }
const gateLabels = { data: '数据有效性', business: '经营质量初筛', valuation: '价格吸引力初筛' }
const gateStateLabels = { pass: '通过初筛', fail: '未通过', unknown: '待核验' }
const opportunityTone = (stage: string) => stage === 'research_candidate' ? 'is-candidate' : stage === 'blocked' ? 'is-expensive' : 'is-blocked'
const opportunityMetric = (m: OpportunityMetric) => m.value === null ? '—' : m.unit === 'ratio' ? formatPct(m.value) : m.value.toFixed(2) + '×'

const valuationLabels: Record<ValuationAssessment['status'], string> = {
  undervalued: '低估（规则）', fair_low: '合理偏低', fair: '合理', expensive: '偏贵', very_expensive: '明显偏贵', unknown: '无法判断',
}
const valuationTone = (status: string) => ['undervalued', 'fair_low'].includes(status) ? 'is-candidate' : ['expensive', 'very_expensive'].includes(status) ? 'is-expensive' : status === 'fair' ? 'is-watch' : 'is-blocked'
const metricText = (a: ValuationAssessment) => a.current == null ? '—' : a.current.toFixed(2) + (a.unit === 'percent' ? '%' : '×')
const rangeText = (a: ValuationAssessment) => a.range ? `${a.range.low}–${a.range.high}${a.unit === 'percent' ? '%' : '×'}` : '—'

/**
 * Match a screen row to a universe company.
 *
 * The screen works in normalised API codes (`600519.SH`) while the universe
 * stores native exchange symbols, and the two differ for US listings.  Matching
 * on the preferred security and falling back to any listed security keeps the
 * join explicit instead of relying on display names, which repeat across
 * markets.
 */
function screenKeyCandidates(company: Company): string[] {
  const apiCode = (security: Security) =>
    security.market === 'US' && !security.ticker.endsWith('.US') ? security.ticker + '.US' : security.ticker
  return [apiCode({ ...company.securities.find((s) => s.ticker === company.preferredTicker) ?? company.securities[0] } as Security),
    ...company.securities.map(apiCode)]
}

function formatPct(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? (value * 100).toFixed(1) + '%' : '—'
}

const universe = universeJson as Universe
const researchSnapshot = researchJson as unknown as ResearchSnapshot
const researchById = new Map(researchSnapshot.companies.map((entry) => [entry.companyId, entry]))
const sectorsById = new Map(universe.sectors.map((sector) => [sector.id, sector]))
const tracksById = new Map(universe.tracks.map((track) => [track.id, track]))
const marketLabels: Record<string, string> = { CN: 'A股', HK: '港股', US: '美股', KR: '韩股' }
const statusLabels: Record<string, string> = { research: '研究观察', priority: '重点观察', paused: '暂停观察', excluded: '不再观察' }
const factorLabels: Record<string, string> = {
  ai_capex: 'AI 算力资本开支', semiconductor_cycle: '半导体资本开支周期', memory_price_cycle: '存储价格周期',
  china_consumption: '中国消费与内需', commodity_price: '商品价格周期', interest_rate: '利率',
  policy_regulation: '政策与合规周期', fx: '汇率', platform_regulation: '平台监管与广告周期', property_cycle: '地产与租金周期',
  new_energy_price_war: '新能源价格战', grid_capex: '电网资本开支', medicare_pricing: '医保谈判与集采',
  geopolitical_export_control: '出口管制',
}
const archetypeLabels: Record<string, string> = {
  bank: '银行（PB-ROE 驱动）', insurer: '保险（P/EV 驱动）', exchange: '交易所（成交驱动）', payment: '支付（支付量驱动）',
  property_operator: '不动产运营（NAV 驱动）', cyclical_commodity: '资源周期（中枢利润）', stable_cash_dividend: '稳定现金流与分红',
  growth_manufacturing: '成长制造', software_platform: '软件与平台', pre_profit_milestone: '里程碑型（管线药物）',
  healthcare_services: '医疗服务与器械', other: '待归类',
}
const priorityLabels: Record<string, string> = { L0: 'L0 · 基础身份', L1: 'L1 · 常规观察', L2: 'L2 · 深度研究', L3: 'L3 · 候选复核' }
const params = new URLSearchParams(window.location.search)

function safeParam(key: string, allowed: string[]): string {
  const value = params.get(key) || ''
  return allowed.includes(value) ? value : ''
}
function normalized(value: string): string {
  return value.trim().toLocaleLowerCase()
}
function option(value: string, text: string) {
  return h('option', { value }, text)
}
function selectControl(label: string, value: string, options: Array<[string, string]>, onChange: (value: string) => void) {
  return h('label', { class: 'ivu-filter' }, [
    h('span', { class: 'ivu-label' }, label),
    h('select', {
      class: 'ivu-select',
      'aria-label': label,
      value,
      onChange: (event: Event) => onChange((event.target as HTMLSelectElement).value),
    }, options.map(([code, name]) => option(code, name))),
  ])
}
function codeText(company: Company): string {
  return [company.preferredTicker, ...company.securities.filter((security) => security.ticker !== company.preferredTicker).map((security) => security.ticker)].join(' / ')
}

/**
 * P2-3 research tiering.
 *
 * Priority is a function of three things we already model, so it is computed
 * rather than hand-assigned (the old file had every company at L1, which is the
 * same as having no tiering):
 *
 * - archetype: an archetype whose method set is narrow (P/EV, NAV, mid-cycle) is
 *   harder to get right, so it needs deeper work than a plain PE name;
 * - factor exposure: companies whose earnings are driven by a single external
 *   price are the ones that can move most between reviews;
 * - data readiness: a company whose securities are identity-verified can be
 *   researched now, while an unverified one needs its filings located first.
 *
 * `watchStatus` follows the same inputs: `research` when evidence is missing,
 * `priority` when it is a concentrated-exposure or hard-to-value name with
 * evidence, `research` (plain) otherwise. It never means "buy".
 */
const TIER_BY_ARCHETYPE: Record<string, number> = {
  insurer: 3, property_operator: 3, pre_profit_milestone: 3, cyclical_commodity: 3,
  bank: 2, exchange: 2, stable_cash_dividend: 2, payment: 2,
  growth_manufacturing: 1, software_platform: 1, healthcare_services: 1, other: 1,
}

type TieredCompany = Company & { priority: string; watchStatus: string; basis: string[] }

type TierInput = Pick<Company, 'valuationArchetype' | 'factorExposures' | 'securities' | 'evidenceRefs'>

/**
 * The tiering rule lives in `backend/src/coverage.rs`
 * and is written into the universe by the native sync command.  The page reads those
 * fields and only falls back to the same rule locally for an older build, so the
 * page and the file can never disagree about why a company is L3.
 */
function researchTier(company: Company): { priority: string; watchStatus: string; basis: string[] } {
  if (company.researchPriority && company.watchStatus && Array.isArray(company.researchBasis)) {
    return { priority: company.researchPriority, watchStatus: company.watchStatus, basis: company.researchBasis }
  }
  return localTier(company)
}

function localTier(company: TierInput): { priority: string; watchStatus: string; basis: string[] } {
  const basis: string[] = []
  let tier = TIER_BY_ARCHETYPE[company.valuationArchetype] ?? 1
  basis.push('原型 ' + company.valuationArchetype)
  const primaryFactors = company.factorExposures.filter((exposure) => exposure.weight === 'primary')
  if (company.factorExposures.some((exposure) => exposure.direction === 'mixed') && primaryFactors.length === 1) {
    // A single factor with no fixed sign means the earnings direction cannot be
    // read off the factor — that is a research question before it is a value.
    tier = Math.min(3, tier + 1)
    basis.push('唯一主导因子方向不确定')
  }
  // `every` on an empty list is `true`; a company with no listed security has
  // no identity evidence either, so the check must be explicit.
  const verified = company.securities.length > 0 && company.securities.every((security) => security.identityVerified)
  if (!verified) {
    return { priority: 'L1', watchStatus: 'research', basis: [...basis, '身份未核验，先补一手文件'] }
  }
  basis.push('全部证券身份已核验')
  if (company.evidenceRefs.length === 0) return { priority: 'L1', watchStatus: 'research', basis }
  const priority = tier >= 3 ? 'L3' : tier === 2 ? 'L2' : 'L1'
  return { priority, watchStatus: tier >= 2 ? 'priority' : 'research', basis }
}
function stripCsvFormula(value: string): string {
  return /^[\s]*[=+\-@]/.test(value) ? "'" + value : value
}
function csvCell(value: string): string {
  return '"' + stripCsvFormula(value).replaceAll('"', '""') + '"'
}
function downloadCsv(companies: TieredCompany[]): void {
  const header = ['公司ID', '公司', '一级行业', '细分赛道', '首选研究市场', '首选研究证券', '其他上市证券', '观察状态', '优先级', '分类核验状态', '分级依据', '定位']
  const rows = companies.map((company) => [
    company.id,
    company.displayName,
    sectorsById.get(company.primarySectorId)?.name || '',
    tracksById.get(company.primaryTrackId)?.name || '',
    marketLabels[company.preferredMarket] || company.preferredMarket,
    company.preferredTicker,
    company.securities.filter((security) => security.ticker !== company.preferredTicker).map((security) => security.ticker).join(' / '),
    statusLabels[company.watchStatus] || company.watchStatus,
    company.priority,
    company.classificationStatus === 'verified' ? '已核验' : '待核验',
    company.basis.join('；'),
    company.positioning,
  ])
  const csv = '\uFEFF' + [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = 'investment-universe-' + universe.asOf + '.csv'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const InvestmentUniversePage = defineComponent({
  name: 'InvestmentUniversePage',
  setup() {
    const query = ref(params.get('q') || '')
    const sectorId = ref(safeParam('sector', universe.sectors.map((sector) => sector.id)))
    const trackId = ref(safeParam('track', universe.tracks.map((track) => track.id)))
    const market = ref(safeParam('market', ['CN', 'HK', 'US', 'KR']))
    const status = ref(safeParam('status', Object.keys(statusLabels)))
    const priority = ref(safeParam('priority', Object.keys(priorityLabels)))
    const view = ref(params.get('view') === 'tracks' ? 'tracks' : 'companies')
    const selectedId = ref(safeParam('company', universe.companies.map((company) => company.id)))
    const sort = ref(safeParam('sort', ['industry', 'name', 'priority']) || 'industry')

    /**
     * The server-computed screen, read on mount and polled without submitting work.
     *
     * Before this the page could only show the archetype label from the JSON, so
     * every number a reader actually wants — the band, the margin of safety, the
     * verdict — lived in a terminal and in prose.  Loading it here makes the page
     * a view of a computation rather than of a handwritten list.
     *
     * A failure is rendered as a failure.  If the endpoint is down the table must
     * not fall back to "no candidates", because that reads as a finding about the
     * companies when it is a fact about the request.
     */
    const valuationFilter = ref('')
    const opportunityFilter = ref(safeParam('opportunity', Object.keys(opportunityStageLabels)))
    const signalFilter = ref(safeParam('signal', Object.keys(opportunityLabels)))
    const freshnessClock = ref(Date.now())
    let freshnessTimer: ReturnType<typeof setInterval> | undefined
    const freshOpportunity = (row: ScreenRow | null) => !!row?.opportunity && freshnessClock.value >= Date.parse(row.computation.computedAt) && freshnessClock.value - Date.parse(row.computation.computedAt) < VALUATION_FRESHNESS_MS && row.computation.revision === screenMeta.value?.revision
    const controller = new AbortController()

    async function api(path: string, method = 'GET') {
      const response = await fetch(path, { method, headers: { accept: 'json' }, cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]) })
      const body = await response.json().catch(() => null)
      if (!response.ok || body?.code !== 200) throw new Error(body?.msg || 'HTTP ' + response.status)
      return body.data
    }
    const { screenRows, screenMeta, screenError, screenLoading, refreshing, completed,
      refreshErrors, rowState, loadScreen } = useValuationDashboard(api, controller.signal)
    const forwardReports = ref<Record<string, ForwardReport[]>>({})
    const forwardState = ref<Record<string, string>>({})
    async function loadForwardReports(company: Company) {
      if (forwardState.value[company.id] === '读取中') return
      if (company.preferredMarket !== 'CN') { forwardState.value[company.id] = '现有东财/新浪研报链路仅覆盖A股'; return }
      forwardState.value[company.id] = '读取中'
      try {
        const items = await api('/api/company/reports?readOnly=1&code=' + encodeURIComponent(company.preferredTicker)) as ForwardReport[]
        forwardReports.value[company.id] = items.filter((r) => r.reportCarrier === '东方财富' || r.reportCarrier === '新浪' || r.reportCarrier === '东方财富 / 新浪')
        forwardState.value[company.id] = '已读取'
      } catch (error) { forwardState.value[company.id] = '读取失败：' + (error instanceof Error ? error.message : String(error)) }
    }
    const forwardYears = (r: ForwardReport) => (r.forecasts ?? []).filter((f) => f.year >= new Date().getFullYear())
    const forwardNumber = (n: unknown) => typeof n === 'number' && Number.isFinite(n) ? n.toFixed(2) : '—'
    const renderForwardReports = (company: Company) => {
      const reports = forwardReports.value[company.id] ?? []
      return h('section', { class: 'ivu-valuation-detail-block', 'aria-label': '未来估值参考' }, [
        h('h3', '未来估值参考 · 东财 / 新浪研报'),
        h('p', { class: 'ivu-muted-small' }, '复用项目已有研报及已保存的预测提取，不触发模型分析。逐份展示，不合成为一致预期，不自动触发“未来预期差”或低估信号。'),
        h('button', { type: 'button', disabled: forwardState.value[company.id] === '读取中', onClick: () => loadForwardReports(company) }, '刷新研报估值'),
        h('p', forwardState.value[company.id] || '等待读取'),
        ...reports.map((r) => h('article', { class: 'ivu-opportunity-signal' }, [
          h('h4', r.title || '研报'),
          h('p', `${r.reportCarrier} · ${r.orgSName || r.orgName || '机构未标明'} · 发布 ${r.publishDate || '日期缺失'}`),
          ...forwardYears(r).map((f) => h('p', `${f.year}E：EPS ${forwardNumber(f.eps)} 元 · 归母净利润 ${forwardNumber(f.netProfit)} 亿元 · 研报PE ${forwardNumber(f.pe)} 倍 · 行情快照重算PE ${forwardNumber(f.computedPe)} 倍${f.computedPeAsOf ? '（计算基准获取于 ' + new Date(f.computedPeAsOf).toLocaleString('zh-CN') + '）' : ''}`)),
          !forwardYears(r).length ? h('p', '暂无本年及以后年度的已保存盈利预测，不以历史数据补缺。') : null,
          h('p', `研报目标价：${forwardNumber(r.targetPrice)} 元（目标期限、复权及股本口径需核验，不计算上涨空间）`),
          r.reportUrl && /^https?:\/\//i.test(r.reportUrl) ? h('a', { href: r.reportUrl, target: '_blank', rel: 'noopener noreferrer' }, '核查原研报 ↗') : h('span', r.reportLocked ? '登录后可查看原研报' : '原文链接暂缺'),
        ])),
        forwardState.value[company.id] === '已读取' && !reports.length ? h('p', '暂无东财/新浪研报；空缺不代表估值合理。') : null,
        h('p', { class: 'ivu-muted-small' }, '预测可能已过时或尚未兑现；研报PE使用报告当时价格，重算PE使用行情快照而非实时价。负利润不适用PE。未来年度盈利预测不等于内在价值，需结合历史估值、经营质量及悲观情景复核。'),
      ])
    }
    /** A company's screen row, matched by API code rather than by display name. */
    const screenFor = (company: Company): ScreenRow | null => {
      for (const key of screenKeyCandidates(company)) {
        const row = screenRows.value.get(key.toUpperCase())
        if (row) return row
      }
      return null
    }

    const trackOptions = computed(() =>
      universe.tracks.filter((track) => !sectorId.value || track.sectorId === sectorId.value),
    )
    // Priority and watch status are derived, not read from the file: the file
    // carries one uniform value, which is the same as having no tiering at all.
    const tierById = new Map(universe.companies.map((company) => [company.id, researchTier(company)]))
    const tierOf = (company: Company): Pick<TieredCompany, 'priority' | 'watchStatus' | 'basis'> =>
      tierById.get(company.id) ?? { priority: 'L1', watchStatus: 'research', basis: [] }
    const tieredCompanies = computed<TieredCompany[]>(() => universe.companies.map((company) => ({ ...company, ...tierOf(company) })))
    const filteredCompanies = computed(() => {
      const keyword = normalized(query.value)
      const companies = tieredCompanies.value.filter((company) => {
        const opportunity = screenFor(company)?.opportunity
        if (opportunityFilter.value && (freshOpportunity(screenFor(company)) ? opportunity?.stage : 'insufficient_data') !== opportunityFilter.value) return false
        if (signalFilter.value && !opportunity?.signals.some((s) => s.kind === signalFilter.value && s.state === 'triggered')) return false
        if (valuationFilter.value && (screenFor(company)?.assessment?.status ?? 'unknown') !== valuationFilter.value) return false
        if (sectorId.value && company.primarySectorId !== sectorId.value) return false
        if (trackId.value && company.primaryTrackId !== trackId.value) return false
        if (market.value && company.preferredMarket !== market.value) return false
        if (status.value && company.watchStatus !== status.value) return false
        if (priority.value && company.priority !== priority.value) return false
        if (!keyword) return true
        const matchText = [
          company.id, company.displayName, company.positioning,
          company.primaryTrackId,
          tracksById.get(company.primaryTrackId)?.name || '',
          sectorsById.get(company.primarySectorId)?.name || '',
          ...company.securities.map((security) => security.ticker),
        ].join(' ')
        return normalized(matchText).includes(keyword)
      })
      if (sort.value === 'name') {
        return companies.sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-CN'))
      }
      if (sort.value === 'priority') {
        return companies.sort((a, b) => b.priority.localeCompare(a.priority) || a.id.localeCompare(b.id))
      }
      return companies
    })
    const groupedTracks = computed(() => universe.tracks.flatMap((track) => {
      const companies = filteredCompanies.value.filter((company) => company.primaryTrackId === track.id)
      return companies.length ? [{ track, companies }] : []
    }))
    const visibleTracks = computed(() => new Set(filteredCompanies.value.map((company) => company.primaryTrackId)).size)
    const selected = computed<TieredCompany | null>(() => {
      const company = universe.companies.find((item) => item.id === selectedId.value) || null
      return company ? { ...company, ...tierOf(company) } : null
    })


    function setSector(id: string) {
      sectorId.value = id
      trackId.value = ''
    }
    function resetFilters() {
      query.value = ''
      setSector('')
      market.value = ''
      status.value = ''
      priority.value = ''
      sort.value = 'industry'
      valuationFilter.value = ''
      opportunityFilter.value = ''
      signalFilter.value = ''
    }
    const detailDialog = ref<HTMLDialogElement | null>(null)
    let detailTrigger: HTMLElement | null = null
    function syncDetailDialog() {
      const dialog = detailDialog.value
      if (!dialog) return
      if (selectedId.value && !dialog.open) {
        detailTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
        dialog.showModal()
        dialog.scrollTop = 0
        dialog.querySelector<HTMLElement>('.ivu-close')?.focus({ preventScroll: true })
      } else if (!selectedId.value && dialog.open) {
        dialog.close()
        detailTrigger?.focus({ preventScroll: true })
        detailTrigger = null
      }
    }
    watch(selectedId, syncDetailDialog, { flush: 'post' })
    watch(selectedId, (id) => { const company = universe.companies.find((c) => c.id === id); if (company && !forwardState.value[id]) void loadForwardReports(company) }, { immediate: true })
    function chooseCompany(id: string) {
      selectedId.value = id
    }
    function closeDetail() {
      selectedId.value = ''
    }
    function readNavigationState() {
      const p = new URLSearchParams(window.location.search)
      query.value = p.get('q') || ''
      sectorId.value = universe.sectors.some((sector) => sector.id === p.get('sector')) ? p.get('sector') || '' : ''
      trackId.value = universe.tracks.some((track) => track.id === p.get('track')) ? p.get('track') || '' : ''
      market.value = ['CN','HK','US','KR'].includes(p.get('market') || '') ? p.get('market') || '' : ''
      status.value = Object.hasOwn(statusLabels, p.get('status') || '') ? p.get('status') || '' : ''
      priority.value = Object.hasOwn(priorityLabels, p.get('priority') || '') ? p.get('priority') || '' : ''
      sort.value = ['industry','name','priority'].includes(p.get('sort') || '') ? p.get('sort') || 'industry' : 'industry'
      opportunityFilter.value = Object.hasOwn(opportunityStageLabels, p.get('opportunity') || '') ? p.get('opportunity') || '' : ''
      signalFilter.value = Object.hasOwn(opportunityLabels, p.get('signal') || '') ? p.get('signal') || '' : ''
      view.value = p.get('view') === 'tracks' ? 'tracks' : 'companies'
      selectedId.value = universe.companies.some((company) => company.id === p.get('company')) ? p.get('company') || '' : ''
    }
    watch([query, sectorId, trackId, market, status, priority, sort, view, selectedId, opportunityFilter, signalFilter], () => {
      const p = new URLSearchParams()
      const values: Record<string, string> = {
        q: query.value, sector: sectorId.value, track: trackId.value,
        market: market.value, status: status.value, priority: priority.value,
        sort: sort.value === 'industry' ? '' : sort.value,
        view: view.value === 'companies' ? '' : view.value,
        company: selectedId.value, opportunity: opportunityFilter.value, signal: signalFilter.value,
      }
      for (const [key, value] of Object.entries(values)) if (value) p.set(key, value)
      const newUrl = window.location.pathname + (p.size ? '?' + p.toString() : '') + window.location.hash
      if (newUrl !== window.location.pathname + window.location.search + window.location.hash) {
        window.history.replaceState(window.history.state, '', newUrl)
      }
    })
    onMounted(() => {
      syncDetailDialog()
      freshnessTimer = setInterval(() => { freshnessClock.value = Date.now() }, 30000)
      window.addEventListener('popstate', readNavigationState)
      void loadScreen()
    })
    onBeforeUnmount(() => { clearInterval(freshnessTimer); controller.abort(); window.removeEventListener('popstate', readNavigationState) })

    const linkForSecurity = (security: Security) =>
      security.market === 'KR' ? '' : 'company.html?code=' + encodeURIComponent(security.ticker)

    // Evidence is now a record, so the page can link to the primary document
    // instead of printing a string nobody can check.
    const evidenceLink = (company: Company) => {
      const latest = [...company.evidenceRefs].sort((left, right) => right.publishedAt.localeCompare(left.publishedAt))[0]
      return latest
        ? h('a', { href: latest.url, target: '_blank', rel: 'noopener noreferrer' }, '一手文件：' + latest.title.slice(0, 24))
        : h('span', '一手文件：待接入')
    }

    // Weight and direction belong in the label: two companies sharing 利率 do
    // not move the same way, and a bare factor name hides that.
    const directionLabels: Record<string, string> = { positive: '正相关', negative: '负相关', mixed: '双向' }
    const describeFactors = (factors: FactorExposure[]) =>
      factors
        .map((item) => `${factorLabels[item.factor] || item.factor}（${directionLabels[item.direction] || item.direction}${item.weight === 'secondary' ? '，次要' : ''}）`)
        .join('、')

    const renderCompanyToken = (company: Company) => h('button', {
      key: company.id,
      type: 'button',
      class: 'ivu-company-token',
      onClick: () => chooseCompany(company.id),
      'aria-label': '查看' + company.displayName + '的研究详情',
    }, [
      h('strong', company.displayName),
      h('small', codeText(company)),
      h('span', { class: 'ivu-token-arrow', 'aria-hidden': 'true' }, '↗'),
    ])

    // The research snapshot is a separate, dated public-source index. It never
    // enters the rule-based valuation model and never impersonates current prices.
    const renderCompanyResearch = (company: Company) => {
      const research = researchById.get(company.id)
      if (!research) return h('p', { class: 'ivu-screen-warning' }, '尚无该公司的研报研究记录。')
      const forecast = research.forecast
      const link = (url: string, label: string) =>
        h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, label)
      const years = forecast?.forecastYears ?? []
      const formatYear = (entry: ResearchForecastYear) =>
        entry.year + '年：归母净利润 ' + (entry.netProfitYi == null ? '未核验' : entry.netProfitYi.toFixed(2) + '亿元') +
        ' · EPS ' + (entry.epsYuan == null ? '未核验' : entry.epsYuan.toFixed(2) + '元')
      const renderGuidanceValue = (entry: ResearchGuidance) =>
        entry.value.central != null
          ? String(entry.value.central) + (entry.value.plusMinus == null ? '' : '±' + entry.value.plusMinus)
          : entry.value.low != null && entry.value.high != null
            ? entry.value.low + '–' + entry.value.high
            : '未提供具体数值'
      return h('section', { class: 'ivu-valuation-detail-block', 'aria-label': '研报盈利预测与近期资讯' }, [
        h('h3', '研报盈利预测 · 近期资讯'),
        h('p', { class: 'ivu-muted-small' }, '研究快照：' + researchSnapshot.asOf +
          ' · 机构预测与公司经营指引、已披露业绩、系统估值分别展示；不代表交易指令。'),
        forecast ? h('div', [
          h('h4', '近期单券商年度盈利预测（非一致预期与公司指引）'),
          h('p', { class: 'ivu-muted-small' }, forecast.method + ' · 数据截至 ' + forecast.asOf),
          ...years.map((entry) => h('p', { class: 'ivu-detail-copy', key: String(entry.year) }, formatYear(entry))),
          h('p', { class: 'ivu-muted-small' }, link(forecast.source.url, '核查来源：' + forecast.source.publisher + ' ↗')),
        ]) : h('p', { class: 'ivu-screen-warning' }, '暂未从独立网页核查到年度券商盈利预测；不以0或推算补缺。'),
        research.managementGuidance.length ? h('div', [
          h('h4', '公司管理层指引（不同口径，不并入一致预期）'),
          ...research.managementGuidance.map((entry) => h('p', { class: 'ivu-detail-copy', key: entry.period + entry.metric }, [
            entry.period + ' · ' + entry.metric + '：' + renderGuidanceValue(entry) + ' ' + entry.unit + ' · ',
            link(entry.sourceUrl, '公司来源 ↗'),
          ])),
        ]) : null,
        research.analystReports.length ? h('div', [
          h('h4', '近期券商预测'),
          ...research.analystReports.slice(0, 3).map((entry) => h('p', { class: 'ivu-detail-copy', key: entry.institution + entry.publishedAt }, [
            h('strong', entry.institution + ' · ' + entry.publishedAt + '：'),
            entry.title ? ' ' + entry.title + '；' : ' ',
            entry.forecastYears.map((y) => y.netProfitYi != null
              ? `${y.year}年净利${y.netProfitYi.toFixed(2)}亿元`
              : y.epsYuan != null ? `${y.year}年EPS${y.epsYuan.toFixed(2)}元` : null).filter(Boolean).join(' / ') + ' · ',
            link(entry.sourceUrl, '原始预测列表 ↗'),
          ])),
          h('p', { class: 'ivu-muted-small' }, '信息来自独立 Web Search 的公开报告页/摘要；出处和预测口径以原报告为准，不代表市场一致预期。'),
        ]) : null,
        research.keyJudgments.some((entry) => entry.type === 'broker_report_view' || entry.type === 'analyst_synthesis_and_verification_question')
          ? h('div', [
              h('h4', '研究判断与验证问题'),
              ...research.keyJudgments.filter((entry) => entry.type === 'broker_report_view' || entry.type === 'analyst_synthesis_and_verification_question')
                .map((entry, i) => h('p', { class: 'ivu-detail-copy', key: i }, entry.text)),
              h('p', { class: 'ivu-muted-small' }, '研究综合判断属于分析推断，而非公司公告或已实现业绩。'),
            ]) : null,
        h('h4', '近期公司新闻与公告'),
        research.news.length
          ? h('div', research.news.slice(0, 6).map((entry, index) => h('p', { class: 'ivu-detail-copy', key: index }, [
              h('strong', entry.publishedAt + ' · '),
              link(entry.source.url, entry.title + ' ↗'),
              h('span', { class: 'ivu-muted-small' }, entry.verification === 'headline_only' ? '（公开索引/检索摘要）' : '（网页正文已核查）'),
              h('span', ' ' + entry.summary),
            ])))
          : h('p', { class: 'ivu-muted-small' }, '本轮尚未找到独立的近期公司资讯；不代表实际没有新闻。'),
        research.industrySignals?.length ? h('div', [
          h('h4', '相关细分赛道最新信息（不代表本公司已确认业绩）'),
          ...research.industrySignals.map((entry) => h('p', { class: 'ivu-detail-copy', key: entry.trackId + entry.publishedAt }, [
            h('strong', entry.publishedAt + ' · '),
            link(entry.source.url, entry.title + ' ↗'),
            ' ' + entry.summary + '；研究重点：' + entry.implication,
          ])),
        ]) : null,
        research.gaps.length ? h('details', { class: 'ivu-focus-policy' }, [
          h('summary', '数据缺口与核验限制（' + research.gaps.length + '）'),
          h('ul', research.gaps.map((gap, i) => h('li', { key: i, class: 'ivu-detail-copy' }, gap))),
        ]) : null,
      ])
    }

    const renderDetail = (company: TieredCompany) => {
      const track = tracksById.get(company.primaryTrackId)
      const sector = sectorsById.get(company.primarySectorId)
      return h('section', {
        id: 'ivu-company-detail', class: 'ivu-detail', tabindex: -1,
        'aria-label': company.displayName + '详情',
      }, [
        h('div', { class: 'ivu-detail-header' }, [
          h('div', [
            h('div', { class: 'ivu-eyebrow' }, company.id + ' · 候选公司'),
            h('h2', { class: 'ivu-detail-title' }, company.displayName),
            h('p', { class: 'ivu-detail-subtitle' }, (sector?.name || '') + ' / ' + (track?.name || '')),
          ]),
          h('button', { type: 'button', class: 'ivu-close', onClick: closeDetail, 'aria-label': '关闭公司详情' }, '×'),
        ]),
        h('p', { class: 'ivu-description' }, company.positioning),
        h('div', { class: 'ivu-tag-row' }, [
          h('span', { class: 'ivu-tag' }, statusLabels[company.watchStatus] || company.watchStatus),
          h('span', { class: 'ivu-tag' }, priorityLabels[company.priority] || company.priority),
          h('span', { class: 'ivu-tag' }, '首选：' + (marketLabels[company.preferredMarket] || company.preferredMarket) + ' ' + company.preferredTicker),
          h('span', { class: 'ivu-tag ivu-tag-muted' }, company.classificationStatus === 'verified' ? '全部证券身份已核验' : '证券身份待核验'),
        ]),
        h('div', { class: 'ivu-detail-grid' }, [
          h('div', [
            h('h3', { class: 'ivu-section-mini' }, '证券与上市市场'),
            h('div', { class: 'ivu-security-list' }, company.securities.map((security) =>
              h('div', { class: 'ivu-security', key: security.market + ':' + security.ticker }, [
                h('div', [
                  h('strong', security.ticker),
                  h('span', { class: 'ivu-market' }, marketLabels[security.market] || security.market),
                ]),
                linkForSecurity(security)
                  ? h('a', { href: linkForSecurity(security), target: '_blank', rel: 'noopener noreferrer' }, '站内查询 ↗')
                  : h('span', { class: 'ivu-muted-small' }, '待接入'),
                h('small', { class: 'ivu-security-note' }, security.identityVerified ? '证券身份已核验' : '上市身份／权益尚待核验'),
              ]),
            )),
          ]),
          h('div', [
            h('h3', { class: 'ivu-section-mini' }, '赛道研究重点'),
            h('p', { class: 'ivu-detail-copy' }, track?.researchFocus || '暂无'),
            h('h3', { class: 'ivu-section-mini' }, '需要核查的风险'),
            h('p', { class: 'ivu-detail-copy' }, track?.risksToReview || '暂无'),
          ]),
        ]),
        h('div', { class: 'ivu-detail-bottom' }, [
          h('span', '最新证据日期：' + (company.lastEvidenceDate || '待补充')),
          evidenceLink(company),
          h('span', '估值原型：' + (archetypeLabels[company.valuationArchetype] || company.valuationArchetype || '待归类')),
          h('span', '动态估值计算：' + (screenFor(company)?.assessment?.computedAt ? new Date(screenFor(company)!.assessment!.computedAt).toLocaleString('zh-CN') : '等待计算')),
          h('span', '风险因子：' + (company.factorExposures.length ? describeFactors(company.factorExposures) : '待补充证据')),
          h('span', '主题标签：' + (company.themeTags.length ? company.themeTags.join('、') : '待补充证据')),
          h('span', '分级依据：' + (company.basis.join('；') || '待补充')),
        ]),
        renderOpportunityDetail(company),
        h(ObservationInformationPanel, { codes: company.securities.map(portfolioSecurityCode), key: company.id + ':information' }),
        h(ObservationResearchPanel, { code: portfolioSecurityCode({ ticker: company.preferredTicker, market: company.preferredMarket }), key: company.id }),
        renderForwardReports(company),
        renderCompanyResearch(company),
        renderValuationDetail(company),
      ])
    }

    /**
     * The valuation arithmetic, spelled out for one company.
     *
     * The table cell has room for a verdict; this has room for the reason.  It
     * shows which band carried the decision, its anchor period, the ceiling, the
     * current position and the growth reading — the same fields the daily note
     * quotes — so a reader can check the verdict instead of trusting it.
     */
    const renderOpportunityDetail = (company: Company) => {
      const row = screenFor(company)
      const o = row?.opportunity
      if (!o) return h('section', { class: 'ivu-opportunity-detail' }, [h('h3', '机会研究卡'), h('p', '等待服务端机会模型；不会用旧估值标签替代四类线索。')])
      const fresh = freshOpportunity(row)
      const metrics = (items: OpportunityMetric[]) => h('dl', { class: 'ivu-opportunity-metrics' }, items.map((m) => h('div', [h('dt', m.label), h('dd', opportunityMetric(m)), h('small', m.period + ' · ' + m.source)])))
      return h('section', { class: 'ivu-opportunity-detail' }, [
        h('div', { class: 'ivu-section-heading' }, [h('h3', '机会研究卡 · 线索 → 验证 → 研究'), h('span', { class: 'ivu-verdict ' + opportunityTone(fresh ? o.stage : '') }, fresh ? opportunityStageLabels[o.stage] : '缓存过期 / 待刷新')]),
        h('p', { class: 'ivu-muted-small' }, `规则版本 ${o.policyVersion} · ${new Date(o.computedAt).toLocaleString('zh-CN')} · 不按信号数量打分`),
        o.workflow ? h('article', { class: 'ivu-opportunity-review' }, [
          h('h4', '研究路径 · ' + o.workflow.pathLabel),
          h('p', (fresh ? queueLabels[o.workflow.queue] : '缓存待刷新') + '：' + (fresh ? o.workflow.nextAction : '不按旧结果安排当前研究优先级。')),
          h('ul', o.workflow.requiredEvidence.map(t => h('li', t))),
          h('p', '论点状态：' + ({ not_verified: '待验证', reviewed: '人工复核完成', invalidated: '已失效', review_due: '到期需复核' }[o.workflow.thesisStatus]) + '；详见下方研究闭环记录，量化候选不是交易许可。'),
        ]) : null,
        o.seasonality ? h('article', { class: 'ivu-opportunity-review' }, [
          h('h4', '环比与历史季节性'), h('p', o.seasonality.reason),
          ...([['营收', o.seasonality.revenue], ['利润', o.seasonality.profit]] as const).map(([label, reading]) => h('div', [
            h('p', `${label}：本期 ${formatPct(reading.current)} · 历史中位数 ${formatPct(reading.median)} · ${reading.samples.length}个样本`),
            h('ul', reading.samples.map(sample => h('li', sample.period + '：' + formatPct(sample.value)))),
          ])),
        ]) : null,
        h('div', { class: 'ivu-opportunity-gates' }, o.gates.map((g) => h('article', { class: 'ivu-opportunity-gate is-' + g.state }, [h('strong', gateLabels[g.key]), h('span', gateStateLabels[g.state]), ...g.reasons.map((r) => h('p', r))]))),
        h('div', { class: 'ivu-opportunity-signals' }, o.signals.map((signal) => h('article', { class: 'ivu-opportunity-signal' }, [
          h('div', { class: 'ivu-section-heading' }, [h('h4', opportunityLabels[signal.kind]), h('span', { class: 'ivu-verdict ' + (signal.state === 'triggered' ? 'is-watch' : 'is-blocked') }, evidenceLabels[signal.state])]),
          h('p', signal.summary), metrics(signal.metrics),
          h('ul', signal.limitations.map((text) => h('li', text))),
        ]))),
        h('h4', '经营质量读数'),
        metrics([
          { key: 'cash', label: '经营现金 / 归母利润（TTM）', value: o.quality.cashConversion, unit: 'multiple', period: o.quality.cashflowReportDate || '未覆盖', source: '同期间财报；非金融初筛' },
          { key: 'debt', label: '资产负债率', value: o.quality.debtRatio, unit: 'ratio', period: o.quality.balanceReportDate || '未覆盖', source: '总负债 / 总资产' },
          { key: 'growth', label: '利润两年复合增长', value: o.quality.profitCagr2y, unit: 'ratio', period: '最近两年TTM', source: '正式财报口径待核验' },
        ]),
        h('div', { class: 'ivu-opportunity-review' }, [
          h('h4', '市场可能担心什么'), h('p', o.review.marketConcern),
          h('h4', '与市场不同的判断是否成立'), h('p', o.review.alternativeView),
          h('h4', '下一步验证'), h('ul', o.review.nextChecks.map((t) => h('li', t))),
          h('h4', '什么会使判断失效'), h('ul', o.review.invalidation.map((t) => h('li', t))),
        ]),
        ...o.caveats.map((text) => h('p', { class: 'ivu-muted-small' }, text)),
      ])
    }
    const renderOpportunityCell = (company: Company) => {
      const row = screenFor(company)
      const o = row?.opportunity
      return h('div', { class: 'ivu-valuation' }, [
        h('span', { class: 'ivu-verdict ' + opportunityTone(freshOpportunity(row) ? o!.stage : '') }, o ? freshOpportunity(row) ? opportunityStageLabels[o.stage] : '缓存待刷新' : '等待机会计算'),
        ...(o?.signals.filter((s) => s.state === 'triggered').map((s) => h('span', { class: 'ivu-valuation-detail' }, opportunityLabels[s.kind])) ?? []),
      ])
    }
    const renderValuationDetail = (company: Company) => {
      const row = screenFor(company)
      const a = row?.assessment
      if (!a) return h('p', { class: 'ivu-screen-warning' }, row?.note || '等待后台计算；缺失数据不代表估值合理。')
      const fact = (title: string, value: string) => h('div', [h('dt', title), h('dd', value)])
      return h('section', { class: 'ivu-valuation-detail-block' }, [
        h('h3', '估值依据 · 可复核规则'),
        renderValuationCell(company),
        h('dl', { class: 'ivu-valuation-facts' }, [
          fact('主方法', a.method || '暂无适用主方法'), fact('当前指标', metricText(a)), fact('规则合理区间', rangeText(a)),
          fact('保守安全边际', formatPct(a.conservativeMargin)), fact('可信度', a.confidence === 'medium' ? '中（非未来价值预测）' : '低'),
          fact('行情来源', a.quote?.source || '取数失败'), fact('行情日期', a.quote?.date || '—'),
          fact('行情获取时间', a.quote ? new Date(a.quote.fetchedAt).toLocaleString('zh-CN') : '—'),
          fact('财报期间', a.operating.reportDate || '—'), fact('经营口径', a.operating.periodLabel),
          fact('单季营收同比', formatPct(a.operating.revenueYoY)), fact('单季利润同比', formatPct(a.operating.profitYoY)),
          fact('单季营收环比', formatPct(row?.opportunity?.quality.revenueQoQ)), fact('单季利润环比', formatPct(row?.opportunity?.quality.profitQoQ)),
          fact('环比比较期间（未季调）', row?.opportunity?.quality.qoqPeriod || '未覆盖'),
          fact('TTM利润同比', formatPct(a.operating.ttmGrowth)), fact('未来估值', '东财 / 新浪研报参考见上方；情景估值待核验'),
        ]),
        h('p', { class: 'ivu-muted-small' }, '安全边际 = 1 − 当前市值 / 规则区间的保守价值下限；负数表示尚无保守折价。'),
        h('h4', '历史估值位置'),
        ...a.history.windows.map((w) => h('p', { class: 'ivu-detail-copy' }, `${w.years}年 ${a.history.metric} 分位：${formatPct(w.percentile)} · ${w.samples}个有效样本 · ${w.from || '—'} 至 ${w.to || '—'}`)),
        h('p', { class: 'ivu-muted-small' }, a.history.note),
        h('h4', '假设与限制'),
        h('ul', [...a.assumptions, ...a.limitations].map((text) => h('li', { class: 'ivu-detail-copy' }, text))),
        h('p', { class: 'ivu-muted-small' }, '档位规则：低于下限为低估；下半区合理偏低；上半区合理；超过上限为偏贵；超过上限20%为明显偏贵。阈值为可审计政策，不是统计概率。'),
      ])
    }
    const renderValuationCell = (company: Company) => {
      const row = screenFor(company)
      const a = row?.assessment
      const state = row ? rowState.value[row.code] : ''
      return h('div', { class: 'ivu-valuation' }, [
        h('span', { class: 'ivu-verdict ' + valuationTone(a?.status || 'unknown') }, a ? valuationLabels[a.status] : '无法判断'),
        h('span', { class: 'ivu-valuation-detail' }, a?.method ? `${a.method} ${metricText(a)}` : row?.note || '等待计算'),
        a?.range ? h('span', { class: 'ivu-valuation-detail' }, '规则区间 ' + rangeText(a)) : null,
        a ? h('span', { class: 'ivu-valuation-detail' }, `可信度${a.confidence === 'medium' ? '中' : '低'} · ${a.quote?.date || '无行情日期'}`) : null,
        h('span', { class: 'ivu-valuation-detail' }, state || (row ? '缓存结果' : '待刷新')),
        a ? h('time', { class: 'ivu-valuation-detail', dateTime: a.computedAt }, new Date(a.computedAt).toLocaleString('zh-CN')) : null,
      ])
    }
    const renderScreenStatus = () => h('section', { class: 'ivu-screen-status', 'aria-live': 'polite' }, [
      h('div', { class: 'ivu-screen-head' }, [
        h('strong', '估值看板 · 后台计算 / 自动缓存'),
        h('button', { type: 'button', class: 'ivu-open', disabled: screenLoading.value, onClick: () => void loadScreen(true) }, '检查更新'),
        h('span', { class: 'ivu-muted-small' }, screenLoading.value ? '读取缓存…' : refreshing.value ? `等待服务端更新 · 有效缓存 ${completed.value}/${screenMeta.value?.companies ?? 0}` : `有效缓存 ${completed.value}/${screenMeta.value?.companies ?? 0}`),
      ]),
      refreshing.value ? h('progress', { max: screenMeta.value?.companies || 1, value: completed.value, 'aria-label': '估值刷新进度' }) : null,
      screenError.value ? h('p', { class: 'ivu-screen-warning' }, '读取失败：' + screenError.value) : null,
      refreshErrors.value ? h('p', { class: 'ivu-screen-warning' }, `${refreshErrors.value}家数据请求失败，已标记阻断；不是公司价值结论。`) : null,
      h('span', { class: 'ivu-muted-small' }, '规则估值非买卖信号 · 东财 / 新浪未来估值参考见详情'),
      ...(screenMeta.value?.warnings ?? []).map(text => h('p', { class: 'ivu-muted-small' }, text)),
      screenMeta.value?.oldestComputedAt ? h('p', { class: 'ivu-muted-small' }, `计算时间范围：${new Date(screenMeta.value.oldestComputedAt).toLocaleString('zh-CN')} — ${new Date(screenMeta.value.generatedAt!).toLocaleString('zh-CN')} · 规则指纹 ${screenMeta.value.revision.slice(0, 12)}`) : null,
    ])

    const renderResearchForecastCell = (company: Company) => {
      const forecast = researchById.get(company.id)?.forecast
      if (!forecast) return h('button', { type: 'button', onClick: () => { selectedId.value = company.id } }, '查看东财 / 新浪未来估值')
      return h('div', { class: 'ivu-valuation' }, [
        ...forecast.forecastYears.map((entry) =>
          h('span', { class: 'ivu-valuation-detail', key: String(entry.year) },
            `${entry.year}净利 ${entry.netProfitYi == null ? '—' : entry.netProfitYi.toFixed(2) + '亿'} · EPS ${entry.epsYuan == null ? '—' : entry.epsYuan.toFixed(2)}`)),
        h('span', { class: 'ivu-valuation-detail' }, forecast.source.publisher + ' · ' + forecast.asOf),
      ])
    }

    const renderTable = () => h('div', { class: 'ivu-table-wrap' }, [
      h('table', { class: 'ivu-table' }, [
        h('thead', [h('tr', [
          h('th', '公司与证券'),
          h('th', '行业 / 细分赛道'),
          h('th', '首选研究市场'),
          h('th', '研究层级'),
          h('th', '估值判定'),
          h('th', '机会线索 / 验证'),
          h('th', '历史位置'),
          h('th', '经营趋势'),
          h('th', '未来估值 / 券商预测'),
          h('th', '状态'),
          h('th', { class: 'ivu-action-col' }, '详情'),
        ])]),
        h('tbody', filteredCompanies.value.map((company) =>
          h('tr', { key: company.id, class: selectedId.value === company.id ? 'ivu-row-selected' : '' }, [
            h('td', [
              h('strong', { class: 'ivu-company-name' }, company.displayName),
              h('span', { class: 'ivu-ticker-line' }, codeText(company)),
            ]),
            h('td', [
              h('span', { class: 'ivu-row-sector' }, sectorsById.get(company.primarySectorId)?.name || '—'),
              h('span', { class: 'ivu-row-track' }, tracksById.get(company.primaryTrackId)?.name || '—'),
            ]),
            h('td', [h('div', { class: 'ivu-market-tags' },
              [h('span', { class: 'ivu-market-chip is-preferred', key: company.preferredMarket }, marketLabels[company.preferredMarket] || company.preferredMarket),
                ...Array.from(new Set(company.securities.map((security) => security.market))).filter((item) => item !== company.preferredMarket).map((item) =>
                  h('span', { class: 'ivu-market-chip', key: item }, marketLabels[item] || item),
                )],
            )]),
            h('td', h('span', { class: 'ivu-priority' }, company.priority)),
            h('td', renderValuationCell(company)),
            h('td', renderOpportunityCell(company)),
            h('td', (screenFor(company)?.assessment?.history.windows ?? []).map((w) => h('div', { class: 'ivu-valuation-detail' }, `${w.years}年PE：${w.percentile == null ? '样本不足 / 不适用' : formatPct(w.percentile)}`))),
            h('td', [
              h('div', { class: 'ivu-valuation-detail' }, '单季营收同比 ' + formatPct(screenFor(company)?.assessment?.operating.revenueYoY)),
              h('div', { class: 'ivu-valuation-detail' }, '单季利润同比 ' + formatPct(screenFor(company)?.assessment?.operating.profitYoY)),
              h('div', { class: 'ivu-valuation-detail' }, 'TTM利润同比 ' + formatPct(screenFor(company)?.assessment?.operating.ttmGrowth)),
              h('div', { class: 'ivu-valuation-detail' }, '单季营收环比 ' + formatPct(screenFor(company)?.opportunity?.quality.revenueQoQ)),
              h('div', { class: 'ivu-valuation-detail' }, '单季利润环比 ' + formatPct(screenFor(company)?.opportunity?.quality.profitQoQ)),
              h('div', { class: 'ivu-valuation-detail' }, screenFor(company)?.assessment?.operating.reportDate || '未覆盖'),
            ]),
            h('td', renderResearchForecastCell(company)),
            h('td', [
              h('span', { class: 'ivu-status' }, statusLabels[company.watchStatus] || company.watchStatus),
              h('span', { class: 'ivu-ticker-line' }, company.classificationStatus === 'verified' ? '证券身份已核验' : '证券身份待核验'),
            ]),
            h('td', { class: 'ivu-action-col' }, [
              h('button', {
                type: 'button', class: 'ivu-open',
                onClick: () => chooseCompany(company.id),
                'aria-label': '查看' + company.displayName + '详情',
              }, '查看 ↗'),
            ]),
          ]),
        )),
      ]),
    ])

    const renderTrackCards = () => h('div', { class: 'ivu-track-grid' }, groupedTracks.value.map(({ track, companies }) =>
      h('article', { class: 'ivu-track-card', key: track.id }, [
        h('div', { class: 'ivu-track-head' }, [
          h('div', [
            h('small', track.id + ' · ' + (sectorsById.get(track.sectorId)?.name || '')),
            h('h3', track.name),
          ]),
          h('span', { class: 'ivu-track-count' }, companies.length + ' 家'),
        ]),
        h('div', { class: 'ivu-track-companies' }, companies.map(renderCompanyToken)),
        h('div', { class: 'ivu-track-caption' }, [
          h('strong', '研究重点'),
          h('p', track.researchFocus),
        ]),
        h('div', { class: 'ivu-track-caption ivu-track-risk' }, [
          h('strong', '核查风险'),
          h('p', track.risksToReview),
        ]),
      ]),
    ))

    const focusMode = ref<'all' | OpportunityKind | 'risk' | 'repair_data' | 'review_risk' | 'verify_thesis' | 'monitor'>('all')
    const queueLabels = { repair_data: '数据修复', review_risk: '风险复核', verify_thesis: '论点验证', monitor: '常规观察' }
    const focusLabels = { all: '全部线索', ...opportunityLabels, ...queueLabels, risk: '风险 / 缺口' }
    const focusGroups = computed(() => {
      const groups: Record<keyof typeof focusLabels, Company[]> = { all: [], historical_discount: [], earnings_delivery: [], forward_gap: [], drawdown: [], risk: [], repair_data: [], review_risk: [], verify_thesis: [], monitor: [] }
      for (const company of universe.companies) {
        const row = screenFor(company)
        const o = row?.opportunity
        if (!o) continue
        if (!freshOpportunity(row)) { groups.risk.push(company); continue }
        if (o.workflow) groups[o.workflow.queue].push(company)
        if (['blocked', 'insufficient_data'].includes(o.stage)) groups.risk.push(company)
        const triggered = o.signals.filter((s) => s.state === 'triggered')
        for (const signal of triggered) groups[signal.kind].push(company)
        if (triggered.length && ['research_candidate', 'clue'].includes(o.stage)) groups.all.push(company)
      }
      const rank = (c: Company) => screenFor(c)?.opportunity?.stage === 'research_candidate' ? 0 : screenFor(c)?.opportunity?.stage === 'clue' ? 1 : 2
      for (const list of Object.values(groups)) list.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))
      return groups
    })
    const focusCards = computed(() => {
      const sectors = new Map<string, number>()
      return focusGroups.value[focusMode.value].filter((company) => {
        const count = sectors.get(company.primarySectorId) ?? 0
        sectors.set(company.primarySectorId, count + 1)
        return count < 2
      }).slice(0, 6)
    })
    const renderFocus = () => h('section', { class: 'ivu-focus', 'aria-labelledby': 'ivu-focus-heading' }, [
      h('div', { class: 'ivu-section-heading' }, [
        h('div', [h('div', { class: 'ivu-eyebrow' }, 'EVIDENCE BEFORE OPPORTUNITY'), h('h2', { id: 'ivu-focus-heading' }, '机会研究雷达'), h('p', '四类线索分别发现，三道验证决定研究优先级。没有综合推荐分。')]),
        h('span', { class: 'ivu-focus-scope' }, '全池研究入口 · 每行业最多2家 · 最多6家'),
      ]),
      h('div', { class: 'ivu-focus-tabs', role: 'group', 'aria-label': '机会线索分类' }, Object.entries(focusLabels).map(([key, label]) =>
        h('button', { type: 'button', 'aria-pressed': focusMode.value === key, 'aria-label': label, onClick: () => { focusMode.value = key as keyof typeof focusLabels } }, [label, h('span', String(focusGroups.value[key as keyof typeof focusLabels].length))]))),
      focusCards.value.length ? h('div', { class: 'ivu-focus-grid' }, focusCards.value.map((company) => {
        const row = screenFor(company)!
        const o = row.opportunity!
        const a = row.assessment
        const clues = o.signals.filter((s) => s.state === 'triggered' && (['all', 'risk'].includes(focusMode.value) || s.kind === focusMode.value))
        const gate = o.gates.find((g) => g.state === 'fail') ?? o.gates.find((g) => g.state === 'unknown')
        return h('article', { class: 'ivu-focus-card', key: company.id }, [
          h('div', { class: 'ivu-focus-card-top' }, [h('span', sectorsById.get(company.primarySectorId)?.name || '—'), h('span', { class: 'ivu-verdict ' + opportunityTone(freshOpportunity(row) ? o.stage : '') }, freshOpportunity(row) ? opportunityStageLabels[o.stage] : '缓存待刷新')]),
          h('h3', company.displayName), h('p', { class: 'ivu-focus-code' }, `${company.preferredTicker} · ${tracksById.get(company.primaryTrackId)?.name || ''}`),
          h('div', { class: 'ivu-opportunity-tags' }, clues.map((c) => h('span', opportunityLabels[c.kind]))),
          h('p', { class: 'ivu-focus-reason' }, freshOpportunity(row) ? clues[0]?.summary ?? gate?.reasons[0] ?? '等待证据核查' : '缓存过期或本轮刷新失败，不据此形成当前机会判断。'),
          h('p', { class: 'ivu-focus-reason' }, gate ? `${gateLabels[gate.key]}：${gate.reasons[0]}` : '三道量化初筛通过；仍需核查公告、扣非、现金流与股本稀释。'),
          o.workflow ? h('p', { class: 'ivu-focus-reason' }, freshOpportunity(row) ? queueLabels[o.workflow.queue] + ' · ' + o.workflow.pathLabel + '：' + o.workflow.nextAction : '待刷新后重新确定研究任务。') : null,
          h('div', { class: 'ivu-focus-metrics' }, [
            h('div', [h('span', a?.method || '主估值方法'), h('strong', a ? metricText(a) : '—')]),
            h('div', [h('span', 'TTM利润同比'), h('strong', formatPct(o.quality.ttmGrowth))]),
            h('div', [h('span', '单季营收环比'), h('strong', formatPct(o.quality.revenueQoQ))]),
            h('div', [h('span', '单季利润环比'), h('strong', formatPct(o.quality.profitQoQ))]),
          ]),
          h('div', { class: 'ivu-focus-card-bottom' }, [
            h('span', `${o.policyVersion} · ${new Date(o.computedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`),
            h('button', { type: 'button', class: 'ivu-open', 'aria-label': '研究' + company.displayName, onClick: () => chooseCompany(company.id) }, '查看证据链 ↗'),
          ]),
        ])
      })) : h('div', { class: 'ivu-focus-empty', role: 'status' }, focusMode.value === 'forward_gap' ? '暂无已复核且与当前行情日期、币种、市值匹配的未来情景线索；请在公司详情的研究闭环中补充并核验假设。' : screenLoading.value || refreshing.value ? '当前已计算结果暂无此类线索，等待本轮刷新。' : '暂无满足规则的线索，不为填满卡片而降低门槛。'),
      h('details', { class: 'ivu-focus-policy' }, [h('summary', '研究规则、阈值与覆盖边界'), h('p', `历史折价：3年与5年PE分位均≤${formatPct(opportunityPolicy.historyPercentileMax)}；盈利兑现：TTM利润同比≥${formatPct(opportunityPolicy.ttmGrowthMin)}，连续${opportunityPolicy.earningsQuarters}个正式单季营收同比≥${formatPct(opportunityPolicy.quarterRevenueGrowthMin)}、利润同比≥${formatPct(opportunityPolicy.quarterProfitGrowthMin)}，不以PEG直接判低估。回撤：雪球前复权${Object.entries(opportunityPolicy.returns).map(([days, threshold]) => days + '交易日跌幅≥' + formatPct(-threshold)).join('、')}，或距252交易日最高收盘价回撤≥${formatPct(-opportunityPolicy.drawdown252Max)}。金融/周期企业不套用通用增长规则。`), h('p', '量化验证：有效行情和报表、经营现金转化与两年利润/负债初筛、适用主方法下价格未超规则区间。正式相邻单季环比必须可比；下降指标需至少两年同季度转换均下降，且本期不弱于历史中位数超过5个百分点，才解除环比待核查。该比较不是季调或因果证明，其他经营门槛不放宽。上季基数非正、缺季或预告不计算环比。存在缺口时只保留线索，不自动通过。历史折价与回撤有共同价格因素，命中多个不加分。验证阶段优先，同阶段按观察池顺序，每行业最多2家；与下方筛选独立。'), h('p', `阈值为${opportunityPolicy.version}研究政策，尚未完成样本外收益检验。未来估值、行业相对收益、市场预期差及定性护城河尚需证据；所有结果仅用于研究，不自动交易。`)]),
    ])

    return () => h('main', { class: 'ivu-page' }, [
      h('div', { class: 'ivu-shell' }, [
        h('header', { class: 'ivu-page-header' }, [
          h('div', [h('div', { class: 'ivu-eyebrow' }, 'INVESTMENT UNIVERSE'), h('h1', '观察池与主动组合'), h('p', '证据驱动研究 · 组合约束优先 · 必要时才调整')]),
          h('div', { class: 'ivu-header-summary' }, [h('strong', String(universe.companies.length)), h('span', '观察公司'), h('i', '/'), h('strong', String(universe.sectors.length)), h('span', '行业'), h('i', '/'), h('strong', '≤39'), h('span', '持仓上限')]),
        ]),
        h(ActivePortfolioPanel, { onSelectSecurity: (code: string) => { const company = universe.companies.find(c => c.securities.some(s => portfolioSecurityCode(s) === code)); if (company) chooseCompany(company.id) } }),
        renderScreenStatus(),
        renderFocus(),
        h('dialog', {
          ref: detailDialog, class: 'ivu-detail-dialog',
          'aria-label': selected.value ? selected.value.displayName + '详情与证据链' : '公司详情与证据链',
          onCancel: (event: Event) => { event.preventDefault(); closeDetail() },
          onClick: (event: MouseEvent) => {
            if (event.target !== detailDialog.value) return
            const bounds = detailDialog.value!.getBoundingClientRect()
            if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeDetail()
          },
        }, selected.value ? [renderDetail(selected.value)] : []),
        h('div', { class: 'ivu-workspace' }, [
          h('div', { class: 'ivu-main-content' }, [
            h('div', { class: 'ivu-topline' }, [
              h('div', [
                h('div', { class: 'ivu-eyebrow' }, 'EXPLORE COMPANIES'),
                h('h2', { id: 'observation-universe' }, '完整观察池'),
                h('p', '集中筛选行业、估值与经营状态，横向比较全部候选。'),
              ]),
              h('button', {
                type: 'button', class: 'ivu-export', disabled: filteredCompanies.value.length === 0,
                onClick: () => downloadCsv(filteredCompanies.value),
              }, '导出当前结果 CSV ↗'),
            ]),
            h('div', { class: 'ivu-controls' }, [
              h('label', { class: 'ivu-search-field' }, [
                h('span', { class: 'ivu-label' }, '搜索公司 / 代码 / 业务定位'),
                h('input', {
                  id: 'ivu-search', type: 'search', class: 'ivu-search',
                  placeholder: '输入如 中际旭创、NVDA、光模块…',
                  value: query.value,
                  onInput: (event: Event) => { query.value = (event.target as HTMLInputElement).value },
                }),
              ]),
              h('div', { class: 'ivu-filters' }, [
                selectControl('机会验证状态', opportunityFilter.value, [['', '全部验证状态'], ...Object.entries(opportunityStageLabels)], (value) => { opportunityFilter.value = value }),
                selectControl('机会线索', signalFilter.value, [['', '全部机会线索'], ...Object.entries(opportunityLabels)], (value) => { signalFilter.value = value }),
                selectControl('估值档位', valuationFilter.value, [['', '全部估值'], ...Object.entries(valuationLabels)], (value) => { valuationFilter.value = value }),
                selectControl('一级行业', sectorId.value,
                  [['', '全部行业'], ...universe.sectors.map((item): [string, string] => [item.id, item.name])], setSector),
                selectControl('细分赛道', trackId.value,
                  [['', '全部赛道'], ...trackOptions.value.map((item): [string, string] => [item.id, item.name])],
                  (value) => { trackId.value = value }),
                selectControl('首选研究市场', market.value,
                  [['', '全部市场'], ['CN','A股'], ['HK','港股'], ['US','美股'], ['KR','韩股']],
                  (value) => { market.value = value }),
                selectControl('研究层级', priority.value,
                  [['', '全部层级'], ...Object.entries(priorityLabels)], (value) => { priority.value = value }),
                selectControl('观察状态', status.value,
                  [['', '全部状态'], ...Object.entries(statusLabels)], (value) => { status.value = value }),
                selectControl('排序', sort.value, [
                  ['industry', '按行业/A股优先'], 
                  ['name', '按公司名称'],
                  ['priority', '按研究层级'],
                ], (value) => { sort.value = value }),
              ]),
            ]),
            h('div', { class: 'ivu-result-tools' }, [
              h('div', { class: 'ivu-result-count', 'aria-live': 'polite' }, [
                h('strong', String(filteredCompanies.value.length)),
                ' 家公司 · ',
                h('strong', String(visibleTracks.value)),
                ' 条赛道',
                filteredCompanies.value.length < universe.companies.length
                  ? h('button', { type: 'button', class: 'ivu-clear', onClick: resetFilters }, '清除筛选')
                  : null,
              ]),
              h('div', { class: 'ivu-view-buttons', role: 'group', 'aria-label': '列表显示模式' }, [
                h('button', { type: 'button', 'aria-pressed': view.value === 'companies', class: view.value === 'companies' ? 'is-active' : '', onClick: () => { view.value = 'companies' } }, '公司列表'),
                h('button', { type: 'button', 'aria-pressed': view.value === 'tracks', class: view.value === 'tracks' ? 'is-active' : '', onClick: () => { view.value = 'tracks' } }, '按赛道浏览'),
              ]),
            ]),
            filteredCompanies.value.length
              ? (view.value === 'companies' ? renderTable() : renderTrackCards())
              : h('div', { class: 'ivu-empty', role: 'status' }, [
                h('strong', '没有找到符合条件的公司'),
                h('p', '可以调整行业、市场或搜索关键词。'),
                h('button', { type: 'button', class: 'ivu-open', onClick: resetFilters }, '重置筛选'),
              ]),
          ]),
        ]),
        h('details', { class: 'ivu-review-fold' }, [h('summary', '每日研究与策略复盘'), renderDailyPanel(chooseCompany)]),
        h('footer', { class: 'ivu-page-foot' }, [
          h('span', '数据口径：经营公司与上市证券分离；行业为待验证的研究归类。'),
          h('span', '来源：config/investment-universe.json · 日期 ' + universe.asOf),
        ]),
      ]),
    ])
  },
})

const root = document.getElementById('investment-universe-vue-root')
if (root) createApp(InvestmentUniversePage).mount(root)
