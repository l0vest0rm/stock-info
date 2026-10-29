import {analyzeBuyPoint} from '../../../../web/src/modules/company/domain/trade-analysis.ts';
import {readFileSync,writeFileSync} from 'node:fs';
const config=JSON.parse(readFileSync(new URL('../../../../web/src/config/buy-point-analysis.json',import.meta.url),'utf8'));
const original=readFileSync(new URL('../../../../scripts/analyze-buy-point.mjs',import.meta.url),'utf8');
const renderer=original.slice(original.indexOf('function renderText('),original.indexOf('function parseArgs('));
const helpers=original.slice(original.indexOf('function price('),original.indexOf('function printUsage('));
const renderText=new Function(`${renderer}\n${helpers}\nreturn renderText`)();
const cases=[];
for(let scenario=0;scenario<42;scenario++){
 const rows=[];let close=100;
 for(let i=0;i<100;i++){
  const previous=close;
  const delta=scenario%7===0?-0.7:scenario%7===1?0.8:scenario%7===2?Math.sin(i/4)*1.5:scenario%7===3?(i>90?2.1:-0.45):scenario%7===4?(i>90?-2.1:0.45):scenario%7===5?0:Math.sin(i*scenario)*1.3;
  close=Math.max(1,close+delta);
  let row={date:new Date(Date.UTC(2026,0,1+i)).toISOString().slice(0,10),close,open:previous+0.1,high:Math.max(close,previous)+0.4,low:Math.min(close,previous)-0.4,volume:10000+(i%5)*1000,amount:scenario<7?100000000:scenario<14?10000000:scenario<21?null:i%5===0?null:70000000,turnover:scenario<28?0.7:0.1};
  if(scenario>=35){row.volume=i%4===0?null:i%3===0?-1:0;row.amount=null;row.turnover=null;}
  rows.push(row);
 }
 if(scenario%3===0){rows.push({...rows.at(-1)});rows.unshift({date:'x',close:-1,open:1,high:1,low:1});}
 if(scenario%4===0)rows.reverse();
 const expected=analyzeBuyPoint(rows,config);cases.push({name:`scenario-${scenario}`,rows,expected,expectedText:renderText({code:"300308.SZ",...expected})});
}
writeFileSync(new URL('./golden.json',import.meta.url),JSON.stringify({config,cases}));
