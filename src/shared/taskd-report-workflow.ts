import type { AppEnv } from "../types";
import { taskdWebQaInput, type SupportedLlmModel } from "./llm-client";
import { type TaskdCallerClient, type TaskdTask, taskdCallerClient } from "./taskd-client";
import { reconcileTaskdResult, type TaskdProjectionState } from "./taskd-result-projection";

/**
 * The provider-neutral, durable part of a model report.  A report surface owns
 * its prompt, frozen business input, validation and projection; this module
 * owns the taskd envelope and the safe observation/recovery rules shared by
 * all of those surfaces.
 */
export type TaskdReportTask = {
  taskId: number | null;
  name: string;
  status: TaskdTask["status"];
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
};
type ObservedTaskdReportTask = { taskId?: number | null; name: string; createdAt: number };

export function taskdReportTaskView(task: Omit<TaskdReportTask, "taskId"> & { taskId?: number | null }): TaskdReportTask {
  return { taskId: task.taskId ?? null, name: task.name, status: task.status, errorMessage: task.errorMessage, createdAt: task.createdAt, updatedAt: task.updatedAt, completedAt: task.completedAt };
}

export function isPendingTaskdReportTask(task: Pick<TaskdReportTask, "status"> | null | undefined): boolean {
  return task?.status === "queued" || task?.status === "leased" || task?.status === "running" || task?.status === "interrupt_requested";
}

export function isTerminalTaskdReportTask(task: Pick<TaskdReportTask, "status"> | null | undefined): boolean {
  return task?.status === "succeeded" || task?.status === "failed" || task?.status === "interrupted" || task?.status === "superseded";
}

export function isObservedTaskdReportTask(expected: ObservedTaskdReportTask | null | undefined, actual: Pick<TaskdTask, "taskId" | "name" | "createdAt">): boolean {
  return Boolean(expected && expected.name === actual.name && expected.createdAt === actual.createdAt && (expected.taskId == null || expected.taskId === actual.taskId));
}

/** A checkpoint authorizes reopening the exact provider turn, never re-submit. */
export function hasRecoverableTaskdReportCheckpoint(value: unknown): boolean {
  const checkpoint = record(value);
  if (text(checkpoint?.provider_url)) return true;
  const submission = record(checkpoint?.submission);
  const state = text(submission?.state) || text(checkpoint?.submission_state);
  return text(submission?.schema_version) === "provider_submission.v1"
    && Boolean(text(submission?.marker))
    && (!state || state === "click_issued" || state === "url_bound");
}

export async function submitTaskdReport<TInput>(env: AppEnv["Bindings"], options: {
  name: string;
  taskType: string;
  model: SupportedLlmModel;
  reasoningEffort: "low" | "medium" | "high" | "xhigh";
  waitTimeoutMs: number;
  prompt: string;
  businessInput?: TInput;
  diagnostics?: Record<string, unknown>;
}): Promise<TaskdTask> {
  return taskdCallerClient(env).submit({
    name: options.name,
    taskType: options.taskType,
    payload: {
      ...taskdWebQaInput(env, {
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        waitTimeoutMs: options.waitTimeoutMs,
        messages: [{ role: "user", content: options.prompt }],
      }, options.name),
      ...(options.businessInput === undefined ? {} : { business_input: options.businessInput }),
    },
    diagnostics: options.diagnostics,
  });
}

/**
 * Read-only taskd observation.  It deliberately contains no submit/recover
 * branch, so polling and explicit sync cannot replay a provider prompt.
 */
export async function observeTaskdReport<T>(options: {
  client: TaskdCallerClient;
  expected: ObservedTaskdReportTask;
  project(task: TaskdTask): Promise<T>;
}): Promise<TaskdProjectionState<T>> {
  return reconcileTaskdResult(options.client, {
    name: options.expected.name,
    project: async (task) => {
      if (!isObservedTaskdReportTask(options.expected, task)) throw new Error("recorded task was superseded; refusing a different run");
      return options.project(task);
    },
  });
}

/** Recover only the stored task and only with a taskd checkpoint. */
export async function recoverTaskdReport(client: TaskdCallerClient, expected: ObservedTaskdReportTask, recoverableStatuses: readonly TaskdTask["status"][] = ["failed"]): Promise<{ task: TaskdTask | null; recoverable: boolean }> {
  let task = await client.get(expected.name);
  if (!task) return { task: null, recoverable: false };
  if (!isObservedTaskdReportTask(expected, task)) throw new Error("recorded task was superseded; refusing to recover another run");
  if (!recoverableStatuses.includes(task.status)) return { task, recoverable: false };
  if (!hasRecoverableTaskdReportCheckpoint(task.checkpoint)) return { task, recoverable: false };
  task = await client.recover(expected.name);
  return { task, recoverable: true };
}

function record(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
