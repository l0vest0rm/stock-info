import type { AppEnv, KlineBar } from "../../../types";
import { getKvCache, putKvCache } from "../../../db/queries";
import { RESEARCH_OPERATING_ANALYSIS_PROMPT } from "../../../generated/prompt-text";
import { taskdWebQaInput } from "../../../shared/llm-client";
import { taskdCallerClient, type TaskdTask } from "../../../shared/taskd-client";
import { reconcileTaskdResult } from "../../../shared/taskd-result-projection";
import { extractTaskdWebQaResult } from "../../../shared/taskd-webqa-result";
import { loadKline } from "../../market/application/load-kline";
import { getSecurity } from "../../security/application/search-securities";
import { normalizeSecurityCode } from "../../../shared/codes";
import industryProfiles from "../../../../config/research-eastmoney-em2016-industry-profiles.json";
import companyProfiles from "../../../../config/eastmoney-company-em2016-profiles.json";

const TASK_TYPE = "webqa.chatgpt.v1";
const MODEL = "gpt-5.6-luna" as const;
const DEFAULT_REASONING_EFFORT = "xhigh";
const PROMPT_VERSION = "investment-analysis.taskd.v4";
const INVESTMENT_ANALYSIS_NAMESPACE = "research_investment_analysis";

type Row = Record<string, unknown>;
type AnalysisFramework = {
  primaryFormula: string;
  operatingMetrics: string[];
  valuationMethods: string[];
  stressFactors: string[];
};
type InvestmentAnalysisInput = {
  schemaVersion: "investment-analysis-input.v2";
  promptVersion: string;
  preparedAt: string;
  security: { code: string; name: string; market: string; type: string; currency: string | null };
  marketSnapshot: {
    asOf: string;
    source: "xueqiu";
    latestPrice: number | null;
    marketCapYi: number | null;
    peTtm: number | null;
    pb: number | null;
    psTtm: number | null;
    pcfTtm: number | null;
  };
  businessBoundary: { status: "confirmed" | "unknown"; note: string | null; products: string[]; customers: string[]; regions: string[] };
  analysisFramework: AnalysisFramework | null;
};
type ResultRow = {
  securityCode: string;
  inputJson: string | null;
  markdown: string | null;
  citationsJson: string;
  sourcesJson: string;
  terminalEvidenceJson: string | null;
  projectedAt: number | null;
  task: StoredTaskValue | null;
};
type StoredTaskValue = {
  name: string;
  status: TaskdTask["status"];
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
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
  const prepared = await prepareResearchInvestmentAnalysis(env, securityCode);
  const current = await loadResult(env.DB, prepared.securityCode);
  const name = researchInvestmentAnalysisTaskName(prepared.securityCode);
  const normalizedReasoningEffort = normalizeReasoningEffort(options.reasoningEffort);
  const task = await taskdCallerClient(env).submit({
    name,
    taskType: TASK_TYPE,
    payload: {
      ...taskdWebQaInput(env, {
      model: MODEL,
      reasoningEffort: normalizedReasoningEffort,
      waitTimeoutMs: 2 * 60 * 60_000,
      messages: [{ role: "user", content: prepared.prompt }],
      }, name),
      // The executor ignores this field; it is retained in taskd with the
      // exact engineering snapshot that produced the submitted prompt.
      business_input: prepared.input,
    },
    diagnostics: {
      securityCode: prepared.securityCode,
      model: MODEL,
      reasoningEffort: normalizedReasoningEffort,
      promptVersion: prepared.input.promptVersion,
      schemaVersion: prepared.input.schemaVersion,
    },
  });
  await storeResult(env.DB, prepared.securityCode, mergeStoredResult(current, {
    inputJson: JSON.stringify(prepared.input),
    task: taskView(task),
  }));
  return { accepted: true, task: taskView(task), input: prepared.input };
}

export async function loadResearchInvestmentAnalysis(env: AppEnv["Bindings"], securityCode: string) {
  const code = securityCode.trim().toUpperCase();
  let result = await loadResult(env.DB, code);
  if (result?.markdown && !isPendingTask(result.task)) return responseFromStoredResult(result);
  const cachedInput = jsonObject(result?.inputJson);
  const shouldQueryTaskd = env.LLM_RUNTIME === "local" && (!result?.markdown || isPendingTask(result.task));
  let prepared: Awaited<ReturnType<typeof prepareResearchInvestmentAnalysis>> | null = null;
  const ensurePrepared = async () => {
    if (!prepared) prepared = await prepareResearchInvestmentAnalysis(env, code);
    return prepared;
  };
  let task: StoredTaskValue | null = result?.task ?? null;
  if (shouldQueryTaskd) {
    const state = await reconcileTaskdResult(taskdCallerClient(env), {
      name: researchInvestmentAnalysisTaskName(code),
      project: async (currentTask) => projectResearchInvestmentAnalysis(env, taskBusinessInput(currentTask) || cachedInput || (await ensurePrepared()).input, currentTask),
    });
    switch (state.state) {
      case "projected":
        result = state.value;
        task = state.value.task;
        break;
      case "pending":
      case "failed":
      case "interrupted":
      case "superseded":
        task = taskView(state.task);
        result = await persistTaskSnapshot(env.DB, code, result, taskBusinessInput(state.task) || cachedInput || (await ensurePrepared()).input, state.task);
        break;
      case "missing":
        task = null;
        if (result?.task) result = await persistTaskSnapshot(env.DB, code, result, cachedInput, null);
        break;
    }
  }
  if (result) return responseFromStoredResult(result);
  const fallbackInput = cachedInput || (await ensurePrepared()).input;
  return {
    availability: task?.status === "failed" ? "failed" as const : task ? "pending" as const : "empty" as const,
    task: task ? taskView(task) : null,
    input: fallbackInput,
    report: null,
    resume: { available: task?.status === "failed", reason: task?.status === "failed" ? "submit_new_task" : "not_failed" },
  };
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
    schemaVersion: "investment-analysis-input.v2",
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
  return {
    asOf: latest.date,
    source: "xueqiu",
    latestPrice: latest.close,
    marketCapYi: latest.marketCapital === null ? null : latest.marketCapital / 100_000_000,
    peTtm: latest.peTtm,
    pb: latest.pb,
    psTtm: latest.ps,
    pcfTtm: latest.pcf,
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
    "## 当前市场快照（工程实时获取）",
    `- 截至：${market.asOf}`,
    `- 数据源：${market.source}`,
    `- 最新价格：${display(market.latestPrice, input.security.currency ?? undefined)}`,
    `- 总市值：${display(market.marketCapYi, "亿元")}`,
    `- PE（TTM）：${display(market.peTtm)}`,
    `- PB：${display(market.pb)}`,
    `- PS（TTM）：${display(market.psTtm)}`,
    `- PCF（TTM）：${display(market.pcfTtm)}`,
    "",
    "## 分析框架（工程配置，不是公司事实）",
    `- 量价成本主公式：${framework?.primaryFormula ?? "未配置"}`,
    `- 优先核验指标：${framework?.operatingMetrics.join("、") || "未配置"}`,
    `- 可用估值方法：${framework?.valuationMethods.join("、") || "未配置"}`,
    `- 压力因素：${framework?.stressFactors.join("、") || "未配置"}`,
  ].join("\n");
}

function display(value: number | null, unit = ""): string {
  return value === null ? "未提供" : `${Number(value.toFixed(2))}${unit ? ` ${unit}` : ""}`;
}

async function projectResearchInvestmentAnalysis(env: AppEnv["Bindings"], input: Record<string, unknown>, task: TaskdTask) {
  const result = extractTaskdWebQaResult(task.result);
  validateResearchInvestmentAnalysisTerminalEvidence(result.terminalEvidence);
  const markdown = text(result.content.markdown);
  validateResearchInvestmentAnalysisMarkdown(markdown);
  const securityCode = text(object(input.security)?.code);
  if (!securityCode) throw new Error("investment analysis input has no security code");
  const projectedAt = Date.now();
  const stored = {
    inputJson: JSON.stringify(input),
    markdown,
    citationsJson: JSON.stringify(result.citations),
    sourcesJson: JSON.stringify(result.sources),
    terminalEvidenceJson: JSON.stringify(result.terminalEvidence),
    projectedAt,
    task: taskView(task),
  } satisfies StoredResultValue;
  await storeResult(env.DB, securityCode, stored);
  return { securityCode, ...stored };
}

async function loadResult(db: D1Database, securityCode: string): Promise<ResultRow | null> {
  const row = await readStoredResearchInvestmentAnalysis(db, securityCode);
  return row ? { securityCode, ...row } : null;
}

export async function writeStoredResearchInvestmentAnalysis(
  db: D1Database,
  securityCode: string,
  value: StoredResultValue,
): Promise<void> {
  await storeResult(db, securityCode, value);
}

export async function readStoredResearchInvestmentAnalysis(
  db: D1Database,
  securityCode: string,
): Promise<StoredResultValue | null> {
  const row = await getKvCache(db, INVESTMENT_ANALYSIS_NAMESPACE, securityCode);
  if (!row) return null;
  const parsed = object(parseJson(row.valueJson));
  if (!parsed) return null;
  const task = parseStoredTask(parsed.task);
  const inputJson = typeof parsed.inputJson === "string" ? parsed.inputJson : null;
  const markdown = text(parsed.markdown) || null;
  const projectedAt = parsed.projectedAt === null || parsed.projectedAt === undefined ? null : Number(parsed.projectedAt);
  if (!markdown && !task) return null;
  return {
    inputJson,
    markdown,
    citationsJson: jsonString(parsed.citationsJson, "[]"),
    sourcesJson: jsonString(parsed.sourcesJson, "[]"),
    terminalEvidenceJson: nullableJsonString(parsed.terminalEvidenceJson),
    projectedAt: Number.isFinite(projectedAt) ? projectedAt : null,
    task,
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
  const headings = new Set([...markdown.matchAll(/^# ([1-9]|1[0-2])\. /gm)].map((match) => match[1]));
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

function taskView(task: Pick<TaskdTask, "name" | "status" | "errorMessage" | "createdAt" | "updatedAt" | "completedAt">) { return { name: task.name, status: task.status, errorMessage: task.errorMessage, createdAt: task.createdAt, updatedAt: task.updatedAt, completedAt: task.completedAt }; }
function responseFromStoredResult(result: ResultRow) {
  const task = result.task;
  return {
    availability: result.markdown ? "available" as const : task?.status === "failed" ? "failed" as const : task ? "pending" as const : "empty" as const,
    task,
    input: parseJson(result.inputJson),
    report: result.markdown ? {
      markdown: result.markdown,
      citations: parseArray(result.citationsJson),
      sources: parseArray(result.sourcesJson),
      terminalMetadata: parseJson(result.terminalEvidenceJson),
      projectedAt: result.projectedAt,
    } : null,
    resume: { available: task?.status === "failed", reason: task?.status === "failed" ? "submit_new_task" : result.markdown ? "already_projected" : "not_failed" },
  };
}
async function persistTaskSnapshot(
  db: D1Database,
  securityCode: string,
  current: ResultRow | null,
  input: Record<string, unknown> | null,
  task: TaskdTask | null,
): Promise<ResultRow> {
  const stored = mergeStoredResult(current, {
    inputJson: input ? JSON.stringify(input) : undefined,
    task: task ? taskView(task) : null,
  });
  await storeResult(db, securityCode, stored);
  return { securityCode, ...stored };
}
async function storeResult(db: D1Database, securityCode: string, value: StoredResultValue): Promise<void> {
  await putKvCache(db, {
    namespace: INVESTMENT_ANALYSIS_NAMESPACE,
    key: securityCode,
    valueJson: JSON.stringify(value),
    expiresAt: null,
    updatedAt: value.projectedAt ?? value.task?.updatedAt ?? Date.now(),
  });
}
function mergeStoredResult(current: ResultRow | StoredResultValue | null, patch: {
  inputJson?: string | null;
  markdown?: string | null;
  citationsJson?: string;
  sourcesJson?: string;
  terminalEvidenceJson?: string | null;
  projectedAt?: number | null;
  task?: StoredTaskValue | null;
}): StoredResultValue {
  return {
    inputJson: patch.inputJson !== undefined ? patch.inputJson : current?.inputJson ?? null,
    markdown: patch.markdown !== undefined ? patch.markdown : current?.markdown ?? null,
    citationsJson: patch.citationsJson ?? current?.citationsJson ?? "[]",
    sourcesJson: patch.sourcesJson ?? current?.sourcesJson ?? "[]",
    terminalEvidenceJson: patch.terminalEvidenceJson !== undefined ? patch.terminalEvidenceJson : current?.terminalEvidenceJson ?? null,
    projectedAt: patch.projectedAt !== undefined ? patch.projectedAt : current?.projectedAt ?? null,
    task: patch.task !== undefined ? patch.task : current?.task ?? null,
  };
}
function parseStoredTask(value: unknown): StoredTaskValue | null {
  const row = object(value);
  const name = text(row?.name);
  const status = text(row?.status) as TaskdTask["status"];
  const createdAt = Number(row?.createdAt);
  const updatedAt = Number(row?.updatedAt);
  if (!name || !isTaskStatus(status) || !Number.isFinite(createdAt) || !Number.isFinite(updatedAt)) return null;
  const completedAt = row?.completedAt === null || row?.completedAt === undefined ? null : Number(row?.completedAt);
  return {
    name,
    status,
    errorMessage: text(row?.errorMessage) || null,
    createdAt,
    updatedAt,
    completedAt: Number.isFinite(completedAt) ? completedAt : null,
  };
}
function isPendingTask(task: StoredTaskValue | TaskdTask | null | undefined): boolean {
  return task?.status === "queued" || task?.status === "leased" || task?.status === "running" || task?.status === "interrupt_requested";
}
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
