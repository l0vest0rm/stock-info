import type { Database } from "../../../platform/contracts";
import type { AppEnv, KlineBar } from "../../../types";
import { readResearchResult, saveResearchResult } from "../infrastructure/research-result-repository";
import { RESEARCH_OPERATING_ANALYSIS_PROMPT } from "../../../generated/prompt-text";
import { isTaskdReadUnavailable, taskdCallerClient, type TaskdTask } from "../../../shared/taskd-client";
import { extractTaskdWebQaResult } from "../../../shared/taskd-webqa-result";
import { hasRecoverableTaskdReportCheckpoint, isObservedTaskdReportTask, isPendingTaskdReportTask, isTerminalTaskdReportTask, observeTaskdReport, recoverTaskdReport, submitTaskdReport, taskdReportTaskView } from "../../../shared/taskd-report-workflow";
import { loadKline } from "../../market/application/load-kline";
import { loadLatestFinancialValuation, type FinancialValuationBasis } from "../../finance/application/latest-financial-valuation";
import { getSecurity } from "../../security/application/search-securities";
import { normalizeSecurityCode } from "../../../shared/codes";
import industryProfiles from "../../../../config/research-eastmoney-em2016-industry-profiles.json";
import companyProfiles from "../../../../config/eastmoney-company-em2016-profiles.json";

const TASK_TYPE = "webqa.chatgpt.v1";
const MODEL = "gpt-5.6-luna" as const;
const DEFAULT_REASONING_EFFORT = "xhigh";
const PROMPT_VERSION = "investment-analysis.taskd.v8";
const INVESTMENT_ANALYSIS_NAMESPACE = "research_investment_analysis";
const CURRENT_INPUT_SCHEMA_VERSION = "investment-analysis-input.v3";

type Row = Record<string, unknown>;
type AnalysisFramework = {
  primaryFormula: string;
  operatingMetrics: string[];
  valuationMethods: string[];
  stressFactors: string[];
};
type InvestmentAnalysisInput = {
  schemaVersion: "investment-analysis-input.v3";
  promptVersion: string;
  preparedAt: string;
  security: { code: string; name: string; market: string; type: string; currency: string | null };
  marketSnapshot: {
    asOf: string;
    marketDataSource: "xueqiu";
    valuationSource: "financial-statements";
    latestPrice: number | null;
    marketCapYi: number | null;
    peTtm: number | null;
    pb: number | null;
    psTtm: number | null;
    pcfTtm: number | null;
    valuationBasis: {
      income: FinancialValuationBasis | null;
      balance: FinancialValuationBasis | null;
      cashflow: FinancialValuationBasis | null;
    };
  };
  businessBoundary: { status: "confirmed" | "unknown"; note: string | null; products: string[]; customers: string[]; regions: string[] };
  analysisFramework: AnalysisFramework | null;
};
type ResultRow = {
  pendingProjection?: boolean;
  pendingInputJson?: string | null;
  securityCode: string;
  inputJson: string | null;
  markdown: string | null;
  citationsJson: string;
  sourcesJson: string;
  terminalEvidenceJson: string | null;
  projectedAt: number | null;
  task: StoredTaskValue | null;
  recovery: RecoveryState;
};
type StoredTaskValue = {
  taskId?: number | null;
  name: string;
  status: TaskdTask["status"];
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
};
type RecoveryState = {
  phase: "none" | "recovering" | "manual_required";
  reason: string | null;
};
type ReportVersion = {
  status: "current" | "legacy" | "unknown";
  inputSchemaVersion: string | null;
  currentInputSchemaVersion: typeof CURRENT_INPUT_SCHEMA_VERSION;
};
type StoredResultValue = Omit<ResultRow, "securityCode">;

export function researchInvestmentAnalysisTaskName(securityCode: string): string {
  return `research:investment-analysis:${securityCode}`;
}

export async function enqueueResearchInvestmentAnalysis(
  env: AppEnv["Bindings"],
  securityCode: string,
  options: { reasoningEffort?: string | null } = {},
) {
  if (env.LLM_RUNTIME !== "local") throw new Error("investment analysis submission is only available in local LLM runtime");
  const prepared = await prepareResearchInvestmentAnalysis(env, securityCode);
  const current = await loadResult(env.DB, prepared.securityCode);
  const name = researchInvestmentAnalysisTaskName(prepared.securityCode);
  const normalizedReasoningEffort = normalizeReasoningEffort(options.reasoningEffort);
  const task = await submitTaskdReport(env, { name, taskType: TASK_TYPE, model: MODEL, reasoningEffort: normalizedReasoningEffort, waitTimeoutMs: 2 * 60 * 60_000, prompt: prepared.prompt, businessInput: prepared.input,
    diagnostics: {
      securityCode: prepared.securityCode,
      model: MODEL,
      reasoningEffort: normalizedReasoningEffort,
      promptVersion: prepared.input.promptVersion,
      schemaVersion: prepared.input.schemaVersion,
    } });
  await storeResult(env.DB, prepared.securityCode, mergeStoredResult(current, {
    pendingProjection: true,
    pendingInputJson: JSON.stringify(prepared.input),
    inputJson: current?.markdown ? current.inputJson : JSON.stringify(prepared.input),
    task: taskView(task),
    recovery: noRecovery(),
  }));
  return { accepted: true, task: taskView(task), input: prepared.input };
}

/** Read model only: opening a page never calls taskd or market providers. */
export async function loadResearchInvestmentAnalysis(env: AppEnv["Bindings"], securityCode: string) {
  const result = await loadResult(env.DB, securityCode.trim().toUpperCase());
  return result ? responseFromStoredResult(result) : {
    availability: "empty" as const, task: null, recovery: noRecovery(), input: null, report: null,
    resume: { available: false, reason: "not_failed" },
  };
}

export async function reconcileResearchInvestmentAnalysis(env: AppEnv["Bindings"], securityCode: string): Promise<void> {
  if (env.LLM_RUNTIME !== "local") return;
  const code = securityCode.trim().toUpperCase();
  const result = await loadResult(env.DB, code);
  if (!result?.task || (result.markdown && !result.pendingProjection && !isPendingTask(result.task))) return;
  try {
    const state = await observeTaskdReport({
      client: taskdCallerClient(env), expected: result.task,
      project: async (task) => {
        const input = taskBusinessInput(task) ?? jsonObject(result.pendingInputJson ?? (result.pendingProjection && result.markdown ? null : result.inputJson));
        if (!input) throw new Error("investment analysis task has no frozen input snapshot");
        if (text(object(input.security)?.code).toUpperCase() !== code) throw new Error("investment analysis frozen input security mismatch");
        await projectResearchInvestmentAnalysis(env, input, task, result);
      },
    });
    if (state.state === "missing") {
      await persistTaskSnapshot(env.DB, code, result, jsonObject(result.inputJson), null, {
        phase: "manual_required", reason: "taskd 已找不到原任务，无法确认已提交的 ChatGPT 会话。",
      });
    } else if (state.state !== "projected" && isObservedTaskdReportTask(result.task, state.task)) {
      await persistTaskSnapshot(env.DB, code, result, taskBusinessInput(state.task) ?? jsonObject(result.inputJson), state.task,
        recoveryAfterTask(result.recovery, state.task));
    } else if (state.state !== "projected") {
      throw new Error("recorded research task was superseded; refusing a different run");
    }
  } catch (error) {
    // A state read can fail while the existing task remains valid. Do not turn
    // a temporary DNS/network outage into a manual-recovery requirement.
    if (isTaskdReadUnavailable(error)) throw error;
    await storeResult(env.DB, code, mergeStoredResult(result, { recovery: {
      phase: "manual_required", reason: error instanceof Error ? error.message : String(error),
    } }), result);
    throw error;
  }
}

/** Explicit observation only: refresh the local projection without replaying provider work. */
export async function syncResearchInvestmentAnalysis(env: AppEnv["Bindings"], securityCode: string) {
  if (env.LLM_RUNTIME !== "local") throw new Error("investment analysis synchronization is only available in local LLM runtime");
  const code = securityCode.trim().toUpperCase();
  await reconcileResearchInvestmentAnalysis(env, code);
  return loadResearchInvestmentAnalysis(env, code);
}

/**
 * Requeue the same taskd task only after taskd recorded a recoverable provider
 * checkpoint. This path never submits another browser prompt.
 */
export async function resumeResearchInvestmentAnalysis(env: AppEnv["Bindings"], securityCode: string) {
  const code = securityCode.trim().toUpperCase();
  const stored = await loadResult(env.DB, code);
  if (!stored?.task) throw new Error("investment analysis has no recorded task to recover");
  if (env.LLM_RUNTIME !== "local") throw new Error("investment analysis recovery is only available in local LLM runtime");

  const recovered = await recoverTaskdReport(taskdCallerClient(env), stored.task);
  let remote = recovered.task;
  let recovery = stored.recovery;
  if (!remote) {
    recovery = {
      phase: "manual_required",
      reason: "taskd 已找不到原任务，无法确认已提交的 ChatGPT 会话。",
    };
  } else if (recovered.recoverable) {
    recovery = {
      phase: "recovering",
      reason: "正在只读找回已提交的 ChatGPT 结果；不会重发提示词。",
    };
  } else if (remote.status === "failed") {
    if (hasRecoverableProviderCheckpoint(remote.checkpoint)) {
      recovery = {
        phase: "manual_required",
        reason: "taskd 未能重新排队原任务，无法确认已提交的 ChatGPT 会话。",
      };
    } else {
      recovery = {
        phase: "manual_required",
        reason: "任务缺少可验证的原会话 checkpoint，无法安全找回，也不会重发提示词。",
      };
    }
  }
  await persistTaskSnapshot(
    env.DB,
    code,
    stored,
    remote ? taskBusinessInput(remote) ?? jsonObject(stored.inputJson) : jsonObject(stored.inputJson),
    remote,
    recovery,
  );
  await reconcileResearchInvestmentAnalysis(env, code);
  return loadResearchInvestmentAnalysis(env, code);
}

async function prepareResearchInvestmentAnalysis(env: AppEnv["Bindings"], securityCode: string) {
  const code = normalizeSecurityCode(securityCode);
  const security = await getSecurity(env.DB, code);
  if (!security) throw new Error("security was not found");
  const [marketSnapshot, localProfile] = await Promise.all([
    loadInvestmentAnalysisMarketSnapshot(env, code),
    Promise.resolve(localCompanyProfile(code)),
  ]);
  const input: InvestmentAnalysisInput = {
    schemaVersion: "investment-analysis-input.v3",
    promptVersion: PROMPT_VERSION,
    preparedAt: new Date().toISOString(),
    security: { code: security.code, name: security.name, market: security.market, type: security.type, currency: security.currency ?? null },
    marketSnapshot,
    // This local routing state does not inject unlinked business facts for
    // the model to repeat as public disclosure; Web Search must verify them.
    businessBoundary: { status: localProfile ? "confirmed" : "unknown", note: null, products: [], customers: [], regions: [] },
    analysisFramework: localProfile ? frameworkForIndustry(localProfile.industry) : null,
  };
  return { securityCode: code, input, prompt: buildResearchInvestmentAnalysisPrompt(input) };
}

export function buildResearchInvestmentAnalysisPrompt(input: InvestmentAnalysisInput): string {
  return RESEARCH_OPERATING_ANALYSIS_PROMPT.replace("{{INPUT_DATA}}", investmentAnalysisBrief(input));
}

async function loadInvestmentAnalysisMarketSnapshot(env: AppEnv["Bindings"], code: string): Promise<InvestmentAnalysisInput["marketSnapshot"]> {
  const today = new Date().toISOString().slice(0, 10);
  const kline = await loadKline(env, code, "day", "normal", `${new Date().getUTCFullYear() - 1}-01-01`, today);
  const latest = kline.rows.filter((row): row is KlineBar => "close" in row).at(-1);
  if (!latest) throw new Error(`Xueqiu K-line is empty for investment analysis: ${code}`);
  const valuation = await loadLatestFinancialValuation(env, code, latest.marketCapital, { availableAt: new Date() });
  return {
    asOf: latest.date,
    marketDataSource: "xueqiu",
    valuationSource: valuation.source,
    latestPrice: latest.close,
    marketCapYi: latest.marketCapital === null ? null : latest.marketCapital / 100_000_000,
    peTtm: valuation.peTtm,
    pb: valuation.pb,
    psTtm: valuation.psTtm,
    pcfTtm: valuation.pcfTtm,
    valuationBasis: valuation.basis,
  };
}

function localCompanyProfile(code: string) {
  return companyProfiles.profiles.find((profile) => profile.code === code && profile.availability === "available" && profile.industry) ?? null;
}

function frameworkForIndustry(industry: string): AnalysisFramework | null {
  const profile = industryProfiles.profiles.find((candidate) => candidate.industries.includes(industry));
  return profile ? {
    primaryFormula: profile.primaryFormula,
    operatingMetrics: [...profile.operatingMetrics],
    valuationMethods: [...profile.valuationMethods],
    stressFactors: [...profile.stressFactors],
  } : null;
}

function investmentAnalysisBrief(input: InvestmentAnalysisInput): string {
  const market = input.marketSnapshot;
  const framework = input.analysisFramework;
  return [
    "## 研究对象",
    `- 公司：${input.security.name}`,
    `- 证券代码：${input.security.code}`,
    `- 报告时点：${input.preparedAt}`,
    "",
    "## 已确认的市场快照",
    `- 截至：${market.asOf}`,
    `- 行情源：${market.marketDataSource}（仅价格、市值）`,
    `- 估值源：${market.valuationSource}（按最新已披露财报、快报、预告派生）`,
    `- 最新价格：${display(market.latestPrice, input.security.currency ?? undefined)}`,
    `- 总市值：${display(market.marketCapYi, "亿元")}`,
    `- PE（TTM）：${display(market.peTtm)}`,
    `- PB：${display(market.pb)}`,
    `- PS（TTM）：${display(market.psTtm)}`,
    `- PCF（TTM）：${display(market.pcfTtm)}`,
    `- 利润/营收口径：${displayBasis(market.valuationBasis.income)}`,
    `- 净资产口径：${displayBasis(market.valuationBasis.balance)}`,
    `- 经营现金流口径：${displayBasis(market.valuationBasis.cashflow)}`,
    "",
    "## 研究框架（不是公司事实）",
    `- 量价成本主公式：${framework?.primaryFormula ?? "未提供"}`,
    `- 优先核验指标：${framework?.operatingMetrics.join("、") || "未提供"}`,
    `- 可用估值方法：${framework?.valuationMethods.join("、") || "未提供"}`,
    `- 压力因素：${framework?.stressFactors.join("、") || "未提供"}`,
  ].join("\n");
}

function display(value: number | null, unit = ""): string {
  return value === null ? "未提供" : `${Number(value.toFixed(2))}${unit ? ` ${unit}` : ""}`;
}

function displayBasis(value: FinancialValuationBasis | null): string {
  return value ? `${value.source}；报告期 ${value.reportDate}；公告日 ${value.noticeDate ?? "未提供"}` : "未提供";
}

async function projectResearchInvestmentAnalysis(env: AppEnv["Bindings"], input: Record<string, unknown>, task: TaskdTask, expected: ResultRow) {
  const result = extractTaskdWebQaResult(task.result);
  validateResearchInvestmentAnalysisTerminalEvidence(result.terminalEvidence);
  const markdown = text(result.content.markdown);
  validateResearchInvestmentAnalysisMarkdown(markdown);
  const securityCode = text(object(input.security)?.code);
  if (!securityCode) throw new Error("investment analysis input has no security code");
  const projectedAt = Date.now();
  const stored = {
    pendingProjection: false,
    pendingInputJson: null,
    inputJson: JSON.stringify(input),
    markdown,
    citationsJson: JSON.stringify(result.citations),
    sourcesJson: JSON.stringify(result.sources),
    terminalEvidenceJson: JSON.stringify(result.terminalEvidence),
    projectedAt,
    task: taskView(task),
    recovery: noRecovery(),
  } satisfies StoredResultValue;
  await storeResult(env.DB, securityCode, stored, expected);
  return { securityCode, ...stored };
}

async function loadResult(db: Database, securityCode: string): Promise<ResultRow | null> {
  const row = await readStoredResearchInvestmentAnalysis(db, securityCode);
  return row ? { securityCode, ...row } : null;
}

export async function writeStoredResearchInvestmentAnalysis(
  db: Database,
  securityCode: string,
  value: StoredResultValue,
): Promise<void> {
  await storeResult(db, securityCode, value);
}

export async function readStoredResearchInvestmentAnalysis(
  db: Database,
  securityCode: string,
): Promise<StoredResultValue | null> {
  const row = await readResearchResult(db, INVESTMENT_ANALYSIS_NAMESPACE, securityCode);
  if (!row) return null;
  const parsed = object(parseJson(row.valueJson));
  if (!parsed) return null;
  const task = parseStoredTask(parsed.task);
  const inputJson = typeof parsed.inputJson === "string" ? parsed.inputJson : null;
  const markdown = text(parsed.markdown) || null;
  const projectedAt = parsed.projectedAt === null || parsed.projectedAt === undefined ? null : Number(parsed.projectedAt);
  const recovery = parseRecovery(parsed.recovery);
  if (!markdown && !task && recovery.phase === "none") return null;
  return {
    ...(parsed.pendingInputJson === undefined ? {} : { pendingInputJson: typeof parsed.pendingInputJson === "string" ? parsed.pendingInputJson : null }),
    ...(parsed.pendingProjection === undefined ? {} : { pendingProjection: parsed.pendingProjection === true }),
    inputJson,
    markdown,
    citationsJson: jsonString(parsed.citationsJson, "[]"),
    sourcesJson: jsonString(parsed.sourcesJson, "[]"),
    terminalEvidenceJson: nullableJsonString(parsed.terminalEvidenceJson),
    projectedAt: Number.isFinite(projectedAt) ? projectedAt : null,
    task,
    recovery,
  };
}

export function validateResearchInvestmentAnalysisTerminalEvidence(evidence: Record<string, unknown> | null): void {
  if (
    text(evidence?.schemaVersion) !== "webqa.completion-evidence.v1"
    || text(evidence?.outcome) !== "succeeded"
  ) {
    throw new Error("investment analysis taskd result lacks terminal WebQA completion evidence");
  }
}

export function validateResearchInvestmentAnalysisMarkdown(markdown: string): void {
  if (markdown.length < 800) throw new Error("investment analysis result is shorter than 800 characters");
  // Markdown producers commonly escape the ordinal separator (`1\\.`) even
  // though it has the same visible H1 meaning as `1.`. Validate the twelve
  // semantic section ordinals, not that harmless serialization difference.
  const headings = new Set([...markdown.matchAll(/^# ([1-9]|1[0-2])(?:\\)?\. /gm)].map((match) => match[1]));
  if (headings.size !== 12) throw new Error("investment analysis result must contain all twelve numbered H1 headings");
}

function taskBusinessInput(task: TaskdTask): Record<string, unknown> | null {
  return object(object(task.input)?.business_input);
}

function normalizeReasoningEffort(value: string | null | undefined): "low" | "medium" | "high" | "xhigh" {
  const normalized = text(value) || DEFAULT_REASONING_EFFORT;
  if (!new Set(["low", "medium", "high", "xhigh"]).has(normalized)) throw new Error("unsupported investment-analysis reasoning effort");
  return normalized as "low" | "medium" | "high" | "xhigh";
}

function taskView(task: Pick<TaskdTask, "name" | "status" | "errorMessage" | "createdAt" | "updatedAt" | "completedAt"> & { taskId?: number | null }) { return { taskId: task.taskId ?? null, name: task.name, status: task.status, errorMessage: task.errorMessage, createdAt: task.createdAt, updatedAt: task.updatedAt, completedAt: task.completedAt }; }
function responseFromStoredResult(result: ResultRow) {
  const task = result.task;
  const recovery = result.recovery;
  const recoveryAvailable = task?.status === "failed" && recovery.phase === "none";
  // An input-contract upgrade must not discard a completed, validated provider
  // result. Keep the frozen report readable and make its contract age explicit
  // so the user, rather than an implicit UI filter, decides whether to refresh.
  const markdown = result.markdown;
  const reportVersion = markdown ? reportVersionFromInput(result.inputJson) : null;
  return {
    availability: markdown ? "available" as const : recovery.phase === "manual_required" || task?.status === "failed" ? "failed" as const : task ? "pending" as const : "empty" as const,
    task,
    recovery,
    input: parseJson(result.inputJson),
    report: markdown ? {
      markdown,
      citations: parseArray(result.citationsJson),
      sources: parseArray(result.sourcesJson),
      terminalMetadata: parseJson(result.terminalEvidenceJson),
      projectedAt: result.projectedAt,
    } : null,
    reportVersion,
    resume: {
      available: recoveryAvailable,
      reason: recoveryAvailable ? "recover_provider_turn" : recovery.phase === "manual_required" ? "manual_required" : markdown ? "already_projected" : "not_failed",
    },
  };
}
function reportVersionFromInput(inputJson: string | null): ReportVersion {
  const inputSchemaVersion = text(object(parseJson(inputJson))?.schemaVersion) || null;
  return {
    status: inputSchemaVersion === CURRENT_INPUT_SCHEMA_VERSION ? "current" : inputSchemaVersion ? "legacy" : "unknown",
    inputSchemaVersion,
    currentInputSchemaVersion: CURRENT_INPUT_SCHEMA_VERSION,
  };
}
async function persistTaskSnapshot(
  db: Database,
  securityCode: string,
  current: ResultRow | null,
  input: Record<string, unknown> | null,
  task: TaskdTask | null,
  recovery: RecoveryState = current?.recovery ?? noRecovery(),
): Promise<ResultRow> {
  const stored = mergeStoredResult(current, {
    inputJson: current?.markdown ? undefined : input ? JSON.stringify(input) : undefined,
    task: task ? taskView(task) : null,
    recovery,
  });
  await storeResult(db, securityCode, stored, current ?? undefined);
  return { securityCode, ...stored };
}
async function storeResult(db: Database, securityCode: string, value: StoredResultValue, expected?: StoredResultValue): Promise<void> {
  await saveResearchResult(db, INVESTMENT_ANALYSIS_NAMESPACE, securityCode, value, expected);
}
function mergeStoredResult(current: ResultRow | StoredResultValue | null, patch: {
  pendingProjection?: boolean;
  pendingInputJson?: string | null;
  inputJson?: string | null;
  markdown?: string | null;
  citationsJson?: string;
  sourcesJson?: string;
  terminalEvidenceJson?: string | null;
  projectedAt?: number | null;
  task?: StoredTaskValue | null;
  recovery?: RecoveryState;
}): StoredResultValue {
  return {
    pendingInputJson: patch.pendingInputJson !== undefined ? patch.pendingInputJson : current?.pendingInputJson ?? null,
    pendingProjection: patch.pendingProjection ?? current?.pendingProjection ?? false,
    inputJson: patch.inputJson !== undefined ? patch.inputJson : current?.inputJson ?? null,
    markdown: patch.markdown !== undefined ? patch.markdown : current?.markdown ?? null,
    citationsJson: patch.citationsJson ?? current?.citationsJson ?? "[]",
    sourcesJson: patch.sourcesJson ?? current?.sourcesJson ?? "[]",
    terminalEvidenceJson: patch.terminalEvidenceJson !== undefined ? patch.terminalEvidenceJson : current?.terminalEvidenceJson ?? null,
    projectedAt: patch.projectedAt !== undefined ? patch.projectedAt : current?.projectedAt ?? null,
    task: patch.task !== undefined ? patch.task : current?.task ?? null,
    recovery: patch.recovery ?? current?.recovery ?? noRecovery(),
  };
}
function noRecovery(): RecoveryState { return { phase: "none", reason: null }; }
function parseRecovery(value: unknown): RecoveryState {
  const recovery = object(value);
  const phase = text(recovery?.phase);
  if (phase === "none" || phase === "recovering" || phase === "manual_required") {
    return { phase, reason: text(recovery?.reason) || null };
  }
  return noRecovery();
}
function hasRecoverableProviderCheckpoint(value: unknown): boolean { return hasRecoverableTaskdReportCheckpoint(value); }
function recoveryAfterTask(current: RecoveryState, task: TaskdTask): RecoveryState {
  if (current.phase === "recovering" && isTerminalTask(task)) {
    return {
      phase: "manual_required",
      reason: task.errorMessage || "找回后的任务没有产生可验证的完成结果。",
    };
  }
  if (task.status === "failed" && !hasRecoverableProviderCheckpoint(task.checkpoint)) {
    return {
      phase: "manual_required",
      reason: isOutcomeUnknown(task.errorMessage)
        ? "无法确认原会话，且任务没有可验证的原会话 checkpoint。"
        : "任务没有可验证的原会话 checkpoint，不能执行无重放找回。",
    };
  }
  return current;
}
function isOutcomeUnknown(value: string | null | undefined): boolean { return /^OutcomeUnknown:/i.test(text(value)); }
function parseStoredTask(value: unknown): StoredTaskValue | null {
  const row = object(value);
  const name = text(row?.name);
  const status = text(row?.status) as TaskdTask["status"];
  const createdAt = Number(row?.createdAt);
  const updatedAt = Number(row?.updatedAt);
  if (!name || !isTaskStatus(status) || !Number.isFinite(createdAt) || !Number.isFinite(updatedAt)) return null;
  const completedAt = row?.completedAt === null || row?.completedAt === undefined ? null : Number(row?.completedAt);
  return {
    ...(row?.taskId == null ? {} : { taskId: Number(row.taskId) }),
    name,
    status,
    errorMessage: text(row?.errorMessage) || null,
    createdAt,
    updatedAt,
    completedAt: Number.isFinite(completedAt) ? completedAt : null,
  };
}
function isPendingTask(task: StoredTaskValue | TaskdTask | null | undefined): boolean { return isPendingTaskdReportTask(task); }
function isTerminalTask(task: StoredTaskValue | TaskdTask | null | undefined): boolean { return isTerminalTaskdReportTask(task); }
function isTaskStatus(value: string): value is TaskdTask["status"] {
  return new Set<TaskdTask["status"]>(["queued", "leased", "running", "interrupt_requested", "succeeded", "failed", "interrupted", "superseded"]).has(value as TaskdTask["status"]);
}
function object(value: unknown): Row | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null; }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function jsonString(value: unknown, fallback = "{}"): string { return typeof value === "string" ? value : fallback; }
function nullableJsonString(value: unknown): string | null { return typeof value === "string" ? value : null; }
function parseJson(value: string | null): unknown { try { return value ? JSON.parse(value) : null; } catch { return null; } }
function parseArray(value: string): unknown[] { const parsed = parseJson(value); return Array.isArray(parsed) ? parsed : []; }
function jsonObject(value: string | null | undefined): Record<string, unknown> | null { return object(parseJson(value ?? null)); }
