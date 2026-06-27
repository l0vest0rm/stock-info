import type { Bindings } from "../types";

export async function runScheduled(
  _event: ScheduledEvent,
  env: Bindings,
  ctx: ExecutionContext
): Promise<void> {
  ctx.waitUntil(recordCronSkip(env));
}

async function recordCronSkip(env: Bindings): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `insert into sync_jobs (job_id, job_type, status, started_at, finished_at, stats_json)
     values (?, 'cron', 'skipped', ?, ?, ?)`
  )
    .bind(crypto.randomUUID(), now, now, JSON.stringify({ reason: "free-tier-mvp-no-bulk-sync" }))
    .run();
}
