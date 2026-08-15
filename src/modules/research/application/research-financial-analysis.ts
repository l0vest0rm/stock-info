import type { AppEnv } from "../../../types";
import { taskdWebQaInput } from "../../../shared/llm-client";
import { taskdCallerClient, type TaskdTask } from "../../../shared/taskd-client";
import { reconcileTaskdResult } from "../../../shared/taskd-result-projection";
import { loadResearchFinancialQuality } from "./research-financials";
import { loadResearchFinancialProfile } from "./research-financial-profile";
import {
  buildFinancialAnalysisSnapshot,
  assertFinancialAnalysisSnapshotCanRun,
  financialAnalysisPrompt,
  FINANCIAL_ANALYSIS_PROMPT_VERSION,
  FINANCIAL_ANALYSIS_TARGET_TYPE,
  type FinancialAnalysisSnapshot,
} from "../domain/financial-analysis";

const MODEL = "gpt-5.6-luna" as const;
const DEFAULT_REASONING_EFFORT = "xhigh";
const TASK_TYPE = "webqa.chatgpt.v1";

type ResultRow = {
  securityCode: string;
  inputFingerprint: string;
  promptVersion: string;
  snapshotJson: string;
  markdown: string;
  citationsJson: string;
  sourcesJson: string;
  terminalEvidenceJson: string;
  projectedAt: number;
};

export function researchFinancialAnalysisTaskName(securityCode: string, inputFingerprint: string): string {
  return `research-financial-analysis:${securityCode}:${inputFingerprint}:${FINANCIAL_ANALYSIS_PROMPT_VERSION}`;
}

export async function enqueueResearchFinancialAnalysis(
  env: AppEnv["Bindings"],
  securityCode: string,
  options: { force?: boolean; reasoningEffort?: string | null } = {},
) {
  const snapshot = await buildSnapshot(env, securityCode);
  assertFinancialAnalysisSnapshotCanRun(snapshot);
  const name = researchFinancialAnalysisTaskName(securityCode, snapshot.lineage.inputFingerprint);
  const reasoningEffort = options.reasoningEffort || DEFAULT_REASONING_EFFORT;
  const task = await taskdCallerClient(env).submit({
    name,
    taskType: TASK_TYPE,
    payload: taskdWebQaInput(env, {
      model: MODEL,
      reasoningEffort: reasoningEffort as "low" | "medium" | "high" | "xhigh",
      waitTimeoutMs: 60 * 60_000,
      messages: [{ role: "user", content: financialAnalysisPrompt(snapshot) }],
    }, name),
  });
  return { accepted: true, task: taskView(task), snapshot, force: options.force === true };
}

export async function loadResearchFinancialAnalysis(env: AppEnv["Bindings"], securityCode: string) {
  const snapshot = await buildSnapshot(env, securityCode);
  const name = researchFinancialAnalysisTaskName(securityCode, snapshot.lineage.inputFingerprint);
  const state = env.LLM_RUNTIME === "local"
    ? await reconcileTaskdResult(taskdCallerClient(env), {
      name,
      project: (task) => projectResearchFinancialAnalysis(env, snapshot, task),
    })
    : { state: "missing" as const };
  const row = await loadFinancialAnalysisResult(env.DB, securityCode, snapshot.lineage.inputFingerprint);
  const task = "task" in state ? state.task : null;
  return {
    availability: row ? "available" as const : state.state === "failed" ? "failed" as const : task ? "pending" as const : "empty" as const,
    task: task ? taskView(task) : null,
    run: null,
    snapshot,
    report: row ? {
      markdown: row.markdown,
      citations: jsonArray(row.citationsJson),
      sources: jsonArray(row.sourcesJson),
      terminalMetadata: jsonObject(row.terminalEvidenceJson),
    } : null,
    resume: { available: state.state === "failed", reason: state.state === "failed" ? "submit_new_task" : row ? "already_projected" : "not_failed" },
  };
}

export async function resumeResearchFinancialAnalysis(env: AppEnv["Bindings"], securityCode: string) {
  // taskd's name semantics intentionally create a new task and supersede the
  // failed/latest one. There is no local gateway recovery or task-id mapping.
  return enqueueResearchFinancialAnalysis(env, securityCode, { force: true });
}

async function projectResearchFinancialAnalysis(env: AppEnv["Bindings"], snapshot: FinancialAnalysisSnapshot, task: TaskdTask) {
  const result = object(task.result);
  const markdown = text(result?.markdown);
  validateFinancialMarkdown(markdown);
  const now = Date.now();
  await env.DB.prepare(`insert into research_financial_analysis_results (
      security_code, input_fingerprint, prompt_version, snapshot_json, markdown,
      citations_json, sources_json, terminal_evidence_json, projected_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(security_code, input_fingerprint, prompt_version) do update set
      snapshot_json=excluded.snapshot_json, markdown=excluded.markdown,
      citations_json=excluded.citations_json, sources_json=excluded.sources_json,
      terminal_evidence_json=excluded.terminal_evidence_json, projected_at=excluded.projected_at`)
    .bind(
      snapshot.securityCode,
      snapshot.lineage.inputFingerprint,
      FINANCIAL_ANALYSIS_PROMPT_VERSION,
      JSON.stringify(snapshot),
      markdown,
      JSON.stringify(Array.isArray(result?.citations) ? result.citations : []),
      JSON.stringify(Array.isArray(result?.sources) ? result.sources : []),
      JSON.stringify(result?.terminal_evidence ?? null),
      now,
    ).run();
  return { securityCode: snapshot.securityCode, inputFingerprint: snapshot.lineage.inputFingerprint, projectedAt: now };
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

async function loadFinancialAnalysisResult(db: D1Database, securityCode: string, inputFingerprint: string): Promise<ResultRow | null> {
  return await db.prepare(`select security_code as securityCode, input_fingerprint as inputFingerprint,
      prompt_version as promptVersion, snapshot_json as snapshotJson, markdown, citations_json as citationsJson,
      sources_json as sourcesJson, terminal_evidence_json as terminalEvidenceJson, projected_at as projectedAt
    from research_financial_analysis_results
    where security_code=? and input_fingerprint=? and prompt_version=?`)
    .bind(securityCode, inputFingerprint, FINANCIAL_ANALYSIS_PROMPT_VERSION).first<ResultRow>();
}

function validateFinancialMarkdown(markdown: string): void {
  if (markdown.length < 800) throw new Error("financial analysis result is shorter than 800 characters");
  const headings = new Set([...markdown.matchAll(/^# ([1-8])\. /gm)].map((match) => match[1]));
  if (headings.size !== 8) throw new Error("financial analysis result must contain all eight numbered H1 headings");
}

function taskView(task: TaskdTask) {
  return { name: task.name, status: task.status, errorMessage: task.errorMessage, createdAt: task.createdAt, updatedAt: task.updatedAt, completedAt: task.completedAt };
}

function object(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function jsonArray(value: string): unknown[] { try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; } }
function jsonObject(value: string): Record<string, unknown> | null { try { const parsed = JSON.parse(value); return object(parsed); } catch { return null; } }
