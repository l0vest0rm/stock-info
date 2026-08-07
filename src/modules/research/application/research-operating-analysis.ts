import { RESEARCH_WEBQA_RUNNER_LEASE_MS, RESEARCH_WEBQA_RUNNER_LEASE_NAME, ownsResearchWebQaRunnerLease } from "./research-webqa-runner-lease";
type Row = Record<string, unknown>;

/** One complete long-form WebQA investment-research document. */
export const OPERATING_ANALYSIS_PROMPT_VERSION = "investment-analysis.webqa.v7";
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const row = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};

export async function loadResearchOperatingAnalysis(db: D1Database, securityCode: string) {
  const code = securityCode.trim().toUpperCase();
  try {
    const [run, job] = await Promise.all([
      db.prepare(`select run_id as runId, security_code as securityCode, prompt_version as promptVersion,
        input_fingerprint as inputFingerprint, input_as_of as inputAsOf, input_json as inputJson,
        report_markdown as reportMarkdown, provider, generated_at as generatedAt
        from research_operating_analysis_runs where security_code=? and prompt_version=? order by generated_at desc limit 1`)
        .bind(code, OPERATING_ANALYSIS_PROMPT_VERSION).first<Row>(),
      db.prepare(`select security_code as securityCode, prompt_version as promptVersion, status, run_id as runId,
        attempt_count as attemptCount, last_error as lastError, created_at as createdAt, started_at as startedAt,
        completed_at as completedAt, updated_at as updatedAt, webqa_task_id as webqaTaskId from research_operating_analysis_jobs
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

export async function enqueueResearchOperatingAnalysis(db: D1Database, securityCode: string, force = false) {
  const code = securityCode.trim().toUpperCase();
  const now = Date.now();
  const existing = await db.prepare(`select status from research_operating_analysis_jobs where security_code=? and prompt_version=?`)
    .bind(code, OPERATING_ANALYSIS_PROMPT_VERSION).first<Row>();
  if (existing && existing.status !== "failed" && !force) return { ...(await loadResearchOperatingAnalysis(db, code)), shouldStart: false, deduplicated: true };
  const webqaConversationId = `${OPERATING_ANALYSIS_PROMPT_VERSION}-${code}-${crypto.randomUUID()}`;
  if (existing) {
    await db.prepare(`update research_operating_analysis_jobs set status='queued', run_id=null, last_error=null,
      completed_at=null, webqa_conversation_id=?, webqa_task_id=null, start_new_session=1, updated_at=? where security_code=? and prompt_version=?`)
      .bind(webqaConversationId, now, code, OPERATING_ANALYSIS_PROMPT_VERSION).run();
  } else {
    await db.prepare(`insert into research_operating_analysis_jobs (security_code, prompt_version, status, attempt_count, webqa_conversation_id, start_new_session, created_at, updated_at)
      values (?, ?, 'queued', 0, ?, 1, ?, ?)`)
      .bind(code, OPERATING_ANALYSIS_PROMPT_VERSION, webqaConversationId, now, now).run();
  }
  return { ...(await loadResearchOperatingAnalysis(db, code)), shouldStart: true, deduplicated: false };
}

export async function claimResearchOperatingAnalysisJob(db: D1Database, runnerInstanceId: string) {
  if (!await ownsResearchWebQaRunnerLease(db, runnerInstanceId)) return null;
  const now = Date.now();
  const candidate = await db.prepare(`select security_code as securityCode, webqa_conversation_id as webqaConversationId,
    webqa_task_id as webqaTaskId, start_new_session as startNewSession from research_operating_analysis_jobs
    where prompt_version=? and status in ('queued', 'running') order by created_at asc limit 1`).bind(OPERATING_ANALYSIS_PROMPT_VERSION).first<Row>();
  const code = text(candidate?.securityCode);
  if (!code) return null;
  const claim = await db.prepare(`update research_operating_analysis_jobs set status='running', attempt_count=attempt_count+1,
    start_new_session=0, started_at=coalesce(started_at, ?), updated_at=?, lease_owner=? where security_code=? and prompt_version=?
    and status in ('queued', 'running') and exists (
      select 1 from research_webqa_runner_leases where lease_name=? and owner_id=? and heartbeat_at>=?
    )`)
    .bind(now, now, runnerInstanceId.trim(), code, OPERATING_ANALYSIS_PROMPT_VERSION,
      RESEARCH_WEBQA_RUNNER_LEASE_NAME, runnerInstanceId.trim(), now - RESEARCH_WEBQA_RUNNER_LEASE_MS).run();
  return claim.meta.changes ? {
    securityCode: code,
    promptVersion: OPERATING_ANALYSIS_PROMPT_VERSION,
    webqaConversationId: text(candidate?.webqaConversationId) || `${OPERATING_ANALYSIS_PROMPT_VERSION}-${code}`,
    webqaTaskId: text(candidate?.webqaTaskId) || null,
    startNewSession: candidate?.startNewSession === 1,
  } : null;
}

export async function checkpointResearchOperatingAnalysisWebQaTask(
  db: D1Database,
  securityCode: string,
  webqaTaskId: string,
  runnerInstanceId: string,
) {
  const taskId = webqaTaskId.trim();
  if (!taskId) throw new Error("webqa task id is required");
  const updated = await db.prepare(`update research_operating_analysis_jobs set webqa_task_id=?, updated_at=?
    where security_code=? and prompt_version=? and status='running' and lease_owner=? and webqa_task_id is null`)
    .bind(taskId, Date.now(), securityCode.trim().toUpperCase(), OPERATING_ANALYSIS_PROMPT_VERSION, runnerInstanceId.trim()).run();
  if (!updated.meta.changes) throw new Error("operating-analysis job lease is no longer owned by this runner or already has a WebQA task");
  return await loadResearchOperatingAnalysis(db, securityCode);
}

export async function completeResearchOperatingAnalysisJob(db: D1Database, securityCode: string, input: unknown, reportMarkdown: string, inputFingerprint: string, runnerInstanceId: string) {
  const code = securityCode.trim().toUpperCase();
  const report = reportMarkdown.trim();
  if (!report) throw new Error("operating analysis report is empty");
  if (!inputFingerprint.trim()) throw new Error("operating analysis input fingerprint is required");
  const now = Date.now();
  // A recovered WebQA answer has the same deterministic input fingerprint.
  // Reuse the existing immutable run ID rather than making the job point to a
  // run which INSERT OR IGNORE deliberately did not create.
  const existing = await db.prepare(`select run_id as runId from research_operating_analysis_runs
    where security_code=? and prompt_version=? and input_fingerprint=? limit 1`)
    .bind(code, OPERATING_ANALYSIS_PROMPT_VERSION, inputFingerprint).first<Row>();
  const runId = text(existing?.runId) || `operating-analysis:${crypto.randomUUID()}`;
  const claimed = await db.prepare(`update research_operating_analysis_jobs set status='completed', run_id=?, last_error=null,
    completed_at=?, updated_at=? where security_code=? and prompt_version=? and status='running' and lease_owner=?`)
    .bind(runId, now, now, code, OPERATING_ANALYSIS_PROMPT_VERSION, runnerInstanceId.trim()).run();
  if (!claimed.meta.changes) throw new Error("operating-analysis job lease is no longer owned by this runner");
  await db.prepare(`insert or ignore into research_operating_analysis_runs (
      run_id, security_code, prompt_version, input_fingerprint, input_as_of, input_json, report_markdown, provider, generated_at
    ) values (?, ?, ?, ?, ?, ?, ?, 'chatgpt-webqa', ?)`)
      .bind(runId, code, OPERATING_ANALYSIS_PROMPT_VERSION, inputFingerprint, now, JSON.stringify(input), report, now).run();
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
