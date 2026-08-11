#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  RESEARCH_OPERATING_ANALYSIS_SYSTEM_PROMPT,
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
import { assembleOperatingAnalysisReport } from "./lib/operating-analysis-report.mjs";
import { calculateDeterministicValuation } from "./lib/operating-analysis-deterministic-valuation.mjs";
import { runOperatingAnalysisStageWaves } from "./lib/operating-analysis-stage-plan.mjs";

const baseUrl = String(process.env.OPERATING_ANALYSIS_RUNNER_BASE_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");
const config = await loadConfig();
const runtimeConfig = await loadLocalJobRuntimeConfig();
const runtimeHandler = runtimeConfig?.handlers?.researchOperatingAnalysis;
const apiKey = await resolveLocalJobApiKey();
const runnerInstanceId = `operating-analysis-runner:${randomUUID()}`;
const INSTRUCTIONS = RESEARCH_OPERATING_ANALYSIS_SYSTEM_PROMPT;
const stages = [
  { key: "company_baseline", label: "公司事实基线", format: "json", webSearch: true, template: RESEARCH_OPERATING_ANALYSIS_COMPANY_BASELINE_PROMPT, dependsOn: [] },
  { key: "industry_validation", label: "行业、产业链与外部验证", format: "json", webSearch: true, template: RESEARCH_OPERATING_ANALYSIS_INDUSTRY_VALIDATION_PROMPT, dependsOn: ["company_baseline"] },
  { key: "operating_analysis", label: "经营、增长与竞争分析", format: "markdown", webSearch: false, template: RESEARCH_OPERATING_ANALYSIS_OPERATING_STAGE_PROMPT, dependsOn: ["company_baseline", "industry_validation"] },
  { key: "financial_analysis", label: "财务、资本、治理与生存能力", format: "markdown", webSearch: false, template: RESEARCH_OPERATING_ANALYSIS_FINANCIAL_STAGE_PROMPT, dependsOn: ["company_baseline", "industry_validation"] },
  { key: "valuation_inputs", label: "情景假设、估值输入与风险结构", format: "json", webSearch: false, template: RESEARCH_OPERATING_ANALYSIS_VALUATION_INPUTS_PROMPT, dependsOn: ["company_baseline", "industry_validation", "operating_analysis", "financial_analysis"] },
  { key: "valuation_conclusion", label: "估值解释、反证与最终结论", format: "markdown", webSearch: false, template: RESEARCH_OPERATING_ANALYSIS_VALUATION_CONCLUSION_PROMPT, dependsOn: ["company_baseline", "industry_validation", "operating_analysis", "financial_analysis", "valuation_inputs"] },
];
const stageWaves = [
  [stages[0]],
  [stages[1]],
  [stages[2], stages[3]],
  [stages[4]],
  [stages[5]],
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
const provider = createLocalJobProvider(apiKey, { streamIdleTimeoutMs: config.streamIdleTimeoutMs });
// The DB lease is the sole provider cap. This adapter deliberately has no
// SharedLlmClient limiter; it only preserves the runner's response shape.
const client = {
  async generateText(request) { return normalizeProviderResult(request, await provider.generate(request)); },
  async streamText(request) { return normalizeProviderResult(request, await provider.stream(request)); },
};
const post = (path, body) => request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const text = (value) => typeof value === "string" ? value.trim() : "";
const json = (value) => { try { return JSON.parse(text(value).replace(/^```json\s*|\s*```$/g, "")); } catch { return null; } };
function positiveInteger(value, fallback) { const parsed = Number(value); return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback; }
function normalizeProviderResult(request, result) { return { ...result, provider: request.provider, model: request.model, reasoningText: result.reasoningText || "", cached: false }; }

async function buildInput(code, modelRun) {
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
    modelRun,
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
function rawResponseSummary(response) {
  const raw = response?.raw;
  return {
    id: typeof raw?.id === "string" ? raw.id : null,
    status: typeof raw?.status === "string" ? raw.status : null,
    output_item_count: Array.isArray(raw?.output) ? raw.output.length : 0,
  };
}
function jsonOutputParseError(stageKey, output, response) {
  return new Error(`${stageKey} returned no valid json output; stage_key=${stageKey}; text_length=${output.length}; output_preview=${JSON.stringify(output.slice(0, 600))}; raw_response_summary=${JSON.stringify(rawResponseSummary(response))}`);
}
function terminal(status) { return ["complete", "partial", "blocked", "not_applicable"].includes(status); }
function stageState(task, key) { return (task?.job?.stages || []).find((item) => item.stageKey === key); }
function artifact(task, key) { const item = stageState(task, key); return item?.output ?? null; }

async function runStage(claim, baseInput, task, definition, owner = runnerInstanceId) {
  const { key, label, format, webSearch, template, dependsOn } = definition;
  const prior = stageState(task, key);
  if (terminal(prior?.status)) return prior.output;
  const upstream = Object.fromEntries(dependsOn.map((upstreamKey) => [upstreamKey, artifact(task, upstreamKey)]));
  const { financialContext, ...sharedInput } = baseInput;
  const input = { ...sharedInput, financialDataSnapshot: financialSnapshotForStage(baseInput.financialDataSnapshot, financialContext, key), stage: { key, label, outputFormat: format }, upstreamArtifacts: upstream };
  const selectedModel = claim.model || config.model;
  const modelPrompt = { model: selectedModel, instructions: INSTRUCTIONS, userPrompt: prompt(template, input) };
  localRuntimeLog("research-operating-analysis", "stage_started", { job_id: claim.jobId, attempt: claim.attempt, security_code: claim.securityCode, stage_key: key });
  await post(`/api/research/operating-analysis-jobs/${encodeURIComponent(claim.securityCode)}/stages/${key}/start`, { input, prompt: modelPrompt, runnerInstanceId: owner, attempt: claim.attempt });
  let output = "";
  const llmRequest = { provider: "openai", requestId: `operating-analysis:${claim.securityCode}:attempt-${claim.attempt}:${key}`, model: selectedModel, instructions: modelPrompt.instructions, input: [{ role: "user", content: [{ type: "input_text", text: modelPrompt.userPrompt }] }], allowReasoning: true, reasoningEffort: claim.reasoningEffort, ...(webSearch ? { tools: [{ type: "web_search", searchContextSize: config.webSearch.searchContextSize }], toolChoice: "required" } : {}), maxOutputTokens: config.maxOutputTokens, cacheEnabled: false, signal: AbortSignal.timeout(webSearch ? config.webSearchJobTimeoutMs : config.jobTimeoutMs), ...(webSearch ? {} : { onText: async (delta) => { output += delta; } }) };
  const response = webSearch ? await client.generateText(llmRequest) : await client.streamText(llmRequest);
  output = text(response.text);
  const parsed = format === "json" ? json(output) : output;
  if (!parsed) throw format === "json"
    ? jsonOutputParseError(key, output, response)
    : new Error(`${key} returned no valid ${format} output`);
  const status = format === "json" && terminal(parsed.status) ? parsed.status : "complete";
  const finalOutput = key === "valuation_inputs" ? { ...parsed, deterministicValuation: calculateValuation(parsed, baseInput) } : parsed;
  await post(`/api/research/operating-analysis-jobs/${encodeURIComponent(claim.securityCode)}/stages/${key}/complete`, { output: finalOutput, status, runnerInstanceId: owner, attempt: claim.attempt });
  localRuntimeLog("research-operating-analysis", "stage_completed", { job_id: claim.jobId, attempt: claim.attempt, security_code: claim.securityCode, stage_key: key, stage_status: status });
  task.job.stages = (task.job.stages || []).map((item) => item.stageKey === key ? { ...item, status, output: finalOutput } : item);
  return finalOutput;
}

/** The calculation consumes only S9-confirmed fields; it never invents an operating assumption. */
function calculateValuation(stageFive, context = {}) {
  return calculateDeterministicValuation({ scenarioOutput: stageFive, context });
}

export async function runJob(claim, owner = runnerInstanceId) {
  const startedAt = Date.now();
  localRuntimeLog("research-operating-analysis", "started", { job_id: claim.jobId, attempt: claim.attempt, security_code: claim.securityCode });
  const heartbeatTimer = setInterval(() => {
    void post(`/api/research/operating-analysis-jobs/${encodeURIComponent(claim.securityCode)}/heartbeat`, { runnerInstanceId: owner, attempt: claim.attempt }).catch(() => {});
  }, 10_000);
  try {
    const input = await buildInput(claim.securityCode, { model: claim.model || config.model, reasoningEffort: claim.reasoningEffort }); const task = await request(`/api/research/company/${encodeURIComponent(claim.securityCode)}/operating-analysis`);
    const stageResults = await runOperatingAnalysisStageWaves(stageWaves, (definition) => runStage(claim, input, task, definition, owner));
    const blocked = stageResults.find(({ output }) => output?.status === "blocked" || output?.deterministicValuation?.status === "blocked");
    if (blocked) throw new Error(`${blocked.stage.label} 被阻断：请补充其列出的证据或数据缺口`);
    const report = assembleOperatingAnalysisReport(input, task.job.stages || []); const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex"); const finalPrompt = stageState(task, "valuation_conclusion")?.prompt || { model: claim.model || config.model, instructions: INSTRUCTIONS, userPrompt: "六阶段任务由系统确定性组装" };
    await post(`/api/research/operating-analysis-jobs/${encodeURIComponent(claim.securityCode)}/complete`, { input: { ...input, stageArtifacts: task.job.stages }, prompt: finalPrompt, reportMarkdown: report, reasoningMarkdown: "", inputFingerprint: fingerprint, streamStats: { staged: true }, runnerInstanceId: owner, attempt: claim.attempt });
    localRuntimeLog("research-operating-analysis", "completed", { job_id: claim.jobId, attempt: claim.attempt, security_code: claim.securityCode, duration_ms: Date.now() - startedAt });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    localRuntimeLog("research-operating-analysis", "failed", { job_id: claim.jobId, attempt: claim.attempt, security_code: claim.securityCode, duration_ms: Date.now() - startedAt, error: message });
    if (error instanceof WorkerUnavailableError) interruptedJobs.set(claim.securityCode, { message, attempt: claim.attempt });
    else await post(`/api/research/operating-analysis-jobs/${encodeURIComponent(claim.securityCode)}/fail`, { error: message, runnerInstanceId: owner, attempt: claim.attempt }).catch(() => {});
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
