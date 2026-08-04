-- A statutory disclosure can seed only a review candidate after it has passed
-- through the existing immutable information-processing ledger.  This table
-- records that second, exact authority binding; it intentionally has no link
-- to operating models, driver plans, scenarios, market-space, or valuations.
create table research_statutory_operating_candidate_provenance (
  candidate_id text primary key,
  registry text not null check (registry in ('cninfo', 'hkex', 'sec')),
  security_code text not null,
  statutory_document_id text not null,
  statutory_document_url text not null,
  statutory_source_locator text not null,
  knowledge_doc_id text not null,
  result_id text not null,
  run_id text not null,
  version_id text not null,
  content_hash text not null,
  producer_version text not null,
  created_at integer not null,
  foreign key(candidate_id) references research_information_evidence_candidates(candidate_id) on delete restrict,
  foreign key(result_id) references knowledge_document_results(result_id) on delete restrict,
  foreign key(version_id) references knowledge_document_versions(version_id) on delete restrict,
  unique(registry, security_code, statutory_document_id, candidate_id)
);
create index idx_research_statutory_operating_candidate_provenance_security
  on research_statutory_operating_candidate_provenance(security_code, created_at desc);
