-- Durable investment-research identity and forecast ledger.
-- Source forecasts, derived consolidations, analyst scenarios and later actual
-- calibrations are deliberately stored in separate tables.

create table research_operating_companies (
  company_id text primary key,
  canonical_name text not null,
  reporting_currency text,
  fiscal_year_end text,
  identity_status text not null default 'confirmed'
    check (identity_status in ('confirmed', 'provisional', 'needs_review')),
  metadata_json text not null default '{}',
  created_at integer not null,
  updated_at integer not null
);
create table research_listed_securities (
  security_code text primary key,
  company_id text,
  venue text not null,
  trading_currency text,
  share_class text,
  depositary_ratio real,
  mapping_status text not null default 'unresolved'
    check (mapping_status in ('confirmed', 'provisional', 'unresolved', 'conflicting')),
  mapping_basis text,
  metadata_json text not null default '{}',
  created_at integer not null,
  updated_at integer not null,
  foreign key(company_id) references research_operating_companies(company_id) on delete restrict
);
create index idx_research_listed_securities_company
  on research_listed_securities(company_id, mapping_status, security_code);

create table research_forecast_source_reviews (
  review_id text primary key,
  security_code text not null,
  company_id text,
  information_id text not null,
  current_forecast_id text,
  review_status text not null
    check (review_status in ('included', 'excluded', 'needs_review')),
  review_reason text,
  reviewed_by text not null default 'local-user',
  reviewed_at integer not null,
  created_at integer not null,
  updated_at integer not null,
  unique(security_code, information_id),
  foreign key(company_id) references research_operating_companies(company_id) on delete restrict,
  foreign key(information_id) references knowledge_information_records(information_id) on delete restrict
);
create index idx_research_forecast_reviews_security
  on research_forecast_source_reviews(security_code, review_status, reviewed_at desc);

create table research_source_forecasts (
  forecast_id text primary key,
  review_id text not null,
  information_id text not null,
  version_id text not null,
  doc_id text not null,
  security_code text not null,
  company_id text,
  institution text,
  analysts_json text not null default '[]',
  forecast_date text not null,
  metric text not null
    check (metric in ('revenue', 'revenue_growth', 'net_profit', 'net_profit_growth', 'gross_margin', 'eps', 'operating_cash_flow')),
  fiscal_year integer not null,
  fiscal_period text not null,
  raw_value real not null,
  raw_unit text not null,
  currency text,
  accounting_basis text not null default 'unspecified'
    check (accounting_basis in ('gaap', 'non_gaap', 'adjusted', 'unspecified')),
  ownership_basis text not null default 'unspecified'
    check (ownership_basis in ('attributable_to_parent', 'consolidated', 'common_shareholders', 'unspecified')),
  share_basis text not null default 'unspecified'
    check (share_basis in ('basic', 'diluted', 'unspecified')),
  normalized_value real,
  normalized_unit text,
  normalization_status text not null
    check (normalization_status in ('comparable', 'needs_review')),
  normalization_notes text,
  source_statement text not null,
  supersedes_forecast_id text,
  created_at integer not null,
  foreign key(review_id) references research_forecast_source_reviews(review_id) on delete restrict,
  foreign key(information_id) references knowledge_information_records(information_id) on delete restrict,
  foreign key(version_id) references knowledge_document_versions(version_id) on delete restrict,
  foreign key(doc_id) references knowledge_docs(doc_id) on delete restrict,
  foreign key(company_id) references research_operating_companies(company_id) on delete restrict,
  foreign key(supersedes_forecast_id) references research_source_forecasts(forecast_id) on delete restrict
);
create index idx_research_source_forecasts_security
  on research_source_forecasts(security_code, metric, fiscal_year, forecast_date desc);
create index idx_research_source_forecasts_company
  on research_source_forecasts(company_id, metric, fiscal_year, forecast_date desc);

create table research_forecast_consolidations (
  consolidation_id text primary key,
  security_code text not null,
  company_id text,
  as_of integer not null,
  label text not null,
  source_universe text not null,
  market_consensus integer not null default 0 check (market_consensus in (0, 1)),
  rule_version text not null,
  created_at integer not null,
  foreign key(company_id) references research_operating_companies(company_id) on delete restrict
);
create index idx_research_forecast_consolidations_security
  on research_forecast_consolidations(security_code, as_of desc, created_at desc);

create table research_forecast_consolidation_groups (
  group_id text primary key,
  consolidation_id text not null,
  comparison_key text not null,
  metric text not null,
  fiscal_year integer not null,
  currency text,
  normalized_unit text not null,
  accounting_basis text not null,
  ownership_basis text not null,
  share_basis text not null,
  sample_count integer not null,
  median_value real not null,
  mean_value real not null,
  min_value real not null,
  max_value real not null,
  standard_deviation real not null,
  created_at integer not null,
  unique(consolidation_id, comparison_key),
  foreign key(consolidation_id) references research_forecast_consolidations(consolidation_id) on delete restrict
);

create table research_forecast_consolidation_members (
  consolidation_id text not null,
  forecast_id text not null,
  comparison_key text,
  membership_status text not null check (membership_status in ('included', 'excluded')),
  reason_code text not null,
  created_at integer not null,
  primary key(consolidation_id, forecast_id),
  foreign key(consolidation_id) references research_forecast_consolidations(consolidation_id) on delete restrict,
  foreign key(forecast_id) references research_source_forecasts(forecast_id) on delete restrict
);

create table research_forecast_synthesis_drafts (
  draft_id text primary key,
  security_code text not null,
  company_id text,
  consolidation_id text,
  model text not null,
  prompt_version text not null,
  content_markdown text not null,
  source_forecast_ids_json text not null default '[]',
  created_at integer not null,
  foreign key(company_id) references research_operating_companies(company_id) on delete restrict,
  foreign key(consolidation_id) references research_forecast_consolidations(consolidation_id) on delete restrict
);
create index idx_research_forecast_drafts_security
  on research_forecast_synthesis_drafts(security_code, created_at desc);

create table research_forecast_scenarios (
  scenario_id text primary key,
  security_code text not null,
  company_id text,
  scenario_name text not null check (scenario_name in ('downside', 'base', 'upside')),
  version integer not null,
  assumptions_json text not null default '[]',
  outputs_json text not null default '[]',
  evidence_refs_json text not null default '[]',
  status text not null default 'draft' check (status in ('draft', 'reviewed', 'superseded')),
  created_at integer not null,
  updated_at integer not null,
  unique(security_code, scenario_name, version),
  foreign key(company_id) references research_operating_companies(company_id) on delete restrict
);

create table research_forecast_calibrations (
  calibration_id text primary key,
  forecast_id text not null,
  actual_period text not null,
  actual_value real not null,
  actual_unit text not null,
  actual_currency text,
  actual_source text not null,
  absolute_error real not null,
  percentage_error real,
  comparability_status text not null check (comparability_status in ('comparable', 'not_comparable')),
  comparability_notes text,
  created_at integer not null,
  unique(forecast_id, actual_period, actual_source),
  foreign key(forecast_id) references research_source_forecasts(forecast_id) on delete restrict
);
