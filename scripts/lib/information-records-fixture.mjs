import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FEED_EXTRACTION_CONTRACT } from '../generated/information-records-contract.mjs';
import { claimExtraction, commitExtraction, readDocument, readDocumentSnapshot, feedInputFingerprint,
  sourceExpectation, sha, inTransaction } from './information-records-store.mjs';
import { evaluateInvestmentRelevance } from './information-feed-relevance.mjs';

export const contract = FEED_EXTRACTION_CONTRACT;
export const record = { entity:'中际旭创',informationType:'fact',category:'revenue',period:'2026Q2',
  statement:'中际旭创2026Q2收入为100亿元。',forecastMeasurement:null };
export const candidates = [{name:'中际旭创',matchedAlias:'中际旭创',tagId:'company:300308.SZ'}];
export const migrationPath = resolve('migrations/0142_information_records_direct_document.sql');
export function fixture({migrate = true} = {}) {
  const directory = mkdtempSync(join(tmpdir(),'stock-info-information-records-'));
  const file = join(directory,'fixture.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE knowledge_docs (
      doc_id TEXT PRIMARY KEY,source_type TEXT,report_type TEXT,source_name TEXT,title TEXT,url TEXT,
      published_at TEXT,fetched_at TEXT,event_time TEXT,access_method TEXT,summary TEXT,content_preview TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',sort_time TEXT,source_name_normalized TEXT,updated_at INTEGER,
      processing_content_hash TEXT,processing_updated_at INTEGER);
    CREATE TABLE knowledge_doc_content_refs (doc_id TEXT PRIMARY KEY,content_key TEXT,content_url TEXT,
      content_type TEXT,content_encoding TEXT,content_bytes INTEGER,content_sha256 TEXT,updated_at INTEGER,
      FOREIGN KEY(doc_id) REFERENCES knowledge_docs(doc_id) ON DELETE CASCADE);
    CREATE TABLE knowledge_doc_tags (doc_id TEXT,tag TEXT,weight INTEGER DEFAULT 0,tagging_input_fingerprint TEXT,
      contract_version TEXT,PRIMARY KEY(doc_id,tag),FOREIGN KEY(doc_id) REFERENCES knowledge_docs(doc_id) ON DELETE CASCADE);
    CREATE TABLE stock (code TEXT PRIMARY KEY,short_name TEXT NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE stock_alias (alias TEXT NOT NULL,code TEXT NOT NULL,source TEXT,updated_at INTEGER NOT NULL,
      PRIMARY KEY(alias,code),FOREIGN KEY(code) REFERENCES stock(code));`);
  const old = readFileSync(resolve('migrations/0128_drop_knowledge_run_ledgers.sql'),'utf8');
  db.exec(old.slice(old.indexOf('create table knowledge_document_results'),old.indexOf('insert into knowledge_document_results')));
  if (migrate) inTransaction(db, () => db.exec(readFileSync(migrationPath,'utf8')));
  return {db,file,directory,options:{path:file},close(){db.close();rmSync(directory,{recursive:true,force:true});}};
}
export function addDocument(db, {id = `f_${randomUUID().replaceAll('-','').slice(0,24)}`, body = record.statement,
  time = new Date().toISOString(),meta = {}, title = '中际旭创营收资讯'} = {}) {
  const metadata = {...meta,feed:{version:'v1',originalFormat:'text',sourceKey:'cls_telegraph',sources:[{sourceKey:'cls_telegraph',url:'https://example.invalid/news'}],
    kind:'new',storyKey:id,contentType:'news',fullBodyHash:sha(body),
    investmentGate:evaluateInvestmentRelevance({title,body}),...meta.feed},
    informationExtraction:meta.informationExtraction || {status:'pending',current:null,categoryCandidates:null}};
  db.prepare(`INSERT INTO knowledge_docs (doc_id,source_type,report_type,source_name,title,url,published_at,fetched_at,event_time,
    access_method,summary,content_preview,metadata_json,sort_time,source_name_normalized,updated_at)
    VALUES (?,'information_feed','news','测试来源',?,'https://example.invalid/news',?,?,?,'markdown',?,?,?,?,'测试来源',?)`)
    .run(id,title,time,time,time,body,body,JSON.stringify(metadata),time,Date.now());
  db.prepare(`INSERT INTO knowledge_doc_content_refs VALUES (?,?,?,'text/markdown','identity',?,?,?)`)
    .run(id,`knowledge-content/${id}.md`,`https://example.invalid/${id}`,Buffer.byteLength(body),sha(body),Date.now());
  return {id,body};
}
export function extract(f, document, records = [record], categoryCandidates = [], extra = {}) {
  const row = readDocument(f.db,document.id);
  const fingerprint = feedInputFingerprint(row,document.body,contract);
  const source = sourceExpectation(row,document.body), owner = randomUUID();
  claimExtraction(document.id,{owner,fingerprint,source,contract},f.options);
  return commitExtraction(document.id,{owner,fingerprint,source,contract,body:document.body,records,categoryCandidates,
    companyCandidates:candidates,...extra},f.options);
}
export function snapshot(f,id) { return readDocumentSnapshot(f.db,id); }
export function legacyFeed(snapshot, records = [record], extra = {}) {
  return {...snapshot.meta.feed,taggingStatus:'complete',taggingInputFingerprint:feedInputFingerprint(snapshot,records.length ? records.map(r=>r.statement).join('\n') : snapshot.summary,contract),
    taggingContentSha256:snapshot.content_sha256,tagContract:contract.contractVersion,tagPromptHash:contract.promptHash,
    tagCategoryCatalogHash:contract.categoryCatalogHash,tagCandidatePolicyHash:contract.candidatePolicyHash,
    taggedAt:Date.now(),records,categoryCandidates:[],...extra};
}
