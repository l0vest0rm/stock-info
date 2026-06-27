#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const sharedDataRoot = "/Users/terry/git/data";
const args = parseArgs(process.argv.slice(2));
const config = loadConfig(args.config);
const cfg = config.eastmoneyReports || {};

if (cfg.enabled === false) {
  console.log(JSON.stringify({ source: "eastmoney_reports", skipped: true, reason: "disabled" }, null, 2));
  process.exit(0);
}

const outputDir = resolve(root, cfg.outputDir || `${sharedDataRoot}/reports`);
mkdirSync(outputDir, { recursive: true });
const stateDir = resolve(root, config.stateDir || `${sharedDataRoot}/stock-info/knowledge/state`);
mkdirSync(stateDir, { recursive: true });
const stateFile = resolve(stateDir, cfg.stateFile || "eastmoney-report-fetch-state.json");
const fetchState = loadState(stateFile);
const range = resolveFetchRange(cfg, config, fetchState);
const beginTime = range.beginTime;
const endTime = range.endTime;

const docs = [];
const seen = new Set();
for (const qType of cfg.qTypes || [{ value: "0", reportType: "company_report" }, { value: "1", reportType: "industry_report" }]) {
  for (let pageNo = 1; pageNo <= integer(cfg.pages, 3); pageNo += 1) {
    const items = await fetchEastmoneyReportPage({
      qType: String(qType.value),
      pageNo,
      pageSize: integer(cfg.pageSize, 100),
      beginTime,
      endTime,
    });
    for (const item of items) {
      const doc = mapEastmoneyReport(item, qType.reportType || "research_report");
      if (!doc.docId || seen.has(doc.docId)) continue;
      seen.add(doc.docId);
      docs.push(doc);
    }
    if (items.length < integer(cfg.pageSize, 100)) break;
  }
}

const file = join(outputDir, `eastmoney-reports-${formatDate(new Date())}.jsonl`);
if (docs.length > 0) {
  writeFileSync(file, `${docs.map((doc) => JSON.stringify(doc)).join("\n")}\n`);
}
saveState(stateFile, {
  lastBeginTime: beginTime,
  lastEndTime: endTime,
  lastFetchedAt: new Date().toISOString(),
  lastFetchedDocs: docs.length,
});

console.log(JSON.stringify({
  source: "eastmoney_reports",
  output: file,
  fetched: docs.length,
  beginTime,
  endTime,
  rangeMode: range.mode,
  stateFile,
}, null, 2));

async function fetchEastmoneyReportPage({ qType, pageNo, pageSize, beginTime, endTime }) {
  const url = new URL("https://reportapi.eastmoney.com/report/list");
  const params = {
    cb: "jQuery",
    industryCode: "*",
    pageSize: String(pageSize),
    industry: "*",
    rating: "*",
    ratingChange: "*",
    beginTime,
    endTime,
    pageNo: String(pageNo),
    fields: "",
    qType,
    orgCode: "",
    code: "*",
    rcode: "",
    _: String(Date.now()),
  };
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    headers: {
      Referer: "https://data.eastmoney.com/report/",
      "User-Agent": "Mozilla/5.0 (compatible; stock-info-local/0.1)",
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`eastmoney report list failed: status=${response.status} body=${text.slice(0, 300)}`);
  }
  const json = parseJsonp(text);
  return Array.isArray(json.data) ? json.data : [];
}

function mapEastmoneyReport(item, reportType) {
  const infoCode = text(item.infoCode);
  const title = text(item.title);
  const stockCode = text(item.stockCode);
  const stockName = text(item.stockName);
  const orgName = text(item.orgSName || item.orgName);
  const industryName = text(item.indvInduName || item.industryName);
  const publishedAt = trimDate(text(item.publishDate));
  const targetName = stockName || industryName;
  const targetCode = stockCode ? `${stockCode}.${stockCode.startsWith("6") ? "SH" : "SZ"}` : "";
  const tags = unique([
    "pdf",
    ...(reportType === "company_report" ? ["公司研报"] : []),
    ...(reportType === "industry_report" ? ["行业研报"] : []),
    industryName,
  ]);
  return {
    docId: infoCode ? stableKnowledgeDocId(`eastmoney_report|${infoCode}`) : "",
    sourceType: "research_report",
    reportType,
    sourceName: orgName || "东方财富",
    title,
    url: infoCode ? `https://pdf.dfcfw.com/pdf/H3_${encodeURIComponent(infoCode)}_1.pdf` : "",
    publishedAt,
    fetchedAt: new Date().toISOString(),
    eventTime: publishedAt,
    targetName,
    targetCode,
    discoveryMethod: "eastmoney_report_list",
    accessMethod: "remote_pdf",
    summary: [title, orgName, targetName, industryName].filter(Boolean).join(" "),
    markdown: "",
    tags,
    metadata: {
      source: "eastmoney_report_list",
      infoCode,
      stockCode,
      stockName,
      orgName: text(item.orgName),
      orgSName: text(item.orgSName),
      industryName,
      publishDate: text(item.publishDate),
      raw: item,
    },
  };
}

function parseJsonp(value) {
  const start = value.indexOf("(");
  const end = value.lastIndexOf(")");
  const body = start >= 0 && end > start ? value.slice(start + 1, end) : value;
  return JSON.parse(body);
}

function stableKnowledgeDocId(value) {
  return `k_${sha256(String(value || "")).slice(0, 24)}`;
}

function sha256(value) {
  return Array.from(new Uint8Array(createHash("sha256").update(value).digest()))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function parseArgs(argv) {
  const parsed = { config: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config") parsed.config = requireValue(argv, ++i, arg);
    else if (arg === "--inbox") i += 1;
    else if (arg === "--remote" || arg === "--local") continue;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return parsed;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value) throw new Error(`missing value for ${flag}`);
  return value;
}

function loadConfig(path) {
  return JSON.parse(readFileSync(resolve(root, path || "config/knowledge-processing.json"), "utf8"));
}

function resolveFetchRange(cfg, rootConfig, state) {
  const today = startOfLocalDay(new Date());
  const end = parseLocalDate(cfg.endTime) || today;
  const lookbackDays = positiveInteger(cfg.lookbackDays ?? rootConfig.maxReportAgeDays, 60);
  const overlapDays = nonNegativeInteger(cfg.overlapDays, 1);
  const floor = addDays(end, -lookbackDays);
  const explicitBegin = parseLocalDate(cfg.beginTime);
  if (explicitBegin) {
    return {
      beginTime: formatDateParam(explicitBegin),
      endTime: formatDateParam(end),
      mode: "explicit_begin",
    };
  }
  const previousEnd = parseLocalDate(state.lastEndTime);
  if (previousEnd) {
    const resumed = addDays(previousEnd, -overlapDays);
    return {
      beginTime: formatDateParam(maxDate(floor, resumed)),
      endTime: formatDateParam(end),
      mode: "resume",
    };
  }
  return {
    beginTime: formatDateParam(floor),
    endTime: formatDateParam(end),
    mode: "lookback",
  };
}

function loadState(file) {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveState(file, patch) {
  const next = {
    ...loadState(file),
    ...patch,
  };
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
}

function formatDate(date) {
  return date.toISOString().slice(0, 10).replaceAll("-", "");
}

function formatDateParam(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function parseLocalDate(value) {
  const raw = text(value);
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

function maxDate(a, b) {
  return a.getTime() >= b.getTime() ? a : b;
}

function trimDate(value) {
  return value ? value.slice(0, 10) : "";
}

function text(value) {
  return String(value ?? "").trim();
}

function integer(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function unique(values) {
  return [...new Set(values.map(text).filter(Boolean))];
}
