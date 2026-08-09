#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { SharedLlmClient } from "@m2ai/shared-llm-client";
import {
  RESEARCH_OPERATING_ANALYSIS_COMPANY_BASELINE_PROMPT,
  RESEARCH_OPERATING_ANALYSIS_FINANCIAL_STAGE_PROMPT,
  RESEARCH_OPERATING_ANALYSIS_INDUSTRY_VALIDATION_PROMPT,
  RESEARCH_OPERATING_ANALYSIS_OPERATING_STAGE_PROMPT,
  RESEARCH_OPERATING_ANALYSIS_VALUATION_CONCLUSION_PROMPT,
  RESEARCH_OPERATING_ANALYSIS_VALUATION_INPUTS_PROMPT,
} from "./generated/prompt-text.mjs";
import { fetchLocalRuntime } from "./lib/local-runtime-request.mjs";
import { buildOperatingAnalysisFinancialContext, financialSnapshotForStage } from "./lib/operating-analysis-financial-snapshot.mjs";
import { createLocalJobProvider, loadLocalJobRuntimeConfig, resolveLocalJobApiKey } from "./lib/local-job-provider-registry.mjs";
import { localRuntimeError, localRuntimeLog } from "./lib/local-runtime-log.mjs";

const baseUrl = String(process.env.OPERATING_ANALYSIS_RUNNER_BASE_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");
const config = await loadConfig();
const runtimeConfig = await loadLocalJobRuntimeConfig();
const runtimeHandler = runtimeConfig?.handlers?.researchOperatingAnalysis;
const apiKey = await resolveLocalJobApiKey();
const runnerInstanceId = `operating-analysis-runner:${randomUUID()}`;
const INSTRUCTIONS = "你是严谨的投资研究员。只使用本阶段允许的证据；不以模型记忆填补缺口；严格按输出格式返回。";
const stages = [
  ["company_baseline", "公司事实基线", "json", true, RESEARCH_OPERATING_ANALYSIS_COMPANY_BASELINE_PROMPT],
  ["industry_validation", "行业、产业链与外部验证", "json", true, RESEARCH_OPERATING_ANALYSIS_INDUSTRY_VALIDATION_PROMPT],
  ["operating_analysis", "经营、增长与竞争分析", "markdown", false, RESEARCH_OPERATING_ANALYSIS_OPERATING_STAGE_PROMPT],
  ["financial_analysis", "财务、资本、治理与生存能力", "markdown", false, RESEARCH_OPERATING_ANALYSIS_FINANCIAL_STAGE_PROMPT],
  ["valuation_inputs", "情景假设、估值输入与风险结构", "json", false, RESEARCH_OPERATING_ANALYSIS_VALUATION_INPUTS_PROMPT],
  ["valuation_conclusion", "估值解释、反证与最终结论", "markdown", false, RESEARCH_OPERATING_ANALYSIS_VALUATION_CONCLUSION_PROMPT],
];
class WorkerUnavailableError extends Error {}
if (!apiKey) throw new Error("local operating-analysis runner requires OPENAI_API_KEY or ~/.codex/auth.json");

async function loadConfig() {
  const parsed = JSON.parse(await readFile(new URL("../config/research-operating-analysis.json", import.meta.url), "utf8"));
  if (parsed?.model !== "gpt-5.6-luna" || !Number.isInteger(parsed?.jobTimeoutMs) || parsed.jobTimeoutMs < 600_000 || !Number.isInteger(parsed?.webSearchJobTimeoutMs) || parsed.webSearchJobTimeoutMs < 1_800_000 || !Number.isInteger(parsed?.streamIdleTimeoutMs) || parsed.streamIdleTimeoutMs < 30_000 || parsed.streamIdleTimeoutMs >= parsed.jobTimeoutMs || parsed?.reasoningEffort !== "max" || parsed?.webSearch?.required !== true) throw new Error("research-operating-analysis config must use gpt-5.6-luna, long general and Web Search job timeouts, a bounded general stream idle timeout, default max reasoning, and required Web Search");
  return parsed;
}
async function request(path, init = {}) {
  let response;
  try { response = await fetchLocalRuntime(`${baseUrl}${path}`, init); } catch (error) { throw new WorkerUnavailableError(`local Node runtime is unavailable: ${error instanceof Error ? error.message : String(error)}`); }
  const body = await response.json().catch(() => null);
  // A reachable Worker can return 5xx for upstream business failures (for
  // example an expired Xueqiu cookie). Only transport failures above are
  // resumable Worker interruptions; application failures must stop the job.
  if (response.status >= 500) throw new Error(body?.msg || `local Node runtime endpoint failed: ${response.status}`);
  if (!response.ok || body?.code !== 200) throw new Error(body?.msg || `operating-analysis endpoint failed: ${response.status}`);
  return body.data;
}
const concurrency = positiveInteger(process.env.OPERATING_ANALYSIS_RUNNER_CONCURRENCY, runtimeHandler?.concurrency || 1);
const pollIntervalMs = positiveInteger(process.env.OPERATING_ANALYSIS_RUNNER_POLL_INTERVAL_MS, runtimeHandler?.pollIntervalMs || 5_000);
const client = new SharedLlmClient({
  providers: {
    openai: createLocalJobProvider(apiKey, { streamIdleTimeoutMs: config.streamIdleTimeoutMs }),
  },
  providerConcurrency: { openai: concurrency },
});
const post = (path, body) => request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const text = (value) => typeof value === "string" ? value.trim() : "";
const json = (value) => { try { return JSON.parse(text(value).replace(/^```json\s*|\s*```$/g, "")); } catch { return null; } };
function positiveInteger(value, fallback) { const parsed = Number(value); return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback; }

async function buildInput(code) {
  const [overview, income, balance, cashflow] = await Promise.all([
    request(`/api/company/overview?code=${encodeURIComponent(code)}`),
    request(`/api/finance/income?code=${encodeURIComponent(code)}&format=read-model`),
    request(`/api/finance/balance?code=${encodeURIComponent(code)}&format=read-model`),
    request(`/api/finance/cashflow?code=${encodeURIComponent(code)}&format=read-model`),
  ]);
  const latest = (income?.rows || []).slice().sort((a, b) => String(b.reportDate).localeCompare(String(a.reportDate)))[0] || {};
  const financialContext = buildOperatingAnalysisFinancialContext({ income, balance, cashflow });
  return {
    researchTaskId: `operating-analysis:${code}`,
    asOf: new Date().toISOString(),
    company: { name: String(overview?.name || "名称未返回"), reportingCurrency: "CNY" },
    security: { securityCode: code, listingVenue: code.split(".").at(-1) || "未知", tradingCurrency: "CNY" },
    reportingBoundary: { latestFiledPeriod: String(latest.reportDate || "") || null, latestAnnualPeriod: latestAnnualPeriod(income), laterProvisionalUpdates: provisionalUpdates(income) },
    marketSnapshot: { asOf: String(overview?.marketDate || "") || null, price: finite(overview?.latestPrice), marketCapitalization: finite(overview?.marketCapYi), currency: "CNY", reportedMultiples: { peTtm: finite(overview?.peTtm), pb: finite(overview?.pb), psTtm: finite(overview?.psTtm), pcfTtm: finite(overview?.pcfTtm) } },
    financialDataSnapshot: financialContext.descriptor,
    financialContext,
    industryProfile: null,
    upstreamArtifactRefs: [],
  };
}
function finite(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function latestAnnualPeriod(income) { const row = (income?.rows || []).find((item) => /12M|FY|annual|年度/i.test(String(item.fiscalPeriod || item?.payload?.FISCAL_PERIOD || ""))); return row?.reportDate || null; }
function provisionalUpdates(income) { return (income?.rows || []).filter((item) => /forecast|performance/i.test(String(item.source || item?.payload?.dataSource || ""))).map((item) => ({ period: item.reportDate, source: item.source })); }
function prompt(template, input) { return template.replace("{{INPUT_DATA}}", JSON.stringify(input, null, 2)); }
function terminal(status) { return ["complete", "partial", "blocked", "not_applicable"].includes(status); }
function stageState(task, key) { return (task?.job?.stages || []).find((item) => item.stageKey === key); }
function artifact(task, key) { const item = stageState(task, key); return item?.output ?? null; }

async function runStage(claim, baseInput, task, definition) {
  const [key, label, format, webSearch, template] = definition;
  const prior = stageState(task, key);
  if (terminal(prior?.status)) return prior.output;
  const upstream = Object.fromEntries(stages.slice(0, stages.findIndex((item) => item[0] === key)).map(([upstreamKey]) => [upstreamKey, artifact(task, upstreamKey)]));
  const { financialContext, ...sharedInput } = baseInput;
  const input = { ...sharedInput, financialDataSnapshot: financialSnapshotForStage(baseInput.financialDataSnapshot, financialContext, key), stage: { key, label, outputFormat: format }, upstreamArtifacts: upstream };
  const modelPrompt = { model: config.model, instructions: INSTRUCTIONS, userPrompt: prompt(template, input) };
  localRuntimeLog("research-operating-analysis", "stage_started", { job_id: claim.jobId, attempt: claim.attempt, security_code: claim.securityCode, stage_key: key });
  await post(`/api/research/operating-analysis-jobs/${encodeURIComponent(claim.securityCode)}/stages/${key}/start`, { input, prompt: modelPrompt, runnerInstanceId, attempt: claim.attempt });
  let output = ""; let checkpointed = 0; let checkpointAt = 0;
  const checkpoint = async (force = false) => {
    if (!output || (!force && output.length - checkpointed < config.streamCheckpoint.minChars && Date.now() - checkpointAt < config.streamCheckpoint.intervalMs)) return;
    await post(`/api/research/operating-analysis-jobs/${encodeURIComponent(claim.securityCode)}/stages/${key}/checkpoint`, { partialOutput: output, runnerInstanceId, attempt: claim.attempt }); checkpointed = output.length; checkpointAt = Date.now();
  };
  const llmRequest = { provider: "openai", model: config.model, instructions: modelPrompt.instructions, input: [{ role: "user", content: [{ type: "input_text", text: modelPrompt.userPrompt }] }], allowReasoning: true, reasoningEffort: claim.reasoningEffort, ...(webSearch ? { tools: [{ type: "web_search", searchContextSize: config.webSearch.searchContextSize }], toolChoice: "required" } : {}), maxOutputTokens: config.maxOutputTokens, cacheEnabled: false, signal: AbortSignal.timeout(webSearch ? config.webSearchJobTimeoutMs : config.jobTimeoutMs), ...(webSearch ? {} : { onText: async (delta) => { output += delta; await checkpoint(); } }) };
  const response = webSearch ? await client.generateText(llmRequest) : await client.streamText(llmRequest);
  output = text(response.text); await checkpoint(true);
  const parsed = format === "json" ? json(output) : output;
  if (!parsed) throw new Error(`${key} returned no valid ${format} output`);
  const status = format === "json" && terminal(parsed.status) ? parsed.status : "complete";
  const finalOutput = key === "valuation_inputs" ? { ...parsed, deterministicValuation: calculateValuation(parsed) } : parsed;
  await post(`/api/research/operating-analysis-jobs/${encodeURIComponent(claim.securityCode)}/stages/${key}/complete`, { output: finalOutput, status, runnerInstanceId, attempt: claim.attempt });
  localRuntimeLog("research-operating-analysis", "stage_completed", { job_id: claim.jobId, attempt: claim.attempt, security_code: claim.securityCode, stage_key: key, stage_status: status });
  task.job.stages = (task.job.stages || []).map((item) => item.stageKey === key ? { ...item, status, output: finalOutput } : item);
  return finalOutput;
}

/** The calculation consumes only stage-five fields; it never invents an operating assumption. */
function calculateValuation(stageFive) {
  const items = Array.isArray(stageFive?.valuationCalculationRequest?.dcfScenarios) ? stageFive.valuationCalculationRequest.dcfScenarios : [];
  const blocked = []; const results = [];
  for (const scenario of items) {
    const years = Array.isArray(scenario?.years) ? scenario.years : [];
    const values = [scenario?.openingRevenue, scenario?.openingNetWorkingCapital, scenario?.wacc, scenario?.terminalGrowth, scenario?.netDebt, scenario?.dilutedShares, ...years.flatMap((year) => [year?.revenueGrowth, year?.ebitMargin, year?.taxRate, year?.depreciationAmortizationMargin, year?.capitalExpenditureMargin, year?.netWorkingCapitalToRevenue])].map(Number);
    if (!years.length || values.some((value) => !Number.isFinite(value)) || Number(scenario.wacc) <= Number(scenario.terminalGrowth) || Number(scenario.dilutedShares) <= 0) { blocked.push({ scenario: scenario?.scenario || "unknown", reason: "DCF 输入缺失、非数值，或 WACC 不大于永续增长率" }); continue; }
    let revenue = Number(scenario.openingRevenue); let nwc = Number(scenario.openingNetWorkingCapital); let enterpriseValue = 0;
    const annuals = years.map((year, index) => { revenue *= 1 + Number(year.revenueGrowth); const ebit = revenue * Number(year.ebitMargin); const fcf = ebit * (1 - Number(year.taxRate)) + revenue * Number(year.depreciationAmortizationMargin) - revenue * Number(year.capitalExpenditureMargin) - (revenue * Number(year.netWorkingCapitalToRevenue) - nwc); nwc = revenue * Number(year.netWorkingCapitalToRevenue); enterpriseValue += fcf / ((1 + Number(scenario.wacc)) ** (index + 1)); return { fiscalYear: year.fiscalYear, revenue, ebit, freeCashFlow: fcf }; });
    const terminalValue = annuals.at(-1).freeCashFlow * (1 + Number(scenario.terminalGrowth)) / (Number(scenario.wacc) - Number(scenario.terminalGrowth)); enterpriseValue += terminalValue / ((1 + Number(scenario.wacc)) ** years.length);
    const equityValue = enterpriseValue - Number(scenario.netDebt); results.push({ scenario: scenario.scenario, currency: scenario.currency, amountScale: scenario.amountScale, annuals, enterpriseValue, equityValue, dilutedValuePerShare: equityValue / Number(scenario.dilutedShares), terminalValueShare: terminalValue / (enterpriseValue * ((1 + Number(scenario.wacc)) ** years.length)) });
  }
  return { status: results.length ? (blocked.length ? "partial" : "complete") : "blocked", method: "deterministic_dcf.v1", results, blockedItems: blocked };
}

function assembleReport(input, task) {
  const statuses = (task.job.stages || []).map((item) => `- ${item.label || item.stageKey}：${item.status}`).join("\n");
  return ["# 1. 研究范围与事实边界", `- 研究截止：${input.asOf}`, `- 公司：${input.company.name}（${input.security.securityCode}）`, "- 三张报表数值来自系统结构化财务接口；检索事实与分析判断按阶段产物区分。", "- 阶段状态：", statuses, "", text(artifact(task, "operating_analysis")), "", text(artifact(task, "financial_analysis")), "", text(artifact(task, "valuation_conclusion")), sourceIndex(task)].filter(Boolean).join("\n\n");
}
function sourceIndex(task) {
  const seen = new Set(); const entries = [artifact(task, "company_baseline"), artifact(task, "industry_validation")].flatMap((item) => Array.isArray(item?.sourceIndex) ? item.sourceIndex : []);
  const lines = entries.flatMap((item) => { const title = text(item?.sourceTitle || item?.title); const url = text(item?.sourceUrl || item?.url); const key = `${title}|${url}`; if (!title || !/^https?:\/\//.test(url) || seen.has(key)) return []; seen.add(key); return [`- [${title}](${url})`]; });
  return lines.length ? ["# 附：来源索引", ...lines].join("\n") : "";
}

async function runJob(claim) {
  const startedAt = Date.now();
  localRuntimeLog("research-operating-analysis", "started", { job_id: claim.jobId, attempt: claim.attempt, security_code: claim.securityCode });
  const heartbeatTimer = setInterval(() => {
    void post(`/api/research/operating-analysis-jobs/${encodeURIComponent(claim.securityCode)}/heartbeat`, { runnerInstanceId, attempt: claim.attempt }).catch(() => {});
  }, 10_000);
  try {
    const input = await buildInput(claim.securityCode); const task = await request(`/api/research/company/${encodeURIComponent(claim.securityCode)}/operating-analysis`);
    for (const definition of stages) { const result = await runStage(claim, input, task, definition); if (result?.status === "blocked") throw new Error(`${definition[1]} 被阻断：请补充其列出的证据或数据缺口`); }
    const report = assembleReport(input, task); const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex"); const finalPrompt = stageState(task, "valuation_conclusion")?.prompt || { model: config.model, instructions: INSTRUCTIONS, userPrompt: "六阶段任务由系统确定性组装" };
    await post(`/api/research/operating-analysis-jobs/${encodeURIComponent(claim.securityCode)}/complete`, { input: { ...input, stageArtifacts: task.job.stages }, prompt: finalPrompt, reportMarkdown: report, reasoningMarkdown: "", inputFingerprint: fingerprint, streamStats: { staged: true }, runnerInstanceId, attempt: claim.attempt });
    localRuntimeLog("research-operating-analysis", "completed", { job_id: claim.jobId, attempt: claim.attempt, security_code: claim.securityCode, duration_ms: Date.now() - startedAt });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    localRuntimeLog("research-operating-analysis", "failed", { job_id: claim.jobId, attempt: claim.attempt, security_code: claim.securityCode, duration_ms: Date.now() - startedAt, error: message });
    if (error instanceof WorkerUnavailableError) interruptedJobs.set(claim.securityCode, { message, attempt: claim.attempt });
    else await post(`/api/research/operating-analysis-jobs/${encodeURIComponent(claim.securityCode)}/fail`, { error: message, runnerInstanceId, attempt: claim.attempt }).catch(() => {});
  } finally { clearInterval(heartbeatTimer); }
}
async function claim() { return post("/api/research/operating-analysis-jobs/claim-next", { runnerInstanceId }); }
const interruptedJobs = new Map();
async function recoverInterruptedJobs() {
  for (const [securityCode, interrupted] of interruptedJobs) {
    try {
      await post(`/api/research/operating-analysis-jobs/${encodeURIComponent(securityCode)}/requeue`, { error: interrupted.message, runnerInstanceId, attempt: interrupted.attempt });
      interruptedJobs.delete(securityCode);
      localRuntimeLog("research-operating-analysis", "requeued", { security_code: securityCode, attempt: interrupted.attempt });
    } catch (recoveryError) {
      if (!(recoveryError instanceof WorkerUnavailableError)) localRuntimeError("research-operating-analysis", "requeue_failed", recoveryError, { security_code: securityCode, attempt: interrupted.attempt });
    }
  }
}
let polling = false; let requested = false; const active = new Set(); let leaseActive = false; let accepting = true;
async function heartbeat() { try { leaseActive = (await post("/api/research/operating-analysis-runner-lease/heartbeat", { runnerInstanceId }))?.active === true; } catch { leaseActive = false; } return leaseActive; }
async function poll() { if (!accepting) return; if (polling) { requested = true; return; } polling = true; try { if (!await heartbeat()) return; await recoverInterruptedJobs(); while (accepting && active.size < concurrency) { const item = await claim(); if (!item) break; let work; work = runJob(item).finally(() => { active.delete(work); void poll(); }); active.add(work); } } catch (error) { localRuntimeError("research-operating-analysis", "polling_paused", error); } finally { polling = false; if (requested && accepting) { requested = false; void poll(); } } }

export function startResearchOperatingAnalysisRunner() {
  accepting = true;
  localRuntimeLog("research-operating-analysis", "polling_started", { runner_instance_id: runnerInstanceId, concurrency, base_url: baseUrl, poll_interval_ms: pollIntervalMs });
  void poll(); const timer = setInterval(() => void poll(), pollIntervalMs);
  return { async stop({ gracefulTimeoutMs = runtimeConfig?.lease?.gracefulShutdownMs || 30_000 } = {}) { accepting = false; clearInterval(timer); await Promise.race([Promise.allSettled([...active]), new Promise((resolve) => setTimeout(resolve, gracefulTimeoutMs))]); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = startResearchOperatingAnalysisRunner();
  const stop = () => { void controller.stop().finally(() => process.exit(0)); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
}
