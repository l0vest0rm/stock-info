-- P3 field-typed operating-model and market-space research.  Every row is
-- individually addressable and evidence-bound through the normalized evidence
-- table below; no free-form JSON is used for user-entered research data.

create table research_operating_models_typed (
  operating_model_id text primary key,
  company_id text not null,
  as_of integer not null,
  version integer not null check (version > 0),
  status text not null check (status in ('draft', 'reviewed', 'superseded')),
  model_type text not null check (model_type in ('product', 'project', 'subscription', 'platform', 'resource', 'financial', 'mixed', 'other')),
  primary_earning_driver text not null,
  revenue_recognition text not null,
  summary text not null,
  epistemic_type text not null check (epistemic_type in ('observed_fact', 'management_guidance', 'source_viewpoint', 'third_party_forecast', 'analysis_assumption', 'system_judgment')),
  created_at integer not null,
  updated_at integer not null,
  unique(company_id, version),
  foreign key(company_id) references research_operating_companies(company_id) on delete restrict
);
create index idx_research_operating_models_typed_company on research_operating_models_typed(company_id, as_of desc, version desc);

create table research_operating_model_segments_typed (
  operating_segment_id text primary key,
  operating_model_id text not null,
  name text not null,
  product_scope text not null,
  customer_scope text not null,
  geographic_scope text not null,
  revenue_formula text not null,
  revenue_recognition text not null,
  sort_order integer not null default 0,
  foreign key(operating_model_id) references research_operating_models_typed(operating_model_id) on delete cascade
);

create table research_operating_model_contracts_typed (
  contract_driver_id text primary key,
  operating_segment_id text not null,
  contract_type text not null check (contract_type in ('subscription', 'usage', 'project', 'framework', 'spot', 'regulated_tariff', 'other')),
  customer_or_channel text not null,
  commitment_description text not null,
  pricing_basis text not null,
  renewal_or_delivery_constraint text not null,
  start_period text,
  end_period text,
  sort_order integer not null default 0,
  foreign key(operating_segment_id) references research_operating_model_segments_typed(operating_segment_id) on delete cascade
);

create table research_operating_model_unit_economics_typed (
  unit_economic_id text primary key,
  operating_segment_id text not null,
  unit_name text not null,
  price_per_unit numeric,
  variable_cost_per_unit numeric,
  currency text,
  amount_scale text,
  period_basis text not null,
  contribution_description text not null,
  sort_order integer not null default 0,
  check ((price_per_unit is null and variable_cost_per_unit is null and currency is null and amount_scale is null) or (price_per_unit is not null and variable_cost_per_unit is not null and currency is not null and amount_scale is not null)),
  foreign key(operating_segment_id) references research_operating_model_segments_typed(operating_segment_id) on delete cascade
);

create table research_operating_model_growth_constraints_typed (
  growth_constraint_id text primary key,
  operating_model_id text not null,
  operating_segment_id text,
  constraint_kind text not null check (constraint_kind in ('capacity', 'customer_concentration', 'certification', 'regulation', 'working_capital', 'technology', 'competition', 'supply_chain', 'capital', 'other')),
  description text not null,
  affected_statement text not null check (affected_statement in ('income', 'balance', 'cashflow', 'multiple')),
  affected_driver text not null,
  invalidation_or_release_condition text not null,
  sort_order integer not null default 0,
  foreign key(operating_model_id) references research_operating_models_typed(operating_model_id) on delete cascade,
  foreign key(operating_segment_id) references research_operating_model_segments_typed(operating_segment_id) on delete restrict
);

-- A driver plan turns segment units and price into revenue, then maps margins
-- and reinvestment assumptions into the three financial statements. It is a
-- versioned model input, not a source forecast or an investment conclusion.
create table research_operating_driver_plans (
  operating_driver_plan_id text primary key,
  operating_model_id text not null,
  scenario_name text not null check (scenario_name in ('downside', 'base', 'upside')),
  as_of integer not null,
  version integer not null check (version > 0),
  status text not null check (status in ('draft', 'reviewed', 'superseded')),
  valuation_currency text not null,
  amount_scale text not null,
  opening_revenue numeric not null check (opening_revenue > 0),
  opening_net_working_capital numeric not null,
  epistemic_type text not null check (epistemic_type in ('analysis_assumption', 'system_judgment')),
  created_at integer not null,
  updated_at integer not null,
  unique(operating_model_id, scenario_name, version),
  foreign key(operating_model_id) references research_operating_models_typed(operating_model_id) on delete restrict
);

create table research_operating_driver_plan_years (
  operating_driver_plan_year_id text primary key,
  operating_driver_plan_id text not null,
  fiscal_year integer not null,
  tax_rate numeric not null,
  forecast_net_debt numeric not null,
  sort_order integer not null default 0,
  unique(operating_driver_plan_id, fiscal_year),
  foreign key(operating_driver_plan_id) references research_operating_driver_plans(operating_driver_plan_id) on delete cascade
);

create table research_operating_driver_segment_years (
  operating_driver_segment_year_id text primary key,
  operating_driver_plan_year_id text not null,
  operating_segment_id text not null,
  volume numeric not null check (volume >= 0),
  price_per_unit numeric not null,
  gross_margin numeric not null,
  operating_expense_margin numeric not null,
  depreciation_amortization_margin numeric not null,
  capital_expenditure_margin numeric not null,
  net_working_capital_to_revenue numeric not null,
  sort_order integer not null default 0,
  unique(operating_driver_plan_year_id, operating_segment_id),
  foreign key(operating_driver_plan_year_id) references research_operating_driver_plan_years(operating_driver_plan_year_id) on delete cascade,
  foreign key(operating_segment_id) references research_operating_model_segments_typed(operating_segment_id) on delete restrict
);

create table research_market_space_assessments_typed (
  market_space_assessment_id text primary key,
  company_id text not null,
  operating_model_id text,
  as_of integer not null,
  version integer not null check (version > 0),
  status text not null check (status in ('draft', 'reviewed', 'superseded')),
  market_definition text not null,
  product_boundary text not null,
  geographic_boundary text not null,
  customer_boundary text not null,
  measurement_definition text not null,
  epistemic_type text not null check (epistemic_type in ('observed_fact', 'management_guidance', 'source_viewpoint', 'third_party_forecast', 'analysis_assumption', 'system_judgment')),
  created_at integer not null,
  updated_at integer not null,
  unique(company_id, market_definition, version),
  foreign key(company_id) references research_operating_companies(company_id) on delete restrict,
  foreign key(operating_model_id) references research_operating_models_typed(operating_model_id) on delete restrict
);
create index idx_research_market_space_assessments_typed_company on research_market_space_assessments_typed(company_id, as_of desc, version desc);

create table research_market_space_estimates_typed (
  market_space_estimate_id text primary key,
  market_space_assessment_id text not null,
  layer text not null check (layer in ('tam', 'sam', 'som')),
  method text not null check (method in ('top_down', 'bottom_up')),
  method_basis text not null check (method_basis in ('terminal_demand', 'unit_value', 'customer_budget', 'supplier_sum', 'supply_capacity', 'company_capacity', 'customer_purchase', 'other')),
  amount numeric not null check (amount >= 0),
  currency text not null,
  amount_scale text not null,
  period_label text not null,
  period_kind text not null check (period_kind in ('annual_flow', 'cumulative_stock', 'point_in_time', 'other')),
  calculation_description text not null,
  status text not null check (status in ('available', 'incomplete', 'incomparable')),
  sort_order integer not null default 0,
  foreign key(market_space_assessment_id) references research_market_space_assessments_typed(market_space_assessment_id) on delete cascade
);

create table research_market_share_bridges_typed (
  market_share_bridge_id text primary key,
  market_space_assessment_id text not null,
  share_type text not null check (share_type in ('revenue', 'shipment', 'customer_wallet', 'new_market', 'profit_pool', 'capacity')),
  period_label text not null,
  starting_share numeric not null,
  ending_share numeric not null,
  unit text not null check (unit in ('ratio', 'percent')),
  status text not null check (status in ('draft', 'reviewed', 'superseded')),
  created_at integer not null,
  updated_at integer not null,
  foreign key(market_space_assessment_id) references research_market_space_assessments_typed(market_space_assessment_id) on delete cascade
);

create table research_market_share_bridge_steps_typed (
  market_share_bridge_step_id text primary key,
  market_share_bridge_id text not null,
  step_kind text not null check (step_kind in ('new_customer', 'customer_expansion', 'new_product', 'customer_loss', 'product_retirement', 'capacity_constraint', 'competition', 'other')),
  direction text not null check (direction in ('gain', 'loss')),
  share_delta numeric not null check (share_delta >= 0),
  description text not null,
  sort_order integer not null default 0,
  foreign key(market_share_bridge_id) references research_market_share_bridges_typed(market_share_bridge_id) on delete cascade
);

create table research_market_profit_pools_typed (
  market_profit_pool_id text primary key,
  market_space_assessment_id text not null,
  period_label text not null,
  industry_revenue numeric not null check (industry_revenue >= 0),
  sustainable_operating_margin numeric not null,
  currency text not null,
  amount_scale text not null,
  normalization_note text not null,
  status text not null check (status in ('draft', 'reviewed', 'superseded')),
  created_at integer not null,
  updated_at integer not null,
  foreign key(market_space_assessment_id) references research_market_space_assessments_typed(market_space_assessment_id) on delete cascade
);

create table research_operating_market_evidence_refs (
  evidence_ref_id text primary key,
  subject_type text not null check (subject_type in ('operating_model', 'operating_segment', 'contract_driver', 'unit_economic', 'growth_constraint', 'driver_plan', 'driver_plan_year', 'driver_segment_year', 'market_space_assessment', 'market_space_estimate', 'share_bridge', 'share_bridge_step', 'profit_pool')),
  subject_id text not null,
  source_kind text not null check (source_kind in ('knowledge_record', 'knowledge_document', 'filing', 'market_data', 'external_url', 'dossier_record', 'research_record')),
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
create index idx_research_operating_market_evidence_subject on research_operating_market_evidence_refs(subject_type, subject_id, created_at);
