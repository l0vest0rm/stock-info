import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv } from '../../../types';
import { ok, fail, externalHttpOptions } from '../../../shared/http';
import { normalizeSecurityCode } from '../../../shared/codes';
import { screenTargets } from '../application/screen-valuation-pool';
import { companyValuationArchetype } from '../domain/valuation-coverage';
import { loadObservationVersions, readObservationResearch, saveObservationResearch, ObservationConflict, readObservationHistory, saveObservationOutcomes } from '../application/observation-research';
import { evaluateCohort } from '../domain/observation-research';
import { fetchXueqiuStockKline } from '../../../adapters/xueqiu';

export const observationResearchRoutes=new Hono<AppEnv>();
observationResearchRoutes.use('/research/observation/*',async(c,next)=>{
  c.header('Cache-Control','no-store');
  // Private local research only. Same-origin checks apply to reads too because
  // the parent API has permissive CORS. Host validation blocks DNS rebinding.
  const url=new URL(c.req.url),origin=c.req.header('Origin');
  if(c.env.APP_RUNTIME!=='node'||c.env.LLM_RUNTIME!=='local') return fail(c,404,'研究编辑和历史记录仅在本地Node工作区开放');
  if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||origin&&origin!==url.origin||c.req.header('Sec-Fetch-Site')==='cross-site') return fail(c,403,'仅允许本机同源研究访问');
  let code: string;
  try { code=normalizeSecurityCode(decodeURIComponent(url.pathname.split('/research/observation/')[1]?.split('/')[0]??'')); } catch { return fail(c,400,'证券编码无效'); }
  if(!screenTargets().some(t=>t.code===code)) return fail(c,400,'证券不在已核验观察池中');
  await next();
});
observationResearchRoutes.use('/research/observation/*',bodyLimit({maxSize:120_000,onError:c=>fail(c,413,'研究记录超过120KB')}));
observationResearchRoutes.get('/research/observation/:code',async c=>{
  const code=normalizeSecurityCode(c.req.param('code'));
  const version=c.req.query('version');
  if(version) { const record=(await loadObservationVersions(c.env.DB,code)).find(v=>v.version===Number(version)); return record?ok(c,record):fail(c,404,'版本不在可读取窗口'); }
  return ok(c,await readObservationResearch(c.env.DB,code,companyValuationArchetype(code)??'other',true));
});
observationResearchRoutes.post('/research/observation/:code',async c=>{
  if(!c.req.header('Content-Type')?.startsWith('application/json')) return fail(c,415,'仅接受application/json');
  const code=normalizeSecurityCode(c.req.param('code'));
  try {
    const body=await c.req.json();
    const record=await saveObservationResearch(c.env.DB,code,companyValuationArchetype(code)??'other',body.expectedVersion,body.draft);
    return ok(c,record);
  } catch(error) {return fail(c,error instanceof ObservationConflict?409:400,error instanceof Error?error.message:'研究保存失败');}
});
observationResearchRoutes.get('/research/observation/:code/history',async c=>ok(c,await readObservationHistory(c.env.DB,normalizeSecurityCode(c.req.param('code')))));
observationResearchRoutes.post('/research/observation/:code/evaluate',async c=>{
  const code=normalizeSecurityCode(c.req.param('code')),history=await readObservationHistory(c.env.DB,code);
  if(!history.cohorts.length) return ok(c,history);
  const target=screenTargets().find(t=>t.code===code)!;
  const benchmark=target.market==='CN'?'000300.SH':target.market==='HK'?'HSI.HK':target.market==='US'?'SPX.US':null;
  const today=new Date().toISOString().slice(0,10),options=externalHttpOptions(c.env);
  const load=async(symbol:string)=>{
    const result=await fetchXueqiuStockKline(c.env.DB,symbol,'day','qfq',today,options,c.env.XUEQIU_COOKIE);
    if(!result.rows.length||result.rows.some(r=>r.source!=='xueqiu'||!['qfq','before'].includes(r.fq)||typeof r.close!=='number')) throw new Error('雪球前复权序列缺失或口径不符');
    return result.rows.map(r=>({date:r.date,close:r.close!}));
  };
  try {
    const bars=await load(code);
    let benchmarkBars:Awaited<ReturnType<typeof load>>=[];
    if(benchmark) { try {benchmarkBars=await load(benchmark);}catch{/* Absolute returns remain valid; never switch providers. */} }
    await saveObservationOutcomes(c.env.DB,code,history.cohorts.flatMap(cohort=>evaluateCohort(cohort,bars,benchmarkBars,Date.now(),benchmark)));
    return ok(c,await readObservationHistory(c.env.DB,code));
  } catch(error) {return fail(c,502,'雪球效果核验失败；保留原记录、不切源：'+(error instanceof Error?error.message:'请求失败'));}
});
