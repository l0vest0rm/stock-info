#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";

import { parseKnowledgeFilename } from "./lib/knowledge-filename-parser.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const args = parseArgs(process.argv.slice(2));
const databaseFile = args.dbFile || findLocalD1Database();
const rows = queryRows(databaseFile);
const updates = rows
  .map((row) => buildUpdate(row))
  .filter(Boolean);

if (updates.length === 0) {
  console.log(JSON.stringify({
    dryRun: args.dryRun,
    databaseFile,
    candidates: rows.length,
    updated: 0,
  }, null, 2));
  process.exit(0);
}

if (!args.dryRun) {
  const sqlFile = join(root, ".tmp-backfill-knowledge-pdf-metadata.sql");
  writeFileSync(sqlFile, renderSql(updates));
  try {
    execFileSync("sqlite3", [databaseFile, `.read ${sqlFile}`], { cwd: root, stdio: "inherit" });
  } finally {
    unlinkSync(sqlFile);
  }
}

console.log(JSON.stringify({
  dryRun: args.dryRun,
  databaseFile,
  candidates: rows.length,
  updated: updates.length,
  sample: updates.slice(0, 5),
}, null, 2));

function parseArgs(argv) {
  const parsed = {
    dryRun: true,
    dbFile: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") parsed.dryRun = false;
    else if (arg === "--dry-run") parsed.dryRun = true;
    else if (arg === "--db-file") parsed.dbFile = requireValue(argv, ++i, arg);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return parsed;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value) throw new Error(`missing value for ${flag}`);
  return value;
}

function findLocalD1Database() {
  const dir = resolve(root, ".wrangler/state/v3/d1/miniflare-D1DatabaseObject");
  if (!existsSync(dir)) {
    throw new Error(`local D1 directory not found: ${dir}`);
  }
  const candidates = readdirSync(dir)
    .filter((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite")
    .map((name) => join(dir, name));
  for (const file of candidates) {
    const tables = execFileSync("sqlite3", [file, ".tables"], { cwd: root, encoding: "utf8" });
    if (tables.includes("knowledge_docs")) {
      return file;
    }
  }
  throw new Error(`no local D1 sqlite file with knowledge_docs found under ${dir}`);
}

function queryRows(databaseFile) {
  const sql = [
    ".mode tabs",
    "select",
    "  doc_id,",
    "  coalesce(source_name, ''),",
    "  coalesce(title, ''),",
    "  coalesce(summary, ''),",
    "  coalesce(published_at, ''),",
    "  coalesce(fetched_at, ''),",
    "  coalesce(event_time, ''),",
    "  coalesce(target_name, ''),",
    "  coalesce(target_code, ''),",
    "  coalesce(report_type, ''),",
    "  coalesce(metadata_json, '')",
    "from knowledge_docs",
    "where source_type = 'research_report'",
    "  and discovery_method = 'local_process_once'",
    "  and coalesce(json_extract(metadata_json, '$.originalFile'), '') like '%.pdf';",
  ].join("\n");
  const output = execFileSync("sqlite3", [databaseFile], {
    cwd: root,
    encoding: "utf8",
    input: sql,
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
  if (!output) {
    return [];
  }
  return output.split("\n").map((line) => {
    const [docId, sourceName, title, summary, publishedAt, fetchedAt, eventTime, targetName, targetCode, reportType, metadataJson] = line.split("\t");
    return {
      docId,
      sourceName,
      title,
      summary,
      publishedAt,
      fetchedAt,
      eventTime,
      targetName,
      targetCode,
      reportType,
      metadata: parseJson(metadataJson),
    };
  });
}

function buildUpdate(row) {
  const originalFile = text(row.metadata.originalFile || row.metadata.inputFile);
  if (!originalFile) {
    return null;
  }
  const parsed = parseKnowledgeFilename(originalFile);
  const currentSourceName = text(row.sourceName);
  const currentTitle = text(row.title);
  const nextSourceName = shouldReplaceSourceName(currentSourceName) ? parsed.sourceName : currentSourceName;
  const nextPublishedAt = text(row.publishedAt) || parsed.publishedAt;
  const nextEventTime = chooseEventTime(row, parsed);
  const nextTargetName = text(row.targetName) || parsed.targetName;
  const nextTargetCode = text(row.targetCode) || parsed.targetCode;
  const nextReportType = shouldUpgradeReportType(text(row.reportType), parsed.reportType, nextTargetCode)
    ? (nextTargetCode ? "company_report" : parsed.reportType)
    : text(row.reportType);
  const nextTitle = shouldRewriteTitle(currentTitle, parsed) ? parsed.title : currentTitle;
  const nextSummary = shouldRewriteSummary(text(row.summary), currentTitle, parsed) ? parsed.title : text(row.summary);
  const nextMetadata = {
    ...row.metadata,
    filenameParse: {
      publishedAt: parsed.publishedAt,
      sourceName: parsed.sourceName,
      targetName: parsed.targetName,
      targetCode: parsed.targetCode,
      reportType: parsed.reportType,
    },
  };

  if (
    nextSourceName === currentSourceName
    && nextPublishedAt === text(row.publishedAt)
    && nextEventTime === text(row.eventTime)
    && nextTargetName === text(row.targetName)
    && nextTargetCode === text(row.targetCode)
    && nextReportType === text(row.reportType)
    && nextTitle === currentTitle
    && nextSummary === text(row.summary)
  ) {
    return null;
  }

  return {
    docId: row.docId,
    sourceName: nextSourceName,
    publishedAt: nextPublishedAt,
    eventTime: nextEventTime,
    targetName: nextTargetName,
    targetCode: nextTargetCode,
    reportType: nextReportType,
    title: nextTitle,
    summary: nextSummary,
    metadataJson: JSON.stringify(nextMetadata),
  };
}

function shouldReplaceSourceName(value) {
  const normalized = text(value).toLowerCase();
  return !normalized || normalized === "本地导入" || normalized === "local import";
}

function chooseEventTime(row, parsed) {
  const currentEventTime = text(row.eventTime);
  if (!parsed.publishedAt) {
    return currentEventTime;
  }
  if (!currentEventTime || currentEventTime === text(row.fetchedAt)) {
    return parsed.publishedAt;
  }
  return currentEventTime;
}

function shouldUpgradeReportType(currentReportType, parsedReportType, targetCode) {
  if (!parsedReportType) {
    return false;
  }
  if (!currentReportType || currentReportType === "research_report") {
    return parsedReportType !== "research_report" || Boolean(targetCode);
  }
  return false;
}

function shouldRewriteTitle(currentTitle, parsed) {
  const normalizedCurrent = normalizeText(currentTitle);
  return Boolean(parsed.title)
    && parsed.title !== currentTitle
    && (
      normalizedCurrent === normalizeText(parsed.normalizedStem)
      || normalizedCurrent === normalizeText(parsed.originalStem)
      || (parsed.publishedAt && normalizedCurrent.startsWith(parsed.publishedAt.replaceAll("-", "")))
    );
}

function shouldRewriteSummary(currentSummary, currentTitle, parsed) {
  const summary = text(currentSummary);
  return !summary
    || summary === currentTitle
    || normalizeText(summary) === normalizeText(parsed.normalizedStem);
}

function renderSql(updates) {
  const lines = ["begin immediate;"];
  for (const row of updates) {
    lines.push(
      `update knowledge_docs set`,
      `  source_name = ${sqlString(row.sourceName)},`,
      `  published_at = ${sqlString(row.publishedAt)},`,
      `  event_time = ${sqlString(row.eventTime)},`,
      `  target_name = ${sqlString(row.targetName)},`,
      `  target_code = ${sqlString(row.targetCode)},`,
      `  report_type = ${sqlString(row.reportType)},`,
      `  title = ${sqlString(row.title)},`,
      `  summary = ${sqlString(row.summary)},`,
      `  metadata_json = ${sqlString(row.metadataJson)}`,
      `where doc_id = ${sqlString(row.docId)};`
    );
  }
  lines.push("commit;");
  return `${lines.join("\n")}\n`;
}

function sqlString(value) {
  return `'${String(value ?? "").replaceAll("'", "''")}'`;
}

function parseJson(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function text(value) {
  return String(value ?? "").trim();
}
