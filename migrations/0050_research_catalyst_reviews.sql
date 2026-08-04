-- A catalyst is an expectation or event record.  Its subsequent outcome must
-- be appended separately so historical research never rewrites the original
-- expectation with information that only became available later.
create table research_catalyst_reviews (
  catalyst_review_id text primary key,
  catalyst_id text not null,
  company_id text,
  security_code text not null,
  as_of integer not null,
  review_status text not null check (review_status in ('observed', 'partially_confirmed', 'confirmed', 'missed', 'not_comparable')),
  outcome_summary text not null,
  expected_vs_actual text not null,
  impacted_assumption_status text not null check (impacted_assumption_status in ('confirmed', 'weakened', 'invalidated', 'not_tested')),
  next_action text not null,
  source_refs_json text not null,
  reviewed_at integer not null,
  created_at integer not null,
  foreign key(catalyst_id) references research_catalysts(catalyst_id) on delete restrict,
  foreign key(company_id) references research_operating_companies(company_id) on delete restrict
);
create unique index idx_research_catalyst_reviews_version
  on research_catalyst_reviews(catalyst_id, as_of, catalyst_review_id);
create index idx_research_catalyst_reviews_subject
  on research_catalyst_reviews(security_code, as_of desc, reviewed_at desc);
