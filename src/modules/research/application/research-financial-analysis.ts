import type { AppEnv } from "../../../types";
import { getKvCache, putKvCache } from "../../../db/queries";
import { taskdWebQaInput } from "../../../shared/llm-client";
import { taskdCallerClient, type TaskdTask } from "../../../shared/taskd-client";
import { reconcileTaskdResult } from "../../../shared/taskd-result-projection";
import { extractTaskdWebQaResult } from "../../../shared/taskd-webqa-result";
import { loadResearchFinancialFactSet } from "./research-financials";
import { buildResearchFinancialQuality } from "../domain/research-financial-quality";
import {
  buildFinancialAnalysisSnapshot,
  assertFinancialAnalysisSnapshotCanRun,
  financialAnalysisPrompt,
  type FinancialAnalysisSnapshot,
} from "../domain/financial-analysis";

const MODEL = "gpt-5.6-luna" as const;
const DEFAULT_REASONING_EFFORT = "xhigh";
const TASK_TYPE = "webqa.chatgpt.v1";
const FINANCIAL_ANALYSIS_NAMESPACE = "research_financial_analysis";

type Row = Record<string, unknown>;
type StoredTaskValue = { taskId: number | null; name: string; status: TaskdTask["status"]; errorMessage: string | null; createdAt: number; updatedAt: number; completedAt: number | null };
type StoredResultValue = { snapshotJson: string | null; markdown: string | null; citationsJson: string; sourcesJson: string; terminalEvidenceJson: string | null; projectedAt: number | null; projectionError: string | null; task: StoredTaskValue | null };
type ResultRow = StoredResultValue & { securityCode: string };

/** One stable taskd task owns the current run. Its frozen input and result are
 * projected into one kv_cache record, never a financial-analysis result table. */
export function researchFinancialAnalysisTaskName(securityCode: string): string {
  return `research:financial-analysis:${securityCode.trim().toUpperCase()}`;
}

export async function enqueueResearchFinancialAnalysis(env: AppEnv["Bindings"], securityCode: string, options: { force?: boolean; reasoningEffort?: string | null } = {}) {
  const prepared = await prepareResearchFinancialAnalysis(env, securityCode);
  const current = await loadResult(env.DB, prepared.snapshot.securityCode);
  const reasoningEffort = normalizeReasoningEffort(options.reasoningEffort);
  const name = researchFinancialAnalysisTaskName(prepared.snapshot.securityCode);
  const task = await taskdCallerClient(env).submit({
    name,
    taskType: TASK_TYPE,
    payload: {
      ...taskdWebQaInput(env, { model: MODEL, reasoningEffort, waitTimeoutMs: 60 * 60_000, messages: [{ role: "user", content: prepared.prompt }] }, name),
      // taskd retains this exact input; the executor intentionally ignores it.
      business_input: prepared.snapshot,
    },
    diagnostics: { securityCode: prepared.snapshot.securityCode, model: MODEL, reasoningEffort, promptVersion: prepared.snapshot.codeVersion, schemaVersion: prepared.snapshot.schemaVersion },
  });
  await storeResult(env.DB, prepared.snapshot.securityCode, mergeStoredResult(current, { snapshotJson: JSON.stringify(prepared.snapshot), task: taskView(task) }));
  return { accepted: true, task: taskView(task), snapshot: prepared.snapshot, force: options.force === true };
}

export async function loadResearchFinancialAnalysis(env: AppEnv["Bindings"], securityCode: string) {
  const code = securityCode.trim().toUpperCase();
  let result = await loadResult(env.DB, code);
  if (result?.markdown && !isPendingTask(result.task)) return responseFromStoredResult(result);

  let task: StoredTaskValue | null = result?.task ?? null;
  // The cache is the local read model. Only a locally recorded in-flight task
  // is reconciled with taskd; an untouched page must not probe taskd or fetch
  // prompt inputs until the user explicitly starts a run.
  if (env.LLM_RUNTIME === "local" && result && task && !result.markdown) {
    const state = await reconcileTaskdResult(taskdCallerClient(env), {
      name: task.name,
      project: async (currentTask) => {
        const snapshot = taskBusinessSnapshot(currentTask) ?? snapshotFromJson(result?.snapshotJson);
        if (!snapshot) throw new Error("financial analysis task has no frozen input snapshot");
        return projectResearchFinancialAnalysis(env, snapshot, currentTask);
      },
    });
    try {
      switch (state.state) {
        case "projected": result = state.value; task = state.value.task; break;
        case "pending":
        case "failed":
        case "interrupted":
        case "superseded":
          task = taskView(state.task);
          result = await persistTaskSnapshot(env.DB, code, result, taskBusinessSnapshot(state.task) ?? snapshotFromJson(result?.snapshotJson), state.task, null);
          break;
        case "missing":
          task = null;
          if (result?.task) result = await persistTaskSnapshot(env.DB, code, result, snapshotFromJson(result.snapshotJson), null, "taskd no longer has the recorded financial-analysis task");
          break;
      }
    } catch (error) {
      // A provider-side success is not a report success until the frozen
      // artifact passes validation. Persist that projection failure so the UI
      // never lies by showing an eternal in-progress state, and a later
      // recovery can retry projection without submitting the prompt again.
      const message = error instanceof Error ? error.message : String(error);
      result = await persistTaskSnapshot(env.DB, code, result, snapshotFromJson(result.snapshotJson), task, message);
    }
  }
  if (result) return responseFromStoredResult(result);
  return { availability: task?.status === "failed" ? "failed" as const : task ? "pending" as const : "empty" as const, task, snapshot: null, report: null, resume: { available: task?.status === "failed", reason: task?.status === "failed" ? "submit_new_task" : "not_failed" } };
}

export async function resumeResearchFinancialAnalysis(env: AppEnv["Bindings"], securityCode: string) {
  const code = securityCode.trim().toUpperCase();
  const stored = await loadResult(env.DB, code);
  if (!stored?.task) throw new Error("financial analysis has no recorded task to recover");
  if (env.LLM_RUNTIME !== "local") throw new Error("financial analysis recovery is only available in local LLM runtime");

  // Taskd submit would create a new task and could emit a second provider
  // prompt. A saved provider_submission.v1 checkpoint authorizes only the
  // dedicated in-place recovery route, which retains the same task id/name
  // and lets the executor re-open the original provider turn.
  const client = taskdCallerClient(env);
  let remote = await client.get(stored.task.name);
  if (remote && isTerminalTask(remote) && hasRecoverableProviderSubmission(remote.checkpoint)) {
    remote = await client.recover(stored.task.name);
  }
  if (!remote) {
    await persistTaskSnapshot(env.DB, code, stored, snapshotFromJson(stored.snapshotJson), null, "taskd no longer has the recorded financial-analysis task");
  } else {
    await persistTaskSnapshot(env.DB, code, stored, taskBusinessSnapshot(remote) ?? snapshotFromJson(stored.snapshotJson), remote, null);
  }
  return loadResearchFinancialAnalysis(env, code);
}

async function prepareResearchFinancialAnalysis(env: AppEnv["Bindings"], securityCode: string) {
  const { security, loaded, facts, sourceErrors, primaryAvailable } = await loadResearchFinancialFactSet(env, securityCode);
  const availability = sourceErrors.length ? "source_error" as const : primaryAvailable ? "available" as const : "partial" as const;
  const snapshot = buildFinancialAnalysisSnapshot({
    securityCode: security.code,
    // This task's prompt is built only from request-time primary finance APIs.
    // A security code cannot establish whether the issuer is a financial entity.
    entityType: "unknown",
    sourcePolicy: financialAnalysisSourcePolicy(security.market),
    availability,
    statutoryGate: { status: "not_loaded", verifiedMetrics: [], reason: "本任务仅冻结主财报接口数据；法定披露核验明细不属于 taskd 财务分析的前置输入。" },
    statements: loaded.map(({ statementType, result, error }) => ({
      statementType, rows: result.rows.length, source: result.delivery?.cache ?? "source_error",
      originProviders: result.delivery?.originProviders ?? [], reportingCurrencies: result.reportingCurrencies,
      latestReportDate: result.latestReportDate, sourceHealth: result.sourceHealth, error,
    })),
    quality: buildResearchFinancialQuality({ facts, entityType: "unknown" }),
  });
  assertFinancialAnalysisSnapshotCanRun(snapshot);
  return { snapshot, prompt: financialAnalysisPrompt(snapshot) };
}

function financialAnalysisSourcePolicy(market: string): string {
  return market === "us_share" ? "Yahoo 主财报（本地经配置代理；生产统一 HTTP；无自动回退）"
    : market === "h_share" ? "Eastmoney HK F10 主财报（无自动回退）"
      : "Eastmoney 主财报（无自动回退）";
}

async function projectResearchFinancialAnalysis(env: AppEnv["Bindings"], snapshot: FinancialAnalysisSnapshot, task: TaskdTask): Promise<ResultRow> {
  const result = extractTaskdWebQaResult(task.result);
  const markdown = text(result.content.markdown);
  validateFinancialMarkdown(markdown);
  const stored: StoredResultValue = {
    snapshotJson: JSON.stringify(snapshot), markdown, citationsJson: JSON.stringify(result.citations), sourcesJson: JSON.stringify(result.sources),
    terminalEvidenceJson: JSON.stringify(result.terminalEvidence), projectedAt: Date.now(), projectionError: null, task: taskView(task),
  };
  await storeResult(env.DB, snapshot.securityCode, stored);
  return { securityCode: snapshot.securityCode, ...stored };
}

async function loadResult(db: D1Database, securityCode: string): Promise<ResultRow | null> {
  const value = await readStoredResearchFinancialAnalysis(db, securityCode);
  return value ? { securityCode, ...value } : null;
}

export async function readStoredResearchFinancialAnalysis(db: D1Database, securityCode: string): Promise<StoredResultValue | null> {
  const row = await getKvCache(db, FINANCIAL_ANALYSIS_NAMESPACE, securityCode.trim().toUpperCase());
  const parsed = object(parseJson(row?.valueJson ?? null));
  if (!parsed) return null;
  const task = parseStoredTask(parsed.task);
  const snapshotJson = typeof parsed.snapshotJson === "string" ? parsed.snapshotJson : null;
  const markdown = text(parsed.markdown) || null;
  const projectedAt = parsed.projectedAt === null || parsed.projectedAt === undefined ? null : Number(parsed.projectedAt);
  if (!snapshotJson && !markdown && !task) return null;
  return { snapshotJson, markdown, citationsJson: jsonString(parsed.citationsJson, "[]"), sourcesJson: jsonString(parsed.sourcesJson, "[]"), terminalEvidenceJson: nullableJsonString(parsed.terminalEvidenceJson), projectedAt: Number.isFinite(projectedAt) ? projectedAt : null, projectionError: text(parsed.projectionError) || null, task };
}

export async function writeStoredResearchFinancialAnalysis(db: D1Database, securityCode: string, value: StoredResultValue): Promise<void> {
  await storeResult(db, securityCode, value);
}

async function persistTaskSnapshot(db: D1Database, securityCode: string, current: ResultRow | StoredResultValue | null, snapshot: FinancialAnalysisSnapshot | null, task: TaskdTask | StoredTaskValue | null, projectionError: string | null | undefined): Promise<ResultRow> {
  const stored = mergeStoredResult(current, { snapshotJson: snapshot ? JSON.stringify(snapshot) : undefined, task: task ? taskView(task) : null, projectionError });
  await storeResult(db, securityCode, stored);
  return { securityCode, ...stored };
}

async function storeResult(db: D1Database, securityCode: string, value: StoredResultValue): Promise<void> {
  await putKvCache(db, { namespace: FINANCIAL_ANALYSIS_NAMESPACE, key: securityCode.trim().toUpperCase(), valueJson: JSON.stringify(value), expiresAt: null, updatedAt: value.projectedAt ?? value.task?.updatedAt ?? Date.now() });
}

function responseFromStoredResult(result: ResultRow) {
  const snapshot = snapshotFromJson(result.snapshotJson);
  return {
    availability: result.markdown ? "available" as const : result.projectionError || isTerminalTask(result.task) ? "failed" as const : result.task ? "pending" as const : "empty" as const,
    task: result.task, snapshot,
    report: result.markdown ? { markdown: result.markdown, citations: parseArray(result.citationsJson), sources: parseArray(result.sourcesJson), terminalMetadata: parseJson(result.terminalEvidenceJson), projectedAt: result.projectedAt } : null,
    resume: { available: !result.markdown && Boolean(result.task), reason: result.markdown ? "already_projected" : result.projectionError ? "retry_projection_only" : isTerminalTask(result.task) ? "inspect_existing_task_only" : "observe_existing_task_only" },
  };
}

function mergeStoredResult(current: ResultRow | StoredResultValue | null, patch: Partial<StoredResultValue>): StoredResultValue {
  return {
    snapshotJson: patch.snapshotJson !== undefined ? patch.snapshotJson : current?.snapshotJson ?? null,
    markdown: patch.markdown !== undefined ? patch.markdown : current?.markdown ?? null,
    citationsJson: patch.citationsJson ?? current?.citationsJson ?? "[]",
    sourcesJson: patch.sourcesJson ?? current?.sourcesJson ?? "[]",
    terminalEvidenceJson: patch.terminalEvidenceJson !== undefined ? patch.terminalEvidenceJson : current?.terminalEvidenceJson ?? null,
    projectedAt: patch.projectedAt !== undefined ? patch.projectedAt : current?.projectedAt ?? null,
    projectionError: patch.projectionError !== undefined ? patch.projectionError : current?.projectionError ?? null,
    task: patch.task !== undefined ? patch.task : current?.task ?? null,
  };
}

function taskBusinessSnapshot(task: TaskdTask): FinancialAnalysisSnapshot | null { return snapshotFromValue(object(task.input)?.business_input); }
function hasRecoverableProviderSubmission(value: unknown): boolean {
  const checkpoint = object(value);
  if (text(checkpoint?.provider_url)) return true;
  const submission = object(checkpoint?.submission);
  if (text(submission?.schema_version) !== "provider_submission.v1") return false;
  return Boolean(text(submission?.marker));
}
function snapshotFromJson(value: string | null | undefined): FinancialAnalysisSnapshot | null { return snapshotFromValue(parseJson(value ?? null)); }
function snapshotFromValue(value: unknown): FinancialAnalysisSnapshot | null { const row = object(value); return row && text(row.securityCode) ? row as FinancialAnalysisSnapshot : null; }
function parseStoredTask(value: unknown): StoredTaskValue | null {
  const row = object(value); const name = text(row?.name); const status = text(row?.status) as TaskdTask["status"]; const createdAt = Number(row?.createdAt); const updatedAt = Number(row?.updatedAt);
  if (!name || !isTaskStatus(status) || !Number.isFinite(createdAt) || !Number.isFinite(updatedAt)) return null;
  const completedAt = row?.completedAt === null || row?.completedAt === undefined ? null : Number(row?.completedAt);
  const taskId = row?.taskId === null || row?.taskId === undefined ? null : Number(row.taskId);
  return { taskId: taskId !== null && Number.isInteger(taskId) && taskId > 0 ? taskId : null, name, status, errorMessage: text(row?.errorMessage) || null, createdAt, updatedAt, completedAt: Number.isFinite(completedAt) ? completedAt : null };
}
function taskView(task: Pick<TaskdTask, "taskId" | "name" | "status" | "errorMessage" | "createdAt" | "updatedAt" | "completedAt"> | StoredTaskValue): StoredTaskValue { return { taskId: task.taskId ?? null, name: task.name, status: task.status, errorMessage: task.errorMessage, createdAt: task.createdAt, updatedAt: task.updatedAt, completedAt: task.completedAt }; }
function isPendingTask(task: StoredTaskValue | TaskdTask | null | undefined): boolean { return task?.status === "queued" || task?.status === "leased" || task?.status === "running" || task?.status === "interrupt_requested"; }
function isTerminalTask(task: StoredTaskValue | TaskdTask | null | undefined): boolean { return task?.status === "succeeded" || task?.status === "failed" || task?.status === "interrupted" || task?.status === "superseded"; }
function isTaskStatus(value: string): value is TaskdTask["status"] { return new Set<TaskdTask["status"]>(["queued", "leased", "running", "interrupt_requested", "succeeded", "failed", "interrupted", "superseded"]).has(value as TaskdTask["status"]); }
function normalizeReasoningEffort(value: string | null | undefined): "low" | "medium" | "high" | "xhigh" { const normalized = text(value) || DEFAULT_REASONING_EFFORT; if (!new Set(["low", "medium", "high", "xhigh"]).has(normalized)) throw new Error("unsupported financial-analysis reasoning effort"); return normalized as "low" | "medium" | "high" | "xhigh"; }
export function validateFinancialMarkdown(markdown: string): void { if (markdown.length < 800) throw new Error("financial analysis result is shorter than 800 characters"); const headings = new Set([...markdown.matchAll(/^# ([1-8])\. /gm)].map((match) => match[1])); if (headings.size !== 8) throw new Error("financial analysis result must contain all eight numbered H1 headings"); }
function object(value: unknown): Row | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null; }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function jsonString(value: unknown, fallback = "{}"): string { return typeof value === "string" ? value : fallback; }
function nullableJsonString(value: unknown): string | null { return typeof value === "string" ? value : null; }
function parseJson(value: string | null): unknown { try { return value ? JSON.parse(value) : null; } catch { return null; } }
function parseArray(value: string): unknown[] { const parsed = parseJson(value); return Array.isArray(parsed) ? parsed : []; }
