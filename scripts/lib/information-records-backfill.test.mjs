import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,addDocument,extract,snapshot,record,contract,legacyFeed } from './information-records-fixture.mjs';
import { inTransaction,feedInputFingerprint,recordDigest } from './information-records-store.mjs';
import { planInformationBackfill,applyInformationBackfill } from './information-records-backfill.mjs';

function seed(f,doc,records=[record],extra={}) {
  const before=snapshot(f,doc.id);
  before.meta.feed=legacyFeed(before,records,{taggingInputFingerprint:feedInputFingerprint(before,doc.body,contract),...extra});
  f.db.prepare('UPDATE knowledge_docs SET metadata_json=? WHERE doc_id=?').run(JSON.stringify(before.meta),doc.id);
  return snapshot(f,doc.id);
}
const aliases=[{name:'中际旭创',alias:'中际旭创',code:'300308.SZ'}];
function plan(s,body) {return planInformationBackfill(s,{body,aliases,contract});}

for (const records of [[],[record]]) test(`valid JSON backfill preserves ${records.length} records and is idempotent`,()=>{
  const f=fixture();try {
    const doc=addDocument(f.db);const old=seed(f,doc,records);const next=plan(old,doc.body);
    assert.equal(next.meta.informationExtraction.current.provenanceStatus,'verified');
    assert.equal(next.meta.informationExtraction.current.outcome,records.length?'extracted':'no_information');
    inTransaction(f.db,()=>applyInformationBackfill(f.db,old,next));
    const saved=snapshot(f,doc.id);assert.equal(saved.records.length,records.length);
    assert.equal(saved.meta.feed.records,undefined);assert.equal(saved.meta.feed.taggingStatus,undefined);
    assert.equal(saved.meta.informationExtraction.current.inputFingerprint,old.meta.feed.taggingInputFingerprint);
    assert.equal(plan(saved,doc.body).kind,'unchanged');
  }finally{f.close();}
});

test('unknown candidate assessment remains needs_review, not an empty successful assessment',()=>{
  const f=fixture();try {const doc=addDocument(f.db),old=seed(f,doc);delete old.meta.feed.categoryCandidates;
    const next=plan(old,doc.body);assert.equal(next.meta.informationExtraction.categoryCandidates,null);
    assert.equal(next.meta.informationExtraction.current.outcome,'needs_review');
    assert.equal(next.meta.informationExtraction.current.categoryCandidateCount,null);
  }finally{f.close();}
});

test('old contracts and missing bodies preserve information without invented provenance',()=>{
  const f=fixture();try {const doc=addDocument(f.db),old=seed(f,doc,[record],{tagContract:'feed-tag-v0'});
    const next=plan(old,null);assert.equal(next.records.length,1);assert.equal(next.records[0].statement,record.statement);
    assert.equal(next.meta.informationExtraction.current.provenanceStatus,'legacy_unverified');
    assert.equal(next.meta.informationExtraction.current.model,null);
  }finally{f.close();}
});

test('relational/JSON conflict is refused and existing information is not replaced',()=>{
  const f=fixture();try {const doc=addDocument(f.db);extract(f,doc);const initial=snapshot(f,doc.id);
    const old=seed(f,doc,[{...record,statement:'中际旭创收入为另一数值。'}]);
    assert.throws(()=>plan(old,doc.body),/conflicting/);assert.deepEqual(snapshot(f,doc.id).records,initial.records);
  }finally{f.close();}
});

test('identical relational/JSON records retain existing information IDs',()=>{
  const f=fixture();try {const doc=addDocument(f.db);extract(f,doc);const initial=snapshot(f,doc.id),old=seed(f,doc);
    const next=plan(old,doc.body);assert.equal(next.records[0].information_id,initial.records[0].information_id);
    inTransaction(f.db,()=>applyInformationBackfill(f.db,old,next));assert.equal(snapshot(f,doc.id).records.length,1);
  }finally{f.close();}
});

test('backfill rejects a changed snapshot and does not lose concurrent source updates',()=>{
  const f=fixture();try {const doc=addDocument(f.db),old=seed(f,doc),next=plan(old,doc.body);
    f.db.prepare("UPDATE knowledge_docs SET metadata_json=json_set(metadata_json,'$.feed.extraSource','new') WHERE doc_id=?").run(doc.id);
    assert.throws(()=>inTransaction(f.db,()=>applyInformationBackfill(f.db,old,next)),/changed/);
    const saved=snapshot(f,doc.id);assert.equal(saved.meta.feed.extraSource,'new');assert.equal(saved.records.length,0);assert.equal(saved.meta.feed.records.length,1);
  }finally{f.close();}
});

test('candidate evidence beyond the original input prefix cannot validate legacy extraction',()=>{
  const f=fixture();try {const evidence='测试平台发生持续两小时以上的服务中断';const body='正文'.repeat(6500)+evidence;
    const doc=addDocument(f.db,{body});const candidate={entity:'测试平台',informationType:'event',statement:'测试平台发生持续两小时以上的服务中断。',
      suggestedCategory:'服务中断',evidence,whyNotExisting:'产品研发不涵盖线上服务中断。'};
    const old=seed(f,doc,[],{categoryCandidates:[candidate]});const next=plan(old,body);
    assert.equal(next.meta.informationExtraction.current.provenanceStatus,'legacy_unverified');
    assert.equal(next.meta.informationExtraction.categoryCandidates[0].evidence,evidence);
    assert.equal(next.meta.informationExtraction.current.outcome,'needs_review');
  }finally{f.close();}
});

test('legacy completed labels without a records array do not become no_information',()=>{
  const f=fixture();try {const doc=addDocument(f.db),old=seed(f,doc,[]);delete old.meta.feed.records;
    const next=plan(old,doc.body);assert.equal(next.meta.informationExtraction.current,null);
    assert.equal(next.meta.informationExtraction.status,'pending');
  }finally{f.close();}
});

test('malformed records are rejected instead of silently dropped',()=>{
  const f=fixture();try {const doc=addDocument(f.db),old=seed(f,doc,[{...record,unknown:'would be lost'}]);
    assert.throws(()=>plan(old,doc.body),/without data loss/);
  }finally{f.close();}
});
