type Row = Record<string, unknown>;

export const RESEARCH_OPERATING_ANALYSIS_RUNNER_LEASE_NAME = "research-operating-analysis-runner";
export const RESEARCH_OPERATING_ANALYSIS_RUNNER_LEASE_MS = 20_000;

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";

/** A single local runner owns one non-resumable llm-client stream at a time. */
export async function renewResearchOperatingAnalysisRunnerLease(db: D1Database, ownerId: string) {
  const owner = ownerId.trim();
  if (!owner) throw new Error("runner instance id is required");
  const now = Date.now();
  const result = await db.prepare(`insert into research_operating_analysis_runner_leases (lease_name, owner_id, heartbeat_at)
    values (?, ?, ?)
    on conflict(lease_name) do update set owner_id=excluded.owner_id, heartbeat_at=excluded.heartbeat_at
    where research_operating_analysis_runner_leases.owner_id=excluded.owner_id
      or research_operating_analysis_runner_leases.heartbeat_at<?`)
    .bind(RESEARCH_OPERATING_ANALYSIS_RUNNER_LEASE_NAME, owner, now, now - RESEARCH_OPERATING_ANALYSIS_RUNNER_LEASE_MS).run();
  return result.meta.changes > 0;
}

export async function ownsResearchOperatingAnalysisRunnerLease(db: D1Database, ownerId: string, now = Date.now()) {
  const lease = await db.prepare(`select owner_id as ownerId, heartbeat_at as heartbeatAt
    from research_operating_analysis_runner_leases where lease_name=?`)
    .bind(RESEARCH_OPERATING_ANALYSIS_RUNNER_LEASE_NAME).first<Row>();
  return text(lease?.ownerId) === ownerId.trim()
    && Number(lease?.heartbeatAt) >= now - RESEARCH_OPERATING_ANALYSIS_RUNNER_LEASE_MS;
}
