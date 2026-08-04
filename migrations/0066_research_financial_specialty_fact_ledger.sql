-- Financial-specialty source facts are immutable observations, not a bank,
-- insurer, or broker scoring model.  Every row must descend from an accepted
-- information-preprocessing evidence reference and from a contemporaneously
-- confirmed financial-entity profile.  It deliberately has no FK to an
-- operating model, scenario, forecast, valuation, decision, or trade.
create table research_financial_specialty_fact_versions (
  financial_specialty_fact_id text primary key,
  financial_profile_id text not null,
  company_id text not null,
  security_code text not null,
  evidence_reference_id text not null,
  candidate_id text not null,
  candidate_review_id text not null,
  entity_type text not null check (entity_type in ('bank', 'insurer', 'broker')),
  metric_key text not null,
  reported_label text not null,
  reported_value text not null,
  value_number real not null,
  unit text not null,
  currency text,
  amount_scale text,
  as_of text not null,
  period_label text not null,
  definition_note text not null,
  comparability_note text not null,
  statement text not null,
  source_url text,
  content_url text,
  source_title text,
  source_name text,
  published_at text,
  source_locator text not null,
  metric_config_version text not null,
  recorded_by text not null,
  recorded_at integer not null,
  created_at integer not null,
  foreign key(financial_profile_id) references research_company_financial_profiles(financial_profile_id) on delete restrict,
  foreign key(company_id) references research_operating_companies(company_id) on delete restrict,
  foreign key(security_code) references research_listed_securities(security_code) on delete restrict,
  foreign key(evidence_reference_id) references research_reusable_evidence_references(evidence_reference_id) on delete restrict,
  foreign key(candidate_id) references research_information_evidence_candidates(candidate_id) on delete restrict,
  foreign key(candidate_review_id) references research_information_evidence_candidate_reviews(candidate_review_id) on delete restrict,
  unique(evidence_reference_id, financial_profile_id, metric_key, as_of, reported_value)
);
create index idx_research_financial_specialty_facts_company_metric
  on research_financial_specialty_fact_versions(company_id, entity_type, metric_key, as_of desc, recorded_at desc, financial_specialty_fact_id desc);
create index idx_research_financial_specialty_facts_security
  on research_financial_specialty_fact_versions(security_code, recorded_at desc, financial_specialty_fact_id desc);
