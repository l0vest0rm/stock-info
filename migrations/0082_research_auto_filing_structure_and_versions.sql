-- Field-level facets make source-bound statutory facts usable as research
-- inputs without turning a model summary into a model assumption.  Every
-- populated facet must still be backed by the same quote and locator.
alter table research_auto_filing_insights add column subject_label text;
alter table research_auto_filing_insights add column segment_label text;
alter table research_auto_filing_insights add column geography_label text;
alter table research_auto_filing_insights add column customer_or_channel text;
alter table research_auto_filing_insights add column driver_key text;
alter table research_auto_filing_insights add column exposure_key text;
alter table research_auto_filing_insights add column causal_direction text;
alter table research_auto_filing_insights add column period_kind text;
alter table research_auto_filing_insights add column numeric_value numeric;
alter table research_auto_filing_insights add column currency text;
alter table research_auto_filing_insights add column amount_scale text;

alter table research_auto_filing_fact_inputs add column subject_label text;
alter table research_auto_filing_fact_inputs add column segment_label text;
alter table research_auto_filing_fact_inputs add column geography_label text;
alter table research_auto_filing_fact_inputs add column customer_or_channel text;
alter table research_auto_filing_fact_inputs add column driver_key text;
alter table research_auto_filing_fact_inputs add column exposure_key text;
alter table research_auto_filing_fact_inputs add column causal_direction text;
alter table research_auto_filing_fact_inputs add column period_kind text;
alter table research_auto_filing_fact_inputs add column numeric_value numeric;
alter table research_auto_filing_fact_inputs add column currency text;
alter table research_auto_filing_fact_inputs add column amount_scale text;
alter table research_auto_filing_fact_inputs add column document_version_id text;
alter table research_auto_filing_fact_inputs add column validity_status text not null default 'current' check (validity_status in ('current', 'historical', 'superseded'));
alter table research_auto_filing_fact_inputs add column superseded_by_document_id text;

-- One official document can supply historical facts forever, while a later
-- document of the same reporting class becomes the current source.  The
-- chain records that distinction instead of deleting old evidence.
create table research_auto_filing_document_versions (
  document_version_id text primary key,
  security_code text not null,
  statutory_document_id text not null,
  document_kind text not null check (document_kind in ('annual', 'interim', 'event', 'other')),
  title text not null,
  published_at text not null,
  document_url text not null,
  report_period text,
  prompt_version text not null,
  extracted_at integer not null,
  is_current integer not null check (is_current in (0, 1)),
  superseded_by_document_id text,
  created_at integer not null,
  updated_at integer not null,
  unique(security_code, statutory_document_id)
);
create index idx_research_auto_filing_document_versions_current
  on research_auto_filing_document_versions(security_code, document_kind, is_current, published_at desc);

-- This is an automatic dependency signal, not a review queue.  Consumers
-- rebuild their own read models from current immutable inputs; no human is
-- expected to accept or approve an event.
create table research_auto_filing_recompute_events (
  recompute_event_id text primary key,
  security_code text not null,
  statutory_document_id text not null,
  target_module text not null check (target_module in ('operating', 'market', 'governance', 'industry', 'forecast', 'risk')),
  reason text not null,
  status text not null check (status in ('pending', 'consumed', 'blocked')),
  created_at integer not null,
  unique(security_code, statutory_document_id, target_module)
);
