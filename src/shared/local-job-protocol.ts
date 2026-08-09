import runtimeConfig from "../../config/local-job-runtime.json";

type HandlerName = "researchWebSearch" | "researchOperatingAnalysis" | "informationProcessing";

const config = runtimeConfig as {
  version: string;
  provider: { id: "openai"; globalConcurrency: number };
  lease: { durationMs: number; heartbeatIntervalMs: number; gracefulShutdownMs: number };
  handlers: Record<HandlerName, { concurrency: number; pollIntervalMs: number }>;
};

export const LOCAL_JOB_PROVIDER_ID = config.provider.id;
export const LOCAL_JOB_LEASE_MS = config.lease.durationMs;
export const LOCAL_JOB_HEARTBEAT_INTERVAL_MS = config.lease.heartbeatIntervalMs;
export const LOCAL_JOB_GRACEFUL_SHUTDOWN_MS = config.lease.gracefulShutdownMs;
export const LOCAL_JOB_HANDLER_CONFIG = config.handlers;

export const GENERIC_LLM_TASK_PROTOCOL_VERSION = "llm-task-protocol.v1";
export type GenericLlmTaskStatus = "queued" | "running" | "completed" | "failed" | "blocked";
export type GenericLlmRunStatus = "running" | "completed" | "failed" | "blocked";
export type GenericLlmArtifactStatus = "complete" | "partial" | "blocked" | "not_applicable" | "failed";
export type GenericLlmOutputType = "json" | "markdown";

export type GenericLlmTaskSpec = {
  taskId?: string;
  taskType: string;
  targetType: string;
  targetId: string;
  idempotencyKey: string;
  protocolVersion?: string;
  promptVersion: string;
  model?: string | null;
  reasoningEffort?: string | null;
  metadata?: unknown;
  now?: number;
};

export type GenericLlmTask = {
  taskId: string;
  taskType: string;
  targetType: string;
  targetId: string;
  idempotencyKey: string;
  protocolVersion: string;
  promptVersion: string;
  status: GenericLlmTaskStatus;
  requestedModel: string | null;
  requestedReasoningEffort: string | null;
  lastRunId: string | null;
  metadata: unknown;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  updatedAt: number;
};

export type GenericLlmRun = {
  runId: string;
  taskId: string;
  attempt: number;
  provider: string;
  model: string;
  reasoningEffort: string | null;
  promptVersion: string;
  inputFingerprint: string | null;
  inputAsOf: number | null;
  input: unknown;
  prompt: unknown;
  status: GenericLlmRunStatus;
  leaseOwner: string | null;
  leaseUntil: number | null;
  heartbeatAt: number | null;
  currentStepKey: string | null;
  progress: unknown;
  progressUpdatedAt: number | null;
  terminalMetadata: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: number;
  completedAt: number | null;
  updatedAt: number;
};

export type GenericLlmArtifact = {
  artifactId: string;
  runId: string;
  stepKey: string;
  upstreamArtifactIds: string[];
  outputType: GenericLlmOutputType;
  status: GenericLlmArtifactStatus;
  output: unknown;
  structureValid: boolean | null;
  blocked: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  terminalMetadata: unknown;
  completedAt: number;
};

export type GenericLlmTaskCreateResult = {
  task: GenericLlmTask;
  created: boolean;
  deduplicated: boolean;
};

export type GenericLlmTaskRunClaim = {
  task: GenericLlmTask;
  run: GenericLlmRun;
};

export type GenericLlmTaskClaimOptions = {
  taskType?: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string | null;
  inputFingerprint?: string | null;
  inputAsOf?: number | null;
  input?: unknown;
  prompt?: unknown;
  now?: number;
};

export type GenericLlmArtifactInput = {
  stepKey: string;
  upstreamArtifactIds?: string[];
  outputType: GenericLlmOutputType;
  status: GenericLlmArtifactStatus;
  output?: unknown;
  structureValid?: boolean | null;
  blocked?: unknown;
  errorCode?: string | null;
  errorMessage?: string | null;
  terminalMetadata?: unknown;
  completedAt?: number;
};

export type GenericLlmRunTerminalInput = {
  runId: string;
  taskId: string;
  attempt: number;
  leaseOwner: string;
  status: Exclude<GenericLlmRunStatus, "running">;
  errorCode?: string | null;
  errorMessage?: string | null;
  terminalMetadata?: unknown;
  completedAt?: number;
};

export type GenericLlmRunProgressInput = {
  runId: string;
  taskId: string;
  attempt: number;
  leaseOwner: string;
  stepKey?: string | null;
  metadata?: unknown;
  updatedAt?: number;
};

export function localJobLeaseUntil(now = Date.now()): number {
  return now + LOCAL_JOB_LEASE_MS;
}

/** Atomically reserves one shared provider slot for a claimed task attempt. */
export async function reserveLocalJobProviderSlot(db: D1Database, jobId: string, jobType: string, attempt: number, leaseOwner: string, now = Date.now()): Promise<boolean> {
  const slot = await db.prepare(`update local_job_provider_slots
    set active_count=active_count+1, concurrency_limit=?, updated_at=?
    where provider_id=? and active_count<concurrency_limit`)
    .bind(config.provider.globalConcurrency, now, LOCAL_JOB_PROVIDER_ID).run();
  if (!slot.meta.changes) return false;
  const lease = await db.prepare(`insert or ignore into local_job_provider_leases
    (provider_id,job_id,job_type,attempt,lease_owner,acquired_at) values (?,?,?,?,?,?)`)
    .bind(LOCAL_JOB_PROVIDER_ID, jobId, jobType, attempt, leaseOwner, now).run();
  if (lease.meta.changes) return true;
  await db.prepare("update local_job_provider_slots set active_count=max(active_count-1,0), updated_at=? where provider_id=?")
    .bind(now, LOCAL_JOB_PROVIDER_ID).run();
  return false;
}

export async function releaseLocalJobProviderSlot(db: D1Database, jobId: string, attempt: number, leaseOwner?: string, now = Date.now()): Promise<void> {
  const removed = await db.prepare(`delete from local_job_provider_leases where provider_id=? and job_id=? and attempt=?${leaseOwner ? " and lease_owner=?" : ""}`)
    .bind(LOCAL_JOB_PROVIDER_ID, jobId, attempt, ...(leaseOwner ? [leaseOwner] : [])).run();
  if (removed.meta.changes) await db.prepare("update local_job_provider_slots set active_count=max(active_count-1,0), updated_at=? where provider_id=?")
    .bind(now, LOCAL_JOB_PROVIDER_ID).run();
}

/** Expired/requeued attempts cannot continue consuming an in-memory runner slot. */
export async function reconcileLocalJobProviderSlots(db: D1Database, now = Date.now()): Promise<void> {
  const genericProtocolAvailable = await hasGenericLlmProtocol(db);
  const genericLeaseGuard = genericProtocolAvailable
    ? `
      union all
      select 1 from llm_runs r where r.task_id=local_job_provider_leases.job_id
        and local_job_provider_leases.job_type='llm_run' and r.status='running'
        and r.attempt=local_job_provider_leases.attempt and r.lease_owner=local_job_provider_leases.lease_owner and r.lease_until>=?`
    : "";
  await db.batch([
    db.prepare(`delete from local_job_provider_leases where provider_id=? and not exists (
      select 1 from research_web_search_package_jobs j where j.job_id=local_job_provider_leases.job_id and j.job_type=local_job_provider_leases.job_type and j.status='running' and j.attempt=local_job_provider_leases.attempt and j.lease_owner=local_job_provider_leases.lease_owner and j.lease_until>=?
      union all
      select 1 from research_operating_analysis_jobs j where j.job_id=local_job_provider_leases.job_id and j.job_type=local_job_provider_leases.job_type and j.status='running' and j.attempt=local_job_provider_leases.attempt and j.lease_owner=local_job_provider_leases.lease_owner and j.lease_until>=?
      union all
      select 1 from information_processing_jobs j where j.job_id=local_job_provider_leases.job_id and j.job_type=local_job_provider_leases.job_type and j.status='running' and j.attempt=local_job_provider_leases.attempt and j.lease_owner=local_job_provider_leases.lease_owner and j.lease_until>=?
      ${genericLeaseGuard}
    )`).bind(LOCAL_JOB_PROVIDER_ID, now, now, now, ...(genericProtocolAvailable ? [now] : [])),
    db.prepare(`update local_job_provider_slots set active_count=(select count(*) from local_job_provider_leases where provider_id=?), concurrency_limit=?, updated_at=? where provider_id=?`)
      .bind(LOCAL_JOB_PROVIDER_ID, config.provider.globalConcurrency, now, LOCAL_JOB_PROVIDER_ID),
  ]);
}

export async function renewLocalJobLease(db: D1Database, table: "research_web_search_package_jobs" | "research_operating_analysis_jobs" | "information_processing_jobs", whereSql: string, whereBindings: unknown[], attempt: number, leaseOwner: string, now = Date.now()): Promise<boolean> {
  const result = await db.prepare(`update ${table} set lease_until=?, heartbeat_at=?, updated_at=? where ${whereSql} and status='running' and attempt=? and lease_owner=?`)
    .bind(localJobLeaseUntil(now), now, now, ...whereBindings, attempt, leaseOwner).run();
  return Boolean(result.meta.changes);
}

export async function loadLocalJobRuntimeState(db: D1Database) {
  const genericProtocolAvailable = await hasGenericLlmProtocol(db);
  const [provider, webSearch, operating, information] = await Promise.all([
    db.prepare("select provider_id as providerId, active_count as activeCount, concurrency_limit as concurrencyLimit, updated_at as updatedAt from local_job_provider_slots where provider_id=?").bind(LOCAL_JOB_PROVIDER_ID).first(),
    db.prepare("select status, count(*) as count from research_web_search_package_jobs group by status").all(),
    db.prepare("select status, count(*) as count from research_operating_analysis_jobs group by status").all(),
    db.prepare("select status, count(*) as count from information_processing_jobs group by status").all(),
  ]);
  const generic = genericProtocolAvailable
    ? await db.prepare("select status, count(*) as count from llm_tasks group by status").all()
    : { results: [] as unknown[] };
  return {
    provider,
    handlers: {
      researchWebSearch: { ...config.handlers.researchWebSearch, states: webSearch.results },
      researchOperatingAnalysis: { ...config.handlers.researchOperatingAnalysis, states: operating.results },
      informationProcessing: { ...config.handlers.informationProcessing, states: information.results },
    },
    genericLlm: { protocolVersion: GENERIC_LLM_TASK_PROTOCOL_VERSION, states: generic.results },
  };
}

/**
 * Create or reuse one durable generic task.  The natural identity includes
 * protocol and prompt versions so a changed contract gets a new task without
 * importing or adapting an old row.
 */
export async function createGenericLlmTask(db: D1Database, spec: GenericLlmTaskSpec): Promise<GenericLlmTaskCreateResult> {
  const taskType = requiredGeneric(spec.taskType, "taskType");
  const targetType = requiredGeneric(spec.targetType, "targetType");
  const targetId = requiredGeneric(spec.targetId, "targetId");
  const idempotencyKey = requiredGeneric(spec.idempotencyKey, "idempotencyKey");
  const protocolVersion = requiredGeneric(spec.protocolVersion || GENERIC_LLM_TASK_PROTOCOL_VERSION, "protocolVersion");
  const promptVersion = requiredGeneric(spec.promptVersion, "promptVersion");
  const now = finiteTimestamp(spec.now) ?? Date.now();
  const taskId = requiredGeneric(spec.taskId || `llm-task:${crypto.randomUUID()}`, "taskId");
  const metadataJson = serializeGenericJson(spec.metadata, "metadata");
  const inserted = await db.prepare(`insert or ignore into llm_tasks (
    task_id, task_type, target_type, target_id, idempotency_key, protocol_version, prompt_version, status,
    requested_model, requested_reasoning_effort, metadata_json, created_at, updated_at
  ) values (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`)
    .bind(taskId, taskType, targetType, targetId, idempotencyKey, protocolVersion, promptVersion,
      nullableGeneric(spec.model), nullableGeneric(spec.reasoningEffort), metadataJson, now, now).run();
  const task = await findGenericLlmTask(db, { taskType, targetType, targetId, idempotencyKey, protocolVersion, promptVersion });
  if (!task) throw new Error("generic LLM task was inserted but cannot be reloaded");
  return { task, created: Boolean(inserted.meta.changes), deduplicated: !inserted.meta.changes };
}

export async function loadGenericLlmTask(db: D1Database, taskId: string): Promise<GenericLlmTask | null> {
  const id = requiredGeneric(taskId, "taskId");
  return normalizeGenericTask(await db.prepare(`select task_id as taskId, task_type as taskType, target_type as targetType, target_id as targetId,
    idempotency_key as idempotencyKey, protocol_version as protocolVersion, prompt_version as promptVersion, status,
    requested_model as requestedModel, requested_reasoning_effort as requestedReasoningEffort, last_run_id as lastRunId,
    metadata_json as metadataJson, last_error_code as lastErrorCode, last_error_message as lastErrorMessage,
    created_at as createdAt, started_at as startedAt, completed_at as completedAt, updated_at as updatedAt
    from llm_tasks where task_id=?`).bind(id).first<Record<string, unknown>>());
}

export type GenericLlmTaskIdentity = Pick<GenericLlmTaskSpec, "taskType" | "targetType" | "targetId" | "idempotencyKey" | "protocolVersion" | "promptVersion"> & { protocolVersion?: string };

export async function loadGenericLlmTaskByIdentity(db: D1Database, identity: GenericLlmTaskIdentity): Promise<GenericLlmTask | null> {
  return findGenericLlmTask(db, {
    taskType: requiredGeneric(identity.taskType, "taskType"), targetType: requiredGeneric(identity.targetType, "targetType"), targetId: requiredGeneric(identity.targetId, "targetId"),
    idempotencyKey: requiredGeneric(identity.idempotencyKey, "idempotencyKey"), protocolVersion: requiredGeneric(identity.protocolVersion || GENERIC_LLM_TASK_PROTOCOL_VERSION, "protocolVersion"), promptVersion: requiredGeneric(identity.promptVersion, "promptVersion"),
  });
}

export async function requeueGenericLlmTask(db: D1Database, taskId: string, now = Date.now()): Promise<boolean> {
  const id = requiredGeneric(taskId, "taskId");
  const result = await db.prepare(`update llm_tasks set status='queued', last_run_id=null, last_error_code=null, last_error_message=null,
    started_at=null, completed_at=null, updated_at=? where task_id=? and status in ('failed', 'blocked', 'completed')`).bind(now, id).run();
  return Boolean(result.meta.changes);
}

export async function loadGenericLlmRun(db: D1Database, runId: string): Promise<GenericLlmRun | null> {
  const id = requiredGeneric(runId, "runId");
  return normalizeGenericRun(await db.prepare(`select run_id as runId, task_id as taskId, attempt, provider, model,
    reasoning_effort as reasoningEffort, prompt_version as promptVersion, input_fingerprint as inputFingerprint, input_as_of as inputAsOf,
    input_json as inputJson, prompt_json as promptJson, status, lease_owner as leaseOwner, lease_until as leaseUntil,
    heartbeat_at as heartbeatAt, current_step_key as currentStepKey, progress_json as progressJson, progress_updated_at as progressUpdatedAt,
    terminal_metadata_json as terminalMetadataJson, error_code as errorCode, error_message as errorMessage,
    started_at as startedAt, completed_at as completedAt, updated_at as updatedAt
    from llm_runs where run_id=?`).bind(id).first<Record<string, unknown>>());
}

export async function loadGenericLlmRunArtifacts(db: D1Database, runId: string): Promise<GenericLlmArtifact[]> {
  const id = requiredGeneric(runId, "runId");
  const rows = await db.prepare(`select artifact_id as artifactId, run_id as runId, step_key as stepKey,
    upstream_artifact_ids_json as upstreamArtifactIdsJson, output_type as outputType, status, output_json as outputJson,
    output_markdown as outputMarkdown, structure_valid as structureValid, blocked_json as blockedJson,
    error_code as errorCode, error_message as errorMessage, terminal_metadata_json as terminalMetadataJson, completed_at as completedAt
    from llm_run_artifacts where run_id=? order by completed_at, step_key`).bind(id).all<Record<string, unknown>>();
  return rows.results.map(normalizeGenericArtifact);
}

/**
 * Claim one queued generic task and create its fenced run attempt. Existing
 * table-specific callers continue to use their own claim functions; this API
 * is the forward protocol for consumers migrated later.
 */
export async function claimGenericLlmTaskRun(db: D1Database, runnerInstanceId: string, options: GenericLlmTaskClaimOptions = {}): Promise<GenericLlmTaskRunClaim | null> {
  const runner = requiredGeneric(runnerInstanceId, "runnerInstanceId");
  const now = finiteTimestamp(options.now) ?? Date.now();
  await reconcileLocalJobProviderSlots(db, now);
  await requeueExpiredGenericLlmTaskRuns(db, now);
  const taskType = nullableGeneric(options.taskType);
  const candidate = await db.prepare(`select task_id as taskId, task_type as taskType, target_type as targetType, target_id as targetId,
    idempotency_key as idempotencyKey, protocol_version as protocolVersion, prompt_version as promptVersion,
    requested_model as requestedModel, requested_reasoning_effort as requestedReasoningEffort
    from llm_tasks where status='queued'${taskType ? " and task_type=?" : ""} order by created_at, task_id limit 1`)
    .bind(...(taskType ? [taskType] : [])).first<Record<string, unknown>>();
  if (!candidate) return null;
  const taskId = requiredGeneric(candidate.taskId, "taskId");
  const attemptRow = await db.prepare("select coalesce(max(attempt), 0) + 1 as nextAttempt from llm_runs where task_id=?").bind(taskId).first<{ nextAttempt: number }>();
  const attempt = Number(attemptRow?.nextAttempt);
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error("invalid generic LLM task attempt");
  const provider = requiredGeneric(options.provider || LOCAL_JOB_PROVIDER_ID, "provider");
  const model = requiredGeneric(options.model || candidate.requestedModel, "model");
  const reasoningEffort = nullableGeneric(options.reasoningEffort ?? candidate.requestedReasoningEffort);
  if (!await reserveLocalJobProviderSlot(db, taskId, "llm_run", attempt, runner, now)) return null;
  const runId = `llm-run:${crypto.randomUUID()}`;
  const inputJson = serializeGenericJson(options.input, "input");
  const promptJson = serializeGenericJson(options.prompt, "prompt");
  try {
    const taskUpdate = await db.prepare(`update llm_tasks set status='running', last_run_id=?, last_error_code=null, last_error_message=null,
      started_at=coalesce(started_at, ?), completed_at=null, updated_at=? where task_id=? and status='queued'`)
      .bind(runId, now, now, taskId).run();
    if (!taskUpdate.meta.changes) {
      await releaseLocalJobProviderSlot(db, taskId, attempt, runner, now);
      return null;
    }
    const runInsert = await db.prepare(`insert into llm_runs (
      run_id, task_id, attempt, provider, model, reasoning_effort, prompt_version, input_fingerprint, input_as_of,
      input_json, prompt_json, status, lease_owner, lease_until, heartbeat_at, started_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`)
      .bind(runId, taskId, attempt, provider, model, reasoningEffort, textGeneric(candidate.promptVersion),
        nullableGeneric(options.inputFingerprint), finiteTimestamp(options.inputAsOf), inputJson, promptJson,
        runner, localJobLeaseUntil(now), now, now, now).run();
    if (!runInsert.meta.changes) throw new Error("generic LLM run was not created");
    const task = await loadGenericLlmTask(db, taskId);
    const run = await loadGenericLlmRun(db, runId);
    if (!task || !run) throw new Error("generic LLM run was created but cannot be reloaded");
    return { task, run };
  } catch (error) {
    await releaseLocalJobProviderSlot(db, taskId, attempt, runner, now);
    await db.prepare(`update llm_tasks set status='queued', last_run_id=null, updated_at=? where task_id=? and status='running' and last_run_id=?`)
      .bind(now, taskId, runId).run().catch(() => {});
    throw error;
  }
}

export async function heartbeatGenericLlmRun(db: D1Database, runId: string, taskId: string, attempt: number, runnerInstanceId: string, now = Date.now()): Promise<boolean> {
  const run = requiredGeneric(runId, "runId");
  const task = requiredGeneric(taskId, "taskId");
  const runner = requiredGeneric(runnerInstanceId, "runnerInstanceId");
  const result = await db.prepare(`update llm_runs set lease_until=?, heartbeat_at=?, updated_at=?
    where run_id=? and task_id=? and status='running' and attempt=? and lease_owner=? and lease_until>=?`)
    .bind(localJobLeaseUntil(now), now, now, run, task, attempt, runner, now).run();
  if (result.meta.changes) {
    await db.prepare("update llm_tasks set updated_at=? where task_id=? and status='running' and last_run_id=?")
      .bind(now, task, run).run();
  }
  return Boolean(result.meta.changes);
}

/** Persist only structured current-step metadata. This is intentionally not a
 * text checkpoint: a stage prompt/input snapshot is acceptable metadata, while
 * streamed model output must wait for a terminal artifact write. */
export async function recordGenericLlmRunProgress(db: D1Database, input: GenericLlmRunProgressInput): Promise<boolean> {
  const runId = requiredGeneric(input.runId, "runId");
  const taskId = requiredGeneric(input.taskId, "taskId");
  const runner = requiredGeneric(input.leaseOwner, "leaseOwner");
  const now = finiteTimestamp(input.updatedAt) ?? Date.now();
  const metadataJson = serializeGenericJson(input.metadata, "progress");
  const result = await db.prepare(`update llm_runs set current_step_key=?, progress_json=?, progress_updated_at=?, updated_at=?
    where run_id=? and task_id=? and status='running' and attempt=? and lease_owner=? and lease_until>=?`)
    .bind(nullableGeneric(input.stepKey), metadataJson, now, now, runId, taskId, input.attempt, runner, now).run();
  return Boolean(result.meta.changes);
}

/** Persist exactly one terminal artifact for an active run. No partial body
 * checkpoint API exists here; `partial` is a terminal artifact status only. */
export async function writeGenericLlmRunArtifact(db: D1Database, input: GenericLlmArtifactInput & { runId: string; taskId: string; attempt: number; leaseOwner: string }): Promise<GenericLlmArtifact> {
  const runId = requiredGeneric(input.runId, "runId");
  const taskId = requiredGeneric(input.taskId, "taskId");
  const leaseOwner = requiredGeneric(input.leaseOwner, "leaseOwner");
  const stepKey = requiredGeneric(input.stepKey, "stepKey");
  const now = finiteTimestamp(input.completedAt) ?? Date.now();
  assertGenericArtifactStatus(input.status);
  const outputJson = input.outputType === "json" ? serializeGenericJson(input.output, "output") : null;
  const outputMarkdown = input.outputType === "markdown" ? nullableGeneric(input.output) : null;
  if (input.outputType === "markdown" && input.status === "complete" && !outputMarkdown) throw new Error("complete Markdown artifact requires output");
  const active = await db.prepare(`select run_id as runId from llm_runs where run_id=? and task_id=? and status='running'
    and attempt=? and lease_owner=? and lease_until>=?`).bind(runId, taskId, input.attempt, leaseOwner, now).first();
  if (!active) throw new Error("generic LLM run lease is no longer owned by this runner");
  const artifactId = `llm-artifact:${crypto.randomUUID()}`;
  const inserted = await db.prepare(`insert into llm_run_artifacts (
    artifact_id, run_id, step_key, upstream_artifact_ids_json, output_type, status, output_json, output_markdown,
    structure_valid, blocked_json, error_code, error_message, terminal_metadata_json, completed_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(artifactId, runId, stepKey, JSON.stringify(input.upstreamArtifactIds || []), input.outputType, input.status,
      outputJson, outputMarkdown, input.structureValid === null || input.structureValid === undefined ? null : input.structureValid ? 1 : 0,
      serializeGenericJson(input.blocked, "blocked"), nullableGeneric(input.errorCode), nullableGeneric(input.errorMessage),
      serializeGenericJson(input.terminalMetadata, "terminalMetadata"), now).run();
  if (!inserted.meta.changes) throw new Error("generic LLM terminal artifact was not persisted");
  await db.prepare("update llm_runs set updated_at=? where run_id=? and status='running' and attempt=? and lease_owner=?")
    .bind(now, runId, input.attempt, leaseOwner).run();
  const artifact = await db.prepare(`select artifact_id as artifactId, run_id as runId, step_key as stepKey,
    upstream_artifact_ids_json as upstreamArtifactIdsJson, output_type as outputType, status, output_json as outputJson,
    output_markdown as outputMarkdown, structure_valid as structureValid, blocked_json as blockedJson,
    error_code as errorCode, error_message as errorMessage, terminal_metadata_json as terminalMetadataJson, completed_at as completedAt
    from llm_run_artifacts where artifact_id=?`).bind(artifactId).first<Record<string, unknown>>();
  if (!artifact) throw new Error("generic LLM terminal artifact was inserted but cannot be reloaded");
  return normalizeGenericArtifact(artifact);
}

export async function completeGenericLlmRun(db: D1Database, input: GenericLlmRunTerminalInput): Promise<{ task: GenericLlmTask; run: GenericLlmRun; artifacts: GenericLlmArtifact[] }> {
  const runId = requiredGeneric(input.runId, "runId");
  const taskId = requiredGeneric(input.taskId, "taskId");
  const runner = requiredGeneric(input.leaseOwner, "leaseOwner");
  const now = finiteTimestamp(input.completedAt) ?? Date.now();
  const errorCode = nullableGeneric(input.errorCode);
  const errorMessage = nullableGeneric(input.errorMessage);
  const metadataJson = serializeGenericJson(input.terminalMetadata, "terminalMetadata");
  const active = await db.prepare(`select job_id as jobId from local_job_provider_leases where provider_id=? and job_id=? and job_type='llm_run' and attempt=? and lease_owner=?`)
    .bind(LOCAL_JOB_PROVIDER_ID, taskId, input.attempt, runner).first<Record<string, unknown>>();
  if (!active) throw new Error("generic LLM provider lease is no longer owned by this runner");
  const runUpdate = await db.prepare(`update llm_runs set status=?, terminal_metadata_json=?, error_code=?, error_message=?, completed_at=?, updated_at=?, lease_until=null
    where run_id=? and task_id=? and status='running' and attempt=? and lease_owner=? and lease_until>=?`)
    .bind(input.status, metadataJson, errorCode, errorMessage, now, now, runId, taskId, input.attempt, runner, now).run();
  if (!runUpdate.meta.changes) throw new Error("generic LLM run lease is no longer owned by this runner");
  const taskStatus: GenericLlmTaskStatus = input.status === "blocked" ? "blocked" : input.status;
  const taskUpdate = await db.prepare(`update llm_tasks set status=?, last_error_code=?, last_error_message=?, completed_at=?, updated_at=?
    where task_id=? and status='running' and last_run_id=?`).bind(taskStatus, errorCode, errorMessage, now, now, taskId, runId).run();
  if (!taskUpdate.meta.changes) throw new Error("generic LLM task was no longer running when run completed");
  await releaseLocalJobProviderSlot(db, taskId, input.attempt, runner, now);
  const task = await loadGenericLlmTask(db, taskId); const run = await loadGenericLlmRun(db, runId);
  if (!task || !run) throw new Error("generic LLM run completed but cannot be reloaded");
  return { task, run, artifacts: await loadGenericLlmRunArtifacts(db, runId) };
}

export async function failGenericLlmRun(db: D1Database, input: Omit<GenericLlmRunTerminalInput, "status">): Promise<{ task: GenericLlmTask; run: GenericLlmRun; artifacts: GenericLlmArtifact[] }> {
  return completeGenericLlmRun(db, { ...input, status: "failed" });
}

/** Requeue only runs whose lease expired; a late owner cannot write a new
 * terminal state because its run row remains fenced by attempt/owner checks. */
export async function requeueExpiredGenericLlmTaskRuns(db: D1Database, now = Date.now()): Promise<number> {
  const expired = await db.prepare(`select run_id as runId, task_id as taskId, attempt, lease_owner as leaseOwner
    from llm_runs where status='running' and lease_until<?`).bind(now).all<Record<string, unknown>>();
  let count = 0;
  for (const row of expired.results) {
    const runId = textGeneric(row.runId); const taskId = textGeneric(row.taskId); const attempt = Number(row.attempt); const owner = textGeneric(row.leaseOwner);
    if (!runId || !taskId || !Number.isInteger(attempt) || !owner) continue;
    const runUpdate = await db.prepare(`update llm_runs set status='failed', error_code='lease_expired', error_message=?, completed_at=?, updated_at=?, lease_until=null
      where run_id=? and task_id=? and status='running' and attempt=? and lease_owner=? and lease_until<?`)
      .bind("generic LLM run lease expired; requeued from the last terminal artifact", now, now, runId, taskId, attempt, owner, now).run();
    if (!runUpdate.meta.changes) continue;
    const taskUpdate = await db.prepare(`update llm_tasks set status='queued', last_error_code='lease_expired', last_error_message=?, completed_at=null, updated_at=?
      where task_id=? and status='running' and last_run_id=?`).bind("generic LLM run lease expired; requeued from the last terminal artifact", now, taskId, runId).run();
    if (taskUpdate.meta.changes) count += 1;
    await releaseLocalJobProviderSlot(db, taskId, attempt, owner, now);
  }
  return count;
}

/** Requeue one expired run after an endpoint has identified its task. This is
 * deliberately fenced by the complete run identity so a per-task recovery
 * request cannot sweep unrelated generic work. */
export async function requeueExpiredGenericLlmRun(db: D1Database, input: {
  runId: string;
  taskId: string;
  attempt: number;
  leaseOwner: string;
  errorMessage?: string;
  now?: number;
}): Promise<boolean> {
  const runId = requiredGeneric(input.runId, "runId");
  const taskId = requiredGeneric(input.taskId, "taskId");
  const leaseOwner = requiredGeneric(input.leaseOwner, "leaseOwner");
  const attempt = Number(input.attempt);
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error("generic LLM attempt is required");
  const now = finiteTimestamp(input.now) ?? Date.now();
  const message = textGeneric(input.errorMessage) || "generic LLM run lease expired; requeued from the last terminal artifact";
  const runUpdate = await db.prepare(`update llm_runs set status='failed', error_code='lease_expired', error_message=?, completed_at=?, updated_at=?, lease_until=null
    where run_id=? and task_id=? and status='running' and attempt=? and lease_owner=? and lease_until<?`)
    .bind(message, now, now, runId, taskId, attempt, leaseOwner, now).run();
  if (!runUpdate.meta.changes) return false;
  const taskUpdate = await db.prepare(`update llm_tasks set status='queued', last_error_code='lease_expired', last_error_message=?, completed_at=null, updated_at=?
    where task_id=? and status='running' and last_run_id=?`).bind(message, now, taskId, runId).run();
  await releaseLocalJobProviderSlot(db, taskId, attempt, leaseOwner, now);
  return Boolean(taskUpdate.meta.changes);
}

async function findGenericLlmTask(db: D1Database, identity: {
  taskType: string;
  targetType: string;
  targetId: string;
  idempotencyKey: string;
  protocolVersion: string;
  promptVersion: string;
}): Promise<GenericLlmTask | null> {
  return normalizeGenericTask(await db.prepare(`select task_id as taskId, task_type as taskType, target_type as targetType, target_id as targetId,
    idempotency_key as idempotencyKey, protocol_version as protocolVersion, prompt_version as promptVersion, status,
    requested_model as requestedModel, requested_reasoning_effort as requestedReasoningEffort, last_run_id as lastRunId,
    metadata_json as metadataJson, last_error_code as lastErrorCode, last_error_message as lastErrorMessage,
    created_at as createdAt, started_at as startedAt, completed_at as completedAt, updated_at as updatedAt
    from llm_tasks where task_type=? and target_type=? and target_id=? and idempotency_key=? and protocol_version=? and prompt_version=?`)
    .bind(identity.taskType, identity.targetType, identity.targetId, identity.idempotencyKey, identity.protocolVersion, identity.promptVersion)
    .first<Record<string, unknown>>());
}

function normalizeGenericTask(row: Record<string, unknown> | null): GenericLlmTask | null {
  if (!row) return null;
  const status = textGeneric(row.status) as GenericLlmTaskStatus;
  if (!["queued", "running", "completed", "failed", "blocked"].includes(status)) throw new Error("invalid generic LLM task status");
  return {
    taskId: requiredGeneric(row.taskId, "taskId"), taskType: requiredGeneric(row.taskType, "taskType"), targetType: requiredGeneric(row.targetType, "targetType"), targetId: requiredGeneric(row.targetId, "targetId"),
    idempotencyKey: requiredGeneric(row.idempotencyKey, "idempotencyKey"), protocolVersion: requiredGeneric(row.protocolVersion, "protocolVersion"), promptVersion: requiredGeneric(row.promptVersion, "promptVersion"), status,
    requestedModel: nullableGeneric(row.requestedModel), requestedReasoningEffort: nullableGeneric(row.requestedReasoningEffort), lastRunId: nullableGeneric(row.lastRunId), metadata: parseGenericJson(row.metadataJson),
    lastErrorCode: nullableGeneric(row.lastErrorCode), lastErrorMessage: nullableGeneric(row.lastErrorMessage), createdAt: finiteTimestamp(row.createdAt) ?? 0, startedAt: finiteTimestamp(row.startedAt), completedAt: finiteTimestamp(row.completedAt), updatedAt: finiteTimestamp(row.updatedAt) ?? 0,
  };
}

function normalizeGenericRun(row: Record<string, unknown> | null): GenericLlmRun | null {
  if (!row) return null;
  const status = textGeneric(row.status) as GenericLlmRunStatus;
  if (!["running", "completed", "failed", "blocked"].includes(status)) throw new Error("invalid generic LLM run status");
  return {
    runId: requiredGeneric(row.runId, "runId"), taskId: requiredGeneric(row.taskId, "taskId"), attempt: Number(row.attempt), provider: requiredGeneric(row.provider, "provider"), model: requiredGeneric(row.model, "model"),
    reasoningEffort: nullableGeneric(row.reasoningEffort), promptVersion: requiredGeneric(row.promptVersion, "promptVersion"), inputFingerprint: nullableGeneric(row.inputFingerprint), inputAsOf: finiteTimestamp(row.inputAsOf), input: parseGenericJson(row.inputJson), prompt: parseGenericJson(row.promptJson), status,
    leaseOwner: nullableGeneric(row.leaseOwner), leaseUntil: finiteTimestamp(row.leaseUntil), heartbeatAt: finiteTimestamp(row.heartbeatAt), currentStepKey: nullableGeneric(row.currentStepKey), progress: parseGenericJson(row.progressJson), progressUpdatedAt: finiteTimestamp(row.progressUpdatedAt), terminalMetadata: parseGenericJson(row.terminalMetadataJson), errorCode: nullableGeneric(row.errorCode), errorMessage: nullableGeneric(row.errorMessage),
    startedAt: finiteTimestamp(row.startedAt) ?? 0, completedAt: finiteTimestamp(row.completedAt), updatedAt: finiteTimestamp(row.updatedAt) ?? 0,
  };
}

function normalizeGenericArtifact(row: Record<string, unknown>): GenericLlmArtifact {
  const status = textGeneric(row.status) as GenericLlmArtifactStatus;
  if (!["complete", "partial", "blocked", "not_applicable", "failed"].includes(status)) throw new Error("invalid generic LLM artifact status");
  const outputType = textGeneric(row.outputType) as GenericLlmOutputType;
  if (!["json", "markdown"].includes(outputType)) throw new Error("invalid generic LLM artifact output type");
  const structure = row.structureValid === null || row.structureValid === undefined ? null : Boolean(Number(row.structureValid));
  const output = outputType === "json" ? parseGenericJson(row.outputJson) : nullableGeneric(row.outputMarkdown);
  const upstream = parseGenericJson(row.upstreamArtifactIdsJson);
  return {
    artifactId: requiredGeneric(row.artifactId, "artifactId"), runId: requiredGeneric(row.runId, "runId"), stepKey: requiredGeneric(row.stepKey, "stepKey"), upstreamArtifactIds: Array.isArray(upstream) ? upstream.flatMap((item) => typeof item === "string" && item.trim() ? [item.trim()] : []) : [], outputType, status, output,
    structureValid: structure, blocked: parseGenericJson(row.blockedJson), errorCode: nullableGeneric(row.errorCode), errorMessage: nullableGeneric(row.errorMessage), terminalMetadata: parseGenericJson(row.terminalMetadataJson), completedAt: finiteTimestamp(row.completedAt) ?? 0,
  };
}

function assertGenericArtifactStatus(value: string): asserts value is GenericLlmArtifactStatus {
  if (!["complete", "partial", "blocked", "not_applicable", "failed"].includes(value)) throw new Error("invalid generic LLM artifact terminal status");
}

function textGeneric(value: unknown): string { return typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : ""; }
function nullableGeneric(value: unknown): string | null { const result = textGeneric(value); return result || null; }
function requiredGeneric(value: unknown, name: string): string { const result = textGeneric(value); if (!result) throw new Error(`generic LLM ${name} is required`); return result; }
function finiteTimestamp(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : null;
}
function serializeGenericJson(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  try { return JSON.stringify(value); } catch { throw new Error(`generic LLM ${name} is not serializable`); }
}
function parseGenericJson(value: unknown): unknown {
  if (typeof value !== "string" || !value.trim()) return null;
  try { return JSON.parse(value); } catch { return null; }
}
async function hasGenericLlmProtocol(db: D1Database): Promise<boolean> {
  try {
    const row = await db.prepare(`select count(*) as count from sqlite_master where type='table' and name in ('llm_tasks','llm_runs','llm_run_artifacts')`).first<{ count: number }>();
    return Number(row?.count) === 3;
  } catch {
    return false;
  }
}
