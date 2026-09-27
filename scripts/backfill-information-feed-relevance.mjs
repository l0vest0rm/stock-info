#!/usr/bin/env node
// Re-evaluate persisted local feed documents without calling the extraction model.
import { DatabaseSync } from 'node:sqlite';
import { brotliDecompressSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildContentOptions } from './knowledge-content-r2.mjs';
import { LOCAL_SQLITE_CONNECTION_PRAGMAS, resolveExistingLocalD1Database } from './lib/local-d1-sqlite.mjs';
import { currentInvestmentGate, evaluateInvestmentRelevance,
  investmentRelevanceBodyHash, stockWhitelistEntries } from './lib/information-feed-relevance.mjs';
import { appendRejectedFeed } from './lib/information-feed-rejection-audit.mjs';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
if (args.some((arg) => !['--apply','--dry-run'].includes(arg))) throw new Error('usage: node scripts/backfill-information-feed-relevance.mjs [--apply|--dry-run]');
const db = new DatabaseSync(resolveExistingLocalD1Database(), { readOnly: !apply });
db.exec(LOCAL_SQLITE_CONNECTION_PRAGMAS.filter((line) => apply || !line.includes('journal_mode')).join('\n'));
const contentRoot = buildContentOptions({remote:false}).localContentDir;
const stockEntries = stockWhitelistEntries(db.prepare(`select s.code,s.short_name,a.alias
  from stock s left join stock_alias a on a.code=s.code
  where s.information_feed_focus=1`).all());
const rows = db.prepare(`select d.doc_id,d.title,d.url,d.published_at,d.metadata_json,c.content_key,c.content_sha256
  from knowledge_docs d join knowledge_doc_content_refs c on c.doc_id=d.doc_id
  where d.source_type='information_feed' order by d.sort_time,d.doc_id`).all();
if (apply) {
  const backupDir = resolve(process.env.INFORMATION_FEED_RELEVANCE_BACKUP_DIR || 'data/local/backups');
  mkdirSync(backupDir,{recursive:true});
  const filename = resolve(backupDir,`information-feed-relevance-${new Date().toISOString().replaceAll(':','-')}.jsonl`);
  writeFileSync(filename,rows.map((row) => JSON.stringify({doc_id:row.doc_id,metadata_json:row.metadata_json})).join('\n')+'\n',{flag:'wx',mode:0o600});
  console.error(`Archived original feed metadata: ${filename}`);
  db.exec('BEGIN IMMEDIATE');
}
const update = apply ? db.prepare("update knowledge_docs set metadata_json=? where doc_id=? and metadata_json=?") : null;
const counts = { scanned:0, unchanged:0, pass:0, reject:0, uncertain:0, missingBody:0, invalidContent:0, changed:0 };
const rejectedSamples = [];
const rejectedForAudit = [];
try {
  for (const row of rows) {
    counts.scanned += 1;
    if (!row.content_key?.startsWith('knowledge-content/')) { counts.missingBody += 1; continue; }
    const path = resolve(contentRoot, row.content_key.slice('knowledge-content/'.length));
    if (!path.startsWith(contentRoot + '/') || !existsSync(path)) { counts.missingBody += 1; continue; }
    const payload = readFileSync(path);
    const body = (row.content_key.endsWith('.br') ? brotliDecompressSync(payload) : payload).toString('utf8');
    if (investmentRelevanceBodyHash(body) !== row.content_sha256) { counts.invalidContent += 1; continue; }
    const metadata = JSON.parse(row.metadata_json);
    const feed = metadata.feed || {};
    const gate = evaluateInvestmentRelevance({title:row.title,body,stockEntries});
    counts[gate.decision] += 1;
    if (gate.effectiveDisposition === 'reject' && rejectedSamples.length < 20) rejectedSamples.push({docId:row.doc_id,title:row.title,reason:gate.reasonCodes});
    if (apply && gate.effectiveDisposition === 'reject') rejectedForAudit.push({ sourceKey: feed.sourceKey,
      sourceItemId: feed.sourceItemId, url: row.url, title: row.title, publishedAt: row.published_at, ...gate });
    if (currentInvestmentGate(feed.investmentGate,{title:row.title,body,stockEntries})
      && JSON.stringify(feed.investmentGate) === JSON.stringify(gate)) { counts.unchanged += 1; continue; }
    if (apply) {
      metadata.feed = {...feed,investmentGate:gate};
      const result = update.run(JSON.stringify(metadata),row.doc_id,row.metadata_json);
      if (result.changes !== 1) throw new Error(`concurrent metadata change: ${row.doc_id}`);
    }
    counts.changed += 1;
  }
  if (apply) db.exec('COMMIT');
} catch (error) {
  if (apply) db.exec('ROLLBACK');
  throw error;
} finally { db.close(); }
for (const entry of rejectedForAudit) appendRejectedFeed(entry);
console.log(JSON.stringify({apply,counts,rejectedSamples},null,2));
