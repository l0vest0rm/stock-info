import type { FinancialStatement, FundNavRow, KlineBar, SecurityRecord } from "../types";

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
