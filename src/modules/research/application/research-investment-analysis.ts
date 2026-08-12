import type { AppEnv, KlineBar } from "../../../types";
import { RESEARCH_OPERATING_ANALYSIS_PROMPT, RESEARCH_OPERATING_ANALYSIS_SYSTEM_PROMPT } from "../../../generated/prompt-text";
import { taskdWebQaInput } from "../../../shared/llm-client";
import { taskdCallerClient, type TaskdTask } from "../../../shared/taskd-client";
import { reconcileTaskdResult } from "../../../shared/taskd-result-projection";
import { loadKline } from "../../market/application/load-kline";
import industryProfiles from "../../../../config/research-eastmoney-em2016-industry-profiles.json";
import companyProfiles from "../../../../config/eastmoney-company-em2016-profiles.json";

const TASK_TYPE = "webqa.chatgpt.v1";
const MODEL = "gpt-5.6-luna" as const;
const DEFAULT_REASONING_EFFORT = "xhigh";
const PROMPT_VERSION = "investment-analysis.taskd.v2";

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
  inputJson: string;
  markdown: string;
  citationsJson: string;
  sourcesJson: string;
  terminalEvidenceJson: string | null;
  projectedAt: number;
};

export function researchInvestmentAnalysisTaskName(securityCode: string): string {
  return `research:investment-analysis:${securityCode}`;
}

export async function enqueueResearchInvestmentAnalysis(
  env: AppEnv["Bindings"],
  securityCode: string,
  options: { reasoningEffort?: string | null } = {},
) {
  const prepared = await prepareResearchInvestmentAnalysis(env, securityCode);
  const name = researchInvestmentAnalysisTaskName(prepared.securityCode);
  const task = await taskdCallerClient(env).submit({
    name,
    taskType: TASK_TYPE,
    payload: {
      ...taskdWebQaInput(env, {
      model: MODEL,
      reasoningEffort: normalizeReasoningEffort(options.reasoningEffort),
      waitTimeoutMs: 2 * 60 * 60_000,
      messages: [
        { role: "system", content: RESEARCH_OPERATING_ANALYSIS_SYSTEM_PROMPT },
        { role: "user", content: prepared.prompt },
      ],
      }, name),
      // The executor ignores this field; it is retained in taskd with the
      // exact engineering snapshot that produced the submitted prompt.
      business_input: prepared.input,
    },
  });
  return { accepted: true, task: taskView(task), input: prepared.input };
}

export async function loadResearchInvestmentAnalysis(env: AppEnv["Bindings"], securityCode: string) {
  const prepared = await prepareResearchInvestmentAnalysis(env, securityCode);
  const name = researchInvestmentAnalysisTaskName(prepared.securityCode);
  const state = env.LLM_RUNTIME === "local"
    ? await reconcileTaskdResult(taskdCallerClient(env), {
      name,
      project: (task) => projectResearchInvestmentAnalysis(env, taskBusinessInput(task) || prepared.input, task),
    })
    : { state: "missing" as const };
  const result = await loadResult(env.DB, prepared.securityCode);
  const task = "task" in state ? state.task : null;
  return {
    availability: result ? "available" as const : state.state === "failed" ? "failed" as const : task ? "pending" as const : "empty" as const,
    task: task ? taskView(task) : null,
    input: result ? parseJson(result.inputJson) : prepared.input,
    report: result ? {
      markdown: result.markdown,
      citations: parseArray(result.citationsJson),
      sources: parseArray(result.sourcesJson),
      terminalMetadata: parseJson(result.terminalEvidenceJson),
      projectedAt: result.projectedAt,
    } : null,
    resume: { available: state.state === "failed", reason: state.state === "failed" ? "submit_new_task" : result ? "already_projected" : "not_failed" },
  };
}

async function prepareResearchInvestmentAnalysis(env: AppEnv["Bindings"], securityCode: string) {
  const code = securityCode.trim().toUpperCase();
  const security = await env.DB.prepare("select code, name, market, type, currency from securities where code=?").bind(code).first<{ code: string; name: string; market: string; type: string; currency: string | null }>();
  if (!security) throw new Error("security was not found");
  const [marketSnapshot, localProfile] = await Promise.all([
    loadInvestmentAnalysisMarketSnapshot(env, code),
    Promise.resolve(localCompanyProfile(code)),
  ]);
  const input: InvestmentAnalysisInput = {
    schemaVersion: "investment-analysis-input.v2",
    promptVersion: PROMPT_VERSION,
    preparedAt: new Date().toISOString(),
    security: { code: security.code, name: security.name, market: security.market, type: security.type, currency: security.currency },
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
  const boundary = input.businessBoundary;
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
    "## 本地业务边界状态",
    `- 状态：${boundary.status}`,
    `- 说明：${boundary.note ?? "未提供"}`,
    `- 已确认产品：${boundary.products.join("、") || "未提供"}`,
    `- 已确认客户：${boundary.customers.join("、") || "未提供"}`,
    `- 已确认地区：${boundary.regions.join("、") || "未提供"}`,
    "",
    "## 分析框架（工程配置，不是公司事实）",
    `- 量价成本主公式：${framework?.primaryFormula ?? "未配置"}`,
    `- 优先核验指标：${framework?.operatingMetrics.join("、") || "未配置"}`,
    `- 可用估值方法：${framework?.valuationMethods.join("、") || "未配置"}`,
    `- 压力因素：${framework?.stressFactors.join("、") || "未配置"}`,
  ].join("\n");
}

function display(value: number | null, unit = ""): string { return value === null ? "未提供" : `${value}${unit ? ` ${unit}` : ""}`; }

async function projectResearchInvestmentAnalysis(env: AppEnv["Bindings"], input: Record<string, unknown>, task: TaskdTask) {
  const result = object(task.result);
  validateResearchInvestmentAnalysisTerminalEvidence(result);
  const answer = object(result?.answer);
  const content = object(answer?.content);
  const markdown = text(content?.markdown);
  validateResearchInvestmentAnalysisMarkdown(markdown);
  const securityCode = text(object(input.security)?.code);
  if (!securityCode) throw new Error("investment analysis input has no security code");
  const projectedAt = Date.now();
  await env.DB.prepare(`insert into research_investment_analysis_results (
      security_code,input_json,markdown,citations_json,sources_json,terminal_evidence_json,projected_at
    ) values (?,?,?,?,?,?,?)
    on conflict(security_code) do update set
      input_json=excluded.input_json,markdown=excluded.markdown,citations_json=excluded.citations_json,
      sources_json=excluded.sources_json,terminal_evidence_json=excluded.terminal_evidence_json,projected_at=excluded.projected_at`)
    .bind(
      securityCode,
      JSON.stringify(input),
      markdown,
      JSON.stringify(Array.isArray(answer?.citations) ? answer.citations : []),
      JSON.stringify(Array.isArray(answer?.sources) ? answer.sources : []),
      JSON.stringify(result?.terminal_evidence ?? null),
      projectedAt,
    ).run();
  return { securityCode, projectedAt };
}

async function loadResult(db: D1Database, securityCode: string): Promise<ResultRow | null> {
  return await db.prepare(`select security_code as securityCode,input_json as inputJson,markdown,citations_json as citationsJson,
      sources_json as sourcesJson,terminal_evidence_json as terminalEvidenceJson,projected_at as projectedAt
    from research_investment_analysis_results where security_code=?`).bind(securityCode).first<ResultRow>();
}

export function validateResearchInvestmentAnalysisTerminalEvidence(result: Record<string, unknown> | null): void {
  const evidence = object(result?.terminal_evidence);
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

function taskView(task: TaskdTask) { return { name: task.name, status: task.status, errorMessage: task.errorMessage, createdAt: task.createdAt, updatedAt: task.updatedAt, completedAt: task.completedAt }; }
function object(value: unknown): Row | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null; }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function parseJson(value: string | null): unknown { try { return value ? JSON.parse(value) : null; } catch { return null; } }
function parseArray(value: string): unknown[] { const parsed = parseJson(value); return Array.isArray(parsed) ? parsed : []; }
