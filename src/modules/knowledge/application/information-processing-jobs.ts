import {
  completeInformationProcessing,
  failInformationProcessing,
  prepareInformationDocument,
  type InformationProcessingModelRequest,
} from "./information-processing";
import { localJobLeaseUntil, reconcileLocalJobProviderSlots, releaseLocalJobProviderSlot, renewLocalJobLease, reserveLocalJobProviderSlot } from "../../../shared/local-job-protocol";
import type { AppEnv } from "../../../types";

export type InformationProcessingJob = { job_id: string; doc_id: string; attempt: number; lease_owner: string };
export type InformationProcessingJobState = InformationProcessingJob & { status: string; lease_until: number | null; last_run_id: string | null };

/** Claiming is deliberately application-owned: routes only transport a lease. */
export async function claimInformationProcessingJobs(db: D1Database, limit: number, runnerInstanceId: string, documentIds?: string[]): Promise<InformationProcessingJob[]> {
  const now = Date.now(); const runner = runnerInstanceId.trim();
  if (!runner) throw new Error("runnerInstanceId is required");
  await reconcileLocalJobProviderSlots(db, now);
  await db.prepare("update information_processing_jobs set status='queued', lease_owner=null, lease_until=null, last_error=?, updated_at=? where status='running' and lease_until<?")
    .bind("local information processing runner lease expired; retrying with a new attempt", now, now).run();
  const requestedIds = [...new Set(documentIds || [])];
  const requestedClause = requestedIds.length ? ` and j.doc_id in (${requestedIds.map(() => "?").join(",")})` : "";
  const queued = await db.prepare(`select j.job_id, j.doc_id, j.attempt from information_processing_jobs j join knowledge_docs d on d.doc_id=j.doc_id where j.status='queued'${requestedClause} order by d.sort_time desc,d.doc_id desc limit ?`)
    .bind(...requestedIds, limit).all<{ job_id: string; doc_id: string; attempt: number }>();
  const claimed: InformationProcessingJob[] = [];
  for (const job of queued.results) {
    const attempt = Number(job.attempt) + 1;
    if (!await reserveLocalJobProviderSlot(db, job.job_id, "information_processing", attempt, runner, now)) break;
    const update = await db.prepare("update information_processing_jobs set status='running',attempt_count=attempt_count+1,attempt=?,lease_owner=?,lease_until=?,heartbeat_at=?,started_at=coalesce(started_at,?),updated_at=? where job_id=? and status='queued' and attempt=?")
      .bind(attempt, runner, localJobLeaseUntil(now), now, now, now, job.job_id, attempt - 1).run();
    if (update.meta.changes) claimed.push({ job_id: job.job_id, doc_id: job.doc_id, attempt, lease_owner: runner });
    else await releaseLocalJobProviderSlot(db, job.job_id, attempt, runner, now);
  }
  return claimed;
}

export async function loadInformationProcessingJob(db: D1Database, jobId: string): Promise<InformationProcessingJobState | null> {
  return db.prepare("select job_id,doc_id,status,attempt,lease_owner,lease_until,last_run_id from information_processing_jobs where job_id=?").bind(jobId).first<InformationProcessingJobState>();
}

export function ownsInformationProcessingAttempt(request: InformationProcessingModelRequest, jobId: string, job: InformationProcessingJobState | null, runnerInstanceId: unknown, attempt: unknown): boolean {
  return Boolean(job && job.job_id === jobId && job.status === "running" && job.attempt === attempt && job.lease_owner === runnerInstanceId && Number(job.lease_until) >= Date.now() && job.last_run_id === request.runId
    && typeof request.runId === "string" && request.runId.startsWith("knowledge-run:") && typeof request.versionId === "string" && request.versionId.startsWith("knowledge-version:")
    && request.model === "gpt-5.6-luna" && Number.isInteger(request.maxTokens) && request.maxTokens > 0 && typeof request.instructions === "string" && typeof request.input === "string");
}

/** The route transports this result; claim, preparation and terminal fencing stay application-owned. */
export async function claimAndPrepareInformationProcessingJob(env: AppEnv["Bindings"], runnerInstanceId: string) {
  const [job] = await claimInformationProcessingJobs(env.DB, 1, runnerInstanceId);
  if (!job) return null;
  try {
    const prepared = await prepareInformationDocument(env, job.doc_id);
    const now = Date.now();
    if (prepared.kind === "complete") {
      const status = prepared.result.needsReview ? "needs_review" : "completed";
      const updated = await env.DB.prepare("update information_processing_jobs set status=?, last_run_id=?, last_error=null, completed_at=?, updated_at=?, lease_until=null where job_id=? and status='running' and attempt=? and lease_owner=? and lease_until>=?")
        .bind(status, prepared.result.runId, now, now, job.job_id, job.attempt, job.lease_owner, now).run();
      if (!updated.meta.changes) throw new Error("information processing job lease is no longer owned by this runner");
      await releaseLocalJobProviderSlot(env.DB, job.job_id, job.attempt, job.lease_owner, now);
      return { jobId: job.job_id, documentId: job.doc_id, status, attempt: job.attempt, result: prepared.result };
    }
    const updated = await env.DB.prepare("update information_processing_jobs set last_run_id=?, updated_at=? where job_id=? and status='running' and attempt=? and lease_owner=? and lease_until>=?")
      .bind(prepared.request.runId, now, job.job_id, job.attempt, job.lease_owner, now).run();
    if (!updated.meta.changes) throw new Error("information processing job lease is no longer owned by this runner");
    return { jobId: job.job_id, documentId: job.doc_id, status: "running", attempt: job.attempt, runnerInstanceId: job.lease_owner, request: prepared.request };
  } catch (error) {
    const now = Date.now(); const message = error instanceof Error ? error.message : String(error);
    const updated = await env.DB.prepare("update information_processing_jobs set status='failed', last_error=?, completed_at=?, updated_at=?, lease_until=null where job_id=? and status='running' and attempt=? and lease_owner=? and lease_until>=?")
      .bind(message, now, now, job.job_id, job.attempt, job.lease_owner, now).run();
    if (updated.meta.changes) await releaseLocalJobProviderSlot(env.DB, job.job_id, job.attempt, job.lease_owner, now);
    return { jobId: job.job_id, documentId: job.doc_id, status: "failed", attempt: job.attempt, error: message };
  }
}

export async function completeClaimedInformationProcessingJob(env: AppEnv["Bindings"], jobId: string, payload: { request: InformationProcessingModelRequest; text: string; raw: unknown; cached: boolean; runnerInstanceId: string; attempt: number }) {
  const job = await loadInformationProcessingJob(env.DB, jobId);
  if (!ownsInformationProcessingAttempt(payload.request, jobId, job, payload.runnerInstanceId, payload.attempt)) throw new Error("information processing job lease is no longer owned by this runner");
  try {
    const result = await completeInformationProcessing(env, payload.request, payload.text, payload.raw, payload.cached);
    const status = result.needsReview ? "needs_review" : "completed";
    const now = Date.now();
    const updated = await env.DB.prepare("update information_processing_jobs set status=?, last_run_id=?, last_error=null, completed_at=?, updated_at=?, lease_until=null where job_id=? and status='running' and attempt=? and lease_owner=? and lease_until>=?")
      .bind(status, result.runId, now, now, jobId, payload.attempt, payload.runnerInstanceId, now).run();
    if (!updated.meta.changes) throw new Error("information processing job lease is no longer owned by this runner");
    await releaseLocalJobProviderSlot(env.DB, jobId, payload.attempt, payload.runnerInstanceId, now);
    return { status, result };
  } catch (error) {
    const now = Date.now(); const message = error instanceof Error ? error.message : String(error);
    const updated = await env.DB.prepare("update information_processing_jobs set status='failed', last_error=?, completed_at=?, updated_at=?, lease_until=null where job_id=? and status='running' and attempt=? and lease_owner=? and lease_until>=?")
      .bind(message, now, now, jobId, payload.attempt, payload.runnerInstanceId, now).run();
    if (updated.meta.changes) await releaseLocalJobProviderSlot(env.DB, jobId, payload.attempt, payload.runnerInstanceId, now);
    throw error;
  }
}

export async function failClaimedInformationProcessingJob(env: AppEnv["Bindings"], jobId: string, payload: { request: InformationProcessingModelRequest; error: string; runnerInstanceId: string; attempt: number }) {
  const job = await loadInformationProcessingJob(env.DB, jobId);
  if (!ownsInformationProcessingAttempt(payload.request, jobId, job, payload.runnerInstanceId, payload.attempt)) throw new Error("information processing job lease is no longer owned by this runner");
  await failInformationProcessing(env, payload.request, payload.error);
  const now = Date.now();
  const updated = await env.DB.prepare("update information_processing_jobs set status='failed', last_error=?, completed_at=?, updated_at=?, lease_until=null where job_id=? and status='running' and attempt=? and lease_owner=? and lease_until>=?")
    .bind(payload.error, now, now, jobId, payload.attempt, payload.runnerInstanceId, now).run();
  if (!updated.meta.changes) throw new Error("information processing job lease is no longer owned by this runner");
  await releaseLocalJobProviderSlot(env.DB, jobId, payload.attempt, payload.runnerInstanceId, now);
}

export async function heartbeatInformationProcessingJob(db: D1Database, jobId: string, runnerInstanceId: string, attempt: number): Promise<boolean> {
  return renewLocalJobLease(db, "information_processing_jobs", "job_id=?", [jobId], attempt, runnerInstanceId);
}
