import type { SecurityRecord } from "../types";

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
  { prefix: "report-forecast:", namespace: "company_report_forecast" },
  { prefix: "shared-report-analysis:", namespace: "shared_report_analysis" },
  { prefix: "knowledge-report-analysis:", namespace: "knowledge_report_analysis" },
  { prefix: "company-news-report-analysis:", namespace: "company_news_report_analysis" },
  { prefix: "sina-report-list:", namespace: "sina_report_list" },
  { prefix: "sina-report-detail:", namespace: "sina_report_detail" },
  { prefix: "eastmoney-report-pdf-text:", namespace: "eastmoney_report_pdf_text" },
  { prefix: "financial-provisional-sync:", namespace: "financial_provisional_sync" },
  { prefix: "llm-daily-quota:", namespace: "daily_llm_quota" },
  { prefix: "companies-follow-config", namespace: "companies_follow_config" },
  { prefix: "us.options.chain.v2.", namespace: "us_option_chain" },
];

export async function upsertSecurity(db: D1Database, record: SecurityRecord): Promise<void> {
  const upsert = db.prepare(
    `insert into securities
        (code, market, type, name, currency, exchange_name, source, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(code) do update set
        market = excluded.market,
        type = excluded.type,
        name = excluded.name,
        currency = excluded.currency,
        exchange_name = excluded.exchange_name,
        source = excluded.source,
        updated_at = excluded.updated_at`
  );
  const prefixDelete = db.prepare("delete from security_search_prefixes where code = ?");
  const prefixInsert = db.prepare(
    `insert into security_search_prefixes (prefix, code, priority)
     values (?, ?, ?)
     on conflict(prefix, code) do update set
       priority = min(security_search_prefixes.priority, excluded.priority)`
  );
  const prefixRows = buildSecuritySearchPrefixes(record);
  await db.batch([
    upsert.bind(
      record.code,
      record.market,
      record.type,
      record.name,
      record.currency ?? null,
      record.exchangeName ?? null,
      record.source ?? null,
      record.updatedAt
    ),
    prefixDelete.bind(record.code),
    ...prefixRows.map((row) => prefixInsert.bind(row.prefix, record.code, row.priority)),
  ]);
}

export async function findSecurity(db: D1Database, code: string): Promise<SecurityRecord | null> {
  const row = await db
    .prepare(
      `select code, market, type, name, currency, exchange_name as exchangeName,
        source, updated_at as updatedAt
       from securities where code = ?`
    )
    .bind(code)
    .first<SecurityRecord>();
  return row ?? null;
}

export async function searchLocalSecurities(db: D1Database, q: string): Promise<SecurityRecord[]> {
  const normalized = normalizeSecuritySearchText(q);
  if (!normalized) {
    return [];
  }
  const result = await db
    .prepare(
      `select securities.code, securities.market, securities.type, securities.name,
        securities.currency, securities.exchange_name as exchangeName,
        securities.source, securities.updated_at as updatedAt
       from securities
       join security_search_prefixes on security_search_prefixes.code = securities.code
       where security_search_prefixes.prefix = ?
       order by
         case
           when lower(securities.code) = ? then 0
           when lower(case
             when instr(securities.code, '.') > 0
               then substr(securities.code, 1, instr(securities.code, '.') - 1)
             else securities.code
           end) = ? then 1
           when lower(securities.name) = ? then 2
           when lower(replace(securities.name, ' ', '')) = ? then 3
           else 4
         end asc,
         security_search_prefixes.priority asc,
         securities.updated_at desc
       limit 10`
    )
    .bind(normalized, normalized, normalized, normalized, normalized)
    .all<SecurityRecord>();
  return result.results ?? [];
}

function buildSecuritySearchPrefixes(record: SecurityRecord): Array<{ prefix: string; priority: number }> {
  const terms = [
    { value: normalizeSecuritySearchText(record.code), priority: 0 },
    { value: normalizeSecuritySearchText(bareSecurityCode(record.code)), priority: 0 },
    { value: normalizeSecuritySearchText(record.name), priority: 1 },
    { value: normalizeSecuritySearchText(String(record.name || "").replace(/\s+/g, "")), priority: 2 },
  ].filter((item) => item.value);
  const seen = new Set<string>();
  const rows: Array<{ prefix: string; priority: number }> = [];
  for (const term of terms) {
    const maxLength = Math.min(term.value.length, 24);
    for (let index = 1; index <= maxLength; index += 1) {
      const prefix = term.value.slice(0, index);
      const key = `${prefix}|${term.priority}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      rows.push({ prefix, priority: term.priority });
    }
  }
  return rows;
}

function normalizeSecuritySearchText(value: string): string {
  return String(value || "").trim().toLowerCase();
}

function bareSecurityCode(code: string): string {
  return String(code || "").trim().split(".")[0] || "";
}

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
