-- Field-typed P2 industry research records.  0037 remains readable for the
-- first-generation page; this schema is the write contract for subsequent
-- field-based workflows.  It intentionally has no free-form JSON payload
-- columns: every analytical field and every evidence link is addressable.

create table research_industry_track_profiles (
  track_profile_id text primary key,
  industry_key text not null,
  taxonomy text not null,
  taxonomy_version text not null,
  industry_name text not null,
  parent_industry_key text,
  as_of integer not null,
  version integer not null check (version > 0),
  status text not null check (status in ('draft', 'reviewed', 'superseded')),
  boundary_included text not null,
  boundary_excluded text not null,
  demand_equation text,
  supply_equation text,
  cycle_position text not null check (cycle_position in ('not_assessed', 'trough', 'recovery', 'expansion', 'peak', 'contraction', 'structurally_non_cyclical')),
  valuation_primary_method text,
  valuation_limitations text,
  epistemic_type text not null check (epistemic_type in ('observed_fact', 'management_guidance', 'source_viewpoint', 'third_party_forecast', 'analysis_assumption', 'system_judgment')),
  created_at integer not null,
  updated_at integer not null,
  unique(industry_key, taxonomy, taxonomy_version, version)
);
create index idx_research_industry_track_profiles_lookup
  on research_industry_track_profiles(industry_key, taxonomy, taxonomy_version, as_of desc, version desc);

create table research_industry_track_demand_drivers (
  driver_id text primary key,
  track_profile_id text not null,
  driver_kind text not null check (driver_kind in ('volume', 'price', 'penetration', 'utilization', 'asset_growth', 'customer_capex', 'policy', 'other')),
  label text not null,
  definition text not null,
  indicator_name text,
  indicator_frequency text,
  leading_lagging text not null check (leading_lagging in ('leading', 'coincident', 'lagging', 'not_assessed')),
  financial_transmission text not null,
  sort_order integer not null default 0,
  foreign key(track_profile_id) references research_industry_track_profiles(track_profile_id) on delete cascade
);

create table research_industry_track_supply_constraints (
  constraint_id text primary key,
  track_profile_id text not null,
  constraint_kind text not null check (constraint_kind in ('capacity', 'resource', 'technology', 'regulation', 'yield', 'capital', 'labor', 'other')),
  label text not null,
  description text not null,
  affected_variable text not null,
  direction_when_binding text not null check (direction_when_binding in ('raises_price', 'limits_volume', 'raises_cost', 'delays_delivery', 'mixed', 'not_assessed')),
  sort_order integer not null default 0,
  foreign key(track_profile_id) references research_industry_track_profiles(track_profile_id) on delete cascade
);

create table research_industry_track_value_chain_nodes (
  value_chain_node_id text primary key,
  track_profile_id text not null,
  node_role text not null check (node_role in ('input_supplier', 'component_supplier', 'producer', 'channel', 'customer', 'payer', 'regulator', 'other')),
  name text not null,
  description text not null,
  revenue_recognition_role text not null,
  sort_order integer not null default 0,
  foreign key(track_profile_id) references research_industry_track_profiles(track_profile_id) on delete cascade
);

create table research_industry_track_kpis (
  kpi_id text primary key,
  track_profile_id text not null,
  name text not null,
  definition text not null,
  unit text not null,
  frequency text not null,
  timing_role text not null check (timing_role in ('leading', 'coincident', 'lagging', 'not_assessed')),
  financial_mapping text not null,
  sort_order integer not null default 0,
  foreign key(track_profile_id) references research_industry_track_profiles(track_profile_id) on delete cascade
);

create table research_company_track_exposures (
  company_track_exposure_id text primary key,
  company_id text not null,
  track_profile_id text not null,
  as_of integer not null,
  version integer not null check (version > 0),
  status text not null check (status in ('draft', 'reviewed', 'superseded')),
  selection_basis text not null check (selection_basis in ('primary_business', 'secondary_business')),
  business_segment text not null,
  product_scope text not null,
  geographic_scope text not null,
  customer_scope text not null,
  exposure_description text not null,
  epistemic_type text not null check (epistemic_type in ('observed_fact', 'management_guidance', 'source_viewpoint', 'third_party_forecast', 'analysis_assumption', 'system_judgment')),
  created_at integer not null,
  updated_at integer not null,
  unique(company_id, track_profile_id, version),
  foreign key(company_id) references research_operating_companies(company_id) on delete restrict,
  foreign key(track_profile_id) references research_industry_track_profiles(track_profile_id) on delete restrict
);
create index idx_research_company_track_exposures_company
  on research_company_track_exposures(company_id, as_of desc, version desc);

create table research_company_track_exposure_shares (
  exposure_share_id text primary key,
  company_track_exposure_id text not null,
  measure text not null check (measure in ('revenue', 'gross_profit', 'operating_profit', 'assets', 'volume', 'other')),
  value numeric not null check (value >= 0),
  unit text not null check (unit in ('ratio', 'percent', 'currency', 'units')),
  basis_period text not null,
  denominator_description text,
  sort_order integer not null default 0,
  foreign key(company_track_exposure_id) references research_company_track_exposures(company_track_exposure_id) on delete cascade
);

create table research_peer_comparison_sets (
  peer_comparison_set_id text primary key,
  company_id text not null,
  track_profile_id text not null,
  as_of integer not null,
  version integer not null check (version > 0),
  status text not null check (status in ('draft', 'reviewed', 'superseded')),
  comparison_purpose text not null check (comparison_purpose in ('operating_model', 'financial_quality', 'valuation_context', 'competitive_context')),
  selection_criteria text not null,
  epistemic_type text not null check (epistemic_type in ('observed_fact', 'management_guidance', 'source_viewpoint', 'third_party_forecast', 'analysis_assumption', 'system_judgment')),
  created_at integer not null,
  updated_at integer not null,
  unique(company_id, track_profile_id, comparison_purpose, version),
  foreign key(company_id) references research_operating_companies(company_id) on delete restrict,
  foreign key(track_profile_id) references research_industry_track_profiles(track_profile_id) on delete restrict
);
create index idx_research_peer_comparison_sets_company
  on research_peer_comparison_sets(company_id, as_of desc, version desc);

create table research_peer_comparison_members (
  peer_comparison_member_id text primary key,
  peer_comparison_set_id text not null,
  company_id text,
  security_code text,
  peer_name text not null,
  relationship_type text not null check (relationship_type in ('direct', 'adjacent', 'substitute', 'upstream', 'downstream', 'benchmark')),
  membership_status text not null check (membership_status in ('included', 'excluded', 'watchlist')),
  comparability_status text not null check (comparability_status in ('comparable', 'partially_comparable', 'not_comparable', 'unreviewed')),
  exclusion_reason text,
  sort_order integer not null default 0,
  check ((membership_status = 'excluded' and exclusion_reason is not null) or membership_status <> 'excluded'),
  foreign key(peer_comparison_set_id) references research_peer_comparison_sets(peer_comparison_set_id) on delete cascade,
  foreign key(company_id) references research_operating_companies(company_id) on delete restrict,
  foreign key(security_code) references research_listed_securities(security_code) on delete restrict
);
create index idx_research_peer_comparison_members_set
  on research_peer_comparison_members(peer_comparison_set_id, membership_status, sort_order, peer_comparison_member_id);

create table research_peer_comparison_dimensions (
  comparison_dimension_id text primary key,
  peer_comparison_member_id text not null,
  dimension text not null check (dimension in ('business_model', 'product_scope', 'customer_scope', 'geography', 'reporting_currency', 'accounting_basis', 'fiscal_year', 'capital_intensity', 'cycle_position', 'security_rights')),
  status text not null check (status in ('aligned', 'adjustment_required', 'not_comparable', 'not_assessed')),
  target_value text,
  peer_value text,
  adjustment_note text,
  sort_order integer not null default 0,
  unique(peer_comparison_member_id, dimension),
  foreign key(peer_comparison_member_id) references research_peer_comparison_members(peer_comparison_member_id) on delete cascade
);

-- Evidence is normalized rather than encoded as a JSON payload.  subject_id is
-- deliberately polymorphic so one source may bind an overall profile or a
-- specific field; the application validates its declared subject type.
create table research_industry_comparability_evidence_refs (
  evidence_ref_id text primary key,
  subject_type text not null check (subject_type in ('track_profile', 'demand_driver', 'supply_constraint', 'value_chain_node', 'industry_kpi', 'company_exposure', 'exposure_share', 'peer_comparison_set', 'peer_member', 'comparison_dimension')),
  subject_id text not null,
  source_kind text not null check (source_kind in ('knowledge_record', 'knowledge_document', 'filing', 'market_data', 'external_url', 'dossier_record')),
  source_id text,
  information_id text,
  version_id text,
  document_id text,
  url text,
  title text,
  published_at text,
  locator text,
  created_at integer not null,
  check (source_id is not null or information_id is not null or version_id is not null or document_id is not null or url is not null)
);
create index idx_research_industry_comparability_evidence_subject
  on research_industry_comparability_evidence_refs(subject_type, subject_id, created_at);
