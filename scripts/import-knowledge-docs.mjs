#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContentOptions, prepareKnowledgeContentAsync } from "./knowledge-content-r2.mjs";
import { loadLocalCompanyCodeResolver } from "./lib/local-company-code-resolver.mjs";
import { executeLocalD1SqlFile } from "./lib/local-d1-sqlite.mjs";
import {
  appendSyncLedgerEntries,
  compactSyncLedger,
  knowledgeImportFingerprint,
  legacySourceFingerprintMatches,
  loadSyncLedger,
  syncStateFor,
} from "./lib/knowledge-import-sync.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.file) {
  usage();
}
if (args.remote && !args.uploadContentRemote) {
  throw new Error("remote knowledge import requires --upload-content-remote; use scripts/import-knowledge-docs-remote.mjs");
}

const now = Date.now();
const maxSqlBatchBytes = positiveInteger(
  process.env.KNOWLEDGE_IMPORT_MAX_SQL_BATCH_BYTES,
  args.remote ? 700000 : 64000000
);
const maxLocalContentChunkChars = positiveInteger(process.env.KNOWLEDGE_IMPORT_LOCAL_CONTENT_CHUNK_CHARS, 20000);
const docChunkSize = positiveInteger(process.env.KNOWLEDGE_IMPORT_DOC_CHUNK_SIZE, args.remote ? 400 : 1000);
const contentOptions = buildContentOptions(args);
const localCompanyCodeResolver = loadLocalCompanyCodeResolver(process.cwd());
const docs = loadDocs(args.file);
if (docs.length === 0) {
  throw new Error(`no knowledge docs found in ${args.file}`);
}
const syncTarget = { scope: "knowledge_docs", target: args.remote ? "remote" : "local", database: args.database };
const syncLedger = loadSyncLedger(args.syncFile);
const syncState = syncStateFor(syncLedger.entries, syncTarget);
const pendingDocs = [];
const syncUpgrades = [];
let skippedSynced = 0;
for (const doc of docs) {
  const importFingerprint = knowledgeImportFingerprint(doc);
  const syncMatch = docSyncMatch(doc, syncState, importFingerprint, { requireR2: args.uploadContentRemote });
  if (syncMatch.matched) {
    skippedSynced += 1;
    if (syncMatch.legacy) {
      syncUpgrades.push({
        ...syncMatch.entry,
        importedAt: new Date().toISOString(),
        importFingerprint,
      });
    }
    continue;
  }
  pendingDocs.push({ raw: doc, importFingerprint });
}
if (pendingDocs.length === 0) {
  appendSyncLedgerEntries(args.syncFile, syncUpgrades);
  const syncCompaction = compactSyncLedger(args.syncFile);
  console.log(JSON.stringify({
    imported: 0,
    skippedSynced,
    batches: 0,
    syncUpgraded: syncUpgrades.length,
    syncCompaction,
    contentBucket: contentOptions.bucket,
  }, null, 2));
  process.exit(0);
}

let imported = 0;
let executedBatches = 0;
for (let offset = 0; offset < pendingDocs.length; offset += docChunkSize) {
  const chunk = pendingDocs.slice(offset, offset + docChunkSize);
  const normalizedDocs = await mapWithConcurrency(
    chunk,
    contentOptions.uploadConcurrency,
    async (candidate) => {
      const normalized = await normalizeDoc(candidate.raw);
      return { ...normalized, importFingerprint: candidate.importFingerprint };
    },
    { label: "knowledge-import", completed: offset, total: pendingDocs.length }
  );
  const batches = buildSqlBatches(normalizedDocs);
  for (let index = 0; index < batches.length; index += 1) {
    const sql = batches[index].statements.join("\n");
    const dir = mkdtempSync(join(tmpdir(), "stock-info-knowledge-import-"));
    const sqlFile = join(dir, "import.sql");
    try {
      writeFileSync(sqlFile, sql);
      executeD1SqlFile(sqlFile);
      imported += batches[index].docs;
      executedBatches += 1;
      appendImportResults(args.resultFile, buildImportResults(batches[index].items));
      appendSyncEntries(buildSyncEntries(batches[index].items));
      console.error(
        `[knowledge-import] imported batch docs=${batches[index].docs} imported=${imported}/${pendingDocs.length} d1Batches=${executedBatches}`
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

appendSyncLedgerEntries(args.syncFile, syncUpgrades);
const syncCompaction = compactSyncLedger(args.syncFile);

function executeD1SqlFile(sqlFile) {
  if (!args.remote) {
    executeLocalD1SqlFile(sqlFile, { requiredTable: "knowledge_docs" });
    return;
  }
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
      {
        stdio: ["ignore", "ignore", "pipe"],
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      }
    );
  } catch (err) {
    if (err.stderr) process.stderr.write(err.stderr);
    throw err;
  }
}

console.log(JSON.stringify({
  imported,
  skippedSynced,
  batches: executedBatches,
  chunkSize: docChunkSize,
  maxSqlBatchBytes,
  localExecutor: args.remote ? null : "sqlite-transaction",
  syncUpgraded: syncUpgrades.length,
  syncCompaction,
  contentBucket: contentOptions.bucket,
}, null, 2));

function statementsForDoc(item) {
  return [
    `insert into knowledge_docs (
        doc_id, source_type, report_type, source_name, title, url, published_at, fetched_at,
        event_time, target_name, target_code, discovery_method, access_method, summary,
        content_preview, metadata_json, recommendation_score, recommendation_level,
        recommendation_tags_json, recommendation_reasons_json, rank_score, source_weight,
        sort_time, source_name_normalized, target_code_normalized, updated_at
      ) values (
        ${q(item.docId)}, ${q(item.sourceType)}, ${q(item.reportType)}, ${q(item.sourceName)},
        ${q(item.title)}, ${q(item.url)}, ${q(item.publishedAt)}, ${q(item.fetchedAt)},
        ${q(item.eventTime)}, ${q(item.targetName)}, ${q(item.targetCode)}, ${q(item.discoveryMethod)},
        ${q(item.accessMethod)}, ${q(item.summary)}, ${q(item.contentPreview)},
        ${q(JSON.stringify(item.metadata))}, ${item.recommendationScore}, ${q(item.recommendationLevel)},
        ${q(JSON.stringify(item.tags))}, ${q(JSON.stringify(item.recommendationReasons))},
        ${item.rankScore}, ${item.sourceWeight}, ${qText(item.sortTime)},
        ${qText(item.sourceNameNormalized)}, ${qText(item.targetCodeNormalized)}, ${item.updatedAt}
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
        content_preview=excluded.content_preview,
        metadata_json=excluded.metadata_json,
        recommendation_score=excluded.recommendation_score,
        recommendation_level=excluded.recommendation_level,
        recommendation_tags_json=excluded.recommendation_tags_json,
        recommendation_reasons_json=excluded.recommendation_reasons_json,
        rank_score=excluded.rank_score,
        source_weight=excluded.source_weight,
        sort_time=excluded.sort_time,
        source_name_normalized=excluded.source_name_normalized,
        target_code_normalized=excluded.target_code_normalized,
        updated_at=excluded.updated_at;`,
    contentRefStatement("knowledge_doc_content_refs", item),
    securityLinkStatements(item),
    localContentCacheStatement(item),
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

function contentRefStatement(table, item) {
  if (!hasContentRef(item)) {
    return `delete from ${table} where doc_id = ${q(item.docId)};`;
  }
  return `insert into ${table} (
      doc_id, content_key, content_url, content_type, content_encoding, content_bytes, content_sha256, updated_at
    ) values (
      ${q(item.docId)}, ${q(item.contentKey)}, ${q(item.contentUrl)}, ${q(item.contentType)},
      ${q(item.contentEncoding)}, ${item.contentBytes}, ${q(item.contentSha256)}, ${item.updatedAt}
    )
    on conflict(doc_id) do update set
      content_key=excluded.content_key,
      content_url=excluded.content_url,
      content_type=excluded.content_type,
      content_encoding=excluded.content_encoding,
      content_bytes=excluded.content_bytes,
      content_sha256=excluded.content_sha256,
      updated_at=excluded.updated_at;`;
}

function localContentCacheStatement(item) {
  if (args.remote || args.uploadContentRemote) {
    return [
      `delete from knowledge_local_content_cache_chunks where content_key = ${q(item.contentKey)};`,
      `delete from knowledge_local_content_cache where content_key = ${q(item.contentKey)};`,
    ];
  }
  if (!text(item.contentKey) || !text(item.payloadBase64)) {
    return [
      `delete from knowledge_local_content_cache_chunks where content_key = ${q(item.contentKey)};`,
      `delete from knowledge_local_content_cache where content_key = ${q(item.contentKey)};`,
    ];
  }
  return [
    `delete from knowledge_local_content_cache_chunks where content_key = ${q(item.contentKey)};`,
    `insert into knowledge_local_content_cache (
      content_key, content_type, content_encoding, content_sha256, content_bytes, updated_at
    ) values (
      ${q(item.contentKey)}, ${q(item.contentType)}, ${q(item.contentEncoding)},
      ${q(item.contentSha256)}, ${item.contentBytes}, ${item.updatedAt}
    )
    on conflict(content_key) do update set
      content_type=excluded.content_type,
      content_encoding=excluded.content_encoding,
      content_sha256=excluded.content_sha256,
      content_bytes=excluded.content_bytes,
      updated_at=excluded.updated_at;`,
    ...buildLocalContentChunkStatements(item),
  ];
}

function securityLinkStatements(item) {
  return [
    `delete from knowledge_doc_security_links where doc_id = ${q(item.docId)};`,
    ...item.securityCodes.map((code) =>
      `insert into knowledge_doc_security_links (doc_id, code)
         values (${q(item.docId)}, ${q(code)})
         on conflict(doc_id, code) do nothing;`
    ),
  ];
}

function hasContentRef(item) {
  return Boolean(
    text(item.contentKey)
    || text(item.contentUrl)
    || text(item.contentSha256)
    || integer(item.contentBytes, 0) > 0
  );
}

function buildSqlBatches(items) {
  const batches = [];
  let current = [];
  let currentBytes = 0;
  let currentDocs = 0;
  let currentItems = [];
  for (const item of items) {
    const statements = statementsForDoc(item).flat();
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

function buildLocalContentChunkStatements(item) {
  const payloadBase64 = text(item.payloadBase64);
  if (!payloadBase64) {
    return [];
  }
  const statements = [];
  for (let index = 0; index < payloadBase64.length; index += maxLocalContentChunkChars) {
    const chunk = payloadBase64.slice(index, index + maxLocalContentChunkChars);
    statements.push(`insert into knowledge_local_content_cache_chunks (
        content_key, chunk_index, payload_base64
      ) values (
        ${q(item.contentKey)}, ${index / maxLocalContentChunkChars}, ${q(chunk)}
      )
      on conflict(content_key, chunk_index) do update set
        payload_base64=excluded.payload_base64;`);
  }
  return statements;
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
  const uploadedRemote = args.remote || args.uploadContentRemote;
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
    importFingerprint: item.importFingerprint,
    hasD1: true,
    hasR2: Boolean(uploadedRemote && text(item.contentKey)),
  }));
}

function appendImportResults(file, entries) {
  if (!file || entries.length === 0) {
    return;
  }
  writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { flag: "a" });
}

function buildSyncEntries(items) {
  const importedAt = new Date().toISOString();
  const uploadedRemote = args.remote || args.uploadContentRemote;
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
    importFingerprint: item.importFingerprint,
    hasD1: true,
    hasR2: Boolean(uploadedRemote && text(item.contentKey)),
  }));
}

function appendSyncEntries(entries) {
  appendSyncLedgerEntries(args.syncFile, entries);
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

function docSyncMatch(raw, syncState, importFingerprint, options = {}) {
  const docId = text(raw.docId ?? raw.doc_id ?? raw.id);
  if (!docId) {
    return { matched: false };
  }
  const entry = syncState.get(docId);
  if (!entry || !entry.hasD1) {
    return { matched: false };
  }
  if (options.requireR2 && !entry.hasR2) {
    return { matched: false };
  }
  if (text(entry.importFingerprint)) {
    return { matched: text(entry.importFingerprint) === importFingerprint, entry, legacy: false };
  }
  const matched = legacySourceFingerprintMatches(raw, entry);
  return { matched, entry, legacy: matched };
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
  const contentRemote = args.remote || args.uploadContentRemote;
  const sourceName = text(raw.sourceName ?? raw.source_name);
  const publishedAt = text(raw.publishedAt ?? raw.published_at);
  const fetchedAt = text(raw.fetchedAt ?? raw.fetched_at);
  const eventTime = text(raw.eventTime ?? raw.event_time ?? raw.publishedAt ?? raw.published_at);
  const targetName = text(raw.targetName ?? raw.target_name);
  const targetCode = resolveImportCompanyCode(raw.targetCode ?? raw.target_code, raw.targetName ?? raw.target_name);
  const content = await prepareKnowledgeContentAsync({
    docId,
    markdown: rawMdText,
    remote: contentRemote,
    options: contentOptions,
  });
  const tags = unique(array(raw.tags).map(text));
  return {
    docId,
    sourceType,
    reportType,
    sourceName,
    title,
    url: text(raw.url),
    publishedAt,
    fetchedAt,
    eventTime,
    targetName,
    targetCode,
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
    sortTime: firstNonEmpty(eventTime, publishedAt, fetchedAt),
    sourceNameNormalized: normalizeLower(sourceName),
    targetCodeNormalized: normalizeUpper(targetCode),
    updatedAt: integer(raw.updatedAt ?? raw.updated_at, now),
    stockAliases: extractStockAliases({
      targetName,
      targetCode,
      metadata,
    }),
    securityCodes: extractSecurityCodes({ targetCode, metadata }),
  };
}

function extractStockAliases({ targetName, targetCode, metadata }) {
  const links = Array.isArray(metadata.stockLinks) ? metadata.stockLinks : [];
  const aliases = [];
  const push = (alias, code, name, source) => {
    const normalizedAlias = text(alias);
    const normalizedCode = resolveImportCompanyCode(code, name);
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
    return normalizeSupportedCompanyCode(`${usMatch[1]}.US`);
  }
  const prefixedMatch = raw.match(/^(SH|SZ|BJ)(\d{6})$/);
  if (prefixedMatch) {
    return normalizeSupportedCompanyCode(`${prefixedMatch[2]}.${prefixedMatch[1]}`);
  }
  const hkPrefixedMatch = raw.match(/^HK(\d{5})$/);
  if (hkPrefixedMatch) {
    return normalizeSupportedCompanyCode(`${hkPrefixedMatch[1]}.HK`);
  }
  return normalizeSupportedCompanyCode(raw);
}

function normalizeSupportedCompanyCode(value) {
  const normalized = text(value).toUpperCase();
  return isSupportedCompanyCode(normalized) ? normalized : "";
}

function resolveImportCompanyCode(code, name = "") {
  const normalized = normalizeKnowledgeStockCode(code);
  if (normalized) {
    return normalized;
  }
  return localCompanyCodeResolver.resolveByName(name);
}

function isSupportedCompanyCode(value) {
  const normalized = text(value).toUpperCase();
  return /^\d{6}\.(SH|SZ|BJ)$/.test(normalized)
    || /^\d{5}\.HK$/.test(normalized)
    || /^[A-Z0-9.-]+\.US$/.test(normalized);
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

async function mapWithConcurrency(items, concurrency, mapper, progress = {}) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
      const completed = integer(progress.completed, 0) + index + 1;
      const total = integer(progress.total, items.length);
      if (completed % 25 === 0 || completed === total) {
        console.error(`[${text(progress.label) || "knowledge-import"}] prepared content ${completed}/${total}`);
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

function qText(value) {
  return `'${String(value ?? "").replaceAll("'", "''")}'`;
}

function extractSecurityCodes({ targetCode, metadata }) {
  const codes = [normalizeKnowledgeStockCode(targetCode)];
  const links = Array.isArray(metadata.stockLinks) ? metadata.stockLinks : [];
  for (const link of links) {
    codes.push(normalizeKnowledgeStockCode(link?.code));
  }
  return unique(codes);
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const normalized = text(value);
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

function normalizeLower(value) {
  return text(value).toLowerCase();
}

function normalizeUpper(value) {
  return text(value).toUpperCase();
}
