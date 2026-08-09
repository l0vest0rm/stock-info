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
  await db.batch([
    db.prepare(`delete from local_job_provider_leases where provider_id=? and not exists (
      select 1 from research_web_search_package_jobs j where j.job_id=local_job_provider_leases.job_id and j.job_type=local_job_provider_leases.job_type and j.status='running' and j.attempt=local_job_provider_leases.attempt and j.lease_owner=local_job_provider_leases.lease_owner and j.lease_until>=?
      union all
      select 1 from research_operating_analysis_jobs j where j.job_id=local_job_provider_leases.job_id and j.job_type=local_job_provider_leases.job_type and j.status='running' and j.attempt=local_job_provider_leases.attempt and j.lease_owner=local_job_provider_leases.lease_owner and j.lease_until>=?
      union all
      select 1 from information_processing_jobs j where j.job_id=local_job_provider_leases.job_id and j.job_type=local_job_provider_leases.job_type and j.status='running' and j.attempt=local_job_provider_leases.attempt and j.lease_owner=local_job_provider_leases.lease_owner and j.lease_until>=?
    )`).bind(LOCAL_JOB_PROVIDER_ID, now, now, now),
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
  const [provider, webSearch, operating, information] = await Promise.all([
    db.prepare("select provider_id as providerId, active_count as activeCount, concurrency_limit as concurrencyLimit, updated_at as updatedAt from local_job_provider_slots where provider_id=?").bind(LOCAL_JOB_PROVIDER_ID).first(),
    db.prepare("select status, count(*) as count from research_web_search_package_jobs group by status").all(),
    db.prepare("select status, count(*) as count from research_operating_analysis_jobs group by status").all(),
    db.prepare("select status, count(*) as count from information_processing_jobs group by status").all(),
  ]);
  return {
    provider,
    handlers: {
      researchWebSearch: { ...config.handlers.researchWebSearch, states: webSearch.results },
      researchOperatingAnalysis: { ...config.handlers.researchOperatingAnalysis, states: operating.results },
      informationProcessing: { ...config.handlers.informationProcessing, states: information.results },
    },
  };
}
