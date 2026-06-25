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
import { basename, extname, join, resolve } from "node:path";
import { createHash } from "node:crypto";

const root = resolve(new URL("..", import.meta.url).pathname);
const args = parseArgs(process.argv.slice(2));
const config = loadConfig(args.config);
const dbTarget = args.remote ?? envBoolean("KNOWLEDGE_PROCESS_REMOTE") ?? Boolean(config.remote);
const inboxDir = resolve(root, args.inboxDir || config.inboxDir || "data/knowledge/inbox");
const processedDir = resolve(root, config.processedDir || "data/knowledge/processed");
const failedDir = resolve(root, config.failedDir || "data/knowledge/failed");
const workDir = resolve(root, config.workDir || "data/knowledge/work");
const now = new Date();

for (const dir of [inboxDir, processedDir, failedDir, workDir]) {
  mkdirSync(dir, { recursive: true });
}

const files = listInputFiles(inboxDir);
const results = [];
const fileBatches = [];

for (const file of files) {
  try {
    const fileDocs = await processInputFile(file, config);
    fileBatches.push({ file, docs: fileDocs });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeFileSync(`${file}.error.log`, `${message}\n`);
    moveToDir(file, failedDir);
    if (existsSync(`${file}.error.log`)) {
      moveToDir(`${file}.error.log`, failedDir);
    }
    results.push({ file, status: "failed", error: message });
  }
}

const topicDecisions = await evaluateTopics(fileBatches.flatMap((batch) => batch.docs), config);
const docs = [];
let skippedByTopic = 0;

for (const batch of fileBatches) {
  try {
    const keptDocs = [];
    for (const rawDoc of batch.docs) {
      const topic = topicDecisions.get(rawDoc.docId) || { keep: true, method: "missing", score: 0, reasons: [] };
      if (!topic.keep) {
        skippedByTopic += 1;
        continue;
      }
      const doc = await enrichWithLlmIfEnabled({
        ...rawDoc,
        metadata: {
          ...rawDoc.metadata,
          topicFilter: topic,
        },
      }, config);
      keptDocs.push(doc);
    }
    docs.push(...keptDocs);
    moveToDir(batch.file, processedDir);
    results.push({ file: batch.file, status: "processed", docs: keptDocs.length, skipped: batch.docs.length - keptDocs.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeFileSync(`${batch.file}.error.log`, `${message}\n`);
    moveToDir(batch.file, failedDir);
    if (existsSync(`${batch.file}.error.log`)) {
      moveToDir(`${batch.file}.error.log`, failedDir);
    }
    results.push({ file: batch.file, status: "failed", error: message });
  }
}

const uniqueDocs = uniqueByDocId(docs);
let imported = 0;
if (uniqueDocs.length > 0) {
  const importFile = join(workDir, `knowledge-import-${formatRunTime(now)}.jsonl`);
  writeFileSync(importFile, `${uniqueDocs.map((doc) => JSON.stringify(doc)).join("\n")}\n`);
  execFileSync(
    "npm",
    [
      "run",
      "import:knowledge:docs",
      "--",
      "--file",
      importFile,
      dbTarget ? "--remote" : "--local",
      "--database",
      config.database || "stock_info",
    ],
    { cwd: root, stdio: "inherit" }
  );
  imported = uniqueDocs.length;
}

console.log(JSON.stringify({
  inboxDir,
  database: config.database || "stock_info",
  remote: dbTarget,
  files: files.length,
  imported,
  skippedByTopic,
  results: results.map((item) => ({
    file: basename(item.file),
    status: item.status,
    docs: item.docs || 0,
    skipped: item.skipped || 0,
    error: item.error || undefined,
  })),
}, null, 2));

async function processInputFile(file, cfg) {
  const ext = extname(file).toLowerCase();
  if (ext === ".json" || ext === ".jsonl") {
    return loadJsonDocs(file).map((item) => normalizeInputDoc(item, file, cfg));
  }
  if (ext === ".pdf") {
    const markdown = convertPdfToMarkdown(file, cfg);
    return [normalizeInputDoc({
      title: titleFromFilename(file),
      sourceType: "research_report",
      reportType: "research_report",
      sourceName: cfg.defaultSourceName,
      accessMethod: "markdown",
      markdown,
      metadata: { originalFile: basename(file), pdfStored: false },
      tags: ["pdf"],
    }, file, cfg)];
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
    }, file, cfg)];
  }
  throw new Error(`unsupported input file: ${file}`);
}

function normalizeInputDoc(raw, file, cfg) {
  const title = text(raw.title) || titleFromFilename(file);
  const markdown = text(raw.mdText ?? raw.md_text ?? raw.markdown ?? raw.content ?? raw.body);
  const summary = text(raw.summary) || summarize(markdown);
  const sourceType = text((raw.sourceType ?? raw.source_type) || inferSourceType(raw, file, cfg));
  const reportType = text((raw.reportType ?? raw.report_type) || inferReportType(sourceType, raw, file));
  const baseTags = unique([
    ...array(raw.tags).map(text),
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
  const recommendationScore = integer(raw.recommendationScore ?? raw.recommendation_score, scoring.score);
  const recommendationLevel = text(raw.recommendationLevel ?? raw.recommendation_level) || levelForScore(recommendationScore, cfg);
  return {
    docId: text(raw.docId ?? raw.doc_id ?? raw.id) || makeDocId(raw, file),
    sourceType,
    reportType,
    sourceName: text(raw.sourceName ?? raw.source_name) || cfg.defaultSourceName || "",
    title,
    url: text(raw.url),
    publishedAt: text(raw.publishedAt ?? raw.published_at ?? raw.date),
    fetchedAt: text(raw.fetchedAt ?? raw.fetched_at) || now.toISOString(),
    eventTime: text(raw.eventTime ?? raw.event_time ?? raw.publishedAt ?? raw.published_at ?? raw.date),
    targetName: text(raw.targetName ?? raw.target_name),
    targetCode: text(raw.targetCode ?? raw.target_code),
    discoveryMethod: text(raw.discoveryMethod ?? raw.discovery_method) || "local_process_once",
    accessMethod: text(raw.accessMethod ?? raw.access_method) || "markdown",
    summary,
    markdown: truncate(markdown, integer(cfg.maxMarkdownChars, 120000)),
    tags,
    metadata: {
      ...object(raw.metadata ?? raw.metadata_json),
      processedAt: now.toISOString(),
      inputFile: basename(file),
      pdfStored: false,
    },
    recommendationScore,
    recommendationLevel,
    recommendationReasons: array(raw.recommendationReasons ?? raw.recommendation_reasons).map(text).filter(Boolean).length > 0
      ? array(raw.recommendationReasons ?? raw.recommendation_reasons).map(text).filter(Boolean)
      : scoring.reasons,
    rankScore: integer(raw.rankScore ?? raw.rank_score, recommendationScore),
    sourceWeight: integer(raw.sourceWeight ?? raw.source_weight, 0),
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
  const result = spawnSync(python, ["-c", code, file, out], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`pdf to markdown failed: ${result.stdout.trim()} ${result.stderr.trim()}`.trim());
  }
  return readFileSync(out, "utf8");
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
  const parsed = await requestLlmJson({
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
  const nextScore = integer(parsed.recommendationScore, doc.recommendationScore);
  return {
    ...doc,
    summary: text(parsed.summary) || doc.summary,
    tags: unique([...doc.tags, ...array(parsed.tags).map(text)]),
    targetName: text(parsed.targetName) || doc.targetName,
    targetCode: text(parsed.targetCode) || doc.targetCode,
    recommendationScore: nextScore,
    recommendationLevel: levelForScore(nextScore, cfg),
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
  const filter = cfg.topicFilter || {};
  if (!filter.enabled) {
    for (const doc of docsToFilter) {
      decisions.set(doc.docId, { keep: true, method: "disabled", score: 0, reasons: [] });
    }
    return decisions;
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
    return decisions;
  }

  const llm = cfg.llm || {};
  const apiKey = process.env[llm.apiKeyEnv || "VOLC_ARK_API_KEY"] || process.env.LLM_API_KEY;
  if (!apiKey) {
    for (const item of uncertainDocs) {
      decisions.set(item.doc.docId, { keep: false, method: "local_missing_llm_key", ...item.local });
    }
    return decisions;
  }

  const batchSize = Math.max(1, integer(filter.llmBatchSize, 50));
  for (let offset = 0; offset < uncertainDocs.length; offset += batchSize) {
    const batch = uncertainDocs.slice(offset, offset + batchSize);
    const llmDecisions = await reviewTopicBatchWithLlm(batch.map((item, index) => ({
      index,
      title: item.doc.title,
      summary: item.doc.summary,
      sourceType: item.doc.sourceType,
      reportType: item.doc.reportType,
      tags: item.doc.tags,
    })), cfg);
    for (const [index, item] of batch.entries()) {
      const result = llmDecisions.get(index);
      const confidence = Number(result?.confidence);
      const keep = Boolean(result?.isAi) && Number.isFinite(confidence)
        && confidence >= Number(filter.llmMinConfidence ?? 0.65);
      decisions.set(item.doc.docId, {
        keep,
        method: "llm_batch",
        score: item.local.score,
        reasons: [...item.local.reasons, text(result?.reason)].filter(Boolean),
        confidence: Number.isFinite(confidence) ? confidence : 0,
        model: process.env.KNOWLEDGE_PROCESS_LLM_MODEL || llm.model || "doubao-seed-2-0-mini-260215",
      });
    }
  }
  return decisions;
}

async function reviewTopicBatchWithLlm(items, cfg) {
  const filter = cfg.topicFilter || {};
  const llm = cfg.llm || {};
  const apiKey = process.env[llm.apiKeyEnv || "VOLC_ARK_API_KEY"] || process.env.LLM_API_KEY;
  const model = process.env.KNOWLEDGE_PROCESS_LLM_MODEL || llm.model || "doubao-seed-2-0-mini-260215";
  const parsed = await requestLlmJson({
    baseUrl: (process.env.LLM_BASE_URL || llm.baseUrl || "https://ark.cn-beijing.volces.com/api/v3").replace(/\/$/, ""),
    apiKey,
    model,
    maxTokens: Math.max(300, items.length * 80),
    system: "你是金融资讯主题分类器。只输出严格 JSON，不要 Markdown。",
    user: [
      "批量判断以下新闻或研报是否主要属于 AI 产业链。",
      "AI 产业链包括：大模型、AI应用、算力、GPU/ASIC/AI芯片、服务器、数据中心、存储/HBM/DRAM/NAND、半导体、先进封装、光模块/CPO/硅光、高速互联、液冷、电源、国产替代等。",
      "只根据标题、摘要、类型和已有标签判断，不要扩展联想。",
      "输出 JSON：{\"items\":[{\"index\":number,\"isAi\":boolean,\"confidence\":number,\"reason\":string}]}。",
      "待判断列表：",
      JSON.stringify(items),
    ].join("\n"),
  });
  const decisions = new Map();
  for (const item of array(parsed.items)) {
    const index = Number(item?.index);
    if (Number.isInteger(index)) {
      decisions.set(index, item);
    }
  }
  return decisions;
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
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`LLM request failed: status=${response.status} body=${JSON.stringify(body).slice(0, 300)}`);
  }
  const textBody = extractLlmText(body);
  const parsed = parseJsonObjectFromText(textBody);
  if (!parsed) {
    throw new Error(`LLM response is not JSON: ${textBody.slice(0, 300)}`);
  }
  return parsed;
}

function extractLlmText(body) {
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((item) => item?.text || "").join("");
  return "";
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

function levelForScore(score, cfg) {
  const levels = array(cfg.scoreLevels).slice().sort((a, b) => integer(b.minScore, 0) - integer(a.minScore, 0));
  const matched = levels.find((item) => score >= integer(item.minScore, 0));
  return text(matched?.level) || "";
}

function listInputFiles(dir) {
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((file) => statSync(file).isFile())
    .filter((file) => [".json", ".jsonl", ".md", ".txt", ".pdf"].includes(extname(file).toLowerCase()))
    .sort();
}

function moveToDir(file, dir) {
  const target = uniquePath(join(dir, basename(file)));
  try {
    renameSync(file, target);
  } catch {
    copyFileSync(file, target);
    rmSync(file, { force: true });
  }
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
  return `local:${sha256(stable).slice(0, 24)}`;
}

function titleFromMarkdown(markdown) {
  const heading = markdown.split(/\r?\n/).find((line) => /^#\s+/.test(line));
  return heading ? heading.replace(/^#\s+/, "").trim() : "";
}

function titleFromFilename(file) {
  return basename(file, extname(file)).replace(/[_-]+/g, " ").trim();
}

function summarize(markdown) {
  return markdown
    .replace(/^#+\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function uniqueByDocId(items) {
  const map = new Map();
  for (const item of items) {
    map.set(item.docId, item);
  }
  return [...map.values()];
}

function loadConfig(path) {
  const file = resolve(root, path || "config/knowledge-processing.json");
  return JSON.parse(readFileSync(file, "utf8"));
}

function parseArgs(argv) {
  const parsed = { config: "", inboxDir: "", remote: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config") parsed.config = requireValue(argv, ++i, arg);
    else if (arg === "--inbox") parsed.inboxDir = requireValue(argv, ++i, arg);
    else if (arg === "--remote") parsed.remote = true;
    else if (arg === "--local") parsed.remote = false;
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

function unique(values) {
  return [...new Set(values.map(text).filter(Boolean))];
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
