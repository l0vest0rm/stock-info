create table if not exists securities (
  code text primary key,
  market text not null,
  type text not null,
  name text not null,
  currency text,
  exchange_name text,
  source text,
  updated_at integer not null
);

create index if not exists idx_securities_type_name on securities(type, name);

create table if not exists security_aliases (
  alias text not null,
  code text not null,
  source text not null,
  updated_at integer not null,
  primary key(alias, code, source)
);

create index if not exists idx_security_aliases_code on security_aliases(code);

create table if not exists kline_bars (
  code text not null,
  period text not null,
  fq text not null,
  date text not null,
  open real,
  close real,
  high real,
  low real,
  volume real,
  amount real,
  amplitude real,
  pct_change real,
  change_amount real,
  turnover real,
  source text,
  updated_at integer not null,
  primary key(code, period, fq, date)
);

create index if not exists idx_kline_bars_code_date on kline_bars(code, date);

create table if not exists fund_nav (
  code text not null,
  date text not null,
  nav real,
  accum_nav real,
  daily_return real,
  subscription_status text,
  redemption_status text,
  updated_at integer not null,
  primary key(code, date)
);

create table if not exists financial_statements (
  code text not null,
  statement_type text not null,
  report_date text not null,
  fiscal_period text,
  payload_json text not null,
  source text,
  raw_r2_key text,
  updated_at integer not null,
  primary key(code, statement_type, report_date)
);

create index if not exists idx_financial_statements_code_type
  on financial_statements(code, statement_type, report_date);

create table if not exists company_notices (
  notice_id text primary key,
  code text not null,
  title text not null,
  publish_date text,
  notice_type text,
  source text,
  pdf_r2_key text,
  raw_r2_key text,
  updated_at integer not null
);

create index if not exists idx_company_notices_code_date on company_notices(code, publish_date);

create table if not exists watchlist_items (
  code text primary key,
  enabled integer not null default 1,
  priority integer not null default 100,
  tags text,
  updated_at integer not null
);

create table if not exists sync_jobs (
  job_id text primary key,
  job_type text not null,
  status text not null,
  started_at integer not null,
  finished_at integer,
  error text,
  stats_json text
);

create index if not exists idx_sync_jobs_type_started on sync_jobs(job_type, started_at);
