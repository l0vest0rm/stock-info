-- A reviewed operating source fact may be proposed as an input to one precise
-- field of a typed operating model.  This is deliberately a separate ledger:
-- no trigger or foreign-key action can write a model, driver plan, scenario,
-- financial statement, or valuation from a binding.

create table research_operating_source_fact_bindings (
  operating_source_fact_binding_id text primary key,
  operating_company_id text not null,
  operating_source_fact_id text not null,
  operating_model_id text not null,
  target_kind text not null check (target_kind in ('segment_variable', 'contract_parameter', 'growth_constraint')),
  target_id text not null,
  target_field text not null,
  formula text not null,
  applicable_period text not null,
  applicability_description text not null,
  uncovered_scope text not null,
  created_by text not null,
  created_at integer not null,
  foreign key(operating_company_id) references research_operating_companies(company_id) on delete restrict,
  foreign key(operating_source_fact_id) references research_operating_source_facts(operating_source_fact_id) on delete restrict,
  foreign key(operating_model_id) references research_operating_models_typed(operating_model_id) on delete restrict
);
create index idx_research_operating_source_fact_bindings_company
  on research_operating_source_fact_bindings(operating_company_id, created_at desc, operating_source_fact_binding_id desc);
create index idx_research_operating_source_fact_bindings_fact
  on research_operating_source_fact_bindings(operating_source_fact_id, created_at desc);

-- Reviews are append-only. The latest review is the current status, so a
-- rejected or superseded modelling interpretation remains auditable instead
-- of silently changing an earlier source-to-field claim.
create table research_operating_source_fact_binding_reviews (
  operating_source_fact_binding_review_id text primary key,
  operating_source_fact_binding_id text not null,
  review_status text not null check (review_status in ('reviewed', 'needs_revision', 'rejected')),
  review_note text not null,
  reviewed_by text not null,
  reviewed_at integer not null,
  foreign key(operating_source_fact_binding_id) references research_operating_source_fact_bindings(operating_source_fact_binding_id) on delete restrict
);
create index idx_research_operating_source_fact_binding_reviews_binding
  on research_operating_source_fact_binding_reviews(operating_source_fact_binding_id, reviewed_at desc, operating_source_fact_binding_review_id desc);
