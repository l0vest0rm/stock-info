import { computed, createApp, defineComponent, h, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ValuationAssessment } from '../../../../../shared/valuation-assessment'
import universeJson from '../../../../../config/investment-universe.json'
import { renderDailyPanel } from './investment-daily-panel'

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
  /** Derived by scripts/sync-investment-universe-valuation.mjs; see src/modules/research/domain/valuation-coverage.ts. */
  valuationArchetype: string
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

/**
 * A row of the server-computed screen.
 *
 * The page must not compute this itself.  The band, the implied ceiling, the
 * margin of safety and the verdict all depend on statements, a dated quote and
 * the archetype's allowed methods; duplicating that in the browser would give two
 * definitions of "cheap" and eventually two answers.  `GET /api/research/valuation-screen`
 * runs the same `screenValuationCandidate` the daily note quotes.
 */
type ScreenRow = {
  assessment?: ValuationAssessment;
  code: string
  name: string
  market: string
  archetype: string
  verdict: 'research_candidate' | 'watch' | 'blocked'
  basis: { key: string; label?: string; reportDate: string } | null
  position: { metric: string; marketCap: number; impliedHigh: number; marginOfSafety: number } | null
  blockReasons: string[]
  note: string
  growth: { verdict: string; ttmGrowth: number | null; reportDate: string | null; note: string | null } | null
  executable: false
}
type ScreenSnapshot = {
  asOf: string
  generatedAt: string | null
  targets: string[]
  companies: number
  byVerdict: Record<string, number>
  blockedDetail: Record<string, number>
  rows: ScreenRow[]
  stale: boolean
  warnings: string[]
}

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
 * The tiering rule lives in `src/modules/research/domain/valuation-coverage.ts`
 * and is written into the universe by the sync script.  The page reads those
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
     * The server-computed screen, fetched once on mount.
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
    const screenRows = ref<Map<string, ScreenRow>>(new Map())
    const screenMeta = ref<ScreenSnapshot | null>(null)
    const screenError = ref('')
    const screenLoading = ref(true)
    const refreshing = ref(false)
    const completed = ref(0)
    const refreshErrors = ref(0)
    const rowState = ref<Record<string, string>>({})
    const valuationFilter = ref('')
    const controller = new AbortController()

    async function api(path: string, method = 'GET') {
      const response = await fetch(path, { method, headers: { accept: 'json' }, cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]) })
      const body = await response.json().catch(() => null)
      if (!response.ok || body?.code !== 200) throw new Error(body?.msg || 'HTTP ' + response.status)
      return body.data
    }
    function acceptRow(row: ScreenRow) {
      screenRows.value = new Map(screenRows.value).set(row.code.toUpperCase(), row)
    }
    async function loadScreen() {
      if (refreshing.value) return
      screenError.value = ''
      try {
        const snapshot = await api('/api/research/valuation-screen') as ScreenSnapshot
        screenMeta.value = snapshot
        for (const row of snapshot.rows) acceptRow(row)
        screenLoading.value = false
        refreshing.value = true
        completed.value = 0
        refreshErrors.value = 0
        rowState.value = Object.fromEntries(snapshot.targets.map((code) => [code, '等待刷新']))
        let cursor = 0
        async function worker() {
          while (!controller.signal.aborted) {
            const code = snapshot.targets[cursor++]
            if (!code) return
            rowState.value[code] = '刷新中'
            try {
              // Only two in-flight securities. Each response is server-computed
              // and durably cached; no whole-pool Worker background lifetime.
              let result = await api('/api/research/valuation-screen/refresh/' + encodeURIComponent(code), 'POST')
              for (let retry = 0; result.state === 'busy' && retry < 60 && !controller.signal.aborted; retry++) {
                await new Promise((resolve) => setTimeout(resolve, 3000))
                result = await api('/api/research/valuation-screen/refresh/' + encodeURIComponent(code), 'POST')
              }
              if (result.state !== 'complete' || !result.row) throw new Error('其他页面正在计算，请稍后重试')
              acceptRow(result.row)
              rowState.value[code] = '本轮已计算'
            } catch (error) {
              if (controller.signal.aborted) return
              rowState.value[code] = '刷新失败 · 旧结果仅供参考'
              refreshErrors.value++
            } finally { completed.value++ }
          }
        }
        await Promise.all([worker(), worker()])
      } catch (error) {
        if (!controller.signal.aborted) screenError.value = error instanceof Error ? error.message : String(error)
      } finally { screenLoading.value = false; refreshing.value = false }
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
    }
    function chooseCompany(id: string) {
      selectedId.value = id
      void nextTick(() => document.getElementById('ivu-company-detail')?.focus())
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
      view.value = p.get('view') === 'tracks' ? 'tracks' : 'companies'
      selectedId.value = universe.companies.some((company) => company.id === p.get('company')) ? p.get('company') || '' : ''
    }
    watch([query, sectorId, trackId, market, status, priority, sort, view, selectedId], () => {
      const p = new URLSearchParams()
      const values: Record<string, string> = {
        q: query.value, sector: sectorId.value, track: trackId.value,
        market: market.value, status: status.value, priority: priority.value,
        sort: sort.value === 'industry' ? '' : sort.value,
        view: view.value === 'companies' ? '' : view.value,
        company: selectedId.value,
      }
      for (const [key, value] of Object.entries(values)) if (value) p.set(key, value)
      const newUrl = window.location.pathname + (p.size ? '?' + p.toString() : '') + window.location.hash
      if (newUrl !== window.location.pathname + window.location.search + window.location.hash) {
        window.history.replaceState(window.history.state, '', newUrl)
      }
    })
    onMounted(() => {
      window.addEventListener('popstate', readNavigationState)
      void loadScreen()
    })
    onBeforeUnmount(() => { controller.abort(); window.removeEventListener('popstate', readNavigationState) })

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
          h('button', { type: 'button', class: 'ivu-close', onClick: () => { selectedId.value = '' }, 'aria-label': '关闭公司详情' }, '×'),
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
          fact('TTM利润同比', formatPct(a.operating.ttmGrowth)), fact('未来估值', '未覆盖 · 等待有来源的预测'),
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
        h('button', { type: 'button', class: 'ivu-open', disabled: refreshing.value || screenLoading.value, onClick: () => void loadScreen() }, '重新计算'),
        h('span', { class: 'ivu-muted-small' }, screenLoading.value ? '读取缓存…' : refreshing.value ? `后台刷新 ${completed.value}/${screenMeta.value?.companies ?? 0}` : `本轮计算结束 ${completed.value}/${screenMeta.value?.companies ?? 0}`),
      ]),
      refreshing.value ? h('progress', { max: screenMeta.value?.companies || 1, value: completed.value, 'aria-label': '估值刷新进度' }) : null,
      screenError.value ? h('p', { class: 'ivu-screen-warning' }, '读取失败：' + screenError.value) : null,
      refreshErrors.value ? h('p', { class: 'ivu-screen-warning' }, `${refreshErrors.value}家请求失败；保留的旧结果不代表本轮估值。`) : null,
      h('span', { class: 'ivu-muted-small' }, '先展示缓存，再逐行更新 · 规则估值非买卖信号 · 未来估值待补'),
    ])

    const renderTable = () => h('div', { class: 'ivu-table-wrap' }, [
      h('table', { class: 'ivu-table' }, [
        h('thead', [h('tr', [
          h('th', '公司与证券'),
          h('th', '行业 / 细分赛道'),
          h('th', '首选研究市场'),
          h('th', '研究层级'),
          h('th', '估值判定'),
          h('th', '历史位置'),
          h('th', '经营趋势'),
          h('th', '未来估值'),
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
            h('td', (screenFor(company)?.assessment?.history.windows ?? []).map((w) => h('div', { class: 'ivu-valuation-detail' }, `${w.years}年PE：${w.percentile == null ? '样本不足 / 不适用' : formatPct(w.percentile)}`))),
            h('td', [
              h('div', { class: 'ivu-valuation-detail' }, '单季营收 ' + formatPct(screenFor(company)?.assessment?.operating.revenueYoY)),
              h('div', { class: 'ivu-valuation-detail' }, '单季利润 ' + formatPct(screenFor(company)?.assessment?.operating.profitYoY)),
              h('div', { class: 'ivu-valuation-detail' }, 'TTM利润 ' + formatPct(screenFor(company)?.assessment?.operating.ttmGrowth)),
              h('div', { class: 'ivu-valuation-detail' }, screenFor(company)?.assessment?.operating.reportDate || '未覆盖'),
            ]),
            h('td', h('span', { class: 'ivu-valuation-detail' }, '未覆盖 · 待补预测')),
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

    const focusMode = ref<'opportunity' | 'change' | 'data'>('opportunity')
    const focusLabels = { opportunity: '估值机会', change: '经营变化', data: '数据待核查' }
    const focusGroups = computed(() => {
      const groups: Record<keyof typeof focusLabels, Array<{ company: Company; reason: string; score: number }>> = { opportunity: [], change: [], data: [] }
      for (const company of universe.companies) {
        const row = screenFor(company)
        const a = row?.assessment
        if (!row) continue // Pending is not a finding about the company.
        const stale = !a || Date.now() - Date.parse(a.computedAt) > 10 * 60000 || rowState.value[row.code]?.startsWith('刷新失败')
        const growth = a?.operating.ttmGrowth
        if (!stale && a && growth != null && (growth <= -.1 || growth >= .3)) {
          groups.change.push({ company, reason: `TTM利润同比 ${formatPct(growth)}，${growth < 0 ? '需核查盈利收缩原因' : '需核查增长来源与持续性'}${a.operating.provisional ? '（含预告/快报）' : ''}`, score: growth < 0 ? 100 + Math.abs(growth) : growth })
        }
        if (stale || a?.status === 'unknown') {
          if (stale || !row.blockReasons.includes('earnings_shrinking')) groups.data.push({ company, reason: stale ? '缓存过期或刷新未成功，先核验数据' : row.note, score: stale ? 2 : 1 })
          continue
        }
        if (!a) continue
        if (['undervalued', 'fair_low'].includes(a.status) && a.confidence === 'medium' && growth != null && growth >= 0 && !a.operating.provisional) {
          groups.opportunity.push({ company, reason: `${valuationLabels[a.status]}，TTM利润同比 ${formatPct(growth)}；优先核查盈利可持续性`, score: a.conservativeMargin ?? -Infinity })
        }
      }
      for (const group of Object.values(groups)) group.sort((a, b) => b.score - a.score || a.company.id.localeCompare(b.company.id))
      return groups
    })
    const focusCards = computed(() => {
      const sectors = new Map<string, number>()
      return focusGroups.value[focusMode.value].filter(({ company }) => {
        const count = sectors.get(company.primarySectorId) ?? 0
        sectors.set(company.primarySectorId, count + 1)
        return count < 2
      }).slice(0, 6)
    })
    const renderFocus = () => h('section', { class: 'ivu-focus', 'aria-labelledby': 'ivu-focus-heading' }, [
      h('div', { class: 'ivu-section-heading' }, [
        h('div', [h('div', { class: 'ivu-eyebrow' }, 'RESEARCH FIRST'), h('h2', { id: 'ivu-focus-heading' }, '优先关注'), h('p', '先看值得研究的变化，再浏览完整观察池。')]),
        h('span', { class: 'ivu-focus-scope' }, '全池精选 · 每行业最多2家 · 最多6家'),
      ]),
      h('div', { class: 'ivu-focus-tabs', role: 'group', 'aria-label': '重点关注分类' }, Object.entries(focusLabels).map(([key, label]) =>
        h('button', { type: 'button', 'aria-pressed': focusMode.value === key, onClick: () => { focusMode.value = key as keyof typeof focusLabels } }, [label, h('span', String(focusGroups.value[key as keyof typeof focusLabels].length))]))),
      focusCards.value.length ? h('div', { class: 'ivu-focus-grid' }, focusCards.value.map(({ company, reason }) => {
        const a = screenFor(company)?.assessment
        return h('article', { class: 'ivu-focus-card', key: company.id }, [
          h('div', { class: 'ivu-focus-card-top' }, [h('span', sectorsById.get(company.primarySectorId)?.name || '—'), h('span', { class: 'ivu-verdict ' + valuationTone(focusMode.value === 'data' ? 'unknown' : a?.status ?? 'unknown') }, focusMode.value === 'data' ? '待核查' : a ? valuationLabels[a.status] : '无法判断')]),
          h('h3', company.displayName),
          h('p', { class: 'ivu-focus-code' }, `${company.preferredTicker} · ${tracksById.get(company.primaryTrackId)?.name || ''}`),
          h('p', { class: 'ivu-focus-reason' }, reason),
          h('div', { class: 'ivu-focus-metrics' }, [
            h('div', [h('span', a?.method || '主方法'), h('strong', a ? metricText(a) : '—')]),
            h('div', [h('span', '保守安全边际'), h('strong', formatPct(a?.conservativeMargin))]),
          ]),
          h('div', { class: 'ivu-focus-card-bottom' }, [
            h('span', a ? `${rowState.value[screenFor(company)!.code] === '本轮已计算' ? '已更新' : '缓存'} · ${new Date(a.computedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '数据不足'),
            h('button', { type: 'button', class: 'ivu-open', 'aria-label': '研究' + company.displayName, onClick: () => chooseCompany(company.id) }, '查看依据 ↗'),
          ]),
        ])
      })) : h('div', { class: 'ivu-focus-empty', role: 'status' }, screenLoading.value ? '正在读取估值结果…' : refreshing.value ? '已计算结果中暂无符合条件的公司，等待本轮刷新。' : '暂无符合条件的公司；不为填满卡片而放宽规则。'),
      h('details', { class: 'ivu-focus-policy' }, [h('summary', '如何选出这些公司？'), h('p', '估值机会：未过期的低估或合理偏低结果、可信度中、正式报告TTM利润同比非负；按保守安全边际排序。经营变化：TTM利润同比≤−10%或≥30%，先看收缩。数据待核查：估值无法判断、缓存过期或刷新失败。各组每行业最多2家，展示前6家；与下方列表筛选独立。刷新未完成时不是完整全池排名。规则估值并非内在价值，以上仅为研究优先级，不是交易建议。')]),
    ])

    return () => h('main', { class: 'ivu-page' }, [
      h('div', { class: 'ivu-shell' }, [
        h('header', { class: 'ivu-page-header' }, [
          h('div', [h('div', { class: 'ivu-eyebrow' }, 'INVESTMENT UNIVERSE'), h('h1', '优质公司观察池'), h('p', '分散行业 · 研究好公司 · 等待合理估值')]),
          h('div', { class: 'ivu-header-summary' }, [h('strong', String(universe.companies.length)), h('span', '观察公司'), h('i', '/'), h('strong', String(universe.sectors.length)), h('span', '行业'), h('i', '/'), h('strong', '20–30'), h('span', '目标持有')]),
        ]),
        renderScreenStatus(),
        renderFocus(),
        selected.value ? renderDetail(selected.value) : null,
        h('div', { class: 'ivu-workspace' }, [
          h('div', { class: 'ivu-main-content' }, [
            h('div', { class: 'ivu-topline' }, [
              h('div', [
                h('div', { class: 'ivu-eyebrow' }, 'EXPLORE COMPANIES'),
                h('h2', '完整观察池'),
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
