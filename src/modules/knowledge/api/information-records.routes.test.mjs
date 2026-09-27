import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
// The API is bundled separately; keep the SQLite fixture and its file-relative
// ontology loader unbundled so import.meta.url retains its original meaning.
if (!process.env.INFORMATION_RECORDS_API_BUNDLE) throw new Error('run npm run test:information-records');
const { informationFeedRoutes } = await import(process.env.INFORMATION_RECORDS_API_BUNDLE);
import { fixture,addDocument,extract,record } from '../../../../scripts/lib/information-records-fixture.mjs';
import { evaluateInvestmentRelevance } from '../../../../scripts/lib/information-feed-relevance.mjs';

function client(f,local=true){
  const app=new Hono().route('/api',informationFeedRoutes);
  const DB={prepare(sql){let values=[];return {bind(...v){values=v;return this;},async all(){return {results:f.db.prepare(sql).all(...values)};},async first(){return f.db.prepare(sql).get(...values) || null;}};}};
  return async path=>{const response=await app.request('/api'+path,{}, {DB,APP_RUNTIME:local?'node':'worker'});return {status:response.status,...await response.json()};};
}

test('feed pagination is per document, not per information record',async()=>{
  const f=fixture();try {const one=addDocument(f.db,{time:'2026-09-25T12:00:00.000Z'}),two=addDocument(f.db,{time:'2026-09-26T12:00:00.000Z'});
    extract(f,one);extract(f,two,[record,{...record,category:'net_profit',statement:'中际旭创2026Q2净利润增长。'}]);
    const get=client(f),first=await get('/knowledge/feed?limit=1');assert.equal(first.status,200);assert.equal(first.data.list.length,1);assert.equal(first.data.list[0].records.length,2);
    assert.equal(first.data.has_next,true);const second=await get('/knowledge/feed?limit=1&cursor='+encodeURIComponent(first.data.next_cursor));assert.equal(second.data.list[0].doc_id,one.id);
  }finally{f.close();}
});

test('company and category filters must match the same record, and matching information leads the card',async()=>{
  const f=fixture();try {
    const first={...record,category:'revenue',statement:'中际旭创2026Q2收入为100亿元。'};
    const second={...record,entity:'澜起科技',category:'net_profit',statement:'澜起科技2026Q2净利润为20亿元。'};
    const doc=addDocument(f.db,{body:first.statement+second.statement});
    extract(f,doc,[first,second],[],{companyCandidates:[
      {name:'中际旭创',matchedAlias:'中际旭创',tagId:'company:300308.SZ'},
      {name:'澜起科技',matchedAlias:'澜起科技',tagId:'company:688008.SH'},
    ]});
    const get=client(f);
    assert.equal((await get('/knowledge/feed?company=300308.SZ&category=net_profit')).data.list.length,0);
    assert.equal((await get('/knowledge/feed?entity=company%3A300308.SZ&category=net_profit')).data.list.length,0);
    assert.equal((await get('/knowledge/feed?company=300308.SZ&industry='+encodeURIComponent('电子设备-电子设备制造-电子设备制造'))).data.list.length,0);
    assert.equal((await get('/knowledge/feed?category=net_profit&industry='+encodeURIComponent('信息技术-通信设备-通信传输设备'))).data.list.length,0);
    const matched=await get('/knowledge/feed?company=688008.SH&category=net_profit');
    assert.equal(matched.data.list.length,1);
    assert.equal(matched.data.list[0].records[0].entity,'澜起科技');
    assert.equal(matched.data.list[0].records[0].category,'net_profit');
    assert.equal(matched.data.list[0].tags.find((tag) => tag.tagId.startsWith('category:')).tagId,'category:net_profit');
    assert.equal((await get('/knowledge/feed?category=revenue,net_profit')).data.list.length,1);
    assert.equal((await get('/knowledge/feed?company=300308.SZ,688008.SH')).data.list.length,1);
    assert.equal((await get('/knowledge/feed?entity=company%3A300308.SZ,company%3A688008.SH')).data.list.length,1);
    const entities=(await get('/knowledge/feed/facets')).data.entities;
    assert.deepEqual(entities.map((item) => item.id).sort(),['company:300308.SZ','company:688008.SH']);
  }finally{f.close();}
});

test('content type filtering uses the same default as the feed response and facets',async()=>{
  const f=fixture();try {
    const doc=addDocument(f.db);extract(f,doc);
    f.db.prepare("UPDATE knowledge_docs SET metadata_json=json_remove(metadata_json,'$.feed.contentType') WHERE doc_id=?").run(doc.id);
    const get=client(f);
    assert.equal((await get('/knowledge/feed?content_type=news')).data.list[0].content_type,'news');
    assert.deepEqual((await get('/knowledge/feed/facets')).data.content_types,[{id:'news',count:1}]);
  }finally{f.close();}
});

test('rejected investment relevance is absent from feed and facets',async()=>{
  const f=fixture();try {
    const title='中国队获得亚运会篮球铜牌',body='中国队在篮球比赛中获得铜牌。';
    const rejected=addDocument(f.db,{title,body,meta:{feed:{investmentGate:evaluateInvestmentRelevance({title,body})}}});
    extract(f,rejected,[{...record,statement:'中国队在篮球比赛中获得铜牌。',entity:'中国队'}]);
    const get=client(f);
    assert.equal((await get('/knowledge/feed')).data.list.length,0);
    assert.deepEqual((await get('/knowledge/feed/facets')).data.entities,[]);
  }finally{f.close();}
});

test('digest tampering hides records from feed cards',async()=>{
  const f=fixture();try {const doc=addDocument(f.db);extract(f,doc);const get=client(f);
    assert.equal((await get('/knowledge/feed')).data.list[0].records.length,1);
    f.db.prepare("UPDATE knowledge_information_records SET statement=statement||'changed' WHERE doc_id=?").run(doc.id);
    assert.equal((await get('/knowledge/feed')).data.list[0].records.length,0);
  }finally{f.close();}
});

test('unresolved non-company names remain retrievable without a fabricated entity key',async()=>{
  const f=fixture();try {const item={...record,entity:'测试,市场',statement:'测试,市场2026Q2收入增长。'},doc=addDocument(f.db,{body:item.statement});extract(f,doc,[item]);
    const get=client(f);
    const facets=(await get('/knowledge/feed/facets')).data.entities;
    assert.deepEqual(facets,[{id:`entity:${encodeURIComponent(item.entity)}`,count:1,label:item.entity}]);
    const feed=await get('/knowledge/feed?entity='+encodeURIComponent(facets[0].id));
    assert.equal(feed.data.list.length,1);assert.equal(feed.data.list[0].records[0].entity,item.entity);
    assert.equal((await get('/knowledge/feed?entity='+encodeURIComponent(facets[0].id)+'&category=net_profit')).data.list.length,0);
    assert.equal((await get('/knowledge/feed?entity=entity%3A%25BAD')).status,400);
  }finally{f.close();}
});

test('review candidates are local-only',async()=>{
  const f=fixture();try {const evidence='测试平台发生持续两小时以上的服务中断';const doc=addDocument(f.db,{body:record.statement+evidence});
    const candidate={entity:'测试平台',informationType:'event',statement:evidence+'。',suggestedCategory:'服务中断',evidence,whyNotExisting:'产品研发不涵盖在线服务故障。'};
    extract(f,doc,[record],[candidate]);const get=client(f);
    const feed=await get('/knowledge/feed?status=category_gap');assert.equal(feed.data.list.length,1);assert.equal(feed.data.list[0].records.length,1);assert.equal(feed.data.list[0].category_candidates.length,1);
    assert.equal((await client(f,false)('/knowledge/feed')).data.list.length,0);
  }finally{f.close();}
});

test('production requires explicit publication and never returns local diagnostics',async()=>{
  const f=fixture();try {const doc=addDocument(f.db);extract(f,doc);const get=client(f,false);
    assert.equal((await get('/knowledge/feed')).data.list.length,0);
    f.db.prepare("UPDATE knowledge_docs SET metadata_json=json_set(metadata_json,'$.feed.publishAllowed',json('true')) WHERE doc_id=?").run(doc.id);
    const result=await get('/knowledge/feed');assert.equal(result.data.list.length,1);assert.equal(result.data.list[0].category_candidates,undefined);
    assert.equal((await get('/knowledge/feed?status=complete')).status,400);
  }finally{f.close();}
});

test('empty successful extraction remains complete and unclassified',async()=>{
  const f=fixture();try {const doc=addDocument(f.db);extract(f,doc,[]);const get=client(f);
    const result=await get('/knowledge/feed?status=unclassified');assert.equal(result.data.list.length,1);assert.equal(result.data.list[0].tagging_status,'complete');
    assert.deepEqual(result.data.list[0].records,[]);assert.deepEqual(result.data.list[0].category_candidates,[]);
    assert.equal((await get('/knowledge/feed/facets')).status,200);
    assert.equal((await get('/knowledge/feed/story?key='+doc.id)).data.list.length,1);
  }finally{f.close();}
});

test('standalone entity records endpoint is removed in both runtimes',async()=>{
  for (const local of [true,false]) {
    const app=new Hono().route('/api',informationFeedRoutes);
    const response=await app.request('/api/knowledge/information-records?entity=A',{}, {APP_RUNTIME:local?'node':'worker'});
    assert.equal(response.status,404);
  }
});
