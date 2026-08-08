#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { SharedLlmClient, createResponsesProvider } from "@m2ai/shared-llm-client";
import { RESEARCH_OPERATING_ANALYSIS_PROMPT } from "./generated/prompt-text.mjs";
import { fetchLocalWorker } from "./lib/local-worker-request.mjs";

const baseUrl = String(process.env.OPERATING_ANALYSIS_RUNNER_BASE_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");
const config = await loadConfig();
const apiKey = await resolveApiKey();
const modelBaseUrl = String(process.env.OPENAI_BASE_URL || process.env.LLM_BASE_URL || "https://api.m2ai.cc/api/v1/openai").replace(/\/+$/, "");
const runnerInstanceId = `operating-analysis-runner:${randomUUID()}`;

class WorkerUnavailableError extends Error {}

if (!apiKey) throw new Error("local operating-analysis runner requires OPENAI_API_KEY or ~/.codex/auth.json");

async function loadConfig() {
  const parsed = JSON.parse(await readFile(new URL("../config/research-operating-analysis.json", import.meta.url), "utf8"));
  if (parsed?.model !== "gpt-5.6-luna" || parsed?.reasoningEffort !== "high" || parsed?.webSearch?.required !== true) {
    throw new Error("research-operating-analysis config must use gpt-5.6-luna, default high reasoning, and required Web Search");
  }
  return parsed;
}

async function resolveApiKey() {
  if (typeof process.env.OPENAI_API_KEY === "string" && process.env.OPENAI_API_KEY.trim()) return process.env.OPENAI_API_KEY.trim();
  if (typeof process.env.LLM_API_KEY === "string" && process.env.LLM_API_KEY.trim()) return process.env.LLM_API_KEY.trim();
  try {
    const auth = JSON.parse(await readFile(`${process.env.HOME}/.codex/auth.json`, "utf8"));
    return typeof auth?.OPENAI_API_KEY === "string" ? auth.OPENAI_API_KEY.trim() : "";
  } catch { return ""; }
}

async function request(path, init = {}) {
  let response;
  try {
    response = await fetchLocalWorker(`${baseUrl}${path}`, init);
  } catch (error) {
    throw new WorkerUnavailableError(`local Worker is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const body = await response.json().catch(() => null);
  if (response.status >= 500) throw new WorkerUnavailableError(body?.msg || `local Worker endpoint failed: ${response.status}`);
  if (!response.ok || body?.code !== 200) throw new Error(body?.msg || `operating-analysis endpoint failed: ${response.status}`);
  return body.data;
}

async function buildInput(code) {
  const [overview, income] = await Promise.all([
    request(`/api/company/overview?code=${encodeURIComponent(code)}`),
    request(`/api/finance/income?code=${encodeURIComponent(code)}&format=read-model`),
  ]);
  return {
    schemaVersion: "operating-analysis-prompt-context.v6",
    security: { code, name: overview?.name || "名称未返回" },
    reportingStatus: buildReportingStatus(income),
    marketSnapshot: buildMarketSnapshot(overview),
  };
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function buildMarketSnapshot(overview) {
  return {
    price: {
      asOf: String(overview?.marketDate || "") || null,
      latestPrice: numberOrNull(overview?.latestPrice),
      source: String(overview?.source || "") || null,
    },
    valuationMultiples: {
      marketCapYi: numberOrNull(overview?.marketCapYi),
      peTtm: numberOrNull(overview?.peTtm),
      pb: numberOrNull(overview?.pb),
      psTtm: numberOrNull(overview?.psTtm),
      pcfTtm: numberOrNull(overview?.pcfTtm),
      currency: "CNY",
      marketCapUnit: "CNY 100m",
    },
  };
}

function statementRows(statement) {
  return (statement?.rows || []).slice().sort((a, b) => String(b.reportDate).localeCompare(String(a.reportDate)));
}

function payloadOf(row) {
  return row?.payload && typeof row.payload === "object" ? row.payload : {};
}

function provisionalDataSource(row) {
  const dataSource = String(payloadOf(row).dataSource || "");
  if (dataSource === "performance_forecast" || row?.source === "eastmoney_forecast") return "业绩预告";
  if (dataSource === "performance_report" || row?.source === "eastmoney_performance") return "业绩快报";
  return null;
}

function fiscalPeriodIsAnnual(row) {
  const period = String(row.fiscalPeriod || payloadOf(row).FISCAL_PERIOD || "").toLowerCase();
  return /^(12m|fy|annual|年报)$/.test(period) || /年度/.test(period);
}

function reportLabel(row) {
  const date = String(row?.reportDate || "");
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(date);
  if (!match) return date || null;
  const [, year, month] = match;
  if (fiscalPeriodIsAnnual(row)) return `${year}FY`;
  const quarter = { "03": "Q1", "06": "Q2", "09": "Q3", "12": "Q4" }[month];
  return quarter ? `${year}${quarter}` : date;
}

function reportDescriptor(row) {
  if (!row) return null;
  return { period: reportLabel(row), endedAt: String(row.reportDate || "") || null };
}

function buildReportingStatus(income) {
  const rows = statementRows(income);
  const formalRows = rows.filter((row) => !provisionalDataSource(row));
  const latestFiledFinancialReport = formalRows[0] || null;
  const latestAnnual = formalRows.find(fiscalPeriodIsAnnual) || null;
  const laterPerformanceRows = latestFiledFinancialReport
    ? rows.filter((row) => provisionalDataSource(row) && String(row.reportDate) > String(latestFiledFinancialReport.reportDate))
    : rows.filter((row) => provisionalDataSource(row));
  const latestPerformanceDate = laterPerformanceRows.map((row) => String(row.reportDate || "")).sort().at(-1) || null;
  const latestPerformanceRows = latestPerformanceDate ? laterPerformanceRows.filter((row) => String(row.reportDate) === latestPerformanceDate) : [];
  const laterPerformanceUpdate = latestPerformanceDate
    ? { period: reportLabel(latestPerformanceRows[0]), endedAt: latestPerformanceDate, types: [...new Set(latestPerformanceRows.map(provisionalDataSource).filter(Boolean))] }
    : null;
  return {
    latestFiledFinancialReport: reportDescriptor(latestFiledFinancialReport),
    latestAnnualFinancialReport: reportDescriptor(latestAnnual),
    ...(laterPerformanceUpdate ? { laterPerformanceUpdate } : {}),
  };
}

function prompt(input) {
  return renderPrompt(RESEARCH_OPERATING_ANALYSIS_PROMPT, {
    SECURITY_NAME: input.security.name,
    SECURITY_CODE: input.security.code,
    REPORTING_STATUS_BRIEF: formatReportingStatus(input.reportingStatus),
    MARKET_SNAPSHOT_BRIEF: formatMarketSnapshot(input.marketSnapshot),
  });
}

function formatReportingStatus(status) {
  const reportLine = (label, report) => report?.period && report?.endedAt
    ? `- ${label}：${report.period}，截至 ${report.endedAt}。`
    : `- ${label}：系统当前未确认。`;
  const lines = [
    reportLine("最新正式财报", status?.latestFiledFinancialReport),
    reportLine("最近年报", status?.latestAnnualFinancialReport),
  ];
  const update = status?.laterPerformanceUpdate;
  if (update?.period && update?.endedAt) {
    const types = Array.isArray(update.types) && update.types.length ? `（${update.types.join("、")}）` : "";
    lines.push(`- 此后业绩更新：${update.period}${types}，截至 ${update.endedAt}；它不是正式财报。`);
  }
  return lines.join("\n");
}

function formatNumber(value, maximumFractionDigits = 1) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits, minimumFractionDigits: 0 }).format(value);
}

function formatMarketSnapshot(snapshot) {
  const price = snapshot?.price || {};
  const multiples = snapshot?.valuationMultiples || {};
  const entries = [
    ["最新价", numberOrNull(price.latestPrice), "元", 2],
    ["总市值", numberOrNull(multiples.marketCapYi), "亿元", 1],
    ["PE（TTM）", numberOrNull(multiples.peTtm), "倍", 1],
    ["PB", numberOrNull(multiples.pb), "倍", 1],
    ["PS（TTM）", numberOrNull(multiples.psTtm), "倍", 1],
    ["PCF（TTM）", numberOrNull(multiples.pcfTtm), "倍", 1],
  ].filter(([, value]) => value !== null);
  if (!entries.length) return "系统当前未取得可用的价格或估值快照。";
  const asOf = String(price.asOf || "") || "日期未知";
  return [
    `快照日期：${asOf}。`,
    "",
    "| 指标 | 数值 |",
    "| --- | ---: |",
    ...entries.map(([label, value, unit, digits]) => `| ${label} | ${formatNumber(value, digits)} ${unit} |`),
  ].join("\n");
}

function renderPrompt(template, values) {
  return Object.entries(values).reduce(
    (output, [key, value]) => output.split(`{{${key}}}`).join(String(value)),
    template,
  );
}

function createClient() {
  return new SharedLlmClient({
    providers: {
      openai: createResponsesProvider({
        name: "openai",
        baseUrl: modelBaseUrl,
        apiKey,
        streamIdleTimeoutMs: config.jobTimeoutMs,
      }),
    },
    providerConcurrency: { openai: 1 },
  });
}

async function generateReport(claim, input) {
  let reportMarkdown = "";
  let reasoningMarkdown = "";
  let checkpointedLength = 0;
  let checkpointedAt = 0;
  let lastCheckpointError = "";
  const checkpoint = async (force = false) => {
    const now = Date.now();
    const enoughText = reportMarkdown.length + reasoningMarkdown.length - checkpointedLength >= config.streamCheckpoint.minChars;
    const enoughTime = now - checkpointedAt >= config.streamCheckpoint.intervalMs;
    if ((!reportMarkdown && !reasoningMarkdown) || !force && !enoughText && !enoughTime) return;
    const reportSnapshot = reportMarkdown;
    const reasoningSnapshot = reasoningMarkdown;
    try {
      await request(`/api/research/operating-analysis-jobs/${encodeURIComponent(claim.securityCode)}/checkpoint`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ partialReportMarkdown: reportSnapshot, partialReasoningMarkdown: reasoningSnapshot, runnerInstanceId }),
      });
      checkpointedLength = reportSnapshot.length + reasoningSnapshot.length;
      checkpointedAt = Date.now();
      lastCheckpointError = "";
    } catch (error) {
      if (!(error instanceof WorkerUnavailableError)) throw error;
      const message = error.message;
      if (message !== lastCheckpointError) {
        console.warn(`[operating-analysis-runner] checkpoint delayed for ${claim.securityCode}: ${message}`);
        lastCheckpointError = message;
      }
    }
  };
  const response = await createClient().streamText({
    provider: "openai",
    model: config.model,
    instructions: "你是严谨的投资研究员。遵守用户给定的报告结构；只陈述可追溯证据支持的事实、计算和判断，不以搜索不到的信息填空。",
    input: [{ role: "user", content: [{ type: "input_text", text: prompt(input) }] }],
    allowReasoning: true,
    reasoningEffort: claim.reasoningEffort,
    tools: [{ type: "web_search", searchContextSize: config.webSearch.searchContextSize }],
    toolChoice: "required",
    maxOutputTokens: config.maxOutputTokens,
    cacheEnabled: false,
    signal: AbortSignal.timeout(config.jobTimeoutMs),
    onText: async (delta) => {
      reportMarkdown += delta;
      await checkpoint();
    },
    onReasoning: async (delta) => {
      reasoningMarkdown += delta;
      await checkpoint();
    },
  });
  reportMarkdown = response.text.trim();
  reasoningMarkdown = response.reasoningText.trim();
  await checkpoint(true);
  return { reportMarkdown, reasoningMarkdown, webSearch: response.webSearch ?? null };
}

async function completeWithWorkerRecovery(code, body) {
  const deadline = Date.now() + config.persistenceRecovery.maxWaitMs;
  let lastError = null;
  while (Date.now() <= deadline) {
    try {
      await request(`/api/research/operating-analysis-jobs/${encodeURIComponent(code)}/complete`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      return;
    } catch (error) {
      if (!(error instanceof WorkerUnavailableError)) throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, config.persistenceRecovery.retryIntervalMs));
    }
  }
  throw lastError ?? new WorkerUnavailableError("local Worker did not return while persisting the completed report");
}

async function runOperatingAnalysisOnce() {
  const claim = await request("/api/research/operating-analysis-jobs/claim-next", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runnerInstanceId }),
  });
  if (!claim) return false;
  try {
    const input = await buildInput(claim.securityCode);
    const inputFingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const result = await generateReport(claim, input);
    if (!result.reportMarkdown) throw new Error("llm-client stream completed without output text");
    await completeWithWorkerRecovery(claim.securityCode, {
        input: {
          ...input,
          modelRun: {
            client: "llm-client",
            model: config.model,
            reasoningEffort: claim.reasoningEffort,
            webSearch: result.webSearch,
          },
        },
        inputFingerprint,
        reportMarkdown: result.reportMarkdown,
        reasoningMarkdown: result.reasoningMarkdown,
        runnerInstanceId,
    });
    console.log(`[operating-analysis-runner] completed ${claim.securityCode} chars=${result.reportMarkdown.length}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof WorkerUnavailableError) {
      console.warn(`[operating-analysis-runner] Worker remained unavailable after ${config.persistenceRecovery.maxWaitMs}ms; preserved task state for retry: ${message}`);
      return false;
    }
    console.error(`[operating-analysis-runner] failed ${claim.securityCode}: ${message}`);
    await persistFailure(`/api/research/operating-analysis-jobs/${encodeURIComponent(claim.securityCode)}/fail`, { error: message, runnerInstanceId });
  }
  return true;
}

async function persistFailure(path, body) {
  try {
    await request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (error) {
    console.error(`[operating-analysis-runner] could not persist failure: ${error instanceof Error ? error.message : String(error)}`);
  }
}

let active = false;
let runnerLeaseActive = false;
let runnerLeaseHeartbeatInFlight = false;
let lastLeaseMessage = "";

async function heartbeatRunnerLease() {
  if (runnerLeaseHeartbeatInFlight) return runnerLeaseActive;
  runnerLeaseHeartbeatInFlight = true;
  try {
    const lease = await request("/api/research/operating-analysis-runner-lease/heartbeat", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runnerInstanceId }),
    });
    runnerLeaseActive = lease?.active === true;
    const message = runnerLeaseActive ? "" : "another local operating-analysis runner still owns the active lease";
    if (message && message !== lastLeaseMessage) console.warn(`[operating-analysis-runner] ${message}`);
    lastLeaseMessage = message;
  } catch (error) {
    runnerLeaseActive = false;
    const message = error instanceof Error ? error.message : String(error);
    if (message !== lastLeaseMessage) console.warn(`[operating-analysis-runner] cannot renew runner lease: ${message}`);
    lastLeaseMessage = message;
  } finally {
    runnerLeaseHeartbeatInFlight = false;
  }
  return runnerLeaseActive;
}

async function poll() {
  if (active) return;
  active = true;
  try {
    if (!await heartbeatRunnerLease()) return;
    while (await runOperatingAnalysisOnce()) { /* drain queued local work */ }
  } catch (error) {
    console.warn(`[operating-analysis-runner] polling paused: ${error instanceof Error ? error.message : String(error)}`);
  } finally { active = false; }
}

console.log(`[operating-analysis-runner] ${runnerInstanceId} using llm-client ${config.model} with required Web Search; polling ${baseUrl} every 5000ms`);
void poll();
const timer = setInterval(() => { void poll(); }, 5_000);
const heartbeatTimer = setInterval(() => { void heartbeatRunnerLease(); }, 5_000);
process.once("SIGINT", () => { clearInterval(timer); clearInterval(heartbeatTimer); process.exit(0); });
process.once("SIGTERM", () => { clearInterval(timer); clearInterval(heartbeatTimer); process.exit(0); });
