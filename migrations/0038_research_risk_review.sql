-- Public, auditable research-risk review records. These tables intentionally
-- exclude owner keys and portfolio scopes: personal positions and trade plans
-- remain in their private decision stores and must not leak into research.

create table research_risk_pressure_scenarios (
  scenario_id text primary key,
  company_id text,
  security_code text not null,
  as_of integer not null,
  scenario_key text not null,
  version integer not null check (version > 0),
  supersedes_scenario_id text,
  status text not null check (status in ('draft', 'reviewed', 'superseded')),
  scope text not null check (scope in ('operating_company', 'listed_security')),
  title text not null,
  transmission text not null,
  model_version text not null,
  inputs_json text not null,
  results_json text not null,
  source_refs_json text not null default '[]',
  created_at integer not null,
  updated_at integer not null,
  unique(security_code, scenario_key, version),
  foreign key(company_id) references research_operating_companies(company_id) on delete restrict,
  foreign key(supersedes_scenario_id) references research_risk_pressure_scenarios(scenario_id) on delete restrict
);
create index idx_research_risk_pressure_security on research_risk_pressure_scenarios(security_code, as_of desc, scenario_key, version desc);
create index idx_research_risk_pressure_company on research_risk_pressure_scenarios(company_id, as_of desc);

create table research_risk_relationships (
  relationship_id text primary key,
  company_id text,
  security_code text not null,
  as_of integer not null,
  scope text not null check (scope in ('operating_company', 'listed_security')),
  relationship_type text not null check (relationship_type in ('customer', 'supplier', 'geography', 'product', 'channel', 'financing', 'asset', 'regulation', 'other')),
  counterparty_name text not null,
  description text not null,
  transmission text not null,
  concentration_value real check (concentration_value is null or (concentration_value >= 0 and concentration_value <= 1)),
  concentration_basis text,
  status text not null check (status in ('active', 'historical', 'unavailable')),
  epistemic_type text not null check (epistemic_type in ('observed_fact', 'management_guidance', 'source_viewpoint', 'third_party_forecast', 'analysis_assumption', 'system_judgment')),
  source_refs_json text not null default '[]',
  created_at integer not null,
  updated_at integer not null,
  foreign key(company_id) references research_operating_companies(company_id) on delete restrict
);
create index idx_research_risk_relationships_security on research_risk_relationships(security_code, as_of desc, relationship_type, status);
create index idx_research_risk_relationships_company on research_risk_relationships(company_id, as_of desc, relationship_type, status);

-- One row is an explicit, inspectable change for one public research module.
-- No owner_key is present by design; a snapshot comparison is not a trade log.
create table research_snapshot_module_differences (
  difference_id text primary key,
  company_id text,
  security_code text not null,
  baseline_snapshot_id text,
  current_snapshot_id text not null,
  module_id text not null,
  diff_version text not null,
  change_type text not null check (change_type in ('added', 'removed', 'changed')),
  baseline_json text not null,
  current_json text not null,
  fields_json text not null,
  created_at integer not null,
  unique(current_snapshot_id, module_id, diff_version),
  foreign key(company_id) references research_operating_companies(company_id) on delete restrict,
  foreign key(baseline_snapshot_id) references research_analysis_snapshots(analysis_snapshot_id) on delete restrict,
  foreign key(current_snapshot_id) references research_analysis_snapshots(analysis_snapshot_id) on delete restrict
);
create index idx_research_snapshot_differences_security on research_snapshot_module_differences(security_code, created_at desc, module_id);
