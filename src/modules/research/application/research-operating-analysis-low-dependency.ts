import {
  RESEARCH_OPERATING_ANALYSIS_TARGET_PROMPT_VERSION,
  RESEARCH_OPERATING_ANALYSIS_TARGET_PROTOCOL_VERSION,
  RESEARCH_OPERATING_ANALYSIS_TARGET_STAGES,
  RESEARCH_OPERATING_ANALYSIS_TARGET_TASK_TYPE,
  RESEARCH_OPERATING_ANALYSIS_STAGE_REGISTRY_VERSION,
  RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGES_VERSION,
  getResearchOperatingAnalysisStage,
  getResearchOperatingAnalysisWorkPackage,
  RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGES,
  workPackageForStage,
  researchOperatingAnalysisDependencies,
  researchOperatingAnalysisTaskIdentity,
  terminalResearchOperatingAnalysisStatuses,
  type ResearchAnalysisStageDefinition,
  type ResearchAnalysisStageKey,
  type ResearchAnalysisStageStatus,
  type ResearchAnalysisWorkPackageDefinition,
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
/** Code/registry boundary used by resume eligibility.  A run cannot mix
 * artifacts produced under a different stage registry with the current
 * pipeline, even when the generic prompt identity is unchanged. */
export const LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_CODE_VERSION = RESEARCH_OPERATING_ANALYSIS_STAGE_REGISTRY_VERSION;
export const LOW_DEPENDENCY_COORDINATOR_HANDLER_KEY = "research_operating_analysis_low_dependency_coordinator";
export const LOW_DEPENDENCY_STAGE_HANDLER_KEY = "research_operating_analysis_low_dependency_stage";
/** Match WebQA's selectable reasoning levels; the page and durable task use
 * the same default so a fresh task cannot silently fall back to another one. */
export const LOW_DEPENDENCY_DEFAULT_REASONING_EFFORT = "xhigh";
export type LowDependencyResearchAnalysisStageKey = ResearchAnalysisStageKey;
export type LowDependencyResearchAnalysisStageStatus = ResearchAnalysisStageStatus | "queued" | "running";

type Row = Record<string, unknown>;
type ModelPrompt = { model?: string; instructions: string; userPrompt: string };
type Lineage = { upstreamArtifactIds?: unknown; sourceIds?: unknown; claimIds?: unknown; evidenceIds?: unknown; unknownIds?: unknown };

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const row = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const statuses = new Set<string>(terminalResearchOperatingAnalysisStatuses());
export const LOW_DEPENDENCY_PROJECTION_VERSION = "research-artifact-projection.v1";
const successfulArtifactStatuses = new Set(["complete", "not_applicable"]);

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

export type LowDependencyResumeEligibility = {
  available: boolean;
  reason: "available" | "no_latest_failed_run" | "latest_run_not_failed" | "version_mismatch" | "no_reusable_stage_artifacts" | "no_failed_stages";
  runId: string | null;
  failedStageKeys: string[];
  reusableStageKeys: string[];
  promptVersion: string | null;
  codeVersion: string | null;
  currentPromptVersion: string;
  currentCodeVersion: string;
};

type ResumeStageVersionInput = {
  stageKey: string;
  status?: string | null;
  runStatus?: string | null;
  errorCode?: string | null;
  promptVersion?: string | null;
  stageVersion?: string | null;
  projectionVersion?: string | null;
  codeVersion?: string | null;
};

/**
 * Pure resume gate shared by the read model and the API mutation.  Resume is
 * intentionally narrower than targeted rerun: it is valid only for the
 * latest failed run, requires at least one current successful artifact to
 * retain, and rejects an explicitly recorded prompt/registry mismatch.
 */
export function evaluateLowDependencyResumeEligibility(input: {
  latestRunId?: string | null;
  latestRunStatus?: string | null;
  latestRunPromptVersion?: string | null;
  latestRunCodeVersion?: string | null;
  currentPromptVersion?: string;
  currentCodeVersion?: string;
  stages?: ResumeStageVersionInput[];
} = {}): LowDependencyResumeEligibility {
  const currentPromptVersion = text(input.currentPromptVersion) || LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_PROMPT_VERSION;
  const currentCodeVersion = text(input.currentCodeVersion) || LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_CODE_VERSION;
  const runId = text(input.latestRunId) || null;
  const latestRunStatus = text(input.latestRunStatus);
  const latestRunPromptVersion = text(input.latestRunPromptVersion) || null;
  const latestRunCodeVersion = text(input.latestRunCodeVersion) || null;
  const stages = Array.isArray(input.stages) ? input.stages : [];
  const failedStageKeys = stages
    .filter((stage) => text(stage.status) === "failed" || (text(stage.status) === "blocked" && (text(stage.runStatus) === "failed" || text(stage.errorCode) === "dependency_blocked")))
    .map((stage) => text(stage.stageKey))
    .filter(Boolean);
  const reusableStageKeys = stages
    .filter((stage) => successfulArtifactStatuses.has(text(stage.status)) && text(stage.runStatus) === "completed")
    .filter((stage) => {
      const definition = RESEARCH_OPERATING_ANALYSIS_TARGET_STAGES.find((item) => item.key === stage.stageKey);
      if (!definition || stage.stageVersion !== definition.schemaVersion || stage.projectionVersion !== LOW_DEPENDENCY_PROJECTION_VERSION) return false;
      if (stage.promptVersion !== currentPromptVersion || stage.codeVersion !== currentCodeVersion) return false;
      return stage.stageKey !== "report_assembly";
    })
    .map((stage) => text(stage.stageKey))
    .filter(Boolean);
  const explicitVersionMismatch = Boolean(
    latestRunPromptVersion !== currentPromptVersion
    || latestRunCodeVersion !== currentCodeVersion
    || stages.some((stage) => successfulArtifactStatuses.has(text(stage.status)) && (
      stage.promptVersion !== currentPromptVersion
      || stage.codeVersion !== currentCodeVersion
      || !RESEARCH_OPERATING_ANALYSIS_TARGET_STAGES.some((definition) => definition.key === stage.stageKey && definition.schemaVersion === stage.stageVersion)
      || stage.projectionVersion !== LOW_DEPENDENCY_PROJECTION_VERSION
    )),
  );
  const base = { runId, failedStageKeys: [...new Set(failedStageKeys)].sort(), reusableStageKeys: [...new Set(reusableStageKeys)].sort(), promptVersion: latestRunPromptVersion, codeVersion: latestRunCodeVersion, currentPromptVersion, currentCodeVersion };
  if (!runId) return { ...base, available: false, reason: "no_latest_failed_run" };
  if (latestRunStatus !== "failed") return { ...base, available: false, reason: "latest_run_not_failed" };
  if (explicitVersionMismatch) return { ...base, available: false, reason: "version_mismatch" };
  if (!base.failedStageKeys.length) return { ...base, available: false, reason: "no_failed_stages" };
  if (!base.reusableStageKeys.length) return { ...base, available: false, reason: "no_reusable_stage_artifacts" };
  return { ...base, available: true, reason: "available" };
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

/** Map stage-level invalidation requests to the smallest package closure. A
 * package is rerun as one provider request; downstream packages are rerun when
 * any package dependency is invalidated. */
function lowDependencyRerunWorkPackageClosure(stageKeys: string[]): string[] {
  const invalidatedStages = new Set(stageKeys);
  const packageKeys = new Set<string>();
  for (const definition of RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGES) {
    if (definition.stageKeys.some((stageKey) => invalidatedStages.has(stageKey))) packageKeys.add(definition.key);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const definition of RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGES) {
      if (!packageKeys.has(definition.key) && definition.dependsOn.some((dependency) => packageKeys.has(dependency))) {
        packageKeys.add(definition.key);
        changed = true;
      }
    }
  }
  return RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGES.map((definition) => definition.key).filter((key) => packageKeys.has(key));
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

function recordedCodeVersion(value: unknown): string | null {
  const metadata = row(value);
  return text(metadata.codeVersion || metadata.stageRegistryVersion || metadata.registryVersion) || null;
}

/**
 * A coordinator can retain compatibility children from the pre-package DAG.
 * Once any package child exists, package children are the authoritative
 * workflow and legacy children/artifacts must not leak into the current read
 * model or resume gate.
 */
function currentWorkflowChildren(children: GenericLlmTask[]): { children: GenericLlmTask[]; packageMode: boolean } {
  const packageChildren = children.filter((child) => Boolean(text(row(child.metadata).workPackageKey)));
  return packageChildren.length ? { children: packageChildren, packageMode: true } : { children, packageMode: false };
}

const WEBQA_EVIDENCE_SCHEMA_VERSION = "research-operating-analysis-webqa-evidence.v1";
/** Keep the report projection bounded even when a provider returns a very large
 * source list. Counts below still describe the complete provider answer. */
export const WEBQA_EVIDENCE_MAX_ITEMS = 100;
const WEBQA_EVIDENCE_TEXT_MAX_LENGTH = 1_200;
const WEBQA_EVIDENCE_TITLE_MAX_LENGTH = 500;
const WEBQA_EVIDENCE_URL_MAX_LENGTH = 2_048;

function nonNegativeCount(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function safeHttpsUrl(value: unknown): string | null {
  try {
    const parsed = new URL(text(value));
    if (parsed.protocol !== "https:") return null;
    const href = parsed.href;
    return href.length <= WEBQA_EVIDENCE_URL_MAX_LENGTH ? href : null;
  } catch { return null; }
}

type WebqaEvidenceItem = { text: string; title: string; url: string };

function normalizeEvidenceItems(value: unknown): WebqaEvidenceItem[] {
  if (!Array.isArray(value)) return [];
  const items: WebqaEvidenceItem[] = [];
  for (const candidate of value.slice(0, WEBQA_EVIDENCE_MAX_ITEMS)) {
    const source = row(candidate);
    const url = safeHttpsUrl(source.url);
    if (!url) continue;
    items.push({
      text: text(source.text).slice(0, WEBQA_EVIDENCE_TEXT_MAX_LENGTH),
      title: text(source.title).slice(0, WEBQA_EVIDENCE_TITLE_MAX_LENGTH),
      url,
    });
  }
  return items;
}

/** Keep the report API independent of raw provider JSON and answer bodies. */
export function normalizeFinalReportEvidence(value: unknown): Row | null {
  const source = row(value);
  if (!Object.keys(source).length) return null;
  const structured = typeof source.structuredAnswerAvailable === "boolean" ? source.structuredAnswerAvailable : null;
  const citations = normalizeEvidenceItems(source.citations);
  const sources = normalizeEvidenceItems(source.sources);
  return {
    schemaVersion: text(source.schemaVersion) || WEBQA_EVIDENCE_SCHEMA_VERSION,
    transport: text(source.transport) || null,
    provider: text(source.provider) || null,
    providerUrl: safeHttpsUrl(source.providerUrl),
    providerConversationId: text(source.providerConversationId) || null,
    gatewayTaskId: text(source.gatewayTaskId) || null,
    rawTaskId: text(source.rawTaskId) || null,
    rawRunId: text(source.rawRunId) || null,
    rawArtifactId: text(source.rawArtifactId) || null,
    citationCount: nonNegativeCount(source.citationCount) ?? (Array.isArray(source.citations) ? source.citations.length : null),
    sourceCount: nonNegativeCount(source.sourceCount) ?? (Array.isArray(source.sources) ? source.sources.length : null),
    structuredAnswerAvailable: structured,
    citations,
    sources,
  };
}

function evidenceFromRawModel({ rawTaskId, gatewayTaskId, rawRun, rawArtifact }: { rawTaskId: string; gatewayTaskId?: string | null; rawRun: GenericLlmRun | null; rawArtifact: GenericLlmArtifact | null }): Row | null {
  if (!rawRun && !rawArtifact) return null;
  const runMetadata = row(rawRun?.terminalMetadata);
  const artifactMetadata = row(rawArtifact?.terminalMetadata);
  const metadata = { ...artifactMetadata, ...runMetadata };
  const output = row(rawArtifact?.output);
  const answer = row(output.answer);
  const content = row(answer.content);
  const citations = Array.isArray(answer.citations) ? answer.citations : null;
  const sources = Array.isArray(answer.sources) ? answer.sources : null;
  const structured = Object.keys(answer).length > 0
    ? answer.formatVersion === "webqa.answer.v1"
      && typeof content.markdown === "string"
      && citations !== null
      && sources !== null
      && Object.keys(row(answer.rawSnapshot)).length > 0
    : null;
  return normalizeFinalReportEvidence({
    schemaVersion: WEBQA_EVIDENCE_SCHEMA_VERSION,
    transport: text(metadata.transport) || null,
    provider: text(metadata.provider) || text(output.provider) || null,
    providerUrl: metadata.providerUrl,
    providerConversationId: text(metadata.providerConversationId) || null,
    gatewayTaskId: text(metadata.gatewayTaskId) || gatewayTaskId || null,
    rawTaskId,
    rawRunId: rawRun?.runId || rawArtifact?.runId || null,
    rawArtifactId: rawArtifact?.artifactId || null,
    citationCount: nonNegativeCount(citations?.length),
    sourceCount: nonNegativeCount(sources?.length),
    structuredAnswerAvailable: structured,
    citations,
    sources,
  });
}

async function loadFinalReportEvidence(db: D1Database, reportMetadata: Row, childTask: GenericLlmTask | undefined, parentTask: GenericLlmTask | null): Promise<Row | null> {
  // New final-report runs persist this projection directly on report_assembly.
  const persisted = normalizeFinalReportEvidence(reportMetadata.evidence);
  if (persisted) return persisted;
  // Older/recovered rows only recorded the generic raw task on the final
  // report child/coordinator. Recover its terminal artifact without exposing
  // the raw provider payload through the report API.
  const childMetadata = row(childTask?.metadata);
  const parentMetadata = row(parentTask?.metadata);
  const rawTaskId = text(reportMetadata.rawTaskId)
    || text(reportMetadata.recoveryRawTaskId)
    || text(childMetadata.rawTaskId)
    || text(childMetadata.recoveryRawTaskId)
    || text(parentMetadata.rawTaskId)
    || text(parentMetadata.recoveryRawTaskId);
  if (!rawTaskId) return null;
  const rawTask = await loadGenericLlmTask(db, rawTaskId);
  const rawRun = rawTask?.lastRunId ? await loadGenericLlmRun(db, rawTask.lastRunId) : null;
  const artifacts = rawRun ? await loadGenericLlmRunArtifacts(db, rawRun.runId) : [];
  const rawArtifact = artifacts.filter((artifact) => artifact.stepKey === "raw_model").sort((left, right) => right.completedAt - left.completedAt)[0] || null;
  return evidenceFromRawModel({
    rawTaskId,
    gatewayTaskId: text(reportMetadata.gatewayTaskId)
      || text(reportMetadata.recoveryGatewayTaskId)
      || text(childMetadata.gatewayTaskId)
      || text(childMetadata.recoveryGatewayTaskId)
      || text(parentMetadata.gatewayTaskId)
      || text(parentMetadata.recoveryGatewayTaskId)
      || null,
    rawRun,
    rawArtifact,
  });
}

/** Read the latest coordinator boundary and the child terminal artifacts that
 * can survive it. This query never searches an older successful run when the
 * latest coordinator run is not failed; that is the latest-failed-only gate. */
export async function loadLowDependencyResumeEligibility(db: D1Database, securityCode: string): Promise<LowDependencyResumeEligibility> {
  const task = await loadTask(db, securityCode).catch((error) => {
    if (/no such table|no such column/i.test(String(error))) return null;
    throw error;
  });
  if (!task?.lastRunId) return evaluateLowDependencyResumeEligibility();
  const run = await loadGenericLlmRun(db, task.lastRunId);
  if (!run) return evaluateLowDependencyResumeEligibility({ latestRunId: task.lastRunId, latestRunStatus: null });
  const childSelection = currentWorkflowChildren(await loadGenericLlmChildTasks(db, task.taskId));
  const stageRows = await Promise.all(childSelection.children.filter((child) => text(child.stageKey)).map(async (child) => {
    const childRun = child.lastRunId ? await loadGenericLlmRun(db, child.lastRunId) : null;
    const artifacts = childRun ? await loadGenericLlmRunArtifacts(db, childRun.runId) : [];
    const metadata = row(child.metadata);
    const stageVersions = row(metadata.stageVersions);
    const stageKeys = Array.isArray(metadata.stageKeys) ? metadata.stageKeys.map(text).filter(Boolean) : [text(child.stageKey)];
    return stageKeys.map((stageKey) => {
      const artifact = artifacts.find((item) => item.stepKey === stageKey);
      const artifactMetadata = row(artifact?.terminalMetadata);
      return {
        stageKey,
        status: artifact?.status || child.status,
        runStatus: childRun?.status || null,
        errorCode: child.lastErrorCode || null,
        promptVersion: childRun?.promptVersion || child.promptVersion || null,
        stageVersion: artifact?.stageVersion || text(stageVersions[stageKey]) || null,
        projectionVersion: artifact?.projectionVersion || null,
        codeVersion: recordedCodeVersion(artifactMetadata) || recordedCodeVersion(metadata),
      } satisfies ResumeStageVersionInput;
    });
  }));
  const stages = stageRows.flat();
  return evaluateLowDependencyResumeEligibility({
    latestRunId: run.runId,
    latestRunStatus: run.status,
    latestRunPromptVersion: run.promptVersion,
    latestRunCodeVersion: recordedCodeVersion(run.terminalMetadata) || recordedCodeVersion(task.metadata),
    stages,
  });
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
      stageRegistryVersion: LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_CODE_VERSION,
      workPackageVersion: RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGES_VERSION,
      codeVersion: LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_CODE_VERSION,
      rerunStageKeys,
      scopeEnvelopeAvailable: options.scopeEnvelopeAvailable !== false,
    },
    now,
  });
  const parent = parentResult.task;
  const rerunPackageKeys = lowDependencyRerunWorkPackageClosure(rerunStageKeys);
  const byPackage = new Map<string, GenericLlmTask>();
  for (const definition of RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGES) {
    // The single-prompt workflow keeps the deterministic valuation contract in
    // the registry for compatibility, but does not materialize it as a
    // prerequisite.  The final Markdown package is the terminal report owner.
    if (definition.bypassed) continue;
    const executionMode = definition.execution === "deterministic" ? "engineering" as const : "model" as const;
    const dependencyIds = definition.dependsOn.map((key) => byPackage.get(key)?.taskId).filter((id): id is string => Boolean(id));
    const stageVersions = Object.fromEntries(definition.stageKeys.map((stageKey) => [stageKey, getResearchOperatingAnalysisStage(stageKey).schemaVersion]));
    const child = await createGenericLlmTask(db, {
      ...parentIdentity,
      taskType: `${LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_TASK_TYPE}_work_package`,
      idempotencyKey: `${parent.idempotencyKey}:work-package:${RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGES_VERSION}:${definition.key}`,
      handlerKey: LOW_DEPENDENCY_STAGE_HANDLER_KEY,
      executionMode,
      parentTaskId: parent.taskId,
      stageKey: definition.key,
      model: executionMode === "model" ? text(options.model) || "gpt-5.6-luna" : "engineering",
      reasoningEffort: executionMode === "model" ? text(options.reasoningEffort) || LOW_DEPENDENCY_DEFAULT_REASONING_EFFORT : null,
      dependsOnTaskIds: dependencyIds,
      metadata: {
        securityCode: code,
        parentTaskId: parent.taskId,
        workPackageKey: definition.key,
        workPackageVersion: RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGES_VERSION,
        stageKeys: definition.stageKeys,
        stageVersions,
        codeVersion: LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_CODE_VERSION,
        execution: definition.execution,
        outputKind: definition.outputKind,
        finalReport: definition.finalReport === true,
        bypassed: false,
        rerun: rerunPackageKeys.includes(definition.key),
      },
      now,
    });
    let childTask = child.task;
    if (rerunPackageKeys.includes(definition.key) && ["completed", "failed", "blocked"].includes(childTask.status)) {
      await requeueGenericLlmTask(db, childTask.taskId, now);
      childTask = (await loadGenericLlmTask(db, childTask.taskId)) || childTask;
    }
    if (childTask.status === "queued") {
      await db.prepare("update llm_tasks set requested_model=?, requested_reasoning_effort=?, handler_key=?, execution_mode=?, metadata_json=?, updated_at=? where task_id=? and status='queued'")
        .bind(executionMode === "model" ? text(options.model) || "gpt-5.6-luna" : "engineering", executionMode === "model" ? text(options.reasoningEffort) || LOW_DEPENDENCY_DEFAULT_REASONING_EFFORT : null, LOW_DEPENDENCY_STAGE_HANDLER_KEY, executionMode, JSON.stringify({ ...(row(childTask.metadata)), securityCode: code, parentTaskId: parent.taskId, workPackageKey: definition.key, workPackageVersion: RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGES_VERSION, stageKeys: definition.stageKeys, stageVersions, codeVersion: LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_CODE_VERSION, outputKind: definition.outputKind, execution: definition.execution, finalReport: definition.finalReport === true, bypassed: false, rerun: rerunPackageKeys.includes(definition.key) }), now, childTask.taskId).run();
      childTask = (await loadGenericLlmTask(db, childTask.taskId)) || childTask;
    }
    byPackage.set(definition.key, childTask);
  }
  // Edges are inserted after all child rows exist, allowing the registry to
  // remain declarative rather than coupling identity creation to task order.
  for (const definition of RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGES) {
    const child = byPackage.get(definition.key);
    if (!child) continue;
    const dependencyIds = definition.dependsOn.map((key) => byPackage.get(key)?.taskId).filter((id): id is string => Boolean(id));
    if (dependencyIds.length) await addGenericLlmTaskDependencies(db, child.taskId, dependencyIds, now);
  }
  return { parent, children: [...byPackage.values()] };
}

/** Requeue the route child and its blocked descendants after a validated S0.2
 * manual confirmation. Dependency reconciliation keeps descendants queued
 * until the route child reaches `completed`, so no model can run on an
 * unconfirmed scope projection. */
export async function unlockLowDependencyRoutingAfterConfirmation(db: D1Database, securityCode: string) {
  const task = await loadTask(db, securityCode);
  if (!task) return { requeued: [], requeuedStageKeys: [], parentRequeued: false };
  const children = await loadGenericLlmChildTasks(db, task.taskId);
  const byPackage = new Map<string, GenericLlmTask>();
  for (const child of children) {
    const metadata = row(child.metadata);
    const packageKey = text(metadata.workPackageKey) || text(child.stageKey);
    if (packageKey && !byPackage.has(packageKey)) byPackage.set(packageKey, child);
  }
  const invalidatedPackages = lowDependencyRerunWorkPackageClosure(["local_routing_match"]);
  const requeued: string[] = [];
  const requeuedStageKeys: string[] = [];
  for (const packageKey of invalidatedPackages) {
    const child = byPackage.get(packageKey);
    if (!child || !["completed", "failed", "blocked"].includes(child.status)) continue;
    const result = await db.prepare(`update llm_tasks set status='queued', last_run_id=null, last_error_code=null,
      last_error_message=null, started_at=null, completed_at=null, ready_at=null, updated_at=?
      where task_id=? and status in ('completed','failed','blocked')`).bind(Date.now(), child.taskId).run();
    if (result.meta.changes) {
      requeued.push(packageKey);
      const stageKeys = row(child.metadata).stageKeys;
      if (Array.isArray(stageKeys)) requeuedStageKeys.push(...stageKeys.map(text).filter(Boolean));
    }
  }
  await reconcileGenericLlmTaskDependencies(db);
  let parentRequeued = false;
  if (["completed", "failed", "blocked"].includes(task.status)) parentRequeued = await requeueGenericLlmTask(db, task.taskId);
  return { requeued, requeuedStageKeys: [...new Set(requeuedStageKeys)].sort(), parentRequeued };
}

export async function loadLowDependencyResearchOperatingAnalysis(db: D1Database, securityCode: string) {
  const code = text(securityCode).toUpperCase();
  try {
    const task = await loadTask(db, code);
    const run = task?.lastRunId ? await loadGenericLlmRun(db, task.lastRunId) : null;
    const childSelection = task ? currentWorkflowChildren(await loadGenericLlmChildTasks(db, task.taskId)) : { children: [], packageMode: false };
    const childRuns = new Map((await Promise.all(childSelection.children.map(async (child) => [child.taskId, child.lastRunId ? await loadGenericLlmRun(db, child.lastRunId) : null] as const))).map(([taskId, childRun]) => [taskId, childRun]));
    const childByWorkPackage = new Map<string, GenericLlmTask>();
    for (const child of childSelection.children) {
      const packageKey = text(row(child.metadata).workPackageKey);
      if (packageKey) childByWorkPackage.set(packageKey, child);
    }
    const childRunIds = new Set(childSelection.children.map((child) => text(child.lastRunId)).filter(Boolean));
    // New S0-S12 runs persist each stage on its own child task and expose the
    // terminal artifacts through workflow links. Keep reading the coordinator
    // run's same-task artifacts for compatibility with pre-DAG rows.
    const workflowArtifacts = task ? await loadGenericWorkflowArtifacts(db, task.taskId) : [];
    const currentWorkflowArtifacts = childSelection.packageMode
      ? workflowArtifacts.filter((artifact) => childRunIds.has(text(artifact.runId)))
      : workflowArtifacts;
    const legacyArtifacts = childSelection.packageMode || !run ? [] : await loadGenericLlmRunArtifacts(db, run.runId);
    const artifactProjection = new Map<string, GenericLlmArtifact>();
    for (const artifact of legacyArtifacts) artifactProjection.set(artifact.stepKey, artifact);
    for (const artifact of currentWorkflowArtifacts) artifactProjection.set(artifact.stepKey, artifact);
    const artifacts = [...artifactProjection.values()];
    // Package children own several legacy stages. Project each package child
    // onto every declared stage so the read model preserves the S1-S12 API
    // shape while preferring the current package task over old stage rows.
    const childByStage = new Map<string, GenericLlmTask>();
    const orderedChildren = [...childSelection.children].sort((left, right) => {
      const leftPackage = text(row(left.metadata).workPackageKey) ? 1 : 0;
      const rightPackage = text(row(right.metadata).workPackageKey) ? 1 : 0;
      return rightPackage - leftPackage;
    });
    for (const child of orderedChildren) {
      const metadata = row(child.metadata);
      const stageKeys = Array.isArray(metadata.stageKeys) ? metadata.stageKeys.map(text).filter(Boolean) : [];
      const ownedStages = stageKeys.length ? stageKeys : [text(child.stageKey)];
      for (const stageKey of ownedStages) if (stageKey && !childByStage.has(stageKey)) childByStage.set(stageKey, child);
    }
    const artifactByKey = new Map(artifacts.map((artifact) => [artifact.stepKey, artifact]));
    const stages = RESEARCH_OPERATING_ANALYSIS_TARGET_STAGES.map((definition) => normalizeStage(definition, artifactByKey.get(definition.key), run, childByStage.get(definition.key)));
    const workflowPackages = childSelection.packageMode
      ? RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGES.filter((definition) => !definition.bypassed).map((definition) => {
        const child = childByWorkPackage.get(definition.key);
        return normalizeWorkPackage(definition, child, child ? childRuns.get(child.taskId) || null : null);
      })
      : [];
    const resume = await loadLowDependencyResumeEligibility(db, code);
    const context = artifactByKey.get("research_context") || artifactByKey.get("engineering_baseline");
    const contextOutput = row(context?.output);
    const reportArtifact = artifactByKey.get("report_assembly");
    const reportMetadata = row(reportArtifact?.terminalMetadata);
    const reportStage = stages.find((stage) => stage.stageKey === "report_assembly");
    const reportEvidence = reportArtifact
      ? await loadFinalReportEvidence(db, reportMetadata, childByStage.get("report_assembly"), task)
      : null;
    const report = reportArtifact ? {
      status: reportStage?.status || reportArtifact.status,
      artifactId: reportArtifact.artifactId,
      markdown: reportStage?.status === "complete" && typeof reportArtifact.output === "string" ? reportArtifact.output : null,
      manifest: reportMetadata.reportManifest ?? null,
      projectionFingerprint: text(reportMetadata.projectionFingerprint) || null,
      blockers: Array.isArray(reportMetadata.blockers) ? reportMetadata.blockers : [],
      evidence: reportEvidence,
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
      workflowPackages,
      report,
      unknownStageKeys: [...new Set(unknownStageKeys)].sort(),
      contractErrors,
      finalArtifactId: reportStage?.status === "complete" ? reportArtifact?.artifactId ?? null : null,
      resume,
      resumeAvailable: resume.available,
    };
  } catch (error) {
    if (/no such table/i.test(String(error))) return { protocolVersion: LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_PROTOCOL_VERSION, promptVersion: LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_PROMPT_VERSION, availability: "unavailable" as const, scopeEnvelopeAvailable: false, task: null, run: null, stages: [], workflowPackages: [], report: null, unknownStageKeys: [], contractErrors: [], finalArtifactId: null, resume: evaluateLowDependencyResumeEligibility(), resumeAvailable: false };
    throw error;
  }
}

export async function enqueueLowDependencyResearchOperatingAnalysis(db: D1Database, securityCode: string, force = false, requestedReasoningEffort: unknown = LOW_DEPENDENCY_DEFAULT_REASONING_EFFORT, requestedModel: unknown = "gpt-5.6-luna", requestedStageKeys: unknown = undefined) {
  const code = text(securityCode).toUpperCase();
  if (!code) throw new Error("low-dependency research-analysis security code is required");
  // A forced refresh is a full regeneration boundary. Without an explicit
  // invalidation list, a newly claimed run can reuse a terminal artifact from
  // the previous run (including a blocked S0.2 route) before manual routing
  // confirmation is applied.
  const requestedRerunStageKeys = effectiveLowDependencyRefreshStageKeys(force, requestedStageKeys);
  // Materialization expands these legacy requests to the smallest package
  // dependency closure. Persist the caller's stage keys unchanged so the
  // package child can expose why it was requeued without pretending there are
  // one-task-per-stage model calls.
  const rerunStageKeys = normalizeLowDependencyRerunStageKeys(requestedRerunStageKeys);
  const now = Date.now();
  const created = await createGenericLlmTask(db, {
    ...taskIdentity(code), handlerKey: LOW_DEPENDENCY_COORDINATOR_HANDLER_KEY, executionMode: "engineering", model: "engineering", reasoningEffort: null,
    metadata: { securityCode: code, output: "low_dependency_operating_analysis", coordinator: true, stageRegistryVersion: LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_CODE_VERSION, rerunStageKeys }, now,
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
    reasoningEffort: text(requestedReasoningEffort) || LOW_DEPENDENCY_DEFAULT_REASONING_EFFORT,
    rerunStageKeys,
    scopeEnvelopeAvailable,
    now,
  });
  const currentMetadata = row(task.metadata);
  await db.prepare("update llm_tasks set requested_model=?, requested_reasoning_effort=?, handler_key=?, execution_mode='engineering', metadata_json=?, updated_at=? where task_id=? and status='queued'")
    .bind("engineering", null, LOW_DEPENDENCY_COORDINATOR_HANDLER_KEY, JSON.stringify({ ...currentMetadata, securityCode: code, output: "low_dependency_operating_analysis", coordinator: true, stageRegistryVersion: LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_CODE_VERSION, codeVersion: LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_CODE_VERSION, rerunStageKeys, childTaskIds: materialized.children.map((child) => child.taskId) }), now, task.taskId).run();
  return { ...(await loadLowDependencyResearchOperatingAnalysis(db, code)), shouldStart: true, deduplicated: !created.created, materialized: { parentTaskId: materialized.parent.taskId, childTaskIds: materialized.children.map((child) => child.taskId) } };
}

/**
 * Requeue only the failed child stages from the latest failed coordinator run
 * and the final deterministic report assembly. Successful siblings stay
 * terminal and are consumed through their existing workflow artifact links.
 */
export async function resumeLowDependencyResearchOperatingAnalysis(db: D1Database, securityCode: string, requestedReasoningEffort: unknown = LOW_DEPENDENCY_DEFAULT_REASONING_EFFORT, requestedModel: unknown = "gpt-5.6-luna", requestedRunId?: unknown) {
  const code = text(securityCode).toUpperCase();
  if (!code) throw new Error("low-dependency research-analysis security code is required");
  const eligibility = await loadLowDependencyResumeEligibility(db, code);
  const expectedRunId = text(requestedRunId);
  if (!eligibility.available) throw new Error(`low-dependency research-analysis resume is unavailable: ${eligibility.reason}`);
  if (expectedRunId && expectedRunId !== eligibility.runId) throw new Error("low-dependency research-analysis resume run is no longer the latest failed run");
  const task = await loadTask(db, code);
  if (!task || task.status !== "failed") throw new Error("low-dependency research-analysis resume requires a failed task");
  const now = Date.now();
  const requeuedParent = await requeueGenericLlmTask(db, task.taskId, now);
  if (!requeuedParent) throw new Error("low-dependency research-analysis latest failed run is no longer resumable");
  const rerunSet = new Set([...eligibility.failedStageKeys, "report_assembly"]);
  const rerunStageKeys = RESEARCH_OPERATING_ANALYSIS_TARGET_STAGES.map((definition) => definition.key).filter((key) => rerunSet.has(key));
  const metadata = row(task.metadata);
  const scopeEnvelopeAvailable = metadata.scopeEnvelopeAvailable !== false;
  const materialized = await materializeLowDependencyWorkflowTasks(db, code, {
    parentTaskId: task.taskId,
    model: text(requestedModel) || "gpt-5.6-luna",
    reasoningEffort: text(requestedReasoningEffort) || LOW_DEPENDENCY_DEFAULT_REASONING_EFFORT,
    rerunStageKeys,
    scopeEnvelopeAvailable,
    now,
  });
  await db.prepare("update llm_tasks set requested_model=?, requested_reasoning_effort=?, handler_key=?, execution_mode='engineering', metadata_json=?, updated_at=? where task_id=? and status='queued'")
    .bind("engineering", null, LOW_DEPENDENCY_COORDINATOR_HANDLER_KEY, JSON.stringify({ ...metadata, securityCode: code, output: "low_dependency_operating_analysis", coordinator: true, stageRegistryVersion: LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_CODE_VERSION, codeVersion: LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_CODE_VERSION, rerunStageKeys, resumeFromRunId: eligibility.runId, childTaskIds: materialized.children.map((child) => child.taskId) }), now, task.taskId).run();
  return {
    ...(await loadLowDependencyResearchOperatingAnalysis(db, code)),
    shouldStart: true,
    resumed: true,
    resumeFromRunId: eligibility.runId,
    resumeStageKeys: rerunStageKeys,
    materialized: { parentTaskId: materialized.parent.taskId, childTaskIds: materialized.children.map((child) => child.taskId) },
  };
}

export async function claimLowDependencyResearchOperatingAnalysisJob(db: D1Database, runnerInstanceId: string) {
  if (!await ownsResearchOperatingAnalysisRunnerLease(db, text(runnerInstanceId))) return null;
  const claim = await claimNextGenericLlmQueueTaskRun(db, text(runnerInstanceId), { taskType: LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_TASK_TYPE, executionMode: "engineering", protocolVersion: LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_PROTOCOL_VERSION, promptVersion: LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_PROMPT_VERSION });
  if (!claim || claim.task.targetType !== "security") return null;
  return { jobId: claim.task.taskId, taskId: claim.task.taskId, runId: claim.run.runId, securityCode: claim.task.targetId, model: claim.run.model, reasoningEffort: claim.run.reasoningEffort, promptVersion: claim.task.promptVersion, attempt: claim.run.attempt, lineageRunId: claim.run.lineageRunId, rerunStageKeys: normalizeLowDependencyRerunStageKeys(row(claim.task.metadata).rerunStageKeys) };
}

export async function startLowDependencyResearchOperatingAnalysisStage(db: D1Database, securityCode: string, stageKey: string, input: unknown, prompt: unknown, runnerInstanceId: string, attempt: number, lineage: Lineage = {}, allowReuse = true, taskId?: string, runId?: string) {
  const packageDefinition = tryGetWorkPackage(stageKey);
  if (packageDefinition) {
    const modelPrompt = normalizePrompt(prompt);
    if (packageDefinition.execution === "model" && !modelPrompt) throw new Error("low-dependency research-analysis work-package prompt is required");
    const { task, run } = await currentRunForTask(db, securityCode, taskId, runId, attempt, runnerInstanceId);
    assertTaskOwnsStage(task, packageDefinition.key);
    const artifacts = await loadGenericLlmRunArtifacts(db, run.runId);
    const terminalStages = packageDefinition.stageKeys.every((ownedStage) => {
      const artifact = artifacts.find((item) => item.stepKey === ownedStage);
      return artifact && statuses.has(artifact.status);
    });
    if (allowReuse && terminalStages) return { stageKey: packageDefinition.key, packageKey: packageDefinition.key, stageKeys: packageDefinition.stageKeys, status: "complete", runId: run.runId, taskId: task.taskId };
    const normalizedLineage = normalizeLineage(lineage);
    const inputFingerprint = text(row(input).inputFingerprint) || text(run.inputFingerprint) || null;
    const recorded = await recordGenericLlmRunProgress(db, {
      runId: run.runId, taskId: task.taskId, attempt, leaseOwner: text(runnerInstanceId), stepKey: packageDefinition.key,
      metadata: { input, prompt: modelPrompt, packageKey: packageDefinition.key, workPackageVersion: RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGES_VERSION, stageKeys: packageDefinition.stageKeys, stageVersions: Object.fromEntries(packageDefinition.stageKeys.map((key) => [key, getResearchOperatingAnalysisStage(key).schemaVersion])), inputFingerprint, ...normalizedLineage, startedAt: Date.now(), attemptCount: attempt, outputKind: packageDefinition.outputKind }, updatedAt: Date.now(),
    });
    if (!recorded) throw new Error("low-dependency research-analysis generic run lease is no longer owned by this runner");
    return { stageKey: packageDefinition.key, packageKey: packageDefinition.key, stageKeys: packageDefinition.stageKeys, status: "running", runId: run.runId, taskId: task.taskId };
  }
  const definition = getResearchOperatingAnalysisStage(stageKey);
  const modelPrompt = normalizePrompt(prompt);
  if (definition.execution === "model" && !modelPrompt) throw new Error("low-dependency research-analysis stage prompt is required");
  const { task, run } = await currentRunForTask(db, securityCode, taskId, runId, attempt, runnerInstanceId);
  assertTaskOwnsStage(task, definition.key);
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
  assertTaskOwnsStage(task, definition.key);
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
    terminalMetadata: { input: progress.input, prompt: progress.prompt, stageVersion: definition.schemaVersion, codeVersion: LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_CODE_VERSION, inputFingerprint: text(progress.inputFingerprint) || text(run.inputFingerprint) || null, ...normalizedLineage, ...(row(metadata)), startedAt: progress.startedAt, attemptCount: attempt }, completedAt: Date.now(),
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
  const childSelection = currentWorkflowChildren(await loadGenericLlmChildTasks(db, task.taskId));
  const finalReportMode = childSelection.children.some((child) => row(child.metadata).finalReport === true);
  const bypassedStageKeys = new Set(RESEARCH_OPERATING_ANALYSIS_WORK_PACKAGES.filter((definition) => definition.bypassed).flatMap((definition) => definition.stageKeys));
  const runArtifacts = await loadGenericLlmRunArtifacts(db, run.runId);
  const workflowArtifacts = await loadGenericWorkflowArtifacts(db, task.taskId);
  const byArtifactId = new Map<string, GenericLlmArtifact>();
  for (const artifact of [...runArtifacts, ...workflowArtifacts]) if (!byArtifactId.has(artifact.artifactId)) byArtifactId.set(artifact.artifactId, artifact);
  const artifacts = [...byArtifactId.values()];
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
  const missing = RESEARCH_OPERATING_ANALYSIS_TARGET_STAGES.filter((stage) => {
    if (bypassedStageKeys.has(stage.key)) return false;
    if (finalReportMode && stage.key !== "engineering_baseline" && stage.key !== "local_routing_match" && stage.key !== "report_assembly") return false;
    return !byKey.has(stage.key);
  }).map((stage) => stage.key);
  const report = byKey.get("report_assembly");
  const requestedStatus = text(reportStatus);
  const terminalStageStatuses = new Set(["complete", "not_applicable"]);
  const incomplete = RESEARCH_OPERATING_ANALYSIS_TARGET_STAGES.filter((stage) => {
    if (bypassedStageKeys.has(stage.key)) return false;
    if (finalReportMode && stage.key !== "engineering_baseline" && stage.key !== "local_routing_match" && stage.key !== "report_assembly") return false;
    return !terminalStageStatuses.has(byKey.get(stage.key)?.status || "");
  }).map((stage) => ({ stageKey: stage.key, status: byKey.get(stage.key)?.status || "missing" }));
  const reportMatches = Boolean(report && report.status === "complete" && (!reportArtifactId || report.artifactId === text(reportArtifactId)) && (!requestedStatus || requestedStatus === "complete"));
  const success = reportMatches && missing.length === 0 && duplicateKeys.length === 0 && incomplete.length === 0 && invalidStageContracts.length === 0;
  const now = Date.now();
  const terminalMetadata = {
    protocolVersion: LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_PROTOCOL_VERSION,
    codeVersion: LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_CODE_VERSION,
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
    terminalMetadata: { ...terminalMetadata, codeVersion: LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_CODE_VERSION },
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
    if (!artifacts.some((artifact) => artifact.stepKey === current)) await writeGenericLlmRunArtifact(db, { runId: run.runId, taskId: task.taskId, attempt, leaseOwner: text(runnerInstanceId), stepKey: current, stageVersion: getResearchOperatingAnalysisStage(current).schemaVersion, outputType: getResearchOperatingAnalysisStage(current).outputKind, status: "failed", errorCode: "low_dependency_stage_failed", errorMessage: message, projectionVersion: LOW_DEPENDENCY_PROJECTION_VERSION, terminalMetadata: { currentStepKey: current, codeVersion: LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_CODE_VERSION }, completedAt: Date.now() });
  }
  await failGenericLlmRun(db, { runId: run.runId, taskId: task.taskId, attempt, leaseOwner: text(runnerInstanceId), errorCode: "low_dependency_stage_failed", errorMessage: message, terminalMetadata: { currentStepKey: current, codeVersion: LOW_DEPENDENCY_RESEARCH_OPERATING_ANALYSIS_CODE_VERSION }, completedAt: Date.now() });
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

function tryGetWorkPackage(key: string) {
  try { return getResearchOperatingAnalysisWorkPackage(key); } catch { return null; }
}

function assertTaskOwnsStage(task: GenericLlmTask, stageKey: string) {
  const taskStageKey = text(task.stageKey);
  if (!taskStageKey) return;
  if (taskStageKey === stageKey) return;
  const metadata = row(task.metadata);
  const ownedStages = Array.isArray(metadata.stageKeys) ? metadata.stageKeys.map(text).filter(Boolean) : [];
  if (!ownedStages.includes(stageKey)) throw new Error("low-dependency child stage key does not match task");
}

/** This is the authoritative execution view. `stages` remains a compatibility
 * projection for recovery, while a work package maps one-to-one to a child
 * task/run and therefore to an actual model invocation. */
function normalizeWorkPackage(definition: ResearchAnalysisWorkPackageDefinition, childTask?: GenericLlmTask, childRun?: GenericLlmRun | null) {
  const progress = row(childRun?.progress);
  const startedAt = childRun?.startedAt ?? childTask?.startedAt ?? null;
  const completedAt = childRun?.completedAt ?? childTask?.completedAt ?? null;
  const status = definition.bypassed
    ? "not_applicable"
    : childTask?.status === "completed" ? "complete" : childTask?.status || "queued";
  return {
    key: definition.key,
    label: definition.label,
    execution: definition.execution,
    webSearch: definition.webSearch,
    finalReport: definition.finalReport === true,
    bypassed: definition.bypassed === true,
    stageKeys: definition.stageKeys,
    status,
    taskId: childTask?.taskId ?? null,
    runId: childRun?.runId ?? childTask?.lastRunId ?? null,
    model: childRun?.model ?? childTask?.requestedModel ?? null,
    reasoningEffort: childRun?.reasoningEffort ?? childTask?.requestedReasoningEffort ?? null,
    prompt: normalizePrompt(progress.prompt),
    startedAt,
    completedAt,
    elapsedMs: startedAt === null ? null : Math.max(0, (completedAt ?? Date.now()) - startedAt),
    updatedAt: childRun?.updatedAt ?? childTask?.updatedAt ?? null,
    lastError: childRun?.errorMessage ?? childTask?.lastErrorMessage ?? null,
  };
}

function normalizeStage(definition: ResearchAnalysisStageDefinition, artifact: GenericLlmArtifact | undefined, run: GenericLlmRun | null, childTask?: GenericLlmTask) {
  if (!artifact) return normalizeQueuedStage(definition, run, childTask);
  const metadata = row(artifact.terminalMetadata);
  const startedAt = Number.isFinite(Number(metadata.startedAt)) ? Number(metadata.startedAt) : null;
  const childStatus = childTask?.status === "queued" ? "queued" : childTask?.status === "running" ? "running" : childTask?.status === "blocked" ? "blocked" : childTask?.status === "failed" ? "failed" : null;
  return { stageKey: definition.key, label: definition.label, owner: definition.owner, execution: definition.execution, outputKind: definition.outputKind, schemaVersion: definition.schemaVersion, dependsOn: definition.dependsOn, fallbackDependsOn: definition.fallbackDependsOn, status: (childStatus || artifact.status) as LowDependencyResearchAnalysisStageStatus, taskId: childTask?.taskId ?? null, taskStatus: childTask?.status ?? null, parentTaskId: childTask?.parentTaskId ?? null, childRunId: childTask?.lastRunId ?? artifact.runId, artifactId: artifact.artifactId, runId: artifact.runId, sourceRunId: artifact.sourceRunId ?? null, reused: artifact.reused === true, upstreamArtifactIds: artifact.upstreamArtifactIds, sourceIds: artifact.sourceIds, claimIds: artifact.claimIds, evidenceIds: artifact.evidenceIds, unknownIds: artifact.unknownIds, inputFingerprint: artifact.inputFingerprint, stageVersion: artifact.stageVersion, projectionVersion: artifact.projectionVersion, attempt: run?.attempt ?? 0, attemptCount: Number(metadata.attemptCount) || run?.attempt || 0, startedAt, completedAt: artifact.completedAt, elapsedMs: startedAt === null ? null : Math.max(0, artifact.completedAt - startedAt), updatedAt: artifact.completedAt, lastError: artifact.errorMessage || childTask?.lastErrorMessage || null, output: artifact.output, blocked: artifact.blocked, validationFailure: metadata.validationFailure ?? null, prompt: normalizePrompt(metadata.prompt), input: metadata.input ?? null };
}

function normalizeQueuedStage(definition: ResearchAnalysisStageDefinition, run: GenericLlmRun | null, childTask?: GenericLlmTask) {
  const packageMetadata = row(childTask?.metadata);
  if (packageMetadata.finalReport === true && definition.key !== "report_assembly") {
    return { stageKey: definition.key, label: definition.label, owner: definition.owner, execution: definition.execution, outputKind: definition.outputKind, schemaVersion: definition.schemaVersion, dependsOn: definition.dependsOn, fallbackDependsOn: definition.fallbackDependsOn, status: "not_applicable", taskId: childTask?.taskId ?? null, taskStatus: childTask?.status ?? null, parentTaskId: childTask?.parentTaskId ?? null, childRunId: childTask?.lastRunId ?? null, artifactId: null, runId: childTask?.lastRunId ?? run?.runId ?? null, upstreamArtifactIds: [], sourceIds: [], claimIds: [], evidenceIds: [], unknownIds: [], inputFingerprint: null, stageVersion: definition.schemaVersion, projectionVersion: null, attempt: childTask?.lastRunId ? 1 : 0, attemptCount: 0, startedAt: null, completedAt: childTask?.completedAt ?? null, elapsedMs: null, updatedAt: childTask?.updatedAt ?? null, lastError: null, output: null, blocked: null, prompt: null, input: null };
  }
  if (workPackageForStage(definition.key)?.bypassed === true) {
    return { stageKey: definition.key, label: definition.label, owner: definition.owner, execution: definition.execution, outputKind: definition.outputKind, schemaVersion: definition.schemaVersion, dependsOn: definition.dependsOn, fallbackDependsOn: definition.fallbackDependsOn, status: "not_applicable", taskId: null, taskStatus: null, parentTaskId: null, childRunId: null, artifactId: null, runId: run?.runId ?? null, upstreamArtifactIds: [], sourceIds: [], claimIds: [], evidenceIds: [], unknownIds: [], inputFingerprint: null, stageVersion: definition.schemaVersion, projectionVersion: null, attempt: 0, attemptCount: 0, startedAt: null, completedAt: null, elapsedMs: null, updatedAt: null, lastError: null, output: null, blocked: null, prompt: null, input: null };
  }
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
