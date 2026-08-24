-- The redesigned macro module keeps its catalog and numeric facts separate.
-- Do not add provenance, derived values, or scheduler state to macro_data.
create table if not exists macro_indicators (
  id integer primary key,
  metric_id integer not null check (metric_id between 1 and 60),
  category_id integer not null check (category_id between 1 and 8),
  region_code text not null check (region_code in ('CN', 'US')),
  definition_id integer not null default 0,
  name text not null,
  frequency text not null check (frequency in ('daily', 'weekly', 'monthly', 'quarterly', 'annual')),
  unit text not null,
  enabled integer not null default 1 check (enabled in (0, 1)),

  -- Source and statistical-definition contract.  A NULL source is an
  -- intentionally visible-but-unmapped catalog entry, not a synthetic value.
  source_id text,
  source_series_id text,
  source_url text,
  publisher text,
  seasonal_adjustment text,
  lead_lag text check (lead_lag is null or lead_lag in ('leading', 'coincident', 'lagging')),
  transform_method text,
  stale_after_seconds integer not null default 0 check (stale_after_seconds >= 0),

  -- Scheduling state is per concrete source series.  A zero interval and
  -- NULL next_fetch_at deliberately keep an unverified mapping unscheduled.
  refresh_interval_seconds integer not null default 0 check (refresh_interval_seconds >= 0),
  revision_lookback_periods integer not null default 0 check (revision_lookback_periods >= 0),
  next_fetch_at integer,
  last_success_at integer,
  fetch_lease_until integer,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  last_error text,

  unique (metric_id, region_code, definition_id)
);

-- The scheduler only scans enabled, explicitly scheduled indicators.  It must
-- claim every selected row conditionally before fetching it.
create index if not exists idx_macro_indicators_due
  on macro_indicators (enabled, next_fetch_at, id);

create table if not exists macro_data (
  indicator_id integer not null,
  period_day integer not null check (period_day between 10000101 and 99991231),
  published_at integer not null,
  value real not null,

  primary key (indicator_id, period_day, published_at),
  foreign key (indicator_id) references macro_indicators(id) on delete restrict
) without rowid;

create index if not exists idx_macro_data_published
  on macro_data (published_at desc, indicator_id);
