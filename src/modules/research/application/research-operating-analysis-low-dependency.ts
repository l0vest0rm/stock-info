import {
  RESEARCH_OPERATING_ANALYSIS_TARGET_PROMPT_VERSION,
  RESEARCH_OPERATING_ANALYSIS_TARGET_PROTOCOL_VERSION,
  RESEARCH_OPERATING_ANALYSIS_TARGET_STAGES,
  RESEARCH_OPERATING_ANALYSIS_TARGET_TASK_TYPE,
  getResearchOperatingAnalysisStage,
  researchOperatingAnalysisDependencies,
  researchOperatingAnalysisTaskIdentity,
  terminalResearchOperatingAnalysisStatuses,
  type ResearchAnalysisStageDefinition,
  type ResearchAnalysisStageKey,
  type ResearchAnalysisStageStatus,
} from "./research-operating-analysis-stage-registry";
import {
  claimNextGenericLlmQueueTaskRun,
  addGenericLlmTaskDependencies,
  completeGenericLlmRun,
  createGenericLlmTask,
  failGenericLlmRun,
  heartbeatGenericLlmRun,
  loadGenericLlmRun,
  loadGenericLlmRunArtifacts,
  loadGenericLlmTask,
  loadGenericLlmChildTasks,
  loadGenericWorkflowArtifacts,
  loadGenericLlmTaskByIdentity,
  normalizeGenericLlmIdArray,
  recordGenericLlmRunProgress,
  reconcileGenericLlmTaskDependencies,
  requeueExpiredGenericLlmRun,
  requeueGenericLlmTask,
  linkGenericWorkflowArtifact,
  reuseCompatibleGenericLlmRunArtifact,
  writeGenericLlmRunArtifact,
  type GenericLlmArtifact,
  type GenericLlmRun,
  type GenericLlmTask,
} from "../../../shared/local-job-protocol";
import { ownsResearchOperatingAnalysisRunnerLease } from "./research-operating-analysis-runner-lease";

export const LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_PROMPT_VERSION = RESEARCH_OPERATING_ANALYSIS_TARGET_PROMPT_VERSION;
export const LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_TASK_TYPE = RESEARCH_OPERATING_ANALYSIS_TARGET_TASK_TYPE;
export const LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_PROTOCOL_VERSION = RESEARCH_OPERATING_ANALYSIS_TARGET_PROTOCOL_VERSION;
export const LOW_DEPENDENCY_COORDINATOR_HANDLER_KEY = "research_operating_analysis_low_dependency_coordinator";
export const LOW_DEPENDENCY_STAGE_HANDLER_KEY = "research_operating_analysis_low_dependency_stage";
export type LowDependencyResearchAnalysisStageKey = ResearchAnalysisStageKey;
export type LowDependencyResearchAnalysisStageStatus = ResearchAnalysisStageStatus | "queued" | "running";

type Row = Record<string, unknown>;
type ModelPrompt = { model?: string; instructions: string; userPrompt: string };
type Lineage = { upstreamArtifactIds?: unknown; sourceIds?: unknown; claimIds?: unknown; evidenceIds?: unknown; unknownIds?: unknown };

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const row = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const statuses = new Set<string>(terminalResearchOperatingAnalysisStatuses());
const LOW_DEPENDENCY_PROJECTION_VERSION = "research-artifact-projection.v1";

export function lowDependencyResearchOperatingAnalysisTaskIdentity(securityCode: string, idempotencyKey?: string) {
  return researchOperatingAnalysisTaskIdentity(securityCode, { idempotencyKey });
}

export function normalizeLowDependencyRerunStageKeys(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("low-dependency rerun stageKeys must be an array");
  const seen = new Set<string>();
  for (const item of value) {
    const key = text(item);
    if (!key) throw new Error("low-dependency rerun stageKeys contains an empty stage key");
    getResearchOperatingAnalysisStage(key);
    if (seen.has(key)) throw new Error(`low-dependency rerun stageKeys contains duplicate stage: ${key}`);
    seen.add(key);
  }
  return [...seen].sort();
}

/** Force refreshes invalidate every target stage, including both S0 routing stages. */
export function effectiveLowDependencyRefreshStageKeys(force: boolean, requestedStageKeys: unknown): string[] {
  if (force) return RESEARCH_OPERATING_ANALYSIS_TARGET_STAGES.map((stage) => stage.key);
  return normalizeLowDependencyRerunStageKeys(requestedStageKeys);
}

function lowDependencyRerunClosure(stageKeys: string[], scopeEnvelopeAvailable = true): string[] {
  const invalidated = new Set(stageKeys);
  let changed = true;
  while (changed) {
    changed = false;
    for (const definition of RESEARCH_OPERATING_ANALYSIS_TARGET_STAGES) {
      if (!invalidated.has(definition.key) && researchOperatingAnalysisDependencies(definition.key, { scopeEnvelopeAvailable }).some((dependency) => invalidated.has(dependency))) {
        invalidated.add(definition.key);
        changed = true;
      }
    }
  }
  return RESEARCH_OPERATING_ANALYSIS_TARGET_STAGES.map((definition) => definition.key).filter((key) => invalidated.has(key));
}

function taskIdentity(code: string) {
  return lowDependencyResearchOperatingAnalysisTaskIdentity(code);
}

async function loadTask(db: D1Database, securityCode: string): Promise<GenericLlmTask | null> {
  const code = text(securityCode).toUpperCase();
  if (!code) throw new Error("low-dependency research-analysis security code is required");
  return loadGenericLlmTaskByIdentity(db, taskIdentity(code));
}

async function currentRun(db: D1Database, securityCode: string, attempt?: number, runnerInstanceId?: string): Promise<{ task: GenericLlmTask; run: GenericLlmRun }> {
  const task = await loadTask(db, securityCode);
  if (!task || !task.lastRunId) throw new Error("low-dependency research-analysis task run not found");
  const run = await loadGenericLlmRun(db, task.lastRunId);
  if (!run || run.taskId !== task.taskId) throw new Error("low-dependency research-analysis task run not found");
  if (attempt !== undefined && (run.attempt !== attempt || run.status !== "running" || run.leaseOwner !== text(runnerInstanceId) || (run.leaseUntil ?? 0) < Date.now())) {
    throw new Error("low-dependency research-analysis generic run lease is no longer owned by this runner");
  }
  return { task, run };
}

async function currentRunForTask(db: D1Database, securityCode: string, taskId: unknown, runId: unknown, attempt?: number, runnerInstanceId?: string): Promise<{ task: GenericLlmTask; run: GenericLlmRun }> {
  const normalizedTaskId = text(taskId);
  if (!normalizedTaskId) return currentRun(db, securityCode, attempt, runnerInstanceId);
  const task = await loadGenericLlmTask(db, normalizedTaskId);
  if (!task || task.targetId !== text(securityCode).toUpperCase()) throw new Error("low-dependency research-analysis child task not found");
  const selectedRunId = text(runId) || task.lastRunId;
  if (!selectedRunId) throw new Error("low-dependency research-analysis child task run not found");
  const run = await loadGenericLlmRun(db, selectedRunId);
  if (!run || run.taskId !== task.taskId) throw new Error("low-dependency research-analysis child task run not found");
  if (attempt !== undefined && (run.attempt !== attempt || run.status !== "running" || run.leaseOwner !== text(runnerInstanceId) || (run.leaseUntil ?? 0) < Date.now())) {
    throw new Error("low-dependency research-analysis child run lease is no longer owned by this runner");
  }
  return { task, run };
}

/**
 * Materialize the coordinator and every S0-S12 child once.  Child identity is
 * stable per security/stage so reruns can requeue only the invalidation
 * closure while retaining terminal siblings for compatibility reuse.
 */
export async function materializeLowDependencyWorkflowTasks(db: D1Database, securityCode: string, options: {
  parentTaskId?: string;
  model?: string | null;
  reasoningEffort?: string | null;
  rerunStageKeys?: string[];
  scopeEnvelopeAvailable?: boolean;
  now?: number;
} = {}) {
  const code = text(securityCode).toUpperCase();
  if (!code) throw new Error("low-dependency research-analysis security code is required");
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const parentTaskId = text(options.parentTaskId);
  const rerunStageKeys = normalizeLowDependencyRerunStageKeys(options.rerunStageKeys);
  const parentIdentity = taskIdentity(code);
  const parentResult = await createGenericLlmTask(db, {
    ...parentIdentity,
    taskId: parentTaskId || undefined,
    handlerKey: LOW_DEPENDENCY_COORDINATOR_HANDLER_KEY,
    executionMode: "engineering",
    model: text(options.model) || "engineering",
    reasoningEffort: text(options.reasoningEffort) || null,
    metadata: {
      securityCode: code,
      output: "low_dependency_operating_analysis",
      coordinator: true,
      stageRegistryVersion: "investment-analysis.stage-registry.v1",
      rerunStageKeys,
      scopeEnvelopeAvailable: options.scopeEnvelopeAvailable !== false,
    },
    now,
  });
  const parent = parentResult.task;
  const byStage = new Map<string, GenericLlmTask>();
  for (const definition of RESEARCH_OPERATING_ANALYSIS_TARGET_STAGES) {
    const executionMode = definition.execution === "deterministic" ? "engineering" as const : "model" as const;
    const dependencies = researchOperatingAnalysisDependencies(definition.key, { scopeEnvelopeAvailable: options.scopeEnvelopeAvailable !== false });
    const dependencyIds = dependencies.map((key) => byStage.get(key)?.taskId).filter((id): id is string => Boolean(id));
    const child = await createGenericLlmTask(db, {
      ...parentIdentity,
      taskType: `${LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_TASK_TYPE}_stage`,
      idempotencyKey: `${parent.idempotencyKey}:stage:${definition.key}`,
      handlerKey: LOW_DEPENDENCY_STAGE_HANDLER_KEY,
      executionMode,
      parentTaskId: parent.taskId,
      stageKey: definition.key,
      model: executionMode === "model" ? text(options.model) || "gpt-5.6-luna" : "engineering",
      reasoningEffort: executionMode === "model" ? text(options.reasoningEffort) || "max" : null,
      dependsOnTaskIds: dependencyIds,
      metadata: {
        securityCode: code,
        parentTaskId: parent.taskId,
        stageKey: definition.key,
        stageVersion: definition.schemaVersion,
        outputKind: definition.outputKind,
        execution: definition.execution,
        rerun: rerunStageKeys.includes(definition.key),
      },
      now,
    });
    let childTask = child.task;
    if (rerunStageKeys.includes(definition.key) && ["completed", "failed", "blocked"].includes(childTask.status)) {
      await requeueGenericLlmTask(db, childTask.taskId, now);
      childTask = (await loadGenericLlmTask(db, childTask.taskId)) || childTask;
    }
    if (childTask.status === "queued") {
      await db.prepare("update llm_tasks set requested_model=?, requested_reasoning_effort=?, handler_key=?, execution_mode=?, metadata_json=?, updated_at=? where task_id=? and status='queued'")
        .bind(executionMode === "model" ? text(options.model) || "gpt-5.6-luna" : "engineering", executionMode === "model" ? text(options.reasoningEffort) || "max" : null, LOW_DEPENDENCY_STAGE_HANDLER_KEY, executionMode, JSON.stringify({ ...(row(childTask.metadata)), securityCode: code, parentTaskId: parent.taskId, stageKey: definition.key, stageVersion: definition.schemaVersion, outputKind: definition.outputKind, execution: definition.execution, rerun: rerunStageKeys.includes(definition.key) }), now, childTask.taskId).run();
      childTask = (await loadGenericLlmTask(db, childTask.taskId)) || childTask;
    }
    byStage.set(definition.key, childTask);
  }
  // Edges are inserted after all child rows exist, allowing the registry to
  // remain declarative rather than coupling identity creation to task order.
  for (const definition of RESEARCH_OPERATING_ANALYSIS_TARGET_STAGES) {
    const child = byStage.get(definition.key);
    if (!child) continue;
    const dependencies = researchOperatingAnalysisDependencies(definition.key, { scopeEnvelopeAvailable: options.scopeEnvelopeAvailable !== false });
    const dependencyIds = dependencies.map((key) => byStage.get(key)?.taskId).filter((id): id is string => Boolean(id));
    if (dependencyIds.length) await addGenericLlmTaskDependencies(db, child.taskId, dependencyIds, now);
  }
  return { parent, children: [...byStage.values()] };
}

/** Requeue the route child and its blocked descendants after a validated S0.2
 * manual confirmation. Dependency reconciliation keeps descendants queued
 * until the route child reaches `completed`, so no model can run on an
 * unconfirmed scope projection. */
export async function unlockLowDependencyRoutingAfterConfirmation(db: D1Database, securityCode: string) {
  const task = await loadTask(db, securityCode);
  if (!task) return { requeued: [], parentRequeued: false };
  const children = await loadGenericLlmChildTasks(db, task.taskId);
  const byStage = new Map(children.filter((child) => child.stageKey).map((child) => [child.stageKey as string, child]));
  const invalidated = new Set<string>(["local_routing_match"]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const definition of RESEARCH_OPERATING_ANALYSIS_TARGET_STAGES) {
      if (!invalidated.has(definition.key) && definition.dependsOn.some((dependency) => invalidated.has(dependency))) {
        invalidated.add(definition.key);
        changed = true;
      }
    }
  }
  const requeued: string[] = [];
  for (const stageKey of [...invalidated].sort()) {
    const child = byStage.get(stageKey);
    if (!child || !["completed", "failed", "blocked"].includes(child.status)) continue;
    const result = await db.prepare(`update llm_tasks set status='queued', last_run_id=null, last_error_code=null,
      last_error_message=null, started_at=null, completed_at=null, ready_at=null, updated_at=?
      where task_id=? and status in ('completed','failed','blocked')`).bind(Date.now(), child.taskId).run();
    if (result.meta.changes) requeued.push(stageKey);
  }
  await reconcileGenericLlmTaskDependencies(db);
  let parentRequeued = false;
  if (["completed", "failed", "blocked"].includes(task.status)) parentRequeued = await requeueGenericLlmTask(db, task.taskId);
  return { requeued, parentRequeued };
}

export async function loadLowDependencyResearchOperatingAnalysis(db: D1Database, securityCode: string) {
  const code = text(securityCode).toUpperCase();
  try {
    const task = await loadTask(db, code);
    const run = task?.lastRunId ? await loadGenericLlmRun(db, task.lastRunId) : null;
    // New S0-S12 runs persist each stage on its own child task and expose the
    // terminal artifacts through workflow links. Keep reading the coordinator
    // run's same-task artifacts for compatibility with pre-DAG rows.
    const workflowArtifacts = task ? await loadGenericWorkflowArtifacts(db, task.taskId) : [];
    const legacyArtifacts = run ? await loadGenericLlmRunArtifacts(db, run.runId) : [];
    const artifactProjection = new Map<string, GenericLlmArtifact>();
    for (const artifact of legacyArtifacts) artifactProjection.set(artifact.stepKey, artifact);
    for (const artifact of workflowArtifacts) artifactProjection.set(artifact.stepKey, artifact);
    const artifacts = [...artifactProjection.values()];
    const childTasks = task ? await loadGenericLlmChildTasks(db, task.taskId) : [];
    const childByStage = new Map(childTasks.filter((child) => child.stageKey).map((child) => [child.stageKey as string, child]));
    const artifactByKey = new Map(artifacts.map((artifact) => [artifact.stepKey, artifact]));
    const stages = RESEARCH_OPERATING_ANALYSIS_TARGET_STAGES.map((definition) => normalizeStage(definition, artifactByKey.get(definition.key), run, childByStage.get(definition.key)));
    const context = artifactByKey.get("research_context") || artifactByKey.get("engineering_baseline");
    const contextOutput = row(context?.output);
    const reportArtifact = artifactByKey.get("report_assembly");
    const reportMetadata = row(reportArtifact?.terminalMetadata);
    const reportStage = stages.find((stage) => stage.stageKey === "report_assembly");
    const report = reportArtifact ? {
      status: reportStage?.status || reportArtifact.status,
      artifactId: reportArtifact.artifactId,
      markdown: reportStage?.status === "complete" && typeof reportArtifact.output === "string" ? reportArtifact.output : null,
      manifest: reportMetadata.reportManifest ?? null,
      projectionFingerprint: text(reportMetadata.projectionFingerprint) || null,
      blockers: Array.isArray(reportMetadata.blockers) ? reportMetadata.blockers : [],
    } : null;
    const unknownStageKeys = artifacts.filter((artifact) => !RESEARCH_OPERATING_ANALYSIS_TARGET_STAGES.some((stage) => stage.key === artifact.stepKey)).map((artifact) => artifact.stepKey);
    const contractErrors = artifacts.flatMap((artifact) => {
      const definition = RESEARCH_OPERATING_ANALYSIS_TARGET_STAGES.find((stage) => stage.key === artifact.stepKey);
      if (!definition || !["complete", "not_applicable"].includes(artifact.status)) return [];
      return artifact.stageVersion !== definition.schemaVersion || artifact.projectionVersion !== LOW_DEPENDENCY_PROJECTION_VERSION || artifact.outputType !== definition.outputKind
        ? [{ stageKey: artifact.stepKey, stageVersion: artifact.stageVersion, projectionVersion: artifact.projectionVersion, outputType: artifact.outputType, expectedOutputType: definition.outputKind }]
        : [];
    });
    return {
      protocolVersion: LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_PROTOCOL_VERSION,
      promptVersion: LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_PROMPT_VERSION,
      availability: task || artifacts.length ? "available" as const : "empty" as const,
      scopeEnvelopeAvailable: (contextOutput.scopeEnvelope !== null && contextOutput.scopeEnvelope !== undefined) || (contextOutput.companyScope !== null && contextOutput.companyScope !== undefined),
      task: task ? normalizeTask(task, run, stages) : null,
      run,
      stages,
      report,
      unknownStageKeys: [...new Set(unknownStageKeys)].sort(),
      contractErrors,
      finalArtifactId: reportStage?.status === "complete" ? reportArtifact?.artifactId ?? null : null,
    };
  } catch (error) {
    if (/no such table/i.test(String(error))) return { protocolVersion: LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_PROTOCOL_VERSION, promptVersion: LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_PROMPT_VERSION, availability: "unavailable" as const, scopeEnvelopeAvailable: false, task: null, run: null, stages: [], report: null, unknownStageKeys: [], contractErrors: [], finalArtifactId: null };
    throw error;
  }
}

export async function enqueueLowDependencyResearchOperatingAnalysis(db: D1Database, securityCode: string, force = false, requestedReasoningEffort: unknown = "max", requestedModel: unknown = "gpt-5.6-luna", requestedStageKeys: unknown = undefined) {
  const code = text(securityCode).toUpperCase();
  if (!code) throw new Error("low-dependency research-analysis security code is required");
  // A forced refresh is a full regeneration boundary. Without an explicit
  // invalidation list, a newly claimed run can reuse a terminal artifact from
  // the previous run (including a blocked S0.2 route) before manual routing
  // confirmation is applied.
  const requestedRerunStageKeys = effectiveLowDependencyRefreshStageKeys(force, requestedStageKeys);
  const rerunStageKeys = lowDependencyRerunClosure(requestedRerunStageKeys, true);
  const now = Date.now();
  const created = await createGenericLlmTask(db, {
    ...taskIdentity(code), handlerKey: LOW_DEPENDENCY_COORDINATOR_HANDLER_KEY, executionMode: "engineering", model: "engineering", reasoningEffort: null,
    metadata: { securityCode: code, output: "low_dependency_operating_analysis", coordinator: true, stageRegistryVersion: "investment-analysis.stage-registry.v1", rerunStageKeys }, now,
  });
  let task = created.task;
  if (task.status === "running" || (task.status === "completed" && !force)) return { ...(await loadLowDependencyResearchOperatingAnalysis(db, code)), shouldStart: false, deduplicated: true };
  if (task.status === "failed" || task.status === "blocked" || (task.status === "completed" && force)) {
    await requeueGenericLlmTask(db, task.taskId, now);
    task = (await loadTask(db, code)) || task;
  }
  if (task.status !== "queued") return { ...(await loadLowDependencyResearchOperatingAnalysis(db, code)), shouldStart: false, deduplicated: true };
  const scopeEnvelopeAvailable = row(task.metadata).scopeEnvelopeAvailable !== false;
  const materialized = await materializeLowDependencyWorkflowTasks(db, code, {
    parentTaskId: task.taskId,
    model: text(requestedModel) || "gpt-5.6-luna",
    reasoningEffort: text(requestedReasoningEffort) || "max",
    rerunStageKeys,
    scopeEnvelopeAvailable,
    now,
  });
  const currentMetadata = row(task.metadata);
  await db.prepare("update llm_tasks set requested_model=?, requested_reasoning_effort=?, handler_key=?, execution_mode='engineering', metadata_json=?, updated_at=? where task_id=? and status='queued'")
    .bind("engineering", null, LOW_DEPENDENCY_COORDINATOR_HANDLER_KEY, JSON.stringify({ ...currentMetadata, securityCode: code, output: "low_dependency_operating_analysis", coordinator: true, stageRegistryVersion: "investment-analysis.stage-registry.v1", rerunStageKeys, childTaskIds: materialized.children.map((child) => child.taskId) }), now, task.taskId).run();
  return { ...(await loadLowDependencyResearchOperatingAnalysis(db, code)), shouldStart: true, deduplicated: !created.created, materialized: { parentTaskId: materialized.parent.taskId, childTaskIds: materialized.children.map((child) => child.taskId) } };
}

export async function claimLowDependencyResearchOperatingAnalysisJob(db: D1Database, runnerInstanceId: string) {
  if (!await ownsResearchOperatingAnalysisRunnerLease(db, text(runnerInstanceId))) return null;
  const claim = await claimNextGenericLlmQueueTaskRun(db, text(runnerInstanceId), { taskType: LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_TASK_TYPE, executionMode: "engineering", protocolVersion: LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_PROTOCOL_VERSION, promptVersion: LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_PROMPT_VERSION });
  if (!claim || claim.task.targetType !== "security") return null;
  return { jobId: claim.task.taskId, taskId: claim.task.taskId, runId: claim.run.runId, securityCode: claim.task.targetId, model: claim.run.model, reasoningEffort: claim.run.reasoningEffort, promptVersion: claim.task.promptVersion, attempt: claim.run.attempt, lineageRunId: claim.run.lineageRunId, rerunStageKeys: normalizeLowDependencyRerunStageKeys(row(claim.task.metadata).rerunStageKeys) };
}

export async function startLowDependencyResearchOperatingAnalysisStage(db: D1Database, securityCode: string, stageKey: string, input: unknown, prompt: unknown, runnerInstanceId: string, attempt: number, lineage: Lineage = {}, allowReuse = true, taskId?: string, runId?: string) {
  const definition = getResearchOperatingAnalysisStage(stageKey);
  const modelPrompt = normalizePrompt(prompt);
  if (definition.execution === "model" && !modelPrompt) throw new Error("low-dependency research-analysis stage prompt is required");
  const { task, run } = await currentRunForTask(db, securityCode, taskId, runId, attempt, runnerInstanceId);
  if (task.stageKey && task.stageKey !== definition.key) throw new Error("low-dependency child stage key does not match task");
  const artifacts = await loadGenericLlmRunArtifacts(db, run.runId);
  const existing = artifacts.find((artifact) => artifact.stepKey === definition.key);
  if (existing && statuses.has(existing.status)) return normalizeStage(definition, existing, run, task);
  const normalizedLineage = normalizeLineage(lineage);
  const inputFingerprint = text(row(input).inputFingerprint) || text(run.inputFingerprint) || null;
  if (allowReuse) {
    const reused = await reuseCompatibleGenericLlmRunArtifact(db, {
      runId: run.runId, taskId: task.taskId, attempt, leaseOwner: text(runnerInstanceId), stepKey: definition.key,
      stageVersion: definition.schemaVersion, inputFingerprint, upstreamArtifactIds: normalizedLineage.upstreamArtifactIds,
      projectionVersion: LOW_DEPENDENCY_PROJECTION_VERSION,
    });
    if (reused) {
      if (task.parentTaskId) await linkGenericWorkflowArtifact(db, { parentTaskId: task.parentTaskId, childTaskId: task.taskId, runId: run.runId, artifactId: reused.artifactId, stageKey: definition.key, linkedAt: Date.now() });
      return normalizeStage(definition, reused, run, task);
    }
  }
  const recorded = await recordGenericLlmRunProgress(db, {
    runId: run.runId, taskId: task.taskId, attempt, leaseOwner: text(runnerInstanceId), stepKey: definition.key,
    metadata: { input, prompt: modelPrompt, stageVersion: definition.schemaVersion, inputFingerprint, ...normalizedLineage, startedAt: Date.now(), attemptCount: attempt, outputKind: definition.outputKind }, updatedAt: Date.now(),
  });
  if (!recorded) throw new Error("low-dependency research-analysis generic run lease is no longer owned by this runner");
  return normalizeQueuedStage(definition, await loadGenericLlmRun(db, run.runId), task);
}

export async function completeLowDependencyResearchOperatingAnalysisStage(db: D1Database, securityCode: string, stageKey: string, output: unknown, status: string, runnerInstanceId: string, attempt: number, lineage: Lineage = {}, metadata: unknown = null, errorCode: unknown = null, errorMessage: unknown = null, taskId?: string, runId?: string) {
  const definition = getResearchOperatingAnalysisStage(stageKey);
  if (!statuses.has(status)) throw new Error("invalid low-dependency research-analysis stage status");
  if (definition.outputKind === "json" && (!output || typeof output !== "object" || Array.isArray(output))) throw new Error("low-dependency JSON stage output is invalid");
  if (definition.outputKind === "markdown" && !text(output)) throw new Error("low-dependency Markdown stage output is empty");
  const { task, run } = await currentRunForTask(db, securityCode, taskId, runId, attempt, runnerInstanceId);
  if (task.stageKey && task.stageKey !== definition.key) throw new Error("low-dependency child stage key does not match task");
  const artifacts = await loadGenericLlmRunArtifacts(db, run.runId);
  const existing = artifacts.find((artifact) => artifact.stepKey === definition.key);
  if (existing && statuses.has(existing.status)) return normalizeStage(definition, existing, run, task);
  const progress = row(run.progress);
  const normalizedLineage = normalizeLineage({ ...inferLineage(output), ...lineage });
  const artifact = await writeGenericLlmRunArtifact(db, {
    runId: run.runId, taskId: task.taskId, attempt, leaseOwner: text(runnerInstanceId), stepKey: definition.key,
    stageVersion: definition.schemaVersion, inputFingerprint: text(progress.inputFingerprint) || text(run.inputFingerprint) || null,
    upstreamArtifactIds: normalizedLineage.upstreamArtifactIds, sourceIds: normalizedLineage.sourceIds, claimIds: normalizedLineage.claimIds, evidenceIds: normalizedLineage.evidenceIds, unknownIds: normalizedLineage.unknownIds,
    outputType: definition.outputKind, status: status as "complete" | "partial" | "blocked" | "not_applicable" | "failed", output,
    structureValid: status === "complete", blocked: row(output).blockedItems || row(output).blockedValuationItems || row(output).analysisGaps || null, errorCode: status === "failed" ? text(errorCode) || "low_dependency_stage_failed" : text(errorCode) || null, errorMessage: status === "failed" ? text(errorMessage) || text(row(output).error) || "low-dependency stage failed" : text(errorMessage) || null, projectionVersion: LOW_DEPENDENCY_PROJECTION_VERSION,
    terminalMetadata: { input: progress.input, prompt: progress.prompt, stageVersion: definition.schemaVersion, inputFingerprint: text(progress.inputFingerprint) || text(run.inputFingerprint) || null, ...normalizedLineage, ...(row(metadata)), startedAt: progress.startedAt, attemptCount: attempt }, completedAt: Date.now(),
  });
  if (task.parentTaskId) {
    await linkGenericWorkflowArtifact(db, {
      parentTaskId: task.parentTaskId,
      childTaskId: task.taskId,
      runId: run.runId,
      artifactId: artifact.artifactId,
      stageKey: definition.key,
      linkedAt: Date.now(),
    });
  }
  return normalizeStage(definition, artifact, run);
}

/**
 * Terminalize the target protocol only after S12 exists and its report gate has
 * passed. A partial/blocked/failed stage is deliberately represented as a
 * blocked generic run; it is never reported as a successful analysis.
 */
export async function completeLowDependencyResearchOperatingAnalysisJob(db: D1Database, securityCode: string, runnerInstanceId: string, attempt: number, reportStatus?: unknown, reportArtifactId?: unknown) {
  const { task, run } = await currentRun(db, securityCode, attempt, runnerInstanceId);
  const artifacts = await loadGenericLlmRunArtifacts(db, run.runId);
  const byKey = new Map<string, GenericLlmArtifact>();
  const duplicateKeys: string[] = [];
  const unknownStageKeys = artifacts.filter((artifact) => !RESEARCH_OPERATING_ANALYSIS_TARGET_STAGES.some((stage) => stage.key === artifact.stepKey)).map((artifact) => artifact.stepKey);
  if (unknownStageKeys.length) throw new Error(`low-dependency run contains unknown stage artifacts: ${[...new Set(unknownStageKeys)].sort().join(",")}`);
  const invalidStageContracts = artifacts.flatMap((artifact) => {
    const definition = RESEARCH_OPERATING_ANALYSIS_TARGET_STAGES.find((stage) => stage.key === artifact.stepKey);
    if (!definition || !["complete", "not_applicable"].includes(artifact.status)) return [];
    return artifact.stageVersion !== definition.schemaVersion || artifact.projectionVersion !== LOW_DEPENDENCY_PROJECTION_VERSION || artifact.outputType !== definition.outputKind
      ? [{ stageKey: artifact.stepKey, stageVersion: artifact.stageVersion, projectionVersion: artifact.projectionVersion, outputType: artifact.outputType, expectedOutputType: definition.outputKind }]
      : [];
  });
  for (const artifact of artifacts) {
    if (byKey.has(artifact.stepKey)) duplicateKeys.push(artifact.stepKey);
    else byKey.set(artifact.stepKey, artifact);
  }
  const missing = RESEARCH_OPERATING_ANALYSIS_TARGET_STAGES.filter((stage) => !byKey.has(stage.key)).map((stage) => stage.key);
  const report = byKey.get("report_assembly");
  const requestedStatus = text(reportStatus);
  const terminalStageStatuses = new Set(["complete", "not_applicable"]);
  const incomplete = RESEARCH_OPERATING_ANALYSIS_TARGET_STAGES.filter((stage) => !terminalStageStatuses.has(byKey.get(stage.key)?.status || "")).map((stage) => ({ stageKey: stage.key, status: byKey.get(stage.key)?.status || "missing" }));
  const reportMatches = Boolean(report && report.status === "complete" && (!reportArtifactId || report.artifactId === text(reportArtifactId)) && (!requestedStatus || requestedStatus === "complete"));
  const success = reportMatches && missing.length === 0 && duplicateKeys.length === 0 && incomplete.length === 0 && invalidStageContracts.length === 0;
  const now = Date.now();
  const terminalMetadata = {
    protocolVersion: LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_PROTOCOL_VERSION,
    reportProjection: "research_operating_analysis_low_dependency",
    reportArtifactId: report?.artifactId || null,
    reportStatus: report?.status || requestedStatus || null,
    missingStages: missing,
    duplicateStageKeys: [...new Set(duplicateKeys)].sort(),
    incompleteStages: incomplete,
    invalidStageContracts,
  };
  await completeGenericLlmRun(db, {
    runId: run.runId,
    taskId: task.taskId,
    attempt,
    leaseOwner: text(runnerInstanceId),
    status: success ? "completed" : "blocked",
    errorCode: success ? null : "low_dependency_report_gate",
    errorMessage: success ? null : `S12 report gate failed${missing.length ? `; missing=${missing.join(",")}` : ""}${incomplete.length ? `; incomplete=${incomplete.map((item) => `${item.stageKey}:${item.status}`).join(",")}` : ""}${invalidStageContracts.length ? `; invalid_contract=${invalidStageContracts.map((item) => item.stageKey).join(",")}` : ""}`.slice(0, 1600),
    terminalMetadata,
    completedAt: now,
  });
  return loadLowDependencyResearchOperatingAnalysis(db, securityCode);
}

export async function failLowDependencyResearchOperatingAnalysisJob(db: D1Database, securityCode: string, error: unknown, runnerInstanceId: string, attempt: number) {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1600);
  const { task, run } = await currentRun(db, securityCode, attempt, runnerInstanceId);
  const current = run.currentStepKey;
  if (current && RESEARCH_OPERATING_ANALYSIS_TARGET_STAGES.some((stage) => stage.key === current)) {
    const artifacts = await loadGenericLlmRunArtifacts(db, run.runId);
    if (!artifacts.some((artifact) => artifact.stepKey === current)) await writeGenericLlmRunArtifact(db, { runId: run.runId, taskId: task.taskId, attempt, leaseOwner: text(runnerInstanceId), stepKey: current, stageVersion: getResearchOperatingAnalysisStage(current).schemaVersion, outputType: getResearchOperatingAnalysisStage(current).outputKind, status: "failed", errorCode: "low_dependency_stage_failed", errorMessage: message, projectionVersion: LOW_DEPENDENCY_PROJECTION_VERSION, terminalMetadata: { currentStepKey: current }, completedAt: Date.now() });
  }
  await failGenericLlmRun(db, { runId: run.runId, taskId: task.taskId, attempt, leaseOwner: text(runnerInstanceId), errorCode: "low_dependency_stage_failed", errorMessage: message, terminalMetadata: { currentStepKey: current }, completedAt: Date.now() });
  return loadLowDependencyResearchOperatingAnalysis(db, securityCode);
}

export async function heartbeatLowDependencyResearchOperatingAnalysisJob(db: D1Database, securityCode: string, runnerInstanceId: string, attempt: number) {
  const context = await currentRun(db, securityCode).catch(() => null);
  return context ? heartbeatGenericLlmRun(db, context.run.runId, context.task.taskId, attempt, text(runnerInstanceId)) : false;
}

export async function requeueInterruptedLowDependencyResearchOperatingAnalysisJob(db: D1Database, securityCode: string, error: unknown, runnerInstanceId: string, attempt: number) {
  const context = await currentRun(db, securityCode).catch(() => null);
  const now = Date.now();
  if (!context || context.run.status !== "running" || context.run.attempt !== attempt || context.run.leaseOwner !== text(runnerInstanceId) || (context.run.leaseUntil ?? 0) >= now) return false;
  return requeueExpiredGenericLlmRun(db, { runId: context.run.runId, taskId: context.task.taskId, attempt, leaseOwner: text(runnerInstanceId), errorMessage: `low-dependency runner interrupted: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1600), now });
}

function normalizeTask(task: GenericLlmTask, run: GenericLlmRun | null, stages: unknown[]) {
  return { jobId: task.taskId, taskId: task.taskId, jobType: task.taskType, targetType: task.targetType, securityCode: task.targetId, protocolVersion: LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_PROTOCOL_VERSION, promptVersion: task.promptVersion, status: task.status, runId: task.lastRunId, lineageRunId: run?.lineageRunId ?? null, attempt: run?.attempt ?? 0, leaseOwner: run?.leaseOwner ?? null, leaseUntil: run?.leaseUntil ?? null, heartbeatAt: run?.heartbeatAt ?? null, model: run?.model || task.requestedModel, reasoningEffort: run?.reasoningEffort || task.requestedReasoningEffort, rerunStageKeys: normalizeLowDependencyRerunStageKeys(row(task.metadata).rerunStageKeys), lastError: task.lastErrorMessage || run?.errorMessage || null, createdAt: task.createdAt, startedAt: run?.startedAt ?? task.startedAt, completedAt: task.completedAt, updatedAt: Math.max(task.updatedAt, run?.updatedAt || 0), currentStepKey: run?.currentStepKey ?? null, progress: run?.progress ?? null, stages };
}

function normalizeStage(definition: ResearchAnalysisStageDefinition, artifact: GenericLlmArtifact | undefined, run: GenericLlmRun | null, childTask?: GenericLlmTask) {
  if (!artifact) return normalizeQueuedStage(definition, run, childTask);
  const metadata = row(artifact.terminalMetadata);
  const startedAt = Number.isFinite(Number(metadata.startedAt)) ? Number(metadata.startedAt) : null;
  const childStatus = childTask?.status === "queued" ? "queued" : childTask?.status === "running" ? "running" : childTask?.status === "blocked" ? "blocked" : childTask?.status === "failed" ? "failed" : null;
  return { stageKey: definition.key, label: definition.label, owner: definition.owner, execution: definition.execution, outputKind: definition.outputKind, schemaVersion: definition.schemaVersion, dependsOn: definition.dependsOn, fallbackDependsOn: definition.fallbackDependsOn, status: (childStatus || artifact.status) as LowDependencyResearchAnalysisStageStatus, taskId: childTask?.taskId ?? null, taskStatus: childTask?.status ?? null, parentTaskId: childTask?.parentTaskId ?? null, childRunId: childTask?.lastRunId ?? artifact.runId, artifactId: artifact.artifactId, runId: artifact.runId, sourceRunId: artifact.sourceRunId ?? null, reused: artifact.reused === true, upstreamArtifactIds: artifact.upstreamArtifactIds, sourceIds: artifact.sourceIds, claimIds: artifact.claimIds, evidenceIds: artifact.evidenceIds, unknownIds: artifact.unknownIds, inputFingerprint: artifact.inputFingerprint, stageVersion: artifact.stageVersion, projectionVersion: artifact.projectionVersion, attempt: run?.attempt ?? 0, attemptCount: Number(metadata.attemptCount) || run?.attempt || 0, startedAt, completedAt: artifact.completedAt, elapsedMs: startedAt === null ? null : Math.max(0, artifact.completedAt - startedAt), updatedAt: artifact.completedAt, lastError: artifact.errorMessage || childTask?.lastErrorMessage || null, output: artifact.output, blocked: artifact.blocked, validationFailure: metadata.validationFailure ?? null, prompt: normalizePrompt(metadata.prompt), input: metadata.input ?? null };
}

function normalizeQueuedStage(definition: ResearchAnalysisStageDefinition, run: GenericLlmRun | null, childTask?: GenericLlmTask) {
  const current = childTask?.status === "running" || (!childTask && run?.currentStepKey === definition.key);
  const progress = row(run?.progress);
  const startedAt = current ? Number(progress.startedAt) || null : null;
  const currentStatus = childTask?.status === "blocked" ? "blocked" : childTask?.status === "failed" ? "failed" : childTask?.status === "completed" ? "complete" : current ? "running" : "queued";
  return { stageKey: definition.key, label: definition.label, owner: definition.owner, execution: definition.execution, outputKind: definition.outputKind, schemaVersion: definition.schemaVersion, dependsOn: definition.dependsOn, fallbackDependsOn: definition.fallbackDependsOn, status: currentStatus, taskId: childTask?.taskId ?? null, taskStatus: childTask?.status ?? null, parentTaskId: childTask?.parentTaskId ?? null, childRunId: childTask?.lastRunId ?? null, artifactId: null, runId: childTask?.lastRunId ?? run?.runId ?? null, upstreamArtifactIds: [], sourceIds: [], claimIds: [], evidenceIds: [], unknownIds: [], inputFingerprint: text(progress.inputFingerprint) || null, stageVersion: definition.schemaVersion, projectionVersion: null, attempt: childTask?.lastRunId ? 1 : current ? run?.attempt ?? 0 : 0, attemptCount: current ? run?.attempt ?? 0 : 0, startedAt, completedAt: childTask?.completedAt ?? null, elapsedMs: null, updatedAt: childTask?.updatedAt ?? (current ? run?.progressUpdatedAt ?? null : null), lastError: childTask?.lastErrorMessage || (current && run?.status !== "running" ? run?.errorMessage ?? null : null), output: null, blocked: null, prompt: normalizePrompt(progress.prompt), input: progress.input ?? null };
}

function normalizePrompt(value: unknown): ModelPrompt | null {
  const source = row(value); const instructions = text(source.instructions); const userPrompt = text(source.userPrompt); const model = text(source.model);
  return instructions && userPrompt ? { ...(model ? { model } : {}), instructions, userPrompt } : null;
}

function normalizeLineage(lineage: Lineage) {
  return {
    upstreamArtifactIds: normalizeGenericLlmIdArray(lineage.upstreamArtifactIds, "upstreamArtifactIds"),
    sourceIds: normalizeGenericLlmIdArray(lineage.sourceIds, "sourceIds"),
    claimIds: normalizeGenericLlmIdArray(lineage.claimIds, "claimIds"),
    evidenceIds: normalizeGenericLlmIdArray(lineage.evidenceIds, "evidenceIds"),
    unknownIds: normalizeGenericLlmIdArray(lineage.unknownIds, "unknownIds"),
  };
}

function inferLineage(output: unknown): Lineage {
  const result: Record<string, string[]> = { upstreamArtifactIds: [], sourceIds: [], claimIds: [], evidenceIds: [], unknownIds: [] };
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const targetKey = key === "usedUpstreamArtifactIds" ? "upstreamArtifactIds" : key;
      if (targetKey in result && Array.isArray(item)) result[targetKey].push(...item.filter((id): id is string => typeof id === "string"));
      else {
        const singularTarget = { upstreamArtifactId: "upstreamArtifactIds", usedUpstreamArtifactId: "upstreamArtifactIds", sourceId: "sourceIds", claimId: "claimIds", evidenceId: "evidenceIds", unknownId: "unknownIds" }[key];
        if (singularTarget && typeof item === "string") result[singularTarget].push(item);
        else visit(item);
      }
    }
  };
  visit(output);
  return result;
}
