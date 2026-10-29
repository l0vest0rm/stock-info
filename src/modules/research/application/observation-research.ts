import type { Database } from '../../../platform/contracts';
import type { ObservationResearchDraft, ObservationResearchRead, ObservationResearchVersion, ObservationCohort, ObservationOutcome, ObservationHistoryRead } from '../../../../shared/observation-research';
import { expectations, researchTemplate, validateDraft, verifyIndustry, summarizeHistory } from '../domain/observation-research';

const prefix = (code: string) => `observation-research:v1:${code}:`;
export async function loadObservationVersions(db:Database,code:string,limit=100):Promise<ObservationResearchVersion[]> {
  const rows=await db.prepare(`select value_json from kv_cache where namespace = 'observation-ledger-v1' and key >= ? and key < ? order by key desc limit ?`).bind(prefix(code),prefix(code)+'~',Math.max(1,Math.min(100,limit))).all<{value_json:string}>();
  return rows.results.map(r=>JSON.parse(r.value_json));
}
export async function readObservationResearch(db:Database,code:string,archetype:string,canWrite:boolean):Promise<ObservationResearchRead> {
  const versions=await loadObservationVersions(db,code),current=versions[0]??null;
  return {canWrite,code,archetype,current,versions:versions.map(v=>({version:v.version,recordedAt:v.recordedAt,status:v.thesis.status,changeType:v.thesis.changeType,changeReason:v.thesis.changeReason})),industry:verifyIndustry(archetype,current?.industryFacts??[]),expectationResult:expectations(current?.expectations??null),template:researchTemplate(archetype)};
}
export class ObservationConflict extends Error {}
export async function saveObservationResearch(db:Database,code:string,archetype:string,expectedVersion:number,draft:unknown):Promise<ObservationResearchVersion> {
  if(!Number.isInteger(expectedVersion)||expectedVersion<0) throw new Error('expectedVersion无效');
  validateDraft(draft);
  // Copy only the public research contract; reject accidental account/position fields.
  const allowed=['thesis','industryFacts','expectations'];
  if(Object.keys(draft).some(k=>!allowed.includes(k))) throw new Error('不允许额外字段；账户、仓位和交易信息不得写入研究记录');
  const current=(await loadObservationVersions(db,code,1))[0];
  if((current?.version??0)!==expectedVersion) throw new ObservationConflict('记录已被其他编辑更新，请重新读取后合并；未覆盖原记录');
  const industry=verifyIndustry(archetype,draft.industryFacts),expectationResult=expectations(draft.expectations);
  if(draft.thesis.status==='reviewed' && (industry.state!=='pass'||expectationResult.status!=='available')) throw new Error('已复核论点还需行业专用质量通过和完整可计算情景；缺口不能自动通过');
  const record:ObservationResearchVersion={...draft,code,version:expectedVersion+1,recordedAt:new Date().toISOString(),industry,expectationResult};
  try {
    await db.prepare(`insert into kv_cache(namespace,key,value_json,expires_at,updated_at) values('observation-ledger-v1',?,?,null,?)`).bind(prefix(code)+String(record.version).padStart(10,'0'),JSON.stringify(record),Date.now()).run();
  } catch(error) {
    if(/unique|constraint/i.test(String(error))) throw new ObservationConflict('并发编辑冲突；原记录已保留，请重新读取');
    throw error;
  }
  return record;
}
const cohortPrefix=(code:string)=>`observation-cohort:v1:${code}:`;
const outcomePrefix=(code:string)=>`observation-outcome:v1:${code}:`;
/** Called exclusively by the dashboard writer after successful fenced cache write.
 * First computed observation per UTC day is immutable, including exclusions. */
export async function appendObservationCohort(db:Database,row:import('../../../../shared/valuation-dashboard').DashboardRow):Promise<void> {
  const recordedAt=new Date().toISOString(),day=recordedAt.slice(0,10);
  const record:ObservationCohort={id:`${row.code}:${day}`,code:row.code,recordedAt,quoteDate:row.opportunity?.price?.asOf??null,stage:row.opportunity?.stage??'insufficient_data',policyVersion:row.opportunity?.policyVersion??'missing',dependencyRevision:row.computation.revision,computationId:row.computation.id,gates:row.opportunity?.gates??[],signals:row.opportunity?.signals??[],researchVersion:row.researchVersion??null};
  await db.prepare(`insert into kv_cache(namespace,key,value_json,expires_at,updated_at) values('observation-ledger-v1',?,?,null,?) on conflict(namespace,key) do nothing`).bind(cohortPrefix(row.code)+day,JSON.stringify(record),Date.now()).run();
}
export async function readObservationHistory(db:Database,code:string):Promise<ObservationHistoryRead> {
  const [cohortRows,outcomeRows]=await Promise.all([
    db.prepare(`select value_json from kv_cache where namespace = 'observation-ledger-v1' and key >= ? and key < ? order by key desc limit 180`).bind(cohortPrefix(code),cohortPrefix(code)+'~').all<{value_json:string}>(),
    db.prepare(`select value_json from kv_cache where namespace = 'observation-ledger-v1' and key >= ? and key < ? order by key desc limit 540`).bind(outcomePrefix(code),outcomePrefix(code)+'~').all<{value_json:string}>(),
  ]);
  const cohorts:ObservationCohort[]=cohortRows.results.map(r=>JSON.parse(r.value_json)),outcomes:ObservationOutcome[]=outcomeRows.results.map(r=>JSON.parse(r.value_json));
  for(const c of cohorts) for(const horizon of [20,60,120]) if(!outcomes.some(o=>o.id===c.id&&o.horizon===horizon)) outcomes.push({id:c.id,horizon,state:'pending',return:null,benchmarkReturn:null,excessReturn:null,endDate:null,reason:'尚未执行前瞻效果核验。',evaluatedAt:''});
  return {cohorts,outcomes,summary:summarizeHistory(cohorts,outcomes),limitations:['只展示最近180个真实记录日；首次每天计算同时记录入选和排除结果，历史不可补造。','以记录UTC日期之后的首个证券交易日收盘作为观察起点，不是实际成交或组合收益。','20/60/120证券交易日价格收益，使用同次雪球前复权序列；不是严格总回报，数据源重述仍是限制。','同一公司相邻样本重叠且相关，均值不代表独立样本统计显著性；保留政策版本，不能混当策略胜率。','缺少行情/基准、停牌或未到期都单列；不以零填缺口，不自动交易。']};
}
export async function saveObservationOutcomes(db:Database,code:string,outcomes:ObservationOutcome[]):Promise<void> {
  // Matured results are frozen; later evaluations may fill pending/unavailable only.
  for(let offset=0;offset<outcomes.length;offset+=40) await db.batch(outcomes.slice(offset,offset+40).map(o=>db.prepare(`insert into kv_cache(namespace,key,value_json,expires_at,updated_at) values('observation-ledger-v1',?,?,null,?)
    on conflict(namespace,key) do update set value_json=excluded.value_json,updated_at=excluded.updated_at
    where json_extract(kv_cache.value_json,'$.state') <> 'matured'`).bind(outcomePrefix(code)+o.id+':'+o.horizon,JSON.stringify(o),Date.now())));
}
