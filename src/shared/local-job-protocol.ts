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
export const GENERIC_LLM_TASK_DEFAULT_PRIORITY = 500;
/** Universal handler for request-bound and CLI model calls. */
export const GENERIC_LLM_RAW_MODEL_TASK_TYPE = "generic_raw_model";
export const GENERIC_LLM_RAW_MODEL_HANDLER_KEY = "generic_raw_model";
export const GENERIC_LLM_RAW_MODEL_ARTIFACT_STEP = "raw_model";
export const GENERIC_LLM_TASK_SEQUENCE_NAME = "llm_tasks";
export const GENERIC_LLM_GLOBAL_MODEL_CONCURRENCY = 5;
/** The run ledger requires a provider/model even for deterministic work. */
export const GENERIC_LLM_ENGINEERING_PROVIDER = "engineering";
export const GENERIC_LLM_ENGINEERING_MODEL = "engineering";
export type GenericLlmTaskStatus = "queued" | "running" | "completed" | "failed" | "blocked";
export type GenericLlmRunStatus = "running" | "completed" | "failed" | "blocked";
export type GenericLlmArtifactStatus = "complete" | "partial" | "blocked" | "not_applicable" | "failed";
export type GenericLlmOutputType = "json" | "markdown";
export type GenericLlmExecutionMode = "model" | "engineering";
export type GenericLlmDependencyState = "ready" | "waiting" | "blocked";

export type GenericLlmDependency = {
  taskId: string;
  dependsOnTaskId: string;
  requiredStatus: "completed";
  status: GenericLlmTaskStatus | null;
};

export type GenericLlmDependencyEvaluation = {
  state: GenericLlmDependencyState;
  pendingTaskIds: string[];
  failedTaskIds: string[];
  dependencyTaskIds: string[];
};

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
  priority?: number | null;
  handlerKey?: string | null;
  executionMode?: GenericLlmExecutionMode | null;
  parentTaskId?: string | null;
  stageKey?: string | null;
  readyAt?: number | null;
  dependsOnTaskIds?: string[];
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
  priority: number;
  queueSequence: number;
  handlerKey: string;
  executionMode: GenericLlmExecutionMode;
  parentTaskId: string | null;
  stageKey: string | null;
  readyAt: number | null;
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
  /** The nearest prior run whose terminal artifacts were considered for reuse. */
  lineageRunId: string | null;
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
  stageVersion: string | null;
  inputFingerprint: string | null;
  upstreamArtifactIds: string[];
  sourceIds: string[];
  claimIds: string[];
  evidenceIds: string[];
  unknownIds: string[];
  outputType: GenericLlmOutputType;
  status: GenericLlmArtifactStatus;
  output: unknown;
  structureValid: boolean | null;
  blocked: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  terminalMetadata: unknown;
  projectionVersion: string | null;
  completedAt: number;
  /** Source run when this artifact is linked into a recovery run. */
  sourceRunId?: string | null;
  reused?: boolean;
};

export type GenericLlmTaskCreateResult = {
  task: GenericLlmTask;
  created: boolean;
  deduplicated: boolean;
};

export type GenericWebQaRecoveryResult = {
  sourceTask: GenericLlmTask;
  sourceRun: GenericLlmRun;
  recoveryTask: GenericLlmTask;
  recoveryTaskId: string;
  gatewayTaskId: string;
  finalReportTaskId: string | null;
  coordinatorTaskId: string | null;
};

export type GenericLlmTaskRunClaim = {
  task: GenericLlmTask;
  run: GenericLlmRun;
};

export type GenericLlmTaskClaimOptions = {
  taskType?: string;
  /** Global-dispatcher admission filter used when a handler-local lane is full. */
  excludeHandlerKeys?: string[];
  protocolVersion?: string;
  promptVersion?: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string | null;
  inputFingerprint?: string | null;
  inputAsOf?: number | null;
  input?: unknown;
  prompt?: unknown;
  executionMode?: GenericLlmExecutionMode;
  /** Internal compatibility switch; only the new global dispatcher sets it. */
  globalQueue?: boolean;
  now?: number;
};

/** Provider-neutral payload persisted in a raw/model task's metadata.  It is
 * intentionally limited to the shared provider contract; request signals and
 * callbacks never cross the durable boundary. */
export type GenericRawModelRequest = {
  provider: string;
  model: string;
  requestId?: string;
  instructions?: string;
  input: Array<{ role: "user" | "assistant" | "system"; content: Array<{ type: "input_text"; text: string }> }>;
  maxOutputTokens?: number;
  temperature?: number;
  allowReasoning?: boolean;
  reasoningEffort?: string | null;
  reasoningSummary?: "auto" | "concise" | "detailed";
  tools?: Array<Record<string, unknown>>;
  toolChoice?: "auto" | "required" | "none";
  cacheTtlMs?: number;
  cacheEnabled?: boolean;
  stream?: boolean;
};

export type GenericLlmArtifactInput = {
  stepKey: string;
  stageVersion?: string;
  inputFingerprint?: string | null;
  upstreamArtifactIds?: string[];
  sourceIds?: string[];
  claimIds?: string[];
  evidenceIds?: string[];
  unknownIds?: string[];
  outputType: GenericLlmOutputType;
  status: GenericLlmArtifactStatus;
  output?: unknown;
  structureValid?: boolean | null;
  blocked?: unknown;
  errorCode?: string | null;
  errorMessage?: string | null;
  terminalMetadata?: unknown;
  projectionVersion?: string | null;
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

export type GenericLlmArtifactCompatibilityInput = {
  runId: string;
  taskId: string;
  attempt: number;
  leaseOwner: string;
  stepKey: string;
  stageVersion: string;
  inputFingerprint: string | null;
  upstreamArtifactIds?: string[];
  projectionVersion: string;
  now?: number;
};

/** Validate the queue contract at the API boundary; do not silently clamp. */
export function normalizeGenericLlmPriority(value: unknown, fallback = GENERIC_LLM_TASK_DEFAULT_PRIORITY): number {
  if (value === undefined || value === null || value === "") return fallback;
  const priority = Number(value);
  if (!Number.isInteger(priority) || priority < 0 || priority > 1000) {
    throw new Error("generic LLM priority must be an integer from 0 to 1000");
  }
  return priority;
}

export function normalizeGenericLlmExecutionMode(value: unknown, fallback: GenericLlmExecutionMode = "model"): GenericLlmExecutionMode {
  if (value === undefined || value === null || value === "") return fallback;
  const mode = textGeneric(value);
  if (mode !== "model" && mode !== "engineering") throw new Error("generic LLM executionMode must be model or engineering");
  return mode;
}

/** Higher priority wins; equal priorities are FIFO by durable sequence. */
export function compareGenericLlmQueueOrder(left: Pick<GenericLlmTask, "priority" | "queueSequence" | "createdAt" | "taskId">, right: Pick<GenericLlmTask, "priority" | "queueSequence" | "createdAt" | "taskId">): number {
  return right.priority - left.priority
    || left.queueSequence - right.queueSequence
    || left.createdAt - right.createdAt
    || left.taskId.localeCompare(right.taskId);
}

export function evaluateGenericLlmDependencies(statuses: Array<Pick<GenericLlmDependency, "dependsOnTaskId" | "status">>): GenericLlmDependencyEvaluation {
  const pendingTaskIds = statuses.filter((item) => item.status !== "completed").filter((item) => item.status !== "failed" && item.status !== "blocked").map((item) => item.dependsOnTaskId);
  const failedTaskIds = statuses.filter((item) => item.status === "failed" || item.status === "blocked").map((item) => item.dependsOnTaskId);
  const dependencyTaskIds = statuses.map((item) => item.dependsOnTaskId);
  return {
    state: failedTaskIds.length ? "blocked" : pendingTaskIds.length ? "waiting" : "ready",
    pendingTaskIds,
    failedTaskIds,
    dependencyTaskIds,
  };
}

export function localJobLeaseUntil(now = Date.now()): number {
  return now + LOCAL_JOB_LEASE_MS;
}

/**
 * Allocate a durable FIFO sequence. SQLite serializes the UPDATE, so callers
 * in different local worker processes cannot obtain the same sequence. A
 * compatibility fallback is retained for a partially migrated database; the
 * 0110 migration always creates the allocator row before new tasks are used.
 */
export async function allocateGenericLlmQueueSequence(db: D1Database): Promise<number> {
  try {
    const row = await db.prepare(`update llm_scheduler_sequence
      set next_sequence=next_sequence+1 where sequence_name=? returning next_sequence as nextSequence`)
      .bind(GENERIC_LLM_TASK_SEQUENCE_NAME).first<{ nextSequence: number }>();
    const sequence = Number(row?.nextSequence);
    if (Number.isInteger(sequence) && sequence > 0) return sequence;
  } catch {
    // A pre-0110 database is handled by the legacy insert path below.
  }
  try {
    const row = await db.prepare("select coalesce(max(queue_sequence), 0) + 1 as nextSequence from llm_tasks")
      .first<{ nextSequence: number }>();
    const sequence = Number(row?.nextSequence);
    return Number.isInteger(sequence) && sequence > 0 ? sequence : 0;
  } catch {
    return 0;
  }
}

export async function addGenericLlmTaskDependencies(db: D1Database, taskId: string, dependsOnTaskIds: string[], now = Date.now()): Promise<void> {
  const task = requiredGeneric(taskId, "taskId");
  const ids = normalizeGenericLlmIdArray(dependsOnTaskIds, "dependsOnTaskIds");
  if (!ids.length) {
    await db.prepare("update llm_tasks set ready_at=coalesce(ready_at,?), updated_at=? where task_id=? and status='queued'")
      .bind(now, now, task).run().catch(() => {});
    return;
  }
  await db.batch(ids.map((dependency) => db.prepare(`insert or ignore into llm_task_dependencies
    (task_id, depends_on_task_id, required_status, created_at) values (?, ?, 'completed', ?)`)
    .bind(task, dependency, now)));
  await refreshGenericLlmTaskDependencyState(db, task, now);
}

export async function loadGenericLlmTaskDependencies(db: D1Database, taskId: string): Promise<GenericLlmDependency[]> {
  const task = requiredGeneric(taskId, "taskId");
  try {
    const rows = await db.prepare(`select d.task_id as taskId, d.depends_on_task_id as dependsOnTaskId,
      d.required_status as requiredStatus, t.status
      from llm_task_dependencies d left join llm_tasks t on t.task_id=d.depends_on_task_id
      where d.task_id=? order by d.depends_on_task_id`).bind(task).all<Record<string, unknown>>();
    return rows.results.map((row) => ({
      taskId: requiredGeneric(row.taskId, "taskId"),
      dependsOnTaskId: requiredGeneric(row.dependsOnTaskId, "dependsOnTaskId"),
      requiredStatus: "completed" as const,
      status: nullableGeneric(row.status) as GenericLlmTaskStatus | null,
    }));
  } catch (error) {
    if (/no such table|no such column/i.test(String(error))) return [];
    throw error;
  }
}

export async function evaluateGenericLlmTaskDependencies(db: D1Database, taskId: string): Promise<GenericLlmDependencyEvaluation> {
  return evaluateGenericLlmDependencies(await loadGenericLlmTaskDependencies(db, taskId));
}

/** Mark one queued task ready or visibly blocked by a failed upstream task. */
export async function refreshGenericLlmTaskDependencyState(db: D1Database, taskId: string, now = Date.now()): Promise<GenericLlmDependencyEvaluation> {
  const task = requiredGeneric(taskId, "taskId");
  const evaluation = await evaluateGenericLlmTaskDependencies(db, task);
  if (evaluation.state === "ready") {
    await db.prepare("update llm_tasks set ready_at=coalesce(ready_at,?), updated_at=? where task_id=? and status='queued'")
      .bind(now, now, task).run().catch(() => {});
  } else if (evaluation.state === "blocked") {
    await db.prepare(`update llm_tasks set status='blocked', last_error_code='dependency_blocked',
      last_error_message=?, completed_at=?, updated_at=? where task_id=? and status='queued'`)
      .bind(`blocked by failed dependencies: ${evaluation.failedTaskIds.join(", ")}`, now, now, task).run().catch(() => {});
  } else {
    await db.prepare("update llm_tasks set ready_at=null, updated_at=? where task_id=? and status='queued'")
      .bind(now, task).run().catch(() => {});
  }
  return evaluation;
}

/** Reconcile all queued dependency edges after an upstream terminal update. */
export async function reconcileGenericLlmTaskDependencies(db: D1Database, now = Date.now()): Promise<{ ready: number; blocked: number }> {
  try {
    const statement = db.prepare(`select distinct d.task_id as taskId from llm_task_dependencies d
      join llm_tasks t on t.task_id=d.task_id where t.status='queued'`);
    if (typeof (statement as unknown as { all?: unknown }).all !== "function") return { ready: 0, blocked: 0 };
    const rows = await statement.all<{ taskId: string }>();
    let ready = 0; let blocked = 0;
    for (const row of rows.results) {
      const evaluation = await refreshGenericLlmTaskDependencyState(db, row.taskId, now);
      if (evaluation.state === "ready") ready += 1;
      if (evaluation.state === "blocked") blocked += 1;
    }
    return { ready, blocked };
  } catch (error) {
    if (/no such table|no such column/i.test(String(error))) return { ready: 0, blocked: 0 };
    throw error;
  }
}

/** Link a child-stage terminal artifact into its workflow projection. */
export async function linkGenericWorkflowArtifact(db: D1Database, input: {
  parentTaskId: string;
  childTaskId: string;
  runId: string;
  artifactId: string;
  stageKey: string;
  linkedAt?: number;
}): Promise<boolean> {
  const parentTaskId = requiredGeneric(input.parentTaskId, "parentTaskId");
  const childTaskId = requiredGeneric(input.childTaskId, "childTaskId");
  const runId = requiredGeneric(input.runId, "runId");
  const artifactId = requiredGeneric(input.artifactId, "artifactId");
  const stageKey = requiredGeneric(input.stageKey, "stageKey");
  const linked = await db.prepare(`insert or ignore into llm_workflow_artifact_links
    (parent_task_id, child_task_id, run_id, artifact_id, stage_key, linked_at)
    values (?, ?, ?, ?, ?, ?)`)
    .bind(parentTaskId, childTaskId, runId, artifactId, stageKey, finiteTimestamp(input.linkedAt) ?? Date.now()).run();
  return Boolean(linked.meta.changes);
}

export async function loadGenericWorkflowArtifacts(db: D1Database, parentTaskId: string): Promise<GenericLlmArtifact[]> {
  const parent = requiredGeneric(parentTaskId, "parentTaskId");
  try {
    const rows = await db.prepare(`select a.artifact_id as artifactId, l.run_id as runId, a.step_key as stepKey,
      a.stage_version as stageVersion, a.input_fingerprint as inputFingerprint,
      a.upstream_artifact_ids_json as upstreamArtifactIdsJson, a.source_ids_json as sourceIdsJson,
      a.claim_ids_json as claimIdsJson, a.evidence_ids_json as evidenceIdsJson, a.unknown_ids_json as unknownIdsJson,
      a.output_type as outputType, a.status, a.output_json as outputJson, a.output_markdown as outputMarkdown,
      a.structure_valid as structureValid, a.blocked_json as blockedJson, a.error_code as errorCode,
      a.error_message as errorMessage, a.terminal_metadata_json as terminalMetadataJson,
      a.projection_version as projectionVersion, a.completed_at as completedAt,
      a.run_id as sourceRunId, 0 as reused
      from llm_workflow_artifact_links l join llm_run_artifacts a on a.artifact_id=l.artifact_id
      where l.parent_task_id=? order by l.linked_at, l.stage_key`).bind(parent).all<Record<string, unknown>>();
    return rows.results.map(normalizeGenericArtifact);
  } catch (error) {
    if (/no such table|no such column/i.test(String(error))) return [];
    throw error;
  }
}

/** Atomically reserves one shared provider slot for a claimed task attempt. */
export async function reserveLocalJobProviderSlot(db: D1Database, jobId: string, jobType: string, attempt: number, leaseOwner: string, now = Date.now(), concurrencyLimit = config.provider.globalConcurrency): Promise<boolean> {
  const slot = await db.prepare(`update local_job_provider_slots
    set active_count=active_count+1, concurrency_limit=?, updated_at=?
    where provider_id=? and active_count<?`)
    .bind(concurrencyLimit, now, LOCAL_JOB_PROVIDER_ID, concurrencyLimit).run();
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

/** Engineering work is fenced by the generic run lease but never consumes a
 * provider slot. This helper is intentionally a no-op for the ledger. */
export async function reserveGenericEngineeringSlot(): Promise<boolean> {
  return true;
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
  const priority = normalizeGenericLlmPriority(spec.priority);
  const handlerKey = textGeneric(spec.handlerKey) || taskType;
  const executionMode = normalizeGenericLlmExecutionMode(spec.executionMode);
  const parentTaskId = nullableGeneric(spec.parentTaskId);
  const stageKey = nullableGeneric(spec.stageKey);
  const dependsOnTaskIds = normalizeGenericLlmIdArray(spec.dependsOnTaskIds, "dependsOnTaskIds");
  if (dependsOnTaskIds.includes(taskId)) throw new Error("generic LLM task cannot depend on itself");
  const readyAt = dependsOnTaskIds.length ? null : finiteTimestamp(spec.readyAt) ?? now;
  const queueSequence = await allocateGenericLlmQueueSequence(db);
  let inserted: { meta: { changes?: number } };
  try {
    inserted = await db.prepare(`insert or ignore into llm_tasks (
      task_id, task_type, target_type, target_id, idempotency_key, protocol_version, prompt_version, status,
      requested_model, requested_reasoning_effort, metadata_json, priority, queue_sequence, handler_key,
      execution_mode, parent_task_id, stage_key, ready_at, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(taskId, taskType, targetType, targetId, idempotencyKey, protocolVersion, promptVersion,
        nullableGeneric(spec.model), nullableGeneric(spec.reasoningEffort), metadataJson, priority, queueSequence,
        handlerKey, executionMode, parentTaskId, stageKey, readyAt, now, now).run();
  } catch (error) {
    // Keep callers usable while a local database is being upgraded. The next
    // migration is additive; no scheduler claim should run until it exists.
    if (!/no such column|no such table/i.test(String(error))) throw error;
    inserted = await db.prepare(`insert or ignore into llm_tasks (
      task_id, task_type, target_type, target_id, idempotency_key, protocol_version, prompt_version, status,
      requested_model, requested_reasoning_effort, metadata_json, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`)
      .bind(taskId, taskType, targetType, targetId, idempotencyKey, protocolVersion, promptVersion,
        nullableGeneric(spec.model), nullableGeneric(spec.reasoningEffort), metadataJson, now, now).run();
  }
  const task = await findGenericLlmTask(db, { taskType, targetType, targetId, idempotencyKey, protocolVersion, promptVersion });
  if (!task) throw new Error("generic LLM task was inserted but cannot be reloaded");
  if (dependsOnTaskIds.length && inserted.meta.changes) await addGenericLlmTaskDependencies(db, task.taskId, dependsOnTaskIds, now);
  return { task, created: Boolean(inserted.meta.changes), deduplicated: !inserted.meta.changes };
}

export async function loadGenericLlmTask(db: D1Database, taskId: string): Promise<GenericLlmTask | null> {
  const id = requiredGeneric(taskId, "taskId");
  try {
    return normalizeGenericTask(await db.prepare(`select task_id as taskId, task_type as taskType, target_type as targetType, target_id as targetId,
      idempotency_key as idempotencyKey, protocol_version as protocolVersion, prompt_version as promptVersion, status,
      requested_model as requestedModel, requested_reasoning_effort as requestedReasoningEffort, last_run_id as lastRunId,
      metadata_json as metadataJson, last_error_code as lastErrorCode, last_error_message as lastErrorMessage,
      priority, queue_sequence as queueSequence, handler_key as handlerKey, execution_mode as executionMode,
      parent_task_id as parentTaskId, stage_key as stageKey, ready_at as readyAt,
      created_at as createdAt, started_at as startedAt, completed_at as completedAt, updated_at as updatedAt
      from llm_tasks where task_id=?`).bind(id).first<Record<string, unknown>>());
  } catch (error) {
    if (!/no such column/i.test(String(error))) throw error;
    return normalizeGenericTask(await db.prepare(`select task_id as taskId, task_type as taskType, target_type as targetType, target_id as targetId,
      idempotency_key as idempotencyKey, protocol_version as protocolVersion, prompt_version as promptVersion, status,
      requested_model as requestedModel, requested_reasoning_effort as requestedReasoningEffort, last_run_id as lastRunId,
      metadata_json as metadataJson, last_error_code as lastErrorCode, last_error_message as lastErrorMessage,
      created_at as createdAt, started_at as startedAt, completed_at as completedAt, updated_at as updatedAt
      from llm_tasks where task_id=?`).bind(id).first<Record<string, unknown>>());
  }
}

/** Load all materialized children of a workflow coordinator in queue order. */
export async function loadGenericLlmChildTasks(db: D1Database, parentTaskId: string): Promise<GenericLlmTask[]> {
  const parent = requiredGeneric(parentTaskId, "parentTaskId");
  try {
    const rows = await db.prepare(`select task_id as taskId, task_type as taskType, target_type as targetType, target_id as targetId,
      idempotency_key as idempotencyKey, protocol_version as protocolVersion, prompt_version as promptVersion, status,
      requested_model as requestedModel, requested_reasoning_effort as requestedReasoningEffort, last_run_id as lastRunId,
      metadata_json as metadataJson, last_error_code as lastErrorCode, last_error_message as lastErrorMessage,
      priority, queue_sequence as queueSequence, handler_key as handlerKey, execution_mode as executionMode,
      parent_task_id as parentTaskId, stage_key as stageKey, ready_at as readyAt,
      created_at as createdAt, started_at as startedAt, completed_at as completedAt, updated_at as updatedAt
      from llm_tasks where parent_task_id=? order by queue_sequence asc, created_at asc, task_id asc`).bind(parent).all<Record<string, unknown>>();
    // A compatibility D1 adapter may return a shared `all()` fixture for
    // unrelated queries. Child rows always carry a non-empty parent ID; ignore
    // malformed/non-child rows instead of letting their artifact status poison
    // the parent status read.
    return rows.results
      .filter((row) => Boolean(textGeneric(row.parentTaskId)))
      .map(normalizeGenericTask)
      .filter((task): task is GenericLlmTask => Boolean(task));
  } catch (error) {
    if (/no such table|no such column/i.test(String(error))) return [];
    throw error;
  }
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
  const sourceTask = await loadGenericLlmTask(db, id);
  const sourceRun = sourceTask?.status === "failed" && sourceTask.lastRunId
    ? await loadGenericLlmRun(db, sourceTask.lastRunId)
    : null;
  const result = await db.prepare(`update llm_tasks set status='queued', last_run_id=null, last_error_code=null, last_error_message=null,
    started_at=null, completed_at=null, updated_at=? where task_id=? and status in ('failed', 'blocked', 'completed')`).bind(now, id).run();
  if (result.meta.changes && sourceTask && sourceRun) {
    await persistGenericWebQaRecoveryMetadata(db, sourceTask, sourceRun, now);
  }
  if (result.meta.changes) await refreshGenericLlmTaskDependencyState(db, id, now);
  return Boolean(result.meta.changes);
}

/**
 * Keep the gateway task identity at the generic protocol boundary. A later
 * fenced attempt then GETs the original browser conversation instead of
 * submitting another ChatGPT turn after an app/worker interruption.
 */
export function genericWebQaRecoveryExternal(sourceTask: Pick<GenericLlmTask, "taskId">, sourceRun: Pick<GenericLlmRun, "runId" | "progress">): Record<string, unknown> | null {
  const progress = sourceRun.progress && typeof sourceRun.progress === "object" && !Array.isArray(sourceRun.progress)
    ? sourceRun.progress as Record<string, unknown>
    : {};
  const external = progress.external && typeof progress.external === "object" && !Array.isArray(progress.external)
    ? progress.external as Record<string, unknown>
    : null;
  if (external?.kind !== "webqa") return null;
  const gatewayTaskId = textGeneric(external.gatewayTaskId || external.taskId);
  const conversationId = textGeneric(external.conversationId);
  const idempotencyKey = textGeneric(external.idempotencyKey);
  if (!gatewayTaskId || !conversationId || !idempotencyKey) return null;
  return {
    ...external,
    kind: "webqa",
    gatewayTaskId,
    recoveredFromRunId: sourceRun.runId,
    recoveredFromTaskId: sourceTask.taskId,
  };
}

async function persistGenericWebQaRecoveryMetadata(db: D1Database, sourceTask: GenericLlmTask, sourceRun: GenericLlmRun, now: number): Promise<void> {
  const recoveryExternal = genericWebQaRecoveryExternal(sourceTask, sourceRun);
  if (!recoveryExternal) return;
  const metadata = sourceTask.metadata && typeof sourceTask.metadata === "object" && !Array.isArray(sourceTask.metadata)
    ? sourceTask.metadata as Record<string, unknown>
    : {};
  await db.prepare("update llm_tasks set metadata_json=?, updated_at=? where task_id=? and status='queued'")
    .bind(JSON.stringify({
      ...metadata,
      recoveryExternal,
      recoveredFromRunId: sourceRun.runId,
      recoveryGatewayTaskId: recoveryExternal.gatewayTaskId,
    }), now, sourceTask.taskId).run();
}

/**
 * Adopt one already-completed WebQA-backed final-report request without
 * submitting another provider prompt. The source task/run and its old
 * citation-only artifact remain immutable evidence; requeueing the same
 * durable task creates the next fenced run, whose metadata tells the Node
 * adapter to GET the previously persisted gateway task instead of POSTing.
 */
export async function recoverGenericWebQaFinalReport(db: D1Database, input: {
  taskId: string;
  now?: number;
}): Promise<GenericWebQaRecoveryResult> {
  const sourceTaskId = requiredGeneric(input.taskId, "taskId");
  const now = finiteTimestamp(input.now) ?? Date.now();
  const sourceTask = await loadGenericLlmTask(db, sourceTaskId);
  if (!sourceTask) throw new Error("generic WebQA recovery source task not found");
  if (sourceTask.taskType !== GENERIC_LLM_RAW_MODEL_TASK_TYPE || sourceTask.handlerKey !== GENERIC_LLM_RAW_MODEL_HANDLER_KEY) {
    throw new Error("generic WebQA recovery only supports generic_raw_model tasks");
  }
  if (sourceTask.targetType !== "research_operating_analysis_low_dependency_final_report") {
    throw new Error("generic WebQA recovery only supports low-dependency final-report tasks");
  }
  if (!sourceTask.lastRunId || sourceTask.status !== "completed") {
    throw new Error("generic WebQA recovery requires a completed source task run");
  }
  const sourceRun = await loadGenericLlmRun(db, sourceTask.lastRunId);
  if (!sourceRun || sourceRun.status !== "completed") throw new Error("generic WebQA recovery source run is not completed");
  const progress = sourceRun.progress && typeof sourceRun.progress === "object" && !Array.isArray(sourceRun.progress)
    ? sourceRun.progress as Record<string, unknown>
    : {};
  const external = progress.external && typeof progress.external === "object" && !Array.isArray(progress.external)
    ? progress.external as Record<string, unknown>
    : null;
  if (external?.kind !== "webqa") throw new Error("generic WebQA recovery source run has no WebQA progress identity");
  const gatewayTaskId = textGeneric(external.gatewayTaskId);
  const conversationId = textGeneric(external.conversationId);
  const idempotencyKey = textGeneric(external.idempotencyKey);
  if (!gatewayTaskId || !conversationId || !idempotencyKey) throw new Error("generic WebQA recovery source progress is incomplete");

  const sourceMetadata = sourceTask.metadata && typeof sourceTask.metadata === "object" && !Array.isArray(sourceTask.metadata)
    ? sourceTask.metadata as Record<string, unknown>
    : {};
  const recoveryExternal = {
    ...external,
    kind: "webqa",
    recoveredFromRunId: sourceRun.runId,
    recoveredFromTaskId: sourceTask.taskId,
  };
  const recoveryMetadata = {
    ...sourceMetadata,
    recoveryExternal,
    recoveredFromRunId: sourceRun.runId,
    recoveryGatewayTaskId: gatewayTaskId,
  };

  const requeued = await requeueGenericLlmTask(db, sourceTask.taskId, now);
  if (!requeued) throw new Error("generic WebQA recovery source task could not be requeued");
  await db.prepare("update llm_tasks set metadata_json=?, updated_at=? where task_id=? and status='queued'")
    .bind(JSON.stringify(recoveryMetadata), now, sourceTask.taskId).run();

  let finalReportTaskId: string | null = null;
  let coordinatorTaskId: string | null = null;
  try {
    const childRows = await db.prepare(`select task_id as taskId, parent_task_id as parentTaskId, status, metadata_json as metadataJson
      from llm_tasks where task_type='research_operating_analysis_low_dependency_work_package'
        and target_id=? and stage_key='final_report'
      order by created_at desc limit 1`).bind(sourceTask.targetId).all<Record<string, unknown>>();
    const child = childRows.results[0];
    if (child) {
      finalReportTaskId = textGeneric(child.taskId) || null;
      coordinatorTaskId = textGeneric(child.parentTaskId) || null;
      if (!finalReportTaskId) throw new Error("low-dependency final-report recovery child task id is missing");
      const childMetadata = parseGenericJson(child.metadataJson);
      const nextChildMetadata = childMetadata && typeof childMetadata === "object" && !Array.isArray(childMetadata)
        ? childMetadata as Record<string, unknown>
        : {};
      nextChildMetadata.recoveryRawTaskId = sourceTask.taskId;
      nextChildMetadata.recoveredFromRunId = sourceRun.runId;
      nextChildMetadata.recoveryGatewayTaskId = gatewayTaskId;
      await db.prepare("update llm_tasks set metadata_json=?, updated_at=? where task_id=?")
        .bind(JSON.stringify(nextChildMetadata), now, finalReportTaskId).run();
      if (["failed", "blocked", "completed"].includes(textGeneric(child.status))) await requeueGenericLlmTask(db, finalReportTaskId, now);
      if (coordinatorTaskId) {
        const parent = await loadGenericLlmTask(db, coordinatorTaskId);
        if (parent && ["failed", "blocked", "completed"].includes(parent.status)) await requeueGenericLlmTask(db, coordinatorTaskId, now);
      }
      await reconcileGenericLlmTaskDependencies(db, now);
    }
  } catch (error) {
    if (!/no such table|no such column/i.test(String(error))) throw error;
  }

  const recoveryTask = await loadGenericLlmTask(db, sourceTask.taskId);
  if (!recoveryTask) throw new Error("generic WebQA recovery task disappeared after requeue");
  return { sourceTask, sourceRun, recoveryTask, recoveryTaskId: recoveryTask.taskId, gatewayTaskId, finalReportTaskId, coordinatorTaskId };
}

export async function loadGenericLlmRun(db: D1Database, runId: string): Promise<GenericLlmRun | null> {
  const id = requiredGeneric(runId, "runId");
  return normalizeGenericRun(await db.prepare(`select run_id as runId, task_id as taskId, attempt, provider, model,
    reasoning_effort as reasoningEffort, prompt_version as promptVersion, input_fingerprint as inputFingerprint, input_as_of as inputAsOf,
    input_json as inputJson, prompt_json as promptJson, lineage_run_id as lineageRunId, status, lease_owner as leaseOwner, lease_until as leaseUntil,
    heartbeat_at as heartbeatAt, current_step_key as currentStepKey, progress_json as progressJson, progress_updated_at as progressUpdatedAt,
    terminal_metadata_json as terminalMetadataJson, error_code as errorCode, error_message as errorMessage,
    started_at as startedAt, completed_at as completedAt, updated_at as updatedAt
    from llm_runs where run_id=?`).bind(id).first<Record<string, unknown>>());
}

export async function loadGenericLlmRunArtifacts(db: D1Database, runId: string): Promise<GenericLlmArtifact[]> {
  const id = requiredGeneric(runId, "runId");
  const rows = await db.prepare(`select artifact_id as artifactId, run_id as runId, step_key as stepKey,
    stage_version as stageVersion, input_fingerprint as inputFingerprint,
    upstream_artifact_ids_json as upstreamArtifactIdsJson, source_ids_json as sourceIdsJson,
    claim_ids_json as claimIdsJson, evidence_ids_json as evidenceIdsJson, unknown_ids_json as unknownIdsJson,
    output_type as outputType, status, output_json as outputJson,
    output_markdown as outputMarkdown, structure_valid as structureValid, blocked_json as blockedJson,
    error_code as errorCode, error_message as errorMessage, terminal_metadata_json as terminalMetadataJson,
    projection_version as projectionVersion, completed_at as completedAt
    from llm_run_artifacts where run_id=? order by completed_at, step_key`).bind(id).all<Record<string, unknown>>();
  let linkedRows: { results: Record<string, unknown>[] } = { results: [] };
  try {
    linkedRows = await db.prepare(`select a.artifact_id as artifactId, ? as runId, source_run.run_id as sourceRunId, 1 as reused, a.step_key as stepKey,
      a.stage_version as stageVersion, a.input_fingerprint as inputFingerprint,
      a.upstream_artifact_ids_json as upstreamArtifactIdsJson, a.source_ids_json as sourceIdsJson,
      a.claim_ids_json as claimIdsJson, a.evidence_ids_json as evidenceIdsJson, a.unknown_ids_json as unknownIdsJson,
      a.output_type as outputType, a.status, a.output_json as outputJson,
      a.output_markdown as outputMarkdown, a.structure_valid as structureValid, a.blocked_json as blockedJson,
      a.error_code as errorCode, a.error_message as errorMessage, a.terminal_metadata_json as terminalMetadataJson,
      a.projection_version as projectionVersion, a.completed_at as completedAt
      from llm_run_artifact_links l
      join llm_run_artifacts a on a.artifact_id=l.artifact_id
      join llm_runs source_run on source_run.run_id=a.run_id
      join llm_runs owner_run on owner_run.run_id=l.run_id and owner_run.task_id=source_run.task_id
      where l.run_id=? order by a.completed_at, a.step_key`).bind(id, id).all<Record<string, unknown>>();
  } catch (error) {
    if (!/no such table/i.test(String(error))) throw error;
  }
  const byArtifact = new Map<string, Record<string, unknown>>();
  for (const row of [...rows.results, ...linkedRows.results]) {
    const artifactId = textGeneric(row.artifactId);
    if (artifactId && !byArtifact.has(artifactId)) byArtifact.set(artifactId, row);
  }
  return [...byArtifact.values()].sort((left, right) => Number(left.completedAt || 0) - Number(right.completedAt || 0) || textGeneric(left.stepKey).localeCompare(textGeneric(right.stepKey))).map(normalizeGenericArtifact);
}

/** Claim the next task from the universal priority/FIFO queue. */
export async function claimNextGenericLlmTaskRun(db: D1Database, runnerInstanceId: string, options: GenericLlmTaskClaimOptions = {}): Promise<GenericLlmTaskRunClaim | null> {
  return claimGenericLlmTaskRunInternal(db, runnerInstanceId, { ...options, executionMode: options.executionMode || "model", globalQueue: true });
}

/**
 * Claim the next task from the universal queue without filtering by execution
 * mode.  The dispatcher uses this entrypoint so deterministic engineering
 * stages participate in the same priority/FIFO ordering as model work while
 * still bypassing provider-slot reservation in the claim transaction.
 */
export async function claimNextGenericLlmQueueTaskRun(db: D1Database, runnerInstanceId: string, options: GenericLlmTaskClaimOptions = {}): Promise<GenericLlmTaskRunClaim | null> {
  return claimGenericLlmTaskRunInternal(db, runnerInstanceId, { ...options, globalQueue: true });
}

/** Claim the next deterministic engineering task without a provider lease. */
export async function claimNextGenericEngineeringTaskRun(db: D1Database, runnerInstanceId: string, options: GenericLlmTaskClaimOptions = {}): Promise<GenericLlmTaskRunClaim | null> {
  return claimGenericLlmTaskRunInternal(db, runnerInstanceId, { ...options, executionMode: "engineering", globalQueue: true });
}

/**
 * Claim one queued generic task and create its fenced run attempt. Existing
 * table-specific callers continue to use their own claim functions; this API
 * remains the compatibility path until each producer is migrated.
 */
export async function claimGenericLlmTaskRun(db: D1Database, runnerInstanceId: string, options: GenericLlmTaskClaimOptions = {}): Promise<GenericLlmTaskRunClaim | null> {
  return claimGenericLlmTaskRunInternal(db, runnerInstanceId, options);
}

async function claimGenericLlmTaskRunInternal(db: D1Database, runnerInstanceId: string, options: GenericLlmTaskClaimOptions = {}): Promise<GenericLlmTaskRunClaim | null> {
  const runner = requiredGeneric(runnerInstanceId, "runnerInstanceId");
  const now = finiteTimestamp(options.now) ?? Date.now();
  await reconcileLocalJobProviderSlots(db, now);
  await requeueExpiredGenericLlmTaskRuns(db, now);
  const globalQueue = options.globalQueue === true;
  if (globalQueue) await reconcileGenericLlmTaskDependencies(db, now);
  const taskType = nullableGeneric(options.taskType);
  const excludeHandlerKeys = Array.isArray(options.excludeHandlerKeys)
    ? [...new Set(options.excludeHandlerKeys.map((value) => nullableGeneric(value)).filter((value): value is string => Boolean(value)))]
    : [];
  const protocolVersion = nullableGeneric(options.protocolVersion);
  const promptVersion = nullableGeneric(options.promptVersion);
  const requestedExecutionMode = options.executionMode ? normalizeGenericLlmExecutionMode(options.executionMode) : null;
  const claimConditions = ["status='queued'"];
  const claimBindings: unknown[] = [];
  if (globalQueue) {
    claimConditions.push("(ready_at is null or ready_at<=?)");
    claimBindings.push(now);
    claimConditions.push(`not exists (
      select 1 from llm_task_dependencies d
      join llm_tasks dependency on dependency.task_id=d.depends_on_task_id
      where d.task_id=llm_tasks.task_id and dependency.status<>'completed'
    )`);
  } else if (taskType) {
    claimConditions.push("task_type=?");
    claimBindings.push(taskType);
  }
  if (globalQueue && requestedExecutionMode) { claimConditions.push("execution_mode=?"); claimBindings.push(requestedExecutionMode); }
  if (globalQueue && excludeHandlerKeys.length) {
    claimConditions.push(`handler_key not in (${excludeHandlerKeys.map(() => "?").join(",")})`);
    claimBindings.push(...excludeHandlerKeys);
  }
  if (protocolVersion) { claimConditions.push("protocol_version=?"); claimBindings.push(protocolVersion); }
  if (promptVersion) { claimConditions.push("prompt_version=?"); claimBindings.push(promptVersion); }
  if (!globalQueue && requestedExecutionMode) { claimConditions.push("execution_mode=?"); claimBindings.push(requestedExecutionMode); }
  const globalSelect = `select task_id as taskId, task_type as taskType, target_type as targetType, target_id as targetId,
    idempotency_key as idempotencyKey, protocol_version as protocolVersion, prompt_version as promptVersion,
    status, requested_model as requestedModel, requested_reasoning_effort as requestedReasoningEffort,
    metadata_json as metadataJson, last_run_id as lastRunId, last_error_code as lastErrorCode,
    last_error_message as lastErrorMessage, priority, queue_sequence as queueSequence, handler_key as handlerKey,
    execution_mode as executionMode, parent_task_id as parentTaskId, stage_key as stageKey, ready_at as readyAt,
    created_at as createdAt, started_at as startedAt, completed_at as completedAt, updated_at as updatedAt
    from llm_tasks where ${claimConditions.join(" and ")}
    order by priority desc, queue_sequence asc, created_at asc, task_id asc limit 1`;
  const legacyConditions = ["status='queued'", ...(!globalQueue && taskType ? ["task_type=?"] : []), ...(protocolVersion ? ["protocol_version=?"] : []), ...(promptVersion ? ["prompt_version=?"] : []), ...(!globalQueue && requestedExecutionMode ? ["execution_mode=?"] : [])];
  const legacySelect = `select task_id as taskId, task_type as taskType, target_type as targetType, target_id as targetId,
    idempotency_key as idempotencyKey, protocol_version as protocolVersion, prompt_version as promptVersion,
    requested_model as requestedModel, requested_reasoning_effort as requestedReasoningEffort
    from llm_tasks where ${legacyConditions.join(" and ")}
    order by created_at, task_id limit 1`;
  const legacySelectWithoutExecutionMode = `select task_id as taskId, task_type as taskType, target_type as targetType, target_id as targetId,
    idempotency_key as idempotencyKey, protocol_version as protocolVersion, prompt_version as promptVersion,
    requested_model as requestedModel, requested_reasoning_effort as requestedReasoningEffort
    from llm_tasks where ${legacyConditions.filter((condition) => condition !== "execution_mode=?").join(" and ")}
    order by created_at, task_id limit 1`;
  let candidate: Record<string, unknown> | null;
  try {
    candidate = await db.prepare(globalQueue ? globalSelect : legacySelect).bind(...claimBindings).first<Record<string, unknown>>();
  } catch (error) {
    if (!/no such column|no such table/i.test(String(error))) throw error;
    // A pre-0110 database can continue on the compatibility claim path. The
    // universal dispatcher is only ordered once the additive schema exists.
    const legacyBindings: unknown[] = [];
    if (!globalQueue && taskType) legacyBindings.push(taskType);
    if (protocolVersion) legacyBindings.push(protocolVersion);
    if (promptVersion) legacyBindings.push(promptVersion);
    const fallbackSelect = globalQueue || requestedExecutionMode ? legacySelectWithoutExecutionMode : legacySelect;
    candidate = await db.prepare(fallbackSelect).bind(...legacyBindings).first<Record<string, unknown>>();
  }
  if (!candidate) return null;
  const taskId = requiredGeneric(candidate.taskId, "taskId");
  const attemptRow = await db.prepare("select coalesce(max(attempt), 0) + 1 as nextAttempt from llm_runs where task_id=?").bind(taskId).first<{ nextAttempt: number }>();
  const attempt = Number(attemptRow?.nextAttempt);
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error("invalid generic LLM task attempt");
  const executionMode = normalizeGenericLlmExecutionMode(candidate.executionMode);
  const provider = requiredGeneric(options.provider || (executionMode === "engineering" ? GENERIC_LLM_ENGINEERING_PROVIDER : LOCAL_JOB_PROVIDER_ID), "provider");
  const model = requiredGeneric(options.model || textGeneric(candidate.requestedModel) || (executionMode === "engineering" ? GENERIC_LLM_ENGINEERING_MODEL : ""), "model");
  const reasoningEffort = nullableGeneric(options.reasoningEffort ?? candidate.requestedReasoningEffort);
  const providerLeaseRequired = executionMode === "model";
  const reserved = providerLeaseRequired
    ? globalQueue
      ? await reserveLocalJobProviderSlot(db, taskId, "llm_run", attempt, runner, now, GENERIC_LLM_GLOBAL_MODEL_CONCURRENCY)
      : await reserveLocalJobProviderSlot(db, taskId, "llm_run", attempt, runner, now)
    : await reserveGenericEngineeringSlot();
  if (!reserved) {
    // A saturated model slot must not starve deterministic engineering work
    // later in the same global queue. Retry the exact queue predicate with an
    // explicit engineering mode; no provider lease is needed on that path.
    if (globalQueue && !requestedExecutionMode && executionMode === "model") {
      return claimGenericLlmTaskRunInternal(db, runner, { ...options, executionMode: "engineering", globalQueue: true, now });
    }
    return null;
  }
  const runId = `llm-run:${crypto.randomUUID()}`;
  const lineageRunId = await nearestGenericLlmRunId(db, taskId);
  const inputJson = serializeGenericJson(options.input, "input");
  const promptJson = serializeGenericJson(options.prompt, "prompt");
  try {
    const taskUpdate = await db.prepare(`update llm_tasks set status='running', last_run_id=?, last_error_code=null, last_error_message=null,
      started_at=coalesce(started_at, ?), completed_at=null, updated_at=? where task_id=? and status='queued'`)
      .bind(runId, now, now, taskId).run();
    if (!taskUpdate.meta.changes) {
      if (providerLeaseRequired) await releaseLocalJobProviderSlot(db, taskId, attempt, runner, now);
      return null;
    }
    const runInsert = await db.prepare(`insert into llm_runs (
      run_id, task_id, attempt, provider, model, reasoning_effort, prompt_version, input_fingerprint, input_as_of,
      input_json, prompt_json, lineage_run_id, status, lease_owner, lease_until, heartbeat_at, started_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`)
      .bind(runId, taskId, attempt, provider, model, reasoningEffort, textGeneric(candidate.promptVersion),
        nullableGeneric(options.inputFingerprint), finiteTimestamp(options.inputAsOf), inputJson, promptJson, lineageRunId,
        runner, localJobLeaseUntil(now), now, now, now).run();
    if (!runInsert.meta.changes) throw new Error("generic LLM run was not created");
    const task = await loadGenericLlmTask(db, taskId);
    const run = await loadGenericLlmRun(db, runId);
    if (!task || !run) throw new Error("generic LLM run was created but cannot be reloaded");
    return { task, run };
  } catch (error) {
    if (providerLeaseRequired) await releaseLocalJobProviderSlot(db, taskId, attempt, runner, now);
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

/** Persist the active run's artifact projection. The 0107 schema has one row
 * per (run, step), so partial stream updates upsert that row and the terminal
 * result replaces the final partial projection. */
export async function writeGenericLlmRunArtifact(db: D1Database, input: GenericLlmArtifactInput & { runId: string; taskId: string; attempt: number; leaseOwner: string }): Promise<GenericLlmArtifact> {
  const runId = requiredGeneric(input.runId, "runId");
  const taskId = requiredGeneric(input.taskId, "taskId");
  const leaseOwner = requiredGeneric(input.leaseOwner, "leaseOwner");
  const stepKey = requiredGeneric(input.stepKey, "stepKey");
  const now = finiteTimestamp(input.completedAt) ?? Date.now();
  assertGenericArtifactStatus(input.status);
  assertGenericOutputType(input.outputType);
  const stageVersion = nullableGeneric(input.stageVersion);
  const inputFingerprint = nullableGeneric(input.inputFingerprint);
  const upstreamArtifactIds = normalizeGenericLlmIdArray(input.upstreamArtifactIds, "upstreamArtifactIds");
  const sourceIds = normalizeGenericLlmIdArray(input.sourceIds, "sourceIds");
  const claimIds = normalizeGenericLlmIdArray(input.claimIds, "claimIds");
  const evidenceIds = normalizeGenericLlmIdArray(input.evidenceIds, "evidenceIds");
  const unknownIds = normalizeGenericLlmIdArray(input.unknownIds, "unknownIds");
  const projectionVersion = nullableGeneric(input.projectionVersion);
  const outputJson = input.outputType === "json" ? serializeGenericJson(input.output, "output") : null;
  const outputMarkdown = input.outputType === "markdown" ? nullableGeneric(input.output) : null;
  if (input.outputType === "json" && input.status === "complete" && (input.output === undefined || input.output === null)) throw new Error("complete JSON artifact requires output");
  if (input.outputType === "markdown" && input.status === "complete" && !outputMarkdown) throw new Error("complete Markdown artifact requires output");
  const active = await db.prepare(`select run_id as runId from llm_runs where run_id=? and task_id=? and status='running'
    and attempt=? and lease_owner=? and lease_until>=?`).bind(runId, taskId, input.attempt, leaseOwner, now).first();
  if (!active) throw new Error("generic LLM run lease is no longer owned by this runner");
  const artifactId = `llm-artifact:${crypto.randomUUID()}`;
  const values = [artifactId, runId, stepKey, stageVersion, inputFingerprint, JSON.stringify(upstreamArtifactIds), JSON.stringify(sourceIds), JSON.stringify(claimIds), JSON.stringify(evidenceIds), JSON.stringify(unknownIds), input.outputType, input.status,
    outputJson, outputMarkdown, input.structureValid === null || input.structureValid === undefined ? null : input.structureValid ? 1 : 0,
    serializeGenericJson(input.blocked, "blocked"), nullableGeneric(input.errorCode), nullableGeneric(input.errorMessage),
    serializeGenericJson(input.terminalMetadata, "terminalMetadata"), projectionVersion, now] as const;
  const changed = await db.prepare(`insert into llm_run_artifacts (
    artifact_id, run_id, step_key, stage_version, input_fingerprint, upstream_artifact_ids_json,
    source_ids_json, claim_ids_json, evidence_ids_json, unknown_ids_json, output_type, status,
    output_json, output_markdown, structure_valid, blocked_json, error_code, error_message,
    terminal_metadata_json, projection_version, completed_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(run_id, step_key) do update set stage_version=excluded.stage_version,
      input_fingerprint=excluded.input_fingerprint, upstream_artifact_ids_json=excluded.upstream_artifact_ids_json,
      source_ids_json=excluded.source_ids_json, claim_ids_json=excluded.claim_ids_json,
      evidence_ids_json=excluded.evidence_ids_json, unknown_ids_json=excluded.unknown_ids_json,
      output_type=excluded.output_type, status=excluded.status, output_json=excluded.output_json,
      output_markdown=excluded.output_markdown, structure_valid=excluded.structure_valid,
      blocked_json=excluded.blocked_json, error_code=excluded.error_code, error_message=excluded.error_message,
      terminal_metadata_json=excluded.terminal_metadata_json, projection_version=excluded.projection_version,
      completed_at=excluded.completed_at`)
    .bind(...values).run();
  if (!changed.meta.changes) throw new Error("generic LLM artifact was not persisted");
  await db.prepare("update llm_runs set updated_at=? where run_id=? and status='running' and attempt=? and lease_owner=?")
    .bind(now, runId, input.attempt, leaseOwner).run();
  const artifact = await db.prepare(`select artifact_id as artifactId, run_id as runId, step_key as stepKey,
    stage_version as stageVersion, input_fingerprint as inputFingerprint,
    upstream_artifact_ids_json as upstreamArtifactIdsJson, source_ids_json as sourceIdsJson,
    claim_ids_json as claimIdsJson, evidence_ids_json as evidenceIdsJson, unknown_ids_json as unknownIdsJson,
    output_type as outputType, status, output_json as outputJson,
    output_markdown as outputMarkdown, structure_valid as structureValid, blocked_json as blockedJson,
    error_code as errorCode, error_message as errorMessage, terminal_metadata_json as terminalMetadataJson,
    projection_version as projectionVersion, completed_at as completedAt
    from llm_run_artifacts where run_id=? and step_key=?`).bind(runId, stepKey).first<Record<string, unknown>>();
  if (!artifact) throw new Error("generic LLM terminal artifact was inserted but cannot be reloaded");
  return normalizeGenericArtifact(artifact);
}

/**
 * Link one compatible terminal artifact from the nearest prior run into the
 * active recovery run.  The artifact row is never copied or rewritten: its
 * UUID and upstream lineage stay stable and the link table records the new
 * run's ownership.  Compatibility is deliberately exact so a changed input,
 * stage schema, projection, or upstream artifact invalidates that stage and
 * lets the dependency wave recompute only the affected descendants.
 */
export async function reuseCompatibleGenericLlmRunArtifact(db: D1Database, input: GenericLlmArtifactCompatibilityInput): Promise<GenericLlmArtifact | null> {
  const runId = requiredGeneric(input.runId, "runId");
  const taskId = requiredGeneric(input.taskId, "taskId");
  const runner = requiredGeneric(input.leaseOwner, "leaseOwner");
  const stepKey = requiredGeneric(input.stepKey, "stepKey");
  const stageVersion = requiredGeneric(input.stageVersion, "stageVersion");
  const projectionVersion = requiredGeneric(input.projectionVersion, "projectionVersion");
  const now = finiteTimestamp(input.now) ?? Date.now();
  const upstreamArtifactIds = normalizeGenericLlmIdArray(input.upstreamArtifactIds, "upstreamArtifactIds").sort();
  const inputFingerprint = nullableGeneric(input.inputFingerprint);
  const active = await db.prepare(`select run_id as runId from llm_runs
    where run_id=? and task_id=? and status='running' and attempt=? and lease_owner=? and lease_until>=?`)
    .bind(runId, taskId, input.attempt, runner, now).first();
  if (!active) throw new Error("generic LLM run lease is no longer owned by this runner");

  const current = (await loadGenericLlmRunArtifacts(db, runId)).find((artifact) => artifact.stepKey === stepKey);
  if (current && ["complete", "not_applicable"].includes(current.status)) return current;

  // A null fingerprint is intentionally not reusable.  It means the caller
  // failed to establish the deterministic input boundary for this stage.
  if (!inputFingerprint) return null;
  let candidate: Record<string, unknown> | null = null;
  try {
    candidate = await db.prepare(`select candidateArtifactId as artifactId, candidateSourceRunId as sourceRunId, candidateSourceRunId as runId, candidateStepKey as stepKey,
      candidateStageVersion as stageVersion, candidateInputFingerprint as inputFingerprint,
      candidateUpstreamIds as upstreamArtifactIdsJson, candidateSourceIds as sourceIdsJson,
      candidateClaimIds as claimIdsJson, candidateEvidenceIds as evidenceIdsJson, candidateUnknownIds as unknownIdsJson,
      candidateOutputType as outputType, candidateStatus as status, candidateOutputJson as outputJson,
      candidateOutputMarkdown as outputMarkdown, candidateStructureValid as structureValid, candidateBlockedJson as blockedJson,
      candidateErrorCode as errorCode, candidateErrorMessage as errorMessage, candidateTerminalMetadataJson as terminalMetadataJson,
      candidateProjectionVersion as projectionVersion, candidateCompletedAt as completedAt
      from (
        select r.attempt as candidateAttempt, r.run_id as candidateRunId, a.run_id as candidateSourceRunId, a.artifact_id as candidateArtifactId, a.step_key as candidateStepKey,
          a.stage_version as candidateStageVersion, a.input_fingerprint as candidateInputFingerprint, a.upstream_artifact_ids_json as candidateUpstreamIds,
          a.source_ids_json as candidateSourceIds, a.claim_ids_json as candidateClaimIds, a.evidence_ids_json as candidateEvidenceIds,
          a.unknown_ids_json as candidateUnknownIds, a.output_type as candidateOutputType, a.status as candidateStatus,
          a.output_json as candidateOutputJson, a.output_markdown as candidateOutputMarkdown, a.structure_valid as candidateStructureValid,
          a.blocked_json as candidateBlockedJson, a.error_code as candidateErrorCode, a.error_message as candidateErrorMessage,
          a.terminal_metadata_json as candidateTerminalMetadataJson, a.projection_version as candidateProjectionVersion, a.completed_at as candidateCompletedAt
          from llm_runs r join llm_run_artifacts a on a.run_id=r.run_id
          where r.task_id=? and r.run_id<>? and r.attempt<? and r.status in ('completed','failed','blocked')
        union all
        select r.attempt as candidateAttempt, r.run_id as candidateRunId, a.run_id as candidateSourceRunId, a.artifact_id as candidateArtifactId, a.step_key as candidateStepKey,
          a.stage_version as candidateStageVersion, a.input_fingerprint as candidateInputFingerprint, a.upstream_artifact_ids_json as candidateUpstreamIds,
          a.source_ids_json as candidateSourceIds, a.claim_ids_json as candidateClaimIds, a.evidence_ids_json as candidateEvidenceIds,
          a.unknown_ids_json as candidateUnknownIds, a.output_type as candidateOutputType, a.status as candidateStatus,
          a.output_json as candidateOutputJson, a.output_markdown as candidateOutputMarkdown, a.structure_valid as candidateStructureValid,
          a.blocked_json as candidateBlockedJson, a.error_code as candidateErrorCode, a.error_message as candidateErrorMessage,
          a.terminal_metadata_json as candidateTerminalMetadataJson, a.projection_version as candidateProjectionVersion, a.completed_at as candidateCompletedAt
          from llm_runs r
          join llm_run_artifact_links l on l.run_id=r.run_id
          join llm_run_artifacts a on a.artifact_id=l.artifact_id
          join llm_runs source_run on source_run.run_id=a.run_id and source_run.task_id=r.task_id
          where r.task_id=? and r.run_id<>? and r.attempt<? and r.status in ('completed','failed','blocked')
      ) candidates
      where candidateStepKey=? and candidateStatus in ('complete','not_applicable')
        and candidateStageVersion=? and candidateInputFingerprint=?
        and candidateUpstreamIds=? and candidateProjectionVersion=?
      order by candidateAttempt desc, candidateCompletedAt desc limit 1`)
      .bind(taskId, runId, input.attempt, taskId, runId, input.attempt, stepKey, stageVersion, inputFingerprint, JSON.stringify(upstreamArtifactIds), projectionVersion)
      .first<Record<string, unknown>>();
  } catch (error) {
    if (/no such table/i.test(String(error))) return null;
    throw error;
  }
  if (!candidate) return null;
  const sourceRunId = requiredGeneric(candidate.sourceRunId, "sourceRunId");
  const candidateArtifact = normalizeGenericArtifact({ ...candidate, runId: sourceRunId });
  if (!genericArtifactCompatibilityMatches(candidateArtifact, { stageVersion, inputFingerprint, upstreamArtifactIds, projectionVersion })) return null;
  const linked = await db.prepare(`insert or ignore into llm_run_artifact_links
    (run_id, artifact_id, source_run_id, step_key, stage_version, input_fingerprint, upstream_artifact_ids_json, projection_version, linked_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(runId, requiredGeneric(candidate.artifactId, "artifactId"), sourceRunId, stepKey, stageVersion, inputFingerprint, JSON.stringify(upstreamArtifactIds), projectionVersion, now).run();
  if (!linked.meta.changes) {
    const existing = (await loadGenericLlmRunArtifacts(db, runId)).find((artifact) => artifact.stepKey === stepKey);
    if (existing && ["complete", "not_applicable"].includes(existing.status)) return existing;
    return null;
  }
  return normalizeGenericArtifact({ ...candidate, runId, sourceRunId, reused: 1 });
}

export async function completeGenericLlmRun(db: D1Database, input: GenericLlmRunTerminalInput): Promise<{ task: GenericLlmTask; run: GenericLlmRun; artifacts: GenericLlmArtifact[] }> {
  const runId = requiredGeneric(input.runId, "runId");
  const taskId = requiredGeneric(input.taskId, "taskId");
  const runner = requiredGeneric(input.leaseOwner, "leaseOwner");
  const now = finiteTimestamp(input.completedAt) ?? Date.now();
  const errorCode = nullableGeneric(input.errorCode);
  const errorMessage = nullableGeneric(input.errorMessage);
  const metadataJson = serializeGenericJson(input.terminalMetadata, "terminalMetadata");
  const executionMode = await loadGenericLlmExecutionMode(db, taskId);
  if (executionMode === "model") {
    const active = await db.prepare(`select job_id as jobId from local_job_provider_leases where provider_id=? and job_id=? and job_type='llm_run' and attempt=? and lease_owner=?`)
      .bind(LOCAL_JOB_PROVIDER_ID, taskId, input.attempt, runner).first<Record<string, unknown>>();
    if (!active) throw new Error("generic LLM provider lease is no longer owned by this runner");
  }
  const runUpdate = await db.prepare(`update llm_runs set status=?, terminal_metadata_json=?, error_code=?, error_message=?, completed_at=?, updated_at=?, lease_until=null
    where run_id=? and task_id=? and status='running' and attempt=? and lease_owner=? and lease_until>=?`)
    .bind(input.status, metadataJson, errorCode, errorMessage, now, now, runId, taskId, input.attempt, runner, now).run();
  if (!runUpdate.meta.changes) throw new Error("generic LLM run lease is no longer owned by this runner");
  const taskStatus: GenericLlmTaskStatus = input.status === "blocked" ? "blocked" : input.status;
  const taskUpdate = await db.prepare(`update llm_tasks set status=?, last_error_code=?, last_error_message=?, completed_at=?, updated_at=?
    where task_id=? and status='running' and last_run_id=?`).bind(taskStatus, errorCode, errorMessage, now, now, taskId, runId).run();
  if (!taskUpdate.meta.changes) throw new Error("generic LLM task was no longer running when run completed");
  if (executionMode === "model") await releaseLocalJobProviderSlot(db, taskId, input.attempt, runner, now);
  // Completing one task should immediately unlock (or visibly block) queued
  // downstream tasks; this is derived from terminal status and dependency rows.
  await reconcileGenericLlmTaskDependencies(db, now);
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
    if (taskUpdate.meta.changes) {
      count += 1;
      const sourceTask = await loadGenericLlmTask(db, taskId);
      const sourceRun = await loadGenericLlmRun(db, runId);
      if (sourceTask && sourceRun) await persistGenericWebQaRecoveryMetadata(db, sourceTask, sourceRun, now);
    }
    if (await loadGenericLlmExecutionMode(db, taskId) === "model") await releaseLocalJobProviderSlot(db, taskId, attempt, owner, now);
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
  if (taskUpdate.meta.changes) {
    const sourceTask = await loadGenericLlmTask(db, taskId);
    const sourceRun = await loadGenericLlmRun(db, runId);
    if (sourceTask && sourceRun) await persistGenericWebQaRecoveryMetadata(db, sourceTask, sourceRun, now);
  }
  if (await loadGenericLlmExecutionMode(db, taskId) === "model") await releaseLocalJobProviderSlot(db, taskId, attempt, leaseOwner, now);
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
  const bindings = [identity.taskType, identity.targetType, identity.targetId, identity.idempotencyKey, identity.protocolVersion, identity.promptVersion];
  try {
    return normalizeGenericTask(await db.prepare(`select task_id as taskId, task_type as taskType, target_type as targetType, target_id as targetId,
      idempotency_key as idempotencyKey, protocol_version as protocolVersion, prompt_version as promptVersion, status,
      requested_model as requestedModel, requested_reasoning_effort as requestedReasoningEffort, last_run_id as lastRunId,
      metadata_json as metadataJson, last_error_code as lastErrorCode, last_error_message as lastErrorMessage,
      priority, queue_sequence as queueSequence, handler_key as handlerKey, execution_mode as executionMode,
      parent_task_id as parentTaskId, stage_key as stageKey, ready_at as readyAt,
      created_at as createdAt, started_at as startedAt, completed_at as completedAt, updated_at as updatedAt
      from llm_tasks where task_type=? and target_type=? and target_id=? and idempotency_key=? and protocol_version=? and prompt_version=?`)
      .bind(...bindings).first<Record<string, unknown>>());
  } catch (error) {
    if (!/no such column/i.test(String(error))) throw error;
    return normalizeGenericTask(await db.prepare(`select task_id as taskId, task_type as taskType, target_type as targetType, target_id as targetId,
      idempotency_key as idempotencyKey, protocol_version as protocolVersion, prompt_version as promptVersion, status,
      requested_model as requestedModel, requested_reasoning_effort as requestedReasoningEffort, last_run_id as lastRunId,
      metadata_json as metadataJson, last_error_code as lastErrorCode, last_error_message as lastErrorMessage,
      created_at as createdAt, started_at as startedAt, completed_at as completedAt, updated_at as updatedAt
      from llm_tasks where task_type=? and target_type=? and target_id=? and idempotency_key=? and protocol_version=? and prompt_version=?`)
      .bind(...bindings).first<Record<string, unknown>>());
  }
}

function normalizeGenericTask(row: Record<string, unknown> | null): GenericLlmTask | null {
  if (!row) return null;
  const status = textGeneric(row.status) as GenericLlmTaskStatus;
  if (!["queued", "running", "completed", "failed", "blocked"].includes(status)) throw new Error("invalid generic LLM task status");
  const taskType = requiredGeneric(row.taskType, "taskType");
  const queueSequence = Number(row.queueSequence);
  const normalizedQueueSequence = Number.isInteger(queueSequence) && queueSequence >= 0 ? queueSequence : 0;
  return {
    taskId: requiredGeneric(row.taskId, "taskId"), taskType, targetType: requiredGeneric(row.targetType, "targetType"), targetId: requiredGeneric(row.targetId, "targetId"),
    idempotencyKey: requiredGeneric(row.idempotencyKey, "idempotencyKey"), protocolVersion: requiredGeneric(row.protocolVersion, "protocolVersion"), promptVersion: requiredGeneric(row.promptVersion, "promptVersion"), status,
    requestedModel: nullableGeneric(row.requestedModel), requestedReasoningEffort: nullableGeneric(row.requestedReasoningEffort), lastRunId: nullableGeneric(row.lastRunId), metadata: parseGenericJson(row.metadataJson),
    priority: normalizeGenericLlmPriority(row.priority), queueSequence: normalizedQueueSequence,
    handlerKey: textGeneric(row.handlerKey) || taskType,
    executionMode: normalizeGenericLlmExecutionMode(row.executionMode),
    parentTaskId: nullableGeneric(row.parentTaskId), stageKey: nullableGeneric(row.stageKey), readyAt: finiteTimestamp(row.readyAt),
    lastErrorCode: nullableGeneric(row.lastErrorCode), lastErrorMessage: nullableGeneric(row.lastErrorMessage), createdAt: finiteTimestamp(row.createdAt) ?? 0, startedAt: finiteTimestamp(row.startedAt), completedAt: finiteTimestamp(row.completedAt), updatedAt: finiteTimestamp(row.updatedAt) ?? 0,
  };
}

function normalizeGenericRun(row: Record<string, unknown> | null): GenericLlmRun | null {
  if (!row) return null;
  const status = textGeneric(row.status) as GenericLlmRunStatus;
  if (!["running", "completed", "failed", "blocked"].includes(status)) throw new Error("invalid generic LLM run status");
  return {
    runId: requiredGeneric(row.runId, "runId"), taskId: requiredGeneric(row.taskId, "taskId"), attempt: Number(row.attempt), provider: requiredGeneric(row.provider, "provider"), model: requiredGeneric(row.model, "model"),
    reasoningEffort: nullableGeneric(row.reasoningEffort), promptVersion: requiredGeneric(row.promptVersion, "promptVersion"), inputFingerprint: nullableGeneric(row.inputFingerprint), inputAsOf: finiteTimestamp(row.inputAsOf), input: parseGenericJson(row.inputJson), prompt: parseGenericJson(row.promptJson), lineageRunId: nullableGeneric(row.lineageRunId), status,
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
  const upstreamArtifactIds = parseGenericIdArray(row.upstreamArtifactIdsJson, "upstreamArtifactIds");
  const sourceIds = parseGenericIdArray(row.sourceIdsJson, "sourceIds");
  const claimIds = parseGenericIdArray(row.claimIdsJson, "claimIds");
  const evidenceIds = parseGenericIdArray(row.evidenceIdsJson, "evidenceIds");
  const unknownIds = parseGenericIdArray(row.unknownIdsJson, "unknownIds");
  return {
    artifactId: requiredGeneric(row.artifactId, "artifactId"), runId: requiredGeneric(row.runId, "runId"), stepKey: requiredGeneric(row.stepKey, "stepKey"), stageVersion: nullableGeneric(row.stageVersion), inputFingerprint: nullableGeneric(row.inputFingerprint), upstreamArtifactIds, sourceIds, claimIds, evidenceIds, unknownIds, outputType, status, output,
    structureValid: structure, blocked: parseGenericJson(row.blockedJson), errorCode: nullableGeneric(row.errorCode), errorMessage: nullableGeneric(row.errorMessage), terminalMetadata: parseGenericJson(row.terminalMetadataJson), projectionVersion: nullableGeneric(row.projectionVersion), completedAt: finiteTimestamp(row.completedAt) ?? 0,
    ...(nullableGeneric(row.sourceRunId) ? { sourceRunId: nullableGeneric(row.sourceRunId), reused: Boolean(row.reused) } : {}),
  };
}

function assertGenericArtifactStatus(value: string): asserts value is GenericLlmArtifactStatus {
  if (!["complete", "partial", "blocked", "not_applicable", "failed"].includes(value)) throw new Error("invalid generic LLM artifact terminal status");
}

function assertGenericOutputType(value: string): asserts value is GenericLlmOutputType {
  if (!["json", "markdown"].includes(value)) throw new Error("invalid generic LLM artifact output type");
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

/**
 * Normalize lineage IDs without silently dropping malformed references.  An
 * omitted field (or a legacy row predating 0108) is the safe empty default;
 * once a caller supplies an array, every member must be a named, unique ID.
 */
export function normalizeGenericLlmIdArray(value: unknown, name = "lineageIds"): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`generic LLM ${name} must be an array of IDs`);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") throw new Error(`generic LLM ${name} contains a non-string ID`);
    const id = item.trim();
    if (!id || /^\d+$/.test(id) || /\s/.test(id)) throw new Error(`generic LLM ${name} contains an invalid ID`);
    if (seen.has(id)) throw new Error(`generic LLM ${name} contains a duplicate ID: ${id}`);
    seen.add(id);
    result.push(id);
  }
  return result;
}

/** Pure contract predicate used by recovery tests and by callers that need to
 * explain why an artifact was invalidated without touching the database. */
export function genericArtifactCompatibilityMatches(artifact: Pick<GenericLlmArtifact, "status" | "stageVersion" | "inputFingerprint" | "upstreamArtifactIds" | "projectionVersion">, expected: Pick<GenericLlmArtifactCompatibilityInput, "stageVersion" | "inputFingerprint" | "upstreamArtifactIds" | "projectionVersion">): boolean {
  if (!["complete", "not_applicable"].includes(artifact.status)) return false;
  if (artifact.stageVersion !== expected.stageVersion || artifact.inputFingerprint !== expected.inputFingerprint || artifact.projectionVersion !== expected.projectionVersion) return false;
  const actualIds = normalizeGenericLlmIdArray(artifact.upstreamArtifactIds, "upstreamArtifactIds").sort();
  const expectedIds = normalizeGenericLlmIdArray(expected.upstreamArtifactIds, "upstreamArtifactIds").sort();
  return actualIds.length === expectedIds.length && actualIds.every((id, index) => id === expectedIds[index]);
}

function parseGenericIdArray(value: unknown, name: string): string[] {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value !== "string") return normalizeGenericLlmIdArray(value, name);
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error(`generic LLM ${name} JSON is invalid`); }
  return normalizeGenericLlmIdArray(parsed, name);
}

async function nearestGenericLlmRunId(db: D1Database, taskId: string): Promise<string | null> {
  const previous = await db.prepare(`select run_id as runId from llm_runs
    where task_id=? order by attempt desc, updated_at desc limit 1`).bind(taskId).first<{ runId: string }>();
  return nullableGeneric(previous?.runId);
}

async function loadGenericLlmExecutionMode(db: D1Database, taskId: string): Promise<GenericLlmExecutionMode> {
  try {
    const row = await db.prepare("select execution_mode as executionMode from llm_tasks where task_id=?")
      .bind(taskId).first<Record<string, unknown>>();
    return normalizeGenericLlmExecutionMode(row?.executionMode);
  } catch (error) {
    if (/no such column/i.test(String(error))) return "model";
    throw error;
  }
}

async function hasGenericLlmProtocol(db: D1Database): Promise<boolean> {
  try {
    const row = await db.prepare(`select count(*) as count from sqlite_master where type='table' and name in ('llm_tasks','llm_runs','llm_run_artifacts')`).first<{ count: number }>();
    return Number(row?.count) === 3;
  } catch {
    return false;
  }
}
