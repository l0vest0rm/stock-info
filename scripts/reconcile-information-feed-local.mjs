#!/usr/bin/env node

// Reconcile already-stored, provably repeated local cards after dedupe rules change.
// Conservative by design: only same-title, same-week, deterministic repeat pairs.
import { brotliDecompressSync } from 'node:zlib';
import { closeSync, existsSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifyFeedCandidate } from './lib/information-feed-dedupe.mjs';
import { executeLocalD1Sql, queryLocalD1Sql } from './lib/local-d1-sqlite.mjs';

const apply = process.argv.includes('--apply');
if (process.argv.slice(2).some((arg) => arg !== '--apply')) throw new Error('unknown argument');
if (apply && process.env.LLM_RUNTIME !== 'local') throw new Error('local feed reconciliation requires LLM_RUNTIME=local');
const lockFile = resolve('data/local/information-feed.lock');
if (apply) {
  let fd;
  try { fd = openSync(lockFile, 'wx'); }
  catch (error) {
    if (error?.code === 'EEXIST') throw new Error('feed ingester is active; retry after it finishes');
    throw error;
  }
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
  process.on('exit', () => { try { unlinkSync(lockFile); } catch { /* already removed */ } });
}
const root = resolve(process.env.KNOWLEDGE_CONTENT_LOCAL_DIR || '/Users/terry/git/data/stock-info/knowledge/content-cache');
const rows = queryLocalD1Sql(`select d.doc_id,d.title,d.published_at,d.fetched_at,d.metadata_json,c.content_key
  from knowledge_docs d join knowledge_doc_content_refs c on c.doc_id=d.doc_id
  where d.source_type='information_feed' order by d.title,d.published_at,d.doc_id`, { requiredTable: 'knowledge_docs' });
const groups = new Map();
for (const row of rows) {
  row.meta = JSON.parse(row.metadata_json || '{}');
  const key = row.content_key?.startsWith('knowledge-content/') ? row.content_key.slice('knowledge-content/'.length) : '';
  const path = key ? resolve(root, key) : '';
  if (!path.startsWith(`${root}/`) || !existsSync(path)) continue;
  const bytes = readFileSync(path);
  row.body = (path.endsWith('.br') ? brotliDecompressSync(bytes) : bytes).toString('utf8');
  row.localPath = path;
  groups.set(row.title, [...(groups.get(row.title) || []), row]);
}
const removals = [];
for (const group of groups.values()) {
  if (group.length < 2) continue;
  const retained = [];
  for (const row of group) {
    if (row.meta.feed?.kind !== 'new') { retained.push(row); continue; }
    const match = retained.find((candidate) =>
      candidate.meta.feed?.kind === 'new'
      && Math.abs(Date.parse(candidate.published_at || candidate.fetched_at) - Date.parse(row.published_at || row.fetched_at)) <= 7 * 86400000
      && classifyFeedCandidate({ body: row.body, title: row.title, sourceKey: row.meta.feed.sourceKey,
        sourceItemId: row.meta.feed.sourceItemId, entityCodes: row.meta.feed.entityCodes },
      { body: candidate.body, title: candidate.title, sourceKey: candidate.meta.feed.sourceKey,
        sourceItemId: candidate.meta.feed.sourceItemId, entityCodes: candidate.meta.feed.entityCodes }).kind === 'repeat');
    if (match) removals.push({ keep: match, drop: row });
    else retained.push(row);
  }
}
console.log(JSON.stringify({ dryRun: !apply, repeatedCards: removals.length,
  pairs: removals.map(({ keep, drop }) => ({ keep: keep.doc_id, drop: drop.doc_id, title: drop.title })) }));
if (!apply || !removals.length) process.exit(0);
if (removals.some(({ keep, drop }) => keep.meta.feed.publishedFingerprint || drop.meta.feed.publishedFingerprint)) {
  throw new Error('published feed entries require coordinated remote deletion; local-only reconcile refused');
}
const sourceSets = new Map();
for (const { keep, drop } of removals) {
  const refs = sourceSets.get(keep.doc_id) || new Map((keep.meta.feed.sources || []).map((item) => [sourceKey(item), item]));
  for (const item of drop.meta.feed.sources || []) refs.set(sourceKey(item), item);
  sourceSets.set(keep.doc_id, refs);
}
const statements = [];
for (const [docId, refs] of sourceSets) {
  const row = rows.find((item) => item.doc_id === docId);
  row.meta.feed.sources = [...refs.values()];
  statements.push(`update knowledge_docs set metadata_json=${q(JSON.stringify(row.meta))},updated_at=${Date.now()} where doc_id=${q(docId)};`);
}
for (const { drop } of removals) statements.push(`delete from knowledge_docs where doc_id=${q(drop.doc_id)};`);
executeLocalD1Sql(statements.join('\n'), { requiredTable: 'knowledge_docs' });
let removedFiles = 0;
for (const { drop } of removals) {
  const refs = queryLocalD1Sql(`select count(*) n from knowledge_doc_content_refs where content_key=${q(drop.content_key)}`, { requiredTable: 'knowledge_doc_content_refs' });
  if (Number(refs[0]?.n) === 0) { rmSync(drop.localPath, { force: true }); removedFiles += 1; }
}
console.log(JSON.stringify({ reconciled: removals.length, removedFiles }));

function sourceKey(item) { return [item.sourceKey,item.sourceItemId,item.url,item.contentHash].join('|'); }
function q(value) { return `'${String(value).replaceAll("'", "''")}'`; }
