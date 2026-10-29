// Run from the repository root with Node. Development-only differential fixture
// generator; all positions/accounts are synthetic, never read from a live DB.
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
const output=await build({entryPoints:['src/modules/research/domain/active-portfolio.ts'],bundle:true,write:false,format:'esm',platform:'node'});
const domain=await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].text).toString('base64'));
const now=Date.parse('2026-10-29T12:00:00Z'), asOf=new Date(now-1000).toISOString();
const dashboard={rows:[],pending:[],revision:'fixture',freshnessMs:600000};
const draft={...domain.portfolioTemplate(),asOf,source:'synthetic isolated fixture, not real holdings',positions:[{account:'test',code:'600036.SH',quantity:10,price:10,currency:'CNY',fxToBase:1}],cash:[{account:'test',amount:100,currency:'CNY',fxToBase:1}]};
const record={version:1,snapshotVersion:1,recordedAt:asOf,draft,decisions:[]};
const withDraft=patch=>({...record,draft:{...draft,...patch}});
const universe=JSON.parse(readFileSync('config/investment-universe.json','utf8'));
const company=universe.companies.find(c=>c.securities.some(s=>s.ticker==='600036.SH'));
const hk=company.securities.find(s=>s.market==='HK');
const row={code:'600036.SH',computation:{id:'one',revision:'fixture',computedAt:asOf},researchVersion:1,opportunity:{stage:'research_candidate',policyVersion:'test',gates:[{key:'business',state:'fail',reasons:['earnings deteriorated']}],workflow:{thesisStatus:'invalidated',queue:'review_risk',nextAction:'verify thesis'}}};
const live={...dashboard,rows:[row]};
const cases=[['empty',null,dashboard],['complete',record,dashboard],['price-missing',withDraft({positions:[{...draft.positions[0],price:null}]}),dashboard],['fx-missing',withDraft({cash:[{...draft.cash[0],currency:'USD',fxToBase:null}]}),dashboard],['cash-fx',withDraft({cash:[{...draft.cash[0],currency:'USD',fxToBase:7}]}),dashboard],['us-join',withDraft({positions:[{...draft.positions[0],code:'NVDA.US',currency:'USD',fxToBase:7}]}),dashboard],['company-merge',withDraft({positions:[...draft.positions,{...draft.positions[0],code:hk.ticker,currency:'HKD',fxToBase:.9},{...draft.positions[0],account:'other'}]}),dashboard],['forty',withDraft({positions:Array.from({length:40},(_,i)=>({...draft.positions[0],code:`TEST${i}.US`}))}),dashboard],['stale',withDraft({asOf:new Date(now-40*3600000).toISOString()}),dashboard],['risk-limits',withDraft({rules:{...draft.rules,maxCompanyWeight:.4,maxSectorWeight:.4}}),dashboard],['equal-limits',withDraft({rules:{...draft.rules,maxCompanyWeight:.5,maxSectorWeight:.5}}),dashboard],['invalidated',record,live],['recomputed',record,{...live,rows:[{...row,computation:{...row.computation,id:'two',computedAt:new Date(now).toISOString()}}]}],['evidence-change',record,{...live,rows:[{...row,researchVersion:2}]}],['pending',record,{...live,pending:[row.code]}],['revision',record,{...live,revision:'new'}],['future',record,{...live,rows:[{...row,computation:{...row.computation,computedAt:new Date(now+1000).toISOString()}}]}],['repair',record,{...live,rows:[{...row,opportunity:{...row.opportunity,workflow:{thesisStatus:'review_due',queue:'repair_data',nextAction:'repair'}}}]}],['unverified',record,{...live,rows:[{...row,opportunity:{...row.opportunity,workflow:{thesisStatus:'not_verified',queue:'review',nextAction:'verify'}}}]}],['candidate',record,{...live,rows:[{...row,code:'NVDA.US',opportunity:{...row.opportunity,gates:[{key:'business',state:'pass',reasons:[]}],workflow:{thesisStatus:'reviewed',queue:'review',nextAction:'research'}}}]}]];
const assessments=cases.map(([name,current,dashboard])=>({name,current,dashboard,now,expected:domain.assessPortfolio(current,dashboard,now)}));
const risk=domain.assessPortfolio(record,live,now).tasks.find(t=>t.subject===row.code);
const acknowledged={...record,decisions:[{taskId:risk.id,choice:'keep',reason:'synthetic no trade',until:null,recordedAt:asOf,task:Object.fromEntries(Object.entries(risk).filter(([k])=>k!=='decision'))}]};
assessments.push({name:'acknowledged',current:acknowledged,dashboard:live,now,expected:domain.assessPortfolio(acknowledged,live,now)});
const input={title:'reduce concentration fixture',rationale:'compare with unchanged holdings',estimatedCosts:0,externalCashFlow:0,target:{...draft,positions:[{...draft.positions[0],quantity:5}],cash:[{...draft.cash[0],amount:150}]}};
const comparisons=[input,{...input,estimatedCosts:null},{...input,estimatedCosts:10},{...input,estimatedCosts:10,externalCashFlow:10}].map(input=>({current:record,input,dashboard,now,expected:domain.comparePortfolioProposal(record,input,dashboard,now)}));
writeFileSync('backend/src/portfolio/fixtures.json',JSON.stringify({assessments,comparisons})+'\n');
console.log(JSON.stringify({assessments:assessments.length,comparisons:comparisons.length}));
