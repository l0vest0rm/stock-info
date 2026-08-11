import type { AppEnv } from "../../../types";
import { createGenericLlmTask, loadGenericLlmRun, loadGenericLlmRunArtifacts, loadGenericLlmTask, type GenericLlmTask } from "../../../shared/local-job-protocol";
import { loadResearchFinancialQuality } from "./research-financials";
import { loadResearchFinancialProfile } from "./research-financial-profile";
import {
  buildFinancialAnalysisSnapshot,
  assertFinancialAnalysisSnapshotCanRun,
  financialAnalysisPrompt,
  FINANCIAL_ANALYSIS_ORIGIN_TASK_TYPE,
  FINANCIAL_ANALYSIS_PROMPT_VERSION,
  FINANCIAL_ANALYSIS_PROTOCOL_VERSION,
  FINANCIAL_ANALYSIS_TARGET_TYPE,
  type FinancialAnalysisSnapshot,
} from "../domain/financial-analysis";

const MODEL = "gpt-5.6-luna";
const DEFAULT_REASONING_EFFORT = "xhigh";
const PRIORITY = 520;

type Row = { taskId?: string };

export async function enqueueResearchFinancialAnalysis(env: AppEnv["Bindings"], securityCode: string, options: { force?: boolean; reasoningEffort?: string | null } = {}) {
  const snapshot = await buildSnapshot(env, securityCode);
  assertFinancialAnalysisSnapshotCanRun(snapshot);
  const versionKey = options.force === true ? `${snapshot.lineage.inputFingerprint}:${Date.now()}` : snapshot.lineage.inputFingerprint;
  const prompt = financialAnalysisPrompt(snapshot);
  const created = await createGenericLlmTask(env.DB, {
    taskType: "generic_raw_model",
    targetType: FINANCIAL_ANALYSIS_TARGET_TYPE,
    targetId: securityCode,
    idempotencyKey: `research-financial-analysis:${securityCode}:${versionKey}`,
    protocolVersion: FINANCIAL_ANALYSIS_PROTOCOL_VERSION,
    promptVersion: FINANCIAL_ANALYSIS_PROMPT_VERSION,
    handlerKey: "generic_raw_model",
    model: MODEL,
    reasoningEffort: options.reasoningEffort || DEFAULT_REASONING_EFFORT,
    priority: PRIORITY,
    metadata: {
      originTaskType: FINANCIAL_ANALYSIS_ORIGIN_TASK_TYPE,
      financialAnalysis: { snapshot, inputFingerprint: snapshot.lineage.inputFingerprint, codeVersion: snapshot.codeVersion },
      rawModelRequest: {
        provider: "openai",
        model: MODEL,
        requestId: `research-financial-analysis:${securityCode}:${versionKey}`,
        instructions: "你是严谨的投资研究员。只使用给定证据，不得用模型记忆补齐缺口；严格按输出标题返回。",
        input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
        // This is a caller-owned artifact contract, deliberately separate
        // from the WebQA provider-terminal contract. The generic adapter can
        // validate its declared shape without knowing this task type.
        artifactContract: { kind: "markdown_h1", numberedH1: true, requiredH1Count: 8, minimumCharacters: 800 },
        allowReasoning: true,
        reasoningEffort: options.reasoningEffort || DEFAULT_REASONING_EFFORT,
        maxOutputTokens: 18000,
        toolChoice: "none",
        stream: true,
      },
    },
  });
  return { ...created, snapshot };
}

export async function loadResearchFinancialAnalysis(env: AppEnv["Bindings"], securityCode: string) {
  const task = await loadLatestFinancialAnalysisTask(env.DB, securityCode);
  if (!task) return { availability: "empty" as const, task: null, run: null, report: null, snapshot: null, resume: { available: false, reason: "no_report" } };
  const run = task.lastRunId ? await loadGenericLlmRun(env.DB, task.lastRunId) : null;
  const artifacts = run ? await loadGenericLlmRunArtifacts(env.DB, run.runId) : [];
  const terminal = artifacts.filter((item) => item.stepKey === "raw_model" && item.status === "complete").at(-1) ?? null;
  const output = terminal?.output && typeof terminal.output === "object" && !Array.isArray(terminal.output) ? terminal.output as Record<string, unknown> : {};
  const answer = output.answer && typeof output.answer === "object" && !Array.isArray(output.answer) ? output.answer as Record<string, unknown> : null;
  const markdown = typeof answer?.content === "object" && answer.content && typeof (answer.content as Record<string, unknown>).markdown === "string"
    ? (answer.content as Record<string, unknown>).markdown as string
    : typeof output.text === "string" ? output.text : null;
  const metadata = task.metadata && typeof task.metadata === "object" && !Array.isArray(task.metadata) ? task.metadata as Record<string, unknown> : {};
  const financialAnalysis = metadata.financialAnalysis && typeof metadata.financialAnalysis === "object" && !Array.isArray(metadata.financialAnalysis) ? metadata.financialAnalysis as Record<string, unknown> : {};
  return {
    availability: task.status === "completed" && markdown ? "available" as const : task.status === "failed" ? "failed" as const : "pending" as const,
    task,
    run,
    snapshot: financialAnalysis.snapshot ?? null,
    report: markdown ? {
      markdown,
      artifactId: terminal?.artifactId ?? null,
      citations: Array.isArray(answer?.citations) ? answer.citations : [],
      sources: Array.isArray(answer?.sources) ? answer.sources : [],
      terminalMetadata: terminal?.terminalMetadata ?? null,
    } : null,
    resume: {
      // Failed WebQA tasks own no completed report artifact. Requeueing would
      // only poll the already terminal gateway task and replay its failure.
      available: false,
      reason: task.status === "failed" ? "rerun_required" : "latest_run_not_failed",
    },
  };
}

export async function resumeResearchFinancialAnalysis(env: AppEnv["Bindings"], securityCode: string) {
  const task = await loadLatestFinancialAnalysisTask(env.DB, securityCode);
  if (!task || task.status !== "failed") throw new Error("only the latest failed financial-analysis run can resume");
  throw new Error("financial-analysis WebQA failure has no reusable report artifact; use refresh to create a new request");
}

async function buildSnapshot(env: AppEnv["Bindings"], securityCode: string): Promise<FinancialAnalysisSnapshot> {
  const profile = await loadResearchFinancialProfile(env.DB, securityCode);
  const financials = await loadResearchFinancialQuality(env, securityCode, { entityType: profile.qualityEntityType });
  return buildFinancialAnalysisSnapshot({
    securityCode,
    entityType: profile.qualityEntityType,
    sourcePolicy: financials.sourcePolicy,
    availability: financials.availability,
    statutoryGate: financials.statutoryGate,
    statements: financials.statements,
    quality: financials.quality,
  });
}

async function loadLatestFinancialAnalysisTask(db: D1Database, securityCode: string): Promise<GenericLlmTask | null> {
  const row = await db.prepare(`select task_id as taskId from llm_tasks
    where task_type='generic_raw_model' and target_type=? and target_id=?
    order by created_at desc, task_id desc limit 1`).bind(FINANCIAL_ANALYSIS_TARGET_TYPE, securityCode).first<Row>();
  return row?.taskId ? loadGenericLlmTask(db, row.taskId) : null;
}
