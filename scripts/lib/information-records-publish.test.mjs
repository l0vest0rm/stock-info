import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,addDocument,extract,snapshot,record,contract } from './information-records-fixture.mjs';
import { publicationEligible,publicationFingerprint,remotePublicationMetadata,stagePublicationStatements,
  verifyStagedPublication,exposePublicationSql } from './information-records-publish.mjs';
import { currentExtractionSql } from '../../src/modules/knowledge/domain/information-records.ts';
const permissions={cls_telegraph:{fullTextAllowed:true}},categories=new Set(['revenue']);

test('publication eligibility checks records, tags, digest, policy and local review',()=>{
  const f=fixture();try {const doc=addDocument(f.db);extract(f,doc);const saved=snapshot(f,doc.id);
    assert.equal(publicationEligible(saved,contract,permissions,categories),true);
    for(const mutate of [s=>s.records[0].statement+='tamper',s=>s.tags=[],s=>s.meta.informationExtraction.categoryCandidates=null,
      s=>s.meta.informationExtraction.status='failed',s=>s.meta.feed.originalFormat='pdf',s=>s.content_sha256='wrong',
      s=>s.meta.feed.investmentGate.effectiveDisposition='reject',s=>s.meta.feed.investmentGate.policyVersion='old']){
      const bad=structuredClone(saved);mutate(bad);assert.equal(publicationEligible(bad,contract,permissions,categories),false);
    }
  }finally{f.close();}
});

test('staged writes remain invisible after each SQL statement and expose only after verification',()=>{
  const local=fixture(),remote=fixture();try {const doc=addDocument(local.db);extract(local,doc);const saved=snapshot(local,doc.id);
    const fingerprint=publicationFingerprint(saved),token='owner-1';
    const visible=()=>remote.db.prepare(`SELECT count(*) n FROM knowledge_docs d WHERE json_extract(d.metadata_json,'$.feed.publishAllowed')=1 AND ${currentExtractionSql('d',contract)}`).get().n;
    for(const sql of stagePublicationStatements(saved,token,fingerprint)){remote.db.exec(sql);assert.equal(visible(),0);}
    verifyStagedPublication(saved,snapshot(remote,doc.id),token,fingerprint);
    remote.db.exec(exposePublicationSql(saved,token,fingerprint));assert.equal(visible(),1);
    const metadata=snapshot(remote,doc.id).meta;
    assert.equal(metadata.informationExtraction.categoryCandidates,undefined);assert.equal(metadata.informationExtraction.lastAttempt,undefined);assert.equal(metadata.feed.records,undefined);
  }finally{local.close();remote.close();}
});

test('superseded publication owner cannot change staged records or expose them',()=>{
  const local=fixture(),remote=fixture();try {const doc=addDocument(local.db);extract(local,doc);const saved=snapshot(local,doc.id),fingerprint=publicationFingerprint(saved);
    const old=stagePublicationStatements(saved,'old',fingerprint),fresh=stagePublicationStatements(saved,'fresh',fingerprint);
    remote.db.exec(old[0]);remote.db.exec(fresh[0]);for(const sql of old.slice(1))remote.db.exec(sql);
    assert.equal(snapshot(remote,doc.id).records.length,0);
    remote.db.exec(exposePublicationSql(saved,'old',fingerprint));assert.equal(snapshot(remote,doc.id).meta.feed.publishAllowed,false);
    assert.throws(()=>verifyStagedPublication(saved,snapshot(remote,doc.id),'old',fingerprint),/owner mismatch/);
  }finally{local.close();remote.close();}
});

test('verification checks record content, not only counts; fingerprint tracks record digest',()=>{
  const local=fixture(),remote=fixture();try {const doc=addDocument(local.db);extract(local,doc);const saved=snapshot(local,doc.id),fingerprint=publicationFingerprint(saved);
    for(const sql of stagePublicationStatements(saved,'t',fingerprint))remote.db.exec(sql);
    remote.db.prepare("UPDATE knowledge_information_records SET statement=statement||' altered'").run();
    assert.throws(()=>verifyStagedPublication(saved,snapshot(remote,doc.id),'t',fingerprint),/content verification/);
    const changed=structuredClone(saved);changed.meta.informationExtraction.current.recordsDigest='new-digest';
    assert.notEqual(publicationFingerprint(changed),fingerprint);
  }finally{local.close();remote.close();}
});
