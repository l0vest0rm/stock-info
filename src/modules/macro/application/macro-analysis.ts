import type { Database } from "../../../platform/contracts";
import type { AppEnv } from "../../../types";
import { MACRO_ANALYSIS_PROMPT } from "../../../generated/prompt-text";
import { isTaskdReadUnavailable, taskdCallerClient, type TaskdTask } from "../../../shared/taskd-client";
import { extractTaskdWebQaResult } from "../../../shared/taskd-webqa-result";
import { hasRecoverableTaskdReportCheckpoint, isPendingTaskdReportTask, isTerminalTaskdReportTask, observeTaskdReport, recoverTaskdReport, submitTaskdReport, taskdReportTaskView } from "../../../shared/taskd-report-workflow";
import { isObservedTaskdReportTask, readTaskdReportResult, saveTaskdReportResult } from "../../research/infrastructure/research-result-repository";

const REPORT_KEY = "GLOBAL";
const REPORT_NAMESPACE = "macro_analysis";
const TASK_NAME = "macro:analysis:global";
const TASK_TYPE = "webqa.chatgpt.v1";
const MODEL = "gpt-5.6-luna" as const;
const DEFAULT_REASONING_EFFORT = "xhigh";
const PROMPT_VERSION = "macro-analysis.taskd.v1";
const INPUT_SCHEMA_VERSION = "macro-analysis-input.v1";

type Row = Record<string, unknown>;
type StoredTask = { taskId: number | null; name: string; status: TaskdTask["status"]; errorMessage: string | null; createdAt: number; updatedAt: number; completedAt: number | null };
type Recovery = { phase: "none" | "recovering" | "manual_required"; reason: string | null };
type StoredResult = {
  pendingProjection: boolean;
  pendingInputJson: string | null;
  inputJson: string | null;
  markdown: string | null;
  citationsJson: string;
  sourcesJson: string;
  terminalEvidenceJson: string | null;
  projectedAt: number | null;
  task: StoredTask | null;
  recovery: Recovery;
};
type MacroInput = { schemaVersion: typeof INPUT_SCHEMA_VERSION; promptVersion: typeof PROMPT_VERSION; preparedAt: string };

/** One stable business name makes refreshes observable latest-only taskd work. */
export function macroAnalysisTaskName(): string { return TASK_NAME; }

/** Read model only: opening the page never contacts taskd or a model. */
export async function loadMacroAnalysis(env: AppEnv["Bindings"]) {
  const result = await loadStored(env.DB);
  return { ...(result ? response(result) : emptyResponse()), canManageLocally: env.LLM_RUNTIME === "local" };
}

/**
 * Local lifecycle observer for the one global macro task. It performs the
 * same read-only taskd reconciliation as the research report surfaces; it
 * never submits or recovers provider work.
 */
export async function reconcileMacroAnalysis(env: AppEnv["Bindings"]): Promise<boolean> {
  if (env.LLM_RUNTIME !== "local") return false;
  const stored = await loadStored(env.DB);
  if (!stored?.task || (!stored.pendingProjection && !isPending(stored.task))) return false;
  await syncMacroAnalysis(env);
  return true;
}

/** A user action is the only way to submit a new global macro report. */
export async function enqueueMacroAnalysis(env: AppEnv["Bindings"], options: { reasoningEffort?: string | null } = {}) {
  if (env.LLM_RUNTIME !== "local") throw new Error("macro analysis submission is only available in local LLM runtime");
  const input: MacroInput = { schemaVersion: INPUT_SCHEMA_VERSION, promptVersion: PROMPT_VERSION, preparedAt: new Date().toISOString() };
  const reasoningEffort = normalizeReasoningEffort(options.reasoningEffort);
  const task = await submitTaskdReport(env, { name: TASK_NAME, taskType: TASK_TYPE, model: MODEL, reasoningEffort, waitTimeoutMs: 2 * 60 * 60_000, prompt: MACRO_ANALYSIS_PROMPT, businessInput: input,
    diagnostics: { model: MODEL, reasoningEffort, promptVersion: PROMPT_VERSION, schemaVersion: INPUT_SCHEMA_VERSION, scope: "global_macro" } });
  const current = await loadStored(env.DB);
  const stored = merge(current, {
    pendingProjection: true,
    pendingInputJson: JSON.stringify(input),
    inputJson: current?.markdown ? current.inputJson : JSON.stringify(input),
    task: taskView(task),
    recovery: noRecovery(),
  });
  await saveStored(env.DB, stored);
  return { accepted: true, task: taskView(task), input };
}

/** Explicit observation/projection only; it never submits or replays a prompt. */
export async function syncMacroAnalysis(env: AppEnv["Bindings"]) {
  if (env.LLM_RUNTIME !== "local") throw new Error("macro analysis synchronization is only available in local LLM runtime");
  const stored = await loadStored(env.DB);
  if (!stored?.task) return emptyResponse();
  try {
    const state = await observeTaskdReport({
      client: taskdCallerClient(env), expected: stored.task,
      project: async (task) => {
        const input = taskInput(task) ?? inputFromJson(stored.pendingInputJson ?? stored.inputJson);
        if (!input) throw new Error("macro analysis task has no frozen input snapshot");
        // Persist the terminal task observation before validating its report.
        // A malformed completed result is terminal, not a perpetually
        // "running" task that the local scheduler should retry forever.
        const observedTerminal = merge(stored, { task: taskView(task), recovery: noRecovery() });
        await saveStored(env.DB, observedTerminal, stored);
        const result = extractTaskdWebQaResult(task.result);
        validateMacroAnalysisTerminalEvidence(result.terminalEvidence);
        const markdown = text(result.content.markdown);
        validateMacroAnalysisMarkdown(markdown);
        await saveStored(env.DB, merge(observedTerminal, {
          pendingProjection: false, pendingInputJson: null, inputJson: JSON.stringify(input), markdown,
          citationsJson: JSON.stringify(result.citations), sourcesJson: JSON.stringify(result.sources),
          terminalEvidenceJson: JSON.stringify(result.terminalEvidence), projectedAt: Date.now(), task: taskView(task), recovery: noRecovery(),
        }), observedTerminal);
      },
    });
    if (state.state === "missing") {
      await saveStored(env.DB, merge(stored, { recovery: { phase: "manual_required", reason: "taskd 已找不到原任务，无法确认已提交的 ChatGPT 会话。" }, task: null }), stored);
    } else if (state.state !== "projected" && isObservedTaskdReportTask(stored.task, state.task)) {
      await saveStored(env.DB, merge(stored, { task: taskView(state.task), recovery: recoveryAfterTask(stored.recovery, state.task) }), stored);
    } else if (state.state !== "projected") {
      throw new Error("recorded macro task was superseded; refusing a different run");
    }
  } catch (error) {
    if (isTaskdReadUnavailable(error)) throw error;
    const latest = await loadStored(env.DB) ?? stored;
    await saveStored(env.DB, merge(latest, {
      // If taskd supplied a terminal result that fails this application's
      // evidence/content contract, retain that terminal observation and stop
      // background retries. It cannot be repaired by rereading taskd.
      pendingProjection: isTerminal(latest.task) ? false : undefined,
      recovery: { phase: "manual_required", reason: error instanceof Error ? error.message : String(error) },
    }), latest);
    throw error;
  }
  return loadMacroAnalysis(env);
}

/** Recover only a checkpointed provider turn; no branch ever submits another prompt. */
export async function resumeMacroAnalysis(env: AppEnv["Bindings"]) {
  if (env.LLM_RUNTIME !== "local") throw new Error("macro analysis recovery is only available in local LLM runtime");
  const stored = await loadStored(env.DB);
  if (!stored?.task) throw new Error("macro analysis has no recorded task to recover");
  const recovered = await recoverTaskdReport(taskdCallerClient(env), stored.task);
  let remote = recovered.task;
  let recovery = stored.recovery;
  if (!remote) {
    recovery = { phase: "manual_required", reason: "taskd 已找不到原任务，无法确认已提交的 ChatGPT 会话。" };
  } else if (recovered.recoverable) {
    recovery = { phase: "recovering", reason: "正在只读找回已提交的 ChatGPT 结果；不会重发提示词。" };
  } else if (remote.status === "failed") {
    if (!hasRecoverableProviderCheckpoint(remote.checkpoint)) {
      recovery = { phase: "manual_required", reason: "任务缺少可验证的原会话 checkpoint，无法安全找回，也不会重发提示词。" };
    } else {
      recovery = { phase: "manual_required", reason: "taskd 未能重新排队原任务，无法确认已提交的 ChatGPT 会话。" };
    }
  }
  await saveStored(env.DB, merge(stored, { task: remote ? taskView(remote) : null, recovery }), stored);
  return loadMacroAnalysis(env);
}

export function validateMacroAnalysisTerminalEvidence(evidence: Record<string, unknown> | null): void {
  if (text(evidence?.schemaVersion) !== "webqa.completion-evidence.v1" || text(evidence?.outcome) !== "succeeded") {
    throw new Error("macro analysis taskd result lacks terminal WebQA completion evidence");
  }
}

export function validateMacroAnalysisMarkdown(markdown: string): void {
  if (markdown.length < 4_000) throw new Error("macro analysis result is shorter than 4000 characters");
  const expected = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十", "二十一", "二十二", "二十三", "二十四", "二十五", "二十六", "二十七", "二十八", "二十九", "三十", "三十一"];
  // Models commonly add a report title before the numbered structure, which
  // can make the first numbered section an H2 while retaining all required
  // sections. The numbered topology is the delivery contract; its Markdown
  // nesting level is not evidence of missing analysis.
  const headings = new Set([...markdown.matchAll(/^#{1,6} ([一二三四五六七八九十]+)、/gm)].map((match) => match[1]));
  if (!expected.every((heading) => headings.has(heading))) throw new Error("macro analysis result must contain all thirty-one numbered sections");
  if (!/^# 一句话结论\s*$/m.test(markdown)) throw new Error("macro analysis result must contain the one-sentence conclusion H1 heading");
}

async function loadStored(db: Database): Promise<StoredResult | null> {
  const row = await readTaskdReportResult(db, REPORT_NAMESPACE, REPORT_KEY);
  const parsed = object(parseJson(row?.valueJson ?? null));
  if (!parsed) return null;
  const task = parseTask(parsed.task);
  const markdown = text(parsed.markdown) || null;
  if (!task && !markdown) return null;
  return {
    pendingProjection: parsed.pendingProjection === true,
    pendingInputJson: stringOrNull(parsed.pendingInputJson), inputJson: stringOrNull(parsed.inputJson), markdown,
    citationsJson: stringOr(parsed.citationsJson, "[]"), sourcesJson: stringOr(parsed.sourcesJson, "[]"),
    terminalEvidenceJson: stringOrNull(parsed.terminalEvidenceJson), projectedAt: finiteOrNull(parsed.projectedAt), task, recovery: parseRecovery(parsed.recovery),
  };
}
async function saveStored(db: Database, value: StoredResult, expected?: StoredResult): Promise<void> {
  await saveTaskdReportResult(db, REPORT_NAMESPACE, REPORT_KEY, value, expected);
}
function response(result: StoredResult) {
  const recoveryAvailable = result.task?.status === "failed" && result.recovery.phase === "none";
  return {
    availability: result.markdown ? "available" as const : result.recovery.phase === "manual_required" || isTerminal(result.task) ? "failed" as const : result.task ? "pending" as const : "empty" as const,
    task: result.task, recovery: result.recovery, input: parseJson(result.inputJson),
    report: result.markdown ? { markdown: result.markdown, citations: arrayFromJson(result.citationsJson), sources: arrayFromJson(result.sourcesJson), terminalMetadata: parseJson(result.terminalEvidenceJson), projectedAt: result.projectedAt } : null,
    resume: { available: recoveryAvailable, reason: recoveryAvailable ? "recover_provider_turn" : result.recovery.phase === "manual_required" ? "manual_required" : result.markdown ? "already_projected" : "not_failed" },
  };
}
function emptyResponse() { return { availability: "empty" as const, task: null, recovery: noRecovery(), input: null, report: null, resume: { available: false, reason: "not_failed" } }; }
function merge(current: StoredResult | null, patch: Partial<StoredResult>): StoredResult {
  return { pendingProjection: patch.pendingProjection ?? current?.pendingProjection ?? false, pendingInputJson: patch.pendingInputJson !== undefined ? patch.pendingInputJson : current?.pendingInputJson ?? null, inputJson: patch.inputJson !== undefined ? patch.inputJson : current?.inputJson ?? null, markdown: patch.markdown !== undefined ? patch.markdown : current?.markdown ?? null, citationsJson: patch.citationsJson ?? current?.citationsJson ?? "[]", sourcesJson: patch.sourcesJson ?? current?.sourcesJson ?? "[]", terminalEvidenceJson: patch.terminalEvidenceJson !== undefined ? patch.terminalEvidenceJson : current?.terminalEvidenceJson ?? null, projectedAt: patch.projectedAt !== undefined ? patch.projectedAt : current?.projectedAt ?? null, task: patch.task !== undefined ? patch.task : current?.task ?? null, recovery: patch.recovery ?? current?.recovery ?? noRecovery() };
}
function taskInput(task: TaskdTask): MacroInput | null { return inputFromValue(object(task.input)?.business_input); }
function inputFromJson(value: string | null): MacroInput | null { return inputFromValue(parseJson(value)); }
function inputFromValue(value: unknown): MacroInput | null { const input = object(value); return text(input?.schemaVersion) === INPUT_SCHEMA_VERSION && text(input?.promptVersion) === PROMPT_VERSION && text(input?.preparedAt) ? input as MacroInput : null; }
function taskView(task: Pick<TaskdTask, "taskId" | "name" | "status" | "errorMessage" | "createdAt" | "updatedAt" | "completedAt">): StoredTask { return taskdReportTaskView(task); }
function parseTask(value: unknown): StoredTask | null { const task = object(value); const name = text(task?.name); const status = text(task?.status) as TaskdTask["status"]; const createdAt = Number(task?.createdAt); const updatedAt = Number(task?.updatedAt); if (!name || !isTaskStatus(status) || !Number.isFinite(createdAt) || !Number.isFinite(updatedAt)) return null; return { taskId: Number.isInteger(Number(task?.taskId)) && Number(task?.taskId) > 0 ? Number(task?.taskId) : null, name, status, errorMessage: text(task?.errorMessage) || null, createdAt, updatedAt, completedAt: finiteOrNull(task?.completedAt) }; }
function isTaskStatus(value: string): value is TaskdTask["status"] { return new Set<TaskdTask["status"]>(["queued", "leased", "running", "interrupt_requested", "succeeded", "failed", "interrupted", "superseded"]).has(value as TaskdTask["status"]); }
function recoveryAfterTask(current: Recovery, task: TaskdTask): Recovery { if (current.phase === "recovering" && isTerminal(task)) return { phase: "manual_required", reason: task.errorMessage || "找回后的任务没有产生可验证的完成结果。" }; if (task.status === "failed" && !hasRecoverableProviderCheckpoint(task.checkpoint)) return { phase: "manual_required", reason: "任务没有可验证的原会话 checkpoint，不能执行无重放找回。" }; return current; }
function hasRecoverableProviderCheckpoint(value: unknown): boolean { return hasRecoverableTaskdReportCheckpoint(value); }
function isTerminal(task: StoredTask | TaskdTask | null): boolean { return isTerminalTaskdReportTask(task); }
function isPending(task: StoredTask | TaskdTask | null): boolean { return isPendingTaskdReportTask(task); }
function normalizeReasoningEffort(value: string | null | undefined): "low" | "medium" | "high" | "xhigh" { const normalized = text(value) || DEFAULT_REASONING_EFFORT; if (!new Set(["low", "medium", "high", "xhigh"]).has(normalized)) throw new Error("unsupported macro-analysis reasoning effort"); return normalized as "low" | "medium" | "high" | "xhigh"; }
function noRecovery(): Recovery { return { phase: "none", reason: null }; }
function parseRecovery(value: unknown): Recovery { const recovery = object(value); const phase = text(recovery?.phase); return phase === "none" || phase === "recovering" || phase === "manual_required" ? { phase, reason: text(recovery?.reason) || null } : noRecovery(); }
function object(value: unknown): Row | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null; }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function stringOr(value: unknown, fallback: string): string { return typeof value === "string" ? value : fallback; }
function stringOrNull(value: unknown): string | null { return typeof value === "string" ? value : null; }
function finiteOrNull(value: unknown): number | null { if (value === null || value === undefined) return null; const number = Number(value); return Number.isFinite(number) ? number : null; }
function parseJson(value: string | null | undefined): unknown { try { return value ? JSON.parse(value) : null; } catch { return null; } }
function arrayFromJson(value: string): unknown[] { const parsed = parseJson(value); return Array.isArray(parsed) ? parsed : []; }
