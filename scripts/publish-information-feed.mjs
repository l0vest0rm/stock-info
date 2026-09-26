#!/usr/bin/env node

// Batches only fully tagged local feed snapshots into remote R2/D1. No model calls.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { brotliDecompressSync } from 'node:zlib';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { buildContentOptions, prepareKnowledgeContentAsync } from './knowledge-content-r2.mjs';
import { executeLocalD1Sql, queryLocalD1Sql } from './lib/local-d1-sqlite.mjs';
import { feedCategoryCatalogHash } from './lib/information-feed-extraction.mjs';
import { INFORMATION_PROCESSING_DOCUMENT_ANALYSIS_SYSTEM_PROMPT, INFORMATION_PROCESSING_DOCUMENT_ANALYSIS_USER_PROMPT } from './generated/prompt-text.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const apply = process.argv.includes('--apply');
const config = JSON.parse(readFileSync(resolve(root, 'config/information-feed.json'), 'utf8'));
const categoryIds = new Set(Object.keys(JSON.parse(readFileSync(resolve(root, 'config/knowledge-ontology.json'), 'utf8')).informationExtraction.categories));
const currentTagContract = config.tagContract;
if (!/^feed-tag-v\d+$/.test(currentTagContract)) throw new Error('invalid information feed tag contract');
if (apply && config.automation?.publishRemote !== true) {
  console.log(JSON.stringify({ published: 0, skipped: 'remote publication switch is off' }));
  process.exit(0);
}
const maxBatch = 200;
const currentPromptHash = sha(INFORMATION_PROCESSING_DOCUMENT_ANALYSIS_SYSTEM_PROMPT + INFORMATION_PROCESSING_DOCUMENT_ANALYSIS_USER_PROMPT);
const currentCategoryCatalogHash = feedCategoryCatalogHash();
const currentCandidatePolicyHash = sha(JSON.stringify(config.companyCandidates || {}));
const ledgerFile = resolve(root, process.env.INFORMATION_FEED_PUBLISH_LEDGER || 'data/local/information-feed-publish-ledger.json');
const ledger = existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, 'utf8')) : { uploadedKeys: {} };
const options = buildContentOptions({ remote: true, uploadContentRemote: true,
  contentPublicBaseUrl: process.env.INFORMATION_FEED_REMOTE_CONTENT_BASE_URL || 'https://content.tinfo.cc' });
const publication = config.remotePublication || {};
const rows = queryLocalD1Sql(`select d.doc_id,d.source_type,d.report_type,d.source_name,d.title,d.url,d.published_at,d.fetched_at,d.event_time,d.access_method,
  d.summary,d.content_preview,d.metadata_json,d.sort_time,d.source_name_normalized,d.updated_at,
  c.content_key,c.content_url,c.content_type,c.content_encoding,c.content_bytes,c.content_sha256
  from knowledge_docs d left join knowledge_doc_content_refs c on c.doc_id=d.doc_id
  where d.source_type='information_feed' order by d.sort_time,d.doc_id`, { requiredTable: 'knowledge_docs' });
const tags = queryLocalD1Sql(`select t.doc_id,t.tag,t.weight,t.tagging_input_fingerprint,t.contract_version
  from knowledge_doc_tags t join knowledge_docs d on d.doc_id=t.doc_id where d.source_type='information_feed'`, { requiredTable: 'knowledge_doc_tags' });
const tagsByDoc = new Map();
for (const tag of tags) tagsByDoc.set(tag.doc_id, [...(tagsByDoc.get(tag.doc_id) || []), tag]);
const latestByStory = new Map();
for (const row of rows) {
  row.meta = JSON.parse(row.metadata_json || '{}');
  const story = row.meta.feed?.storyKey || row.doc_id;
  latestByStory.set(story, row);
}
const eligible = [];
const remove = [];
for (const row of rows) {
  const feed = row.meta.feed || {};
  const validTags = (tagsByDoc.get(row.doc_id) || []).filter((tag) =>
    (tag.tag.startsWith('company:') || (tag.tag.startsWith('category:') && categoryIds.has(tag.tag.slice('category:'.length))))
    && tag.weight >= 1 && tag.weight <= 100
    && tag.tagging_input_fingerprint === feed.taggingInputFingerprint
    && tag.contract_version === feed.tagContract
  );
  const latest = latestByStory.get(feed.storyKey || row.doc_id);
  const latestFeed = latest.meta.feed || {};
  const fullTextAllowed = publication[feed.sourceKey]?.fullTextAllowed === true;
  if ((!fullTextAllowed || feed.originalFormat !== 'text') && feed.publishedFingerprint) { remove.push(row); continue; }
  if (latestFeed.taggingStatus === 'complete' && latest !== row && !hasCurrentTags(latest)
    && feed.publishedFingerprint) { remove.push(row); continue; }
  if (latest !== row) continue;
  if (feed.version !== 'v1' || feed.originalFormat !== 'text' || !fullTextAllowed || !row.content_key || feed.taggingStatus !== 'complete'
    || feed.tagContract !== currentTagContract || feed.tagPromptHash !== currentPromptHash || feed.tagCategoryCatalogHash !== currentCategoryCatalogHash
    || feed.tagCandidatePolicyHash !== currentCandidatePolicyHash
    || feed.taggingContentSha256 !== row.content_sha256
    || !feed.taggingInputFingerprint || !Array.isArray(feed.records) || feed.records.length === 0
    || feed.records.some((record) => !categoryIds.has(record?.category))
    || new Set(validTags.filter((tag) => tag.tag.startsWith('category:')).map((tag) => tag.tag.slice('category:'.length))).size
      !== new Set(feed.records.map((record) => record.category)).size
    || feed.records.some((record) => !validTags.some((tag) => tag.tag === `category:${record.category}`))) {
    if (feed.publishedFingerprint && (feed.taggingStatus !== 'pending' || feed.originalFormat !== 'text' || !fullTextAllowed)) remove.push(row);
    continue;
  }
  feed.publishAllowed = true;
  row.metadata_json = JSON.stringify(row.meta);
  const fingerprint = sha(JSON.stringify([row.doc_id,row.content_sha256,validTags.map((tag) => [tag.tag,tag.weight]).sort(),
    feed.sources,feed.taggingInputFingerprint,feed.tagContract]));
  if (feed.publishedFingerprint !== fingerprint) eligible.push({ row, validTags, fingerprint });
}
if (!apply) {
  console.log(JSON.stringify({ dryRun: true, eligible: eligible.length, remove: remove.length,
    missingR2: eligible.filter((item) => !ledger.uploadedKeys[item.row.content_key]).length }));
  process.exit(0);
}
if (process.env.LLM_RUNTIME !== 'local') throw new Error('remote feed publishing must run from the local Node runtime');
let uploaded = 0, published = 0, deleted = 0, batches = 0;
for (let offset = 0; offset < Math.max(eligible.length, remove.length); offset += maxBatch) {
  const chunk = eligible.slice(offset, offset + maxBatch);
  const removals = remove.slice(offset, offset + maxBatch);
  const ready = [];
  for (const item of chunk) {
    const body = readLocalBody(item.row.content_key);
    if (!body || sha(body) !== item.row.content_sha256) {
      console.error(`[information-feed-publish] missing or changed local content: ${item.row.doc_id}`);
      continue;
    }
    if (!ledger.uploadedKeys[item.row.content_key]) {
      try {
        const remote = await prepareKnowledgeContentAsync({ docId: item.row.doc_id, markdown: body, remote: true, options });
        if (remote.contentKey !== item.row.content_key) throw new Error('remote content key mismatch');
        ledger.uploadedKeys[item.row.content_key] = Date.now();
        saveLedger();
        uploaded += 1;
      } catch (error) {
        console.error(`[information-feed-publish] R2 failed ${item.row.doc_id}: ${String(error)}`);
        continue;
      }
    }
    item.row.content_url = `${options.publicBaseUrl.replace(/\/$/, '')}/${item.row.content_key}`;
    ready.push(item);
  }
  if (!ready.length && !removals.length) continue;
  const units = [
    ...ready.map((item) => ({ item, row: null, sql: statementsFor(item.row, item.validTags).join('\n') })),
    ...removals.map((row) => ({ item: null, row, sql: `delete from knowledge_docs where doc_id=${q(row.doc_id)};` })),
  ];
  let group = [];
  let bytes = 0;
  const groups = [];
  for (const unit of units) {
    const size = Buffer.byteLength(unit.sql) + 1;
    if (size > 650000) throw new Error(`single feed item exceeds D1 batch limit: ${unit.item?.row.doc_id || unit.row.doc_id}`);
    if (group.length && bytes + size > 650000) { groups.push(group); group = []; bytes = 0; }
    group.push(unit);
    bytes += size;
  }
  if (group.length) groups.push(group);
  for (const batch of groups) {
    const batchReady = batch.flatMap((unit) => unit.item ? [unit.item] : []);
    const batchRemovals = batch.flatMap((unit) => unit.row ? [unit.row] : []);
    const temp = mkdtempSync(join(tmpdir(), 'stock-info-feed-publish-'));
    try {
      const file = join(temp, 'batch.sql');
      writeFileSync(file, batch.map((unit) => unit.sql).join('\n'));
      remoteD1(['--file', file]);
      const ids = batchReady.map((item) => item.row.doc_id);
      const verified = remoteQuery(`select
        ${ids.length ? `(select count(*) from knowledge_docs d join knowledge_doc_content_refs c on c.doc_id=d.doc_id
          where d.doc_id in (${ids.map(q).join(',')}) and c.content_sha256=json_extract(d.metadata_json,'$.feed.taggingContentSha256')
          and json_extract(d.metadata_json,'$.feed.publishAllowed')=1)` : '0'} as docs,
        ${ids.length ? `(select count(*) from knowledge_doc_tags t join knowledge_docs d on d.doc_id=t.doc_id
          where t.doc_id in (${ids.map(q).join(',')})
          and t.tagging_input_fingerprint=json_extract(d.metadata_json,'$.feed.taggingInputFingerprint')
          and t.contract_version=json_extract(d.metadata_json,'$.feed.tagContract'))` : '0'} as tags,
        ${batchRemovals.length ? `(select count(*) from knowledge_docs where doc_id in (${batchRemovals.map((row) => q(row.doc_id)).join(',')}))` : '0'} as remaining`);
      if (Number(verified.docs) !== batchReady.length || Number(verified.tags) !== batchReady.reduce((sum, item) => sum + item.validTags.length, 0)
        || Number(verified.remaining) !== 0) throw new Error('remote batch verification failed');
      for (const item of batchReady) {
        item.row.meta.feed.publishedFingerprint = item.fingerprint;
        executeLocalD1Sql(`update knowledge_docs set metadata_json=${q(JSON.stringify(item.row.meta))} where doc_id=${q(item.row.doc_id)};`, { requiredTable: 'knowledge_docs' });
      }
      for (const row of batchRemovals) {
        delete row.meta.feed.publishedFingerprint;
        row.meta.feed.publishAllowed = false;
        executeLocalD1Sql(`update knowledge_docs set metadata_json=${q(JSON.stringify(row.meta))} where doc_id=${q(row.doc_id)};`, { requiredTable: 'knowledge_docs' });
      }
      published += batchReady.length;
      deleted += batchRemovals.length;
      batches += 1;
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }
}
console.log(JSON.stringify({ uploaded, published, deleted, batches }));

function statementsFor(row, tags) {
  const columns = ['doc_id','source_type','report_type','source_name','title','url','published_at','fetched_at','event_time','access_method','summary','content_preview','metadata_json','sort_time','source_name_normalized','updated_at'];
  const content = ['doc_id','content_key','content_url','content_type','content_encoding','content_bytes','content_sha256','updated_at'];
  return [
    `insert into knowledge_docs (${columns.join(',')}) values (${columns.map((column) => q(row[column])).join(',')}) on conflict(doc_id) do update set ${columns.filter((column) => column !== 'doc_id').map((column) => `${column}=excluded.${column}`).join(',')};`,
    `insert into knowledge_doc_content_refs (${content.join(',')}) values (${content.map((column) => q(row[column])).join(',')}) on conflict(doc_id) do update set ${content.filter((column) => column !== 'doc_id').map((column) => `${column}=excluded.${column}`).join(',')};`,
    `delete from knowledge_doc_tags where doc_id=${q(row.doc_id)} and (tag like 'company:%' or tag like 'category:%' or tag like 'topic:%' or tag like 'theme:%' or tag like 'focus:%');`,
    ...tags.map((tag) => `insert into knowledge_doc_tags (doc_id,tag,weight,tagging_input_fingerprint,contract_version) values (${q(row.doc_id)},${q(tag.tag)},${q(tag.weight)},${q(tag.tagging_input_fingerprint)},${q(tag.contract_version)});`),
  ];
}

function hasCurrentTags(row) {
  const feed = row.meta.feed || {};
  return (tagsByDoc.get(row.doc_id) || []).some((tag) =>
    tag.tag.startsWith('category:') && categoryIds.has(tag.tag.slice('category:'.length))
    && tag.tagging_input_fingerprint === feed.taggingInputFingerprint
    && tag.contract_version === feed.tagContract
    && tag.weight >= 1 && tag.weight <= 100);
}

function remoteD1(extra) {
  return execFileSync('npx', ['wrangler','d1','execute','stock_info','--remote','--json',...extra], { cwd: root, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
}
function remoteQuery(sql) {
  const output = JSON.parse(remoteD1(['--command', sql]));
  return output[0]?.results?.[0] || {};
}
function readLocalBody(key) {
  if (!key?.startsWith('knowledge-content/')) return '';
  const path = resolve(process.env.KNOWLEDGE_CONTENT_LOCAL_DIR || '/Users/terry/git/data/stock-info/knowledge/content-cache', key.slice('knowledge-content/'.length));
  if (!existsSync(path)) return '';
  const bytes = readFileSync(path);
  return (key.endsWith('.br') ? brotliDecompressSync(bytes) : bytes).toString('utf8');
}
function saveLedger() {
  mkdirSync(dirname(ledgerFile), { recursive: true });
  const temporary = `${ledgerFile}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(ledger));
  renameSync(temporary, ledgerFile);
}
function sha(value) { return createHash('sha256').update(value).digest('hex'); }
function q(value) { return value === null || value === undefined ? 'null' : `'${String(value).replaceAll("'", "''")}'`; }
