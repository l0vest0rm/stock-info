-- Source-bound external industry time-series observations.  These are not
-- company disclosures and may only be written by the local source extractor
-- after an allow-listed authority document has been imported to knowledge.
create table research_industry_source_series_observations (
  industry_series_observation_id text primary key,
  security_code text not null,
  industry_key text not null,
  metric_key text not null,
  metric_label text not null,
  period_label text not null,
  numeric_value real not null,
  unit text not null,
  currency text,
  amount_scale text,
  geographic_scope text,
  product_scope text,
  statistical_method text,
  source_doc_id text not null,
  source_url text not null,
  source_title text not null,
  source_authority text not null check (source_authority in ('government', 'official_association', 'official_exchange', 'regulator')),
  evidence_quote text not null,
  evidence_locator text not null,
  extraction_method text not null,
  prompt_version text not null,
  model text not null,
  processed_at integer not null,
  created_at integer not null,
  unique(security_code, source_doc_id, metric_key, period_label, prompt_version)
);
create index idx_research_industry_source_series_lookup
  on research_industry_source_series_observations(security_code, industry_key, metric_key, period_label desc, processed_at desc);
