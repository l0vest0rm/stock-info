-- Versioned industry tracks, evidence-bound company exposures, and explicitly
-- qualified peer universes. These records describe research inputs and
-- comparability limits; they never store an investment conclusion or ranking.

create table research_industry_profiles (
  industry_profile_id text primary key,
  industry_key text not null,
  taxonomy text not null,
  taxonomy_version text not null,
  industry_name text not null,
  parent_industry_key text,
  as_of integer not null,
  version integer not null check (version > 0),
  status text not null check (status in ('draft', 'reviewed', 'superseded')),
  definition text not null,
  demand_drivers_json text not null default '[]',
  supply_structure_json text not null default '{}',
  cycle_characteristics_json text not null default '{}',
  value_chain_json text not null default '[]',
  epistemic_type text not null check (epistemic_type in (
    'observed_fact', 'management_guidance', 'source_viewpoint',
    'third_party_forecast', 'analysis_assumption', 'system_judgment'
  )),
  source_refs_json text not null default '[]',
  created_at integer not null,
  updated_at integer not null,
  unique(industry_key, taxonomy, taxonomy_version, version)
);
create index idx_research_industry_profiles_lookup
  on research_industry_profiles(industry_key, taxonomy, taxonomy_version, as_of desc, version desc);

create table research_company_industry_exposures (
  exposure_id text primary key,
  company_id text not null,
  industry_profile_id text not null,
  as_of integer not null,
  version integer not null check (version > 0),
  status text not null check (status in ('draft', 'reviewed', 'superseded')),
  selection_basis text not null check (selection_basis in ('primary_business')),
  primary_business_description text not null,
  exposure_scope_json text not null default '{}',
  exposure_share_json text not null default '{}',
  epistemic_type text not null check (epistemic_type in (
    'observed_fact', 'management_guidance', 'source_viewpoint',
    'third_party_forecast', 'analysis_assumption', 'system_judgment'
  )),
  source_refs_json text not null default '[]',
  created_at integer not null,
  updated_at integer not null,
  unique(company_id, industry_profile_id, version),
  foreign key(company_id) references research_operating_companies(company_id) on delete restrict,
  foreign key(industry_profile_id) references research_industry_profiles(industry_profile_id) on delete restrict
);
create index idx_research_company_industry_exposures_company
  on research_company_industry_exposures(company_id, as_of desc, version desc);

create table research_peer_universes (
  peer_universe_id text primary key,
  company_id text not null,
  industry_profile_id text not null,
  as_of integer not null,
  version integer not null check (version > 0),
  status text not null check (status in ('draft', 'reviewed', 'superseded')),
  comparison_purpose text not null check (comparison_purpose in (
    'operating_model', 'financial_quality', 'valuation_context', 'competitive_context'
  )),
  selection_criteria text not null,
  cross_market_policy_json text not null default '{}',
  epistemic_type text not null check (epistemic_type in (
    'observed_fact', 'management_guidance', 'source_viewpoint',
    'third_party_forecast', 'analysis_assumption', 'system_judgment'
  )),
  source_refs_json text not null default '[]',
  created_at integer not null,
  updated_at integer not null,
  unique(company_id, industry_profile_id, comparison_purpose, version),
  foreign key(company_id) references research_operating_companies(company_id) on delete restrict,
  foreign key(industry_profile_id) references research_industry_profiles(industry_profile_id) on delete restrict
);
create index idx_research_peer_universes_company
  on research_peer_universes(company_id, as_of desc, version desc);

create table research_peer_universe_members (
  peer_member_id text primary key,
  peer_universe_id text not null,
  company_id text,
  security_code text,
  peer_name text not null,
  relationship_type text not null check (relationship_type in (
    'direct', 'adjacent', 'substitute', 'upstream', 'downstream', 'benchmark'
  )),
  membership_status text not null check (membership_status in ('included', 'excluded', 'watchlist')),
  comparability_status text not null check (comparability_status in (
    'comparable', 'partially_comparable', 'not_comparable', 'unreviewed'
  )),
  exclusion_reason text,
  comparison_dimensions_json text not null default '{}',
  cross_market_metadata_json text not null default '{}',
  source_refs_json text not null default '[]',
  sort_order integer not null default 0,
  check (
    (membership_status = 'excluded' and exclusion_reason is not null)
    or membership_status <> 'excluded'
  ),
  foreign key(peer_universe_id) references research_peer_universes(peer_universe_id) on delete cascade,
  foreign key(company_id) references research_operating_companies(company_id) on delete restrict,
  foreign key(security_code) references research_listed_securities(security_code) on delete restrict
);
create index idx_research_peer_universe_members_universe
  on research_peer_universe_members(peer_universe_id, membership_status, sort_order, peer_member_id);
