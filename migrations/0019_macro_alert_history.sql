-- Alert evaluations are retained as evidence. The unique key prevents a
-- repeated manual check from creating duplicate alerts for the same observed
-- data vintage and threshold rule, while allowing a later official revision
-- to create a distinct record.
create table if not exists macro_alert_history (
  alert_id integer primary key,
  owner_key text not null,
  series_id text not null,
  observation_date text not null,
  observation_vintage_at integer not null,
  observed_at integer not null,
  value real not null,
  rule_operator text not null check (rule_operator in ('gte', 'lte')),
  rule_threshold real not null,
  source_url text,
  notification_state text not null default 'not_configured',
  notification_detail text,
  evaluated_at integer not null,
  metadata_json text not null default '{}',
  foreign key(series_id) references macro_series(series_id) on delete restrict,
  unique(owner_key, series_id, observation_date, observation_vintage_at, rule_operator, rule_threshold)
);

create index if not exists idx_macro_alert_history_owner_evaluated
  on macro_alert_history(owner_key, evaluated_at desc);
