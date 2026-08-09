import {
  completeInformationProcessing,
  failInformationProcessing,
  INFORMATION_PROCESSING_PROMPT_VERSION,
  prepareInformationDocument,
  type InformationProcessingModelRequest,
  type InformationProcessResult,
} from "./information-processing";
import {
  claimGenericLlmTaskRun,
  completeGenericLlmRun,
  createGenericLlmTask,
  failGenericLlmRun,
  heartbeatGenericLlmRun,
  loadGenericLlmRun,
  loadGenericLlmTask,
  writeGenericLlmRunArtifact,
  type GenericLlmRun,
  type GenericLlmTask,
} from "../../../shared/local-job-protocol";
import type { AppEnv } from "../../../types";

export const INFORMATION_PROCESSING_TASK_TYPE = "information_processing";
export const INFORMATION_PROCESSING_TARGET_TYPE = "knowledge_document";
export const INFORMATION_PROCESSING_MODEL = "gpt-5.6-luna" as const;
export const INFORMATION_PROCESSING_ARTIFACT_STEP = "document_analysis";

/**
 * The information-processing queue is the generic task ledger.  These fields
 * intentionally refer to the generic task/run rather than the retired
 * information_processing_jobs row; the knowledge run remains a business
 * projection and is carried separately in the model request.
 */
export type InformationProcessingJob = {
  taskId: string;
  docId: string;
  attempt: number;
  leaseOwner: string;
  runId: string;
};
export type InformationProcessingJobState = InformationProcessingJob & {
  status: string;
  leaseUntil: number | null;
  lastRunId: string | null;
};

export type EnqueueInformationProcessingOptions = { force?: boolean; now?: number };

/** Create or reuse a generic task for each document. */
export async function enqueueInformationProcessingTasks(
  db: D1Database,
  documentIds: string[],
  triggerSource: "automatic" | "cli" | "manual",
  options: EnqueueInformationProcessingOptions = {},
) {
  const now = options.now ?? Date.now();
  const ids = [...new Set(documentIds.map((id) => String(id || "").trim()).filter(Boolean))];
  const tasks = [] as Array<{ taskId: string; docId: string; status: string; created: boolean; deduplicated: boolean }>;
  for (const docId of ids) {
    const created = await createGenericLlmTask(db, {
      taskType: INFORMATION_PROCESSING_TASK_TYPE,
      targetType: INFORMATION_PROCESSING_TARGET_TYPE,
      targetId: docId,
      idempotencyKey: `${docId}:${INFORMATION_PROCESSING_PROMPT_VERSION}`,
      promptVersion: INFORMATION_PROCESSING_PROMPT_VERSION,
      model: INFORMATION_PROCESSING_MODEL,
      reasoningEffort: "low",
      metadata: { documentId: docId, triggerSource },
      now,
    });
    let task = created.task;
    // A failed/blocked task is explicitly retryable.  `force` is used by the
    // existing enqueue/retry endpoints to request a fresh execution, while a
    // running task is never reset underneath its current lease.
    if (options.force && (task.status === "failed" || task.status === "blocked" || task.status === "completed")) {
      await db.prepare(`update llm_tasks
        set status='queued', last_run_id=null, last_error_code=null, last_error_message=null,
            started_at=null, completed_at=null, updated_at=?
        where task_id=? and status in ('failed', 'blocked', 'completed')`).bind(now, task.taskId).run();
      task = (await loadGenericLlmTask(db, task.taskId)) || task;
    }
    tasks.push({ taskId: task.taskId, docId, status: task.status, created: created.created, deduplicated: created.deduplicated });
  }
  return tasks;
}

/** Claiming and terminal fencing are application-owned; routes only transport a lease. */
export async function claimInformationProcessingJobs(
  db: D1Database,
  limit: number,
  runnerInstanceId: string,
  _documentIds?: string[],
): Promise<InformationProcessingJob[]> {
  const runner = runnerInstanceId.trim();
  if (!runner) throw new Error("runnerInstanceId is required");
  const count = Math.max(0, Math.min(100, Number(limit) || 0));
  const claimed: InformationProcessingJob[] = [];
  for (let index = 0; index < count; index += 1) {
    const claim = await claimGenericLlmTaskRun(db, runner, {
      taskType: INFORMATION_PROCESSING_TASK_TYPE,
      model: INFORMATION_PROCESSING_MODEL,
      reasoningEffort: "low",
      input: { targetType: INFORMATION_PROCESSING_TARGET_TYPE },
      prompt: { promptVersion: INFORMATION_PROCESSING_PROMPT_VERSION },
    });
    if (!claim) break;
    claimed.push({
      taskId: claim.task.taskId,
      docId: claim.task.targetId,
      attempt: claim.run.attempt,
      leaseOwner: runner,
      runId: claim.run.runId,
    });
  }
  return claimed;
}

export async function loadInformationProcessingJob(db: D1Database, taskId: string): Promise<InformationProcessingJobState | null> {
  const task = await loadGenericLlmTask(db, taskId);
  if (!task || task.taskType !== INFORMATION_PROCESSING_TASK_TYPE || task.targetType !== INFORMATION_PROCESSING_TARGET_TYPE) return null;
  const run = task.lastRunId ? await loadGenericLlmRun(db, task.lastRunId) : null;
  return {
    taskId: task.taskId,
    docId: task.targetId,
    status: task.status,
    attempt: run?.attempt || 0,
    leaseOwner: run?.leaseOwner || "",
    leaseUntil: run?.leaseUntil ?? null,
    runId: run?.runId || task.lastRunId || "",
    lastRunId: task.lastRunId,
  };
}

/**
 * Pure fencing check used by the route boundary and focused tests.  The
 * snake_case aliases are accepted only so old unit fixtures remain readable;
 * no runtime path reads the table-specific job shape anymore.
 */
export function ownsInformationProcessingAttempt(
  request: InformationProcessingModelRequest,
  taskId: string,
  state: InformationProcessingJobState | Record<string, unknown> | null,
  runnerInstanceId: unknown,
  attempt: unknown,
): boolean {
  const value = state as Record<string, unknown> | null;
  if (!value) return false;
  const stateTaskId = text(value.taskId ?? value.job_id);
  const stateStatus = text(value.status);
  const stateAttempt = Number(value.attempt);
  const stateOwner = text(value.leaseOwner ?? value.lease_owner);
  const stateLeaseUntil = Number(value.leaseUntil ?? value.lease_until);
  const stateRunId = text(value.runId ?? value.run_id ?? value.lastRunId ?? value.last_run_id);
  return Boolean(stateTaskId === taskId && stateStatus === "running" && stateAttempt === Number(attempt)
    && stateOwner === text(runnerInstanceId) && stateLeaseUntil >= Date.now()
    && stateRunId && typeof request.runId === "string" && request.runId.startsWith("knowledge-run:")
    && typeof request.versionId === "string" && request.versionId.startsWith("knowledge-version:")
    && request.model === INFORMATION_PROCESSING_MODEL && Number.isInteger(request.maxTokens) && request.maxTokens > 0
    && typeof request.instructions === "string" && typeof request.input === "string");
}

function stateFor(task: GenericLlmTask, run: GenericLlmRun): InformationProcessingJobState {
  return {
    taskId: task.taskId,
    docId: task.targetId,
    status: task.status,
    attempt: run.attempt,
    leaseOwner: run.leaseOwner || "",
    leaseUntil: run.leaseUntil,
    runId: run.runId,
    lastRunId: task.lastRunId,
  };
}

async function loadOwnedAttempt(db: D1Database, taskId: string, runId: string | undefined, runner: string, attempt: number, request: InformationProcessingModelRequest) {
  const task = await loadGenericLlmTask(db, taskId);
  const genericRunId = runId || task?.lastRunId || "";
  const run = genericRunId ? await loadGenericLlmRun(db, genericRunId) : null;
  if (!task || !run) throw new Error("information processing task lease is no longer owned by this runner");
  const state = stateFor(task, run);
  if (!ownsInformationProcessingAttempt(request, taskId, state, runner, attempt)
    || state.runId !== genericRunId || run?.taskId !== taskId) {
    throw new Error("information processing task lease is no longer owned by this runner");
  }
  const businessRun = await db.prepare(`select 1
    from knowledge_processing_runs r
    join knowledge_document_versions v on v.version_id=r.version_id
    where r.run_id=? and v.doc_id=? and r.status='running'`).bind(request.runId, task.targetId).first();
  if (!businessRun) throw new Error("information processing business run is no longer active for this task");
  return { task: task!, run: run!, state };
}

/** Persist the transport request snapshot on the generic run after preparation. */
async function saveGenericRequestSnapshot(db: D1Database, taskId: string, runId: string, attempt: number, runner: string, request: InformationProcessingModelRequest): Promise<void> {
  const now = Date.now();
  const inputFingerprint = await digestHex(JSON.stringify({ input: request.input, versionId: request.versionId, promptVersion: INFORMATION_PROCESSING_PROMPT_VERSION }));
  await db.prepare(`update llm_runs set input_fingerprint=?, input_json=?, prompt_json=?, input_as_of=?, updated_at=?
    where run_id=? and task_id=? and status='running' and attempt=? and lease_owner=? and lease_until>=?`)
    .bind(
      inputFingerprint,
      JSON.stringify(request.input),
      JSON.stringify({ instructions: request.instructions, model: request.model, maxTokens: request.maxTokens, versionId: request.versionId }),
      now, now, runId, taskId, attempt, runner, now,
    ).run();
}

async function writeTerminalArtifact(
  env: AppEnv["Bindings"],
  taskId: string,
  runId: string,
  attempt: number,
  runner: string,
  output: unknown,
  status: "complete" | "partial" | "failed",
  errorMessage?: string,
) {
  return writeGenericLlmRunArtifact(env.DB, {
    runId,
    taskId,
    attempt,
    leaseOwner: runner,
    stepKey: INFORMATION_PROCESSING_ARTIFACT_STEP,
    outputType: "json",
    status,
    output,
    structureValid: status === "failed" ? null : true,
    errorMessage: errorMessage || null,
    terminalMetadata: { consumer: INFORMATION_PROCESSING_TASK_TYPE },
  });
}

async function completeGenericInformationRun(
  env: AppEnv["Bindings"],
  job: InformationProcessingJob,
  result: InformationProcessResult,
  output: unknown,
) {
  await writeTerminalArtifact(env, job.taskId, job.runId, job.attempt, job.leaseOwner, output, result.needsReview ? "partial" : "complete");
  return completeGenericLlmRun(env.DB, {
    runId: job.runId,
    taskId: job.taskId,
    attempt: job.attempt,
    leaseOwner: job.leaseOwner,
    status: "completed",
    terminalMetadata: {
      consumer: INFORMATION_PROCESSING_TASK_TYPE,
      knowledgeRunId: result.runId,
      versionId: result.versionId,
      action: result.action,
      outcome: result.outcome || null,
      needsReview: result.needsReview,
      recordCount: result.recordCount,
    },
  });
}

async function failGenericInformationRun(
  env: AppEnv["Bindings"],
  job: InformationProcessingJob,
  message: string,
  request?: Pick<InformationProcessingModelRequest, "runId" | "versionId">,
) {
  if (request) await failInformationProcessing(env, request, message).catch(() => {});
  await writeTerminalArtifact(env, job.taskId, job.runId, job.attempt, job.leaseOwner, null, "failed", message).catch(() => {});
  return failGenericLlmRun(env.DB, {
    runId: job.runId,
    taskId: job.taskId,
    attempt: job.attempt,
    leaseOwner: job.leaseOwner,
    errorCode: "information_processing_failed",
    errorMessage: message,
    terminalMetadata: { consumer: INFORMATION_PROCESSING_TASK_TYPE },
  });
}

/** The route transports this result; preparation and terminal fencing stay application-owned. */
export async function claimAndPrepareInformationProcessingJob(env: AppEnv["Bindings"], runnerInstanceId: string) {
  const [claimed] = await claimInformationProcessingJobs(env.DB, 1, runnerInstanceId);
  if (!claimed) return null;
  let request: InformationProcessingModelRequest | undefined;
  try {
    const prepared = await prepareInformationDocument(env, claimed.docId);
    if (prepared.kind === "complete") {
      const result = prepared.result;
      await completeGenericInformationRun(env, claimed, result, { result });
      return { taskId: claimed.taskId, jobId: claimed.taskId, documentId: claimed.docId, status: "completed", attempt: claimed.attempt, runId: claimed.runId, result };
    }
    request = prepared.request;
    await saveGenericRequestSnapshot(env.DB, claimed.taskId, claimed.runId, claimed.attempt, claimed.leaseOwner, request);
    return {
      taskId: claimed.taskId,
      jobId: claimed.taskId,
      documentId: claimed.docId,
      status: "running",
      attempt: claimed.attempt,
      runId: claimed.runId,
      runnerInstanceId: claimed.leaseOwner,
      request,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failGenericInformationRun(env, claimed, message, request);
    return { taskId: claimed.taskId, jobId: claimed.taskId, documentId: claimed.docId, status: "failed", attempt: claimed.attempt, runId: claimed.runId, error: message };
  }
}

export async function completeClaimedInformationProcessingJob(
  env: AppEnv["Bindings"],
  taskId: string,
  payload: {
    request: InformationProcessingModelRequest;
    text: string;
    raw: unknown;
    cached: boolean;
    runnerInstanceId: string;
    attempt: number;
    runId?: string;
  },
) {
  const owned = await loadOwnedAttempt(env.DB, taskId, payload.runId, payload.runnerInstanceId, payload.attempt, payload.request);
  const job: InformationProcessingJob = {
    taskId: owned.task.taskId,
    docId: owned.task.targetId,
    attempt: owned.run.attempt,
    leaseOwner: payload.runnerInstanceId,
    runId: owned.run.runId,
  };
  let result: InformationProcessResult | null = null;
  try {
    result = await completeInformationProcessing(env, payload.request, payload.text, payload.raw, payload.cached);
    await completeGenericInformationRun(env, job, result, {
      text: payload.text,
      raw: payload.raw,
      cached: payload.cached,
      result,
    });
    return { status: result.needsReview ? "needs_review" : "completed", result, taskId: job.taskId, runId: job.runId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // `completeInformationProcessing` removes a failed business attempt itself;
    // do not delete a successfully projected result merely because generic
    // terminal bookkeeping failed after it was written.
    if (!result) await failInformationProcessing(env, payload.request, message).catch(() => {});
    await failGenericInformationRun(env, job, message).catch(() => {});
    throw error;
  }
}

export async function failClaimedInformationProcessingJob(
  env: AppEnv["Bindings"],
  taskId: string,
  payload: { request: InformationProcessingModelRequest; error: string; runnerInstanceId: string; attempt: number; runId?: string },
) {
  const owned = await loadOwnedAttempt(env.DB, taskId, payload.runId, payload.runnerInstanceId, payload.attempt, payload.request);
  const job: InformationProcessingJob = {
    taskId: owned.task.taskId,
    docId: owned.task.targetId,
    attempt: owned.run.attempt,
    leaseOwner: payload.runnerInstanceId,
    runId: owned.run.runId,
  };
  await failGenericInformationRun(env, job, payload.error, payload.request);
}

export async function heartbeatInformationProcessingJob(
  db: D1Database,
  taskId: string,
  runId: string,
  runnerInstanceId: string,
  attempt: number,
): Promise<boolean> {
  return heartbeatGenericLlmRun(db, runId, taskId, attempt, runnerInstanceId);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

async function digestHex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
