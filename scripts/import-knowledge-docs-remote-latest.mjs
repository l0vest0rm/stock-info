#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { loadKnowledgeDefaults } from "./knowledge-defaults.mjs";

if (process.argv.length > 2) {
  throw new Error("import-knowledge-docs-remote-latest.mjs does not accept arguments");
}

const defaults = loadKnowledgeDefaults();
const workFiles = listWorkFiles(defaults.workDir, "knowledge-import-");
const latest = workFiles[workFiles.length - 1];
const stamp = latest.basename.replace(/^knowledge-import-/, "").replace(/\.jsonl$/, "");
const resultFile = join(defaults.workDir, `knowledge-import-result-${stamp}.json`);
const tempDir = mkdtempSync(join(tmpdir(), "stock-info-knowledge-import-remote-latest-"));
const mergedFile = join(tempDir, `knowledge-import-remote-pending-${stamp}.jsonl`);

try {
  const mergedDocs = collectLatestDocs(workFiles);
  const filteredDocs = filterDocsForRemoteImport(mergedDocs, defaults.config);
  writeFileSync(mergedFile, `${filteredDocs.map((doc) => JSON.stringify(doc)).join("\n")}\n`);
  console.error(
    `[knowledge-import] collected manifests=${workFiles.length} mergedDocs=${mergedDocs.length} pendingRemoteWindow=${filteredDocs.length} latest=${latest.basename}`
  );

  execFileSync(
    process.execPath,
    [
      new URL("./import-knowledge-docs-remote.mjs", import.meta.url).pathname,
      "--file",
      mergedFile,
      "--result-file",
      resultFile,
      "--sync-file",
      defaults.importSyncFile,
      "--database",
      defaults.database,
    ],
    { stdio: "inherit" }
  );
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

function listWorkFiles(workDir, prefix) {
  const names = readdirSync(workDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".jsonl"))
    .sort();
  if (names.length === 0) {
    throw new Error(`no ${prefix}*.jsonl files found in ${workDir}`);
  }
  return names.map((name) => {
    const file = join(workDir, name);
    return {
      file,
      basename: basename(file),
      mtimeMs: statSync(file).mtimeMs,
    };
  });
}

function collectLatestDocs(workFiles) {
  const docsByKey = new Map();
  for (const workFile of workFiles) {
    const docs = loadDocs(workFile.file);
    for (let index = 0; index < docs.length; index += 1) {
      const doc = docs[index];
      docsByKey.set(docKey(doc, workFile.basename, index), doc);
    }
  }
  return [...docsByKey.values()];
}

function loadDocs(file) {
  const body = readFileSync(file, "utf8").trim();
  if (!body) {
    return [];
  }
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function filterDocsForRemoteImport(docs, config) {
  const retention = object(config.remoteImportRetention);
  const newsMaxAgeDays = positiveInteger(retention.newsMaxAgeDays, 14);
  const reportMaxAgeDays = positiveInteger(retention.reportMaxAgeDays, 30);
  const now = Date.now();
  return docs.filter((doc) => {
    const kind = classifyDocKind(doc);
    const maxAgeDays = kind === "report" ? reportMaxAgeDays : newsMaxAgeDays;
    const timeMs = docTimeMs(doc);
    if (timeMs <= 0) {
      return true;
    }
    return now - timeMs <= maxAgeDays * 86400000;
  });
}

function classifyDocKind(doc) {
  const sourceType = text(doc.sourceType ?? doc.source_type);
  const reportType = text(doc.reportType ?? doc.report_type);
  if (sourceType === "research_report") {
    return "report";
  }
  if (reportType === "company_report" || reportType === "industry_report" || reportType === "research_report") {
    return "report";
  }
  return "news";
}

function docTimeMs(doc) {
  const candidates = [
    doc.eventTime,
    doc.event_time,
    doc.publishedAt,
    doc.published_at,
    doc.fetchedAt,
    doc.fetched_at,
  ];
  for (const candidate of candidates) {
    const ms = Date.parse(text(candidate));
    if (Number.isFinite(ms) && ms > 0) {
      return ms;
    }
  }
  return 0;
}

function docKey(doc, basename, index) {
  const docId = text(doc.docId ?? doc.doc_id ?? doc.id);
  if (docId) {
    return `doc:${docId}`;
  }
  return `raw:${basename}:${index}`;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function object(value) {
  return value && typeof value === "object" ? value : {};
}

function text(value) {
  return String(value ?? "").trim();
}
