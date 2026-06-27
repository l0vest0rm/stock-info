import type { FinancialStatement, FundNavRow, KlineBar, SecurityRecord } from "../types";

export type HttpCacheRecord = {
  status: number;
  headersJson: string | null;
  bodyText: string;
  expiresAt: number;
  updatedAt: number;
};

export type LlmCacheRecord = {
  responseJson: string;
  expiresAt: number;
  updatedAt: number;
};

export type AppKvRecord = {
  valueJson: string;
  expiresAt: number | null;
  updatedAt: number;
};

export async function upsertSecurity(db: D1Database, record: SecurityRecord): Promise<void> {
  await db
    .prepare(
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
    )
    .bind(
      record.code,
      record.market,
      record.type,
      record.name,
      record.currency ?? null,
      record.exchangeName ?? null,
      record.source ?? null,
      record.updatedAt
    )
    .run();
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
  const like = `%${q}%`;
  const result = await db
    .prepare(
      `select code, market, type, name, currency, exchange_name as exchangeName,
        source, updated_at as updatedAt
       from securities
       where code like ? or name like ?
       order by updated_at desc
       limit 10`
    )
    .bind(like, like)
    .all<SecurityRecord>();
  return result.results ?? [];
}

export async function upsertKlineBars(db: D1Database, rows: KlineBar[]): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  const stmt = db.prepare(
    `insert into kline_bars
      (code, period, fq, date, open, close, high, low, volume, amount, amplitude,
       pct_change, change_amount, turnover, source, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(code, period, fq, date) do update set
       open = excluded.open,
       close = excluded.close,
       high = excluded.high,
       low = excluded.low,
       volume = excluded.volume,
       amount = excluded.amount,
       amplitude = excluded.amplitude,
       pct_change = excluded.pct_change,
       change_amount = excluded.change_amount,
       turnover = excluded.turnover,
       source = excluded.source,
       updated_at = excluded.updated_at`
  );
  await db.batch(
    rows.map((row) =>
      stmt.bind(
        row.code,
        row.period,
        row.fq,
        row.date,
        row.open,
        row.close,
        row.high,
        row.low,
        row.volume,
        row.amount,
        row.amplitude,
        row.pctChange,
        row.changeAmount,
        row.turnover,
        row.source,
        row.updatedAt
      )
    )
  );
}

export async function getKlineBars(
  db: D1Database,
  code: string,
  period: string,
  fq: string,
  from: string,
  to: string
): Promise<KlineBar[]> {
  const result = await db
    .prepare(
      `select code, period, fq, date, open, close, high, low, volume, amount, amplitude,
        pct_change as pctChange, change_amount as changeAmount, turnover, source,
        updated_at as updatedAt
       from kline_bars
       where code = ? and period = ? and fq = ? and date >= ? and date <= ?
       order by date asc`
    )
    .bind(code, period, fq, from, to)
    .all<KlineBar>();
  return result.results ?? [];
}

export async function upsertFundNav(db: D1Database, rows: FundNavRow[]): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  const stmt = db.prepare(
    `insert into fund_nav
      (code, date, nav, accum_nav, daily_return, subscription_status, redemption_status, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(code, date) do update set
       nav = excluded.nav,
       accum_nav = excluded.accum_nav,
       daily_return = excluded.daily_return,
       subscription_status = excluded.subscription_status,
       redemption_status = excluded.redemption_status,
       updated_at = excluded.updated_at`
  );
  await db.batch(
    rows.map((row) =>
      stmt.bind(
        row.code,
        row.date,
        row.nav,
        row.accumNav,
        row.dailyReturn,
        row.subscriptionStatus,
        row.redemptionStatus,
        row.updatedAt
      )
    )
  );
}

export async function getFundNavRows(
  db: D1Database,
  code: string,
  from: string,
  to: string
): Promise<FundNavRow[]> {
  const result = await db
    .prepare(
      `select code, date, nav, accum_nav as accumNav, daily_return as dailyReturn,
        subscription_status as subscriptionStatus, redemption_status as redemptionStatus,
        updated_at as updatedAt
       from fund_nav
       where code = ? and date >= ? and date <= ?
       order by date asc`
    )
    .bind(code, from, to)
    .all<FundNavRow>();
  return result.results ?? [];
}

export async function upsertFinancialStatements(
  db: D1Database,
  rows: FinancialStatement[]
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  const stmt = db.prepare(
    `insert into financial_statements
      (code, statement_type, report_date, fiscal_period, payload_json, source, raw_r2_key, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(code, statement_type, report_date) do update set
       fiscal_period = excluded.fiscal_period,
       payload_json = excluded.payload_json,
       source = excluded.source,
       raw_r2_key = excluded.raw_r2_key,
       updated_at = excluded.updated_at`
  );
  await db.batch(
    rows.map((row) =>
      stmt.bind(
        row.code,
        row.statementType,
        row.reportDate,
        row.fiscalPeriod,
        JSON.stringify(row.payload),
        row.source,
        row.rawR2Key,
        row.updatedAt
      )
    )
  );
}

export async function getFinancialStatements(
  db: D1Database,
  code: string,
  statementType: string
): Promise<FinancialStatement[]> {
  const result = await db
    .prepare(
      `select code, statement_type as statementType, report_date as reportDate,
        fiscal_period as fiscalPeriod, payload_json as payloadJson, source,
        raw_r2_key as rawR2Key, updated_at as updatedAt
       from financial_statements
       where code = ? and statement_type = ?
       order by report_date desc
       limit 16`
    )
    .bind(code, statementType)
    .all<
      Omit<FinancialStatement, "payload"> & {
        payloadJson: string;
      }
    >();
  return (result.results ?? []).map((row) => ({
    ...row,
    payload: JSON.parse(row.payloadJson),
  }));
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

export async function getAppKv(db: D1Database, key: string, now = Date.now()): Promise<AppKvRecord | null> {
  const row = await db
    .prepare(
      `select value_json as valueJson, expires_at as expiresAt, updated_at as updatedAt
       from app_kv
       where key = ? and (expires_at is null or expires_at > ?)`
    )
    .bind(key, now)
    .first<AppKvRecord>();
  return row ?? null;
}

export async function putAppKv(
  db: D1Database,
  record: {
    key: string;
    valueJson: string;
    expiresAt: number | null;
    updatedAt: number;
  }
): Promise<void> {
  await db
    .prepare(
      `insert into app_kv (key, value_json, expires_at, updated_at)
       values (?, ?, ?, ?)
       on conflict(key) do update set
        value_json = excluded.value_json,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at`
    )
    .bind(record.key, record.valueJson, record.expiresAt, record.updatedAt)
    .run();
}

export async function getLlmCache(db: D1Database, cacheKey: string, now = Date.now()): Promise<LlmCacheRecord | null> {
  const row = await db
    .prepare(
      `select response_json as responseJson, expires_at as expiresAt, updated_at as updatedAt
       from llm_cache
       where cache_key = ? and expires_at > ?`
    )
    .bind(cacheKey, now)
    .first<LlmCacheRecord>();
  return row ?? null;
}

export async function putLlmCache(
  db: D1Database,
  record: {
    cacheKey: string;
    provider: string;
    model: string;
    requestJson: string;
    responseJson: string;
    expiresAt: number;
    updatedAt: number;
  }
): Promise<void> {
  await db
    .prepare(
      `insert into llm_cache
        (cache_key, provider, model, request_json, response_json, expires_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?)
       on conflict(cache_key) do update set
        provider = excluded.provider,
        model = excluded.model,
        request_json = excluded.request_json,
        response_json = excluded.response_json,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at`
    )
    .bind(
      record.cacheKey,
      record.provider,
      record.model,
      record.requestJson,
      record.responseJson,
      record.expiresAt,
      record.updatedAt
    )
    .run();
}

export async function consumeDailyLlmQuota(
  db: D1Database,
  key: string,
  limit: number,
  expiresAt: number,
  updatedAt: number
): Promise<{ allowed: boolean; count: number }> {
  const row = await db
    .prepare(
      `insert into app_kv (key, value_json, expires_at, updated_at)
       values (?, json_object('count', 1), ?, ?)
       on conflict(key) do update set
        value_json = case
          when coalesce(cast(json_extract(app_kv.value_json, '$.count') as integer), 0) < ?
            then json_object('count', coalesce(cast(json_extract(app_kv.value_json, '$.count') as integer), 0) + 1)
          else app_kv.value_json
        end,
        expires_at = case
          when coalesce(cast(json_extract(app_kv.value_json, '$.count') as integer), 0) < ? then excluded.expires_at
          else app_kv.expires_at
        end,
        updated_at = case
          when coalesce(cast(json_extract(app_kv.value_json, '$.count') as integer), 0) < ? then excluded.updated_at
          else app_kv.updated_at
        end
       returning
        cast(json_extract(value_json, '$.count') as integer) as count,
        updated_at as updatedAt`
    )
    .bind(key, expiresAt, updatedAt, limit, limit, limit)
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
      `update app_kv
       set value_json = json_object(
             'count',
             max(coalesce(cast(json_extract(value_json, '$.count') as integer), 0) - 1, 0)
           ),
           updated_at = ?
       where key = ?`
    )
    .bind(updatedAt, key)
    .run();
}
