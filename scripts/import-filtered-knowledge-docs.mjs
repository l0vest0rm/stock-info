#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = parseArgs(process.argv.slice(2));
if (!args.file) usage();

const now = Date.now();
const maxMarkdownChars = positiveInteger(process.env.KNOWLEDGE_IMPORT_MAX_MARKDOWN_CHARS, 30000);
const maxSqlBatchBytes = positiveInteger(process.env.KNOWLEDGE_IMPORT_MAX_SQL_BATCH_BYTES, 700000);
const rows = loadRows(args.file);
if (rows.length === 0) {
  console.log(JSON.stringify({ imported: 0, file: args.file }, null, 2));
  process.exit(0);
}

const batches = buildSqlBatches(rows.map((row) => [statementForRow(normalizeRow(row))]));
let imported = 0;

for (let index = 0; index < batches.length; index += 1) {
  const sql = batches[index].statements.join("\n");
  const dir = mkdtempSync(join(tmpdir(), "stock-info-filtered-import-"));
  const sqlFile = join(dir, "import-filtered.sql");
  try {
    writeFileSync(sqlFile, sql);
    executeWrangler(sqlFile);
    imported += batches[index].docs;
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

console.log(JSON.stringify({ imported, batches: batches.length, maxMarkdownChars }, null, 2));

function statementForRow(item) {
  return `insert into knowledge_filtered_docs (
      doc_id, source_type, report_type, source_name, title, url, published_at, fetched_at,
      event_time, target_name, target_code, summary, md_text, metadata_json,
      filter_method, filter_score, filter_confidence, filter_reasons_json, source_file,
      reviewed_status, updated_at
    ) values (
      ${q(item.docId)}, ${q(item.sourceType)}, ${q(item.reportType)}, ${q(item.sourceName)},
      ${q(item.title)}, ${q(item.url)}, ${q(item.publishedAt)}, ${q(item.fetchedAt)},
      ${q(item.eventTime)}, ${q(item.targetName)}, ${q(item.targetCode)}, ${q(item.summary)},
      ${q(item.mdText)}, ${q(JSON.stringify(item.metadata))}, ${q(item.filterMethod)},
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
      md_text=excluded.md_text,
      metadata_json=excluded.metadata_json,
      filter_method=excluded.filter_method,
      filter_score=excluded.filter_score,
      filter_confidence=excluded.filter_confidence,
      filter_reasons_json=excluded.filter_reasons_json,
      source_file=excluded.source_file,
      updated_at=excluded.updated_at;`;
}

function buildSqlBatches(rowStatements) {
  const batches = [];
  let current = [];
  let currentBytes = 0;
  let currentDocs = 0;
  for (const statements of rowStatements) {
    const sql = statements.join("\n");
    const bytes = Buffer.byteLength(sql);
    if (current.length > 0 && currentBytes + bytes > maxSqlBatchBytes) {
      batches.push({ statements: current, docs: currentDocs });
      current = [];
      currentBytes = 0;
      currentDocs = 0;
    }
    current.push(...statements);
    currentBytes += bytes;
    currentDocs += 1;
  }
  if (current.length > 0) {
    batches.push({ statements: current, docs: currentDocs });
  }
  return batches;
}

function normalizeRow(raw) {
  const doc = raw.doc || raw;
  const filter = raw.filter || raw.topic || {};
  const metadata = object(doc.metadata ?? doc.metadata_json);
  const rawMdText = text(doc.markdown ?? doc.mdText ?? doc.md_text);
  const mdText = truncate(rawMdText, maxMarkdownChars);
  if (rawMdText.length > mdText.length) {
    metadata.markdownTruncated = true;
    metadata.originalMarkdownChars = rawMdText.length;
    metadata.importedMarkdownChars = mdText.length;
  }
  return {
    docId: text(doc.docId ?? doc.doc_id ?? raw.docId ?? raw.doc_id),
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
    mdText,
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
  const parsed = { database: "stock_info", file: "", remote: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--remote") parsed.remote = true;
    else if (arg === "--local") parsed.remote = false;
    else if (arg === "--database") parsed.database = requireValue(argv, ++i, arg);
    else if (arg === "--file") parsed.file = requireValue(argv, ++i, arg);
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
  console.error("Usage: node scripts/import-filtered-knowledge-docs.mjs --file filtered.jsonl [--remote] [--database stock_info]");
  process.exit(1);
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

function truncate(value, max) {
  return value.length > max ? value.slice(0, max) : value;
}

function q(value) {
  if (value === null || value === undefined || value === "") return "null";
  return `'${String(value).replaceAll("'", "''")}'`;
}
