-- Formal actuals and calibration records deliberately sit outside the source
-- forecast ledger.  A restatement is a new immutable fact, never an update of
-- the historical result used by an old forecast.

create table research_management_guidance_forecasts (
  guidance_forecast_id text primary key,
  security_code text not null,
  company_id text,
  guidance_date text not null,
  metric text not null check (metric in ('revenue', 'revenue_growth', 'net_profit', 'net_profit_growth', 'gross_margin', 'eps', 'operating_cash_flow')),
  fiscal_year integer not null,
  fiscal_period text not null,
  raw_value real not null,
  raw_unit text not null,
  currency text,
  accounting_basis text not null check (accounting_basis in ('gaap', 'non_gaap', 'adjusted', 'unspecified')),
  ownership_basis text not null check (ownership_basis in ('attributable_to_parent', 'consolidated', 'common_shareholders', 'unspecified')),
  share_basis text not null check (share_basis in ('basic', 'diluted', 'unspecified')),
  normalized_value real,
  normalized_unit text,
  normalization_status text not null check (normalization_status in ('comparable', 'needs_review')),
  normalization_notes text,
  guidance_conditions text not null,
  source_statement text not null,
  source_refs_json text not null,
  supersedes_guidance_forecast_id text,
  created_at integer not null,
  foreign key(company_id) references research_operating_companies(company_id) on delete restrict,
  foreign key(supersedes_guidance_forecast_id) references research_management_guidance_forecasts(guidance_forecast_id) on delete restrict
);
create index idx_research_management_guidance_forecasts_security
  on research_management_guidance_forecasts(security_code, metric, fiscal_year, guidance_date desc, created_at desc);

create table research_formal_actuals (
  actual_id text primary key,
  security_code text not null,
  company_id text,
  metric text not null check (metric in ('revenue', 'revenue_growth', 'net_profit', 'net_profit_growth', 'gross_margin', 'eps', 'operating_cash_flow')),
  fiscal_year integer not null,
  fiscal_period text not null,
  raw_value real not null,
  raw_unit text not null,
  currency text,
  accounting_basis text not null check (accounting_basis in ('gaap', 'non_gaap', 'adjusted', 'unspecified')),
  ownership_basis text not null check (ownership_basis in ('attributable_to_parent', 'consolidated', 'common_shareholders', 'unspecified')),
  share_basis text not null check (share_basis in ('basic', 'diluted', 'unspecified')),
  normalized_value real,
  normalized_unit text,
  normalization_status text not null check (normalization_status in ('comparable', 'needs_review')),
  normalization_notes text,
  actual_status text not null check (actual_status in ('original', 'restated', 'superseded')),
  revision_number integer not null check (revision_number > 0),
  supersedes_actual_id text,
  restatement_note text,
  filed_at text not null,
  source_statement text not null,
  source_refs_json text not null,
  created_at integer not null,
  unique(security_code, metric, fiscal_period, revision_number),
  foreign key(company_id) references research_operating_companies(company_id) on delete restrict,
  foreign key(supersedes_actual_id) references research_formal_actuals(actual_id) on delete restrict,
  check ((actual_status = 'original' and supersedes_actual_id is null and restatement_note is null)
    or (actual_status = 'restated' and supersedes_actual_id is not null and restatement_note is not null)
    or actual_status = 'superseded')
);
create index idx_research_formal_actuals_security
  on research_formal_actuals(security_code, metric, fiscal_year, revision_number desc, filed_at desc);

create table research_forecast_actual_calibration_records (
  calibration_id text primary key,
  security_code text not null,
  company_id text,
  forecast_kind text not null check (forecast_kind in ('management_guidance', 'third_party_forecast')),
  forecast_id text not null,
  actual_id text not null,
  metric text not null,
  fiscal_period text not null,
  currency text,
  normalized_unit text,
  accounting_basis text,
  ownership_basis text,
  share_basis text,
  forecast_normalized_value real,
  actual_normalized_value real,
  absolute_error real,
  percentage_error real,
  comparability_status text not null check (comparability_status in ('comparable', 'not_comparable')),
  comparability_reason text,
  calibrated_at integer not null,
  unique(forecast_kind, forecast_id, actual_id),
  foreign key(company_id) references research_operating_companies(company_id) on delete restrict,
  foreign key(actual_id) references research_formal_actuals(actual_id) on delete restrict,
  check ((comparability_status = 'comparable' and comparability_reason is null and absolute_error is not null)
    or (comparability_status = 'not_comparable' and comparability_reason is not null and absolute_error is null and percentage_error is null))
);
create index idx_research_forecast_actual_calibration_records_security
  on research_forecast_actual_calibration_records(security_code, forecast_kind, calibrated_at desc);
