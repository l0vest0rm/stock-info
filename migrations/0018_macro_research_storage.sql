create table if not exists macro_series (
  series_id text primary key,
  name text not null,
  category text not null,
  region text not null,
  frequency text not null,
  unit text not null,
  source_id text not null,
  transmission_json text not null default '[]',
  regions_json text not null default '[]',
  license_class text not null default 'official',
  stale_after_seconds integer not null,
  enabled integer not null default 1 check (enabled in (0, 1)),
  metadata_json text not null default '{}',
  updated_at integer not null
);

create index if not exists idx_macro_series_region_category
  on macro_series(region, category, enabled);
create index if not exists idx_macro_series_source
  on macro_series(source_id, enabled);

-- A row is an immutable view of an observation as known at one release/revision.
-- Ingesting a later revision therefore never destroys the initially released value.
create table if not exists macro_observation_vintages (
  series_id text not null,
  observation_date text not null,
  released_at integer not null,
  vintage_at integer not null,
  revision_number integer not null default 0,
  value real not null,
  consensus real,
  previous_value real,
  is_preliminary integer not null default 0 check (is_preliminary in (0, 1)),
  quality_status text not null default 'valid',
  source_url text,
  raw_r2_key text,
  observed_at integer not null,
  primary key(series_id, observation_date, vintage_at),
  foreign key(series_id) references macro_series(series_id) on delete cascade
);

create index if not exists idx_macro_observation_vintages_series_date
  on macro_observation_vintages(series_id, observation_date, vintage_at desc);
create index if not exists idx_macro_observation_vintages_released
  on macro_observation_vintages(released_at desc);

create table if not exists macro_events (
  event_id text primary key,
  scheduled_at integer not null,
  region text not null,
  importance text not null,
  title text not null,
  series_id text,
  actual real,
  consensus real,
  previous real,
  unit text,
  status text not null default 'scheduled',
  source_id text not null,
  source_url text,
  metadata_json text not null default '{}',
  updated_at integer not null,
  foreign key(series_id) references macro_series(series_id) on delete set null
);

create index if not exists idx_macro_events_scheduled_region
  on macro_events(scheduled_at, region, importance);

create table if not exists macro_source_health (
  source_id text primary key,
  display_name text not null,
  state text not null,
  last_attempt_at integer,
  last_success_at integer,
  consecutive_failures integer not null default 0,
  last_error text,
  next_retry_at integer,
  latency_ms integer,
  metadata_json text not null default '{}',
  updated_at integer not null
);

create table if not exists macro_user_watch_configs (
  owner_key text not null,
  series_id text not null,
  enabled integer not null default 1 check (enabled in (0, 1)),
  position integer not null default 100,
  alert_rules_json text not null default '[]',
  display_options_json text not null default '{}',
  created_at integer not null,
  updated_at integer not null,
  primary key(owner_key, series_id),
  foreign key(series_id) references macro_series(series_id) on delete cascade
);

create index if not exists idx_macro_user_watch_configs_owner
  on macro_user_watch_configs(owner_key, enabled, position);
