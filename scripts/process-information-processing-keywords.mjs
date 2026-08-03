#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { resolveLocalD1Database } from "./lib/local-d1-sqlite.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const args = parseArgs(process.argv.slice(2));
const inputPath = resolve(root, String(args.input || "config/information-processing-institutional-top300.json"));
const server = String(args.server || process.env.INFORMATION_PROCESSING_SERVER || "http://127.0.0.1:8000").replace(/\/$/, "");
const dryRun = args.dryRun === true;
const all = args.all === true;
const maxDocuments = all ? Infinity : positiveInteger(args.maxDocuments, 100, "--max-documents");
const maxAgeDays = positiveInteger(args.maxAgeDays, 30, "--max-age-days");
const concurrency = Math.min(20, positiveInteger(args.concurrency, 3, "--concurrency"));
const retryStaleProcessingMinutes = positiveInteger(args.retryStaleProcessingMinutes, 2, "--retry-stale-processing-minutes");
const progressPath = resolve(root, String(args.progressFile || `data/stock-info/knowledge/state/institutional-top300-information-processing-${runStamp()}.jsonl`));
const input = parseInput(JSON.parse(await readFile(inputPath, "utf8")));
const promptVersion = String(args.promptVersion || "information-processing-v15").trim();
if (!promptVersion) throw new Error("--prompt-version must not be empty");
const databaseFile = resolveLocalD1Database({ root, requiredTable: "knowledge_docs" });
const documents = loadDocuments(databaseFile, promptVersion, retryStaleProcessingMinutes, maxAgeDays);
const selection = selectDocuments(input, documents, maxDocuments);

console.log(`关键词：${input.keywords.length} 个；最近 ${maxAgeDays} 天标题匹配：${selection.matched} 篇；已处理：${selection.alreadyProcessed} 篇；预筛跳过：${selection.preprocessedSkip} 篇；内容不可用：${selection.unavailableContent} 篇；已排队/处理中：${selection.activeJobs} 篇；本次待处理：${selection.selected.length} 篇${all ? "（全部）" : `（上限 ${maxDocuments}）`}；并发：${concurrency}`);
console.log(`范围：每个关键词只处理最近 ${maxAgeDays} 天；排序：机构持仓优先级升序；同一关键词内按时间从近到远；${retryStaleProcessingMinutes} 分钟未更新的“处理中”任务会重试。输入：${inputPath}`);
if (selection.selected.length === 0) {
  console.log("没有符合条件的未处理文档。");
  process.exit(0);
}

if (dryRun) {
  for (const [index, item] of selection.selected.entries()) {
    console.log(`[预览 ${index + 1}/${selection.selected.length}] #${item.priority} ${item.name} · 日期：${displayDocumentDate(item.sortTime)} · ${item.title} · ${item.docId}`);
  }
  process.exit(0);
}

await mkdir(dirname(progressPath), { recursive: true });
const startedAt = Date.now();
let completed = 0;
let failed = 0;
let nextIndex = 0;
await Promise.all(Array.from({ length: Math.min(concurrency, selection.selected.length) }, () => processNextDocument()));
console.log(`结束：待处理 ${selection.selected.length} 篇，完成 ${completed}，失败 ${failed}，总耗时 ${secondsSince(startedAt)}s。进度日志：${progressPath}`);

async function processNextDocument() {
  while (true) {
    const index = nextIndex;
    nextIndex += 1;
    if (index >= selection.selected.length) return;
    const item = selection.selected[index];
    const position = index + 1;
    const itemStartedAt = Date.now();
    const label = `[${position}/${selection.selected.length}] #${item.priority} ${item.name} · 日期：${displayDocumentDate(item.sortTime)}`;
    process.stdout.write(`${label} 开始：${item.title}\n`);
    const heartbeat = setInterval(() => {
      process.stdout.write(`${label} 仍在处理中，已等待 ${secondsSince(itemStartedAt)}s…\n`);
    }, 10_000);
    try {
      const result = await processDocument(server, item.docId);
      const durationSeconds = secondsSince(itemStartedAt);
      const status = String(result.status || "unknown");
      if (status === "failed") failed += 1;
      else completed += 1;
      process.stdout.write(`${label} ${status}，${describeResult(result)}，耗时 ${durationSeconds}s；累计完成 ${completed}，失败 ${failed}。\n`);
      await appendProgress(progressPath, { at: new Date().toISOString(), position, total: selection.selected.length, ...item, durationSeconds, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed += 1;
      process.stderr.write(`${label} 请求失败：${message}；累计完成 ${completed}，失败 ${failed}。\n`);
      await appendProgress(progressPath, { at: new Date().toISOString(), position, total: selection.selected.length, ...item, durationSeconds: secondsSince(itemStartedAt), error: message });
    } finally {
      clearInterval(heartbeat);
    }
  }
}

function loadDocuments(database, promptVersion, retryStaleProcessingMinutes, maxAgeDays) {
  const activeProcessingCutoff = Date.now() - retryStaleProcessingMinutes * 60 * 1000;
  const documentCutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
  const sql = `
    select d.doc_id, d.title, d.sort_time,
      exists (
        select 1 from knowledge_document_versions v
        join knowledge_processing_runs r on r.version_id = v.version_id
        where v.doc_id = d.doc_id
          and v.version_id = (
            select v2.version_id from knowledge_document_versions v2
            where v2.doc_id = d.doc_id order by v2.created_at desc limit 1
          )
          and r.stage = 'document_analysis'
          and r.prompt_version = ${sqlString(promptVersion)}
          and r.status in ('succeeded', 'needs_review')
      ) as is_processed,
      exists (
        select 1 from information_processing_jobs j
        where j.doc_id = d.doc_id
          and (j.status = 'queued' or (j.status = 'processing' and j.updated_at >= ${activeProcessingCutoff}))
      ) as has_active_job,
      exists (
        select 1 from information_processing_jobs j
        where j.doc_id = d.doc_id
          and j.status = 'failed'
          and j.last_error like 'knowledge document content unavailable in local cache or source: 404%'
      ) as content_unavailable,
      coalesce((
        select p.action
        from knowledge_preprocessing_decisions p
        where p.version_id = (
          select v3.version_id from knowledge_document_versions v3
          where v3.doc_id = d.doc_id order by v3.created_at desc limit 1
        )
        order by p.decided_at desc limit 1
      ), '') as preprocessing_action
    from knowledge_docs d
    where d.sort_time >= ${sqlString(documentCutoff)}
      and trim(coalesce(d.title, '')) != ''
  `;
  const output = execFileSync("sqlite3", ["-readonly", "-json", database, sql], { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  return JSON.parse(output || "[]").map((row) => ({
    docId: String(row.doc_id || ""), title: String(row.title || ""), sortTime: String(row.sort_time || ""),
    processed: Number(row.is_processed) === 1, activeJob: Number(row.has_active_job) === 1,
    contentUnavailable: Number(row.content_unavailable) === 1,
    preprocessedSkip: isTerminalPreprocessingAction(row.preprocessing_action),
  }));
}

function selectDocuments(input, documents, maxDocuments) {
  const seen = new Set();
  const candidates = [];
  let matched = 0;
  let alreadyProcessed = 0;
  let preprocessedSkip = 0;
  let unavailableContent = 0;
  let activeJobs = 0;
  for (const keyword of input.keywords) {
    const matches = documents.filter((document) => keyword.titleKeywords.some((needle) => document.title.includes(needle)));
    for (const document of matches) {
      if (seen.has(document.docId)) continue;
      seen.add(document.docId);
      matched += 1;
      if (document.processed) { alreadyProcessed += 1; continue; }
      if (document.preprocessedSkip) { preprocessedSkip += 1; continue; }
      if (document.contentUnavailable) { unavailableContent += 1; continue; }
      if (document.activeJob) { activeJobs += 1; continue; }
      candidates.push({ ...document, priority: keyword.priority, name: keyword.name });
    }
  }
  candidates.sort((left, right) => left.priority - right.priority
    || newestFirst(left.sortTime, right.sortTime)
    || left.docId.localeCompare(right.docId));
  return { matched, alreadyProcessed, preprocessedSkip, unavailableContent, activeJobs, selected: candidates.slice(0, maxDocuments) };
}

async function processDocument(server, documentId) {
  const response = await fetch(`${server}/api/knowledge/processing-jobs`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ documentId, concurrency: 1, triggerSource: "cli" }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.code !== 200) throw new Error(payload?.msg || `HTTP ${response.status}`);
  const results = Array.isArray(payload.data?.results) ? payload.data.results : [];
  const result = results.find((item) => String(item.documentId || "") === documentId);
  if (!result) throw new Error(`processing endpoint did not return ${documentId}`);
  return result;
}

async function appendProgress(file, value) {
  await appendFile(file, `${JSON.stringify(value)}\n`, "utf8");
}

function describeResult(result) {
  if (result.status === "failed") return `错误：${String(result.error || "未知错误")}`;
  const action = result.action ? `处理：${result.action}` : "";
  const outcome = result.outcome ? `结果：${result.outcome}` : "";
  const records = Number.isFinite(Number(result.recordCount)) ? `记录：${Number(result.recordCount)}` : "";
  return [action, outcome, records].filter(Boolean).join("，") || "已返回";
}

function parseInput(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error("keyword input must be a non-empty JSON array");
  const keywords = value.map((raw, index) => {
    const name = String(raw || "").trim();
    if (!name) throw new Error(`keyword ${index + 1} must be a non-empty string`);
    return { priority: index + 1, name, titleKeywords: [name] };
  });
  if (new Set(keywords.map((item) => item.name)).size !== keywords.length) throw new Error("keyword input contains duplicate values");
  return { keywords };
}

function parseArgs(values) {
  const result = {};
  const booleanOptions = new Set(["dryRun", "all"]);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const [key, inline] = value.slice(2).split("=", 2);
    const normalized = key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (inline !== undefined) {
      result[normalized] = inline;
    } else if (booleanOptions.has(normalized)) {
      result[normalized] = true;
    } else {
      const next = values[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`--${key} requires a value`);
      result[normalized] = next;
      index += 1;
    }
  }
  return result;
}

function positiveInteger(value, fallback, option) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${option} must be a positive integer`);
  return parsed;
}

function secondsSince(startedAt) { return Math.max(0, Math.round((Date.now() - startedAt) / 1000)); }
function newestFirst(left, right) {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return right.localeCompare(left);
}
function displayDocumentDate(value) {
  const match = String(value || "").match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : "未知日期";
}
function isTerminalPreprocessingAction(value) {
  return new Set(["exact_duplicate", "template_duplicate", "pure_market_snapshot", "empty_content"]).has(String(value || ""));
}
function sqlString(value) { return `'${String(value).replaceAll("'", "''")}'`; }
function runStamp() { return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z"); }
