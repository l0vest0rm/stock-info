-- Durable research-dossier modules.  These tables deliberately keep source facts,
-- third-party views, analyst assumptions and private user decisions separate.
-- A missing record means unavailable; it must never be rendered as a neutral value.

create table research_dossiers (
  dossier_id text primary key,
  company_id text,
  security_code text not null unique,
  created_at integer not null,
  updated_at integer not null,
  foreign key(company_id) references research_operating_companies(company_id) on delete restrict
);

create table research_business_models (
  business_model_id text primary key,
  company_id text not null,
  as_of integer not null,
  status text not null check (status in ('draft', 'reviewed', 'superseded')),
  primary_earning_driver text,
  revenue_recognition text,
  summary text not null,
  source_type text not null check (source_type in ('fact', 'management_guidance', 'third_party_view', 'analyst_assumption', 'system_assessment')),
  source_refs_json text not null default '[]',
  created_at integer not null,
  updated_at integer not null,
  foreign key(company_id) references research_operating_companies(company_id) on delete restrict
);
create index idx_research_business_models_company on research_business_models(company_id, as_of desc);

create table research_business_segments (
  segment_id text primary key,
  business_model_id text not null,
  name text not null,
  revenue_driver text,
  customer_scope text,
  geographic_scope text,
  pricing_model text,
  cost_driver text,
  working_capital_driver text,
  capital_intensity_driver text,
  source_refs_json text not null default '[]',
  sort_order integer not null default 0,
  foreign key(business_model_id) references research_business_models(business_model_id) on delete cascade
);

create table research_market_space_models (
  market_space_id text primary key,
  company_id text not null,
  as_of integer not null,
  status text not null check (status in ('draft', 'reviewed', 'superseded')),
  market_definition text not null,
  tam_json text not null default '{}',
  sam_json text not null default '{}',
  som_json text not null default '{}',
  profit_pool_json text not null default '{}',
  top_down_json text not null default '{}',
  bottom_up_json text not null default '{}',
  transmission_json text not null default '{}',
  source_type text not null check (source_type in ('fact', 'management_guidance', 'third_party_view', 'analyst_assumption', 'system_assessment')),
  source_refs_json text not null default '[]',
  created_at integer not null,
  updated_at integer not null,
  foreign key(company_id) references research_operating_companies(company_id) on delete restrict
);
create index idx_research_market_space_company on research_market_space_models(company_id, as_of desc);

create table research_competitive_markets (
  competitive_market_id text primary key,
  company_id text not null,
  as_of integer not null,
  status text not null check (status in ('draft', 'reviewed', 'superseded')),
  definition text not null,
  product_scope text,
  customer_scope text,
  geography_scope text,
  period_scope text,
  structure_json text not null default '{}',
  advantage_json text not null default '[]',
  erosion_paths_json text not null default '[]',
  source_type text not null check (source_type in ('fact', 'management_guidance', 'third_party_view', 'analyst_assumption', 'system_assessment')),
  source_refs_json text not null default '[]',
  created_at integer not null,
  updated_at integer not null,
  foreign key(company_id) references research_operating_companies(company_id) on delete restrict
);
create index idx_research_competitive_markets_company on research_competitive_markets(company_id, as_of desc);

create table research_competitors (
  competitor_id text primary key,
  competitive_market_id text not null,
  name text not null,
  security_code text,
  competitor_type text not null check (competitor_type in ('direct', 'adjacent', 'substitute', 'new_entrant', 'customer_inhouse', 'supplier_forward')),
  comparability_note text not null,
  metrics_json text not null default '{}',
  source_refs_json text not null default '[]',
  foreign key(competitive_market_id) references research_competitive_markets(competitive_market_id) on delete cascade
);

create table research_theses (
  thesis_id text primary key,
  company_id text not null,
  as_of integer not null,
  title text not null,
  statement text not null,
  status text not null check (status in ('active', 'under_review', 'invalidated', 'superseded')),
  assessment_type text not null check (assessment_type in ('system_assessment', 'user_decision')),
  invalidation_condition text not null,
  review_by integer,
  created_at integer not null,
  updated_at integer not null,
  foreign key(company_id) references research_operating_companies(company_id) on delete restrict
);
create index idx_research_theses_company on research_theses(company_id, as_of desc, status);

create table research_thesis_evidence (
  thesis_evidence_id text primary key,
  thesis_id text not null,
  stance text not null check (stance in ('support', 'contradict', 'conflict', 'context')),
  knowledge_information_id text,
  source_url text,
  source_title text,
  evidence_type text not null check (evidence_type in ('fact', 'management_guidance', 'third_party_forecast', 'source_viewpoint', 'analyst_assumption', 'system_assessment')),
  statement text not null,
  applicable_period text,
  observed_at integer,
  source_refs_json text not null default '[]',
  created_at integer not null,
  foreign key(thesis_id) references research_theses(thesis_id) on delete cascade,
  foreign key(knowledge_information_id) references knowledge_information_records(information_id) on delete restrict
);
create index idx_research_thesis_evidence_thesis on research_thesis_evidence(thesis_id, stance, observed_at desc);

create table research_valuation_cases (
  valuation_case_id text primary key,
  security_code text not null,
  company_id text,
  as_of integer not null,
  status text not null check (status in ('draft', 'reviewed', 'superseded')),
  valuation_type text not null check (valuation_type in ('dcf', 'relative', 'asset', 'dividend', 'sum_of_parts', 'reverse', 'other')),
  method_rationale text not null,
  assumptions_json text not null default '[]',
  outputs_json text not null default '{}',
  sensitivity_json text not null default '[]',
  source_refs_json text not null default '[]',
  created_at integer not null,
  updated_at integer not null,
  foreign key(company_id) references research_operating_companies(company_id) on delete restrict
);
create index idx_research_valuation_security on research_valuation_cases(security_code, as_of desc);

create table research_risk_entries (
  risk_id text primary key,
  company_id text,
  security_code text,
  as_of integer not null,
  category text not null,
  scope text not null check (scope in ('operating_company', 'listed_security', 'user_portfolio')),
  title text not null,
  exposure text not null,
  transmission text not null,
  loss_range text,
  likelihood text,
  impact text,
  speed text,
  reversibility text,
  gross_risk text,
  verified_mitigation text,
  residual_risk text,
  trigger_condition text not null,
  review_frequency text,
  status text not null check (status in ('new', 'active', 'upgraded', 'downgraded', 'resolved', 'unavailable')),
  source_refs_json text not null default '[]',
  created_at integer not null,
  updated_at integer not null,
  foreign key(company_id) references research_operating_companies(company_id) on delete restrict
);
create index idx_research_risks_security on research_risk_entries(security_code, as_of desc, status);
create index idx_research_risks_company on research_risk_entries(company_id, as_of desc, status);

create table research_catalysts (
  catalyst_id text primary key,
  company_id text,
  security_code text,
  event_at integer,
  event_type text not null,
  title text not null,
  status text not null check (status in ('occurred', 'guided', 'external_expectation', 'tentative', 'cancelled')),
  impacted_assumption text not null,
  expected_effect text,
  outcome_note text,
  source_refs_json text not null default '[]',
  created_at integer not null,
  updated_at integer not null,
  foreign key(company_id) references research_operating_companies(company_id) on delete restrict
);
create index idx_research_catalysts_security on research_catalysts(security_code, event_at);

create table research_analysis_snapshots (
  analysis_snapshot_id text primary key,
  company_id text,
  security_code text not null,
  as_of integer not null,
  completion_level text not null check (completion_level in ('basic', 'standard', 'deep')),
  state text not null,
  summary_json text not null,
  module_status_json text not null,
  created_at integer not null,
  foreign key(company_id) references research_operating_companies(company_id) on delete restrict
);
create index idx_research_analysis_snapshots_security on research_analysis_snapshots(security_code, as_of desc);

create table research_user_notes (
  note_id text primary key,
  owner_key text not null,
  company_id text,
  security_code text not null,
  note_type text not null check (note_type in ('watch_reason', 'personal_view', 'question', 'decision_reference')),
  content text not null,
  references_json text not null default '[]',
  created_at integer not null,
  updated_at integer not null,
  foreign key(company_id) references research_operating_companies(company_id) on delete restrict
);
create index idx_research_user_notes_owner on research_user_notes(owner_key, security_code, updated_at desc);
