-- Automatic financial-entity classification and specialty metrics are a
-- read model of immutable statutory-filing inputs.  They deliberately do not
-- use the legacy human evidence/review tables: no manual approval is part of
-- the research page's operating model.
create table research_auto_filing_financial_profiles (
  auto_financial_profile_id text primary key,
  source_filing_fact_input_id text not null unique,
  security_code text not null,
  operating_company_id text not null,
  entity_type text not null check (entity_type in ('non_financial', 'bank', 'insurer', 'broker', 'financial_other')),
  as_of text not null,
  source_url text not null,
  source_title text not null,
  source_note text not null,
  evidence_quote text not null,
  evidence_locator text not null,
  extraction_method text not null,
  prompt_version text not null,
  model text not null,
  processed_at integer not null,
  materialized_at integer not null,
  foreign key(source_filing_fact_input_id) references research_auto_filing_fact_inputs(filing_fact_input_id) on delete restrict,
  foreign key(security_code) references research_listed_securities(security_code) on delete restrict,
  foreign key(operating_company_id) references research_operating_companies(company_id) on delete restrict
);
create index idx_research_auto_filing_financial_profiles_security
  on research_auto_filing_financial_profiles(security_code, as_of desc, materialized_at desc);
create index idx_research_auto_filing_financial_profiles_company
  on research_auto_filing_financial_profiles(operating_company_id, as_of desc, materialized_at desc);

create table research_auto_filing_financial_specialty_facts (
  auto_financial_specialty_fact_id text primary key,
  auto_financial_profile_id text not null,
  source_filing_fact_input_id text not null unique,
  security_code text not null,
  operating_company_id text not null,
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
  source_url text not null,
  source_title text not null,
  evidence_quote text not null,
  evidence_locator text not null,
  extraction_method text not null,
  prompt_version text not null,
  model text not null,
  processed_at integer not null,
  materialized_at integer not null,
  foreign key(auto_financial_profile_id) references research_auto_filing_financial_profiles(auto_financial_profile_id) on delete restrict,
  foreign key(source_filing_fact_input_id) references research_auto_filing_fact_inputs(filing_fact_input_id) on delete restrict,
  foreign key(security_code) references research_listed_securities(security_code) on delete restrict,
  foreign key(operating_company_id) references research_operating_companies(company_id) on delete restrict
);
create index idx_research_auto_filing_financial_specialty_security
  on research_auto_filing_financial_specialty_facts(security_code, entity_type, metric_key, as_of desc, materialized_at desc);
create index idx_research_auto_filing_financial_specialty_company
  on research_auto_filing_financial_specialty_facts(operating_company_id, entity_type, metric_key, as_of desc, materialized_at desc);
