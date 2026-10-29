import { defineComponent, h, ref, watch } from 'vue'
import type { ObservationResearchDraft, ObservationResearchRead, ObservationHistoryRead, ResearchSource, ExpectationsInput } from '../../../../../shared/observation-research'

const source = (): ResearchSource => ({ url: '', publishedAt: '', checkedAt: '', note: '' })
const scenarioNames = { bear: '悲观', base: '基准', bull: '乐观' }
const queueStatus = { draft: '草稿', reviewed: '人工复核完成', invalidated: '论点失效' }
const pct = (n: number | null) => n === null ? '—' : (n * 100).toFixed(1) + '%'
/** Local-only, source-backed research editor; never sends model requests. */
export const ObservationResearchPanel = defineComponent({
  props: { code: { type: String, required: true } },
  setup(props) {
    const model = ref<ObservationResearchRead | null>(null), history = ref<ObservationHistoryRead | null>(null)
    const draft = ref<ObservationResearchDraft | null>(null), message = ref(''), busy = ref(false), dirty = ref(false), historicalVersion = ref('')
    let generation = 0
    async function api(path: string, body?: unknown) {
      const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', signal: AbortSignal.timeout(120000) })
      const json = await response.json()
      if (!response.ok || json.code !== 200) throw new Error(json.msg || 'HTTP ' + response.status)
      return json.data
    }
    const path = () => '/api/research/observation/' + encodeURIComponent(props.code)
    async function load() {
      const id = ++generation, url = path(); busy.value = true; message.value = ''; model.value = null; history.value = null; draft.value = null; dirty.value = false
      try {
        const [m, hist] = await Promise.all([api(url), api(url + '/history')])
        if (id !== generation) return
        model.value = m; history.value = hist
        const current = m.current || m.template
        draft.value = structuredClone({ thesis: current.thesis, industryFacts: current.industryFacts, expectations: current.expectations })
      } catch (e) { if (id === generation) message.value = e instanceof Error ? e.message : '读取失败' }
      finally { if (id === generation) busy.value = false }
    }
    watch(() => props.code, load, { immediate: true })
    async function save() {
      if (!draft.value || !model.value || busy.value) return
      const id = generation, url = path(); busy.value = true; message.value = ''
      try {
        await api(url, { expectedVersion: model.value.current?.version ?? 0, draft: draft.value })
        if (id !== generation) return
        const m = await api(url)
        if (id !== generation) return
        model.value = m; dirty.value = false; historicalVersion.value = ''; message.value = '已保存新版本；原版本保留。行业与情景按本次证据重新计算，看板按新版本排队更新。'
      } catch (e) { if (id === generation) message.value = e instanceof Error ? e.message : '保存失败' }
      finally { if (id === generation) busy.value = false }
    }
    async function evaluate() {
      if (busy.value) return
      const id = generation, url = path(); busy.value = true
      try { const result = await api(url + '/evaluate', {}); if (id === generation) { history.value = result; message.value = '效果核验完成；未到期及缺口保持单列。' } }
      catch (e) { if (id === generation) message.value = e instanceof Error ? e.message : '核验失败' }
      finally { if (id === generation) busy.value = false }
    }
    async function restore() {
      if (!historicalVersion.value || busy.value) return
      const id = generation; busy.value = true
      try {
        const v = await api(path() + '?version=' + encodeURIComponent(historicalVersion.value))
        if (id !== generation) return
        draft.value = structuredClone({ thesis: v.thesis, industryFacts: v.industryFacts, expectations: v.expectations })
        draft.value!.thesis.status = 'draft'; draft.value!.thesis.changeReason = '基于历史版本 ' + historicalVersion.value + ' 重新研究：'
        dirty.value = true; message.value = '历史版本已载入编辑区；保存将追加新版本，不覆盖历史。'
      } catch (e) { if (id === generation) message.value = String(e) }
      finally { if (id === generation) busy.value = false }
    }
    function field(label: string, value: string | number, set: (v: string) => void, type = 'text') {
      return h('label', { class: 'oru-field' }, [h('span', label), h(type === 'textarea' ? 'textarea' : 'input', { type: type === 'textarea' ? undefined : type, value, step: type === 'number' ? 'any' : undefined, disabled: busy.value, onInput: (e: Event) => { set((e.target as HTMLInputElement).value); dirty.value = true } })])
    }
    function sources(label: string, s: ResearchSource) {
      return h('details', { class: 'oru-source' }, [h('summary', label + ' · 来源与口径（必填）'), field(label + ' HTTPS来源', s.url, v => s.url = v, 'url'), field(label + ' 发布日期', s.publishedAt, v => s.publishedAt = v, 'date'), field(label + ' 核验日期', s.checkedAt, v => s.checkedAt = v, 'date'), field(label + ' 口径/适用要求说明', s.note, v => s.note = v, 'textarea')])
    }
    function addExpectations() {
      if (!draft.value) return
      draft.value.expectations = { marketCap: 0, normalizedProfit: 0, currency: '', amountScale: 'base_units', priceDate: '', profitPeriod: '', years: 3, requiredReturn: .1, annualDilution: 0, sources: { marketCap: source(), profit: source(), assumptions: source() }, scenarios: (['bear','base','bull'] as const).map(name => ({ name, growth: 0, terminalMultiple: 0, payoutRatio: 0, rationale: '' })) }
      dirty.value = true
    }
    function renderExpectations(i: ExpectationsInput) {
      return h('div', [
        h('p', '金额统一使用同一币种本币元；3年/10%/零稀释仅为可编辑输入初值，不是预测或推荐，须提供假设依据。'),
        h('div', { class: 'oru-grid' }, [
          field('当前总市值（本币元）', i.marketCap, v => i.marketCap = Number(v), 'number'), field('正常化归母利润（本币元）', i.normalizedProfit, v => i.normalizedProfit = Number(v), 'number'), field('统一币种（如CNY）', i.currency, v => i.currency = v.toUpperCase()),
          field('价格交易日', i.priceDate, v => i.priceDate = v, 'date'), field('盈利期间截至', i.profitPeriod, v => i.profitPeriod = v, 'date'), field('情景年数', i.years, v => i.years = Number(v), 'number'), field('要求年回报率（小数）', i.requiredReturn, v => i.requiredReturn = Number(v), 'number'), field('年均股本稀释（小数）', i.annualDilution, v => i.annualDilution = Number(v), 'number'),
        ]), sources('市值', i.sources.marketCap), sources('正常化利润', i.sources.profit), sources('情景假设', i.sources.assumptions),
        ...i.scenarios.map(s => h('fieldset', [h('legend', scenarioNames[s.name]), h('div', { class: 'oru-grid' }, [field(scenarioNames[s.name] + ' 利润增速（小数）', s.growth, v => s.growth = Number(v), 'number'), field(scenarioNames[s.name] + ' 期末PE倍数', s.terminalMultiple, v => s.terminalMultiple = Number(v), 'number'), field(scenarioNames[s.name] + ' 分红比例（小数）', s.payoutRatio, v => s.payoutRatio = Number(v), 'number')]), field(scenarioNames[s.name] + ' 假设理由/再投资约束', s.rationale, v => s.rationale = v, 'textarea')])),
      ])
    }
    return () => h('section', { class: 'oru-panel' }, [
      h('h3', '研究闭环 · 行业验证 / 预期差 / 论点版本 / 前瞻评估'),
      h('p', '本机研究工作区，不公开同步；禁止填写账户、仓位、成本或交易指令。保存是人工研究记录，不是模型认证或买卖许可。'),
      message.value ? h('p', { role: 'status', class: 'oru-message' }, message.value) : null,
      !model.value || !draft.value ? h('p', busy.value ? '读取研究记录…' : '研究工作区暂不可用；公开看板仍可独立读取。') : h('div', [
        h('p', `当前版本 ${model.value.current?.version ?? 0} · ${model.value.current?.recordedAt ?? '尚无记录'}${dirty.value ? ' · 编辑未保存，以下计算仍对应已保存版本' : ''}`),
        h('details', { open: true }, [h('summary', '行业专用指标自动验证'),
          h('p', model.value.industry.caveat),
          ...model.value.industry.checks.map(c => h('article', [h('strong', `${c.label} · ${c.rule} · ${c.state === 'pass' ? '通过' : c.state === 'fail' ? '未通过' : '缺证据'}`), h('p', c.reason)])),
          h('p', '下面录入的是人工核验后的指标；零不是缺失，缺少日期或来源不会通过。'),
          ...draft.value.industryFacts.map(f => { const label = model.value!.industry.checks.find(c => c.key === f.key)?.label ?? f.key; return h('fieldset', [h('legend', label), field(label + ' 数值（比例填小数）', f.value, v => f.value = Number(v), 'number'), field(label + ' 财报期间截至', f.period, v => f.period = v, 'date'), sources(label, f.source)]) }),
        ]),
        h('details', [h('summary', '价格隐含预期与三情景'),
          h('p', model.value.expectationResult.method),
          h('p', '达到要求回报率所需利润增长：' + pct(model.value.expectationResult.impliedGrowth)),
          ...model.value.expectationResult.reasons.map(t => h('p', t)),
          ...model.value.expectationResult.scenarios.map(s => h('p', `${scenarioNames[s.name as keyof typeof scenarioNames]}：权益现值 ${s.presentEquityValue.toFixed(0)} · 年化收益 ${pct(s.annualizedReturn)} · 现值折价 ${pct(s.margin)}`)),
          ...model.value.expectationResult.caveats.map(t => h('p', t)),
          draft.value.expectations ? renderExpectations(draft.value.expectations) : h('button', { type: 'button', disabled: busy.value, onClick: addExpectations }, '建立有来源的三情景'),
        ]),
        h('details', [h('summary', '编辑公司论点与验证节点'),
          h('label', ['论点状态', h('select', { 'aria-label': '论点状态', value: draft.value.thesis.status, disabled: busy.value, onChange: (e: Event) => { draft.value!.thesis.status = (e.target as HTMLSelectElement).value as ObservationResearchDraft['thesis']['status']; dirty.value = true } }, Object.entries(queueStatus).map(([v,label])=>h('option',{value:v},label)))]),
          ...([['business','业务与竞争优势'],['marketConcern','市场担忧'],['variantView','与市场不同的判断'],['counterEvidence','最强反证'],['invalidation','论点失效条件']] as const).map(([key,label])=>field(label,draft.value!.thesis[key],v=>draft.value!.thesis[key]=v,'textarea')),
          field('下次验证日期',draft.value.thesis.nextReview,v=>draft.value!.thesis.nextReview=v,'date'),
          ...draft.value.thesis.evidence.map((s,n)=>sources('论点证据'+(n+1),s)),
          h('button',{type:'button',disabled:busy.value||draft.value.thesis.evidence.length>=30,onClick:()=>{draft.value!.thesis.evidence.push(source());dirty.value=true}},'添加论点来源'),
          ...draft.value.thesis.indicators.map((i,n)=>h('fieldset',[h('legend','关键指标'+(n+1)),field('指标名称'+(n+1),i.name,v=>i.name=v),field('基准值及期间'+(n+1),i.baseline,v=>i.baseline=v),field('验证/失效条件'+(n+1),i.condition,v=>i.condition=v),sources('指标'+(n+1),i.source)])),
          h('button',{type:'button',disabled:busy.value||draft.value.thesis.indicators.length>=20,onClick:()=>{draft.value!.thesis.indicators.push({name:'',baseline:'',condition:'',source:source()});dirty.value=true}},'添加关键验证指标'),
        ]),
        h('label',['变更归因',h('select',{'aria-label':'变更归因',value:draft.value.thesis.changeType,disabled:busy.value,onChange:(e:Event)=>{draft.value!.thesis.changeType=(e.target as HTMLSelectElement).value as ObservationResearchDraft['thesis']['changeType'];dirty.value=true}},Object.entries({facts:'公司事实',price:'价格变化',model:'模型调整',data_repair:'数据修复'}).map(([value,label])=>h('option',{value},label)))]),
        field('本次变更原因（必填）',draft.value.thesis.changeReason,v=>draft.value!.thesis.changeReason=v,'textarea'),
        h('button',{type:'button',disabled:busy.value,onClick:save},'校验并保存新版本'),
        h('details',[h('summary','不可覆盖的论点版本记录'),h('p','最近100个版本可载入；更早版本仍保留在数据库，不自动删除。'),
          h('select',{'aria-label':'历史论点版本',value:historicalVersion.value,onChange:(e:Event)=>historicalVersion.value=(e.target as HTMLSelectElement).value},[h('option',{value:''},'选择历史版本'),...model.value.versions.map(v=>h('option',{value:String(v.version)},`v${v.version} · ${v.recordedAt} · ${v.changeType} · ${v.changeReason}`))]),h('button',{type:'button',disabled:busy.value||!historicalVersion.value,onClick:restore},'载入历史版本为草稿')]),
        h('details',[h('summary','前瞻历史效果 · 入选与排除同时留痕'),
          h('button',{type:'button',disabled:busy.value,onClick:evaluate},'使用雪球核验到期样本'),
          h('p',`已记录 ${history.value?.cohorts.length??0} 个真实观察日。新功能没有历史成绩；必须等待真实交易窗口成熟。`),
          ...(history.value?.limitations??[]).map(t=>h('p',t)),
          h('div',{class:'oru-scroll'},[h('table',[h('thead',[h('tr',['规则/依赖版本','分组','交易日','成熟/待到期/缺失','平均价格收益','平均超额收益'].map(t=>h('th',t)))]),h('tbody',(history.value?.summary??[]).map(s=>h('tr',[h('td',s.policyVersion + ' / ' + s.dependencyRevision.slice(0,8)),h('td',s.group==='candidate'?'入选':'排除/数据不足'),h('td',s.horizon),h('td',`${s.samples}/${s.pending}/${s.unavailable}`),h('td',pct(s.meanReturn)),h('td',pct(s.meanExcessReturn))])))])]),
          h('details',[h('summary','逐样本结果与缺口'),...(history.value?.outcomes??[]).slice(0,60).map(o=>h('p',`${o.id} · ${o.horizon}交易日 · ${o.state} · 收益 ${pct(o.return)} · 超额 ${pct(o.excessReturn)} · ${o.reason}${o.evidence ? ' · 起点 '+o.evidence.entryDate+' / '+o.evidence.entryClose+' → '+o.endDate+' / '+o.evidence.exitClose+' · 基准 '+(o.evidence.benchmarkCode??'未覆盖') : ''}`))]),
          ...(history.value?.cohorts??[]).slice(0,20).map(c=>h('p',`${c.recordedAt} · ${c.stage} · ${c.policyVersion} · 论点v${c.researchVersion??0} · 计算${c.computationId}`)),
        ]),
      ]),
    ])
  },
})
