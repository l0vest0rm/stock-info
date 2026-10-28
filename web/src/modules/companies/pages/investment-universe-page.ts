import { computed, createApp, defineComponent, h, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
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
    const sectorCounts = new Map(universe.sectors.map((sector) => [
      sector.id,
      universe.companies.filter((company) => company.primarySectorId === sector.id).length,
    ]))
    const marketCounts = Object.fromEntries(['CN','US','HK'].map((code) => [code, universe.companies.filter((company) => company.preferredMarket === code).length])) as Record<string,number>

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
    onMounted(() => window.addEventListener('popstate', readNavigationState))
    onBeforeUnmount(() => window.removeEventListener('popstate', readNavigationState))

    const countBlock = (value: string | number, label: string, extra: string) =>
      h('div', { class: 'ivu-stat' }, [
        h('strong', { class: 'ivu-stat-value' }, String(value)),
        h('span', { class: 'ivu-stat-label' }, label),
        h('span', { class: 'ivu-stat-extra' }, extra),
      ])

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
          h('span', '估值日期：' + (company.valuationAsOf || '未录入')),
          h('span', '风险因子：' + (company.factorExposures.length ? describeFactors(company.factorExposures) : '待补充证据')),
          h('span', '主题标签：' + (company.themeTags.length ? company.themeTags.join('、') : '待补充证据')),
          h('span', '分级依据：' + (company.basis.join('；') || '待补充')),
        ]),
      ])
    }

    const renderTable = () => h('div', { class: 'ivu-table-wrap' }, [
      h('table', { class: 'ivu-table' }, [
        h('thead', [h('tr', [
          h('th', '公司与证券'),
          h('th', '行业 / 细分赛道'),
          h('th', '首选研究市场'),
          h('th', '研究层级'),
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

    const renderSidebar = () => h('aside', { class: 'ivu-sidebar', 'aria-label': '一级行业筛选' }, [
      h('div', { class: 'ivu-sidebar-title' }, [
        h('h2', '行业目录'),
        h('span', '11 个一级行业'),
      ]),
      h('div', { class: 'ivu-sector-list' }, [
        h('button', {
          class: 'ivu-sector-button' + (sectorId.value === '' ? ' is-active' : ''),
          type: 'button', onClick: () => setSector(''),
          'aria-pressed': sectorId.value === '',
        }, [
          h('span', '全部行业'),
          h('strong', String(universe.companies.length)),
        ]),
        ...universe.sectors.map((sector) => h('button', {
          key: sector.id, type: 'button',
          class: 'ivu-sector-button' + (sectorId.value === sector.id ? ' is-active' : ''),
          'aria-pressed': sectorId.value === sector.id,
          onClick: () => setSector(sector.id),
        }, [
          h('span', [h('span', sector.name), h('small', '参考席位 ' + sector.portfolioIllustration.targetSlots)]),
          h('strong', String(sectorCounts.get(sector.id) || 0)),
        ])),
      ]),
      h('div', { class: 'ivu-sidebar-note' }, [
        h('strong', '25席位参考 · A股优先'),
        h('p', 'A股 ' + universe.strategyPreferences.illustrative25HoldingSlots.CN + ' / 美股 ' + universe.strategyPreferences.illustrative25HoldingSlots.US + ' / 港股 ' + universe.strategyPreferences.illustrative25HoldingSlots.HK + '；与实际持仓无关，按账户资金分别管理。'),
      ]),
    ])

    return () => h('main', { class: 'ivu-page' }, [
      h('div', { class: 'ivu-shell' }, [
        h('section', { class: 'ivu-hero' }, [
          h('div', { class: 'ivu-hero-top' }, [
            h('div', [
              h('div', { class: 'ivu-eyebrow ivu-eyebrow-light' }, 'A-SHARE FIRST · INVESTMENT RESEARCH UNIVERSE · V2'),
              h('h1', '优质公司观察池'),
              h('p', '以A股为主要研究范围，保留少量美股与港股核心候选；11个行业、37个细分赛道，重视竞争优势、合理估值和跨赛道的共同风险。'),
            ]),
            h('span', { class: 'ivu-asof' }, '研究快照 · ' + universe.asOf),
          ]),
          h('div', { class: 'ivu-stats' }, [
            countBlock(universe.companies.length + ' / ' + universe.scope.watchlistLimit, '候选观察公司', universe.tracks.length + '赛道 / ' + universe.sectors.length + '行业'),
            countBlock(marketCounts.CN, 'A股优先', '观察池的主要研究对象'),
            countBlock(marketCounts.US, '美股优先', '仅保留少量核心公司'),
            countBlock(marketCounts.HK, '港股优先', '补充观察标的'),
          ]),
        ]),
        h('div', { class: 'ivu-notice', role: 'note' }, [
          h('strong', '研究配置 · 非实时信号'),
          h('span', '名单来自版本化 JSON。研究观点需结合有效证据和同日估值，不等于真实持仓或自动交易；每日复盘按需人工发起，未启用后台持续监控。'),
        ]),
        renderDailyPanel(chooseCompany),
        h('div', { class: 'ivu-workspace' }, [
          renderSidebar(),
          h('div', { class: 'ivu-main-content' }, [
            h('div', { class: 'ivu-topline' }, [
              h('div', [
                h('div', { class: 'ivu-eyebrow' }, 'EXPLORE COMPANIES'),
                h('h2', '探索候选公司'),
                h('p', 'A股排在各行业前列，可按首选研究市场、赛道和状态筛选。'),
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
            selected.value ? renderDetail(selected.value) : null,
            filteredCompanies.value.length
              ? (view.value === 'companies' ? renderTable() : renderTrackCards())
              : h('div', { class: 'ivu-empty', role: 'status' }, [
                h('strong', '没有找到符合条件的公司'),
                h('p', '可以调整行业、市场或搜索关键词。'),
                h('button', { type: 'button', class: 'ivu-open', onClick: resetFilters }, '重置筛选'),
              ]),
          ]),
        ]),
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
