-- Information-preprocessing records are source observations, not operating or
-- market facts.  This bridge preserves the full immutable source chain and
-- lets a researcher accept it only as a reusable reference / field to fill.
-- It deliberately has no foreign key into an operating, market or valuation
-- record, so review cannot mutate a model by side effect.

create table research_information_evidence_candidates (
  candidate_id text primary key,
  security_code text not null,
  information_id text not null,
  result_id text not null,
  run_id text not null,
  version_id text not null,
  content_hash text not null,
  doc_id text not null,
  entity text not null,
  information_type text not null,
  category text not null,
  period text,
  statement text not null,
  target_module text not null,
  target_field text not null,
  required_fields_json text not null default '[]',
  source_url text,
  content_url text,
  title text,
  source_name text,
  published_at text,
  mapping_config_version text not null,
  created_at integer not null,
  unique(security_code, information_id, target_module, target_field),
  foreign key(information_id) references knowledge_information_records(information_id) on delete restrict,
  foreign key(result_id) references knowledge_document_results(result_id) on delete restrict,
  foreign key(version_id) references knowledge_document_versions(version_id) on delete restrict,
  foreign key(doc_id) references knowledge_docs(doc_id) on delete restrict
);
create index idx_research_information_evidence_candidates_security
  on research_information_evidence_candidates(security_code, created_at desc);

create table research_information_evidence_candidate_reviews (
  candidate_review_id text primary key,
  candidate_id text not null,
  decision text not null check (decision in ('accepted', 'rejected', 'needs_evidence')),
  review_note text not null,
  reviewed_by text not null,
  reviewed_at integer not null,
  created_at integer not null,
  foreign key(candidate_id) references research_information_evidence_candidates(candidate_id) on delete restrict
);
create index idx_research_information_evidence_candidate_reviews_candidate
  on research_information_evidence_candidate_reviews(candidate_id, reviewed_at desc, candidate_review_id desc);

create table research_reusable_evidence_references (
  evidence_reference_id text primary key,
  candidate_id text not null,
  candidate_review_id text not null unique,
  security_code text not null,
  target_module text not null,
  target_field text not null,
  field_status text not null check (field_status in ('needs_field_entry')),
  information_id text not null,
  result_id text not null,
  run_id text not null,
  version_id text not null,
  content_hash text not null,
  doc_id text not null,
  source_url text,
  content_url text,
  title text,
  source_name text,
  published_at text,
  locator text not null,
  created_at integer not null,
  foreign key(candidate_id) references research_information_evidence_candidates(candidate_id) on delete restrict,
  foreign key(candidate_review_id) references research_information_evidence_candidate_reviews(candidate_review_id) on delete restrict
);
create index idx_research_reusable_evidence_references_security
  on research_reusable_evidence_references(security_code, target_module, target_field, created_at desc);
