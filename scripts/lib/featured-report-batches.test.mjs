import test from 'node:test';
import assert from 'node:assert/strict';
import { planTranslationBatches, validateBatchTranslation } from './featured-report-batches.mjs';
const source = (count, text) => ({ sections: Array.from({ length: count }, (_, i) => ({ id: `s${i}`, title: `Section ${i}`, blocks: [{ id: `b${i}`, original: text, sourceLocations: [{ page: i+1, bbox: [0,0,1,1] }] }] })) });
test('30 short chapters fit in one request with all source anchors intact', () => {
 const input = source(30, 'Revenue grew 10% year over year.');
 const batches = planTranslationBatches(input);
 assert.equal(batches.length, 1); assert.equal(batches[0].length, 30);
 assert.deepEqual(batches[0].map(b => b.sourceLocations), input.sections.map(s => s.blocks[0].sourceLocations));
});
test('large reports split by volume without dropping or reordering blocks', () => {
 const batches = planTranslationBatches(source(30, 'Revenue grew 10%. '.repeat(150)));
 assert.ok(batches.length > 1); assert.ok(batches.length < 30);
 assert.deepEqual(batches.flat().map(b => b.id), Array.from({length:30},(_,i)=>`b${i}`));
});
test('Chinese and oversized single blocks respect output and input budgets', () => {
 assert.ok(planTranslationBatches(source(10, '增长'.repeat(500))).length > 1);
 assert.throws(() => planTranslationBatches(source(1, '增长'.repeat(10000))), /预算/);
});
test('reject missing, duplicate or reordered translations', () => {
 const blocks=planTranslationBatches(source(2,'Revenue'))[0];
 const value={sections:[{id:'s0',title:'一'},{id:'s1',title:'二'}],items:[{id:'b0',translation:'收入'},{id:'b1',translation:'收入'}],digest:'收入'};
 validateBatchTranslation(value,blocks);
 for (const bad of [{...value,items:value.items.slice(1)}, {...value,items:[value.items[1],value.items[0]]}]) assert.throws(()=>validateBatchTranslation(bad,blocks));
});

test('whole report uses one call with complete translations and a nonempty summary', async () => {
 const { translateReport } = await import('./featured-report-batches.mjs');
 const input=source(4,'Revenue grew 10%.'); const groups=planTranslationBatches(input); const calls=[];
 const result=await translateReport(input,groups,async(kind,payload,check)=>{
   calls.push(kind);
   const value={sections:input.sections.map(s=>({id:s.id,title:'收入'})),items:payload.blocks.map(b=>({id:b.id,translation:'收入增长10%。'})),summary:'收入增长。',citations:['b0']};
   assert.throws(()=>check({...value,summary:''}));
   assert.ok(payload.blocks.every(b => !('sourceLocations' in b) && !('sectionId' in b)));
   check({items:value.items,summary:value.summary});
   assert.throws(()=>check({...value,items:[]}));
   check(value);return value;
 });
 assert.deepEqual(calls,['whole']);assert.equal(result.results.length,1);assert.ok(result.summary.summary);
});
test('multiple batches keep shared glossary and a final summary without location metadata', async()=>{
 const { translateReport } = await import('./featured-report-batches.mjs');
 const input=source(2,'Revenue'); const groups=input.sections.map(s=>[{...s.blocks[0],sectionId:s.id,sectionTitle:s.title}]);const calls=[];
 await translateReport(input,groups,async(kind,payload,check)=>{
   calls.push(kind);let value;
   if(kind==='glossary')value={terms:['Revenue=收入']};
   else if(kind==='summary') {assert.equal(payload.length,2);assert.ok(payload.every(d=>!('sources' in d)));value={summary:'收入'};}
   else {assert.deepEqual(payload.glossary,{terms:['Revenue=收入']});assert.ok(payload.blocks.every(b=>!('sourceLocations' in b)));value={items:payload.blocks.map(b=>({id:b.id,translation:'收入'})),digest:'收入'};}
   check(value);return value;
 });
 assert.deepEqual(calls,['glossary','translate','translate','summary']);
});
