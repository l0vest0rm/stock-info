-- Public disclosures and information-preprocessing records are evidence, not
-- a writable operating model.  This ledger records the human-normalized,
-- reusable operating facts that may later be cited by a model or driver plan.
-- It deliberately has no foreign key to typed models, plans, scenarios, or
-- valuations: creating a source fact must never alter an analysis input.

create table research_operating_source_facts (
  operating_source_fact_id text primary key,
  operating_company_id text not null,
  source_security_code text not null,
  evidence_reference_id text not null,
  candidate_id text not null,
  candidate_review_id text not null,
  fact_kind text not null check (fact_kind in (
    'segment_volume', 'unit_price', 'capacity_utilization', 'order_backlog',
    'contract_commitment', 'customer_relationship', 'capacity_constraint',
    'growth_constraint', 'product_offering', 'segment_scope',
    'revenue_recognition', 'unit_economics'
  )),
  subject_label text not null,
  segment_label text,
  customer_or_channel text,
  period_label text not null,
  period_kind text not null check (period_kind in ('historical', 'current', 'future_guidance', 'event', 'other')),
  reported_value text not null,
  numeric_value numeric,
  unit text,
  currency text,
  amount_scale text,
  scope_description text not null,
  comparability_note text not null,
  statement text not null,
  information_type text not null check (information_type in ('fact', 'guidance', 'forecast', 'opinion', 'event', 'relationship')),
  mapping_config_version text not null,
  recorded_by text not null,
  recorded_at integer not null,
  created_at integer not null,
  foreign key(operating_company_id) references research_operating_companies(company_id) on delete restrict,
  foreign key(evidence_reference_id) references research_reusable_evidence_references(evidence_reference_id) on delete restrict,
  foreign key(candidate_id) references research_information_evidence_candidates(candidate_id) on delete restrict,
  foreign key(candidate_review_id) references research_information_evidence_candidate_reviews(candidate_review_id) on delete restrict,
  unique(evidence_reference_id, fact_kind, subject_label, period_label, reported_value)
);
create index idx_research_operating_source_facts_company
  on research_operating_source_facts(operating_company_id, recorded_at desc, operating_source_fact_id desc);
create index idx_research_operating_source_facts_security
  on research_operating_source_facts(source_security_code, recorded_at desc, operating_source_fact_id desc);
