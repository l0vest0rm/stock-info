#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import {
  RESEARCH_WEB_SEARCH_EVENT_RISK_PROMPT,
  RESEARCH_WEB_SEARCH_FORECAST_CONSENSUS_PROMPT,
  RESEARCH_WEB_SEARCH_INDUSTRY_MARKET_PROMPT,
  RESEARCH_WEB_SEARCH_LATEST_ANNUAL_REPORT_PROMPT,
  RESEARCH_WEB_SEARCH_PEER_SET_PROMPT,
  RESEARCH_WEB_SEARCH_RECENT_FILINGS_PROMPT,
  RESEARCH_WEB_SEARCH_SOURCE_PACKAGE_SYSTEM_PROMPT,
} from "./generated/prompt-text.mjs";

const effort = argument("--effort");
if (!["low", "medium", "high"].includes(effort)) {
  throw new Error("--effort must be low, medium, or high");
}

const securityCode = argument("--code", "300308.SZ");
const packageKind = argument("--package", "event_risk");
const outputPath = argument("--output");
const latestFinancialReport = {
  period: argument("--financial-report-period", "未知"),
  publishedAt: argument("--financial-report-published-at", "未知"),
  title: argument("--financial-report-title", "未知"),
  url: argument("--financial-report-url", "未知"),
};
const internalForecastCoverage = argument("--internal-forecast-coverage", "基准未读取内部研报预测账本；仅用于验证外部预测补充模板，不得据此声称市场一致预期。");
const [authText, configText] = await Promise.all([
  readFile(`${process.env.HOME}/.codex/auth.json`, "utf8"),
  readFile(new URL("../config/research-web-search-packages.json", import.meta.url), "utf8"),
]);
const apiKey = String(JSON.parse(authText).OPENAI_API_KEY || "").trim();
if (!apiKey) throw new Error("local OpenAI credential is unavailable");
const config = JSON.parse(configText);
const definition = config.packages[packageKind];
if (!definition) throw new Error(`unsupported package: ${packageKind}`);
const packagePrompts = {
  latest_annual_report: RESEARCH_WEB_SEARCH_LATEST_ANNUAL_REPORT_PROMPT,
  recent_filings: RESEARCH_WEB_SEARCH_RECENT_FILINGS_PROMPT,
  industry_market: RESEARCH_WEB_SEARCH_INDUSTRY_MARKET_PROMPT,
  peer_set: RESEARCH_WEB_SEARCH_PEER_SET_PROMPT,
  forecast_consensus: RESEARCH_WEB_SEARCH_FORECAST_CONSENSUS_PROMPT,
  event_risk: RESEARCH_WEB_SEARCH_EVENT_RISK_PROMPT,
};
const prompt = render(packagePrompts[packageKind], {
  SECURITY_CODE: securityCode,
  SECURITY_NAME: securityCode === "300308.SZ" ? "中际旭创" : "名称未提供",
  MARKET: securityCode.endsWith(".HK") ? "HK" : securityCode.endsWith(".US") ? "US" : "A",
  CURRENCY: securityCode.endsWith(".HK") ? "HKD" : securityCode.endsWith(".US") ? "USD" : "CNY",
  PACKAGE_LABEL: definition.label,
  TAB_IDS: definition.tabs.join(", "),
  LATEST_FINANCIAL_REPORT_PERIOD: latestFinancialReport.period,
  LATEST_FINANCIAL_REPORT_PUBLISHED_AT: latestFinancialReport.publishedAt,
  LATEST_FINANCIAL_REPORT_TITLE: latestFinancialReport.title,
  LATEST_FINANCIAL_REPORT_URL: latestFinancialReport.url,
  INTERNAL_FORECAST_COVERAGE: internalForecastCoverage,
  FINANCIAL_DISCLOSURE_BOUNDARY: latestFinancialReport.period !== "未知" && latestFinancialReport.publishedAt !== "未知" && latestFinancialReport.url !== "未知"
    ? `已确认：最新可用法定财报截至 ${latestFinancialReport.period}；于 ${latestFinancialReport.publishedAt} 发布；标题《${latestFinancialReport.title}》；原文 ${latestFinancialReport.url}。该边界由命令行传入。`
    : "边界未知：基准脚本未传入已确认的法定财报期间。不得猜测最新财报期间；仅可在原文明确时记录。",
});
const baseUrl = String(process.env.OPENAI_BASE_URL || process.env.LLM_BASE_URL || "https://api.m2ai.cc/api/v1/openai").replace(/\/+$/, "");
const started = performance.now();
const response = await fetch(`${baseUrl}/responses`, {
  method: "POST",
  headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "text/event-stream" },
  body: JSON.stringify({
    model: config.model,
    store: false,
    stream: true,
    reasoning: { effort },
    tools: [{ type: "web_search", search_context_size: "high" }],
    tool_choice: "required",
    instructions: RESEARCH_WEB_SEARCH_SOURCE_PACKAGE_SYSTEM_PROMPT,
    input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
  }),
});
if (!response.ok || !response.body) {
  throw new Error(`responses request failed: status=${response.status} body=${(await response.text()).slice(0, 1000)}`);
}

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
let output = "";
let firstEventMs = null;
let firstTextMs = null;
const eventTypes = new Set();
const citations = [];
const queries = [];
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  if (firstEventMs === null) firstEventMs = Math.round(performance.now() - started);
  buffer += decoder.decode(value, { stream: true });
  for (;;) {
    const boundary = buffer.indexOf("\n\n");
    if (boundary < 0) break;
    const frame = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 2);
    const payload = frame.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim()).join("\n");
    if (!payload || payload === "[DONE]") continue;
    let event;
    try { event = JSON.parse(payload); } catch { continue; }
    if (event.type) eventTypes.add(event.type);
    if (event.type === "response.output_text.delta") {
      if (firstTextMs === null) firstTextMs = Math.round(performance.now() - started);
      output += event.delta || "";
    }
    collect(event, citations, queries);
  }
}

const elapsedMs = Math.round(performance.now() - started);
let result;
try {
  const parsed = JSON.parse(output.replace(/^```json\s*|\s*```$/g, ""));
  const records = Array.isArray(parsed.evidence_records) ? parsed.evidence_records : [];
  const acceptedStatuses = new Set(["verified", "unavailable", "uncited", "citation_unquoted", "format_incomplete"]);
  const persistableRecords = records.filter((item) => acceptedStatuses.has(item?.status));
  result = {
    configVersion: config.version,
    model: config.model,
    packageKind,
    securityCode,
    prompt,
    effort, elapsedMs, firstEventMs, firstTextMs,
    citationCount: new Set(citations).size,
    queryCount: new Set(queries).size,
    recordCount: records.length,
    persistableRecordCount: persistableRecords.length,
    verifiedCount: records.filter((item) => item?.status === "verified").length,
    unavailableCount: records.filter((item) => item?.status === "unavailable").length,
    invalidStatusCount: records.filter((item) => !acceptedStatuses.has(item?.status)).length,
    statusCounts: Object.fromEntries([...acceptedStatuses].map((status) => [status, records.filter((item) => item?.status === status).length])),
    invalidTabCount: records.filter((item) => !definition.tabs.includes(item?.tab_id)).length,
    summary: String(parsed.summary || "").slice(0, 500),
    facts: records.map((item) => ({
      key: item?.field_key,
      status: item?.status,
      subject: item?.subject,
      statement: String(item?.statement || "").slice(0, 200),
      source: item?.source_title || null,
    })),
    modelOutput: output,
    eventTypes: [...eventTypes],
  };
} catch (error) {
  result = { configVersion: config.version, model: config.model, packageKind, securityCode, prompt, effort, elapsedMs, firstEventMs, firstTextMs, citationCount: new Set(citations).size, queryCount: new Set(queries).size, parseError: String(error), modelOutput: output, eventTypes: [...eventTypes] };
}
const serialized = `${JSON.stringify(result, null, 2)}\n`;
if (outputPath) await writeFile(outputPath, serialized, "utf8");
process.stdout.write(serialized);

function argument(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "") : fallback;
}

function render(template, values) {
  return Object.entries(values).reduce((result, [key, value]) => result.replaceAll(`{{${key}}}`, value), template);
}

function collect(value, citations, queries) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { value.forEach((item) => collect(item, citations, queries)); return; }
  if (value.type === "url_citation" && typeof value.url === "string") citations.push(value.url);
  if (value.type === "web_search_call" && typeof value.action?.query === "string") queries.push(value.action.query);
  Object.values(value).forEach((item) => collect(item, citations, queries));
}
