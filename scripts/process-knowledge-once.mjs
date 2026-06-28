#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  SharedLlmClient,
  SQLiteLlmCacheStore,
  createResponsesProvider,
} from "@m2ai/shared-llm-client/sqlite";

const root = resolve(new URL("..", import.meta.url).pathname);
const sharedDataRoot = "/Users/terry/git/data";
const args = parseArgs(process.argv.slice(2));
const config = loadConfig(args.config);
const dbTarget = args.remote ?? envBoolean("KNOWLEDGE_PROCESS_REMOTE") ?? Boolean(config.remote);
const processedDir = resolve(root, config.processedDir || `${sharedDataRoot}/stock-info/knowledge/processed`);
const failedDir = resolve(root, config.failedDir || `${sharedDataRoot}/stock-info/knowledge/failed`);
const workDir = resolve(root, config.workDir || `${sharedDataRoot}/stock-info/knowledge/work`);
const reviewDir = resolve(root, config.reviewDir || `${sharedDataRoot}/stock-info/knowledge/reviews`);
const stateDir = resolve(root, config.stateDir || `${sharedDataRoot}/stock-info/knowledge/state`);
const inputDirs = resolveInputDirs(args.inboxDir, config, args.extraInputs);
const remotePdfCacheDir = join(workDir, "remote-pdf");
const markdownCacheDir = join(workDir, "markdown-cache");
const llmCacheDbPath = join(stateDir, "llm-cache.sqlite");
const llmReviewDir = join(reviewDir, "llm-topic-review");
const importSyncFile = resolve(stateDir, config.importSyncFile || "knowledge-remote-sync.jsonl");
const now = new Date();
const runId = formatRunTime(now);
const runStartedAt = Date.now();
const scanStartedAtMs = runStartedAt;
const archiveProcessed = args.archiveProcessed || envBoolean("KNOWLEDGE_PROCESS_ARCHIVE_PROCESSED") || false;
const disableAgeLimit = args.disableAgeLimit || envBoolean("KNOWLEDGE_PROCESS_DISABLE_AGE_LIMIT") || false;
const docProcessingConcurrency = Math.max(
  1,
  integer(process.env.KNOWLEDGE_PROCESS_DOC_CONCURRENCY ?? config.docProcessingConcurrency, 4)
);
const maxNewsAgeDays = disableAgeLimit
  ? 0
  : nonNegativeInteger(process.env.KNOWLEDGE_PROCESS_MAX_NEWS_DAYS ?? config.maxNewsAgeDays, 14);
const maxReportAgeDays = disableAgeLimit
  ? 0
  : nonNegativeInteger(process.env.KNOWLEDGE_PROCESS_MAX_REPORT_DAYS ?? config.maxReportAgeDays, 60);
const stateFile = resolve(stateDir, config.scanStateFile || "local-scan-state.json");
const scanState = loadScanState(stateFile);
const scanWatermark = args.fullRescan ? { ms: 0, source: "fullRescan" } : resolveScanWatermark(scanState);
const changedSinceMs = scanWatermark.ms;
let lastProcessedFile = "";
const importTarget = {
  target: dbTarget ? "remote" : "local",
  database: config.database || "stock_info",
};

for (const dir of [processedDir, failedDir, workDir, reviewDir, stateDir, remotePdfCacheDir, markdownCacheDir, llmReviewDir]) {
  mkdirSync(dir, { recursive: true });
}

const importSyncState = args.fullRescan ? new Map() : loadImportSyncState(importSyncFile, importTarget);
const inputScans = inputDirs.map((dir) => listInputFiles(dir, config, changedSinceMs));
const allFiles = inputScans.flatMap((scan) => scan.files);
const skippedByAge = inputScans.reduce((sum, scan) => sum + scan.skippedByAge, 0);
const skippedUnchangedFiles = inputScans.reduce((sum, scan) => sum + scan.skippedUnchangedFiles, 0);
const skippedUnchangedDirs = inputScans.reduce((sum, scan) => sum + scan.skippedUnchangedDirs, 0);
const files = allFiles.slice().sort();
if (files.length === 0 && inputDirs.length === 0) {
  throw new Error("missing input dirs: expected configured news/reports directories");
}
logProgress("discovered input files", {
  totalPending: allFiles.length,
  skippedByAge,
  skippedUnchangedFiles,
  skippedUnchangedDirs,
  selected: files.length,
  changedSince: changedSinceMs ? new Date(changedSinceMs).toISOString() : "",
  changedSinceSource: scanWatermark.source,
  maxNewsAgeDays,
  maxReportAgeDays,
  syncedDocs: importSyncState.size,
  ...countFilesByExtension(allFiles),
  inputDirs,
});
const results = [];
const fileBatches = [];
let skippedImportedDocs = 0;

let scannedFiles = 0;
for (const file of files) {
  scannedFiles += 1;
  if (scannedFiles === 1 || scannedFiles % 25 === 0 || extname(file).toLowerCase() === ".pdf") {
    logProgress("normalizing input", {
      current: scannedFiles,
      total: files.length,
      file: relativeInputPath(file),
    });
  }
  try {
    const fileDocs = await processInputFile(file, config);
    const currentSourceFingerprint = sourceFingerprint(file);
    const newDocs = fileDocs.filter((doc) => !isDocAlreadySynced(doc.docId, currentSourceFingerprint, importSyncState));
    const skipped = fileDocs.length - newDocs.length;
    skippedImportedDocs += skipped;
    if (skipped > 0) {
      logProgress("skipped synced docs", {
        file: relativeInputPath(file),
        skipped,
        remaining: newDocs.length,
      });
    }
    if (newDocs.length === 0) {
      archiveProcessedFile(file);
      results.push({ file, status: "skipped_synced", docs: 0, skippedExisting: skipped });
      lastProcessedFile = file;
      continue;
    }
    fileBatches.push({ file, docs: newDocs });
    lastProcessedFile = file;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeFileSync(`${file}.error.log`, `${message}\n`);
    moveToDir(file, failedDir);
    if (existsSync(`${file}.error.log`)) {
      moveToDir(`${file}.error.log`, failedDir);
    }
    results.push({ file, status: "failed", error: message });
    lastProcessedFile = file;
  }
}

logProgress("evaluating topic filter", {
  docs: fileBatches.reduce((sum, batch) => sum + batch.docs.length, 0),
});
const topicEvaluation = await evaluateTopics(fileBatches.flatMap((batch) => batch.docs), config);
const topicDecisions = topicEvaluation.decisions;
const docs = [];
let skippedByTopic = 0;
const topicReviewRows = [];
const filteredDocs = [];
const processedFilesToArchive = [];

let processedDocs = 0;
for (const batch of fileBatches) {
  try {
    const keptInputs = [];
    for (const rawDoc of batch.docs) {
      processedDocs += 1;
      const topic = topicDecisions.get(rawDoc.docId) || { keep: true, method: "missing", score: 0, reasons: [] };
      topicReviewRows.push(topicReviewRow(rawDoc, batch.file, topic));
      if (!topic.keep) {
        skippedByTopic += 1;
        filteredDocs.push(filteredDocRow(rawDoc, batch.file, topic));
        continue;
      }
      keptInputs.push({
        rawDoc,
        topic,
        current: processedDocs,
      });
    }
    const keptDocs = await mapWithConcurrency(keptInputs, docProcessingConcurrency, async ({ rawDoc, topic, current }) => {
      if (current === 1 || current % 25 === 0 || isPdfDoc(rawDoc)) {
        logProgress("processing kept doc", {
          current,
          title: rawDoc.title,
          accessMethod: rawDoc.accessMethod,
        });
      }
      const materializedDoc = await materializePdfIfNeeded(rawDoc, batch.file, config);
      const doc = await enrichWithLlmIfEnabled({
        ...materializedDoc,
        metadata: {
          ...materializedDoc.metadata,
          topicFilter: topic,
        },
      }, config);
      return withStockLinkMetadata(doc);
    });
    docs.push(...keptDocs);
    processedFilesToArchive.push(batch.file);
    lastProcessedFile = batch.file;
    results.push({ file: batch.file, status: "processed", docs: keptDocs.length, skipped: batch.docs.length - keptDocs.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeFileSync(`${batch.file}.error.log`, `${message}\n`);
    moveToDir(batch.file, failedDir);
    if (existsSync(`${batch.file}.error.log`)) {
      moveToDir(`${batch.file}.error.log`, failedDir);
    }
    results.push({ file: batch.file, status: "failed", error: message });
    lastProcessedFile = batch.file;
  }
}

const topicReview = writeTopicReview(topicReviewRows, config);
const llmTopicReview = writeLlmTopicReview(topicEvaluation.auditRows, config);
logProgress("topic filter done", {
  kept: docs.length,
  filtered: filteredDocs.length,
  review: topicReview.mdFile,
  llmReview: llmTopicReview.jsonlFile,
});
let filteredImported = 0;
const filteredReviewImportEnabled = envBoolean("KNOWLEDGE_FILTERED_IMPORT_ENABLED")
  ?? Boolean(config.filteredReviewImport?.enabled);
if (filteredDocs.length > 0 && filteredReviewImportEnabled) {
  const filteredImportFile = join(workDir, `knowledge-filtered-${formatRunTime(now)}.jsonl`);
  const filteredResultFile = join(workDir, `knowledge-filtered-result-${formatRunTime(now)}.json`);
  writeFileSync(filteredImportFile, `${filteredDocs.map((row) => JSON.stringify(row)).join("\n")}\n`);
  execFileSync(
    "npm",
    [
      "run",
      "import:knowledge:filtered",
      "--",
      "--file",
      filteredImportFile,
      "--result-file",
      filteredResultFile,
      "--sync-file",
      importSyncFile,
      dbTarget ? "--remote" : "--local",
      "--database",
      config.database || "stock_info",
    ],
    { cwd: root, stdio: "inherit" }
  );
  const filteredEntries = readImportResults(filteredResultFile);
  mergeImportSyncState(importSyncState, filteredEntries, importTarget);
  filteredImported = filteredDocs.length;
}
const uniqueDocs = uniqueByDocId(docs);
let imported = 0;
if (uniqueDocs.length > 0) {
  const importFile = join(workDir, `knowledge-import-${formatRunTime(now)}.jsonl`);
  const importResultFile = join(workDir, `knowledge-import-result-${formatRunTime(now)}.json`);
  writeFileSync(importFile, `${uniqueDocs.map((doc) => JSON.stringify(doc)).join("\n")}\n`);
  execFileSync(
    "npm",
    [
      "run",
      "import:knowledge:docs",
      "--",
      "--file",
      importFile,
      "--result-file",
      importResultFile,
      "--sync-file",
      importSyncFile,
      dbTarget ? "--remote" : "--local",
      "--database",
      config.database || "stock_info",
    ],
    { cwd: root, stdio: "inherit" }
  );
  const importedEntries = readImportResults(importResultFile);
  mergeImportSyncState(importSyncState, importedEntries, importTarget);
  imported = uniqueDocs.length;
}
const storageCleanup = pruneKnowledgeStorage(config);
const storageReport = runKnowledgeStorageReport(config);

for (const file of processedFilesToArchive) {
  archiveProcessedFile(file);
}

saveScanState(stateFile, {
  lastFile: lastProcessedFile || scanState.lastFile || "",
  lastRelativeFile: lastProcessedFile ? relativeInputPath(lastProcessedFile) : scanState.lastRelativeFile || "",
  lastCompletedScanStartedAtMs: scanStartedAtMs,
  lastCompletedScanStartedAt: new Date(scanStartedAtMs).toISOString(),
  completedAt: new Date().toISOString(),
});

console.log(JSON.stringify({
  inputDirs,
  database: config.database || "stock_info",
  remote: dbTarget,
  totalPending: allFiles.length,
  skippedByAge,
  skippedUnchangedFiles,
  skippedUnchangedDirs,
  selectedFiles: files.length,
  normalizedFiles: scannedFiles,
  skippedImportedDocs,
  changedSince: changedSinceMs ? new Date(changedSinceMs).toISOString() : "",
  changedSinceSource: scanWatermark.source,
  maxNewsAgeDays,
  maxReportAgeDays,
  nextScanWatermark: new Date(scanStartedAtMs).toISOString(),
  elapsedSeconds: Math.round((Date.now() - runStartedAt) / 1000),
  imported,
  filteredImported,
  filteredImportEnabled: filteredReviewImportEnabled,
  storageCleanup,
  storageReport,
  skippedByTopic,
  topicReview,
  filteredOutPreview: topicReview.filteredOutPreview,
  results: results.map((item) => ({
    file: basename(item.file),
    status: item.status,
    docs: item.docs || 0,
    skipped: item.skipped || 0,
    skippedExisting: item.skippedExisting || 0,
    error: item.error || undefined,
  })),
}, null, 2));

function runKnowledgeStorageReport(cfg) {
  try {
    execFileSync(
      "npm",
      [
        "run",
        "stats:knowledge:storage",
        "--",
        dbTarget ? "--remote" : "--local",
        "--database",
        cfg.database || "stock_info",
      ],
      { cwd: root, stdio: "inherit" }
    );
    return {
      ok: true,
      database: cfg.database || "stock_info",
      remote: dbTarget,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[knowledge-storage] failed to report storage stats: ${message}`);
    return {
      ok: false,
      database: cfg.database || "stock_info",
      remote: dbTarget,
      error: message,
    };
  }
}

async function processInputFile(file, cfg) {
  const ext = extname(file).toLowerCase();
  const fingerprint = sourceFingerprint(file);
  if (ext === ".json" || ext === ".jsonl") {
    return loadJsonDocs(file).map((item) => normalizeInputDoc(item, file, cfg, fingerprint));
  }
  if (ext === ".pdf") {
    return [normalizeInputDoc({
      title: titleFromFilename(file),
      sourceType: "research_report",
      reportType: "research_report",
      sourceName: cfg.defaultSourceName,
      accessMethod: "local_pdf_pending",
      summary: titleFromFilename(file),
      markdown: "",
      metadata: { originalFile: basename(file), pdfStored: false, localPdfPath: file },
      tags: ["pdf"],
    }, file, cfg, fingerprint)];
  }
  if (ext === ".md" || ext === ".txt") {
    const markdown = readFileSync(file, "utf8");
    return [normalizeInputDoc({
      title: titleFromMarkdown(markdown) || titleFromFilename(file),
      sourceType: cfg.defaultSourceType || "local_news",
      reportType: cfg.defaultReportType || "news",
      sourceName: cfg.defaultSourceName,
      accessMethod: "markdown",
      markdown,
      metadata: { originalFile: basename(file) },
    }, file, cfg, fingerprint)];
  }
  throw new Error(`unsupported input file: ${file}`);
}

function normalizeInputDoc(raw, file, cfg, fingerprint = sourceFingerprint(file)) {
  const normalizedRaw = normalizeRawInput(raw, file);
  const title = text(normalizedRaw.title) || titleFromFilename(file);
  const markdown = text(normalizedRaw.mdText ?? normalizedRaw.md_text ?? normalizedRaw.markdown ?? normalizedRaw.content ?? normalizedRaw.body);
  const summary = text(normalizedRaw.summary) || summarize(markdown);
  const sourceType = text((normalizedRaw.sourceType ?? normalizedRaw.source_type) || inferSourceType(normalizedRaw, file, cfg));
  const reportType = text((normalizedRaw.reportType ?? normalizedRaw.report_type) || inferReportType(sourceType, normalizedRaw, file));
  const baseTags = unique([
    ...array(normalizedRaw.tags).map(text),
    ...(extname(file).toLowerCase() === ".pdf" ? ["pdf"] : []),
  ]);
  const scoring = scoreDocument({
    title,
    summary,
    markdown,
    sourceType,
    reportType,
    tags: baseTags,
  }, cfg);
  const tags = unique([...baseTags, ...scoring.tags]);
  const recommendationScore = integer(normalizedRaw.recommendationScore ?? normalizedRaw.recommendation_score, scoring.score);
  return {
    docId: text(normalizedRaw.docId ?? normalizedRaw.doc_id ?? normalizedRaw.id) || makeDocId(normalizedRaw, file),
    sourceType,
    reportType,
    sourceName: text(normalizedRaw.sourceName ?? normalizedRaw.source_name) || cfg.defaultSourceName || "",
    title,
    url: text(normalizedRaw.url),
    publishedAt: text(normalizedRaw.publishedAt ?? normalizedRaw.published_at ?? normalizedRaw.date),
    fetchedAt: text(normalizedRaw.fetchedAt ?? normalizedRaw.fetched_at) || now.toISOString(),
    eventTime: text(normalizedRaw.eventTime ?? normalizedRaw.event_time ?? normalizedRaw.publishedAt ?? normalizedRaw.published_at ?? normalizedRaw.date),
    targetName: text(normalizedRaw.targetName ?? normalizedRaw.target_name),
    targetCode: text(normalizedRaw.targetCode ?? normalizedRaw.target_code),
    discoveryMethod: text(normalizedRaw.discoveryMethod ?? normalizedRaw.discovery_method) || "local_process_once",
    accessMethod: text(normalizedRaw.accessMethod ?? normalizedRaw.access_method) || "markdown",
    summary,
    markdown: truncate(markdown, integer(cfg.maxMarkdownChars, 120000)),
    tags,
    metadata: {
      ...object(normalizedRaw.metadata ?? normalizedRaw.metadata_json),
      processedAt: now.toISOString(),
      inputFile: basename(file),
      inputRelativeFile: fingerprint.sourceFile,
      sourceMtimeMs: fingerprint.sourceMtimeMs,
      sourceSize: fingerprint.sourceSize,
      pdfStored: false,
    },
    recommendationScore,
    recommendationLevel: "",
    recommendationReasons: array(normalizedRaw.recommendationReasons ?? normalizedRaw.recommendation_reasons).map(text).filter(Boolean).length > 0
      ? array(normalizedRaw.recommendationReasons ?? normalizedRaw.recommendation_reasons).map(text).filter(Boolean)
      : scoring.reasons,
    rankScore: integer(normalizedRaw.rankScore ?? normalizedRaw.rank_score, recommendationScore),
    sourceWeight: integer(normalizedRaw.sourceWeight ?? normalizedRaw.source_weight, 0),
  };
}

function normalizeRawInput(raw, file) {
  const ext = extname(file).toLowerCase();
  const contentObject = object(raw.content);
  const stockItems = array(raw.stockInfo ?? raw.stock_info);
  const stockNames = unique(stockItems.map((item) => text(item?.name)));
  const stockCodes = unique([
    ...stockItems.map((item) => text(item?.symbol)),
    ...array(raw.stock_codes).map(text),
  ]);
  const htmlBody = text(contentObject.text ?? raw.content_html);
  const body = text(raw.markdown ?? raw.mdText ?? raw.md_text ?? raw.body)
    || stripHtml(htmlBody)
    || text(raw.text);
  const publishedAt = normalizeDate(raw.publishedAt ?? raw.published_at ?? raw.publish_time ?? raw.time ?? raw.date);
  const isTencentNews = ext === ".json" && (raw.dedupe_title || raw.stockInfo || htmlBody);
  if (!isTencentNews) {
    return {
      ...raw,
      content: body || raw.content,
    };
  }
  const primaryTarget = resolveTencentPrimaryTarget(raw, stockItems);
  const sourceName = text(raw.sourceName ?? raw.source_name ?? raw.source) || "腾讯自选股";
  const title = text(raw.title ?? raw.dedupe_title);
  const dedupeBody = normalizeTencentNewsDedupeBody(body);
  return {
    ...raw,
    docId: text(raw.docId ?? raw.doc_id)
      || stableKnowledgeDocId(`tencent_stock_news|${sourceName}|${title}|${dedupeBody}`),
    title,
    sourceType: text(raw.sourceType ?? raw.source_type) || "local_news",
    reportType: text(raw.reportType ?? raw.report_type) || "news",
    sourceName,
    publishedAt,
    eventTime: publishedAt,
    targetName: primaryTarget.name,
    targetCode: primaryTarget.code,
    content: body,
    tags: unique(array(raw.tags).map(text)),
    metadata: {
      ...object(raw.metadata ?? raw.metadata_json),
      source: "tencent_stock_news",
      newsId: text(raw.id),
      dedupeSignature: stableKnowledgeDocId(`tencent_stock_news|${sourceName}|${title}|${dedupeBody}`),
      stockNames,
      stockCodes,
      originalFile: basename(file),
    },
  };
}

function resolveTencentPrimaryTarget(raw, stockItems) {
  const explicitName = text(raw.targetName ?? raw.target_name);
  const explicitCode = text(raw.targetCode ?? raw.target_code);
  if (explicitName || explicitCode) {
    return { name: explicitName, code: explicitCode };
  }
  const title = text(raw.title ?? raw.dedupe_title);
  const candidates = stockItems
    .map((item) => ({
      name: text(item?.name),
      code: text(item?.symbol),
    }))
    .filter((item) => item.name || item.code);
  if (candidates.length === 1 && isDirectSecurityCandidate(candidates[0])) {
    return candidates[0];
  }
  const titleMatched = candidates.find((item) => {
    const baseName = securityBaseName(item.name);
    return baseName && isDirectSecurityCandidate(item) && title.includes(baseName);
  });
  return titleMatched || { name: "", code: "" };
}

function isDirectSecurityCandidate(item) {
  const name = text(item.name);
  const code = text(item.code).toLowerCase();
  if (!name && !code) return false;
  if (code.startsWith("pt")) return false;
  return !/(ETF|LOF|QDII|概念|指数|板块|主题|基金)/i.test(name);
}

function securityBaseName(name) {
  return text(name)
    .replace(/\.(SH|SZ|US|HK|BJ|PT)$/i, "")
    .replace(/-(SW|W|B|S|R)$/i, "")
    .trim();
}

async function materializePdfIfNeeded(doc, file, cfg) {
  const url = text(doc.url);
  const accessMethod = text(doc.accessMethod ?? doc.access_method).toLowerCase();
  if (url && url.toLowerCase().includes(".pdf") && accessMethod.includes("remote_pdf")) {
    const pdfFile = await downloadRemotePdf(url, doc, cfg);
    const markdown = convertPdfToMarkdownCached(pdfFile, doc.docId || sha256(url), cfg);
    return withStockLinkMetadata({
      ...doc,
      accessMethod: "markdown_from_remote_pdf",
      markdown,
      summary: doc.summary || summarize(markdown),
      metadata: {
        ...doc.metadata,
        pdfStored: false,
        remotePdfMaterialized: true,
        remotePdfUrl: url,
        remotePdfWorkFile: basename(pdfFile),
      },
    });
  }
  if (accessMethod === "local_pdf_pending" || extname(file).toLowerCase() === ".pdf") {
    const markdown = convertPdfToMarkdownCached(file, doc.docId || sha256(file), cfg);
    return withStockLinkMetadata({
      ...doc,
      accessMethod: "markdown_from_local_pdf",
      markdown,
      summary: doc.summary || summarize(markdown),
      metadata: {
        ...doc.metadata,
        pdfStored: false,
        localPdfMaterialized: true,
      },
    });
  }
  return withStockLinkMetadata(doc);
}

async function downloadRemotePdf(url, doc, cfg) {
  const file = join(remotePdfCacheDir, `${safeFilename(doc.docId || sha256(url))}.pdf`);
  if (existsSync(file)) {
    const stat = statSync(file);
    if (stat.size >= 1000) {
      logProgress("reusing downloaded remote pdf", { title: doc.title, file: basename(file) });
      return file;
    }
  }
  logProgress("downloading remote pdf", { title: doc.title, url });
  const headers = {
    Referer: cfg.eastmoneyReports?.referer || "https://data.eastmoney.com/report/",
    "User-Agent": cfg.eastmoneyReports?.userAgent || "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
    Accept: "application/pdf,*/*",
  };
  const response = await fetch(url, { headers });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`remote pdf download failed: status=${response.status} url=${url} body=${body.slice(0, 200)}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 1000) {
    throw new Error(`remote pdf download is too small: bytes=${bytes.length} url=${url}`);
  }
  writeFileSync(file, bytes);
  return file;
}

function withStockLinkMetadata(doc) {
  const stockLinks = extractStockLinks(doc);
  return {
    ...doc,
    metadata: {
      ...doc.metadata,
      stockLinks,
    },
  };
}

function extractStockLinks(doc) {
  const metadata = object(doc.metadata);
  const links = [];
  const push = ({ code, name, aliases = [] }) => {
    const normalizedCode = normalizeStockCode(code);
    const normalizedName = text(name);
    if (!normalizedCode && !normalizedName) return;
    links.push({
      code: normalizedCode,
      name: normalizedName,
      aliases: buildSecurityAliases(normalizedName, normalizedCode, array(aliases).map(text)),
    });
  };
  push({ code: doc.targetCode, name: doc.targetName });
  const stockNames = array(metadata.stockNames);
  const stockCodes = array(metadata.stockCodes);
  for (let i = 0; i < Math.max(stockNames.length, stockCodes.length); i += 1) {
    push({ code: stockCodes[i], name: stockNames[i] });
  }
  const raw = object(metadata.raw);
  push({ code: raw.stockCode, name: raw.stockName });
  const seen = new Set();
  return links.filter((item) => {
    const key = `${item.code}|${item.name}`;
    if ((!item.code && !item.name) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function filteredDocRow(doc, file, topic) {
  return {
    doc: {
      ...doc,
      metadata: {
        ...doc.metadata,
        topicFilter: topic,
        stockLinks: extractStockLinks(doc),
      },
    },
    filter: topic,
    file: relativeInputPath(file),
  };
}

function loadJsonDocs(file) {
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
  return body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
}

function convertPdfToMarkdown(file, cfg) {
  const out = join(workDir, `${basename(file, extname(file))}.md`);
  const python = cfg.python || process.env.PYTHON_BIN || "python3";
  const code = `
import pathlib, sys
pdf = pathlib.Path(sys.argv[1])
out = pathlib.Path(sys.argv[2])
try:
    import pymupdf4llm
    text = pymupdf4llm.to_markdown(str(pdf))
except Exception:
    import fitz
    doc = fitz.open(str(pdf))
    pages = []
    for page in doc:
        pages.append(page.get_text("text"))
    text = "\\n\\n".join(pages)
out.write_text(text, encoding="utf-8")
`;
  const timeoutMs = integer(cfg.pdfConversionTimeoutMs, 120000);
  const result = spawnSync(python, ["-c", code, file, out], { encoding: "utf8", timeout: timeoutMs });
  if (result.error) {
    throw new Error(`pdf to markdown failed: ${result.error.message}`);
  }
  if (result.signal === "SIGTERM") {
    throw new Error(`pdf to markdown timed out after ${timeoutMs}ms: ${file}`);
  }
  if (result.status !== 0) {
    throw new Error(`pdf to markdown failed: ${result.stdout.trim()} ${result.stderr.trim()}`.trim());
  }
  return readFileSync(out, "utf8");
}

function convertPdfToMarkdownCached(file, cacheKey, cfg) {
  const sourceStat = statSync(file);
  const key = safeFilename(cacheKey || file);
  const mdFile = join(markdownCacheDir, `${key}.md`);
  const metaFile = join(markdownCacheDir, `${key}.json`);
  const sourceFingerprint = {
    file,
    basename: basename(file),
    mtimeMs: sourceStat.mtimeMs,
    size: sourceStat.size,
  };
  const cachedMeta = readJsonFile(metaFile);
  if (
    existsSync(mdFile)
    && cachedMeta
    && isMatchingMarkdownCacheMeta(cachedMeta, sourceFingerprint)
  ) {
    logProgress("reusing converted markdown", { file: basename(mdFile), source: relativeInputPath(file) });
    return readFileSync(mdFile, "utf8");
  }
  logProgress("converting pdf to markdown", { file: relativeInputPath(file), cacheKey: key });
  const markdown = convertPdfToMarkdown(file, cfg);
  writeFileSync(mdFile, markdown, "utf8");
  writeFileSync(metaFile, `${JSON.stringify(sourceFingerprint, null, 2)}\n`);
  return markdown;
}

function scoreDocument(doc, cfg) {
  let score = 0;
  const tags = [];
  const reasons = [];
  score += integer(cfg.sourceTypeScores?.[doc.sourceType], 0);
  score += integer(cfg.reportTypeScores?.[doc.reportType], 0);
  for (const tag of doc.tags) {
    score += integer(cfg.tagScores?.[tag], 0);
  }
  const haystack = `${doc.title}\n${doc.summary}\n${doc.markdown.slice(0, 8000)}`.toLowerCase();
  for (const signal of array(cfg.signals)) {
    const keywords = array(signal.keywords);
    if (keywords.some((keyword) => haystack.includes(text(keyword).toLowerCase()))) {
      score += integer(signal.score, 0);
      if (signal.tag) tags.push(text(signal.tag));
      if (signal.reason) reasons.push(text(signal.reason));
    }
  }
  return { score: Math.max(0, score), tags: unique(tags), reasons: unique(reasons) };
}

async function enrichWithLlmIfEnabled(doc, cfg) {
  const llm = cfg.llm || {};
  const enabled = envBoolean("KNOWLEDGE_PROCESS_LLM") ?? Boolean(llm.enabled);
  if (!enabled) {
    return doc;
  }
  const apiKey = process.env[llm.apiKeyEnv || "OPENAI_API_KEY"] || process.env.LLM_API_KEY;
  if (!apiKey) {
    throw new Error(`LLM is enabled but ${llm.apiKeyEnv || "OPENAI_API_KEY"} or LLM_API_KEY is missing`);
  }
  const baseUrl = (process.env.LLM_BASE_URL || llm.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
  const model = process.env.KNOWLEDGE_PROCESS_LLM_MODEL || llm.model || "gpt-5.4-mini";
  const content = truncate(doc.markdown || doc.summary || "", integer(llm.maxInputChars, 12000));
  const cacheKey = [
    "knowledge_enrich",
    model,
    doc.docId || "",
    sha256(JSON.stringify({
      title: doc.title,
      sourceType: doc.sourceType,
      reportType: doc.reportType,
      content,
    })),
  ].join("|");
  const llmResult = await requestLlmJsonCached(cacheKey, {
    baseUrl,
    apiKey,
    model,
    maxTokens: integer(llm.maxTokens, 1200),
    system: "你是金融研报和新闻结构化助手。只输出严格 JSON，不要 Markdown。",
    user: [
      "请从以下内容提取公开资讯展示字段。",
      "输出 JSON 字段：summary:string,tags:string[],recommendationScore:number,recommendationReasons:string[],targetName:string,targetCode:string。",
      "recommendationScore 取 0-100，面向公开研报资讯推荐质量，不做个性化。",
      `标题：${doc.title}`,
      `类型：${doc.sourceType}/${doc.reportType}`,
      "内容：",
      content,
    ].join("\n"),
  });
  const parsed = llmResult.response;
  const nextScore = integer(parsed.recommendationScore, doc.recommendationScore);
  return {
    ...doc,
    summary: text(parsed.summary) || doc.summary,
    tags: unique([...doc.tags, ...array(parsed.tags).map(text)]),
    targetName: text(parsed.targetName) || doc.targetName,
    targetCode: text(parsed.targetCode) || doc.targetCode,
    recommendationScore: nextScore,
    recommendationLevel: "",
    recommendationReasons: array(parsed.recommendationReasons).map(text).filter(Boolean).length > 0
      ? array(parsed.recommendationReasons).map(text).filter(Boolean)
      : doc.recommendationReasons,
    rankScore: nextScore,
    metadata: {
      ...doc.metadata,
      llmModel: model,
      llmProcessedAt: now.toISOString(),
    },
  };
}

async function evaluateTopics(docsToFilter, cfg) {
  const decisions = new Map();
  const auditRows = [];
  const filter = cfg.topicFilter || {};
  if (!filter.enabled) {
    for (const doc of docsToFilter) {
      decisions.set(doc.docId, { keep: true, method: "disabled", score: 0, reasons: [] });
    }
    return { decisions, auditRows };
  }
  const uncertainDocs = [];
  for (const doc of docsToFilter) {
    const local = evaluateTopicLocally(doc, filter);
    if (local.score >= integer(filter.minScore, 2)) {
      decisions.set(doc.docId, { keep: true, method: "local", ...local });
      continue;
    }
    const uncertain = local.score >= integer(filter.uncertainMinScore, 1)
      && local.score <= integer(filter.uncertainMaxScore, 1);
    if (uncertain) {
      uncertainDocs.push({ doc, local });
      continue;
    }
    decisions.set(doc.docId, { keep: false, method: "local", ...local });
  }

  const llmReviewEnabled = envBoolean("KNOWLEDGE_PROCESS_TOPIC_LLM") ?? Boolean(filter.llmReview);
  if (!llmReviewEnabled || uncertainDocs.length === 0) {
    for (const item of uncertainDocs) {
      decisions.set(item.doc.docId, { keep: false, method: "local", ...item.local });
    }
    return { decisions, auditRows };
  }

  const llm = cfg.llm || {};
  const apiKey = process.env[llm.apiKeyEnv || "VOLC_ARK_API_KEY"] || process.env.LLM_API_KEY;
  if (!apiKey) {
    for (const item of uncertainDocs) {
      decisions.set(item.doc.docId, { keep: false, method: "local_missing_llm_key", ...item.local });
    }
    return { decisions, auditRows };
  }

  const batchSize = Math.max(1, integer(filter.llmBatchSize, 50));
  for (let offset = 0; offset < uncertainDocs.length; offset += batchSize) {
    const batch = uncertainDocs.slice(offset, offset + batchSize);
    const batchItems = batch.map((item, index) => ({
      index,
      title: item.doc.title,
      summary: item.doc.summary,
      sourceType: item.doc.sourceType,
      reportType: item.doc.reportType,
      tags: item.doc.tags,
    }));
    const llmBatch = await reviewTopicBatchWithLlm(batchItems, cfg, {
      batchIndex: Math.floor(offset / batchSize),
      totalBatches: Math.ceil(uncertainDocs.length / batchSize),
    });
    const llmDecisions = llmBatch.decisions;
    for (const [index, item] of batch.entries()) {
      const result = llmDecisions.get(index);
      const confidence = Number(result?.confidence);
      const keep = Boolean(result?.isAi) && Number.isFinite(confidence)
        && confidence >= Number(filter.llmMinConfidence ?? 0.65);
      const decision = {
        keep,
        method: "llm_batch",
        score: item.local.score,
        reasons: [...item.local.reasons, text(result?.reason)].filter(Boolean),
        confidence: Number.isFinite(confidence) ? confidence : 0,
        model: process.env.KNOWLEDGE_PROCESS_LLM_MODEL || llm.model || "doubao-seed-2-0-mini-260215",
      };
      decisions.set(item.doc.docId, decision);
      auditRows.push({
        runId,
        batchIndex: llmBatch.batchIndex,
        totalBatches: llmBatch.totalBatches,
        promptVersion: "ai-topic-batch-v2",
        source: "topic_filter_uncertain",
        docId: item.doc.docId,
        title: item.doc.title,
        sourceType: item.doc.sourceType,
        reportType: item.doc.reportType,
        localScore: item.local.score,
        localReasons: item.local.reasons,
        llmModel: llmBatch.model,
        llmCached: llmBatch.cached,
        llmConfidence: Number.isFinite(confidence) ? confidence : 0,
        llmIsAi: Boolean(result?.isAi),
        llmReason: text(result?.reason),
        finalKeep: keep,
        finalMethod: decision.method,
        finalReasons: decision.reasons,
        input: batchItems[index],
        prompt: llmBatch.prompt,
        rawResult: result ?? null,
      });
    }
  }
  return { decisions, auditRows };
}

async function reviewTopicBatchWithLlm(items, cfg, context = {}) {
  const llm = cfg.llm || {};
  const apiKey = process.env[llm.apiKeyEnv || "VOLC_ARK_API_KEY"] || process.env.LLM_API_KEY;
  const model = process.env.KNOWLEDGE_PROCESS_LLM_MODEL || llm.model || "doubao-seed-2-0-mini-260215";
  const prompt = {
    system: "你是金融资讯主题分类器。只输出严格 JSON，不要 Markdown。",
    user: [
      "批量判断以下新闻或研报是否主要属于 AI 产业链。",
      "AI 产业链包括：大模型、AI应用、算力、GPU/ASIC/AI芯片、服务器、数据中心、存储/HBM/DRAM/NAND、半导体、先进封装、光模块/CPO/硅光、高速互联、液冷、电源、国产替代、PCB/AIPCB 等核心硬件与配套环节。",
      "只根据标题、摘要、类型和已有标签判断，不要扩展联想。",
      "输出 JSON：{\"items\":[{\"index\":number,\"isAi\":boolean,\"confidence\":number,\"reason\":string}]}。",
      "待判断列表：",
      JSON.stringify(items),
    ].join("\n"),
  };
  const request = {
    baseUrl: (process.env.LLM_BASE_URL || llm.baseUrl || "https://ark.cn-beijing.volces.com/api/v3").replace(/\/$/, ""),
    apiKey,
    model,
    maxTokens: Math.max(300, items.length * 80),
    ...prompt,
  };
  const cacheKey = sha256(JSON.stringify({
    kind: "topic-filter-llm-review",
    model,
    items,
    prompt,
  }));
  const cachedResponse = await requestLlmJsonCached(cacheKey, request);
  const parsed = cachedResponse.response;
  const decisions = new Map();
  for (const item of array(parsed.items)) {
    const index = Number(item?.index);
    if (Number.isInteger(index)) {
      decisions.set(index, item);
    }
  }
  return {
    decisions,
    model,
    cached: cachedResponse.cached,
    prompt,
    batchIndex: integer(context.batchIndex, 0),
    totalBatches: integer(context.totalBatches, 1),
  };
}

function evaluateTopicLocally(doc, filter) {
  const haystack = `${doc.title}\n${doc.summary}\n${doc.tags.join(" ")}\n${doc.markdown.slice(0, 12000)}`.toLowerCase();
  const matchedCore = matchedKeywords(haystack, filter.coreKeywords);
  const matchedSupport = matchedKeywords(haystack, filter.supportKeywords);
  const matchedDeny = matchedKeywords(haystack, filter.denyKeywords);
  const score = matchedCore.length * 2 + matchedSupport.length - matchedDeny.length * 2;
  const reasons = [
    ...matchedCore.map((item) => `核心:${item}`),
    ...matchedSupport.map((item) => `相关:${item}`),
    ...matchedDeny.map((item) => `排除:${item}`),
  ];
  return { score, reasons };
}

function matchedKeywords(haystack, keywords) {
  return unique(array(keywords).filter((keyword) => haystack.includes(text(keyword).toLowerCase())));
}

async function requestLlmJson({ baseUrl, apiKey, model, maxTokens, system, user }) {
  const provider = inferProvider(baseUrl, model);
  const client = getLocalLlmClient(provider, baseUrl, apiKey);
  const result = await client.generateText({
    provider,
    model,
    instructions: system,
    input: [{ role: "user", content: [{ type: "input_text", text: user }] }],
    temperature: 0,
    maxOutputTokens: maxTokens,
  });
  const parsed = parseJsonObjectFromText(result.text);
  if (!parsed) {
    throw new Error(`LLM response is not JSON: ${result.text.slice(0, 300)}`);
  }
  return { response: parsed, cached: result.cached };
}

async function requestLlmJsonCached(cacheKey, request) {
  const result = await requestLlmJson(request);
  if (result.cached) {
    logProgress("reusing llm cache", { cacheKey: safeFilename(cacheKey) });
  }
  return result;
}

function parseJsonObjectFromText(value) {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(value.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const localLlmClients = new Map();

function getLocalLlmClient(provider, baseUrl, apiKey) {
  const key = `${provider}::${baseUrl}::${apiKey}`;
  if (!localLlmClients.has(key)) {
    localLlmClients.set(
      key,
      new SharedLlmClient({
        cacheStore: new SQLiteLlmCacheStore(llmCacheDbPath),
        providers: {
          [provider]: createResponsesProvider({
            name: provider,
            baseUrl,
            apiKey,
          }),
        },
        providerConcurrency: { [provider]: 3 },
      }),
    );
  }
  return localLlmClients.get(key);
}

function inferProvider(baseUrl, model) {
  return model.startsWith("doubao-") || baseUrl.toLowerCase().includes("volces.com") || baseUrl.toLowerCase().includes("ark.")
    ? "doubao"
    : "openai";
}

function isPdfDoc(doc) {
  return String(doc.accessMethod || "").toLowerCase().includes("pdf")
    || String(doc.url || "").toLowerCase().includes(".pdf")
    || array(doc.tags).map(text).some((tag) => tag.toLowerCase() === "pdf");
}

function topicReviewRow(doc, file, topic) {
  return {
    keep: Boolean(topic.keep),
    title: doc.title,
    sourceType: doc.sourceType,
    reportType: doc.reportType,
    sourceName: doc.sourceName,
    targetName: doc.targetName,
    targetCode: doc.targetCode,
    publishedAt: doc.publishedAt,
    score: integer(topic.score, 0),
    method: text(topic.method),
    confidence: topic.confidence ?? undefined,
    reasons: array(topic.reasons).map(text).filter(Boolean),
    docId: doc.docId,
    file: relativeInputPath(file),
  };
}

function writeTopicReview(rows, cfg) {
  const jsonlFile = join(reviewDir, `topic-filter-${runId}.jsonl`);
  const mdFile = join(reviewDir, `topic-filter-${runId}.md`);
  const kept = rows.filter((row) => row.keep);
  const filteredOut = rows.filter((row) => !row.keep);
  writeFileSync(jsonlFile, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  writeFileSync(mdFile, [
    `# Topic Filter Review ${runId}`,
    "",
    `- kept: ${kept.length}`,
    `- filtered_out: ${filteredOut.length}`,
    "",
    "## Filtered Out",
    ...filteredOut.map((row) => `- ${row.title} | ${row.sourceType}/${row.reportType} | score=${row.score} | ${row.reasons.join("; ") || row.method}`),
    "",
    "## Kept",
    ...kept.map((row) => `- ${row.title} | ${row.sourceType}/${row.reportType} | score=${row.score} | ${row.reasons.join("; ") || row.method}`),
    "",
  ].join("\n"));
  return {
    jsonlFile,
    mdFile,
    kept: kept.length,
    filteredOut: filteredOut.length,
    filteredOutPreview: filteredOut
      .slice(0, integer(cfg.filterReviewPreviewLimit, 50))
      .map((row) => row.title),
  };
}

function writeLlmTopicReview(rows) {
  const jsonlFile = join(llmReviewDir, `topic-filter-llm-${runId}.jsonl`);
  if (rows.length === 0) {
    writeFileSync(jsonlFile, "");
    return { jsonlFile, rows: 0 };
  }
  writeFileSync(jsonlFile, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  return { jsonlFile, rows: rows.length };
}

function pruneKnowledgeStorage(cfg) {
  const retention = object(cfg.storageRetention);
  const filteredConfig = object(cfg.filteredReviewImport);
  const cleanup = {
    enabled: Boolean(retention.enabled),
    knowledgeDocsMaxAgeDays: integer(retention.knowledgeDocsMaxAgeDays, 0),
    filteredPurged: false,
  };
  const statements = [];
  if (filteredConfig.enabled === false && Boolean(filteredConfig.purgeExisting)) {
    statements.push("delete from knowledge_filtered_docs;");
    cleanup.filteredPurged = true;
  }
  const maxAgeDays = integer(retention.knowledgeDocsMaxAgeDays, 0);
  if (Boolean(retention.enabled) && maxAgeDays > 0) {
    const cutoffIso = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    cleanup.cutoffIso = cutoffIso;
    statements.push(
      `delete from knowledge_doc_tags where doc_id in (
        select doc_id from knowledge_docs
        where coalesce(event_time, published_at, fetched_at, '') != ''
          and datetime(coalesce(event_time, published_at, fetched_at)) < datetime('${cutoffIso}')
      );`
    );
    statements.push(
      `delete from knowledge_docs
        where coalesce(event_time, published_at, fetched_at, '') != ''
          and datetime(coalesce(event_time, published_at, fetched_at)) < datetime('${cutoffIso}');`
    );
  }
  if (statements.length === 0) {
    return cleanup;
  }
  executeWranglerSql(statements.join("\n"), cfg);
  return cleanup;
}

function listInputFiles(dir, cfg, changedSinceMs = 0) {
  if (!existsSync(dir)) return { files: [], skippedByAge: 0, skippedUnchangedFiles: 0, skippedUnchangedDirs: 0 };
  const supportedExts = new Set(array(cfg.supportedExtensions).length > 0
    ? array(cfg.supportedExtensions).map((item) => text(item).toLowerCase())
    : [".json", ".jsonl", ".md", ".txt", ".pdf"]);
  const files = [];
  let skippedByAge = 0;
  let skippedUnchangedFiles = 0;
  let skippedUnchangedDirs = 0;
  const stack = [{ path: dir, depth: 0 }];
  while (stack.length > 0) {
    const currentItem = stack.pop();
    const current = currentItem.path;
    for (const name of readdirSync(current)) {
      if (name.startsWith(".")) continue;
      const path = join(current, name);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        if (changedSinceMs > 0 && currentItem.depth > 0 && stat.mtimeMs <= changedSinceMs) {
          skippedUnchangedDirs += 1;
          continue;
        }
        stack.push({ path, depth: currentItem.depth + 1 });
        continue;
      }
      if (stat.isFile() && supportedExts.has(extname(path).toLowerCase())) {
        if (changedSinceMs > 0 && stat.mtimeMs <= changedSinceMs) {
          skippedUnchangedFiles += 1;
          continue;
        }
        if (isOlderThanSourceWindow(path, dir, stat)) {
          skippedByAge += 1;
          continue;
        }
        files.push(path);
      }
    }
  }
  return { files: files.sort(), skippedByAge, skippedUnchangedFiles, skippedUnchangedDirs };
}

function isOlderThanSourceWindow(file, inputDir, stat) {
  const kind = inferInputKind(file, inputDir);
  const maxAgeDays = kind === "news" ? maxNewsAgeDays : maxReportAgeDays;
  if (!maxAgeDays) return false;
  const sourceDate = inferSourceDate(file, stat);
  if (!sourceDate) return false;
  return sourceDate < startOfLocalDay(addDays(now, -maxAgeDays));
}

function inferInputKind(file, inputDir) {
  const owner = basename(inputDir).toLowerCase();
  if (owner.includes("news")) return "news";
  if (owner.includes("report")) return "report";
  const normalized = file.toLowerCase();
  if (normalized.includes("/news/")) return "news";
  if (normalized.includes("/reports/")) return "report";
  const ext = extname(file).toLowerCase();
  return ext === ".pdf" ? "report" : "news";
}

function inferSourceDate(file, stat) {
  const fromPath = latestDateFromText(file);
  if (fromPath) return startOfLocalDay(fromPath);
  return stat?.mtime instanceof Date ? startOfLocalDay(stat.mtime) : null;
}

function latestDateFromText(value) {
  const dates = [];
  const raw = text(value);
  for (const match of raw.matchAll(/(20\d{2})[-_/年.](\d{1,2})[-_/月.](\d{1,2})日?/g)) {
    const date = validLocalDate(Number(match[1]), Number(match[2]), Number(match[3]));
    if (date) dates.push(date);
  }
  for (const match of raw.matchAll(/(20\d{2})(\d{2})(\d{2})/g)) {
    const date = validLocalDate(Number(match[1]), Number(match[2]), Number(match[3]));
    if (date) dates.push(date);
  }
  if (dates.length === 0) return null;
  return dates.sort((a, b) => b.getTime() - a.getTime())[0];
}

function validLocalDate(year, month, day) {
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function loadScanState(file) {
  if (!existsSync(file)) {
    return {};
  }
  try {
    return object(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function readJsonFile(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function resolveScanWatermark(state) {
  const explicit = nonNegativeInteger(state.lastCompletedScanStartedAtMs, 0);
  if (explicit > 0) {
    return { ms: explicit, source: "lastCompletedScanStartedAtMs" };
  }
  const legacyCompletedAt = Date.parse(text(state.completedAt));
  if (Number.isFinite(legacyCompletedAt) && legacyCompletedAt > 0) {
    return { ms: legacyCompletedAt, source: "legacyCompletedAt" };
  }
  return { ms: 0, source: "none" };
}

function saveScanState(file, patch) {
  mkdirSync(dirname(file), { recursive: true });
  const next = {
    ...loadScanState(file),
    ...patch,
  };
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
}

function executeWranglerSql(sql, cfg, options = {}) {
  return execFileSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      cfg.database || "stock_info",
      dbTarget ? "--remote" : "--local",
      "--command",
      sql,
      ...(options.json ? ["--json"] : []),
    ],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 50 * 1024 * 1024 }
  );
}

function sourceFingerprint(file) {
  const stat = statSync(file);
  return {
    sourceFile: relativeInputPath(file),
    sourceMtimeMs: Math.trunc(stat.mtimeMs),
    sourceSize: stat.size,
  };
}

function loadImportSyncState(file, target) {
  const map = new Map();
  if (!existsSync(file)) {
    return map;
  }
  const lines = readFileSync(file, "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (text(entry.target) !== target.target || text(entry.database) !== target.database) {
        continue;
      }
      const docId = text(entry.docId);
      if (!docId) {
        continue;
      }
      map.set(docId, entry);
    } catch {
      continue;
    }
  }
  return map;
}

function isDocAlreadySynced(docId, fingerprint, syncState) {
  const entry = syncState.get(text(docId));
  if (!entry) {
    return false;
  }
  if (!entry.hasD1) {
    return false;
  }
  return text(entry.sourceFile) === text(fingerprint.sourceFile)
    && integer(entry.sourceMtimeMs, -1) === integer(fingerprint.sourceMtimeMs, -2)
    && integer(entry.sourceSize, -1) === integer(fingerprint.sourceSize, -2);
}

function readImportResults(file) {
  if (!existsSync(file)) {
    return [];
  }
  const body = readFileSync(file, "utf8").trim();
  if (!body) {
    return [];
  }
  if (body.startsWith("[")) {
    const parsed = readJsonFile(file);
    return Array.isArray(parsed) ? parsed : [];
  }
  return body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
}

function mergeImportSyncState(syncState, entries, target) {
  for (const entry of entries) {
    if (text(entry.target) !== target.target || text(entry.database) !== target.database) {
      continue;
    }
    const docId = text(entry.docId);
    if (!docId) {
      continue;
    }
    syncState.set(docId, entry);
  }
}

function isUnderDir(file, dir) {
  const rel = relative(dir, file);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("../") && rel !== "..");
}

function isMatchingMarkdownCacheMeta(cachedMeta, sourceFingerprint) {
  if (!cachedMeta || typeof cachedMeta !== "object") return false;
  const sameStats = cachedMeta.mtimeMs === sourceFingerprint.mtimeMs && cachedMeta.size === sourceFingerprint.size;
  if (!sameStats) return false;
  if (cachedMeta.file === sourceFingerprint.file) return true;
  if (text(cachedMeta.basename) && cachedMeta.basename === sourceFingerprint.basename) return true;
  return basename(text(cachedMeta.file)) === sourceFingerprint.basename;
}

function resolveInputDirs(argInboxDir, cfg, extraInputDirs = []) {
  const extraDirs = array(extraInputDirs).map((dir) => resolve(root, text(dir))).filter((dir) => existsSync(dir));
  if (argInboxDir) {
    return unique([resolve(root, argInboxDir), ...extraDirs].filter((dir) => existsSync(dir)));
  }
  const configured = array(cfg.inputDirs).length > 0 ? array(cfg.inputDirs) : [
    `${sharedDataRoot}/news`,
    `${sharedDataRoot}/reports`,
  ];
  const dirs = configured
    .map((dir) => resolve(root, text(dir)))
    .filter((dir) => existsSync(dir));
  const legacyInbox = text(cfg.inboxDir) ? resolve(root, cfg.inboxDir) : "";
  const baseDirs = dirs.length === 0 && legacyInbox && existsSync(legacyInbox)
    ? [legacyInbox]
    : dirs;
  return unique(baseDirs.concat(extraDirs));
}

function archiveProcessedFile(file) {
  if (!archiveProcessed || !existsSync(file) || isUnderDir(file, processedDir)) {
    return;
  }
  moveToDir(file, processedDir);
}

function moveToDir(file, dir) {
  const target = uniquePath(join(dir, relativeInputPath(file)));
  mkdirSync(dirname(target), { recursive: true });
  try {
    renameSync(file, target);
  } catch {
    copyFileSync(file, target);
    rmSync(file, { force: true });
  }
}

function relativeInputPath(file) {
  const owner = inputDirs
    .slice()
    .sort((a, b) => b.length - a.length)
    .find((dir) => file === dir || file.startsWith(`${dir}/`));
  return owner ? relative(owner, file) : basename(file);
}

function uniquePath(path) {
  if (!existsSync(path)) return path;
  const ext = extname(path);
  const stem = path.slice(0, path.length - ext.length);
  return `${stem}-${Date.now()}${ext}`;
}

function inferSourceType(raw, file, cfg) {
  const ext = extname(file).toLowerCase();
  if (ext === ".pdf" || text(raw.url).toLowerCase().includes(".pdf")) {
    return "research_report";
  }
  return cfg.defaultSourceType || "local_news";
}

function inferReportType(sourceType, raw, file) {
  if (raw.reportType || raw.report_type) return text(raw.reportType ?? raw.report_type);
  if (sourceType === "research_report") {
    return text(raw.targetCode ?? raw.target_code) ? "company_report" : "research_report";
  }
  if (extname(file).toLowerCase() === ".pdf") return "research_report";
  return "news";
}

function makeDocId(raw, file) {
  const stable = [
    text(raw.url),
    text(raw.title) || titleFromFilename(file),
    text(raw.publishedAt ?? raw.published_at ?? raw.date),
    basename(file),
  ].join("|");
  return stableKnowledgeDocId(stable);
}

function stableKnowledgeDocId(value) {
  return `k_${sha256(String(value || "")).slice(0, 24)}`;
}

function titleFromMarkdown(markdown) {
  const heading = markdown.split(/\r?\n/).find((line) => /^#\s+/.test(line));
  return heading ? heading.replace(/^#\s+/, "").trim() : "";
}

function titleFromFilename(file) {
  return basename(file, extname(file)).replace(/[_-]+/g, " ").trim();
}

function stripHtml(value) {
  return text(value)
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeDate(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "number") {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  const raw = text(value);
  if (/^\d+$/.test(raw)) {
    const parsed = Number(raw);
    const ms = parsed > 10_000_000_000 ? parsed : parsed * 1000;
    return new Date(ms).toISOString();
  }
  return raw;
}

function countFilesByExtension(files) {
  const counts = {};
  for (const file of files) {
    const ext = extname(file).toLowerCase() || "(none)";
    counts[`ext_${ext.replace(/[^a-z0-9]+/g, "_")}`] = (counts[`ext_${ext.replace(/[^a-z0-9]+/g, "_")}`] || 0) + 1;
  }
  return counts;
}

function logProgress(message, fields = {}) {
  const details = Object.entries(fields)
    .map(([key, value]) => `${key}=${formatLogValue(value)}`)
    .join(" ");
  console.error(`[knowledge] ${new Date().toISOString()} ${message}${details ? ` ${details}` : ""}`);
}

function formatLogValue(value) {
  if (Array.isArray(value)) return JSON.stringify(value);
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value ?? "");
}

function normalizeStockCode(value) {
  const raw = text(value);
  if (!raw) return "";
  const upper = raw.toUpperCase();
  const usMatch = upper.match(/^US([A-Z0-9.-]+)\.(OQ|NQ|N|AMEX|PK|OB)$/);
  if (usMatch) {
    return `${usMatch[1]}.US`;
  }
  const lower = raw.toLowerCase();
  const match = lower.match(/(?:^|[^0-9])([036]\d{5})(?:[^0-9]|$)/);
  if (match) {
    return `${match[1]}.${match[1].startsWith("6") ? "SH" : "SZ"}`;
  }
  const suffixMatch = raw.match(/^(\d{6})\.(SH|SZ)$/i);
  if (suffixMatch) {
    return `${suffixMatch[1]}.${suffixMatch[2].toUpperCase()}`;
  }
  return raw.toUpperCase();
}

function bareStockCode(value) {
  return text(value).split(".")[0];
}

function buildSecurityAliases(name, code, aliases = []) {
  const baseName = securityBaseName(name);
  const shortName = stripSecuritySuffix(baseName);
  return unique([
    code,
    code ? bareStockCode(code) : "",
    name,
    baseName,
    shortName,
    ...array(aliases).map(text),
  ]);
}

function stripSecuritySuffix(name) {
  return text(name)
    .replace(/(股份有限公司|集团有限公司|控股有限公司|科技有限公司|股份|集团|控股|科技)$/u, "")
    .trim();
}

function safeFilename(value) {
  return text(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "file";
}

function summarize(markdown) {
  return markdown
    .replace(/^#+\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function normalizeTencentNewsDedupeBody(value) {
  return stripTencentLeadNoise(text(value))
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim()
    .slice(0, 1200);
}

function isIgnorableTencentLeadLine(value) {
  return /^作者[丨|｜:：\s]/.test(value)
    || /^(公众号|点击上方|来源|原标题)/.test(value)
    || /加星标/.test(value);
}

function stripTencentLeadNoise(value) {
  let normalized = text(value).trim();
  normalized = normalized.replace(/^作者[丨|｜:：\s]*[^\s，。,；;:：]{1,40}\s*/u, "");
  normalized = normalized.replace(/^(公众号|点击上方)[^。！？!?]{0,80}[。！？!?]?\s*/u, "");
  normalized = normalized.replace(/^来源[：:]\s*[^\s]+\s*/u, "");
  normalized = normalized.replace(/^原标题[：:]\s*/u, "");
  if (isIgnorableTencentLeadLine(normalized)) {
    const lines = normalized
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    while (lines.length > 0 && isIgnorableTencentLeadLine(lines[0])) {
      lines.shift();
    }
    normalized = lines.join(" ");
  }
  return normalized.replace(/\s+/g, " ");
}

function uniqueByDocId(items) {
  const map = new Map();
  for (const item of items) {
    map.set(item.docId, item);
  }
  return [...map.values()];
}

async function mapWithConcurrency(items, concurrency, iteratee) {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        return;
      }
      results[currentIndex] = await iteratee(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

function loadConfig(path) {
  const file = resolve(root, path || "config/knowledge-processing.json");
  return JSON.parse(readFileSync(file, "utf8"));
}

function parseArgs(argv) {
  const parsed = {
    config: "",
    inboxDir: "",
    extraInputs: [],
    remote: undefined,
    archiveProcessed: false,
    fullRescan: false,
    disableAgeLimit: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config") parsed.config = requireValue(argv, ++i, arg);
    else if (arg === "--inbox") parsed.inboxDir = requireValue(argv, ++i, arg);
    else if (arg === "--extra-input") parsed.extraInputs.push(requireValue(argv, ++i, arg));
    else if (arg === "--remote") parsed.remote = true;
    else if (arg === "--local") parsed.remote = false;
    else if (arg === "--archive-processed") parsed.archiveProcessed = true;
    else if (arg === "--full-rescan") parsed.fullRescan = true;
    else if (arg === "--no-age-limit") parsed.disableAgeLimit = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return parsed;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value) throw new Error(`missing value for ${flag}`);
  return value;
}

function envBoolean(name) {
  const value = process.env[name];
  if (value === undefined) return undefined;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function formatRunTime(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function truncate(value, max) {
  return value.length > max ? value.slice(0, max) : value;
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

function nonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function unique(values) {
  return [...new Set(values.map(text).filter(Boolean))];
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
