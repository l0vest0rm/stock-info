#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = parseArgs(process.argv.slice(2));
if (!args.file) {
  usage();
}

const now = Date.now();
const maxMarkdownChars = positiveInteger(process.env.KNOWLEDGE_IMPORT_MAX_MARKDOWN_CHARS, 30000);
const maxSearchTextChars = positiveInteger(process.env.KNOWLEDGE_IMPORT_MAX_SEARCH_TEXT_CHARS, 12000);
const maxSqlBatchBytes = positiveInteger(process.env.KNOWLEDGE_IMPORT_MAX_SQL_BATCH_BYTES, 700000);
const docs = loadDocs(args.file);
if (docs.length === 0) {
  throw new Error(`no knowledge docs found in ${args.file}`);
}

const batches = buildSqlBatches(docs.map((doc) => statementsForDoc(normalizeDoc(doc))));
let imported = 0;

for (let index = 0; index < batches.length; index += 1) {
  const sql = batches[index].statements.join("\n");
  const dir = mkdtempSync(join(tmpdir(), "stock-info-knowledge-import-"));
  const sqlFile = join(dir, "import.sql");
  try {
    writeFileSync(sqlFile, sql);
    executeWrangler(sqlFile);
    imported += batches[index].docs;
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

console.log(JSON.stringify({ imported, batches: batches.length, maxMarkdownChars }, null, 2));

function statementsForDoc(item) {
  return [
    `insert into knowledge_docs (
        doc_id, source_type, report_type, source_name, title, url, published_at, fetched_at,
        event_time, target_name, target_code, discovery_method, access_method, summary, md_text,
        search_text, metadata_json, recommendation_score, recommendation_level,
        recommendation_tags_json, recommendation_reasons_json, rank_score, source_weight, updated_at
      ) values (
        ${q(item.docId)}, ${q(item.sourceType)}, ${q(item.reportType)}, ${q(item.sourceName)},
        ${q(item.title)}, ${q(item.url)}, ${q(item.publishedAt)}, ${q(item.fetchedAt)},
        ${q(item.eventTime)}, ${q(item.targetName)}, ${q(item.targetCode)}, ${q(item.discoveryMethod)},
        ${q(item.accessMethod)}, ${q(item.summary)}, ${q(item.mdText)}, ${q(item.searchText)},
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
        md_text=excluded.md_text,
        search_text=excluded.search_text,
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

function buildSqlBatches(docStatements) {
  const batches = [];
  let current = [];
  let currentBytes = 0;
  let currentDocs = 0;
  for (const statements of docStatements) {
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

function parseArgs(argv) {
  const parsed = {
    database: "stock_info",
    file: "",
    remote: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--remote") {
      parsed.remote = true;
    } else if (arg === "--local") {
      parsed.remote = false;
    } else if (arg === "--database") {
      parsed.database = requireValue(argv, ++i, arg);
    } else if (arg === "--file") {
      parsed.file = requireValue(argv, ++i, arg);
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
  console.error("Usage: node scripts/import-knowledge-docs.mjs --file docs.jsonl [--remote] [--database stock_info]");
  process.exit(1);
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

function normalizeDoc(raw) {
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
  const mdText = truncate(rawMdText, maxMarkdownChars);
  const metadata = object(raw.metadata ?? raw.metadata_json);
  if (rawMdText.length > mdText.length) {
    metadata.markdownTruncated = true;
    metadata.originalMarkdownChars = rawMdText.length;
    metadata.importedMarkdownChars = mdText.length;
  }
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
    accessMethod: text(raw.accessMethod ?? raw.access_method ?? "markdown"),
    summary,
    mdText,
    searchText: truncate(text(raw.searchText ?? raw.search_text) || [title, summary, mdText.slice(0, 4000), tags.join(" ")].join(" "), maxSearchTextChars),
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

function truncate(value, max) {
  return value.length > max ? value.slice(0, max) : value;
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
