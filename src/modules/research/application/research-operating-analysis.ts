import { RESEARCH_OPERATING_ANALYSIS_RUNNER_LEASE_MS, RESEARCH_OPERATING_ANALYSIS_RUNNER_LEASE_NAME, ownsResearchOperatingAnalysisRunnerLease } from "./research-operating-analysis-runner-lease";
import { localJobLeaseUntil, reconcileLocalJobProviderSlots, releaseLocalJobProviderSlot, renewLocalJobLease, reserveLocalJobProviderSlot } from "../../../shared/local-job-protocol";

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

export async function loadResearchOperatingAnalysis(db: D1Database, securityCode: string) {
  const code = securityCode.trim().toUpperCase();
  try {
    const [run, job, versions, stages] = await Promise.all([
      findResearchOperatingAnalysisRun(db, code),
      db.prepare(`select job_id as jobId, job_type as jobType, security_code as securityCode, prompt_version as promptVersion, status, run_id as runId, attempt_count as attemptCount, attempt, lease_owner as leaseOwner, lease_until as leaseUntil, heartbeat_at as heartbeatAt,
        model, reasoning_effort as reasoningEffort, last_error as lastError, created_at as createdAt, started_at as startedAt, completed_at as completedAt,
        updated_at as updatedAt, prompt_json as promptJson from research_operating_analysis_jobs where security_code=? and prompt_version=?`)
        .bind(code, OPERATING_ANALYSIS_PROMPT_VERSION).first<Row>(),
      db.prepare(`select run_id as runId, prompt_version as promptVersion, provider, generated_at as generatedAt, total_duration_ms as totalDurationMs
        from research_operating_analysis_runs where security_code=? and prompt_version=? order by generated_at desc`).bind(code, OPERATING_ANALYSIS_PROMPT_VERSION).all<Row>(),
      db.prepare(`select stage_key as stageKey, status, attempt_count as attemptCount, attempt, lease_owner as leaseOwner, output_json as outputJson, output_markdown as outputMarkdown,
        partial_output as partialOutput, prompt_json as promptJson, input_json as inputJson, last_error as lastError, blocked_json as blockedJson,
        started_at as startedAt, completed_at as completedAt, updated_at as updatedAt from research_operating_analysis_stage_artifacts
        where security_code=? and prompt_version=? order by stage_key`).bind(code, OPERATING_ANALYSIS_PROMPT_VERSION).all<Row>(),
    ]);
    const stageMap = new Map(stages.results.map((item) => [text(item.stageKey), normalizeStage(item)]));
    const stageReadModel = OPERATING_ANALYSIS_STAGES.map((definition) => stageMap.get(definition.key) || { stageKey: definition.key, status: "queued", label: definition.label, outputKind: definition.output });
    return {
      availability: run || job || stages.results.length ? "available" as const : "empty" as const,
      run: normalizeResearchOperatingAnalysisRun(run),
      job: job ? { ...job, prompt: normalizeModelPrompt(parseJson(text(job.promptJson))), stages: stageReadModel } : null,
      versions: versions.results,
    };
  } catch (error) {
    if (/no such table/i.test(String(error))) return { availability: "unavailable" as const, run: null, job: null, versions: [] as Row[] };
    throw error;
  }
}

function normalizeStage(source: Row) {
  const key = text(source.stageKey) as OperatingAnalysisStageKey;
  const definition = OPERATING_ANALYSIS_STAGES.find((item) => item.key === key);
  return {
    ...source, stageKey: key, label: definition?.label || key, outputKind: definition?.output || "json",
    output: parseJson(text(source.outputJson)) ?? (text(source.outputMarkdown) || null), partialOutput: text(source.partialOutput) || null,
    prompt: normalizeModelPrompt(parseJson(text(source.promptJson))), input: parseJson(text(source.inputJson)),
    blocked: parseJson(text(source.blockedJson)),
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
  const code = securityCode.trim().toUpperCase(); const effort = reasoningEffort(requestedReasoningEffort); const selectedModel = model(requestedModel); const now = Date.now();
  const existing = await db.prepare(`select status from research_operating_analysis_jobs where security_code=? and prompt_version=?`).bind(code, OPERATING_ANALYSIS_PROMPT_VERSION).first<Row>();
  if (existing?.status === "completed" && !force) return { ...(await loadResearchOperatingAnalysis(db, code)), shouldStart: false, deduplicated: true };
  if (existing) {
    await db.prepare(`update research_operating_analysis_jobs set status='queued', run_id=null, model=?, reasoning_effort=?, last_error=null, started_at=null,
      completed_at=null, prompt_json=null, lease_owner=null, lease_until=null, updated_at=? where security_code=? and prompt_version=?`).bind(selectedModel, effort, now, code, OPERATING_ANALYSIS_PROMPT_VERSION).run();
    if (force) await db.prepare(`delete from research_operating_analysis_stage_artifacts where security_code=? and prompt_version=?`).bind(code, OPERATING_ANALYSIS_PROMPT_VERSION).run();
    else await db.prepare(`update research_operating_analysis_stage_artifacts set status='queued', last_error=null, completed_at=null, updated_at=? where security_code=? and prompt_version=? and status in ('blocked','failed')`).bind(now, code, OPERATING_ANALYSIS_PROMPT_VERSION).run();
  } else {
    await db.prepare(`insert into research_operating_analysis_jobs (job_id, job_type, security_code, prompt_version, status, model, reasoning_effort, attempt_count, attempt, created_at, updated_at)
      values (?, 'research_operating_analysis', ?, ?, 'queued', ?, ?, 0, 0, ?, ?)`).bind(`research-operating-analysis:${code}:${OPERATING_ANALYSIS_PROMPT_VERSION}`, code, OPERATING_ANALYSIS_PROMPT_VERSION, selectedModel, effort, now, now).run();
  }
  return { ...(await loadResearchOperatingAnalysis(db, code)), shouldStart: true, deduplicated: false };
}

/** Recover only an interrupted stage. Completed artifacts are never discarded. */
export async function claimResearchOperatingAnalysisJob(db: D1Database, runnerInstanceId: string) {
  if (!await ownsResearchOperatingAnalysisRunnerLease(db, runnerInstanceId)) return null;
  const now = Date.now(); const runner = runnerInstanceId.trim();
  await reconcileLocalJobProviderSlots(db, now);
  await db.prepare(`update research_operating_analysis_jobs set status='queued', last_error='local runner lease expired; continuing from the last completed stage',
    updated_at=?, lease_owner=null, lease_until=null where prompt_version=? and status='running' and lease_until<?`).bind(now, OPERATING_ANALYSIS_PROMPT_VERSION, now).run();
  const candidate = await db.prepare(`select security_code as securityCode, model, reasoning_effort as reasoningEffort, job_id as jobId, attempt from research_operating_analysis_jobs where prompt_version=? and status='queued' order by created_at asc limit 1`).bind(OPERATING_ANALYSIS_PROMPT_VERSION).first<Row>();
  const code = text(candidate?.securityCode); if (!code) return null;
  const jobId = text(candidate?.jobId); const nextAttempt = Number(candidate?.attempt) + 1;
  if (!jobId || !Number.isInteger(nextAttempt) || nextAttempt < 1) throw new Error("invalid operating-analysis job attempt");
  if (!await reserveLocalJobProviderSlot(db, jobId, "research_operating_analysis", nextAttempt, runner, now)) return null;
  const result = await db.prepare(`update research_operating_analysis_jobs set status='running', attempt_count=attempt_count+1, started_at=coalesce(started_at, ?),
    updated_at=?, attempt=?, lease_owner=?, lease_until=?, heartbeat_at=? where security_code=? and prompt_version=? and status='queued' and attempt=? and exists (select 1 from research_operating_analysis_runner_leases where lease_name=? and owner_id=? and heartbeat_at>=?)`)
    .bind(now, now, nextAttempt, runner, localJobLeaseUntil(now), now, code, OPERATING_ANALYSIS_PROMPT_VERSION, nextAttempt - 1, RESEARCH_OPERATING_ANALYSIS_RUNNER_LEASE_NAME, runner, now - RESEARCH_OPERATING_ANALYSIS_RUNNER_LEASE_MS).run();
  if (!result.meta.changes) { await releaseLocalJobProviderSlot(db, jobId, nextAttempt, runner, now); return null; }
  return { jobId, securityCode: code, model: model(candidate?.model), reasoningEffort: reasoningEffort(candidate?.reasoningEffort), promptVersion: OPERATING_ANALYSIS_PROMPT_VERSION, attempt: nextAttempt };
}

export async function startResearchOperatingAnalysisStage(db: D1Database, securityCode: string, stageKey: OperatingAnalysisStageKey, input: unknown, prompt: unknown, runnerInstanceId: string, attempt: number) {
  assertStage(stageKey); const modelPrompt = normalizeModelPrompt(prompt); if (!modelPrompt) throw new Error("operating analysis stage prompt is required");
  const now = Date.now(); const code = securityCode.trim().toUpperCase(); const runner = runnerInstanceId.trim();
  const owned = await db.prepare(`select job_id as jobId from research_operating_analysis_jobs where security_code=? and prompt_version=? and status='running' and attempt=? and lease_owner=? and lease_until>=?`).bind(code, OPERATING_ANALYSIS_PROMPT_VERSION, attempt, runner, now).first<Row>();
  if (!owned) throw new Error("operating-analysis job lease is no longer owned by this runner");
  const existing = await db.prepare(`select status from research_operating_analysis_stage_artifacts where security_code=? and prompt_version=? and stage_key=?`).bind(code, OPERATING_ANALYSIS_PROMPT_VERSION, stageKey).first<Row>();
  if (["complete", "partial", "blocked", "not_applicable"].includes(text(existing?.status))) return existing;
  if (existing) {
    await db.prepare(`update research_operating_analysis_stage_artifacts set status='running', attempt_count=attempt_count+1, attempt=?, lease_owner=?, input_json=?, prompt_json=?, partial_output=null, last_error=null, started_at=?, completed_at=null, updated_at=? where security_code=? and prompt_version=? and stage_key=?`)
      .bind(attempt, runner, JSON.stringify(input), JSON.stringify(modelPrompt), now, now, code, OPERATING_ANALYSIS_PROMPT_VERSION, stageKey).run();
  } else {
    await db.prepare(`insert into research_operating_analysis_stage_artifacts (security_code,prompt_version,stage_key,status,attempt_count,attempt,lease_owner,input_json,prompt_json,started_at,updated_at) values (?,?,?,'running',1,?,?,?, ?,?,?)`)
      .bind(code, OPERATING_ANALYSIS_PROMPT_VERSION, stageKey, attempt, runner, JSON.stringify(input), JSON.stringify(modelPrompt), now, now).run();
  }
  await db.prepare(`update research_operating_analysis_jobs set prompt_json=?, updated_at=? where security_code=? and prompt_version=? and status='running' and attempt=? and lease_owner=? and lease_until>=?`).bind(JSON.stringify(modelPrompt), now, code, OPERATING_ANALYSIS_PROMPT_VERSION, attempt, runner, now).run();
}

export async function checkpointResearchOperatingAnalysisStage(db: D1Database, securityCode: string, stageKey: OperatingAnalysisStageKey, partialOutput: string, runnerInstanceId: string, attempt: number) {
  assertStage(stageKey); const now = Date.now(); const result = await db.prepare(`update research_operating_analysis_stage_artifacts set partial_output=?, updated_at=? where security_code=? and prompt_version=? and stage_key=? and status='running' and attempt=? and lease_owner=? and exists (select 1 from research_operating_analysis_jobs where security_code=? and prompt_version=? and status='running' and attempt=? and lease_owner=? and lease_until>=?)`)
    .bind(partialOutput.trim(), now, securityCode.trim().toUpperCase(), OPERATING_ANALYSIS_PROMPT_VERSION, stageKey, attempt, runnerInstanceId.trim(), securityCode.trim().toUpperCase(), OPERATING_ANALYSIS_PROMPT_VERSION, attempt, runnerInstanceId.trim(), now).run();
  if (!result.meta.changes) throw new Error("operating-analysis stage is no longer running");
}

export async function completeResearchOperatingAnalysisStage(db: D1Database, securityCode: string, stageKey: OperatingAnalysisStageKey, output: unknown, status: OperatingAnalysisStageStatus, runnerInstanceId: string, attempt: number) {
  assertStage(stageKey); if (!["complete", "partial", "blocked", "not_applicable"].includes(status)) throw new Error("invalid terminal operating-analysis stage status");
  const definition = OPERATING_ANALYSIS_STAGES.find((item) => item.key === stageKey)!; const value = definition.output === "json" ? JSON.stringify(output) : null;
  const markdown = definition.output === "markdown" ? text(output) : null;
  const blocked = definition.output === "json" && output && typeof output === "object" && !Array.isArray(output)
    ? (row(output).blockedValuationItems ?? row(output).blockedItems ?? row(output).unknowns ?? null) : null;
  if (definition.output === "markdown" && !markdown) throw new Error("operating-analysis Markdown stage output is empty");
  if (definition.output === "json" && (!output || typeof output !== "object")) throw new Error("operating-analysis JSON stage output is invalid");
  const now = Date.now(); const code = securityCode.trim().toUpperCase();
  const result = await db.prepare(`update research_operating_analysis_stage_artifacts set status=?, output_json=?, output_markdown=?, blocked_json=?, partial_output=null, completed_at=?, updated_at=? where security_code=? and prompt_version=? and stage_key=? and status='running' and attempt=? and lease_owner=? and exists (select 1 from research_operating_analysis_jobs where security_code=? and prompt_version=? and status='running' and attempt=? and lease_owner=? and lease_until>=?)`)
    .bind(status, value, markdown, blocked ? JSON.stringify(blocked) : null, now, now, code, OPERATING_ANALYSIS_PROMPT_VERSION, stageKey, attempt, runnerInstanceId.trim(), code, OPERATING_ANALYSIS_PROMPT_VERSION, attempt, runnerInstanceId.trim(), now).run();
  if (!result.meta.changes) throw new Error("operating-analysis stage is no longer owned by this runner");
}

export async function completeResearchOperatingAnalysisJob(db: D1Database, securityCode: string, input: unknown, prompt: unknown, reportMarkdown: string, reasoningMarkdown: string, inputFingerprint: string, runnerInstanceId: string, attempt: number, streamStats?: unknown) {
  const code = securityCode.trim().toUpperCase(); const report = reportMarkdown.trim(); const modelPrompt = normalizeModelPrompt(prompt);
  const missing = OPERATING_ANALYSIS_REQUIRED_HEADINGS.filter((heading) => !report.includes(heading));
  if (!report || missing.length) throw new Error(`operating analysis report is incomplete; missing sections: ${missing.join(", ")}`);
  if (!modelPrompt || !inputFingerprint.trim()) throw new Error("operating analysis completion is missing prompt or fingerprint");
  const now = Date.now(); const runner = runnerInstanceId.trim(); const job = await db.prepare(`select job_id as jobId, started_at as startedAt from research_operating_analysis_jobs where security_code=? and prompt_version=? and status='running' and attempt=? and lease_owner=? and lease_until>=?`).bind(code, OPERATING_ANALYSIS_PROMPT_VERSION, attempt, runner, now).first<Row>();
  if (!job) throw new Error("operating-analysis job lease is no longer owned by this runner");
  const totalDurationMs = Number.isFinite(Number(job?.startedAt)) ? Math.max(0, now - Number(job?.startedAt)) : null; const runId = `operating-analysis:${crypto.randomUUID()}`;
  await db.prepare(`insert into research_operating_analysis_runs (run_id,security_code,prompt_version,input_fingerprint,input_as_of,input_json,report_markdown,reasoning_markdown,total_duration_ms,stream_stats_json,prompt_json,provider,generated_at) values (?,?,?,?,?,?,?,?,?,?,?,'llm-client.responses',?)`)
    .bind(runId, code, OPERATING_ANALYSIS_PROMPT_VERSION, inputFingerprint, now, JSON.stringify(input), report, reasoningMarkdown.trim(), totalDurationMs, streamStats ? JSON.stringify(streamStats) : null, JSON.stringify(modelPrompt), now).run();
  const claimed = await db.prepare(`update research_operating_analysis_jobs set status='completed', run_id=?, last_error=null, completed_at=?, updated_at=?, lease_until=null where security_code=? and prompt_version=? and status='running' and attempt=? and lease_owner=? and lease_until>=?`).bind(runId, now, now, code, OPERATING_ANALYSIS_PROMPT_VERSION, attempt, runner, now).run();
  if (!claimed.meta.changes) throw new Error("operating-analysis job lease is no longer owned by this runner");
  await releaseLocalJobProviderSlot(db, text(job.jobId), attempt, runner, now);
  return await loadResearchOperatingAnalysis(db, code);
}

export async function failResearchOperatingAnalysisJob(db: D1Database, securityCode: string, error: unknown, runnerInstanceId: string, attempt: number) {
  const now = Date.now(); const message = error instanceof Error ? error.message : String(error);
  const code = securityCode.trim().toUpperCase(); const runner = runnerInstanceId.trim();
  const job = await db.prepare(`select job_id as jobId from research_operating_analysis_jobs where security_code=? and prompt_version=? and status='running' and attempt=? and lease_owner=? and lease_until>=?`).bind(code, OPERATING_ANALYSIS_PROMPT_VERSION, attempt, runner, now).first<Row>();
  if (!job) throw new Error("operating-analysis job lease is no longer owned by this runner");
  await db.prepare(`update research_operating_analysis_stage_artifacts set status='failed', last_error=?, updated_at=? where security_code=? and prompt_version=? and status='running' and attempt=? and lease_owner=?`).bind(message.slice(0, 1600), now, code, OPERATING_ANALYSIS_PROMPT_VERSION, attempt, runner).run();
  const updated = await db.prepare(`update research_operating_analysis_jobs set status='failed', last_error=?, completed_at=?, updated_at=?, lease_until=null where security_code=? and prompt_version=? and status='running' and attempt=? and lease_owner=? and lease_until>=?`).bind(message.slice(0, 1600), now, now, code, OPERATING_ANALYSIS_PROMPT_VERSION, attempt, runner, now).run();
  if (!updated.meta.changes) throw new Error("operating-analysis job lease is no longer owned by this runner");
  await releaseLocalJobProviderSlot(db, text(job.jobId), attempt, runner, now);
  return await loadResearchOperatingAnalysis(db, securityCode);
}

/**
 * A local Node runtime restart can interrupt a runner while its model stream is
 * still alive. Return only that runner's non-terminal work to the queue so a
 * later claim resumes from the last terminal stage instead of stranding it.
 */
export async function requeueInterruptedResearchOperatingAnalysisJob(db: D1Database, securityCode: string, error: unknown, runnerInstanceId: string, attempt: number) {
  const code = securityCode.trim().toUpperCase(); const runner = runnerInstanceId.trim(); const now = Date.now();
  const job = await db.prepare(`select job_id as jobId, status, lease_owner as leaseOwner, lease_until as leaseUntil, attempt from research_operating_analysis_jobs where security_code=? and prompt_version=?`)
    .bind(code, OPERATING_ANALYSIS_PROMPT_VERSION).first<Row>();
  // A runner that lost its transport cannot revoke its own still-valid lease.
  // Recovery is deliberately delayed until the lease expires, fencing any
  // late stream output from the abandoned attempt.
  if (text(job?.status) !== "running" || text(job?.leaseOwner) !== runner || Number(job?.attempt) !== attempt || Number(job?.leaseUntil) >= now) return false;
  const message = `local Node runtime interrupted this runner; continuing from the last completed stage: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1600);
  await db.prepare(`update research_operating_analysis_stage_artifacts set status='queued', last_error=?, completed_at=null, updated_at=?
    where security_code=? and prompt_version=? and status='running' and attempt=? and lease_owner=? and lease_until<?`)
    .bind(message, now, code, OPERATING_ANALYSIS_PROMPT_VERSION, attempt, runner, now).run();
  const result = await db.prepare(`update research_operating_analysis_jobs set status='queued', last_error=?, lease_owner=null, lease_until=null, updated_at=?
    where security_code=? and prompt_version=? and status='running' and attempt=? and lease_owner=? and lease_until<?`)
    .bind(message, now, code, OPERATING_ANALYSIS_PROMPT_VERSION, attempt, runner, now).run();
  if (result.meta.changes) await releaseLocalJobProviderSlot(db, text(job?.jobId), attempt, runner, now);
  return result.meta.changes > 0;
}

export async function heartbeatResearchOperatingAnalysisJob(db: D1Database, securityCode: string, runnerInstanceId: string, attempt: number) {
  const code = securityCode.trim().toUpperCase();
  return renewLocalJobLease(db, "research_operating_analysis_jobs", "security_code=? and prompt_version=?", [code, OPERATING_ANALYSIS_PROMPT_VERSION], attempt, runnerInstanceId.trim());
}

function assertStage(value: string): asserts value is OperatingAnalysisStageKey { if (!OPERATING_ANALYSIS_STAGES.some((stage) => stage.key === value)) throw new Error("unsupported operating-analysis stage"); }
function parseJson(value: string): unknown { try { return JSON.parse(value); } catch { return null; } }
function normalizeModelPrompt(value: unknown): ModelPrompt | null { const source = row(value); const instructions = text(source.instructions); const userPrompt = text(source.userPrompt); const model = text(source.model); return instructions && userPrompt ? { ...(model ? { model } : {}), instructions, userPrompt } : null; }
