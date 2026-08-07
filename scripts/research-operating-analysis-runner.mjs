#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RESEARCH_OPERATING_ANALYSIS_PROMPT } from "./generated/prompt-text.mjs";

const execFileAsync = promisify(execFile);
const baseUrl = String(process.env.OPERATING_ANALYSIS_RUNNER_BASE_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");
const webctl = process.env.WEBCTL_BIN || "/Users/terry/.local/bin/webctl";
// A WebQA report is deliberately long-running: ChatGPT may research before it
// starts writing and then stream a substantial Markdown answer. This bound is
// only a safety limit for a genuinely stuck provider/session, not a UI wait.
const WEBQA_COMPLETION_TIMEOUT_MS = 20 * 60_000;
const runnerInstanceId = `operating-analysis-runner:${randomUUID()}`;

class WorkerUnavailableError extends Error {}

async function request(path, init = {}) {
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, init);
  } catch (error) {
    throw new WorkerUnavailableError(`local Worker is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const body = await response.json().catch(() => null);
  if (response.status >= 500) throw new WorkerUnavailableError(body?.msg || `local Worker endpoint failed: ${response.status}`);
  if (!response.ok || body?.code !== 200) throw new Error(body?.msg || `operating-analysis endpoint failed: ${response.status}`);
  return body.data;
}

async function buildInput(code, webqaRequestConversationId) {
  const [overview, income] = await Promise.all([
    request(`/api/company/overview?code=${encodeURIComponent(code)}`),
    request(`/api/finance/income?code=${encodeURIComponent(code)}&format=read-model`),
  ]);
  return {
    schemaVersion: "operating-analysis-prompt-context.v5",
    security: { code, name: overview?.name || "名称未返回" },
    webqaRequestConversationId,
    reportingStatus: buildReportingStatus(income),
    marketSnapshot: buildMarketSnapshot(overview),
  };
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function buildMarketSnapshot(overview) {
  return {
    // Every market multiple is a point-in-time observation. It is supplied
    // to avoid redundant Web search, not an authorization to invent forecasts.
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

async function runOperatingAnalysisOnce() {
  const claim = await request("/api/research/operating-analysis-jobs/claim-next", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runnerInstanceId }),
  });
  if (!claim) return false;
  try {
    const conversationId = String(claim.webqaConversationId || `${claim.promptVersion}-${claim.securityCode}`);
    const input = await buildInput(claim.securityCode, conversationId);
    const inputFingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const result = await completeOperatingAnalysisWebQA(claim, conversationId, prompt(input));
    const reportMarkdown = String(result.answer_text || "").trim();
    if (!["completed", "recovered"].includes(String(result.status || ""))) throw new Error(`WebQA did not report completion: ${String(result.status || "missing status")}`);
    const completedInput = {
      ...input,
      webqaSession: {
        conversationId: String(result.conversation_id || conversationId),
        requestConversationId: conversationId,
        sessionUrl: String(result.provider_url || result.session_ref || ""),
      },
    };
    await request(`/api/research/operating-analysis-jobs/${encodeURIComponent(claim.securityCode)}/complete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: completedInput, inputFingerprint, reportMarkdown, runnerInstanceId }) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof WorkerUnavailableError) {
      console.warn(`[operating-analysis-runner] Worker disconnected while processing ${claim.securityCode}; keeping the job recoverable: ${message}`);
      return false;
    }
    if (/job lease is no longer owned/i.test(message)) {
      console.warn(`[operating-analysis-runner] ownership moved while processing ${claim.securityCode}; leaving the replacement runner to recover it.`);
      return false;
    }
    console.error(`[operating-analysis-runner] failed ${claim.securityCode}: ${message}`);
    await persistFailure(`/api/research/operating-analysis-jobs/${encodeURIComponent(claim.securityCode)}/fail`, { error: message, runnerInstanceId });
  }
  return true;
}

async function runWebQATask(args) {
  const { stdout } = await execFileAsync(webctl, args, { maxBuffer: 2 * 1024 * 1024 });
  return JSON.parse(stdout);
}

async function waitForWebQATask(taskId) {
  const deadline = Date.now() + WEBQA_COMPLETION_TIMEOUT_MS + 30_000;
  while (Date.now() < deadline) {
    const task = await runWebQATask(["webqa", "task", "get", taskId]);
    if (task.status === "completed") return {
      status: "completed", answer_text: String(task.answer_text || ""),
      conversation_id: String(task.conversation_id_provider || ""), provider_url: String(task.provider_url || ""),
    };
    if (["failed", "cancelled"].includes(String(task.status))) throw new Error(`WebQA task ${task.status}: ${String(task.error || "no detail")}`);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  throw new Error(`WebQA task ${taskId} exceeded its completion deadline`);
}

async function submitWebQATask(conversationId, question, { newSession = false, mode = "ask", idempotencyKey = "" } = {}) {
  const args = ["webqa", "task", "submit", "--platform", "stock-info", "--conversation-id", conversationId,
    "--mode", mode, "--timeout-ms", String(WEBQA_COMPLETION_TIMEOUT_MS)];
  if (newSession) args.push("--new-session");
  if (idempotencyKey) args.push("--idempotency-key", idempotencyKey);
  if (mode !== "recover_only") args.push(question);
  const task = await runWebQATask(args);
  if (!task.task_id) throw new Error("WebQA gateway accepted no task id");
  return task;
}

async function completeOperatingAnalysisWebQA(claim, conversationId, question) {
  let taskId = String(claim.webqaTaskId || "").trim();
  if (!taskId) {
    const submitted = await submitWebQATask(conversationId, question, {
      newSession: claim.startNewSession === true,
      // Once a WebQA task has been persisted, recovery is gateway-owned and
      // never resends this business prompt. A non-new claim without a task is
      // therefore a read-only recovery attempt, not an implicit retry.
      mode: claim.startNewSession === true ? "ask" : "recover_only",
      idempotencyKey: `operating:${claim.securityCode}:${claim.promptVersion}:${conversationId}`,
    });
    taskId = String(submitted.task_id);
    await request(`/api/research/operating-analysis-jobs/${encodeURIComponent(claim.securityCode)}/webqa-task`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ webqaTaskId: taskId, runnerInstanceId }),
    });
  }
  const result = await waitForWebQATask(taskId);
  assertCompleteOperatingAnalysis(String(result.answer_text || ""));
  return result;
}

async function persistFailure(path, body) {
  try {
    await request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (error) {
    // A Worker restart leaves the job running. Its healthy replacement
    // runner will reacquire the short runner lease and resume this same
    // ChatGPT conversation rather than starting another search.
    console.error(`[operating-analysis-runner] could not persist failure: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertCompleteOperatingAnalysis(reportMarkdown) {
  const headings = ["经营与产业研究", "商业模式与赚钱机制", "市场空间、产品边界与收入传导", "行业阶段、供给约束与竞争", "当前增长、驱动与可持续性", "利润质量、现金转换与营运资本", "资本效率与资本配置", "证券定价与反证", "当前价格隐含的经营要求", "关键估值情景与假设", "主报告最可能出错之处与反面证据", "投资逻辑失效路径", "后续跟踪指标与触发阈值"];
  const missing = headings.filter((heading) => !reportMarkdown.includes(heading));
  if (reportMarkdown.length < 1_400 || missing.length) {
    throw new Error(`WebQA returned an incomplete streaming prefix (length=${reportMarkdown.length}; missing_sections=${missing.join("、") || "none"})`);
  }
}

async function runOnce() {
  // This runner creates one complete investment-research document per task.
  return await runOperatingAnalysisOnce();
}

let active = false;
let runnerLeaseActive = false;
let runnerLeaseHeartbeatInFlight = false;
let lastLeaseMessage = "";

async function heartbeatRunnerLease() {
  if (runnerLeaseHeartbeatInFlight) return runnerLeaseActive;
  runnerLeaseHeartbeatInFlight = true;
  try {
    const lease = await request("/api/research/webqa-runner-lease/heartbeat", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runnerInstanceId }),
    });
    runnerLeaseActive = lease?.active === true;
    const message = runnerLeaseActive ? "" : "another local WebQA runner still owns the active lease";
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
    while (await runOnce()) { /* drain queued local work */ }
  } catch (error) {
    console.warn(`[operating-analysis-runner] polling paused: ${error instanceof Error ? error.message : String(error)}`);
  }
  finally { active = false; }
}

console.log(`[operating-analysis-runner] ${runnerInstanceId} polling ${baseUrl} every 5000ms`);
void poll();
const timer = setInterval(() => { void poll(); }, 5_000);
const heartbeatTimer = setInterval(() => { void heartbeatRunnerLease(); }, 5_000);
process.once("SIGINT", () => { clearInterval(timer); clearInterval(heartbeatTimer); process.exit(0); });
process.once("SIGTERM", () => { clearInterval(timer); clearInterval(heartbeatTimer); process.exit(0); });
