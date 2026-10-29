import { computed, defineComponent, h, onMounted, onBeforeUnmount, ref } from 'vue'
import type { PortfolioRead, PortfolioDraft, PortfolioTask, PortfolioVersion } from '../../../../../shared/active-portfolio'

const labels = { risk: '风险复核', data: '数据缺口', setup: '配置待办', research: '论点验证' }
const choices = { keep: '维持不动', reviewed: '已复核', defer: '延期复核' }
const percent = (n: number | null) => n === null ? '待核对' : (n * 100).toFixed(2) + '%'
const localTime = (s: string) => { if (!s) return ''; const d = new Date(s); return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16) }
const isoTime = (s: string) => s && Number.isFinite(new Date(s).getTime()) ? new Date(s).toISOString() : ''
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))

export const ActivePortfolioPanel = defineComponent({
  emits: ['selectSecurity'],
  setup(_, { emit }) {
    const data = ref<PortfolioRead | null>(null), draft = ref<PortfolioDraft | null>(null)
    const error = ref(''), message = ref(''), busy = ref(false), unavailable = ref(false), dirty = ref(false)
    const editorMode = ref<'snapshot' | 'proposal'>('snapshot')
    const proposalTitle = ref(''), proposalRationale = ref(''), estimatedCosts = ref<number | null>(null), externalCashFlow = ref(0)
    const proposalReviewId = ref(''), proposalReviewReason = ref('')
    const tab = ref('today'), editing = ref(false), selected = ref<PortfolioTask | null>(null)
    const reason = ref(''), choice = ref<'keep' | 'reviewed' | 'defer'>('reviewed'), until = ref('')
    const history = ref<PortfolioVersion | null>(null), clock = ref(Date.now())
    const draftVersion = ref(0), decisionVersion = ref(0)
    const controller = new AbortController(); let timer: ReturnType<typeof setInterval> | undefined
    async function request(path = '/api/research/portfolio/workspace', body?: unknown) {
      const r = await fetch(path, { method: body ? 'POST' : 'GET', cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]) })
      const json = await r.json()
      if (!r.ok || json.code !== 200) { if (r.status === 404) unavailable.value = true; throw new Error(json.msg || '组合读取失败') }
      return json.data
    }
    async function load(reset = false) {
      if (busy.value) return
      busy.value = true
      try { data.value = await request(); error.value = ''; if (!draft.value || reset) { draft.value = clone(data.value!.current?.draft ?? data.value!.template); dirty.value = false; draftVersion.value = data.value?.current?.version ?? 0 } }
      catch (e) { if (!controller.signal.aborted) error.value = String(e instanceof Error ? e.message : e) }
      finally { busy.value = false }
    }
    async function save(command: { type: string; [key: string]: unknown }) {
      if (busy.value) return
      busy.value = true; message.value = ''
      try {
        data.value = await request(undefined, { expectedVersion: ['snapshot', 'proposal'].includes(command.type) ? draftVersion.value : decisionVersion.value, command })
        draft.value = clone(data.value!.current!.draft); draftVersion.value = data.value!.current!.version; dirty.value = false; selected.value = null; proposalReviewId.value = ''; editing.value = false
        error.value = ''; message.value = '已保存到本地私有版本记录；未执行交易'
      } catch (e) { error.value = String(e instanceof Error ? e.message : e) }
      finally { busy.value = false }
    }
    onMounted(async () => { await load(); timer = setInterval(() => { clock.value = Date.now(); if (!editing.value && !selected.value && !proposalReviewId.value && !unavailable.value) void load() }, 60000) })
    onBeforeUnmount(() => { clearInterval(timer); controller.abort() })
    const openTask = (t: PortfolioTask) => !t.decision || t.decision.choice === 'defer' && Date.parse(t.decision.until!) <= clock.value
    const pending = computed(() => data.value?.assessment.tasks.filter(openTask).length ?? 0)
    function field(label: string, value: string | number | null, change: (s: string) => void, type = 'text') {
      return h('label', { class: 'ap-field' }, [h('span', label), h('input', { type, value: value ?? '', step: type === 'number' ? 'any' : undefined, [type === 'datetime-local' ? 'onChange' : 'onInput']: (e: Event) => { change((e.target as HTMLInputElement).value); if (editing.value) dirty.value = true } })])
    }
    const number = (s: string) => s.trim() ? Number(s) : null
    function editor() {
      const d = draft.value!
      return h('div', { class: 'ap-editor' }, [
        h('h3', editorMode.value === 'proposal' ? '编辑假设目标组合（不改变真实持仓）' : '录入已核对的组合快照'),
        h('p', '仅本机保存，不写入公开研究配置。账户使用别名，不要填写账号或凭证。当前只支持无融资的股票与现金；请覆盖全部纳入组合的资产。'),
        editorMode.value === 'proposal' ? h('div', { class: 'ap-fields' }, [
          field('方案名称', proposalTitle.value, s => { proposalTitle.value = s }),
          field('方案理由与不调整的比较', proposalRationale.value, s => { proposalRationale.value = s }),
          field('预计总费用（基准币，未知留空）', estimatedCosts.value, s => { estimatedCosts.value = number(s) }, 'number'),
          field('新增资金/提取资金（基准币，提取为负）', externalCashFlow.value, s => { externalCashFlow.value = Number(s) }, 'number'),
          h('p', '沿用原快照的日期、币种和规则。只改数量及剩余现金，原持仓价格/汇率不得改变。新增证券需要同一时点的价格。'),
        ]) : h('div', { class: 'ap-fields' }, [
          field('基准币种（CNY/HKD/USD/KRW）', d.baseCurrency, s => { d.baseCurrency = s }),
          field('快照时间（本地时区）', localTime(d.asOf), s => { d.asOf = isoTime(s) }, 'datetime-local'),
          h('button', { type: 'button', onClick: () => { d.asOf = new Date().toISOString(); dirty.value = true } }, '用当前时间标记已核对'),
          field('来源与口径说明', d.source, s => { d.source = s }),
          field('评价基准与期限', d.rules.benchmark, s => { d.rules.benchmark = s }),
          field('单公司上限（%，留空不视为通过）', d.rules.maxCompanyWeight === null ? null : d.rules.maxCompanyWeight * 100, s => { d.rules.maxCompanyWeight = number(s) === null ? null : Number(s) / 100 }, 'number'),
          field('行业上限（%，留空不视为通过）', d.rules.maxSectorWeight === null ? null : d.rules.maxSectorWeight * 100, s => { d.rules.maxSectorWeight = number(s) === null ? null : Number(s) / 100 }, 'number'),
        ]),
        h('h4', '股票持仓'), h('p', '证券代码使用如600036.SH、00700.HK、AAPL.US。价格是每股原币价格；汇率为1单位原币折合多少基准币。本币汇率填1，未知价格或汇率留空。'),
        ...d.positions.map((p, i) => h('fieldset', { class: 'ap-fields' }, [h('legend', `持仓 ${i + 1}`),
          field(`账户 ${i + 1}`, p.account, s => { p.account = s }), field(`证券代码 ${i + 1}`, p.code, s => { p.code = s.trim().toUpperCase() }),
          field(`数量 ${i + 1}`, p.quantity, s => { p.quantity = Number(s) }, 'number'), field(`每股价格 ${i + 1}`, p.price, s => { p.price = number(s) }, 'number'),
          field(`币种 ${i + 1}`, p.currency, s => { p.currency = s.toUpperCase() }), field(`折算汇率 ${i + 1}`, p.fxToBase, s => { p.fxToBase = number(s) }, 'number'),
          h('button', { type: 'button', onClick: () => { d.positions.splice(i, 1); dirty.value = true } }, `移除持仓 ${i + 1}`),
        ])),
        h('button', { type: 'button', onClick: () => { d.positions.push({ account: '', code: '', quantity: 0, price: null, currency: d.baseCurrency, fxToBase: 1 }); dirty.value = true } }, '添加持仓'),
        h('h4', '账户现金'),
        ...d.cash.map((c, i) => h('fieldset', { class: 'ap-fields' }, [h('legend', `现金 ${i + 1}`),
          field(`现金账户 ${i + 1}`, c.account, s => { c.account = s }), field(`现金币种 ${i + 1}`, c.currency, s => { c.currency = s.toUpperCase() }),
          field(`现金金额 ${i + 1}`, c.amount, s => { c.amount = Number(s) }, 'number'), field(`现金汇率 ${i + 1}`, c.fxToBase, s => { c.fxToBase = number(s) }, 'number'),
          h('button', { type: 'button', onClick: () => { d.cash.splice(i, 1); dirty.value = true } }, `移除现金 ${i + 1}`),
        ])),
        h('button', { type: 'button', onClick: () => { d.cash.push({ account: '', currency: d.baseCurrency, amount: 0, fxToBase: 1 }); dirty.value = true } }, '添加现金'),
        h('div', { class: 'ap-actions' }, [h('button', { type: 'button', disabled: busy.value, onClick: () => save(editorMode.value === 'proposal' ? { type: 'proposal', proposal: { title: proposalTitle.value, rationale: proposalRationale.value, estimatedCosts: estimatedCosts.value, externalCashFlow: externalCashFlow.value, target: d } } : { type: 'snapshot', draft: d }) }, editorMode.value === 'proposal' ? '保存方案对比（不改持仓）' : '保存已核对快照'),
          h('button', { type: 'button', disabled: busy.value, onClick: async () => { if (dirty.value && !window.confirm('放弃未保存的编辑并读取最新版本？')) return; await load(true); editing.value = false } }, '放弃编辑并重新读取')]),
      ])
    }
    function taskCard(t: PortfolioTask) {
      return h('article', { class: 'ap-task', key: t.id }, [
        h('strong', `${labels[t.kind]} · ${t.title}`), h('p', t.reason), h('p', t.action),
        h('small', t.evidence.join(' · ')),
        t.decision ? h('p', `${choices[t.decision.choice]}：${t.decision.reason}${t.decision.until ? ' · 复核时间 ' + new Date(t.decision.until).toLocaleString() : ''}。原风险/缺口仍保留。`) : null,
        h('div', { class: 'ap-actions' }, [
          h('button', { type: 'button', disabled: busy.value || !data.value?.current, onClick: () => { selected.value = t; decisionVersion.value = data.value?.current?.version ?? 0; reason.value = ''; choice.value = 'reviewed'; until.value = '' } }, openTask(t) ? '处理并留痕' : '再次复核'),
          /\.(SH|SZ|BJ|HK|US|KS|KQ)$/.test(t.subject) ? h('button', { type: 'button', onClick: () => emit('selectSecurity', t.subject) }, '查看研究证据') : null,
        ]),
        selected.value?.id === t.id ? h('div', { class: 'ap-decision' }, [
          h('label', [h('span', '处理方式'), h('select', { 'aria-label': '处理方式', value: choice.value, onChange: (e: Event) => { choice.value = (e.target as HTMLSelectElement).value as typeof choice.value } }, Object.entries(choices).map(([value, name]) => h('option', { value }, name)))]),
          field('处理理由（必填）', reason.value, s => { reason.value = s }),
          choice.value === 'defer' ? field('下次复核时间', until.value, s => { until.value = s }, 'datetime-local') : null,
          h('button', { type: 'button', disabled: busy.value, onClick: () => save({ type: 'decision', taskId: t.id, choice: choice.value, reason: reason.value, until: choice.value === 'defer' ? isoTime(until.value) : null }) }, '保存复核记录'),
          h('button', { type: 'button', onClick: () => { selected.value = null } }, '取消'),
        ]) : null,
      ])
    }
    function renderProposals() {
      return h('div', [h('h3', '调整方案（与真实持仓分离）'), ...(data.value?.current?.proposals ?? []).map(p => h('article', { class: 'ap-task', key: p.id }, [
        h('strong', `${p.title} · ${{ draft: '待复核', confirmed: '已记录采纳，未成交', rejected: '不采纳' }[p.status]}${p.basedOnSnapshot !== data.value!.current!.snapshotVersion ? ' · 原快照已变化' : ''}`),
        h('p', p.rationale),
        h('p', `维持不动：${p.before.securityCount}只，股票${p.before.equityValue ?? '未知'}，现金${p.before.cashValue ?? '未知'}；目标：${p.after.securityCount}只，股票${p.after.equityValue ?? '未知'}，现金${p.after.cashValue ?? '未知'}。`),
        h('p', `总买卖金额/原总资产：${percent(p.comparison.turnover)}；资金差额：${p.comparison.fundingGap ?? '未知'}；预计费用：${p.estimatedCosts ?? '未知'}（均为基准币）。`),
        ...p.comparison.changes.map(c => h('p', `${c.account} · ${c.code}：${c.beforeQuantity} → ${c.afterQuantity}股，市值变动${c.valueChange ?? '未知'}`)),
        h('details', [h('summary', '公司与行业权重变化'), ...p.after.companies.map(c => h('p', `${c.name}：${percent(p.before.nav === null ? null : p.before.companies.find(b => b.id === c.id)?.weight ?? 0)} → ${percent(c.weight)}`)), ...p.before.companies.filter(c => !p.after.companies.some(a => a.id === c.id)).map(c => h('p', `${c.name}：${percent(c.weight)} → 0%`)), ...p.after.sectors.map(c => h('p', `${c.name}：${percent(p.before.nav === null ? null : p.before.sectors.find(b => b.id === c.id)?.weight ?? 0)} → ${percent(c.weight)}`)), ...p.before.sectors.filter(c => !p.after.sectors.some(a => a.id === c.id)).map(c => h('p', `${c.name}：${percent(c.weight)} → 0%`))]),
        ...p.comparison.issues.map(issue => h('p', issue)),
        p.reviewReason ? h('p', '处理理由：' + p.reviewReason) : null,
        p.status === 'draft' && p.basedOnSnapshot === data.value!.current!.snapshotVersion ? h('div', [
          proposalReviewId.value !== p.id ? h('button', { type: 'button', onClick: () => { proposalReviewId.value = p.id; proposalReviewReason.value = ''; decisionVersion.value = data.value!.current!.version } }, '记录方案决定') : [
            field('方案处理理由', proposalReviewReason.value, s => { proposalReviewReason.value = s }),
            ...([['confirmed', '记录采纳（未成交）'], ['rejected', '不采纳']] as const).map(([status, label]) => h('button', { type: 'button', disabled: busy.value, onClick: () => save({ type: 'review_proposal', id: p.id, status, reason: proposalReviewReason.value }) }, label)),
          ],
        ]) : null,
      ]))])
    }
    return () => h('section', { class: 'ap-panel', 'aria-label': '主动组合工作台' }, [
      h('div', { class: 'ivu-eyebrow' }, 'DIVERSIFIED ACTIVE PORTFOLIO'), h('h2', '主动组合工作台'),
      h('p', '每日更新信息，按证据复核，必要时才调整。持仓≤39只，不复制指数，不为凑数买入。'),
      unavailable.value ? h('p', '私有持仓与决策记录仅在本地Node工作区开放；公开观察池仍可使用。') : [
        h('nav', { class: 'ap-actions', 'aria-label': '组合工作区' }, [
          ...[['today', `今日待办${data.value ? ' · ' + pending.value : ''}`], ['portfolio', '我的组合'], ['history', '决策与复盘']].map(([value, label]) => h('button', { type: 'button', 'aria-pressed': tab.value === value, disabled: editing.value, onClick: () => { tab.value = value } }, label)),
          h('a', { href: '#observation-universe' }, '完整观察池 ↓'),
          h('button', { type: 'button', disabled: busy.value || editing.value || !!selected.value || !!proposalReviewId.value, onClick: () => load() }, '刷新待办'),
        ]),
        error.value ? h('p', { role: 'alert', class: 'ap-error' }, error.value + '；未保存的编辑仍保留。') : null,
        message.value ? h('p', { role: 'status' }, message.value) : null,
        !data.value ? h('p', busy.value ? '正在读取本地组合…' : '组合尚未读取成功') : [
          tab.value === 'today' ? [
            h('p', '站内复核清单：每分钟只读刷新；关闭页面不会推送通知。新快照或待办依据变化会重新打开复核。'),
            ...data.value.assessment.tasks.map(taskCard),
            !data.value.assessment.tasks.length ? h('p', '当前已覆盖规则未产生待办；不代表全面风险验证通过。') : null,
            !data.value.current ? h('button', { type: 'button', onClick: () => { tab.value = 'portfolio'; editorMode.value = 'snapshot'; editing.value = true } }, '建立我的组合') : null,
          ] : null,
          tab.value === 'portfolio' ? [
            h('p', `证券 ${data.value.assessment.securityCount} / 39 · 经营公司 ${data.value.assessment.companyCount} · 快照 ${data.value.current ? new Date(data.value.current.draft.asOf).toLocaleString() : '未录入'}`),
            h('p', `快照总资产：${data.value.assessment.nav === null ? '待核对' : data.value.assessment.nav.toLocaleString()} ${data.value.current?.draft.baseCurrency ?? ''} · 股票市值 ${data.value.assessment.equityValue?.toLocaleString() ?? '待核对'} · 现金 ${data.value.assessment.cashValue?.toLocaleString() ?? '待核对'}`),
            h('div', { class: 'ap-columns' }, [h('div', [h('h3', '单公司权重（合并多账户及多地上市）'), ...data.value.assessment.companies.map(c => h('p', `${c.name}：${percent(c.weight)}`))]), h('div', [h('h3', '一级行业权重'), ...data.value.assessment.sectors.map(s => h('p', `${s.name}：${percent(s.weight)}`))])]),
            data.value.current ? h('details', [h('summary', '已保存的持仓与现金明细'), ...data.value.current.draft.positions.map(p => h('p', `${p.account} · ${p.code} · ${p.quantity}股 · 每股${p.price ?? '未知'} ${p.currency} · 汇率${p.fxToBase ?? '未知'}`)), ...data.value.current.draft.cash.map(c => h('p', `${c.account} · 现金${c.amount} ${c.currency} · 汇率${c.fxToBase ?? '未知'}`))]) : null,
            !editing.value ? h('button', { type: 'button', onClick: () => { editorMode.value = 'snapshot'; draft.value = clone(data.value!.current?.draft ?? data.value!.template); draftVersion.value = data.value!.current?.version ?? 0; dirty.value = false; editing.value = true } }, data.value.current ? '编辑组合快照与规则' : '录入组合快照与规则') : null,
            !editing.value && data.value.current ? h('button', { type: 'button', onClick: () => { draft.value = clone(data.value!.current!.draft); draftVersion.value = data.value!.current!.version; editorMode.value = 'proposal'; proposalTitle.value = ''; proposalRationale.value = ''; estimatedCosts.value = null; externalCashFlow.value = 0; editing.value = true } }, '创建调整前后对比') : null,
            editing.value && draft.value ? editor() : null,
            renderProposals(),
          ] : null,
          tab.value === 'history' ? [renderProposals(), h('p', '不可变版本记录。复核不是成交；当前不计算真实组合收益。最近100个版本可读取，旧版本未删除。'),
            ...data.value.history.map(v => h('button', { type: 'button', onClick: async () => { try { history.value = await request('/api/research/portfolio/history/' + v.version) } catch (e) { error.value = String(e) } } }, `版本${v.version} · 快照${v.snapshotVersion} · ${new Date(v.recordedAt).toLocaleString()}`)),
            history.value ? h('article', [h('h3', `版本${history.value.version} · ${history.value.draft.positions.length}条持仓明细`), h('p', `来源：${history.value.draft.source}`), ...history.value.decisions.map(d => h('p', `${d.task.title}｜${choices[d.choice]}：${d.reason}｜${new Date(d.recordedAt).toLocaleString()}`))]) : null,
          ] : null,
          h('details', [h('summary', '口径与当前覆盖边界'), ...data.value.assessment.limitations.map(s => h('p', s))]),
        ],
      ],
    ])
  },
})
