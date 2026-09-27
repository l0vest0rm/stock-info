import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addDocument, fixture } from './lib/information-records-fixture.mjs';

test('rejected source never becomes a document or an extraction request', () => {
  const f = fixture();
  try {
    const input = join(f.directory,'source.json');
    const audit = join(f.directory,'rejected.jsonl');
    writeFileSync(input, JSON.stringify({ sourceKey:'cls_telegraph', sourceItemId:'sports-1',
      title:'中国队获得亚运会篮球铜牌', body:'中国队在亚运会篮球比赛中获得铜牌。',
      url:'https://example.test/sports',
      publishedAt:new Date().toISOString() }));
    const env = { ...process.env, LOCAL_DB_PATH:f.file, KNOWLEDGE_CONTENT_LOCAL_DIR:join(f.directory,'content'),
      INFORMATION_FEED_STATE_FILE:join(f.directory,'state.json'),
      INFORMATION_FEED_TAG_USAGE_FILE:join(f.directory,'usage.json'),
      INFORMATION_FEED_RELEVANCE_AUDIT_FILE:audit,
      INFORMATION_FEED_RELEVANCE_BACKUP_DIR:join(f.directory,'backups'),
      INFORMATION_FEED_LOCK_FILE:join(f.directory,'runner.lock'), LLM_RUNTIME:'local' };
    const run = (mode) => spawnSync(process.execPath,['scripts/information-feed.mjs','--mode',mode,'--file',input],
      {cwd:process.cwd(),env,encoding:'utf8'});
    const rejected = run('run');
    assert.equal(rejected.status,0,rejected.stderr);
    const counters = JSON.parse(rejected.stdout.trim().split('\n').at(-1));
    assert.equal(counters.relevanceRejected,1);
    assert.equal(counters.tagged,0);
    assert.equal(f.db.prepare("select count(*) n from knowledge_docs where source_type='information_feed'").get().n,0);
    const rejectedEntry = JSON.parse(readFileSync(audit,'utf8').trim());
    assert.equal(rejectedEntry.reasonCodes[0],'whitelist_miss');
    assert.equal(rejectedEntry.title,'中国队获得亚运会篮球铜牌');
    assert.equal(rejectedEntry.url,'https://example.test/sports');

    writeFileSync(input, JSON.stringify({ sourceKey:'cls_telegraph', sourceItemId:'rate-1',
      title:'央行宣布降息', body:'央行宣布下调利率。',publishedAt:new Date().toISOString() }));
    const accepted = run('ingest');
    assert.equal(accepted.status,0,accepted.stderr);
    assert.equal(f.db.prepare("select count(*) n from knowledge_docs where source_type='information_feed'").get().n,1);
    const meta=JSON.parse(f.db.prepare("select metadata_json from knowledge_docs where source_type='information_feed'").get().metadata_json);
    assert.equal(meta.feed.investmentGate.effectiveDisposition,'pass');
    const backfill=spawnSync(process.execPath,['scripts/backfill-information-feed-relevance.mjs','--apply'],
      {cwd:process.cwd(),env,encoding:'utf8'});
    assert.equal(backfill.status,0,backfill.stderr);
    assert.equal(JSON.parse(backfill.stdout).counts.unchanged,1);
  } finally { f.close(); }
});

test('legacy pending document is rejected before claiming extraction quota', () => {
  const f=fixture();
  try {
    const title='中国队获得篮球铜牌',body='中国队在篮球比赛中获得铜牌。';
    const doc=addDocument(f.db,{title,body});
    f.db.prepare("update knowledge_docs set metadata_json=json_remove(metadata_json,'$.feed.investmentGate') where doc_id=?").run(doc.id);
    const contentDir=join(f.directory,'content');
    mkdirSync(contentDir,{recursive:true});
    writeFileSync(join(contentDir,`${doc.id}.md`),body);
    const usage=join(f.directory,'usage.json');
    const result=spawnSync(process.execPath,['scripts/information-feed.mjs','--mode','tag','--doc-id',doc.id],{
      cwd:process.cwd(),encoding:'utf8',env:{...process.env,LOCAL_DB_PATH:f.file,
        KNOWLEDGE_CONTENT_LOCAL_DIR:contentDir,INFORMATION_FEED_LOCK_FILE:join(f.directory,'runner.lock'),
        INFORMATION_FEED_TAG_USAGE_FILE:usage,LLM_RUNTIME:'local'},
    });
    assert.equal(result.status,0,result.stderr);
    const counters=JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.equal(counters.tagged,0);assert.equal(counters.tagFailed,0);
    assert.equal(f.db.prepare("select json_extract(metadata_json,'$.feed.investmentGate.effectiveDisposition') disposition from knowledge_docs where doc_id=?").get(doc.id).disposition,'reject');
    assert.equal(f.db.prepare("select json_extract(metadata_json,'$.informationExtraction.status') status from knowledge_docs where doc_id=?").get(doc.id).status,'pending');
  } finally { f.close(); }
});

test('the 500-call daily cap blocks a pending relevant document before model claim', () => {
  const f = fixture();
  try {
    const title = '央行宣布降息', body = '央行宣布下调利率。';
    const doc = addDocument(f.db, { title, body });
    const contentDir = join(f.directory, 'content');
    mkdirSync(contentDir, { recursive: true });
    writeFileSync(join(contentDir, `${doc.id}.md`), body);
    const usage = join(f.directory, 'usage.json');
    writeFileSync(usage, JSON.stringify({ day: new Date().toISOString().slice(0, 10), count: 500 }));
    const result = spawnSync(process.execPath, ['scripts/information-feed.mjs', '--mode', 'tag', '--doc-id', doc.id], {
      cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, LOCAL_DB_PATH: f.file,
        KNOWLEDGE_CONTENT_LOCAL_DIR: contentDir, INFORMATION_FEED_LOCK_FILE: join(f.directory, 'runner.lock'),
        INFORMATION_FEED_TAG_USAGE_FILE: usage, LLM_RUNTIME: 'local' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(usage, 'utf8')).count, 500);
    assert.equal(f.db.prepare("select json_extract(metadata_json,'$.informationExtraction.status') status from knowledge_docs where doc_id=?").get(doc.id).status, 'pending');
  } finally { f.close(); }
});
