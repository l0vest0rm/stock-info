#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContentOptions, prepareKnowledgeContentAsync } from "./knowledge-content-r2.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.file) usage();

const now = Date.now();
const maxSqlBatchBytes = positiveInteger(process.env.KNOWLEDGE_IMPORT_MAX_SQL_BATCH_BYTES, 700000);
const contentOptions = buildContentOptions(args);
const rows = loadRows(args.file);
if (rows.length === 0) {
  console.log(JSON.stringify({ imported: 0, file: args.file }, null, 2));
  process.exit(0);
}

const normalizedRows = await mapWithConcurrency(rows, contentOptions.uploadConcurrency, async (row) => {
  const normalized = await normalizeRow(row);
  appendSyncEntries(buildSyncEntries([normalized], { hasD1: false, hasR2: Boolean(normalized.contentKey) }));
  return normalized;
});
const batches = buildSqlBatches(normalizedRows);
let imported = 0;

for (let index = 0; index < batches.length; index += 1) {
  const sql = batches[index].statements.join("\n");
  const dir = mkdtempSync(join(tmpdir(), "stock-info-filtered-import-"));
  const sqlFile = join(dir, "import-filtered.sql");
  try {
    writeFileSync(sqlFile, sql);
    executeWrangler(sqlFile);
    imported += batches[index].docs;
    appendImportResults(args.resultFile, buildImportResults(batches[index].items));
    appendSyncEntries(buildSyncEntries(batches[index].items, { hasD1: true, hasR2: true }));
    console.error(`[knowledge-filtered-import] imported batch ${index + 1}/${batches.length} docs=${batches[index].docs}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function executeWrangler(sqlFile) {
  try {
    execFileSync(
      "npx",
      [
        "wrangler",
        "d1",
        "execute",
        args.database,
        args.remote ? "--remote" : "--local",
        "--file",
        sqlFile,
      ],
      { stdio: "pipe", encoding: "utf8" }
    );
  } catch (err) {
    if (err.stdout) process.stderr.write(err.stdout);
    if (err.stderr) process.stderr.write(err.stderr);
    throw err;
  }
}

console.log(JSON.stringify({ imported, batches: batches.length, contentBucket: contentOptions.bucket }, null, 2));

function statementForRow(item) {
  return `insert into knowledge_filtered_docs (
      doc_id, source_type, report_type, source_name, title, url, published_at, fetched_at,
      event_time, target_name, target_code, summary,
      content_key, content_url, content_type, content_encoding, content_bytes, content_sha256,
      content_preview, metadata_json,
      filter_method, filter_score, filter_confidence, filter_reasons_json, source_file,
      reviewed_status, updated_at
    ) values (
      ${q(item.docId)}, ${q(item.sourceType)}, ${q(item.reportType)}, ${q(item.sourceName)},
      ${q(item.title)}, ${q(item.url)}, ${q(item.publishedAt)}, ${q(item.fetchedAt)},
      ${q(item.eventTime)}, ${q(item.targetName)}, ${q(item.targetCode)}, ${q(item.summary)},
      ${q(item.contentKey)}, ${q(item.contentUrl)}, ${q(item.contentType)}, ${q(item.contentEncoding)},
      ${item.contentBytes}, ${q(item.contentSha256)}, ${q(item.contentPreview)},
      ${q(JSON.stringify(item.metadata))}, ${q(item.filterMethod)},
      ${item.filterScore}, ${item.filterConfidence === null ? "null" : item.filterConfidence},
      ${q(JSON.stringify(item.filterReasons))}, ${q(item.sourceFile)}, ${q(item.reviewedStatus)},
      ${item.updatedAt}
    )
    on conflict(doc_id) do update set
      source_type=excluded.source_type,
      report_type=excluded.report_type,
      source_name=excluded.source_name,
      title=excluded.title,
      url=excluded.url,
      published_at=excluded.published_at,
      fetched_at=excluded.fetched_at,
      event_time=excluded.event_time,
      target_name=excluded.target_name,
      target_code=excluded.target_code,
      summary=excluded.summary,
      content_key=excluded.content_key,
      content_url=excluded.content_url,
      content_type=excluded.content_type,
      content_encoding=excluded.content_encoding,
      content_bytes=excluded.content_bytes,
      content_sha256=excluded.content_sha256,
      content_preview=excluded.content_preview,
      metadata_json=excluded.metadata_json,
      filter_method=excluded.filter_method,
      filter_score=excluded.filter_score,
      filter_confidence=excluded.filter_confidence,
      filter_reasons_json=excluded.filter_reasons_json,
      source_file=excluded.source_file,
      updated_at=excluded.updated_at;`;
}

function buildSqlBatches(items) {
  const batches = [];
  let current = [];
  let currentBytes = 0;
  let currentDocs = 0;
  let currentItems = [];
  for (const item of items) {
    const statements = [statementForRow(item)];
    const sql = statements.join("\n");
    const bytes = Buffer.byteLength(sql);
    if (current.length > 0 && currentBytes + bytes > maxSqlBatchBytes) {
      batches.push({ statements: current, docs: currentDocs, items: currentItems });
      current = [];
      currentBytes = 0;
      currentDocs = 0;
      currentItems = [];
    }
    current.push(...statements);
    currentBytes += bytes;
    currentDocs += 1;
    currentItems.push(item);
  }
  if (current.length > 0) {
    batches.push({ statements: current, docs: currentDocs, items: currentItems });
  }
  return batches;
}

async function normalizeRow(raw) {
  const doc = raw.doc || raw;
  const filter = raw.filter || raw.topic || {};
  const metadata = object(doc.metadata ?? doc.metadata_json);
  const rawMdText = text(doc.markdown ?? doc.mdText ?? doc.md_text);
  const docId = text(doc.docId ?? doc.doc_id ?? raw.docId ?? raw.doc_id);
  const content = await prepareKnowledgeContentAsync({
    docId,
    markdown: rawMdText,
    remote: args.remote,
    options: contentOptions,
  });
  return {
    docId,
    sourceType: text(doc.sourceType ?? doc.source_type ?? "research_report"),
    reportType: text(doc.reportType ?? doc.report_type ?? doc.sourceType ?? doc.source_type),
    sourceName: text(doc.sourceName ?? doc.source_name),
    title: text(doc.title),
    url: text(doc.url),
    publishedAt: text(doc.publishedAt ?? doc.published_at),
    fetchedAt: text(doc.fetchedAt ?? doc.fetched_at),
    eventTime: text(doc.eventTime ?? doc.event_time ?? doc.publishedAt ?? doc.published_at),
    targetName: text(doc.targetName ?? doc.target_name),
    targetCode: text(doc.targetCode ?? doc.target_code),
    summary: text(doc.summary),
    ...content,
    metadata,
    filterMethod: text(filter.method ?? raw.method),
    filterScore: integer(filter.score ?? raw.score, 0),
    filterConfidence: finiteNumber(filter.confidence ?? raw.confidence),
    filterReasons: array(filter.reasons ?? raw.reasons).map(text).filter(Boolean),
    sourceFile: text(raw.file ?? raw.sourceFile ?? raw.source_file),
    reviewedStatus: text(raw.reviewedStatus ?? raw.reviewed_status) || "pending",
    updatedAt: integer(raw.updatedAt ?? raw.updated_at, now),
  };
}

function parseArgs(argv) {
  const parsed = { database: "stock_info", file: "", remote: false, resultFile: "", syncFile: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--remote") parsed.remote = true;
    else if (arg === "--local") parsed.remote = false;
    else if (arg === "--database") parsed.database = requireValue(argv, ++i, arg);
    else if (arg === "--file") parsed.file = requireValue(argv, ++i, arg);
    else if (arg === "--content-bucket") parsed.contentBucket = requireValue(argv, ++i, arg);
    else if (arg === "--content-public-base-url") parsed.contentPublicBaseUrl = requireValue(argv, ++i, arg);
    else if (arg === "--result-file") parsed.resultFile = requireValue(argv, ++i, arg);
    else if (arg === "--sync-file") parsed.syncFile = requireValue(argv, ++i, arg);
    else if (!parsed.file) parsed.file = arg;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return parsed;
}

function loadRows(file) {
  const body = readFileSync(file, "utf8").trim();
  if (!body) return [];
  return body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value) throw new Error(`missing value for ${flag}`);
  return value;
}

function usage() {
  console.error("Usage: node scripts/import-filtered-knowledge-docs.mjs --file filtered.jsonl [--remote] [--database stock_info] [--content-bucket bucket] [--content-public-base-url url] [--result-file file.jsonl] [--sync-file file.jsonl]");
  process.exit(1);
}

function buildImportResults(items) {
  const importedAt = new Date().toISOString();
  return items.map((item) => ({
    scope: "knowledge_filtered_docs",
    docId: item.docId,
    database: args.database,
    target: args.remote ? "remote" : "local",
    importedAt,
    sourceFile: item.sourceFile || text(item.metadata?.inputRelativeFile),
    sourceMtimeMs: integer(item.metadata?.sourceMtimeMs, 0),
    sourceSize: integer(item.metadata?.sourceSize, 0),
    contentKey: item.contentKey,
    contentUrl: item.contentUrl,
    contentType: item.contentType,
    contentEncoding: item.contentEncoding,
    contentBytes: item.contentBytes,
    contentSha256: item.contentSha256,
    contentBucket: contentOptions.bucket,
    hasD1: true,
    hasR2: Boolean(item.contentKey),
  }));
}

function appendImportResults(file, entries) {
  if (!file || entries.length === 0) {
    return;
  }
  writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { flag: "a" });
}

function buildSyncEntries(items, overrides = {}) {
  const importedAt = new Date().toISOString();
  return items.map((item) => ({
    scope: "knowledge_filtered_docs",
    docId: item.docId,
    database: args.database,
    target: args.remote ? "remote" : "local",
    importedAt,
    sourceFile: item.sourceFile || text(item.metadata?.inputRelativeFile),
    sourceMtimeMs: integer(item.metadata?.sourceMtimeMs, 0),
    sourceSize: integer(item.metadata?.sourceSize, 0),
    contentKey: item.contentKey,
    contentUrl: item.contentUrl,
    contentType: item.contentType,
    contentEncoding: item.contentEncoding,
    contentBytes: item.contentBytes,
    contentSha256: item.contentSha256,
    contentBucket: contentOptions.bucket,
    hasD1: false,
    hasR2: Boolean(item.contentKey),
    ...overrides,
  }));
}

function appendSyncEntries(entries) {
  if (!args.syncFile || entries.length === 0) {
    return;
  }
  writeFileSync(args.syncFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { flag: "a" });
}

function text(value) {
  return String(value ?? "").trim();
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function object(value) {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function integer(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
      if ((index + 1) % 25 === 0 || index + 1 === items.length) {
        console.error(`[knowledge-filtered-import] prepared content ${index + 1}/${items.length}`);
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function q(value) {
  if (value === null || value === undefined || value === "") return "null";
  return `'${String(value).replaceAll("'", "''")}'`;
}
