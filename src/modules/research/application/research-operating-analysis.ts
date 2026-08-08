import { RESEARCH_OPERATING_ANALYSIS_RUNNER_LEASE_MS, RESEARCH_OPERATING_ANALYSIS_RUNNER_LEASE_NAME, ownsResearchOperatingAnalysisRunnerLease } from "./research-operating-analysis-runner-lease";
type Row = Record<string, unknown>;

/** One complete long-form investment-research document generated locally by llm-client. */
export const OPERATING_ANALYSIS_PROMPT_VERSION = "investment-analysis.llm-client.v1";
export const OPERATING_ANALYSIS_DEFAULT_REASONING_EFFORT = "high";
const reasoningEfforts = new Set(["none", "low", "medium", "high", "xhigh", "max"]);
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const row = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};

function reasoningEffort(value: unknown) {
  const effort = text(value) || OPERATING_ANALYSIS_DEFAULT_REASONING_EFFORT;
  if (!reasoningEfforts.has(effort)) throw new Error("unsupported operating-analysis reasoning effort");
  return effort;
}

export async function loadResearchOperatingAnalysis(db: D1Database, securityCode: string) {
  const code = securityCode.trim().toUpperCase();
  try {
    const [run, job] = await Promise.all([
      db.prepare(`select run_id as runId, security_code as securityCode, prompt_version as promptVersion,
        input_fingerprint as inputFingerprint, input_as_of as inputAsOf, input_json as inputJson,
        report_markdown as reportMarkdown, reasoning_markdown as reasoningMarkdown,
        total_duration_ms as totalDurationMs, provider, generated_at as generatedAt
        from research_operating_analysis_runs where security_code=? and prompt_version=? order by generated_at desc limit 1`)
        .bind(code, OPERATING_ANALYSIS_PROMPT_VERSION).first<Row>(),
      db.prepare(`select security_code as securityCode, prompt_version as promptVersion, status, run_id as runId,
        attempt_count as attemptCount, reasoning_effort as reasoningEffort, last_error as lastError, created_at as createdAt, started_at as startedAt,
        completed_at as completedAt, updated_at as updatedAt, partial_report_markdown as partialReportMarkdown,
        partial_reasoning_markdown as partialReasoningMarkdown,
        partial_updated_at as partialUpdatedAt from research_operating_analysis_jobs
        where security_code=? and prompt_version=?`).bind(code, OPERATING_ANALYSIS_PROMPT_VERSION).first<Row>(),
    ]);
    return {
      availability: run || job ? "available" as const : "empty" as const,
      run: run ? { ...run, input: parseJson(text(run.inputJson)) } : null,
      job: job || null,
    };
  } catch (error) {
    if (/no such table/i.test(String(error))) return { availability: "unavailable" as const, run: null, job: null };
    throw error;
  }
}

export async function enqueueResearchOperatingAnalysis(db: D1Database, securityCode: string, force = false, requestedReasoningEffort: unknown = OPERATING_ANALYSIS_DEFAULT_REASONING_EFFORT) {
  const code = securityCode.trim().toUpperCase();
  const effort = reasoningEffort(requestedReasoningEffort);
  const now = Date.now();
  const existing = await db.prepare(`select status from research_operating_analysis_jobs where security_code=? and prompt_version=?`)
    .bind(code, OPERATING_ANALYSIS_PROMPT_VERSION).first<Row>();
  if (existing && existing.status !== "failed" && !force) return { ...(await loadResearchOperatingAnalysis(db, code)), shouldStart: false, deduplicated: true };
  if (existing) {
    await db.prepare(`update research_operating_analysis_jobs set status='queued', run_id=null, reasoning_effort=?, last_error=null,
      completed_at=null, partial_report_markdown=null, partial_reasoning_markdown=null, partial_updated_at=null, lease_owner=null, updated_at=? where security_code=? and prompt_version=?`)
      .bind(effort, now, code, OPERATING_ANALYSIS_PROMPT_VERSION).run();
  } else {
    await db.prepare(`insert into research_operating_analysis_jobs (security_code, prompt_version, status, reasoning_effort, attempt_count, created_at, updated_at)
      values (?, ?, 'queued', ?, 0, ?, ?)`)
      .bind(code, OPERATING_ANALYSIS_PROMPT_VERSION, effort, now, now).run();
  }
  return { ...(await loadResearchOperatingAnalysis(db, code)), shouldStart: true, deduplicated: false };
}

export async function claimResearchOperatingAnalysisJob(db: D1Database, runnerInstanceId: string) {
  if (!await ownsResearchOperatingAnalysisRunnerLease(db, runnerInstanceId)) return null;
  const now = Date.now();
  // A Responses stream cannot be resumed by a replacement Node process. Once
  // this runner has acquired the expired lease, make that interruption visible
  // and leave the saved partial text available for the user to retry.
  await db.prepare(`update research_operating_analysis_jobs set status='failed',
    last_error='local llm-client runner restarted before this stream finished; retry the report',
    completed_at=?, updated_at=? where prompt_version=? and status='running'
    and (lease_owner is null or lease_owner<>?)`)
    .bind(now, now, OPERATING_ANALYSIS_PROMPT_VERSION, runnerInstanceId.trim()).run();
  const candidate = await db.prepare(`select security_code as securityCode, reasoning_effort as reasoningEffort from research_operating_analysis_jobs
    where prompt_version=? and status='queued' order by created_at asc limit 1`).bind(OPERATING_ANALYSIS_PROMPT_VERSION).first<Row>();
  const code = text(candidate?.securityCode);
  if (!code) return null;
  const claim = await db.prepare(`update research_operating_analysis_jobs set status='running', attempt_count=attempt_count+1,
    started_at=?, updated_at=?, lease_owner=? where security_code=? and prompt_version=?
    and status='queued' and exists (
      select 1 from research_operating_analysis_runner_leases where lease_name=? and owner_id=? and heartbeat_at>=?
    )`)
    .bind(now, now, runnerInstanceId.trim(), code, OPERATING_ANALYSIS_PROMPT_VERSION,
      RESEARCH_OPERATING_ANALYSIS_RUNNER_LEASE_NAME, runnerInstanceId.trim(), now - RESEARCH_OPERATING_ANALYSIS_RUNNER_LEASE_MS).run();
  return claim.meta.changes ? {
    securityCode: code,
    promptVersion: OPERATING_ANALYSIS_PROMPT_VERSION,
    reasoningEffort: reasoningEffort(candidate?.reasoningEffort),
  } : null;
}

export async function checkpointResearchOperatingAnalysisStream(
  db: D1Database,
  securityCode: string,
  partialReportMarkdown: string,
  partialReasoningMarkdown: string,
  runnerInstanceId: string,
) {
  const partial = partialReportMarkdown.trim();
  const reasoning = partialReasoningMarkdown.trim();
  if (!partial && !reasoning) return await loadResearchOperatingAnalysis(db, securityCode);
  const now = Date.now();
  const updated = await db.prepare(`update research_operating_analysis_jobs set partial_report_markdown=?, partial_reasoning_markdown=?, partial_updated_at=?, updated_at=?
    where security_code=? and prompt_version=? and status='running' and lease_owner=?`)
    .bind(partial, reasoning, now, now, securityCode.trim().toUpperCase(), OPERATING_ANALYSIS_PROMPT_VERSION, runnerInstanceId.trim()).run();
  if (!updated.meta.changes) throw new Error("operating-analysis job lease is no longer owned by this runner");
  return await loadResearchOperatingAnalysis(db, securityCode);
}

export async function completeResearchOperatingAnalysisJob(db: D1Database, securityCode: string, input: unknown, reportMarkdown: string, reasoningMarkdown: string, inputFingerprint: string, runnerInstanceId: string) {
  const code = securityCode.trim().toUpperCase();
  const report = reportMarkdown.trim();
  const reasoning = reasoningMarkdown.trim();
  if (!report) throw new Error("operating analysis report is empty");
  if (!inputFingerprint.trim()) throw new Error("operating analysis input fingerprint is required");
  const now = Date.now();
  const [existing, job] = await Promise.all([
    db.prepare(`select run_id as runId from research_operating_analysis_runs
      where security_code=? and prompt_version=? and input_fingerprint=? limit 1`)
      .bind(code, OPERATING_ANALYSIS_PROMPT_VERSION, inputFingerprint).first<Row>(),
    db.prepare(`select created_at as createdAt from research_operating_analysis_jobs
      where security_code=? and prompt_version=? and status='running' and lease_owner=?`)
      .bind(code, OPERATING_ANALYSIS_PROMPT_VERSION, runnerInstanceId.trim()).first<Row>(),
  ]);
  const runId = text(existing?.runId) || `operating-analysis:${crypto.randomUUID()}`;
  const createdAt = Number(job?.createdAt);
  const totalDurationMs = Number.isFinite(createdAt) ? Math.max(0, now - createdAt) : null;
  await db.prepare(`insert or ignore into research_operating_analysis_runs (
      run_id, security_code, prompt_version, input_fingerprint, input_as_of, input_json, report_markdown, reasoning_markdown,
      total_duration_ms, provider, generated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'llm-client.responses', ?)`)
    .bind(runId, code, OPERATING_ANALYSIS_PROMPT_VERSION, inputFingerprint, now, JSON.stringify(input), report, reasoning, totalDurationMs, now).run();
  const claimed = await db.prepare(`update research_operating_analysis_jobs set status='completed', run_id=?, last_error=null,
    partial_report_markdown=null, partial_reasoning_markdown=null, partial_updated_at=null, completed_at=?, updated_at=? where security_code=? and prompt_version=? and status='running' and lease_owner=?`)
    .bind(runId, now, now, code, OPERATING_ANALYSIS_PROMPT_VERSION, runnerInstanceId.trim()).run();
  if (!claimed.meta.changes) throw new Error("operating-analysis job lease is no longer owned by this runner");
  return await loadResearchOperatingAnalysis(db, code);
}

export async function failResearchOperatingAnalysisJob(db: D1Database, securityCode: string, error: unknown, runnerInstanceId: string) {
  const now = Date.now();
  const message = error instanceof Error ? error.message : String(error);
  await db.prepare(`update research_operating_analysis_jobs set status='failed', last_error=?, completed_at=?, updated_at=?
    where security_code=? and prompt_version=? and status='running' and lease_owner=?`)
    .bind(message.slice(0, 1600), now, now, securityCode.trim().toUpperCase(), OPERATING_ANALYSIS_PROMPT_VERSION, runnerInstanceId.trim()).run();
  return await loadResearchOperatingAnalysis(db, securityCode);
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return null; }
}
