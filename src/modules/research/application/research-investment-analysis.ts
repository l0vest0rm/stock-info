import type { AppEnv } from "../../../types";
import { RESEARCH_OPERATING_ANALYSIS_SYSTEM_PROMPT } from "../../../generated/prompt-text";
import { taskdWebQaInput } from "../../../shared/llm-client";
import { taskdCallerClient, type TaskdTask } from "../../../shared/taskd-client";
import { reconcileTaskdResult } from "../../../shared/taskd-result-projection";
import { loadResearchFinancialProfile } from "./research-financial-profile";
import { loadResearchFinancialQuality } from "./research-financials";

const TASK_TYPE = "webqa.chatgpt.v1";
const MODEL = "gpt-5.6-luna" as const;
const DEFAULT_REASONING_EFFORT = "xhigh";
const PROMPT_VERSION = "investment-analysis.taskd.v1";

type Row = Record<string, unknown>;
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

export async function resumeResearchInvestmentAnalysis(env: AppEnv["Bindings"], securityCode: string, reasoningEffort?: string | null) {
  return enqueueResearchInvestmentAnalysis(env, securityCode, { reasoningEffort });
}

async function prepareResearchInvestmentAnalysis(env: AppEnv["Bindings"], securityCode: string) {
  const code = securityCode.trim().toUpperCase();
  const security = await env.DB.prepare("select code, name, market, type, currency from securities where code=?").bind(code).first<{ code: string; name: string; market: string; type: string; currency: string | null }>();
  if (!security) throw new Error("security was not found");
  const profile = await loadResearchFinancialProfile(env.DB, code);
  const financials = await loadResearchFinancialQuality(env, code, { entityType: profile.qualityEntityType });
  const input = {
    schemaVersion: "investment-analysis-input.v1",
    promptVersion: PROMPT_VERSION,
    preparedAt: new Date().toISOString(),
    security: { code: security.code, name: security.name, market: security.market, type: security.type, currency: security.currency },
    financialProfile: { entityType: profile.qualityEntityType },
    financials: {
      availability: financials.availability,
      sourcePolicy: financials.sourcePolicy,
      statutoryGate: financials.statutoryGate,
      statements: financials.statements,
      quality: financials.quality,
    },
  };
  return { securityCode: code, input, prompt: buildPrompt(input) };
}

function buildPrompt(input: Record<string, unknown>): string {
  return [
    "请基于以下由 stock-info 工程侧采集并冻结的必要输入，使用 ChatGPT 的公开 Web 检索补充可核验的公司、行业、竞争与风险证据，撰写完整中文投资分析报告。",
    "只输出 Markdown 正文；不得输出任务日志、JSON、内部 ID 或单独来源附录。缺失、冲突或未核验的事实必须明确保留为未知，不能以模型记忆补数。工程输入中的财务口径、期间和来源优先于搜索摘要。",
    "报告必须使用以下 12 个一级标题：# 1. 研究范围与事实边界 至 # 12. 最终结论；每章给出结论、依据、期间/口径、限制和待验证问题。正文附近自然放置可核验链接。估值须区分事实与估计，不编造目标价或确定性结论。",
    "\n## 工程冻结输入\n```json\n" + JSON.stringify(input, null, 2) + "\n```",
  ].join("\n\n");
}

async function projectResearchInvestmentAnalysis(env: AppEnv["Bindings"], input: Record<string, unknown>, task: TaskdTask) {
  const result = object(task.result);
  const answer = object(result?.answer);
  const content = object(answer?.content);
  const markdown = text(content?.markdown);
  validateMarkdown(markdown);
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

function validateMarkdown(markdown: string) {
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
