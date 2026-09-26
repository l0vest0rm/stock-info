import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture,addDocument,extract,snapshot,record,candidates,contract,migrationPath } from './information-records-fixture.mjs';
import { inTransaction,readDocument,readInformationRows,makeInformationRows,recordDigest,claimExtraction,commitExtraction,
  failExtraction,feedInputFingerprint,sourceExpectation,mergeStorySourceReference,shouldAttemptExtraction } from './information-records-store.mjs';
import { canonicalJson,currentExtractionSql,rowToInformation } from '../../src/modules/knowledge/domain/information-records.ts';

for (const count of [0,1,3]) test(`atomic extraction supports ${count} formal records`,()=>{
  const f=fixture(); try {
    const doc=addDocument(f.db);
    const records=Array.from({length:count},(_,i)=>({...record,statement:`中际旭创2026Q2第${i+1}项收入为100亿元。`}));
    extract(f,doc,records);
    const saved=snapshot(f,doc.id);
    assert.equal(saved.records.length,count); assert.equal(saved.meta.informationExtraction.status,'complete');
    assert.equal(saved.meta.informationExtraction.current.outcome,count?'extracted':'no_information');
    assert.equal(saved.meta.informationExtraction.current.recordsDigest,recordDigest(saved.records));
    assert.equal(saved.meta.feed.records,undefined);
    assert.equal(shouldAttemptExtraction(saved.meta.informationExtraction,feedInputFingerprint(saved,doc.body,contract),contract),false);
    assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(),[]);
  } finally { f.close(); }
});

test('record identities survive order/entity-index changes, but not content changes',()=>{
  const a=record,b={...record,statement:'中际旭创2026Q2收入同比增长。'};
  const first=makeInformationRows('doc','hash',[a,b],candidates,1);
  const second=makeInformationRows('doc','hash',[b,a],[],2);
  assert.equal(first[0].information_id,second[1].information_id); assert.equal(first[1].information_id,second[0].information_id);
  assert.notEqual(first[0].information_id,first[1].information_id); assert.notEqual(recordDigest(first),recordDigest(second));
  const repeated=makeInformationRows('doc','hash',[a,a],[],1); assert.notEqual(repeated[0].information_id,repeated[1].information_id);
});

test('expired/lost lease or changed input cannot replace a successful row set',()=>{
  const f=fixture(); try {
    const doc=addDocument(f.db); extract(f,doc); const before=snapshot(f,doc.id);
    const newBody=doc.body+'新增内容';
    f.db.prepare('UPDATE knowledge_doc_content_refs SET content_sha256=? WHERE doc_id=?').run('changed',doc.id);
    const row=readDocument(f.db,doc.id), source=sourceExpectation(row,newBody);
    const fingerprint=feedInputFingerprint(row,newBody,contract);
    assert.throws(()=>claimExtraction(doc.id,{owner:'stale',source,fingerprint,contract},f.options),/input changed/);
    assert.deepEqual(snapshot(f,doc.id).records,before.records);
  } finally {f.close();}
});

test('write failure after delete rolls the entire record/tag/result transaction back',()=>{
  const f=fixture(); try {
    const doc=addDocument(f.db); extract(f,doc); const before=snapshot(f,doc.id);
    f.db.exec(`CREATE TRIGGER reject_new_information BEFORE INSERT ON knowledge_information_records BEGIN SELECT RAISE(ABORT,'test injected failure'); END;`);
    f.db.prepare("UPDATE knowledge_docs SET metadata_json=json_set(metadata_json,'$.informationExtraction.status','pending') WHERE doc_id=?").run(doc.id);
    const row=readDocument(f.db,doc.id), source=sourceExpectation(row,doc.body),fingerprint=feedInputFingerprint(row,doc.body,contract);
    claimExtraction(doc.id,{owner:'owner',source,fingerprint,contract},f.options);
    assert.throws(()=>commitExtraction(doc.id,{owner:'owner',source,fingerprint,contract,body:doc.body,
      records:[record],categoryCandidates:[],companyCandidates:candidates},f.options),/test injected failure/);
    assert.deepEqual(snapshot(f,doc.id).records,before.records);
    failExtraction(doc.id,{owner:'owner',error:'injected'},f.options);
    const after=snapshot(f,doc.id); assert.equal(after.meta.informationExtraction.status,'failed');
    assert.deepEqual(after.meta.informationExtraction.current,before.meta.informationExtraction.current);
  } finally {f.close();}
});

test('source merges during a model call survive successful commit; lost owners fail closed',()=>{
  const f=fixture(); try {
    const doc=addDocument(f.db),row=readDocument(f.db,doc.id),source=sourceExpectation(row,doc.body),fingerprint=feedInputFingerprint(row,doc.body,contract);
    claimExtraction(doc.id,{owner:'owner',source,fingerprint,contract},f.options);
    mergeStorySourceReference(doc.id,{sourceKey:'other',sourceItemId:'item',url:'https://example.invalid/other',contentHash:'hash'},f.options);
    const args={source,fingerprint,contract,body:doc.body,records:[record],categoryCandidates:[],companyCandidates:candidates};
    assert.throws(()=>commitExtraction(doc.id,{...args,owner:'wrong'},f.options),/lease/);
    commitExtraction(doc.id,{...args,owner:'owner'},f.options);
    assert.equal(snapshot(f,doc.id).meta.feed.sources.length,2);
  } finally {f.close();}
});

test('pending/processing/backoff states do not erase a successful result',()=>{
  const f=fixture(); try {
    const doc=addDocument(f.db); extract(f,doc); const saved=snapshot(f,doc.id),fingerprint=feedInputFingerprint(saved,doc.body,contract);
    const state={...saved.meta.informationExtraction,status:'failed',lastAttempt:{...contract,inputFingerprint:fingerprint,attempts:5}};
    assert.equal(shouldAttemptExtraction(state,fingerprint,contract),false);
    assert.equal(shouldAttemptExtraction(state,'changed-input',contract),true);
    assert.equal(shouldAttemptExtraction({...state,status:'processing',lastAttempt:{leaseUntil:Date.now()+10000}},'new',contract),false);
  } finally {f.close();}
});

test('document deletion cascades records and tags without result headers',()=>{
  const f=fixture(); try {const doc=addDocument(f.db);extract(f,doc);f.db.prepare('DELETE FROM knowledge_docs WHERE doc_id=?').run(doc.id);
    assert.equal(readInformationRows(f.db,doc.id).length,0);assert.equal(f.db.prepare('SELECT count(*) n FROM knowledge_doc_tags').get().n,0);
    assert.equal(f.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='knowledge_document_results'").get().n,0);
  }finally{f.close();}
});

test('nonempty migration preserves IDs, statements, measurements, times and zero-record outcomes',()=>{
  const f=fixture({migrate:false});try {
    const a=addDocument(f.db,{meta:{feed:{}}}),b=addDocument(f.db,{meta:{feed:{}}}),c=addDocument(f.db,{meta:{feed:{}}});
    for (const [id,outcome] of [[a.id,'extracted'],[b.id,'no_information'],[c.id,'needs_review']]) {
      f.db.prepare("UPDATE knowledge_docs SET metadata_json='{}' WHERE doc_id=?").run(id);
      f.db.prepare('INSERT INTO knowledge_document_results VALUES (?,?,?,1234)').run('r_'+id,id,outcome);
    }
    f.db.prepare(`INSERT INTO knowledge_information_records VALUES ('stable-id',?,'中际旭创','fact','revenue','2026Q2','原始陈述','{}',9,1234)`).run('r_'+a.id);
    inTransaction(f.db,()=>f.db.exec(readFileSync(migrationPath,'utf8')));
    const saved=readInformationRows(f.db,a.id)[0];assert.equal(saved.information_id,'stable-id');assert.equal(saved.statement,'原始陈述');assert.equal(saved.created_at,1234);assert.equal(saved.sort_order,0);
    assert.equal(readDocument(f.db,b.id).meta.informationExtraction.current.outcome,'no_information');
    assert.equal(readDocument(f.db,c.id).meta.informationExtraction.current.outcome,'needs_review');
    assert.equal(readDocument(f.db,a.id).meta.informationExtraction.current.inputFingerprint,null);
    assert.equal(readDocument(f.db,a.id).meta.informationExtraction.current.provenanceStatus,'legacy_unverified');
  }finally{f.close();}
});

for (const problem of ['orphan-result','orphan-record','invalid-measurement']) test(`migration aborts without loss on ${problem}`,()=>{
  const f=fixture({migrate:false});try {
    const doc=addDocument(f.db);f.db.prepare("UPDATE knowledge_docs SET metadata_json='{}' WHERE doc_id=?").run(doc.id);
    f.db.prepare('INSERT INTO knowledge_document_results VALUES (?,?,?,1234)').run('r',problem==='orphan-result'?'missing':doc.id,'extracted');
    f.db.exec('PRAGMA foreign_keys=OFF');
    f.db.prepare(`INSERT INTO knowledge_information_records VALUES ('i',?,'中际旭创','fact','revenue',NULL,'原文',?,0,1234)`).run(problem==='orphan-record'?'missing':'r',problem==='invalid-measurement'?'[]':'{}');
    f.db.exec('PRAGMA foreign_keys=ON');
    assert.throws(()=>inTransaction(f.db,()=>f.db.exec(readFileSync(migrationPath,'utf8'))));
    assert.equal(f.db.prepare('SELECT count(*) n FROM knowledge_document_results').get().n,1);
    assert.equal(f.db.prepare('SELECT count(*) n FROM knowledge_information_records').get().n,1);
    assert.equal(readDocument(f.db,doc.id).meta.informationExtraction,undefined);
  }finally{f.close();}
});

test('SQL validity rejects contract, source-content and row-count mismatches',()=>{
  const f=fixture();try {const doc=addDocument(f.db);extract(f,doc);
    const count=()=>f.db.prepare(`SELECT count(*) n FROM knowledge_docs d WHERE ${currentExtractionSql('d',contract)}`).get().n;
    assert.equal(count(),1);f.db.prepare("UPDATE knowledge_doc_content_refs SET content_sha256='changed' WHERE doc_id=?").run(doc.id);assert.equal(count(),0);
  }finally{f.close();}
});
