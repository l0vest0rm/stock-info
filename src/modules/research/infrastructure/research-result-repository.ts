import type { Database } from "../../../platform/contracts";
/** Durable taskd report artifacts share kv_cache physically, but never expire.
 * v1 keeps legacy top-level fields readable while recording storage semantics.
 * Background writes use optimistic concurrency against the observed task and
 * projection, so an older run cannot overwrite a newer submission/result.
 */
export const RESEARCH_RESULT_NAMESPACES = ["research_investment_analysis", "research_financial_analysis"] as const;
export type ResearchResultNamespace = typeof RESEARCH_RESULT_NAMESPACES[number];
type Observation = { task: { taskId?: number | null; name: string; createdAt: number; updatedAt: number } | null; projectedAt: number | null };

/**
 * Macro and research reports have the same durable task/projection contract.
 * Keep the namespace caller-owned so a new report surface does not need a
 * database table or become part of the research reconciler by accident.
 */
export async function readTaskdReportResult(db: Database, namespace: string, key: string): Promise<{ valueJson: string } | null> {
  return db.prepare("select value_json as valueJson from kv_cache where namespace = ? and key = ?")
    .bind(namespace, key.trim().toUpperCase()).first<{ valueJson: string }>();
}

export async function saveTaskdReportResult(db: Database, namespace: string, key: string, value: Observation, expected?: Observation): Promise<void> {
  const serialized = JSON.stringify({ ...value, storageVersion: 1, retention: "durable" });
  if (expected) {
    await db.prepare(`update kv_cache set value_json = ?, expires_at = null, updated_at = ?
      where namespace = ? and key = ?
      and json_extract(value_json, '$.task.name') is ?
      and json_extract(value_json, '$.task.createdAt') is ?
      and json_extract(value_json, '$.task.updatedAt') is ?
      and json_extract(value_json, '$.task.taskId') is ?
      and json_extract(value_json, '$.projectedAt') is ?`)
      .bind(serialized, Date.now(), namespace, key.trim().toUpperCase(), expected.task?.name ?? null,
        expected.task?.createdAt ?? null, expected.task?.updatedAt ?? null, expected.task?.taskId ?? null,
        expected.projectedAt).run();
    return;
  }
  await db.prepare(`insert into kv_cache (namespace, key, value_json, expires_at, updated_at)
    values (?, ?, ?, null, ?) on conflict(namespace, key) do update set
      value_json = excluded.value_json, expires_at = null, updated_at = excluded.updated_at
    where coalesce(json_extract(excluded.value_json, '$.task.createdAt'), 0) > coalesce(json_extract(kv_cache.value_json, '$.task.createdAt'), 0)
      or (coalesce(json_extract(excluded.value_json, '$.task.createdAt'), 0) = coalesce(json_extract(kv_cache.value_json, '$.task.createdAt'), 0)
        and coalesce(json_extract(excluded.value_json, '$.task.taskId'), 0) >= coalesce(json_extract(kv_cache.value_json, '$.task.taskId'), 0)
        and coalesce(json_extract(excluded.value_json, '$.task.updatedAt'), 0) >= coalesce(json_extract(kv_cache.value_json, '$.task.updatedAt'), 0))`)
    .bind(namespace, key.trim().toUpperCase(), serialized, Date.now()).run();
}

export function readResearchResult(db: Database, namespace: ResearchResultNamespace, code: string) {
  return readTaskdReportResult(db, namespace, code);
}

export function saveResearchResult(db: Database, namespace: ResearchResultNamespace, code: string, value: Observation, expected?: Observation) {
  return saveTaskdReportResult(db, namespace, code, value, expected);
}

export async function listResearchResultsToReconcile(db: Database): Promise<Array<{ namespace: ResearchResultNamespace; code: string }>> {
  const rows = await db.prepare(`select namespace, key as code from kv_cache
    where namespace in (?, ?) and json_valid(value_json)
    and json_extract(value_json, '$.task.name') is not null
    and (json_extract(value_json, '$.task.status') in ('queued', 'leased', 'running', 'interrupt_requested')
      -- A failed task can later be recovered by taskd without stock-info
      -- issuing another provider submission. Keep unprojected records in the
      -- observer set so the local read model cannot remain stuck on failure.
      or (json_extract(value_json, '$.task.status') = 'failed' and json_extract(value_json, '$.pendingProjection') = 1)
      or (json_extract(value_json, '$.task.status') = 'succeeded' and (json_extract(value_json, '$.markdown') is null or json_extract(value_json, '$.pendingProjection') = 1)))
    order by updated_at asc`).bind(...RESEARCH_RESULT_NAMESPACES).all<{ namespace: ResearchResultNamespace; code: string }>();
  return rows.results;
}

export function isObservedTaskdReportTask(expected: Observation["task"], actual: { taskId: number; name: string; createdAt: number }): boolean {
  return Boolean(expected && expected.name === actual.name && expected.createdAt === actual.createdAt
    && (expected.taskId == null || expected.taskId === actual.taskId));
}

export const isObservedResearchTask = isObservedTaskdReportTask;
