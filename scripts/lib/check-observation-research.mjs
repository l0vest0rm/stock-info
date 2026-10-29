import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { verifyIndustry, industryRules, expectations, researchTemplate, validateDraft, evaluateCohort, summarizeHistory } from '../../src/modules/research/domain/observation-research.ts';

export async function checkObservationResearch() {
  const now=Date.parse('2026-10-29T12:00:00Z');
  const source={url:'https://example.com/filing',publishedAt:'2026-10-28',checkedAt:'2026-10-29',note:'fixture, comparable basis'};
  const bank=[['npl_ratio',.01],['cet1_buffer',.02],['provision_coverage',2]].map(([key,value])=>({key,value,period:'2026-09-30',source}));
  assert.equal(verifyIndustry('bank',bank,now).state,'pass');
  assert.equal(verifyIndustry('bank',[...bank,bank[0]],now).state,'unknown');
  assert.equal(verifyIndustry('bank',bank.map(f=>({...f,period:'2020-01-01'})),now).state,'unknown');
  assert.equal(verifyIndustry('bank',bank.map(f=>f.key==='npl_ratio'?{...f,value:.04}:f),now).state,'fail');
  assert.equal(verifyIndustry('bank',bank.map(f=>({...f,source:{...source,url:'javascript:alert(1)'}})),now).state,'unknown');
  for(const type of ['bank','insurer','cyclical_commodity','property_operator','broker','pre_profit_milestone','stable_cash_dividend','growth_manufacturing']) {
    assert(industryRules(type).length>=2); assert.equal(verifyIndustry(type,[],now).state,'unknown');
  }
  const input={marketCap:100,normalizedProfit:10,currency:'CNY',amountScale:'base_units',priceDate:'2026-10-28',profitPeriod:'2026-09-30',years:3,requiredReturn:.1,annualDilution:0,sources:{marketCap:source,profit:source,assumptions:source},scenarios:[{name:'bear',growth:0,terminalMultiple:8,payoutRatio:0,rationale:'bear'},{name:'base',growth:.1,terminalMultiple:10,payoutRatio:0,rationale:'base'},{name:'bull',growth:.2,terminalMultiple:12,payoutRatio:0,rationale:'bull'}]};
  const e=expectations(input,now);assert.equal(e.status,'available');assert(Math.abs(e.impliedGrowth-.1)<1e-10);assert(Math.abs(e.scenarios[1].annualizedReturn-.1)<1e-10);
  assert(expectations({...input,annualDilution:.1},now).impliedGrowth>e.impliedGrowth);
  for(const patch of [{marketCap:0},{normalizedProfit:-1},{currency:''},{priceDate:'2027-01-01'},{priceDate:'2025-01-01'},{years:1.5},{scenarios:[]},{sources:{}}]) assert.equal(expectations({...input,...patch},now).status,'unavailable');
  const d=researchTemplate('bank');d.thesis.changeReason='fixture';validateDraft(d,now);
  assert.throws(()=>validateDraft({...d,thesis:{...d.thesis,status:'reviewed'}},now),/已复核/);
  const bars=Array.from({length:150},(_,i)=>({date:new Date(Date.parse('2026-01-01')+i*86400000).toISOString().slice(0,10),close:100+i}));
  const cohort={id:'TEST:2026-01-01',code:'TEST',recordedAt:'2026-01-01T18:00:00Z',quoteDate:'2026-01-01',stage:'research_candidate',policyVersion:'fixture',dependencyRevision:'fixture',computationId:'fixture',gates:[],signals:[],researchVersion:0};
  const outcomes=evaluateCohort(cohort,bars,bars,now);
  assert(outcomes.every(o=>o.state==='matured'));
  assert(Math.abs(outcomes[0].return-(121/101-1))<1e-10,'entry must be AFTER capture, not backfilled at the earlier close');
  assert(outcomes.every(o=>o.excessReturn===0));
  assert(evaluateCohort(cohort,bars.slice(0,10),[],now).every(o=>o.state==='pending'));
  assert(evaluateCohort(cohort,bars.slice(10),[],now).every(o=>o.state==='unavailable'));
  assert(evaluateCohort(cohort,[...bars,bars[0]],[],now).every(o=>o.state==='unavailable'));
  assert(evaluateCohort(cohort,bars,[],now).every(o=>o.benchmarkReturn===null));
  assert.equal(summarizeHistory([cohort],outcomes)[0].samples,1);
  assert.equal(summarizeHistory([cohort],outcomes)[3].meanReturn,null);

  const bundled=await build({entryPoints:['src/modules/research/application/observation-research.ts'],bundle:true,write:false,format:'esm',platform:'node'});
  const service=await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'));
  const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(new URL('../../migrations/0117_create_kv_cache.sql',import.meta.url),'utf8'));
  const DB={prepare(sql){let values=[];const statement=sqlite.prepare(sql);const api={bind(...args){values=args;return api},async first(){return statement.get(...values)??null},async all(){return {results:statement.all(...values)}},async run(){return statement.run(...values)}};return api},async batch(statements){sqlite.exec('begin');try{const results=[];for(const s of statements)results.push(await s.run());sqlite.exec('commit');return results}catch(e){sqlite.exec('rollback');throw e}}};
  try {
    const saved=await service.saveObservationResearch(DB,'TEST','bank',0,d);assert.equal(saved.version,1);
    await assert.rejects(service.saveObservationResearch(DB,'TEST','bank',0,d),/其他编辑/);
    const concurrent=await Promise.allSettled([service.saveObservationResearch(DB,'TEST','bank',1,d),service.saveObservationResearch(DB,'TEST','bank',1,d)]);
    assert.equal(concurrent.filter(r=>r.status==='fulfilled').length,1);
    const read=await service.readObservationResearch(DB,'TEST','bank',true);assert.equal(read.versions.length,2);assert.equal(read.current.version,2);
    const row={code:'TEST',computation:{id:'one',revision:'fixture',computedAt:new Date().toISOString()},opportunity:{stage:'clue',policyVersion:'fixture',price:{asOf:'2026-01-01'},gates:[],signals:[]}};
    await service.appendObservationCohort(DB,row);await service.appendObservationCohort(DB,{...row,opportunity:{...row.opportunity,stage:'research_candidate'}});
    const hist=await service.readObservationHistory(DB,'TEST');assert.equal(hist.cohorts.length,1);assert.equal(hist.cohorts[0].stage,'clue');
    assert.equal(sqlite.prepare('select count(*) n from kv_cache where expires_at is not null').get().n,0,'research and cohort history must not expire like cache');
    await service.saveObservationOutcomes(DB,'TEST',outcomes);
    await service.saveObservationOutcomes(DB,'TEST',outcomes.map(o=>({...o,return:999})));
    assert.notEqual((await service.readObservationHistory(DB,'TEST')).outcomes.find(o=>o.id===cohort.id)?.return,999,'matured outcomes must remain immutable');
    const routeBundle=await build({entryPoints:['src/modules/research/api/observation-research.routes.ts'],bundle:true,write:false,format:'esm',platform:'node',plugins:[{name:'boundary-fixtures',setup(b){
      b.onLoad({filter:/screen-valuation-pool\.ts$/},()=>({loader:'js',contents:`export const screenTargets=()=>[{code:'600036.SH',market:'CN'}];`}));
      b.onLoad({filter:/shared\/http\.ts$/},()=>({loader:'js',contents:`export const ok=(c,data)=>c.json({code:200,data});export const fail=(c,status,msg)=>c.json({code:status,msg},status);export const externalHttpOptions=()=>({});`}));
      b.onLoad({filter:/adapters\/xueqiu(?:\/index)?\.ts$/},()=>({loader:'js',contents:`export const fetchXueqiuStockKline=async()=>{throw new Error('fixture no provider')};`}));
    }}]});
    const {observationResearchRoutes:router}=await import('data:text/javascript;base64,'+Buffer.from(routeBundle.outputFiles[0].text).toString('base64'));
    const env={DB,APP_RUNTIME:'node',LLM_RUNTIME:'local'};
    const url='http://127.0.0.1/research/observation/600036.SH';
    assert.equal((await router.request(url,{},env)).status,200,'local route must resolve code through middleware');
    assert.equal((await router.request(url,{headers:{Origin:'https://evil.example'}},env)).status,403);
    assert.equal((await router.request(url,{}, {...env,APP_RUNTIME:'cloudflare',LLM_RUNTIME:'production'})).status,404);
    assert.equal((await router.request(url.replace('127.0.0.1','evil.example'),{},env)).status,403);
    assert.equal((await router.request(url.replace('600036.SH','INVALID'),{},env)).status,400);
    assert.equal((await router.request(url,{method:'POST',headers:{'Content-Type':'text/plain'},body:'{}'},env)).status,415);
    const save=await router.request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedVersion:0,draft:d})},env);
    assert.equal(save.status,200,await save.text());
    assert.equal((await router.request(url+'?version=1',{},env)).status,200);
    assert.equal((await router.request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedVersion:0,draft:d})},env)).status,409);
  } finally {sqlite.close()}
  return {observationResearch:'passed',checks:['industry-paths','missing/stale/source/duplicate','scenario-arithmetic','dilution','invalid-inputs','review-gates','prospective-entry','maturity','benchmark-missing','CAS-concurrency','immutable-history','non-expiring-storage','frozen-outcomes','local-only','same-origin','content-type','version-api']};
}
