#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContentOptions, prepareKnowledgeContentAsync } from "./knowledge-content-r2.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.file) {
  usage();
}
if (args.remote && !args.uploadContentRemote) {
  throw new Error("remote knowledge import requires --upload-content-remote; use scripts/import-knowledge-docs-remote.mjs");
}

const now = Date.now();
const maxSqlBatchBytes = positiveInteger(process.env.KNOWLEDGE_IMPORT_MAX_SQL_BATCH_BYTES, 700000);
const contentOptions = buildContentOptions(args);
const docs = loadDocs(args.file);
if (docs.length === 0) {
  throw new Error(`no knowledge docs found in ${args.file}`);
}
const syncTarget = { scope: "knowledge_docs", target: args.remote ? "remote" : "local", database: args.database };
const syncState = loadSyncState(args.syncFile, syncTarget);
const pendingDocs = [];
let skippedSynced = 0;
for (const doc of docs) {
  if (isDocAlreadySynced(doc, syncState, { requireR2: args.uploadContentRemote })) {
    skippedSynced += 1;
    continue;
  }
  pendingDocs.push(doc);
}
if (pendingDocs.length === 0) {
  console.log(JSON.stringify({ imported: 0, skippedSynced, batches: 0, contentBucket: contentOptions.bucket }, null, 2));
  process.exit(0);
}

const normalizedDocs = await mapWithConcurrency(pendingDocs, contentOptions.uploadConcurrency, async (doc) => {
  const normalized = await normalizeDoc(doc);
  appendSyncEntries(buildSyncEntries([normalized], { hasD1: false, hasR2: Boolean(normalized.contentKey) }));
  return normalized;
});
const batches = buildSqlBatches(normalizedDocs);
let imported = 0;

for (let index = 0; index < batches.length; index += 1) {
  const sql = batches[index].statements.join("\n");
  const dir = mkdtempSync(join(tmpdir(), "stock-info-knowledge-import-"));
  const sqlFile = join(dir, "import.sql");
  try {
    writeFileSync(sqlFile, sql);
    executeWrangler(sqlFile);
    imported += batches[index].docs;
    appendImportResults(args.resultFile, buildImportResults(batches[index].items));
    appendSyncEntries(buildSyncEntries(batches[index].items, { hasD1: true, hasR2: true }));
    console.error(`[knowledge-import] imported batch ${index + 1}/${batches.length} docs=${batches[index].docs}`);
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

console.log(JSON.stringify({ imported, skippedSynced, batches: batches.length, contentBucket: contentOptions.bucket }, null, 2));

function statementsForDoc(item) {
  return [
    `insert into knowledge_docs (
        doc_id, source_type, report_type, source_name, title, url, published_at, fetched_at,
        event_time, target_name, target_code, discovery_method, access_method, summary,
        content_key, content_url, content_type, content_encoding, content_bytes, content_sha256,
        content_preview, metadata_json, recommendation_score, recommendation_level,
        recommendation_tags_json, recommendation_reasons_json, rank_score, source_weight, updated_at
      ) values (
        ${q(item.docId)}, ${q(item.sourceType)}, ${q(item.reportType)}, ${q(item.sourceName)},
        ${q(item.title)}, ${q(item.url)}, ${q(item.publishedAt)}, ${q(item.fetchedAt)},
        ${q(item.eventTime)}, ${q(item.targetName)}, ${q(item.targetCode)}, ${q(item.discoveryMethod)},
        ${q(item.accessMethod)}, ${q(item.summary)}, ${q(item.contentKey)}, ${q(item.contentUrl)},
        ${q(item.contentType)}, ${q(item.contentEncoding)}, ${item.contentBytes}, ${q(item.contentSha256)},
        ${q(item.contentPreview)},
        ${q(JSON.stringify(item.metadata))}, ${item.recommendationScore}, ${q(item.recommendationLevel)},
        ${q(JSON.stringify(item.tags))}, ${q(JSON.stringify(item.recommendationReasons))},
        ${item.rankScore}, ${item.sourceWeight}, ${item.updatedAt}
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
        discovery_method=excluded.discovery_method,
        access_method=excluded.access_method,
        summary=excluded.summary,
        content_key=excluded.content_key,
        content_url=excluded.content_url,
        content_type=excluded.content_type,
        content_encoding=excluded.content_encoding,
        content_bytes=excluded.content_bytes,
        content_sha256=excluded.content_sha256,
        content_preview=excluded.content_preview,
        metadata_json=excluded.metadata_json,
        recommendation_score=excluded.recommendation_score,
        recommendation_level=excluded.recommendation_level,
        recommendation_tags_json=excluded.recommendation_tags_json,
        recommendation_reasons_json=excluded.recommendation_reasons_json,
        rank_score=excluded.rank_score,
        source_weight=excluded.source_weight,
        updated_at=excluded.updated_at;`,
    `delete from knowledge_doc_tags where doc_id = ${q(item.docId)};`,
    ...item.tags.map((tag) =>
      `insert into knowledge_doc_tags (doc_id, tag) values (${q(item.docId)}, ${q(tag.toLowerCase())});`
    ),
    ...item.stockAliases.map((alias) =>
      `insert into knowledge_stock_aliases (alias, code, name, source, updated_at)
         values (${q(alias.alias.toLowerCase())}, ${q(alias.code)}, ${q(alias.name)}, ${q(alias.source)}, ${item.updatedAt})
         on conflict(alias) do update set
           code=excluded.code,
           name=excluded.name,
           source=excluded.source,
           updated_at=excluded.updated_at;`
    ),
  ];
}

function buildSqlBatches(items) {
  const batches = [];
  let current = [];
  let currentBytes = 0;
  let currentDocs = 0;
  let currentItems = [];
  for (const item of items) {
    const statements = statementsForDoc(item);
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

function parseArgs(argv) {
  const parsed = {
    database: "stock_info",
    file: "",
    remote: false,
    uploadContentRemote: false,
    resultFile: "",
    syncFile: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--remote") {
      parsed.remote = true;
    } else if (arg === "--local") {
      parsed.remote = false;
    } else if (arg === "--upload-content-remote") {
      parsed.uploadContentRemote = true;
    } else if (arg === "--database") {
      parsed.database = requireValue(argv, ++i, arg);
    } else if (arg === "--file") {
      parsed.file = requireValue(argv, ++i, arg);
    } else if (arg === "--content-bucket") {
      parsed.contentBucket = requireValue(argv, ++i, arg);
    } else if (arg === "--content-public-base-url") {
      parsed.contentPublicBaseUrl = requireValue(argv, ++i, arg);
    } else if (arg === "--result-file") {
      parsed.resultFile = requireValue(argv, ++i, arg);
    } else if (arg === "--sync-file") {
      parsed.syncFile = requireValue(argv, ++i, arg);
    } else if (!parsed.file) {
      parsed.file = arg;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value) {
    throw new Error(`missing value for ${flag}`);
  }
  return value;
}

function usage() {
  console.error("Usage: node scripts/import-knowledge-docs.mjs --file docs.jsonl [--remote|--local] [--upload-content-remote] [--database stock_info] [--content-bucket bucket] [--content-public-base-url url] [--result-file file.jsonl] [--sync-file file.jsonl]");
  process.exit(1);
}

function buildImportResults(items) {
  const importedAt = new Date().toISOString();
  return items.map((item) => ({
    scope: "knowledge_docs",
    docId: item.docId,
    database: args.database,
    target: args.remote ? "remote" : "local",
    importedAt,
    sourceFile: text(item.metadata?.inputRelativeFile),
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
    scope: "knowledge_docs",
    docId: item.docId,
    database: args.database,
    target: args.remote ? "remote" : "local",
    importedAt,
    sourceFile: text(item.metadata?.inputRelativeFile),
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

function loadDocs(file) {
  const body = readFileSync(file, "utf8").trim();
  if (!body) {
    return [];
  }
  if (body.startsWith("[") || body.startsWith("{")) {
    try {
      const parsed = JSON.parse(body);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      // Fall through: JSONL files commonly start with "{" too.
    }
  }
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function loadSyncState(file, target) {
  const map = new Map();
  if (!file) {
    return map;
  }
  try {
    const body = readFileSync(file, "utf8");
    for (const line of body.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
      const entry = JSON.parse(line);
      if (text(entry.scope) !== target.scope || text(entry.target) !== target.target || text(entry.database) !== target.database) {
        continue;
      }
      const docId = text(entry.docId);
      if (!docId) {
        continue;
      }
      map.set(docId, entry);
    }
  } catch {
    return map;
  }
  return map;
}

function isDocAlreadySynced(raw, syncState, options = {}) {
  const docId = text(raw.docId ?? raw.doc_id ?? raw.id);
  if (!docId) {
    return false;
  }
  const entry = syncState.get(docId);
  if (!entry || !entry.hasD1) {
    return false;
  }
  if (options.requireR2 && !entry.hasR2) {
    return false;
  }
  return text(entry.sourceFile) === text(raw.metadata?.inputRelativeFile)
    && integer(entry.sourceMtimeMs, -1) === integer(raw.metadata?.sourceMtimeMs, -2)
    && integer(entry.sourceSize, -1) === integer(raw.metadata?.sourceSize, -2);
}

async function normalizeDoc(raw) {
  const docId = text(raw.docId ?? raw.doc_id ?? raw.id);
  const title = text(raw.title);
  if (!docId) {
    throw new Error("knowledge doc is missing docId/doc_id/id");
  }
  if (!title) {
    throw new Error(`knowledge doc ${docId} is missing title`);
  }
  const sourceType = text((raw.sourceType ?? raw.source_type) || "research_report");
  const reportType = text((raw.reportType ?? raw.report_type) || sourceType);
  const summary = text(raw.summary);
  const rawMdText = text(raw.mdText ?? raw.md_text ?? raw.markdown);
  const metadata = object(raw.metadata ?? raw.metadata_json);
  const content = await prepareKnowledgeContentAsync({
    docId,
    markdown: rawMdText,
    remote: args.remote,
    options: contentOptions,
  });
  const tags = unique(array(raw.tags).map(text));
  return {
    docId,
    sourceType,
    reportType,
    sourceName: text(raw.sourceName ?? raw.source_name),
    title,
    url: text(raw.url),
    publishedAt: text(raw.publishedAt ?? raw.published_at),
    fetchedAt: text(raw.fetchedAt ?? raw.fetched_at),
    eventTime: text(raw.eventTime ?? raw.event_time ?? raw.publishedAt ?? raw.published_at),
    targetName: text(raw.targetName ?? raw.target_name),
    targetCode: text(raw.targetCode ?? raw.target_code),
    discoveryMethod: text(raw.discoveryMethod ?? raw.discovery_method ?? "local_import"),
    accessMethod: content.contentKey ? "markdown" : text(raw.accessMethod ?? raw.access_method ?? "markdown"),
    summary,
    ...content,
    metadata,
    recommendationScore: integer(raw.recommendationScore ?? raw.recommendation_score, 0),
    recommendationLevel: text(raw.recommendationLevel ?? raw.recommendation_level),
    recommendationReasons: array(raw.recommendationReasons ?? raw.recommendation_reasons).map(text),
    tags,
    rankScore: integer(raw.rankScore ?? raw.rank_score ?? raw.recommendationScore ?? raw.recommendation_score, 0),
    sourceWeight: integer(raw.sourceWeight ?? raw.source_weight, 0),
    updatedAt: integer(raw.updatedAt ?? raw.updated_at, now),
    stockAliases: extractStockAliases({
      targetName: text(raw.targetName ?? raw.target_name),
      targetCode: text(raw.targetCode ?? raw.target_code),
      metadata,
    }),
  };
}

function extractStockAliases({ targetName, targetCode, metadata }) {
  const links = Array.isArray(metadata.stockLinks) ? metadata.stockLinks : [];
  const aliases = [];
  const push = (alias, code, name, source) => {
    const normalizedAlias = text(alias);
    const normalizedCode = text(code);
    if (!normalizedAlias || !normalizedCode) return;
    aliases.push({
      alias: normalizedAlias,
      code: normalizedCode,
      name: text(name),
      source: text(source) || "knowledge_import",
    });
  };
  push(targetName, targetCode, targetName, "target");
  push(targetCode, targetCode, targetName, "target");
  for (const link of links) {
    const derivedAliases = buildSecurityAliases(link?.name, link?.code, array(link?.aliases));
    push(link?.name, link?.code, link?.name, "doc_metadata");
    push(link?.code, link?.code, link?.name, "doc_metadata");
    for (const alias of derivedAliases) {
      push(alias, link?.code, link?.name, "doc_metadata");
    }
  }
  const seen = new Set();
  return aliases.filter((item) => {
    const key = `${item.alias.toLowerCase()}|${item.code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function text(value) {
  return String(value ?? "").trim();
}

function normalizeKnowledgeStockCode(value) {
  const raw = text(value).toUpperCase();
  if (!raw) return "";
  const usMatch = raw.match(/^US([A-Z0-9.-]+)\.(OQ|NQ|N|AMEX|PK|OB)$/);
  if (usMatch) {
    return `${usMatch[1]}.US`;
  }
  return raw;
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function object(value) {
  if (!value) {
    return {};
  }
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

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
      if ((index + 1) % 25 === 0 || index + 1 === items.length) {
        console.error(`[knowledge-import] prepared content ${index + 1}/${items.length}`);
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function securityBaseName(name) {
  return text(name)
    .replace(/\.(SH|SZ|US|HK|BJ|PT)$/i, "")
    .replace(/-(SW|W|B|S|R)$/i, "")
    .trim();
}

function stripSecuritySuffix(name) {
  return text(name)
    .replace(/(股份有限公司|集团有限公司|控股有限公司|科技有限公司|股份|集团|控股|科技)$/u, "")
    .trim();
}

function bareStockCode(value) {
  return text(value).split(".")[0];
}

function buildSecurityAliases(name, code, aliases = []) {
  const normalizedName = text(name);
  const normalizedCode = normalizeKnowledgeStockCode(code);
  const baseName = securityBaseName(normalizedName);
  const shortName = stripSecuritySuffix(baseName);
  return unique([
    normalizedName,
    normalizedCode,
    bareStockCode(normalizedCode),
    baseName,
    shortName,
    ...array(aliases).map(text),
  ]);
}

function q(value) {
  if (value === null || value === undefined || value === "") {
    return "null";
  }
  return `'${String(value).replaceAll("'", "''")}'`;
}
