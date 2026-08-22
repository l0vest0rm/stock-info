export type HttpCacheRecord = {
  status: number;
  headersJson: string | null;
  bodyText: string;
  expiresAt: number;
  updatedAt: number;
};

export type KvCacheRecord = {
  namespace: string;
  key: string;
  valueJson: string;
  expiresAt: number | null;
  updatedAt: number;
};

export type KvCacheValueRecord = Pick<KvCacheRecord, "valueJson" | "expiresAt" | "updatedAt">;

const LEGACY_KV_CACHE_NAMESPACE_RULES: Array<{ prefix: string; namespace: string }> = [
  { prefix: "company-reports-source:", namespace: "company_reports_source" },
  { prefix: "company-report-discovery:", namespace: "company_report_discovery" },
  { prefix: "report-forecast:", namespace: "company_report_forecast" },
  { prefix: "shared-report-analysis:", namespace: "shared_report_analysis" },
  { prefix: "knowledge-report-analysis:", namespace: "knowledge_report_analysis" },
  { prefix: "company-news-report-analysis:", namespace: "company_news_report_analysis" },
  { prefix: "sina-report-list:", namespace: "sina_report_list" },
  { prefix: "sina-report-detail:", namespace: "sina_report_detail" },
  { prefix: "eastmoney-report-pdf-text:", namespace: "eastmoney_report_pdf_text" },
  { prefix: "llm-daily-quota:", namespace: "daily_llm_quota" },
  { prefix: "companies-follow-config", namespace: "companies_follow_config" },
  { prefix: "us.options.chain.v2.", namespace: "us_option_chain" },
];

export async function getHttpCache(db: D1Database, cacheKey: string, now = Date.now()): Promise<HttpCacheRecord | null> {
  const row = await db
    .prepare(
      `select status, headers_json as headersJson, body_text as bodyText,
        expires_at as expiresAt, updated_at as updatedAt
       from http_cache
       where cache_key = ? and expires_at > ?`
    )
    .bind(cacheKey, now)
    .first<HttpCacheRecord>();
  return row ?? null;
}

export async function putHttpCache(
  db: D1Database,
  record: {
    cacheKey: string;
    url: string;
    method: string;
    status: number;
    headersJson: string | null;
    bodyText: string;
    expiresAt: number;
    updatedAt: number;
  }
): Promise<void> {
  await db
    .prepare(
      `insert into http_cache
        (cache_key, url, method, status, headers_json, body_text, expires_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(cache_key) do update set
        url = excluded.url,
        method = excluded.method,
        status = excluded.status,
        headers_json = excluded.headers_json,
        body_text = excluded.body_text,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at`
    )
    .bind(
      record.cacheKey,
      record.url,
      record.method,
      record.status,
      record.headersJson,
      record.bodyText,
      record.expiresAt,
      record.updatedAt
    )
    .run();
}

export async function getKvCache(
  db: D1Database,
  namespace: string,
  key: string,
  now = Date.now()
): Promise<KvCacheRecord | null> {
  const row = await db
    .prepare(
      `select namespace, key, value_json as valueJson, expires_at as expiresAt, updated_at as updatedAt
       from kv_cache
       where namespace = ? and key = ? and (expires_at is null or expires_at > ?)`
    )
    .bind(namespace, key, now)
    .first<KvCacheRecord>();
  return row ?? null;
}

export async function putKvCache(
  db: D1Database,
  record: {
    namespace: string;
    key: string;
    valueJson: string;
    expiresAt: number | null;
    updatedAt: number;
  }
): Promise<void> {
  await db
    .prepare(
      `insert into kv_cache (namespace, key, value_json, expires_at, updated_at)
       values (?, ?, ?, ?, ?)
       on conflict(namespace, key) do update set
        value_json = excluded.value_json,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at`
    )
    .bind(record.namespace, record.key, record.valueJson, record.expiresAt, record.updatedAt)
    .run();
}

export async function deleteKvCache(db: D1Database, namespace: string, key: string): Promise<void> {
  await db
    .prepare(
      `delete from kv_cache
       where namespace = ? and key = ?`
    )
    .bind(namespace, key)
    .run();
}

export async function listKvCacheByNamespace(
  db: D1Database,
  namespace: string,
  now = Date.now()
): Promise<KvCacheRecord[]> {
  const result = await db
    .prepare(
      `select namespace, key, value_json as valueJson, expires_at as expiresAt, updated_at as updatedAt
       from kv_cache
       where namespace = ? and (expires_at is null or expires_at > ?)
       order by updated_at desc, key asc`
    )
    .bind(namespace, now)
    .all<KvCacheRecord>();
  return result.results ?? [];
}

export function resolveLegacyKvCacheLocation(key: string): { namespace: string; key: string } {
  const normalized = String(key || "").trim();
  for (const rule of LEGACY_KV_CACHE_NAMESPACE_RULES) {
    if (normalized.startsWith(rule.prefix)) return { namespace: rule.namespace, key: normalized };
  }
  throw new Error(`unsupported kv_cache key namespace mapping: ${normalized}`);
}

export async function getKvCacheByLegacyKey(
  db: D1Database,
  key: string,
  now = Date.now()
): Promise<KvCacheValueRecord | null> {
  const location = resolveLegacyKvCacheLocation(key);
  const row = await getKvCache(db, location.namespace, location.key, now);
  return row ? { valueJson: row.valueJson, expiresAt: row.expiresAt, updatedAt: row.updatedAt } : null;
}

export async function putKvCacheByLegacyKey(
  db: D1Database,
  record: {
    key: string;
    valueJson: string;
    expiresAt: number | null;
    updatedAt: number;
  }
): Promise<void> {
  const location = resolveLegacyKvCacheLocation(record.key);
  await putKvCache(db, {
    namespace: location.namespace,
    key: location.key,
    valueJson: record.valueJson,
    expiresAt: record.expiresAt,
    updatedAt: record.updatedAt,
  });
}

const DAILY_LLM_QUOTA_CACHE_NAMESPACE = "daily_llm_quota";

export async function consumeDailyLlmQuota(
  db: D1Database,
  key: string,
  limit: number,
  expiresAt: number,
  updatedAt: number
): Promise<{ allowed: boolean; count: number }> {
  const row = await db
    .prepare(
      `insert into kv_cache (namespace, key, value_json, expires_at, updated_at)
       values (?, ?, json_object('count', 1), ?, ?)
       on conflict(namespace, key) do update set
        value_json = case
          when coalesce(cast(json_extract(kv_cache.value_json, '$.count') as integer), 0) < ?
            then json_object('count', coalesce(cast(json_extract(kv_cache.value_json, '$.count') as integer), 0) + 1)
          else kv_cache.value_json
        end,
        expires_at = case
          when coalesce(cast(json_extract(kv_cache.value_json, '$.count') as integer), 0) < ? then excluded.expires_at
          else kv_cache.expires_at
        end,
        updated_at = case
          when coalesce(cast(json_extract(kv_cache.value_json, '$.count') as integer), 0) < ? then excluded.updated_at
          else kv_cache.updated_at
        end
       returning
        cast(json_extract(value_json, '$.count') as integer) as count,
        updated_at as updatedAt`
    )
    .bind(DAILY_LLM_QUOTA_CACHE_NAMESPACE, key, expiresAt, updatedAt, limit, limit, limit)
    .first<{ count: number | null; updatedAt: number | null }>();
  const count = Number(row?.count ?? 0);
  return {
    allowed: Number(row?.updatedAt ?? 0) === updatedAt,
    count,
  };
}

export async function releaseDailyLlmQuota(
  db: D1Database,
  key: string,
  updatedAt: number
): Promise<void> {
  await db
    .prepare(
      `update kv_cache
       set value_json = json_object(
             'count',
             max(coalesce(cast(json_extract(value_json, '$.count') as integer), 0) - 1, 0)
           ),
           updated_at = ?
       where namespace = ? and key = ?`
    )
    .bind(updatedAt, DAILY_LLM_QUOTA_CACHE_NAMESPACE, key)
    .run();
}
