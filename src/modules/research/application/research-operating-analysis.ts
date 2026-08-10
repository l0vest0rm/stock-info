import { ownsResearchOperatingAnalysisRunnerLease } from "./research-operating-analysis-runner-lease";
import {
  claimNextGenericLlmTaskRun,
  completeGenericLlmRun,
  createGenericLlmTask,
  failGenericLlmRun,
  heartbeatGenericLlmRun,
  loadGenericLlmRun,
  loadGenericLlmRunArtifacts,
  loadGenericLlmTaskByIdentity,
  recordGenericLlmRunProgress,
  requeueExpiredGenericLlmRun,
  requeueGenericLlmTask,
  writeGenericLlmRunArtifact,
  type GenericLlmArtifact,
  type GenericLlmRun,
  type GenericLlmTask,
} from "../../../shared/local-job-protocol";

type Row = Record<string, unknown>;
type ModelPrompt = { model?: string; instructions: string; userPrompt: string };
export type OperatingAnalysisStageKey = "company_baseline" | "industry_validation" | "operating_analysis" | "financial_analysis" | "valuation_inputs" | "valuation_conclusion";
export type OperatingAnalysisStageStatus = "queued" | "running" | "complete" | "partial" | "blocked" | "not_applicable" | "failed";

/** A task is six resumable model calls plus a deterministic calculation between 5 and 6. */
export const OPERATING_ANALYSIS_PROMPT_VERSION = "investment-analysis.staged.v1";
export const OPERATING_ANALYSIS_DEFAULT_MODEL = "gpt-5.6-luna";
export const OPERATING_ANALYSIS_DEFAULT_REASONING_EFFORT = "max";
export const OPERATING_ANALYSIS_STAGES: ReadonlyArray<{ key: OperatingAnalysisStageKey; label: string; output: "json" | "markdown"; webSearch: boolean }> = [
  { key: "company_baseline", label: "1. 公司事实基线", output: "json", webSearch: true },
  { key: "industry_validation", label: "2. 行业、产业链与外部验证", output: "json", webSearch: true },
  { key: "operating_analysis", label: "3. 经营、增长与竞争分析", output: "markdown", webSearch: false },
  { key: "financial_analysis", label: "4. 财务、资本、治理与生存能力", output: "markdown", webSearch: false },
  { key: "valuation_inputs", label: "5. 情景假设、估值输入与风险结构", output: "json", webSearch: false },
  { key: "valuation_conclusion", label: "6. 估值解释、反证与最终结论", output: "markdown", webSearch: false },
] as const;
export const OPERATING_ANALYSIS_REQUIRED_HEADINGS = [
  "# 2. 公司概况与商业模式", "# 3. 行业与产业链", "# 4. 公司竞争地位", "# 5. 增长、驱动与可持续性",
  "# 6. 利润质量、现金转换与营运资本", "# 7. 资本效率、管理层治理与资本配置", "# 8. 资产负债表与压力测试",
  "# 9. 估值与市场隐含经营要求", "# 10. 核心风险与反面证据", "# 11. 后续跟踪仪表盘", "# 12. 最终结论",
] as const;

const GENERIC_TASK_TYPE = "research_operating_analysis";
const GENERIC_TARGET_TYPE = "security";
const GENERIC_IDEMPOTENCY_PREFIX = "research-operating-analysis:";
const reasoningEfforts = new Set(["none", "low", "medium", "high", "xhigh", "max"]);
const operatingAnalysisModels = new Set(["gpt-5.4-mini", "gpt-5.6-luna"]);
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const row = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};

function model(value: unknown) {
  const selected = text(value) || OPERATING_ANALYSIS_DEFAULT_MODEL;
  if (!operatingAnalysisModels.has(selected)) throw new Error("unsupported operating-analysis model");
  return selected;
}

function reasoningEffort(value: unknown) {
  const effort = text(value) || OPERATING_ANALYSIS_DEFAULT_REASONING_EFFORT;
  if (!reasoningEfforts.has(effort)) throw new Error("unsupported operating-analysis reasoning effort");
  return effort;
}

function taskIdentity(code: string) {
  return {
    taskType: GENERIC_TASK_TYPE,
    targetType: GENERIC_TARGET_TYPE,
    targetId: code,
    idempotencyKey: `${GENERIC_IDEMPOTENCY_PREFIX}${code}`,
    promptVersion: OPERATING_ANALYSIS_PROMPT_VERSION,
  } as const;
}

async function operatingTask(db: D1Database, securityCode: string): Promise<GenericLlmTask | null> {
  const code = securityCode.trim().toUpperCase();
  return loadGenericLlmTaskByIdentity(db, taskIdentity(code));
}

async function currentRun(db: D1Database, securityCode: string, attempt?: number, runnerInstanceId?: string): Promise<{ task: GenericLlmTask; run: GenericLlmRun }> {
  const task = await operatingTask(db, securityCode);
  if (!task || !task.lastRunId) throw new Error("operating-analysis generic task run not found");
  const run = await loadGenericLlmRun(db, task.lastRunId);
  if (!run || run.taskId !== task.taskId) throw new Error("operating-analysis generic task run not found");
  if (attempt !== undefined && (run.attempt !== attempt || run.status !== "running" || run.leaseOwner !== text(runnerInstanceId) || (run.leaseUntil ?? 0) < Date.now())) {
    throw new Error("operating-analysis generic run lease is no longer owned by this runner");
  }
  return { task, run };
}

export async function loadResearchOperatingAnalysis(db: D1Database, securityCode: string) {
  const code = securityCode.trim().toUpperCase();
  try {
    const task = await operatingTask(db, code);
    const activeRun = task?.lastRunId ? await loadGenericLlmRun(db, task.lastRunId) : null;
    const artifacts = activeRun ? await loadGenericLlmRunArtifacts(db, activeRun.runId) : [];
    const [run, versions] = await Promise.all([
      findResearchOperatingAnalysisRun(db, code),
      db.prepare(`select run_id as runId, prompt_version as promptVersion, provider, generated_at as generatedAt, total_duration_ms as totalDurationMs
        from research_operating_analysis_runs where security_code=? and prompt_version=? order by generated_at desc`).bind(code, OPERATING_ANALYSIS_PROMPT_VERSION).all<Row>(),
    ]);
    const stageMap = new Map(artifacts.map((item) => [item.stepKey, normalizeGenericStage(item, activeRun)]));
    const stageReadModel = OPERATING_ANALYSIS_STAGES.map((definition) => stageMap.get(definition.key) || normalizeQueuedStage(definition, activeRun));
    const job = task ? normalizeGenericJob(task, activeRun, stageReadModel) : null;
    return {
      availability: run || task || artifacts.length ? "available" as const : "empty" as const,
      run: normalizeResearchOperatingAnalysisRun(run),
      job,
      versions: versions.results,
    };
  } catch (error) {
    if (/no such table/i.test(String(error))) return { availability: "unavailable" as const, run: null, job: null, versions: [] as Row[] };
    throw error;
  }
}

function normalizeQueuedStage(definition: typeof OPERATING_ANALYSIS_STAGES[number], activeRun: GenericLlmRun | null) {
  const current = activeRun?.currentStepKey === definition.key;
  const status: OperatingAnalysisStageStatus = current ? (activeRun?.status === "failed" ? "failed" : "running") : "queued";
  const progress = row(activeRun?.progress);
  const metadata = row(progress);
  return {
    stageKey: definition.key, status, label: definition.label, outputKind: definition.output,
    attemptCount: current ? activeRun?.attempt || 0 : 0, attempt: current ? activeRun?.attempt || 0 : 0,
    startedAt: current ? finiteTimestamp(metadata.startedAt) : null,
    completedAt: null, updatedAt: current ? activeRun?.progressUpdatedAt : null,
    lastError: current && activeRun?.status === "failed" ? activeRun.errorMessage : null,
    output: null, prompt: normalizeModelPrompt(metadata.prompt), input: metadata.input ?? null, blocked: null,
  };
}

function normalizeGenericStage(source: GenericLlmArtifact, activeRun: GenericLlmRun | null) {
  const definition = OPERATING_ANALYSIS_STAGES.find((item) => item.key === source.stepKey);
  const metadata = row(source.terminalMetadata);
  return {
    stageKey: source.stepKey, status: source.status as OperatingAnalysisStageStatus, label: definition?.label || source.stepKey,
    outputKind: definition?.output || source.outputType, attemptCount: finiteTimestamp(metadata.attemptCount) ?? activeRun?.attempt ?? 0,
    attempt: activeRun?.attempt ?? 0, leaseOwner: activeRun?.leaseOwner ?? null, leaseUntil: activeRun?.leaseUntil ?? null,
    startedAt: finiteTimestamp(metadata.startedAt), completedAt: source.completedAt, updatedAt: source.completedAt,
    lastError: source.errorMessage, output: source.output, prompt: normalizeModelPrompt(metadata.prompt), input: metadata.input ?? null,
    blocked: source.blocked,
  };
}

function normalizeGenericJob(task: GenericLlmTask, run: GenericLlmRun | null, stages: unknown[]) {
  const progress = row(run?.progress);
  const terminalMetadata = row(run?.terminalMetadata);
  return {
    jobId: task.taskId, taskId: task.taskId, jobType: task.taskType, securityCode: task.targetId, promptVersion: task.promptVersion,
    status: task.status, runId: task.lastRunId, attemptCount: run?.attempt ?? 0, attempt: run?.attempt ?? 0,
    leaseOwner: run?.leaseOwner ?? null, leaseUntil: run?.leaseUntil ?? null, heartbeatAt: run?.heartbeatAt ?? null,
    model: run?.model || task.requestedModel, reasoningEffort: run?.reasoningEffort || task.requestedReasoningEffort,
    lastError: task.lastErrorMessage || run?.errorMessage || null, createdAt: task.createdAt, startedAt: run?.startedAt ?? task.startedAt,
    completedAt: task.completedAt, updatedAt: Math.max(task.updatedAt, run?.updatedAt || 0),
    prompt: normalizeModelPrompt(run?.prompt || progress.prompt), progress: run?.progress ?? null, currentStepKey: run?.currentStepKey ?? null,
    streamStats: terminalMetadata.streamStats ?? null, stages,
  };
}

export async function loadResearchOperatingAnalysisRun(db: D1Database, securityCode: string, runId: string) {
  try { return normalizeResearchOperatingAnalysisRun(await findResearchOperatingAnalysisRun(db, securityCode.trim().toUpperCase(), runId.trim())); }
  catch (error) { if (/no such table/i.test(String(error))) return null; throw error; }
}

function findResearchOperatingAnalysisRun(db: D1Database, code: string, runId?: string) {
  return db.prepare(`select run_id as runId, security_code as securityCode, prompt_version as promptVersion, input_fingerprint as inputFingerprint,
    input_as_of as inputAsOf, input_json as inputJson, report_markdown as reportMarkdown, reasoning_markdown as reasoningMarkdown,
    total_duration_ms as totalDurationMs, stream_stats_json as streamStatsJson, prompt_json as promptJson, provider, generated_at as generatedAt
    from research_operating_analysis_runs where security_code=? and prompt_version=?${runId ? " and run_id=?" : ""} order by generated_at desc limit 1`)
    .bind(code, OPERATING_ANALYSIS_PROMPT_VERSION, ...(runId ? [runId] : [])).first<Row>();
}

function normalizeResearchOperatingAnalysisRun(run: Row | null) {
  return run ? { ...run, input: parseJson(text(run.inputJson)), prompt: normalizeModelPrompt(parseJson(text(run.promptJson))), streamStats: parseJson(text(run.streamStatsJson)) } : null;
}

export async function enqueueResearchOperatingAnalysis(db: D1Database, securityCode: string, force = false, requestedReasoningEffort: unknown = OPERATING_ANALYSIS_DEFAULT_REASONING_EFFORT, requestedModel: unknown = OPERATING_ANALYSIS_DEFAULT_MODEL) {
  const code = securityCode.trim().toUpperCase();
  const effort = reasoningEffort(requestedReasoningEffort);
  const selectedModel = model(requestedModel);
  const now = Date.now();
  const created = await createGenericLlmTask(db, {
    ...taskIdentity(code), handlerKey: GENERIC_TASK_TYPE, model: selectedModel, reasoningEffort: effort,
    metadata: { securityCode: code, output: "staged_operating_analysis" }, now,
  });
  let task = created.task;
  if (task.status === "completed" && !force) return { ...(await loadResearchOperatingAnalysis(db, code)), shouldStart: false, deduplicated: true };
  if (task.status === "running") return { ...(await loadResearchOperatingAnalysis(db, code)), shouldStart: false, deduplicated: true };
  if (task.status === "failed" || task.status === "blocked" || (task.status === "completed" && force)) {
    await requeueGenericLlmTask(db, task.taskId, now);
    task = (await operatingTask(db, code)) || task;
  }
  if (task.status !== "queued") return { ...(await loadResearchOperatingAnalysis(db, code)), shouldStart: false, deduplicated: true };
  await db.prepare(`update llm_tasks set requested_model=?, requested_reasoning_effort=?, updated_at=? where task_id=? and status='queued'`)
    .bind(selectedModel, effort, now, task.taskId).run();
  return { ...(await loadResearchOperatingAnalysis(db, code)), shouldStart: true, deduplicated: !created.created };
}

/** Claim the generic task/run while retaining the runner lease as a local safety gate. */
export async function claimResearchOperatingAnalysisJob(db: D1Database, runnerInstanceId: string) {
  if (!await ownsResearchOperatingAnalysisRunnerLease(db, runnerInstanceId)) return null;
  const claim = await claimNextGenericLlmTaskRun(db, runnerInstanceId.trim());
  if (!claim || claim.task.targetType !== GENERIC_TARGET_TYPE) return null;
  const code = claim.task.targetId;
  return {
    jobId: claim.task.taskId, taskId: claim.task.taskId, runId: claim.run.runId, securityCode: code,
    model: model(claim.run.model), reasoningEffort: reasoningEffort(claim.run.reasoningEffort),
    promptVersion: claim.task.promptVersion, attempt: claim.run.attempt,
  };
}

export async function startResearchOperatingAnalysisStage(db: D1Database, securityCode: string, stageKey: OperatingAnalysisStageKey, input: unknown, prompt: unknown, runnerInstanceId: string, attempt: number) {
  assertStage(stageKey);
  const modelPrompt = normalizeModelPrompt(prompt);
  if (!modelPrompt) throw new Error("operating analysis stage prompt is required");
  const { task, run } = await currentRun(db, securityCode, attempt, runnerInstanceId);
  const artifacts = await loadGenericLlmRunArtifacts(db, run.runId);
  const existing = artifacts.find((artifact) => artifact.stepKey === stageKey);
  if (existing && ["complete", "partial", "blocked", "not_applicable", "failed"].includes(existing.status)) return normalizeGenericStage(existing, run);
  const now = Date.now();
  const progress = row(run.progress);
  const startedAt = run.currentStepKey === stageKey && finiteTimestamp(progress.startedAt) !== null ? finiteTimestamp(progress.startedAt)! : now;
  const recorded = await recordGenericLlmRunProgress(db, {
    runId: run.runId, taskId: task.taskId, attempt, leaseOwner: runnerInstanceId.trim(), stepKey: stageKey,
    metadata: { input, prompt: modelPrompt, startedAt, attemptCount: attempt, outputType: OPERATING_ANALYSIS_STAGES.find((item) => item.key === stageKey)?.output }, updatedAt: now,
  });
  if (!recorded) throw new Error("operating-analysis generic run lease is no longer owned by this runner");
  return normalizeQueuedStage(OPERATING_ANALYSIS_STAGES.find((item) => item.key === stageKey)!, await loadGenericLlmRun(db, run.runId));
}

export async function completeResearchOperatingAnalysisStage(db: D1Database, securityCode: string, stageKey: OperatingAnalysisStageKey, output: unknown, status: OperatingAnalysisStageStatus, runnerInstanceId: string, attempt: number) {
  assertStage(stageKey);
  if (!["complete", "partial", "blocked", "not_applicable"].includes(status)) throw new Error("invalid terminal operating-analysis stage status");
  const definition = OPERATING_ANALYSIS_STAGES.find((item) => item.key === stageKey)!;
  const markdown = definition.output === "markdown" ? text(output) : null;
  if (definition.output === "markdown" && !markdown) throw new Error("operating-analysis Markdown stage output is empty");
  if (definition.output === "json" && (!output || typeof output !== "object" || Array.isArray(output))) throw new Error("operating-analysis JSON stage output is invalid");
  const { task, run } = await currentRun(db, securityCode, attempt, runnerInstanceId);
  const artifacts = await loadGenericLlmRunArtifacts(db, run.runId);
  const existing = artifacts.find((artifact) => artifact.stepKey === stageKey);
  if (existing && ["complete", "partial", "blocked", "not_applicable", "failed"].includes(existing.status)) return normalizeGenericStage(existing, run);
  const progress = row(run.progress);
  const blocked = definition.output === "json" && output && typeof output === "object" && !Array.isArray(output)
    ? (row(output).blockedValuationItems ?? row(output).blockedItems ?? row(output).unknowns ?? null) : null;
  const artifact = await writeGenericLlmRunArtifact(db, {
    runId: run.runId, taskId: task.taskId, attempt, leaseOwner: runnerInstanceId.trim(), stepKey: stageKey,
    outputType: definition.output, status: status as "complete" | "partial" | "blocked" | "not_applicable", output, structureValid: status === "complete", blocked,
    terminalMetadata: { input: progress.input, prompt: progress.prompt, startedAt: progress.startedAt, attemptCount: attempt }, completedAt: Date.now(),
  });
  return normalizeGenericStage(artifact, run);
}

export async function completeResearchOperatingAnalysisJob(db: D1Database, securityCode: string, input: unknown, prompt: unknown, reportMarkdown: string, reasoningMarkdown: string, inputFingerprint: string, runnerInstanceId: string, attempt: number, streamStats?: unknown) {
  const code = securityCode.trim().toUpperCase();
  const report = reportMarkdown.trim();
  const modelPrompt = normalizeModelPrompt(prompt);
  const missing = OPERATING_ANALYSIS_REQUIRED_HEADINGS.filter((heading) => !report.includes(heading));
  if (!report || missing.length) throw new Error(`operating analysis report is incomplete; missing sections: ${missing.join(", ")}`);
  if (!modelPrompt || !inputFingerprint.trim()) throw new Error("operating analysis completion is missing prompt or fingerprint");
  const { task, run } = await currentRun(db, code, attempt, runnerInstanceId);
  const now = Date.now();
  const totalDurationMs = Math.max(0, now - run.startedAt);
  await db.prepare(`insert or ignore into research_operating_analysis_runs (run_id,security_code,prompt_version,input_fingerprint,input_as_of,input_json,report_markdown,reasoning_markdown,total_duration_ms,stream_stats_json,prompt_json,provider,generated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(run.runId, code, OPERATING_ANALYSIS_PROMPT_VERSION, inputFingerprint, now, JSON.stringify(input), report, reasoningMarkdown.trim(), totalDurationMs, streamStats ? JSON.stringify(streamStats) : null, JSON.stringify(modelPrompt), run.provider, now).run();
  await completeGenericLlmRun(db, {
    runId: run.runId, taskId: task.taskId, attempt, leaseOwner: runnerInstanceId.trim(), status: "completed",
    terminalMetadata: { reportProjection: "research_operating_analysis_runs", streamStats: streamStats ?? null }, completedAt: now,
  });
  return await loadResearchOperatingAnalysis(db, code);
}

export async function failResearchOperatingAnalysisJob(db: D1Database, securityCode: string, error: unknown, runnerInstanceId: string, attempt: number) {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1600);
  const { task, run } = await currentRun(db, securityCode, attempt, runnerInstanceId);
  const currentStageKey = run.currentStepKey;
  if (currentStageKey && OPERATING_ANALYSIS_STAGES.some((item) => item.key === currentStageKey)) {
    const artifacts = await loadGenericLlmRunArtifacts(db, run.runId);
    if (!artifacts.some((artifact) => artifact.stepKey === currentStageKey)) {
      const progress = row(run.progress);
      await writeGenericLlmRunArtifact(db, {
        runId: run.runId, taskId: task.taskId, attempt, leaseOwner: runnerInstanceId.trim(), stepKey: currentStageKey,
        outputType: OPERATING_ANALYSIS_STAGES.find((item) => item.key === currentStageKey)!.output, status: "failed",
        errorCode: "operating_analysis_failed", errorMessage: message,
        terminalMetadata: { input: progress.input, prompt: progress.prompt, startedAt: progress.startedAt, attemptCount: attempt }, completedAt: Date.now(),
      });
    }
  }
  await failGenericLlmRun(db, {
    runId: run.runId, taskId: task.taskId, attempt, leaseOwner: runnerInstanceId.trim(), errorCode: "operating_analysis_failed", errorMessage: message,
    terminalMetadata: { currentStepKey: currentStageKey }, completedAt: Date.now(),
  });
  return await loadResearchOperatingAnalysis(db, securityCode);
}

/** A transport outage can only be requeued after the generic run lease expires. */
export async function requeueInterruptedResearchOperatingAnalysisJob(db: D1Database, securityCode: string, _error: unknown, runnerInstanceId: string, attempt: number) {
  const context = await currentRun(db, securityCode).catch(() => null);
  const now = Date.now();
  if (!context || context.run.status !== "running" || context.run.attempt !== attempt || context.run.leaseOwner !== text(runnerInstanceId) || (context.run.leaseUntil ?? 0) >= now) return false;
  return requeueExpiredGenericLlmRun(db, {
    runId: context.run.runId,
    taskId: context.task.taskId,
    attempt,
    leaseOwner: text(runnerInstanceId),
    errorMessage: `local Node runtime interrupted this runner; continuing from the last completed stage: ${_error instanceof Error ? _error.message : String(_error)}`.slice(0, 1600),
    now,
  });
}

export async function heartbeatResearchOperatingAnalysisJob(db: D1Database, securityCode: string, runnerInstanceId: string, attempt: number) {
  const context = await currentRun(db, securityCode).catch(() => null);
  if (!context) return false;
  return heartbeatGenericLlmRun(db, context.run.runId, context.task.taskId, attempt, runnerInstanceId.trim());
}

function assertStage(value: string): asserts value is OperatingAnalysisStageKey { if (!OPERATING_ANALYSIS_STAGES.some((stage) => stage.key === value)) throw new Error("unsupported operating-analysis stage"); }
function parseJson(value: string): unknown { try { return JSON.parse(value); } catch { return null; } }
function normalizeModelPrompt(value: unknown): ModelPrompt | null { const source = row(value); const instructions = text(source.instructions); const userPrompt = text(source.userPrompt); const model = text(source.model); return instructions && userPrompt ? { ...(model ? { model } : {}), instructions, userPrompt } : null; }
function finiteTimestamp(value: unknown): number | null { const number = Number(value); return Number.isFinite(number) && number >= 0 ? number : null; }
