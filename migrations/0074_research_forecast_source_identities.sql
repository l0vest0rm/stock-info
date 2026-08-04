-- A visible institution label is not evidence of an independent forecast.
-- These immutable review records make the original provider/republication
-- relationship explicit before a source forecast can enter an aggregation.
create table research_forecast_source_independence_groups (
  independence_group_id text primary key,
  canonical_name text not null unique,
  status text not null check (status in ('confirmed', 'needs_review')),
  created_by text not null,
  created_at integer not null
);
create index idx_research_forecast_source_independence_groups_status
  on research_forecast_source_independence_groups(status, canonical_name);

create table research_forecast_source_identities (
  source_identity_id text primary key,
  display_name text not null,
  identity_type text not null check (identity_type in ('research_provider', 'republisher', 'joint_authorship', 'database_aggregation')),
  independence_group_id text not null,
  evidence_url text not null check (evidence_url like 'https://%'),
  evidence_title text not null,
  evidence_doc_id text,
  identity_status text not null check (identity_status in ('confirmed', 'needs_review')),
  created_by text not null,
  created_at integer not null,
  foreign key(independence_group_id) references research_forecast_source_independence_groups(independence_group_id) on delete restrict,
  foreign key(evidence_doc_id) references knowledge_docs(doc_id) on delete restrict
);
create index idx_research_forecast_source_identities_group
  on research_forecast_source_identities(independence_group_id, identity_status, display_name);

-- Historical rows intentionally remain nullable.  They are excluded by the
-- v3 consolidation rule until re-reviewed against a confirmed source identity.
alter table research_source_forecasts add column source_identity_id text;
create index idx_research_source_forecasts_source_identity
  on research_source_forecasts(source_identity_id, security_code, forecast_date desc);

-- A derived consolidation freezes the identity/group that governed its
-- inclusion at that time.  It must not be reinterpreted from display labels.
alter table research_forecast_consolidation_members add column source_identity_id text;
alter table research_forecast_consolidation_members add column independence_group_id text;
