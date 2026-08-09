#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { SharedLlmClient, createResponsesProvider } from "@m2ai/shared-llm-client";
import {
  RESEARCH_OPERATING_ANALYSIS_COMPANY_BASELINE_PROMPT,
  RESEARCH_OPERATING_ANALYSIS_FINANCIAL_STAGE_PROMPT,
  RESEARCH_OPERATING_ANALYSIS_INDUSTRY_VALIDATION_PROMPT,
  RESEARCH_OPERATING_ANALYSIS_OPERATING_STAGE_PROMPT,
  RESEARCH_OPERATING_ANALYSIS_VALUATION_CONCLUSION_PROMPT,
  RESEARCH_OPERATING_ANALYSIS_VALUATION_INPUTS_PROMPT,
} from "./generated/prompt-text.mjs";
import { fetchLocalWorker } from "./lib/local-worker-request.mjs";
import { buildOperatingAnalysisFinancialContext, financialSnapshotForStage } from "./lib/operating-analysis-financial-snapshot.mjs";

const baseUrl = String(process.env.OPERATING_ANALYSIS_RUNNER_BASE_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");
const config = await loadConfig();
const apiKey = await resolveApiKey();
const modelBaseUrl = String(process.env.OPENAI_BASE_URL || process.env.LLM_BASE_URL || "https://api.m2ai.cc/api/v1/openai").replace(/\/+$/, "");
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
  if (parsed?.model !== "gpt-5.6-luna" || !Number.isInteger(parsed?.concurrency) || parsed.concurrency < 1 || parsed.concurrency > 20 || !Number.isInteger(parsed?.streamIdleTimeoutMs) || parsed.streamIdleTimeoutMs < 30_000 || parsed.streamIdleTimeoutMs >= parsed.jobTimeoutMs || parsed?.reasoningEffort !== "max" || parsed?.webSearch?.required !== true) throw new Error("research-operating-analysis config must use gpt-5.6-luna, concurrency 1-20, a bounded stream idle timeout, default max reasoning, and required Web Search");
  return parsed;
}
async function resolveApiKey() {
  if (String(process.env.OPENAI_API_KEY || "").trim()) return process.env.OPENAI_API_KEY.trim();
  if (String(process.env.LLM_API_KEY || "").trim()) return process.env.LLM_API_KEY.trim();
  try { const auth = JSON.parse(await readFile(`${process.env.HOME}/.codex/auth.json`, "utf8")); return String(auth?.OPENAI_API_KEY || "").trim(); } catch { return ""; }
}
async function request(path, init = {}) {
  let response;
  try { response = await fetchLocalWorker(`${baseUrl}${path}`, init); } catch (error) { throw new WorkerUnavailableError(`local Worker is unavailable: ${error instanceof Error ? error.message : String(error)}`); }
  const body = await response.json().catch(() => null);
  // A reachable Worker can return 5xx for upstream business failures (for
  // example an expired Xueqiu cookie). Only transport failures above are
  // resumable Worker interruptions; application failures must stop the job.
  if (response.status >= 500) throw new Error(body?.msg || `local Worker endpoint failed: ${response.status}`);
  if (!response.ok || body?.code !== 200) throw new Error(body?.msg || `operating-analysis endpoint failed: ${response.status}`);
  return body.data;
}
const client = new SharedLlmClient({ providers: { openai: createResponsesProvider({ name: "openai", baseUrl: modelBaseUrl, apiKey, streamIdleTimeoutMs: config.streamIdleTimeoutMs }) }, providerConcurrency: { openai: config.concurrency } });
const post = (path, body) => request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const text = (value) => typeof value === "string" ? value.trim() : "";
const json = (value) => { try { return JSON.parse(text(value).replace(/^```json\s*|\s*```$/g, "")); } catch { return null; } };

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
  await post(`/api/research/operating-analysis-jobs/${encodeURIComponent(claim.securityCode)}/stages/${key}/start`, { input, prompt: modelPrompt, runnerInstanceId });
  let output = ""; let checkpointed = 0; let checkpointAt = 0;
  const checkpoint = async (force = false) => {
    if (!output || (!force && output.length - checkpointed < config.streamCheckpoint.minChars && Date.now() - checkpointAt < config.streamCheckpoint.intervalMs)) return;
    await post(`/api/research/operating-analysis-jobs/${encodeURIComponent(claim.securityCode)}/stages/${key}/checkpoint`, { partialOutput: output, runnerInstanceId }); checkpointed = output.length; checkpointAt = Date.now();
  };
  const response = await client.streamText({ provider: "openai", model: config.model, instructions: modelPrompt.instructions, input: [{ role: "user", content: [{ type: "input_text", text: modelPrompt.userPrompt }] }], allowReasoning: true, reasoningEffort: claim.reasoningEffort, ...(webSearch ? { tools: [{ type: "web_search", searchContextSize: config.webSearch.searchContextSize }], toolChoice: "required" } : {}), maxOutputTokens: config.maxOutputTokens, cacheEnabled: false, signal: AbortSignal.timeout(config.jobTimeoutMs), onText: async (delta) => { output += delta; await checkpoint(); } });
  output = text(response.text); await checkpoint(true);
  const parsed = format === "json" ? json(output) : output;
  if (!parsed) throw new Error(`${key} returned no valid ${format} output`);
  const status = format === "json" && terminal(parsed.status) ? parsed.status : "complete";
  const finalOutput = key === "valuation_inputs" ? { ...parsed, deterministicValuation: calculateValuation(parsed) } : parsed;
  await post(`/api/research/operating-analysis-jobs/${encodeURIComponent(claim.securityCode)}/stages/${key}/complete`, { output: finalOutput, status, runnerInstanceId });
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
  try {
    const input = await buildInput(claim.securityCode); const task = await request(`/api/research/company/${encodeURIComponent(claim.securityCode)}/operating-analysis`);
    for (const definition of stages) { const result = await runStage(claim, input, task, definition); if (result?.status === "blocked") throw new Error(`${definition[1]} 被阻断：请补充其列出的证据或数据缺口`); }
    const report = assembleReport(input, task); const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex"); const finalPrompt = stageState(task, "valuation_conclusion")?.prompt || { model: config.model, instructions: INSTRUCTIONS, userPrompt: "六阶段任务由系统确定性组装" };
    await post(`/api/research/operating-analysis-jobs/${encodeURIComponent(claim.securityCode)}/complete`, { input: { ...input, stageArtifacts: task.job.stages }, prompt: finalPrompt, reportMarkdown: report, reasoningMarkdown: "", inputFingerprint: fingerprint, streamStats: { staged: true }, runnerInstanceId });
    console.log(`[operating-analysis-runner] completed ${claim.securityCode}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error); console.error(`[operating-analysis-runner] failed ${claim.securityCode}: ${message}`);
    if (error instanceof WorkerUnavailableError) interruptedJobs.set(claim.securityCode, message);
    else await post(`/api/research/operating-analysis-jobs/${encodeURIComponent(claim.securityCode)}/fail`, { error: message, runnerInstanceId }).catch(() => {});
  }
}
async function claim() { return post("/api/research/operating-analysis-jobs/claim-next", { runnerInstanceId }); }
const interruptedJobs = new Map();
async function recoverInterruptedJobs() {
  for (const [securityCode, error] of interruptedJobs) {
    try {
      await post(`/api/research/operating-analysis-jobs/${encodeURIComponent(securityCode)}/requeue`, { error, runnerInstanceId });
      interruptedJobs.delete(securityCode);
      console.warn(`[operating-analysis-runner] requeued interrupted ${securityCode}; resuming from its last terminal stage`);
    } catch (recoveryError) {
      if (!(recoveryError instanceof WorkerUnavailableError)) console.warn(`[operating-analysis-runner] could not requeue ${securityCode}: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`);
    }
  }
}
let polling = false; let requested = false; const active = new Set(); let leaseActive = false;
async function heartbeat() { try { leaseActive = (await post("/api/research/operating-analysis-runner-lease/heartbeat", { runnerInstanceId }))?.active === true; } catch { leaseActive = false; } return leaseActive; }
async function poll() { if (polling) { requested = true; return; } polling = true; try { if (!await heartbeat()) return; await recoverInterruptedJobs(); while (active.size < config.concurrency) { const item = await claim(); if (!item) break; let work; work = runJob(item).finally(() => { active.delete(work); void poll(); }); active.add(work); } } catch (error) { console.warn(`[operating-analysis-runner] polling paused: ${error instanceof Error ? error.message : String(error)}`); } finally { polling = false; if (requested) { requested = false; void poll(); } } }
console.log(`[operating-analysis-runner] ${runnerInstanceId} staged research, concurrency=${config.concurrency}; polling ${baseUrl} every 5000ms`);
// `poll()` renews the lease before claiming work. A second heartbeat interval
// sent concurrent requests to Miniflare at the same five-second boundary.
void poll(); const timer = setInterval(() => void poll(), 5000);
process.once("SIGINT", () => { clearInterval(timer); process.exit(0); }); process.once("SIGTERM", () => { clearInterval(timer); process.exit(0); });
