import { createApp, defineComponent, h, onMounted, ref } from 'vue'

export type SituationView = 'today' | 'holdings' | 'opportunities' | 'evidence'

type ApiEnvelope<T> = { code?: number; data?: T; msg?: string }
type AnyRecord = Record<string, unknown>

const viewMeta: Record<SituationView, { title: string; subtitle: string; href: string }> = {
  today: { title: '今日交易态势', subtitle: '只呈现需要处理的变化、风险与动作候选。', href: 'situation.html' },
  holdings: { title: '我的持仓影响', subtitle: '将持仓和关注公司映射到最新事件、信号与行动条件。', href: 'situation-holdings.html' },
  opportunities: { title: '机会池', subtitle: '按催化、基本面、市场确认和估值风险审视行业与公司候选。', href: 'situation-opportunities.html' },
  evidence: { title: '证据与复盘', subtitle: '核查原始证据、事件链、历史快照和候选处置。', href: 'situation-evidence.html' },
}

const actionLabels: Record<string, string> = {
  establish: '建仓候选', add: '加仓候选', reduce: '减仓候选', exit: '退出候选', rebalance: '调仓候选', review: '需要核查', research: '机会研究',
}

const stateLabels: Record<string, string> = {
  supportive: '环境偏支持', pressure: '环境有压力', mixed: '信号分歧', data_insufficient: '数据不足',
  confirmed: '已确认', lead: '待核查', conflicting: '证据冲突', scheduled: '已排期',
}

function asRecord(value: unknown): AnyRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as AnyRecord : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function pickArray(source: unknown, keys: string[]): unknown[] {
  const record = asRecord(source)
  for (const key of keys) {
    const value = record[key]
    if (Array.isArray(value)) return value
  }
  return []
}

function text(value: unknown, fallback = '—'): string {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  return fallback
}

function listText(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => text(item, '')).filter(Boolean).join('；') || '—'
  return text(value)
}

function summaryText(value: unknown, fallback = '尚无结构化说明'): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  const record = asRecord(value)
  return text(record.headline ?? record.summary ?? record.methodology ?? record.detail, fallback)
}

function formatDate(value: unknown): string {
  if (!value) return '时间待确认'
  const numeric = typeof value === 'number' ? value : Number(value)
  const date = new Date(Number.isFinite(numeric) && numeric > 1_000_000_000 ? numeric : String(value))
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : String(value)
}

function scoreText(value: unknown): string {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric.toFixed(2) : text(value, '—')
}

function readFollowCodes(): string[] {
  try {
    const raw = localStorage.getItem('follow') || ''
    return [...new Set(raw.split(',').map((item) => item.trim()).filter(Boolean))]
  } catch {
    return []
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  const body = await response.json() as ApiEnvelope<T>
  if (!response.ok || body.code !== 200) throw new Error(body.msg || `请求失败 (${response.status})`)
  return body.data as T
}

function evidenceHref(item: AnyRecord): string {
  const firstEvidence = asRecord(asArray(item.evidence)[0])
  const evidenceId = text(item.evidenceId ?? item.evidence_id ?? firstEvidence.evidenceId ?? firstEvidence.evidence_id ?? item.id, '')
  return evidenceId ? `situation-evidence.html?evidence=${encodeURIComponent(evidenceId)}` : 'situation-evidence.html'
}

function candidateId(item: AnyRecord): string {
  return text(item.candidateId ?? item.candidate_id ?? item.id, '')
}

function stateBadge(state: unknown) {
  const normalized = text(state, '数据不足').toLowerCase()
  const className = normalized.includes('risk') || normalized.includes('pressure') || normalized.includes('urgent') || normalized.includes('exit')
    ? 'situation-badge danger'
    : normalized.includes('support') || normalized.includes('ready') || normalized.includes('confirmed')
      ? 'situation-badge positive'
      : 'situation-badge neutral'
  return h('span', { class: className }, stateLabels[normalized] ?? text(state, '数据不足'))
}

const style = `
.situation-page{background:#f4f7f8;color:#172b2a;min-height:calc(100vh - 8rem)}.situation-shell{max-width:1440px;margin:0 auto;padding:1.25rem}.situation-hero{background:radial-gradient(circle at 92% 18%,rgba(96,165,250,.27),transparent 24rem),linear-gradient(135deg,#112f43,#0f766e);border-radius:1.25rem;color:#f8fafc;padding:1.45rem}.situation-hero h1{font-size:clamp(1.65rem,3vw,2.35rem);margin:.35rem 0}.situation-eyebrow{color:#99f6e4;font-size:.75rem;font-weight:800;letter-spacing:.12em}.situation-nav{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:1rem}.situation-nav a{border:1px solid rgba(255,255,255,.35);border-radius:999px;color:#e8fffb;font-size:.86rem;padding:.35rem .75rem;text-decoration:none}.situation-nav a.active{background:#fff;color:#115e59}.situation-grid{display:grid;gap:1rem}.situation-grid-2{grid-template-columns:repeat(2,minmax(0,1fr))}.situation-grid-3{grid-template-columns:repeat(3,minmax(0,1fr))}.situation-panel,.situation-card{background:#fff;border:1px solid #dbe7e5;border-radius:1rem;box-shadow:0 .5rem 1.3rem rgba(15,52,51,.05)}.situation-panel{padding:1rem}.situation-card{padding:.9rem}.situation-panel-title{color:#123a67;font-size:1.04rem;font-weight:800;margin:0}.situation-meta{color:#64748b;font-size:.8rem}.situation-badge{border-radius:999px;display:inline-block;font-size:.72rem;font-weight:750;padding:.24rem .55rem}.situation-badge.positive{background:#dcfce7;color:#166534}.situation-badge.danger{background:#fee2e2;color:#991b1b}.situation-badge.neutral{background:#e2e8f0;color:#475569}.situation-item{border-top:1px solid #edf2f1;padding:.8rem 0}.situation-item:first-child{border-top:0;padding-top:0}.situation-item h3{font-size:.98rem;margin:0}.situation-empty{background:#f8fafc;border:1px dashed #a9bbb9;border-radius:.75rem;color:#526462;padding:1rem}.situation-error{background:#fff1f2;border:1px solid #fecdd3;border-radius:.8rem;color:#9f1239;padding:1rem}.situation-button{border:1px solid #0f766e;background:#fff;border-radius:.5rem;color:#0f766e;font-size:.78rem;margin:.45rem .45rem 0 0;padding:.28rem .55rem}.situation-button:hover{background:#0f766e;color:#fff}.situation-button:disabled{cursor:wait;opacity:.6}.situation-link{color:#0f766e;font-size:.82rem;font-weight:700;text-decoration:none}.situation-metric{font-size:1.45rem;font-weight:850;line-height:1.1;margin:.4rem 0}.situation-kv{display:grid;gap:.38rem;grid-template-columns:7.2rem minmax(0,1fr);font-size:.85rem}.situation-kv dt{color:#64748b;font-weight:600}.situation-kv dd{margin:0}.situation-table-wrap{overflow:auto}.situation-table{font-size:.84rem;margin:0;min-width:760px}.situation-table td,.situation-table th{vertical-align:top}.situation-status{background:rgba(255,255,255,.11);border:1px solid rgba(255,255,255,.18);border-radius:.8rem;min-width:15rem;padding:.8rem}@media(max-width:991px){.situation-grid-3{grid-template-columns:1fr 1fr}}@media(max-width:640px){.situation-shell{padding:.75rem}.situation-grid-2,.situation-grid-3{grid-template-columns:1fr}.situation-kv{grid-template-columns:6rem minmax(0,1fr)}}
`

function pageNav(active: SituationView) {
  return h('nav', { class: 'situation-nav', 'aria-label': '态势感知页面' }, (Object.keys(viewMeta) as SituationView[]).map((view) =>
    h('a', { href: viewMeta[view].href, class: view === active ? 'active' : undefined, 'aria-current': view === active ? 'page' : undefined }, viewMeta[view].title)
  ))
}

function panel(title: string, content: unknown, note?: string) {
  return h('section', { class: 'situation-panel' }, [
    h('div', { class: 'd-flex justify-content-between align-items-start gap-3 mb-3' }, [
      h('div', [h('h2', { class: 'situation-panel-title' }, title), note ? h('div', { class: 'situation-meta mt-1' }, note) : null]),
    ]),
    content,
  ])
}

function empty(message: string) {
  return h('div', { class: 'situation-empty' }, message)
}

function itemCard(raw: unknown, options: { action?: boolean; onDisposition?: (id: string, disposition: string) => void; busyId?: string } = {}) {
  const item = asRecord(raw)
  const id = candidateId(item)
  const title = text(item.title ?? item.name ?? item.targetName ?? item.targetId ?? item.target_id, '未命名条目')
  const detail = summaryText(item.summary ?? item.proposedPlan ?? item.explanation ?? item.rationale ?? item.detail)
  const action = text(item.actionType ?? item.action_type ?? item.action, '')
  return h('article', { class: 'situation-item', key: id || title }, [
    h('div', { class: 'd-flex justify-content-between gap-3' }, [h('h3', title), stateBadge(action ? actionLabels[action] ?? action : (item.state ?? item.status))]),
    h('p', { class: 'mb-1 small text-secondary' }, detail),
    h('div', { class: 'situation-meta' }, `置信度 ${text(item.confidence, '未提供')} · 截止 ${formatDate(item.asOf ?? item.as_of ?? item.observedAt ?? item.observed_at)}`),
    item.prerequisites || item.preconditions ? h('div', { class: 'situation-meta mt-1' }, `执行前提：${listText(item.prerequisites ?? item.preconditions)}`) : null,
    item.invalidations || item.invalidation ? h('div', { class: 'situation-meta mt-1' }, `失效条件：${listText(item.invalidations ?? item.invalidation)}`) : null,
    h('div', { class: 'mt-1' }, [
      (item.evidenceId || item.evidence_id || asArray(item.evidence).length) ? h('a', { class: 'situation-link', href: evidenceHref(item) }, '查看证据链') : null,
      options.action && id && options.onDisposition ? ['confirmed', 'deferred', 'ignored', 'research'].map((disposition) => h('button', {
        class: 'situation-button', disabled: options.busyId === id, onClick: () => options.onDisposition?.(id, disposition),
      }, disposition === 'confirmed' ? '确认' : disposition === 'deferred' ? '延后' : disposition === 'ignored' ? '忽略' : '进入研究')) : null,
    ]),
  ])
}

function todayBody(data: unknown, dispositionNotice: { value: string }, submitDisposition: (id: string, disposition: string) => void, busyId: { value: string }) {
  const record = asRecord(data)
  const markets = pickArray(data, ['markets', 'marketStates', 'market_states'])
  const changes = pickArray(data, ['changes', 'todayChanges', 'today_changes'])
  const candidates = pickArray(data, ['actionCandidates', 'action_candidates', 'queue', 'actions'])
  const risks = pickArray(data, ['futureRisks', 'future_risks', 'calendar', 'upcomingEvents', 'upcoming_events'])
  return [
    h('div', { class: 'situation-grid situation-grid-2 mt-4' }, [
      panel('当前态势', markets.length ? h('div', { class: 'situation-grid situation-grid-3' }, markets.map((raw) => {
        const market = asRecord(raw)
        return h('article', { class: 'situation-card' }, [h('div', { class: 'd-flex justify-content-between gap-2' }, [h('strong', text(market.name ?? asRecord(market.summary).name ?? market.market ?? market.id)), stateBadge(market.state ?? market.verdict)]), h('div', { class: 'situation-metric' }, scoreText(market.score ?? asRecord(market.summary).score ?? market.summaryScore ?? market.scoreLabel)), h('div', { class: 'situation-meta' }, summaryText(market.summary ?? market.explanation ?? market.detail, '暂无可用传导结论'))])
      })) : empty('尚无已验证的市场态势数据；数据源恢复后才会生成结论。'), '市场状态与数据健康'),
      panel('今日变化', changes.length ? changes.map((item) => itemCard(item)) : empty('相对上一快照没有已确认的新变化。'), '新出现、升级、降级或失效的事件与信号'),
    ]),
    panel('今日动作队列', candidates.length ? [dispositionNotice.value ? h('div', { class: 'alert alert-info small py-2' }, dispositionNotice.value) : null, ...candidates.map((item) => itemCard(item, { action: true, onDisposition: submitDisposition, busyId: busyId.value }))] : empty('今日无计划性交易动作。系统不会用低质量资讯填充队列。'), '候选需要满足个人规则；确认只记录处置，不会自动下单'),
    panel('未来风险', risks.length ? risks.map((item) => itemCard(item)) : empty('未来 7 天没有已验证的重要日历、公告窗口或规则临界点。'), '只显示可追溯的日历与风险事件'),
  ]
}

function holdingsBody(data: unknown, followCodes: string[]) {
  const rows = pickArray(data, ['holdings', 'items', 'rows', 'companies'])
  if (!followCodes.length) return [panel('关注或持仓尚未配置', empty('先在公司页点击 ☆ 加入“我关注的”，或在组合配置中录入持仓、成本和目标仓位。没有个人配置时，系统不会生成虚假的仓位建议。'))]
  return [panel('已关联的关注公司', rows.length ? h('div', { class: 'situation-table-wrap' }, [h('table', { class: 'table table-sm situation-table' }, [h('thead', [h('tr', [h('th', '公司'), h('th', '最新影响'), h('th', '动作候选'), h('th', '证据')])]), h('tbody', rows.map((raw) => { const row = asRecord(raw); const evidence = row.evidenceId || row.evidence_id || row.evidence; return h('tr', [h('td', [h('strong', text(row.name ?? row.companyName ?? row.code)), h('div', { class: 'situation-meta' }, text(row.code ?? row.targetId, ''))]), h('td', [stateBadge(row.impactState ?? row.state), h('div', { class: 'small mt-1' }, text(row.impact ?? row.summary ?? row.detail))]), h('td', text(row.action ?? row.actionType ?? row.candidateAction, '等待证据')), h('td', evidence ? h('a', { class: 'situation-link', href: evidenceHref(row) }, '查看') : '—')]) }))])]) : empty(`已请求 ${followCodes.length} 个关注代码，但暂时没有可关联的态势数据。`), `本机关注：${followCodes.join('、')}`)]
}

function opportunitiesBody(data: unknown) {
  const industries = pickArray(data, ['industries', 'industryOpportunities', 'industry_opportunities'])
  const companies = pickArray(data, ['companies', 'companyOpportunities', 'company_opportunities', 'items'])
  return [
    h('div', { class: 'situation-grid situation-grid-2 mt-4' }, [
      panel('行业机会', industries.length ? industries.map((item) => itemCard(item)) : empty('尚无符合证据门槛的行业机会。')), 
      panel('公司机会', companies.length ? companies.map((item) => itemCard(item)) : empty('尚无符合证据门槛的公司机会。')),
    ]),
    panel('机会筛选原则', h('div', { class: 'situation-kv' }, [h('dt', '催化'), h('dd', '政策、供需、产品、订单、业绩或行业事件。'), h('dt', '基本面'), h('dd', '盈利预期、经营数据与景气验证。'), h('dt', '市场确认'), h('dd', '相对强弱、成交、波动和价格结构。'), h('dt', '估值与风险'), h('dd', '预期透支、组合相关暴露、反证和失效条件。')]), '“建仓候选”不等同于立即买入'),
  ]
}

function evidenceBody(data: unknown, params: URLSearchParams) {
  const record = asRecord(data)
  const id = params.get('evidence') || params.get('event') || params.get('snapshot')
  if (!id) return [panel('选择证据或历史快照', empty('从态势、持仓或机会卡点击“查看证据链”进入；也可使用 evidence、event 或 snapshot 查询参数打开指定条目。'))]
  const evidence = asRecord(record.evidence ?? record)
  const event = asRecord(record.event)
  const snapshot = asRecord(record.snapshot)
  return [
    panel('原始证据', h('dl', { class: 'situation-kv' }, [h('dt', '标题'), h('dd', text(evidence.title ?? event.title)), h('dt', '来源'), h('dd', text(evidence.sourceName ?? evidence.source_id ?? evidence.sourceId)), h('dt', '发布时间'), h('dd', formatDate(evidence.publishedAt ?? evidence.published_at ?? event.occurredAt)), h('dt', '证据等级'), h('dd', text(evidence.evidenceGrade ?? evidence.evidence_grade ?? evidence.grade)), h('dt', '原文'), h('dd', evidence.url ? h('a', { class: 'situation-link', href: String(evidence.url), target: '_blank', rel: 'noreferrer' }, '打开原始来源') : '未提供')]), '每项结论必须能回到原始来源'),
    panel('事件与历史快照', h('dl', { class: 'situation-kv' }, [h('dt', '事件状态'), h('dd', text(event.status ?? record.status)), h('dt', '发生时间'), h('dd', formatDate(event.occurredAt ?? event.occurred_at)), h('dt', '快照时点'), h('dd', formatDate(snapshot.asOf ?? snapshot.as_of ?? record.asOf)), h('dt', '规则版本'), h('dd', text(snapshot.ruleVersion ?? snapshot.rule_version ?? record.ruleVersion)), h('dt', '说明'), h('dd', text(snapshot.summary ?? event.summary ?? record.summary))]), '历史查询应只返回该时点已知、未过期的证据'),
  ]
}

function endpointFor(view: SituationView, params: URLSearchParams): string | null {
  if (view === 'today') return '/api/situations/today'
  if (view === 'holdings') { const codes = readFollowCodes(); return `/api/situations/holdings?codes=${encodeURIComponent(codes.join(','))}` }
  if (view === 'opportunities') return '/api/situations/opportunities'
  const evidence = params.get('evidence'); if (evidence) return `/api/situations/evidence/${encodeURIComponent(evidence)}`
  const event = params.get('event'); if (event) return `/api/situations/events/${encodeURIComponent(event)}`
  const snapshot = params.get('snapshot'); if (snapshot) return `/api/situations/snapshots/${encodeURIComponent(snapshot)}`
  return null
}

export function mountSituationPage(view: SituationView, rootId: string): void {
  const root = document.getElementById(rootId)
  if (!root) return
  const Page = defineComponent({
    name: `Situation${view}`,
    setup() {
      const data = ref<unknown>(null); const loading = ref(true); const error = ref(''); const notice = ref(''); const busyId = ref('')
      const params = new URLSearchParams(window.location.search)
      const load = async () => {
        const endpoint = endpointFor(view, params)
        if (!endpoint) { loading.value = false; return }
        loading.value = true; error.value = ''
        try { data.value = await request(endpoint) } catch (err) { error.value = err instanceof Error ? err.message : String(err) } finally { loading.value = false }
      }
      const submitDisposition = async (id: string, disposition: string) => {
        busyId.value = id; notice.value = ''
        try { await request(`/api/situations/candidates/${encodeURIComponent(id)}/disposition`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ disposition }) }); notice.value = '处置已记录；不会自动下单。'; await load() } catch (err) { notice.value = `未能保存处置：${err instanceof Error ? err.message : String(err)}` } finally { busyId.value = '' }
      }
      onMounted(() => { void load() })
      const content = () => {
        if (loading.value) return h('div', { class: 'situation-panel mt-4 text-center text-muted py-5' }, '正在读取可审计态势数据…')
        if (error.value) return h('div', { class: 'situation-error mt-4' }, [h('strong', '数据暂不可用。'), h('div', { class: 'small mt-1' }, error.value), h('button', { class: 'situation-button', onClick: () => void load() }, '重试')])
        if (view === 'today') return todayBody(data.value, notice, submitDisposition, busyId)
        if (view === 'holdings') return holdingsBody(data.value, readFollowCodes())
        if (view === 'opportunities') return opportunitiesBody(data.value)
        return evidenceBody(data.value, params)
      }
      return () => h('main', { class: 'situation-page' }, [h('style', style), h('div', { class: 'situation-shell' }, [
        h('section', { class: 'situation-hero' }, [h('div', { class: 'd-lg-flex justify-content-between align-items-start gap-4' }, [h('div', [h('div', { class: 'situation-eyebrow' }, 'SITUATION AWARENESS'), h('h1', viewMeta[view].title), h('p', { class: 'mb-0 opacity-75' }, viewMeta[view].subtitle), pageNav(view)]), h('div', { class: 'situation-status mt-3 mt-lg-0' }, [h('div', { class: 'small opacity-75' }, '交易安全边界'), h('div', { class: 'fw-bold mt-1' }, '候选，不是自动指令'), h('div', { class: 'small opacity-75 mt-1' }, '低证据只提示核查；系统不自动下单。')])])]),
        content(),
      ])])
    },
  })
  createApp(Page).mount(root)
}
