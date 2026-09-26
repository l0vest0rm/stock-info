import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync,mkdirSync,readFileSync,readdirSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixture,addDocument,snapshot,record,contract,legacyFeed } from './lib/information-records-fixture.mjs';
import { feedInputFingerprint } from './lib/information-records-store.mjs';

const root=resolve(new URL('..',import.meta.url).pathname);
test('all append-only migrations replay from empty and a second run does nothing',()=>{
  const directory=mkdtempSync(join(tmpdir(),'stock-info-records-replay-'));
  try {
    const path=join(directory,'replay.sqlite'),env={...process.env,LOCAL_DB_PATH:path};
    const first=execFileSync(process.execPath,['scripts/local-db.mjs'],{cwd:root,env,encoding:'utf8'});
    assert.match(first,/0142_information_records_direct_document/);
    assert.match(execFileSync(process.execPath,['scripts/local-db.mjs'],{cwd:root,env,encoding:'utf8'}),/0 migrations applied/);
    const db=new DatabaseSync(path);
    try {
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
      assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='knowledge_document_results'").get().n,0);
      const columns=db.prepare('PRAGMA table_info(knowledge_information_records)').all().map(c=>c.name);
      assert.ok(columns.includes('doc_id'));assert.ok(columns.includes('entity_key'));assert.ok(!columns.includes('result_id'));
    }finally{db.close();}
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('backfill CLI defaults to dry-run and apply archives exact originals, then is idempotent',()=>{
  const f=fixture();try {
    const doc=addDocument(f.db),original=snapshot(f,doc.id);
    original.meta.feed=legacyFeed(original,[record],{taggingInputFingerprint:feedInputFingerprint(original,doc.body,contract)});
    f.db.prepare('UPDATE knowledge_docs SET metadata_json=? WHERE doc_id=?').run(JSON.stringify(original.meta),doc.id);
    const contentDir=join(f.directory,'content'),archiveDir=join(f.directory,'archives');mkdirSync(contentDir);
    writeFileSync(join(contentDir,`${doc.id}.md`),doc.body);
    const args=['scripts/backfill-information-records.mjs','--database',f.file,'--content-dir',contentDir,'--archive-dir',archiveDir];
    const run=(extra=[])=>JSON.parse(execFileSync(process.execPath,[...args,...extra],{cwd:root,encoding:'utf8'}));
    assert.equal(run().dryRun,true);assert.equal(snapshot(f,doc.id).records.length,0);
    const applied=run(['--apply']);assert.deepEqual(applied.errors,[]);assert.equal(applied.verified,1);assert.equal(applied.records,1);
    assert.equal(snapshot(f,doc.id).meta.feed.records,undefined);assert.equal(snapshot(f,doc.id).records.length,1);
    const archive=JSON.parse(readFileSync(join(archiveDir,readdirSync(archiveDir)[0]),'utf8'));
    assert.equal(archive.snapshot.meta.feed.records[0].statement,record.statement);
    assert.equal(run(['--apply']).changed,0);
  }finally{f.close();}
});

test('new-schema publisher dry-run uses records and refuses legacy execution',()=>{
  const f=fixture();try {
    const output=JSON.parse(execFileSync(process.execPath,['scripts/publish-information-feed.mjs'],{
      cwd:root,env:{...process.env,LOCAL_DB_PATH:f.file},encoding:'utf8'}));
    assert.equal(output.dryRun,true);assert.equal(output.remoteCalls,0);assert.equal(output.applyBlocked,true);
  }finally{f.close();}
});
