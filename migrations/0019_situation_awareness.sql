create table if not exists situation_sources (
  source_id text primary key,
  name text not null,
  kind text not null,
  config_json text not null default '{}',
  health_state text not null default 'disabled' check (health_state in ('healthy', 'degraded', 'failed', 'disabled')),
  last_attempt_at integer,
  last_success_at integer,
  consecutive_failures integer not null default 0,
  last_error text,
  updated_at integer not null
);

create table if not exists situation_evidence (
  evidence_id text primary key,
  source_id text not null,
  external_id text,
  url text not null,
  title text not null,
  excerpt text,
  published_at integer not null,
  fetched_at integer not null,
  content_hash text not null,
  raw_r2_key text,
  entities_json text not null default '[]',
  metadata_json text not null default '{}',
  evidence_grade text not null check (evidence_grade in ('official_confirmed', 'multi_source_confirmed', 'single_source_lead', 'conflicting', 'stale', 'unavailable')),
  status text not null default 'active' check (status in ('active', 'superseded', 'retracted', 'rejected')),
  created_at integer not null,
  unique(source_id, external_id),
  unique(source_id, content_hash),
  foreign key(source_id) references situation_sources(source_id) on delete restrict
);

create index if not exists idx_situation_evidence_published on situation_evidence(published_at desc, source_id);
create index if not exists idx_situation_evidence_grade_status on situation_evidence(evidence_grade, status, fetched_at desc);

create table if not exists situation_events (
  event_id text primary key,
  canonical_key text not null unique,
  title text not null,
  occurred_at integer not null,
  region text not null default 'global',
  event_type text not null,
  status text not null check (status in ('lead', 'confirmed', 'conflicting', 'expired', 'retracted')),
  importance text not null check (importance in ('low', 'medium', 'high', 'unclassified')),
  summary text,
  first_seen_at integer not null,
  last_seen_at integer not null,
  created_at integer not null,
  updated_at integer not null
);

create index if not exists idx_situation_events_recent on situation_events(last_seen_at desc, status, importance);
create index if not exists idx_situation_events_type on situation_events(event_type, occurred_at desc);

create table if not exists situation_event_evidence (
  event_id text not null,
  evidence_id text not null,
  role text not null check (role in ('primary', 'corroborating', 'conflicting')),
  confidence real not null check (confidence >= 0 and confidence <= 1),
  created_at integer not null,
  primary key(event_id, evidence_id),
  foreign key(event_id) references situation_events(event_id) on delete cascade,
  foreign key(evidence_id) references situation_evidence(evidence_id) on delete cascade
);

create table if not exists situation_signals (
  signal_id text primary key,
  subject_type text not null check (subject_type in ('market', 'industry', 'company', 'portfolio')),
  subject_id text not null,
  rule_id text not null,
  rule_version text not null,
  state text not null,
  score real,
  confidence real not null check (confidence >= 0 and confidence <= 1),
  observed_at integer not null,
  expires_at integer,
  input_json text not null,
  explanation_json text not null,
  created_at integer not null
);

create index if not exists idx_situation_signals_subject on situation_signals(subject_type, subject_id, observed_at desc);
create index if not exists idx_situation_signals_expiry on situation_signals(expires_at, observed_at desc);

create table if not exists situation_snapshots (
  snapshot_id text primary key,
  as_of integer not null,
  scope_type text not null check (scope_type in ('market', 'industry', 'company', 'portfolio', 'global')),
  scope_id text not null,
  state text not null,
  confidence real not null check (confidence >= 0 and confidence <= 1),
  summary_json text not null,
  rule_version text not null,
  created_at integer not null,
  unique(as_of, scope_type, scope_id, rule_version)
);

create index if not exists idx_situation_snapshots_scope on situation_snapshots(scope_type, scope_id, as_of desc);

create table if not exists situation_impacts (
  impact_id text primary key,
  event_id text,
  signal_id text,
  target_type text not null check (target_type in ('market', 'industry', 'company', 'portfolio')),
  target_id text not null,
  direction text not null check (direction in ('support', 'pressure', 'mixed', 'unknown')),
  transmission text not null,
  confidence real not null check (confidence >= 0 and confidence <= 1),
  rationale_json text not null,
  expires_at integer,
  created_at integer not null,
  check ((event_id is not null) != (signal_id is not null)),
  foreign key(event_id) references situation_events(event_id) on delete cascade,
  foreign key(signal_id) references situation_signals(signal_id) on delete cascade
);

create index if not exists idx_situation_impacts_target on situation_impacts(target_type, target_id, expires_at);

create table if not exists situation_portfolio_rules (
  owner_key text primary key,
  rules_json text not null,
  updated_at integer not null
);

create table if not exists situation_holding_profiles (
  owner_key text not null,
  code text not null,
  profile_json text not null,
  updated_at integer not null,
  primary key(owner_key, code)
);

create table if not exists situation_action_candidates (
  candidate_id text primary key,
  owner_key text not null,
  as_of integer not null,
  action_type text not null check (action_type in ('research', 'establish', 'add', 'reduce', 'exit', 'rebalance', 'review')),
  target_type text not null check (target_type in ('market', 'industry', 'company', 'portfolio')),
  target_id text not null,
  priority integer not null check (priority between 0 and 100),
  status text not null check (status in ('open', 'blocked', 'expired', 'resolved')),
  prerequisites_json text not null,
  proposed_plan_json text not null,
  invalidations_json text not null,
  evidence_json text not null,
  rule_version text not null,
  expires_at integer,
  created_at integer not null,
  updated_at integer not null
);

create index if not exists idx_situation_candidates_owner on situation_action_candidates(owner_key, status, priority desc, as_of desc);
create index if not exists idx_situation_candidates_target on situation_action_candidates(target_type, target_id, status);

create table if not exists situation_candidate_dispositions (
  disposition_id text primary key,
  candidate_id text not null,
  owner_key text not null,
  disposition text not null check (disposition in ('confirmed', 'ignored', 'deferred', 'researching')),
  note text,
  created_at integer not null,
  foreign key(candidate_id) references situation_action_candidates(candidate_id) on delete cascade
);

create index if not exists idx_situation_dispositions_candidate on situation_candidate_dispositions(candidate_id, created_at desc);
