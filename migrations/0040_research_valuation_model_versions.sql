-- Immutable valuation-model versions.  A result always retains the complete
-- set of inputs, source/epistemic classification, currency bridge and the
-- deterministic calculation rule that produced it.
create table research_valuation_model_versions (
  model_version_id text primary key,
  company_id text,
  security_code text not null,
  as_of integer not null,
  status text not null check (status in ('draft', 'reviewed', 'superseded')),
  model_kind text not null check (model_kind in ('dcf')),
  algorithm_version text not null,
  valuation_currency text not null,
  amount_scale text not null,
  security_currency text not null,
  fx_rate_to_security real,
  fx_as_of integer,
  fx_source_refs_json text not null default '[]',
  underlying_shares_per_security real not null,
  model_inputs_json text not null,
  operating_forecasts_json text not null,
  outputs_json text not null,
  sensitivity_json text not null,
  source_refs_json text not null default '[]',
  created_at integer not null,
  foreign key(company_id) references research_operating_companies(company_id) on delete restrict
);
create index idx_research_valuation_model_versions_security
  on research_valuation_model_versions(security_code, as_of desc, created_at desc);
