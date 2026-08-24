-- Keep the two-table macro model while replacing the initial CN/US, 8-category
-- and 60-metric bootstrap constraints with an extensible, row-owned directory.
-- `macro_data` remains the narrow numeric revision ledger.

pragma foreign_keys = off;

alter table macro_data rename to macro_data_pre_0132;
alter table macro_indicators rename to macro_indicators_pre_0132;

create table macro_indicators (
  id integer primary key,
  metric_id integer not null check (metric_id > 0),
  category_id integer not null check (category_id > 0),
  region_code text not null check (length(trim(region_code)) > 0),
  definition_id integer not null default 0 check (definition_id >= 0),

  -- Repeated small-dimension metadata is intentional: the project has only
  -- this catalog table, and a series must be displayable without static maps.
  region_name text not null default '',
  region_sort integer not null default 0,
  category_code text not null default '',
  category_name text not null default '',
  category_sort integer not null default 0,
  metric_code text not null default '',
  metric_name text not null default '',
  metric_description text not null default '',
  metric_sort integer not null default 0,
  statistical_definition text not null default '',
  name text not null,
  frequency text not null check (frequency in ('daily', 'weekly', 'monthly', 'quarterly', 'annual')),
  unit text not null,
  unit_format text not null default 'number',
  seasonal_adjustment text,
  measurement_kind text not null default 'level',
  yoy_method text not null default 'percent_change',
  yoy_base_periods integer not null default 0 check (yoy_base_periods >= 0),
  yoy_display_format text not null default 'percent',
  mom_method text not null default 'percent_change',
  mom_base_periods integer not null default 1 check (mom_base_periods >= 0),
  mom_display_format text not null default 'percent',
  default_trend_periods integer not null default 12 check (default_trend_periods > 0),
  enabled integer not null default 1 check (enabled in (0, 1)),

  source_id text,
  source_series_id text,
  source_url text,
  publisher text,
  publication_timestamp_strategy text,
  source_batch_key text,
  lead_lag text check (lead_lag is null or lead_lag in ('leading', 'coincident', 'lagging')),
  transform_method text,
  stale_after_seconds integer not null default 0 check (stale_after_seconds >= 0),
  refresh_interval_seconds integer not null default 0 check (refresh_interval_seconds >= 0),
  revision_lookback_periods integer not null default 0 check (revision_lookback_periods >= 0),
  next_fetch_at integer,
  last_success_at integer,
  fetch_lease_until integer,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  last_error text,

  -- A concrete statistical series has one stable regional metric identity.
  unique (metric_id, region_code, definition_id)
);

insert into macro_indicators (
  id, metric_id, category_id, region_code, definition_id,
  region_name, region_sort, category_code, category_name, category_sort,
  metric_code, metric_name, metric_description, metric_sort, statistical_definition,
  name, frequency, unit, seasonal_adjustment, enabled,
  source_id, source_series_id, source_url, publisher, lead_lag, transform_method,
  stale_after_seconds, refresh_interval_seconds, revision_lookback_periods,
  next_fetch_at, last_success_at, fetch_lease_until, consecutive_failures, last_error
)
select
  id, metric_id, category_id, region_code, definition_id,
  '', 0, '', '', 0,
  '', '', '', 0, '',
  name, frequency, unit, seasonal_adjustment, enabled,
  source_id, source_series_id, source_url, publisher, lead_lag, transform_method,
  stale_after_seconds, refresh_interval_seconds, revision_lookback_periods,
  next_fetch_at, last_success_at, fetch_lease_until, consecutive_failures, last_error
from macro_indicators_pre_0132;

-- The former table had no region/category/metric directory fields. Empty
-- values above deliberately mark those rows as legacy placeholders; the first
-- operational catalog upsert fills them. We must not invent labels or metric
-- semantics from the old CN/US bootstrap constants during migration.

create table macro_data (
  indicator_id integer not null,
  period_day integer not null check (period_day between 10000101 and 99991231),
  published_at integer not null,
  value real not null,
  primary key (indicator_id, period_day, published_at),
  foreign key (indicator_id) references macro_indicators(id) on delete restrict
) without rowid;

insert into macro_data (indicator_id, period_day, published_at, value)
select indicator_id, period_day, published_at, value from macro_data_pre_0132;

drop table macro_data_pre_0132;
drop table macro_indicators_pre_0132;

create index idx_macro_indicators_due
  on macro_indicators (enabled, next_fetch_at, id);
create index idx_macro_indicators_catalog
  on macro_indicators (enabled, region_sort, category_sort, metric_sort, definition_id);
create index idx_macro_data_published
  on macro_data (published_at desc, indicator_id);

pragma foreign_keys = on;
