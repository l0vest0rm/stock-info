-- A statutory field comparison is evidence, not a formal actual.  This
-- append-only bridge makes the human confirmation explicit before a filing
-- value can enter the actual/calibration ledger or affect model review work.

create table research_formal_actual_candidates (
  candidate_id text primary key,
  security_code text not null,
  verification_id text not null unique,
  metric text not null,
  forecast_metric text,
  fiscal_year integer not null,
  fiscal_period text not null,
  period_start_date text not null,
  period_end_date text not null,
  reported_value real,
  reported_unit text,
  currency text,
  statutory_provider text not null,
  statutory_document_id text,
  statutory_disclosure_url text,
  statutory_locator text,
  statutory_published_at text,
  statutory_report_date text,
  source_binding_json text not null default '{}',
  candidate_rule_version text not null,
  eligibility text not null check (eligibility in ('ready_for_review', 'blocked')),
  blocking_reason text,
  created_at integer not null,
  foreign key(verification_id) references research_financial_statutory_verifications(verification_id) on delete restrict,
  foreign key(security_code) references research_listed_securities(security_code) on delete restrict
);
create index idx_research_formal_actual_candidates_security
  on research_formal_actual_candidates(security_code, eligibility, fiscal_year desc, created_at desc);

create table research_formal_actual_candidate_reviews (
  review_id text primary key,
  candidate_id text not null,
  decision text not null check (decision in ('accepted', 'rejected', 'needs_evidence')),
  reviewer text not null,
  reason text not null,
  accounting_basis text,
  ownership_basis text,
  share_basis text,
  actual_id text unique,
  reviewed_at integer not null,
  created_at integer not null,
  foreign key(candidate_id) references research_formal_actual_candidates(candidate_id) on delete restrict,
  foreign key(actual_id) references research_formal_actuals(actual_id) on delete restrict
);
create index idx_research_formal_actual_candidate_reviews_candidate
  on research_formal_actual_candidate_reviews(candidate_id, reviewed_at desc);

create table research_model_review_items (
  review_item_id text primary key,
  security_code text not null,
  trigger_kind text not null check (trigger_kind in ('formal_actual_accepted', 'actual_restatement', 'calibration_available', 'calibration_blocked')),
  trigger_id text not null,
  target_kind text not null check (target_kind in ('dcf', 'reverse_dcf', 'scenario')),
  target_version_id text not null,
  state text not null check (state in ('open', 'acknowledged', 'resolved', 'not_applicable')),
  reason text not null,
  evidence_json text not null default '{}',
  created_at integer not null,
  reviewed_at integer,
  resolution_note text,
  unique(trigger_kind, trigger_id, target_kind, target_version_id),
  foreign key(security_code) references research_listed_securities(security_code) on delete restrict
);
create index idx_research_model_review_items_security
  on research_model_review_items(security_code, state, created_at desc);
