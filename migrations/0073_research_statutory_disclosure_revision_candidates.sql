-- Official correction/amendment documents are candidates, never automatic
-- financial restatements or a substitute for the structured primary source.
create table research_statutory_disclosure_revision_candidates (
  candidate_id text primary key,
  registry text not null check (registry in ('cninfo', 'hkex')),
  security_code text not null,
  document_id text not null,
  title text not null,
  published_at text not null,
  document_url text not null,
  source_locator text not null,
  report_period text,
  candidate_signals_json text not null,
  rule_version text not null,
  discovered_at integer not null,
  unique (registry, security_code, document_id, rule_version)
);
create index idx_research_statutory_revision_candidates_security_period
  on research_statutory_disclosure_revision_candidates(security_code, report_period, discovered_at desc);

-- Reviews append a disposition; a candidate itself is immutable and an
-- explicit original document is required before calling it a restatement.
create table research_statutory_disclosure_revision_reviews (
  review_id text primary key,
  candidate_id text not null,
  decision text not null check (decision in ('confirmed_financial_restatement', 'not_financial_correction', 'needs_evidence')),
  original_document_id text,
  affected_scope text,
  reviewer text not null,
  reason text not null,
  reviewed_at integer not null,
  created_at integer not null,
  foreign key(candidate_id) references research_statutory_disclosure_revision_candidates(candidate_id) on delete restrict
);
create index idx_research_statutory_revision_reviews_candidate
  on research_statutory_disclosure_revision_reviews(candidate_id, reviewed_at desc);
