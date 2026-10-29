import type { ExpectationsInput, ExpectationsResult, IndustryFact, IndustryVerification, ObservationResearchDraft, ObservationCohort, ObservationOutcome, ObservationHistoryRead, ResearchSource } from '../../../../shared/observation-research';

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const dayMs = 86400000;
export function validDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function validSource(source: ResearchSource, now = Date.now()): boolean {
  if (!source || !validDate(source.publishedAt) || !validDate(source.checkedAt)) return false;
  try { if (new URL(source.url).protocol !== 'https:') return false; } catch { return false; }
  return Date.parse(source.publishedAt) <= Date.parse(source.checkedAt) && Date.parse(source.checkedAt) <= now && typeof source.note === 'string' && source.note.trim().length > 0;
}
type Rule = { key: string; label: string; rule: string; test: (v: number) => boolean; valid: (v: number) => boolean };
const ratio = (v: number) => v >= 0 && v <= 1;
const signed = (_: number) => true;
const positive = (v: number) => v > 0;
const rule = (key: string, label: string, text: string, test: Rule['test'], valid: Rule['valid'] = signed): Rule => ({ key, label, rule: text, test, valid });
/** Research thresholds, NOT regulatory requirements or calibrated return probabilities. */
export function industryRules(archetype: string): Rule[] {
  switch (archetype) {
    case 'bank': return [rule('npl_ratio', '不良贷款率', '≤3%', v => v <= .03, ratio), rule('cet1_buffer', '核心一级资本高于适用要求的缓冲', '>0（适用要求须在来源中说明）', v => v > 0), rule('provision_coverage', '拨备覆盖率', '≥150%', v => v >= 1.5, positive)];
    case 'insurer': return [rule('solvency_buffer', '偿付能力高于适用要求的缓冲', '>0（适用要求须在来源中说明）', v => v > 0), rule('nbv_growth', '可比新业务价值同比', '≥0', v => v >= 0), rule('investment_stress_buffer', '压力情景后偿付能力缓冲', '>0', v => v > 0)];
    case 'cyclical_commodity': return [rule('normalized_profit', '当前业务规模的中周期利润', '>0（本币元）', positive), rule('net_debt_normalized_ebitda', '净债务/中周期EBITDA', '≤3倍', v => v <= 3), rule('inventory_days_change', '可比存货周转天数同比变化', '≤0天', v => v <= 0)];
    case 'property_operator': return [rule('ffo_payout', '分红/可持续FFO', '≤100%', v => v <= 1, v => v >= 0), rule('ltv', '债务/可比资产价值', '≤60%', v => v <= .6, ratio), rule('interest_coverage', '经营收益/利息', '≥2倍', v => v >= 2)];
    case 'broker': return [rule('net_capital_buffer', '净资本高于适用要求的缓冲', '>0', v => v > 0), rule('liquidity_buffer', '流动性高于适用要求的缓冲', '>0', v => v > 0)];
    case 'pre_profit_milestone': return [rule('cash_runway_months', '压力情景现金生存期', '≥18个月', v => v >= 18, v => v >= 0), rule('milestone_on_track', '关键节点按期且已核验', '=1；延期/失败=0', v => v === 1, v => v === 0 || v === 1), rule('funding_gap', '下一关键节点前融资缺口', '≤0（本币元）', v => v <= 0)];
    case 'stable_cash_dividend': case 'exchange': return [rule('fcf_dividend_coverage', '维护资本开支后现金流/分红', '≥1倍', v => v >= 1), rule('net_debt_ebitda', '净债务/EBITDA', '≤3倍', v => v <= 3), rule('interest_coverage', '经营收益/利息', '≥2倍', v => v >= 2)];
    default: return [rule('roic_spread', '增量ROIC减资本成本', '>0', v => v > 0), rule('diluted_eps_growth', '可比扣非摊薄EPS同比', '≥0', v => v >= 0), rule('cash_conversion', '同期间经营现金/利润', '≥80%', v => v >= .8)];
  }
}
export function verifyIndustry(archetype: string, facts: IndustryFact[], now = Date.now()): IndustryVerification {
  const checks = industryRules(archetype).map(r => {
    const matches = facts.filter(f => f.key === r.key), f = matches[0];
    const valid = matches.length === 1 && finite(f.value) && r.valid(f.value) && validDate(f.period) && validSource(f.source, now) && Date.parse(f.period) <= Date.parse(f.source.publishedAt) && now - Date.parse(f.period) <= 240 * dayMs;
    return { key: r.key, label: r.label, rule: r.rule, value: valid ? f.value : null, state: !valid ? 'unknown' as const : r.test(f.value) ? 'pass' as const : 'fail' as const, reason: !valid ? '缺少唯一、有效、240天内、有日期及人工核验来源的可比指标。' : '按已提供证据计算；来源真实性、适用要求和会计口径仍由研究复核人负责。' };
  });
  return { version: 'industry-quality-v1', archetype, state: checks.some(c => c.state === 'fail') ? 'fail' : checks.every(c => c.state === 'pass') ? 'pass' : 'unknown', checks, caveat: '研究政策阈值，不是法定监管标准或收益预测；缺失不通过，人工证据不冒充自动抓取。' };
}
export function expectations(input: ExpectationsInput | null, now = Date.now()): ExpectationsResult {
  const result: ExpectationsResult = { status: 'unavailable', reasons: [], impliedGrowth: null, scenarios: [], method: '每股权益收益情景：逐年分红＋期末盈利倍数；反解达到要求回报率所需的盈利增长', caveats: ['不是DCF或一致预期，不自动替代行业主估值。', '分红与终值均考虑假设稀释；增长、分红和再投资的可行性须人工验证。', '不支持跨币种混算或亏损基数；不计算没有依据的概率加权目标价。'] };
  if (!input) { result.reasons.push('尚未录入有来源的盈利、市值与情景假设。'); return result; }
  const i = input;
  if (![i.marketCap, i.normalizedProfit, i.years, i.requiredReturn, i.annualDilution].every(finite) || i.marketCap <= 0 || i.normalizedProfit <= 0 || !Number.isInteger(i.years) || i.years < 1 || i.years > 10 || i.requiredReturn <= 0 || i.requiredReturn > .5 || i.annualDilution < 0 || i.annualDilution > .5 || !/^[A-Z]{3}$/.test(i.currency) || i.amountScale !== 'base_units') result.reasons.push('数值、币种或金额单位无效；使用同币种本币元、1–10年、正利润。');
  if (!validDate(i.priceDate) || !validDate(i.profitPeriod) || Date.parse(i.priceDate) > now || now - Date.parse(i.priceDate) > 7 * dayMs || Date.parse(i.profitPeriod) > now || now - Date.parse(i.profitPeriod) > 240 * dayMs) result.reasons.push('行情/盈利期间缺失、未来或过期。');
  if (!i.sources || !['marketCap', 'profit', 'assumptions'].every(k => validSource(i.sources[k as keyof typeof i.sources], now))) result.reasons.push('市值、盈利及假设都需HTTPS来源、发布日期、核验日期和口径说明。');
  if (!Array.isArray(i.scenarios) || i.scenarios.length !== 3 || i.scenarios.some(s => !s || typeof s !== 'object') || new Set(i.scenarios.map(s => s.name)).size !== 3 || !i.scenarios.every(s => ['bear','base','bull'].includes(s.name) && [s.growth,s.terminalMultiple,s.payoutRatio].every(finite) && s.growth > -.95 && s.growth <= 2 && s.terminalMultiple > 0 && s.terminalMultiple <= 100 && s.payoutRatio >= 0 && s.payoutRatio <= 1 && typeof s.rationale === 'string' && s.rationale.trim())) result.reasons.push('必须填写悲观/基准/乐观三个有效情景及理由。');
  if (i.sources?.profit && validDate(i.profitPeriod) && validDate(i.sources.profit.publishedAt) && Date.parse(i.profitPeriod) > Date.parse(i.sources.profit.publishedAt)) result.reasons.push('盈利来源发布日期早于盈利期间截至日。');
  if (result.reasons.length) return result;
  const pv = (growth: number, multiple: number, payout: number, rate: number) => {
    let total = 0;
    for (let y = 1; y <= i.years; y++) total += i.normalizedProfit * ((1 + growth) / (1 + i.annualDilution)) ** y * payout / (1 + rate) ** y;
    return total + i.normalizedProfit * ((1 + growth) / (1 + i.annualDilution)) ** i.years * multiple / (1 + rate) ** i.years;
  };
  // Bounded monotone bisection; non-solutions remain unavailable, never clamped.
  const solve = (f: (x: number) => number, low: number, high: number, increasing: boolean): number | null => {
    if (increasing ? f(low) > i.marketCap || f(high) < i.marketCap : f(low) < i.marketCap || f(high) > i.marketCap) return null;
    for (let n=0;n<100;n++) { const mid=(low+high)/2; if ((f(mid)<i.marketCap)===increasing) low=mid; else high=mid; }
    return (low+high)/2;
  };
  const base = i.scenarios.find(s => s.name === 'base')!;
  result.impliedGrowth = solve(g => pv(g,base.terminalMultiple,base.payoutRatio,i.requiredReturn),-.95,2,true);
  for (const s of i.scenarios) {
    const value=pv(s.growth,s.terminalMultiple,s.payoutRatio,i.requiredReturn);
    const irr=solve(r=>pv(s.growth,s.terminalMultiple,s.payoutRatio,r),-.95,10,false);
    if (!finite(value) || irr === null) { result.reasons.push('情景收益率超出可求解范围。'); continue; }
    result.scenarios.push({ name:s.name,presentEquityValue:value,annualizedReturn:irr,margin:1-i.marketCap/value });
  }
  const ordered=['bear','base','bull'].map(n=>result.scenarios.find(s=>s.name===n)?.presentEquityValue);
  if (ordered.every(finite) && !(ordered[0]! <= ordered[1]! && ordered[1]! <= ordered[2]!)) result.reasons.push('悲观/基准/乐观估值次序不一致，请复核假设。');
  if(result.impliedGrowth===null) result.reasons.push('隐含增长超出[-95%,200%]可求解区间。');
  result.status=result.reasons.length?'unavailable':'available'; return result;
}
export function researchTemplate(archetype: string): ObservationResearchDraft {
  const source = (): ResearchSource => ({url:'',publishedAt:'',checkedAt:'',note:''});
  return { thesis: {status:'draft',business:'',marketConcern:'',variantView:'',counterEvidence:'',nextReview:'',invalidation:'',changeReason:'',changeType:'facts',evidence:[],indicators:[]}, industryFacts: industryRules(archetype).map(r=>({key:r.key,value:0,period:'',source:source()})), expectations:null };
}
export function validateDraft(value: unknown, now=Date.now()): asserts value is ObservationResearchDraft {
  if (!value || typeof value!=='object') throw new Error('研究记录必须是对象');
  const d=value as ObservationResearchDraft,t=d.thesis;
  if (!t || !['draft','reviewed','invalidated'].includes(t.status) || !['facts','price','model','data_repair'].includes(t.changeType)) throw new Error('论点状态/变更类型无效');
  for(const k of ['business','marketConcern','variantView','counterEvidence','nextReview','invalidation','changeReason'] as const) if(typeof t[k]!=='string'||t[k].length>10000) throw new Error('论点字段无效或过长');
  if(!t.changeReason.trim()) throw new Error('保存必须说明变更原因');
  if(t.nextReview && !validDate(t.nextReview)) throw new Error('验证日期无效');
  if(!Array.isArray(t.evidence)||t.evidence.length>30||!t.evidence.every(s=>s && ['url','publishedAt','checkedAt','note'].every(k=>typeof s[k as keyof ResearchSource]==='string') && (t.status!=='reviewed'||validSource(s,now)))) throw new Error('论点证据来源无效');
  if(!Array.isArray(t.indicators)||t.indicators.length>20||!t.indicators.every(i=>i&&['name','baseline','condition'].every(k=>typeof i[k as keyof typeof i]==='string')&&i.source && ['url','publishedAt','checkedAt','note'].every(k=>typeof i.source[k as keyof ResearchSource]==='string') && (t.status!=='reviewed'||validSource(i.source,now)))) throw new Error('验证指标无效');
  if(t.status==='reviewed' && (!t.evidence.length||t.indicators.length<3||!t.business.trim()||!t.variantView.trim()||!t.marketConcern.trim()||!t.counterEvidence.trim()||!t.invalidation.trim()||!validDate(t.nextReview)||Date.parse(t.nextReview)<Date.parse(new Date(now).toISOString().slice(0,10))||t.indicators.some(i=>!i.name.trim()||!i.baseline.trim()||!i.condition.trim()))) throw new Error('已复核论点需完整论据、反证、至少三个验证指标、未来验证日期和失效条件');
  if(t.status==='invalidated' && !t.invalidation.trim()) throw new Error('失效记录必须说明失效条件/事实');
  if(!Array.isArray(d.industryFacts)||d.industryFacts.length>30||d.industryFacts.some(f=>!f||typeof f.key!=='string'||!finite(f.value)||typeof f.period!=='string'||!f.source)) throw new Error('行业指标格式无效');
  if(d.expectations!==null && (!d.expectations||typeof d.expectations!=='object')) throw new Error('情景必须为对象或null');
}
export type PricePoint={date:string;close:number};
export function evaluateCohort(cohort:ObservationCohort,bars:PricePoint[],benchmark:PricePoint[],now=Date.now(),benchmarkCode:string|null=null):ObservationOutcome[] {
  const valid=(rows:PricePoint[])=>rows.length>0&&rows.every(r=>validDate(r.date)&&finite(r.close)&&r.close>0&&Date.parse(r.date)<=now)&&new Set(rows.map(r=>r.date)).size===rows.length;
  const rows=[...bars].sort((a,b)=>a.date.localeCompare(b.date));
  const start=rows.findIndex(r=>r.date>cohort.recordedAt.slice(0,10));
  return [20,60,120].map(horizon=>{
    const base={id:cohort.id,horizon,return:null,benchmarkReturn:null,excessReturn:null,endDate:null,evaluatedAt:new Date(now).toISOString()};
    if(!valid(rows)) return {...base,state:'unavailable' as const,reason:'雪球前复权序列无效。'};
    if(start<0) return {...base,state:'pending' as const,reason:'尚无记录日期之后的交易日，等待真实前瞻样本。'};
    if(rows[0].date>cohort.recordedAt.slice(0,10)) return {...base,state:'unavailable' as const,reason:'行情窗口未覆盖记录日，无法确认首个后续交易日。'};
    const end=rows[start+horizon];
    if(!end) return {...base,state:'pending' as const,reason:'尚未达到所需证券交易日数；不填零收益。'};
    if(Date.parse(end.date)-Date.parse(rows[start].date)>horizon*2.2*dayMs) return {...base,state:'unavailable' as const,reason:'停牌/缺失跨度异常，不能作为普通交易窗口。'};
    const ret=end.close/rows[start].close-1;
    const b0=benchmark.find(r=>r.date===rows[start].date),b1=benchmark.find(r=>r.date===end.date);
    const br=valid(benchmark)&&b0&&b1?b1.close/b0.close-1:null;
    return {...base,evidence:{source:'xueqiu_qfq' as const,entryDate:rows[start].date,entryClose:rows[start].close,exitClose:end.close,benchmarkCode,benchmarkEntryClose:br===null?null:b0!.close,benchmarkExitClose:br===null?null:b1!.close},state:'matured' as const,return:ret,benchmarkReturn:br,excessReturn:br===null?null:ret-br,endDate:end.date,reason:br===null?'同市场基准未覆盖，绝对收益有效、超额收益留空。':'同日期基准比较；不是组合收益或严格总回报。'};
  });
}
export function summarizeHistory(cohorts:ObservationCohort[],outcomes:ObservationOutcome[]):ObservationHistoryRead['summary'] {
  const policies = [...new Map(cohorts.map(c => [c.policyVersion + ':' + c.dependencyRevision, { policyVersion: c.policyVersion, dependencyRevision: c.dependencyRevision }])).values()];
  return policies.flatMap(policy => (['candidate','excluded'] as const).flatMap(group=>[20,60,120].map(horizon=>{
    const ids=new Set(cohorts.filter(c=>c.policyVersion === policy.policyVersion && c.dependencyRevision === policy.dependencyRevision && (c.stage==='research_candidate')===(group==='candidate')).map(c=>c.id));
    const rows=outcomes.filter(o=>ids.has(o.id)&&o.horizon===horizon),values=rows.filter(o=>o.state==='matured'&&finite(o.return)),excess=values.filter(o=>finite(o.excessReturn));
    return {...policy,group,horizon,samples:values.length,pending:rows.filter(o=>o.state==='pending').length,unavailable:rows.filter(o=>o.state==='unavailable').length,meanReturn:values.length?values.reduce((s,o)=>s+o.return!,0)/values.length:null,meanExcessReturn:excess.length?excess.reduce((s,o)=>s+o.excessReturn!,0)/excess.length:null};
  })));
}
