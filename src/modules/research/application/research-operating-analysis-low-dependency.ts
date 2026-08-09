import {
  RESEARCH_OPERATING_ANALYSIS_TARGET_PROMPT_VERSION,
  RESEARCH_OPERATING_ANALYSIS_TARGET_PROTOCOL_VERSION,
  RESEARCH_OPERATING_ANALYSIS_TARGET_STAGES,
  RESEARCH_OPERATING_ANALYSIS_TARGET_TASK_TYPE,
  getResearchOperatingAnalysisStage,
  researchOperatingAnalysisTaskIdentity,
  terminalResearchOperatingAnalysisStatuses,
  type ResearchAnalysisStageDefinition,
  type ResearchAnalysisStageKey,
  type ResearchAnalysisStageStatus,
} from "./research-operating-analysis-stage-registry";
import {
  claimGenericLlmTaskRun,
  completeGenericLlmRun,
  createGenericLlmTask,
  failGenericLlmRun,
  heartbeatGenericLlmRun,
  loadGenericLlmRun,
  loadGenericLlmRunArtifacts,
  loadGenericLlmTaskByIdentity,
  normalizeGenericLlmIdArray,
  recordGenericLlmRunProgress,
  requeueExpiredGenericLlmRun,
  requeueGenericLlmTask,
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

export async function loadLowDependencyResearchOperatingAnalysis(db: D1Database, securityCode: string) {
  const code = text(securityCode).toUpperCase();
  try {
    const task = await loadTask(db, code);
    const run = task?.lastRunId ? await loadGenericLlmRun(db, task.lastRunId) : null;
    const artifacts = run ? await loadGenericLlmRunArtifacts(db, run.runId) : [];
    const artifactByKey = new Map(artifacts.map((artifact) => [artifact.stepKey, artifact]));
    const stages = RESEARCH_OPERATING_ANALYSIS_TARGET_STAGES.map((definition) => normalizeStage(definition, artifactByKey.get(definition.key), run));
    const context = artifactByKey.get("research_context");
    const contextOutput = row(context?.output);
    const reportArtifact = artifactByKey.get("report_assembly");
    const reportMetadata = row(reportArtifact?.terminalMetadata);
    const report = reportArtifact ? {
      status: reportArtifact.status,
      artifactId: reportArtifact.artifactId,
      markdown: typeof reportArtifact.output === "string" ? reportArtifact.output : null,
      manifest: reportMetadata.reportManifest ?? null,
      projectionFingerprint: text(reportMetadata.projectionFingerprint) || null,
      blockers: Array.isArray(reportMetadata.blockers) ? reportMetadata.blockers : [],
    } : null;
    const unknownStageKeys = artifacts.filter((artifact) => !RESEARCH_OPERATING_ANALYSIS_TARGET_STAGES.some((stage) => stage.key === artifact.stepKey)).map((artifact) => artifact.stepKey);
    const contractErrors = artifacts.flatMap((artifact) => {
      const definition = RESEARCH_OPERATING_ANALYSIS_TARGET_STAGES.find((stage) => stage.key === artifact.stepKey);
      if (!definition || !["complete", "not_applicable"].includes(artifact.status)) return [];
      return artifact.stageVersion !== definition.schemaVersion || artifact.projectionVersion !== LOW_DEPENDENCY_PROJECTION_VERSION
        ? [{ stageKey: artifact.stepKey, stageVersion: artifact.stageVersion, projectionVersion: artifact.projectionVersion }]
        : [];
    });
    return {
      protocolVersion: LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_PROTOCOL_VERSION,
      promptVersion: LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_PROMPT_VERSION,
      availability: task || artifacts.length ? "available" as const : "empty" as const,
      scopeEnvelopeAvailable: contextOutput.scopeEnvelope !== null && contextOutput.scopeEnvelope !== undefined,
      task: task ? normalizeTask(task, run, stages) : null,
      run,
      stages,
      report,
      unknownStageKeys: [...new Set(unknownStageKeys)].sort(),
      contractErrors,
      finalArtifactId: reportArtifact?.artifactId ?? null,
    };
  } catch (error) {
    if (/no such table/i.test(String(error))) return { protocolVersion: LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_PROTOCOL_VERSION, promptVersion: LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_PROMPT_VERSION, availability: "unavailable" as const, scopeEnvelopeAvailable: false, task: null, run: null, stages: [], report: null, unknownStageKeys: [], contractErrors: [], finalArtifactId: null };
    throw error;
  }
}

export async function enqueueLowDependencyResearchOperatingAnalysis(db: D1Database, securityCode: string, force = false, requestedReasoningEffort: unknown = "max", requestedModel: unknown = "gpt-5.6-luna", requestedStageKeys: unknown = undefined) {
  const code = text(securityCode).toUpperCase();
  if (!code) throw new Error("low-dependency research-analysis security code is required");
  const rerunStageKeys = normalizeLowDependencyRerunStageKeys(requestedStageKeys);
  const now = Date.now();
  const created = await createGenericLlmTask(db, {
    ...taskIdentity(code), model: text(requestedModel) || "gpt-5.6-luna", reasoningEffort: text(requestedReasoningEffort) || "max",
    metadata: { securityCode: code, output: "low_dependency_operating_analysis", stageRegistryVersion: "investment-analysis.stage-registry.v1", rerunStageKeys }, now,
  });
  let task = created.task;
  if (task.status === "running" || (task.status === "completed" && !force)) return { ...(await loadLowDependencyResearchOperatingAnalysis(db, code)), shouldStart: false, deduplicated: true };
  if (task.status === "failed" || task.status === "blocked" || (task.status === "completed" && force)) {
    await requeueGenericLlmTask(db, task.taskId, now);
    task = (await loadTask(db, code)) || task;
  }
  if (task.status !== "queued") return { ...(await loadLowDependencyResearchOperatingAnalysis(db, code)), shouldStart: false, deduplicated: true };
  const currentMetadata = row(task.metadata);
  await db.prepare("update llm_tasks set requested_model=?, requested_reasoning_effort=?, metadata_json=?, updated_at=? where task_id=? and status='queued'")
    .bind(text(requestedModel) || "gpt-5.6-luna", text(requestedReasoningEffort) || "max", JSON.stringify({ ...currentMetadata, securityCode: code, output: "low_dependency_operating_analysis", stageRegistryVersion: "investment-analysis.stage-registry.v1", rerunStageKeys }), now, task.taskId).run();
  return { ...(await loadLowDependencyResearchOperatingAnalysis(db, code)), shouldStart: true, deduplicated: !created.created };
}

export async function claimLowDependencyResearchOperatingAnalysisJob(db: D1Database, runnerInstanceId: string) {
  if (!await ownsResearchOperatingAnalysisRunnerLease(db, text(runnerInstanceId))) return null;
  const claim = await claimGenericLlmTaskRun(db, text(runnerInstanceId), { taskType: LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_TASK_TYPE, protocolVersion: LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_PROTOCOL_VERSION, promptVersion: LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_PROMPT_VERSION });
  if (!claim || claim.task.targetType !== "security") return null;
  return { jobId: claim.task.taskId, taskId: claim.task.taskId, runId: claim.run.runId, securityCode: claim.task.targetId, model: claim.run.model, reasoningEffort: claim.run.reasoningEffort, promptVersion: claim.task.promptVersion, attempt: claim.run.attempt, lineageRunId: claim.run.lineageRunId, rerunStageKeys: normalizeLowDependencyRerunStageKeys(row(claim.task.metadata).rerunStageKeys) };
}

export async function startLowDependencyResearchOperatingAnalysisStage(db: D1Database, securityCode: string, stageKey: string, input: unknown, prompt: unknown, runnerInstanceId: string, attempt: number, lineage: Lineage = {}, allowReuse = true) {
  const definition = getResearchOperatingAnalysisStage(stageKey);
  const modelPrompt = normalizePrompt(prompt);
  if (definition.execution === "model" && !modelPrompt) throw new Error("low-dependency research-analysis stage prompt is required");
  const { task, run } = await currentRun(db, securityCode, attempt, runnerInstanceId);
  const artifacts = await loadGenericLlmRunArtifacts(db, run.runId);
  const existing = artifacts.find((artifact) => artifact.stepKey === definition.key);
  if (existing && statuses.has(existing.status)) return normalizeStage(definition, existing, run);
  const normalizedLineage = normalizeLineage(lineage);
  const inputFingerprint = text(row(input).inputFingerprint) || text(run.inputFingerprint) || null;
  if (allowReuse) {
    const reused = await reuseCompatibleGenericLlmRunArtifact(db, {
      runId: run.runId, taskId: task.taskId, attempt, leaseOwner: text(runnerInstanceId), stepKey: definition.key,
      stageVersion: definition.schemaVersion, inputFingerprint, upstreamArtifactIds: normalizedLineage.upstreamArtifactIds,
      projectionVersion: LOW_DEPENDENCY_PROJECTION_VERSION,
    });
    if (reused) return normalizeStage(definition, reused, run);
  }
  const recorded = await recordGenericLlmRunProgress(db, {
    runId: run.runId, taskId: task.taskId, attempt, leaseOwner: text(runnerInstanceId), stepKey: definition.key,
    metadata: { input, prompt: modelPrompt, stageVersion: definition.schemaVersion, inputFingerprint, ...normalizedLineage, startedAt: Date.now(), attemptCount: attempt, outputKind: definition.outputKind }, updatedAt: Date.now(),
  });
  if (!recorded) throw new Error("low-dependency research-analysis generic run lease is no longer owned by this runner");
  return normalizeQueuedStage(definition, await loadGenericLlmRun(db, run.runId));
}

export async function completeLowDependencyResearchOperatingAnalysisStage(db: D1Database, securityCode: string, stageKey: string, output: unknown, status: string, runnerInstanceId: string, attempt: number, lineage: Lineage = {}, metadata: unknown = null) {
  const definition = getResearchOperatingAnalysisStage(stageKey);
  if (!statuses.has(status)) throw new Error("invalid low-dependency research-analysis stage status");
  if (definition.outputKind === "json" && (!output || typeof output !== "object" || Array.isArray(output))) throw new Error("low-dependency JSON stage output is invalid");
  if (definition.outputKind === "markdown" && !text(output)) throw new Error("low-dependency Markdown stage output is empty");
  const { task, run } = await currentRun(db, securityCode, attempt, runnerInstanceId);
  const artifacts = await loadGenericLlmRunArtifacts(db, run.runId);
  const existing = artifacts.find((artifact) => artifact.stepKey === definition.key);
  if (existing && statuses.has(existing.status)) return normalizeStage(definition, existing, run);
  const progress = row(run.progress);
  const normalizedLineage = normalizeLineage({ ...inferLineage(output), ...lineage });
  const artifact = await writeGenericLlmRunArtifact(db, {
    runId: run.runId, taskId: task.taskId, attempt, leaseOwner: text(runnerInstanceId), stepKey: definition.key,
    stageVersion: definition.schemaVersion, inputFingerprint: text(progress.inputFingerprint) || text(run.inputFingerprint) || null,
    upstreamArtifactIds: normalizedLineage.upstreamArtifactIds, sourceIds: normalizedLineage.sourceIds, claimIds: normalizedLineage.claimIds, evidenceIds: normalizedLineage.evidenceIds, unknownIds: normalizedLineage.unknownIds,
    outputType: definition.outputKind, status: status as "complete" | "partial" | "blocked" | "not_applicable" | "failed", output,
    structureValid: status === "complete", blocked: row(output).blockedItems || row(output).blockedValuationItems || row(output).analysisGaps || null, projectionVersion: LOW_DEPENDENCY_PROJECTION_VERSION,
    terminalMetadata: { input: progress.input, prompt: progress.prompt, stageVersion: definition.schemaVersion, inputFingerprint: text(progress.inputFingerprint) || text(run.inputFingerprint) || null, ...normalizedLineage, ...(row(metadata)), startedAt: progress.startedAt, attemptCount: attempt }, completedAt: Date.now(),
  });
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
    return artifact.stageVersion !== definition.schemaVersion || artifact.projectionVersion !== LOW_DEPENDENCY_PROJECTION_VERSION
      ? [{ stageKey: artifact.stepKey, stageVersion: artifact.stageVersion, projectionVersion: artifact.projectionVersion }]
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

function normalizeStage(definition: ResearchAnalysisStageDefinition, artifact: GenericLlmArtifact | undefined, run: GenericLlmRun | null) {
  if (!artifact) return normalizeQueuedStage(definition, run);
  const metadata = row(artifact.terminalMetadata);
  const startedAt = Number.isFinite(Number(metadata.startedAt)) ? Number(metadata.startedAt) : null;
  return { stageKey: definition.key, label: definition.label, owner: definition.owner, execution: definition.execution, outputKind: definition.outputKind, schemaVersion: definition.schemaVersion, dependsOn: definition.dependsOn, fallbackDependsOn: definition.fallbackDependsOn, status: artifact.status as LowDependencyResearchAnalysisStageStatus, artifactId: artifact.artifactId, runId: artifact.runId, sourceRunId: artifact.sourceRunId ?? null, reused: artifact.reused === true, upstreamArtifactIds: artifact.upstreamArtifactIds, sourceIds: artifact.sourceIds, claimIds: artifact.claimIds, evidenceIds: artifact.evidenceIds, unknownIds: artifact.unknownIds, inputFingerprint: artifact.inputFingerprint, stageVersion: artifact.stageVersion, projectionVersion: artifact.projectionVersion, attempt: run?.attempt ?? 0, attemptCount: Number(metadata.attemptCount) || run?.attempt || 0, startedAt, completedAt: artifact.completedAt, elapsedMs: startedAt === null ? null : Math.max(0, artifact.completedAt - startedAt), updatedAt: artifact.completedAt, lastError: artifact.errorMessage, output: artifact.output, blocked: artifact.blocked, prompt: normalizePrompt(metadata.prompt), input: metadata.input ?? null };
}

function normalizeQueuedStage(definition: ResearchAnalysisStageDefinition, run: GenericLlmRun | null) {
  const current = run?.currentStepKey === definition.key;
  const progress = row(run?.progress);
  const startedAt = current ? Number(progress.startedAt) || null : null;
  const currentStatus = run?.status === "failed" ? "failed" : run?.status === "blocked" ? "blocked" : "running";
  return { stageKey: definition.key, label: definition.label, owner: definition.owner, execution: definition.execution, outputKind: definition.outputKind, schemaVersion: definition.schemaVersion, dependsOn: definition.dependsOn, fallbackDependsOn: definition.fallbackDependsOn, status: current ? currentStatus : "queued", artifactId: null, runId: run?.runId ?? null, upstreamArtifactIds: [], sourceIds: [], claimIds: [], evidenceIds: [], unknownIds: [], inputFingerprint: text(progress.inputFingerprint) || null, stageVersion: definition.schemaVersion, projectionVersion: null, attempt: current ? run?.attempt ?? 0 : 0, attemptCount: current ? run?.attempt ?? 0 : 0, startedAt, completedAt: null, elapsedMs: null, updatedAt: current ? run?.progressUpdatedAt ?? null : null, lastError: current && run?.status !== "running" ? run.errorMessage : null, output: null, blocked: null, prompt: normalizePrompt(progress.prompt), input: progress.input ?? null };
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
