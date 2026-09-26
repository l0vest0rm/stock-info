#!/usr/bin/env node

// Local-only ingest/tag runner. The production Worker never invokes a model.
import { createHash, randomUUID } from 'node:crypto';
import { brotliDecompressSync } from 'node:zlib';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildContentOptions, prepareKnowledgeContent } from './knowledge-content-r2.mjs';
import { executeLocalD1Sql, queryLocalD1Sql } from './lib/local-d1-sqlite.mjs';
import { canonicalFeedUrl, classifyFeedItem, feedBodyHash, feedShingleSketch, sketchesOverlap, FEED_DEDUPE_VERSION } from './lib/information-feed-dedupe.mjs';
import { normalizeFeedSource } from './lib/information-feed-source.mjs';
import { feedCompanyCandidates } from './lib/information-feed-company-candidates.mjs';
import { feedCategoryCatalog, feedCategoryCatalogHash, parseFeedExtraction } from './lib/information-feed-extraction.mjs';
import { isRecentFeedTime, recentFeedRows, MAX_FEED_AGE_HOURS } from './lib/information-feed-window.mjs';
import { INFORMATION_FEED_DOCUMENT_ANALYSIS_SYSTEM_PROMPT,
  INFORMATION_FEED_DOCUMENT_ANALYSIS_USER_PROMPT } from './generated/prompt-text.mjs';
import { requestLocalDirectLlmText } from '../src/shared/local-direct-llm.ts';
import { claimExtraction, commitExtraction, failExtraction, feedInputFingerprint, sourceExpectation,
  shouldAttemptExtraction, mergeStorySourceReference } from './lib/information-records-store.mjs';
import { FEED_EXTRACTION_CONTRACT } from './generated/information-records-contract.mjs';
import { INFORMATION_STORAGE_VERSION, contractMatches } from '../src/modules/knowledge/domain/information-records.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs(process.argv.slice(2));
const feedConfig = JSON.parse(readFileSync(resolve(ROOT, 'config/information-feed.json'), 'utf8'));
const contentOptions = buildContentOptions({ remote: false });
const stateFile = resolve(ROOT, process.env.INFORMATION_FEED_STATE_FILE || 'data/local/information-feed-ingest-state.json');
const usageFile = resolve(ROOT, process.env.INFORMATION_FEED_TAG_USAGE_FILE || 'data/local/information-feed-tag-usage.json');
const TAG_CONTRACT = feedConfig.tagContract;
if (!/^feed-tag-v\d+$/.test(TAG_CONTRACT)) throw new Error('invalid information feed tag contract');
const PROMPT_HASH = sha(INFORMATION_FEED_DOCUMENT_ANALYSIS_SYSTEM_PROMPT + INFORMATION_FEED_DOCUMENT_ANALYSIS_USER_PROMPT);
const CATEGORY_CATALOG_HASH = feedCategoryCatalogHash();
const CANDIDATE_POLICY_HASH = sha(JSON.stringify(feedConfig.companyCandidates || {}));
const EXTRACTION_CONTRACT = { contractVersion: TAG_CONTRACT, promptHash: PROMPT_HASH,
  categoryCatalogHash: CATEGORY_CATALOG_HASH, candidatePolicyHash: CANDIDATE_POLICY_HASH, model: 'gpt-6-luna' };
if (!contractMatches(FEED_EXTRACTION_CONTRACT, EXTRACTION_CONTRACT)) throw new Error('extraction contract build is stale; run npm run build:prompts');

if (args.mode !== 'ingest' && process.env.LLM_RUNTIME !== 'local') throw new Error('information feed tagging requires LLM_RUNTIME=local from the local launch script');

const counters = { scanned: 0, accepted: 0, repeat: 0, update: 0, new: 0, rejected: {}, tagged: 0, tagFailed: 0 };
const releaseLock = acquireLock(resolve(ROOT, 'data/local/information-feed.lock'));
try {
  if (args.mode === 'ingest' || args.mode === 'run') await ingest();
  if (args.mode === 'tag' || args.mode === 'run') await tagPending();
  console.log(JSON.stringify(counters));
} finally { releaseLock(); }

async function ingest() {
  const state = loadJson(stateFile, { files: {} });
  const files = args.file ? [resolve(args.file)] : recentSourceFiles(args.lookbackDays);
  const rows = loadFeedRows();
  const candidates = rows.map((row) => ({ ...row, body: readLocalBody(row.content_key) })).filter((row) => row.body);
  const knownSourceVersions = new Map();
  for (const candidate of candidates) for (const ref of candidate.feed.sources || []) {
    const hash = ref.contentHash || (candidate.feed.kind === 'new' ? feedBodyHash(candidate.body) : '');
    if (!hash) continue;
    const key = `${ref.sourceKey}|${ref.sourceItemId || ref.url}`;
    knownSourceVersions.set(key, new Set([...(knownSourceVersions.get(key) || []), hash]));
  }
  let processed = 0;
  for (const file of files) {
    if (processed >= args.maxDocuments) break;
    const signature = fileSignature(file);
    const previous = state.files[file];
    if (!args.file && previous === signature) continue;
    const rawItems = parseSourceFile(file);
    const clsFile = basename(file).startsWith('cls-telegraph-');
    const firstIndex = !args.file && !clsFile && previous?.signature === signature ? previous.nextIndex : 0;
    for (let index = firstIndex; index < rawItems.length; index += 1) {
      if (processed >= args.maxDocuments) break;
      const raw = rawItems[index];
      const source = normalizeFeedSource(raw);
      if (source.accepted && !isRecentFeedTime(source.publishedAt || source.fetchedAt, Date.now(), args.maxAgeHours)) {
        counters.rejected.outside_48_hour_window = (counters.rejected.outside_48_hour_window || 0) + 1;
        if (!args.file) {
          state.files[file] = index + 1 === rawItems.length ? signature : { signature, nextIndex: index + 1 };
          saveJson(stateFile, state);
        }
        continue;
      }
      const sourceVersionKey = source.accepted ? `${source.sourceKey}|${source.sourceItemId || source.url}` : '';
      const sourceVersionHash = source.accepted ? feedBodyHash(source.body) : '';
      if (clsFile && source.accepted && knownSourceVersions.get(sourceVersionKey)?.has(sourceVersionHash)) continue;
      processed += 1;
      counters.scanned += 1;
      if (!source.accepted) {
        counters.rejected[source.reason] = (counters.rejected[source.reason] || 0) + 1;
      } else {
        ingestOne(source, candidates);
        knownSourceVersions.set(sourceVersionKey, new Set([...(knownSourceVersions.get(sourceVersionKey) || []), sourceVersionHash]));
      }
      if (!args.file) {
        state.files[file] = index + 1 === rawItems.length ? signature : { signature, nextIndex: index + 1 };
        saveJson(stateFile, state);
      }
    }
    if (!args.file && processed < args.maxDocuments) {
      state.files[file] = signature;
      saveJson(stateFile, state);
    }
  }
}

function ingestOne(source, candidates) {
  counters.accepted += 1;
  const exactHash = feedBodyHash(source.body);
  const sketch = feedShingleSketch(source.body);
  const exact = candidates.find((candidate) => candidate.feed.fullBodyHash === exactHash);
  const nearby = candidates.filter((candidate) =>
    candidate.feed.sources?.some((entry) => entry.sourceKey === source.sourceKey && (
      (source.sourceItemId && entry.sourceItemId
        ? entry.sourceItemId === source.sourceItemId
        : source.url && entry.url === canonicalFeedUrl(source.url))
    )) || (Math.abs(Date.parse(candidate.published_at || candidate.fetched_at) - Date.parse(source.publishedAt || source.fetchedAt)) < 7 * 86400000
      && sketchesOverlap(sketch, candidate.feed.sketch))
  );
  const choice = exact ? { kind: 'repeat', candidate: exact } : classifyFeedItem(source, nearby);
  if (choice.kind === 'repeat') {
    counters.repeat += 1;
    addSourceReference(choice.candidate, source);
    return;
  }
  const body = choice.kind === 'update' ? choice.delta : source.body;
  const docId = `f_${createHash('sha256').update(`${source.identityKey}|${exactHash}`).digest('hex').slice(0, 24)}`;
  if (candidates.some((candidate) => candidate.doc_id === docId)) return;
  const storyKey = choice.kind === 'update' ? choice.candidate.feed.storyKey : docId;
  const content = prepareKnowledgeContent({ docId, markdown: body, remote: false, options: contentOptions });
  const feed = {
    version: 'v1', dedupeVersion: FEED_DEDUPE_VERSION,
    kind: choice.kind, storyKey,
    previousItemId: choice.kind === 'update' ? choice.candidate.doc_id : null,
    fullBodyHash: exactHash, sketch, entityCodes: source.entityCodes, originalFormat: 'text', contentType: source.contentType,
    sourceKey: source.sourceKey, sourceItemId: source.sourceItemId,
    sources: choice.kind === 'update'
      ? [...new Map([...(choice.candidate.feed.sources || []), sourceReference(source)].map((item) => [`${item.sourceKey}|${item.sourceItemId}|${item.url}`, item])).values()]
      : [sourceReference(source)],
  };
  const sortTime = choice.kind === 'update' ? source.fetchedAt : (source.publishedAt || source.fetchedAt);
  const now = Date.now();
  executeLocalD1Sql(`
    insert into knowledge_docs (doc_id,source_type,report_type,source_name,title,url,published_at,fetched_at,event_time,access_method,summary,content_preview,metadata_json,sort_time,source_name_normalized,updated_at)
    values (${q(docId)},'information_feed',${q(source.contentType)},${q(source.sourceName)},${q(source.title)},${q(source.url)},${q(source.publishedAt)},${q(source.fetchedAt)},${q(sortTime)},'markdown',${q(body.slice(0,600))},${q(body.slice(0,280))},${q(JSON.stringify({feed, informationExtraction: { storageVersion: INFORMATION_STORAGE_VERSION, status: 'pending', current: null, categoryCandidates: null }}))},${q(sortTime)},${q(source.sourceName.toLowerCase())},${now});
    insert into knowledge_doc_content_refs (doc_id,content_key,content_url,content_type,content_encoding,content_bytes,content_sha256,updated_at)
    values (${q(docId)},${q(content.contentKey)},${q(content.contentUrl)},${q(content.contentType)},${q(content.contentEncoding)},${content.contentBytes},${q(content.contentSha256)},${now});
  `, { requiredTable: 'knowledge_docs' });
  const candidate = { doc_id: docId, source_type: 'information_feed', source_name: source.sourceName,
    title: source.title, url: source.url, sourceKey: source.sourceKey, sourceItemId: source.sourceItemId,
    entityCodes: source.entityCodes,
    published_at: source.publishedAt, fetched_at: source.fetchedAt,
    body, content_key: content.contentKey, feed };
  candidates.push(candidate);
  counters[choice.kind] += 1;
}

async function tagPending() {
  const day = new Date().toISOString().slice(0, 10);
  const usage = loadJson(usageFile, { day, count: 0 });
  if (usage.day !== day) { usage.day = day; usage.count = 0; }
  const remainingToday = Math.max(0, Number(feedConfig.automation?.maxTagsPerDay || 200) - Number(usage.count || 0));
  const limit = Math.min(args.maxTags, remainingToday);
  if (!limit) return;
  const rows = recentFeedRows(loadFeedRows(), Date.now(), args.maxAgeHours)
    .filter((row) => !args.docId || row.doc_id === args.docId);
  const aliases = queryLocalD1Sql("select alias,code,name from knowledge_stock_aliases where length(alias)>=2", { requiredTable: 'knowledge_stock_aliases' });
  for (const row of rows) {
    if (counters.tagged + counters.tagFailed >= limit) break;
    if (!isRecentFeedTime(row.sort_time, Date.now(), args.maxAgeHours)) continue;
    const body = readLocalBody(row.content_key);
    if (!body) continue;
    const fingerprint = feedInputFingerprint(row, body, EXTRACTION_CONTRACT);
    if (!shouldAttemptExtraction(row.extraction, fingerprint, EXTRACTION_CONTRACT)) continue;
    const companyCandidates = feedCompanyCandidates(aliases, row.title, body, feedConfig.companyCandidates);
    const owner = randomUUID();
    const source = sourceExpectation(row, body);
    let claimed = false;
    try {
      claimed = claimExtraction(row.doc_id, { owner, fingerprint, source, contract: EXTRACTION_CONTRACT });
      if (!claimed) continue;
      usage.count += 1;
      saveJson(usageFile, usage);
      const promptValues = { CATEGORY_CATALOG: feedCategoryCatalog(), TITLE: row.title, SOURCE_TYPE: row.source_type,
        REPORT_TYPE: row.feed.contentType || '', PUBLISHED_AT: row.published_at || '', CONTENT: body.slice(0, 12000) };
      const input = INFORMATION_FEED_DOCUMENT_ANALYSIS_USER_PROMPT.replace(/\{\{([A-Z_]+)\}\}/g,
        (_match, key) => promptValues[key] ?? '');
      const response = await requestLocalDirectLlmText(process.env, {
        model: EXTRACTION_CONTRACT.model, instructions: INFORMATION_FEED_DOCUMENT_ANALYSIS_SYSTEM_PROMPT,
        input: [{ role: 'user', content: [{ type: 'input_text', text: input }] }], maxTokens: 2500,
      });
      if (response.raw?.model !== EXTRACTION_CONTRACT.model) throw new Error(`unexpected actual model: ${String(response.raw?.model || 'missing')}`);
      const { records, categoryCandidates } = parseFeedExtraction(response.text, promptValues.CONTENT);
      commitExtraction(row.doc_id, { owner, fingerprint, source, contract: EXTRACTION_CONTRACT,
        body, records, categoryCandidates, companyCandidates });
      counters.tagged += 1;
    } catch (error) {
      if (claimed) failExtraction(row.doc_id, { owner, error });
      counters.tagFailed += 1;
      console.error(`[information-feed] extraction failed ${row.doc_id}: ${String(error?.message || error)}`);
    }
  }
}

function loadFeedRows() {
  return queryLocalD1Sql(`select d.doc_id,d.source_type,d.source_name,d.title,d.url,d.published_at,d.fetched_at,d.sort_time,d.metadata_json,c.content_key
    from knowledge_docs d left join knowledge_doc_content_refs c on c.doc_id=d.doc_id
    where d.source_type='information_feed' order by d.sort_time desc,d.doc_id desc`, { requiredTable: 'knowledge_docs' })
    .map((row) => {
      const metadata = JSON.parse(row.metadata_json || '{}');
      const feed = metadata.feed || {};
      return { ...row, feed, extraction: metadata.informationExtraction, sourceKey: feed.sourceKey, sourceItemId: feed.sourceItemId, entityCodes: feed.entityCodes };
    });
}

function readLocalBody(key) {
  if (!key?.startsWith('knowledge-content/')) return '';
  const file = resolve(contentOptions.localContentDir, key.slice('knowledge-content/'.length));
  if (!existsSync(file)) return '';
  const data = readFileSync(file);
  return (key.endsWith('.br') ? brotliDecompressSync(data) : data).toString('utf8');
}

function addSourceReference(candidate, source) {
  const updated = mergeStorySourceReference(candidate.feed.storyKey, sourceReference(source));
  if (updated.has(candidate.doc_id)) candidate.feed.sources = updated.get(candidate.doc_id);
}

function sourceReference(source) {
  return { sourceKey: source.sourceKey, sourceItemId: source.sourceItemId, url: source.url,
    publishedAt: source.publishedAt, contentHash: feedBodyHash(source.body) };
}

function recentSourceFiles(days) {
  const root = process.env.INFORMATION_FEED_INPUT_DIR || '/Users/terry/git/data/news';
  const cutoff = Date.now() - days * 86400000;
  const result = [];
  function visit(dir) {
    if (!existsSync(dir)) return;
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, item.name);
      if (item.isDirectory()) visit(path);
      else if (item.isFile() && ['.json', '.jsonl'].includes(extname(item.name))) {
        const publishedDate = /\d{4}-\d{2}-\d{2}/.exec(path)?.[0];
        if (!publishedDate || Date.parse(publishedDate) >= cutoff) result.push(path);
      }
    }
  }
  visit(root);
  return result.sort((a, b) => b.localeCompare(a));
}

function parseSourceFile(file) {
  const body = readFileSync(file, 'utf8').trim();
  if (!body) return [];
  if (extname(file) === '.jsonl') {
    const items = body.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    return basename(file).startsWith('cls-telegraph-') ? items.reverse() : items;
  }
  const parsed = JSON.parse(body);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function fileSignature(file) {
  return createHash('sha256').update(basename(file).startsWith('cls-telegraph-') ? 'cls-newest-first-v2|' : '')
    .update(readFileSync(file)).digest('hex');
}

function loadJson(file, fallback) { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback; }
function saveJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`);
  renameSync(temporary, file);
}
function sha(value) { return createHash('sha256').update(value).digest('hex'); }
function q(value) { return value === null || value === undefined ? 'null' : `'${String(value).replaceAll("'", "''")}'`; }

function acquireLock(file) {
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(file, 'wx');
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => { try { unlinkSync(file); } catch { /* already removed */ } };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const pid = Number(readFileSync(file, 'utf8'));
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); throw new Error(`information feed runner is already active: pid=${pid}`); }
        catch (checkError) { if (checkError?.code !== 'ESRCH') throw checkError; }
      }
      unlinkSync(file);
    }
  }
  throw new Error('unable to acquire information feed lock');
}

function parseArgs(argv) {
  const result = { mode: 'run', file: '', docId: '', maxDocuments: 200, maxTags: 20, lookbackDays: 3, maxAgeHours: MAX_FEED_AGE_HOURS };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--mode') result.mode = argv[++i];
    else if (argv[i] === '--file') result.file = argv[++i];
    else if (argv[i] === '--doc-id') result.docId = argv[++i];
    else if (argv[i] === '--max-documents') result.maxDocuments = Number(argv[++i]);
    else if (argv[i] === '--max-tags') result.maxTags = Number(argv[++i]);
    else if (argv[i] === '--lookback-days') result.lookbackDays = Number(argv[++i]);
    else if (argv[i] === '--max-age-hours') result.maxAgeHours = Number(argv[++i]);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!['run', 'ingest', 'tag'].includes(result.mode) || (result.docId && (result.mode !== 'tag' || !/^f_[a-f0-9]{24}$/.test(result.docId)))
    || !Number.isInteger(result.maxDocuments) || result.maxDocuments < 1
    || !Number.isInteger(result.maxTags) || result.maxTags < 1 || !Number.isInteger(result.lookbackDays) || result.lookbackDays < 1
    || !Number.isInteger(result.maxAgeHours) || result.maxAgeHours < 1 || result.maxAgeHours > MAX_FEED_AGE_HOURS) throw new Error('invalid information feed arguments');
  return result;
}
