#!/usr/bin/env node

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { executeLocalD1SqlFile, queryLocalD1Sql, resolveLocalD1Database } from "./lib/local-d1-sqlite.mjs";
import { topicFilterBypassDecision, topicFilterKeywordDecision } from "./lib/knowledge-topic-filter.mjs";

const args = parseArgs(process.argv.slice(2));
if (args.remote) throw new Error("historical blacklist filtering is local-only; remote deletion is intentionally unsupported");

const root = resolve(".");
const configPath = resolve(root, args.config || "config/knowledge-processing.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const filter = config.topicFilter || {};
if (!filter.enabled || filter.mode !== "blacklist") {
  throw new Error("topicFilter must be enabled with mode=blacklist before filtering existing documents");
}

const databaseFile = resolveLocalD1Database({ root, requiredTable: "knowledge_docs" });
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const reviewDir = resolve(args.reviewDir || config.reviewDir || join(root, "data/knowledge/reviews"));
mkdirSync(reviewDir, { recursive: true });

const documents = loadDocuments(databaseFile);
const filtered = documents.flatMap((document) => {
  const bypass = topicFilterBypassDecision(document, filter);
  const decision = bypass || topicFilterKeywordDecision(document, filter);
  if (!decision.blocked) return [];
  return [{
    docId: document.docId,
    sourceType: document.sourceType,
    reportType: document.reportType,
    sourceName: document.sourceName,
    title: document.title,
    url: document.url,
    publishedAt: document.publishedAt,
    eventTime: document.eventTime,
    tags: document.tags,
    filter: {
      mode: filter.mode,
      name: filter.name || "",
      ruleVersion: filter.ruleVersion || "",
      score: decision.score,
      reasons: decision.reasons,
    },
  }];
});

const logFile = join(reviewDir, `historical-blacklist-filter-${stamp}.jsonl`);
const summaryFile = join(reviewDir, `historical-blacklist-filter-${stamp}.json`);
writeFileSync(logFile, filtered.length ? `${filtered.map((row) => JSON.stringify(row)).join("\n")}\n` : "");
const summary = summarize(documents, filtered, { configPath, databaseFile, logFile, applied: Boolean(args.apply) });
writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);

if (args.apply && filtered.length > 0) {
  deleteDocuments(databaseFile, filtered.map((row) => row.docId));
}

console.log(JSON.stringify({ ...summary, summaryFile }, null, 2));

function loadDocuments(database) {
  const rows = queryJson(database, `
    select d.doc_id, d.source_type, d.report_type, d.source_name, d.title, d.url, d.published_at, d.event_time,
           d.summary, d.metadata_json, coalesce(json_group_array(t.tag), '[]') as tags_json
      from knowledge_docs d
      left join knowledge_doc_tags t on t.doc_id = d.doc_id
     group by d.doc_id
     order by d.doc_id
  `);
  return rows.map((row) => ({
    docId: text(row.doc_id),
    sourceType: text(row.source_type),
    reportType: text(row.report_type),
    sourceName: text(row.source_name),
    title: text(row.title),
    url: text(row.url),
    publishedAt: text(row.published_at),
    eventTime: text(row.event_time),
    summary: text(row.summary),
    tags: jsonArray(row.tags_json),
    metadata: jsonObject(row.metadata_json),
  }));
}

function deleteDocuments(databaseFile, docIds) {
  const tempDir = mkdtempSync(join(tmpdir(), "stock-info-historical-blacklist-"));
  const sqlFile = join(tempDir, "delete.sql");
  try {
    const values = chunk(docIds, 500)
      .map((ids) => `insert into historical_blacklist_doc_ids (doc_id) values ${ids.map((id) => `(${sqlString(id)})`).join(", ")};`)
      .join("\n");
    const selectedDocs = "select doc_id from historical_blacklist_doc_ids";
    const selectedVersions = `select version_id from knowledge_document_versions where doc_id in (${selectedDocs})`;
    const selectedRuns = `select run_id from knowledge_processing_runs where version_id in (${selectedVersions})`;
    writeFileSync(sqlFile, `
      create temp table historical_blacklist_doc_ids (doc_id text primary key);
      ${values}
      delete from knowledge_information_records where result_id in (
        select result_id from knowledge_document_results where run_id in (${selectedRuns})
      );
      delete from knowledge_document_results where run_id in (${selectedRuns});
      delete from knowledge_processing_runs where run_id in (${selectedRuns});
      delete from knowledge_preprocessing_decisions where version_id in (${selectedVersions});
      delete from knowledge_document_versions where version_id in (${selectedVersions});
      delete from knowledge_docs where doc_id in (${selectedDocs});
    `);
    executeLocalD1SqlFile(sqlFile, { root, requiredTable: "knowledge_docs" });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function summarize(documents, filtered, context) {
  const byRule = countBy(filtered, (row) => row.filter.reasons.join("; "));
  const bySource = countBy(filtered, (row) => row.sourceType || "unknown");
  return {
    mode: filter.mode,
    ruleVersion: filter.ruleVersion || "",
    applied: context.applied,
    scanned: documents.length,
    filtered: filtered.length,
    filteredPct: documents.length ? Number((filtered.length / documents.length * 100).toFixed(3)) : 0,
    byRule,
    bySource,
    samples: filtered.slice(0, 20).map((row) => ({ docId: row.docId, title: row.title, reasons: row.filter.reasons })),
    configPath: context.configPath,
    databaseFile: context.databaseFile,
    logFile: context.logFile,
  };
}

function queryJson(databaseFile, sql) {
  return queryLocalD1Sql(sql, { path: databaseFile, requiredTable: "knowledge_docs", maxBuffer: 100 * 1024 * 1024 });
}

function countBy(rows, keyOf) {
  return Object.fromEntries([...rows.reduce((counts, row) => {
    const key = keyOf(row);
    counts.set(key, (counts.get(key) || 0) + 1);
    return counts;
  }, new Map()).entries()].sort(([left], [right]) => left.localeCompare(right, "zh-Hans-CN")));
}

function chunk(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function jsonObject(value) {
  try {
    const parsed = JSON.parse(text(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function jsonArray(value) {
  try {
    const parsed = JSON.parse(text(value));
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const [key, inline] = value.slice(2).split("=", 2);
    result[key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = inline ?? values[index + 1] ?? true;
    if (inline === undefined && result[key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] !== true) index += 1;
  }
  return result;
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function text(value) {
  return String(value ?? "").trim();
}
