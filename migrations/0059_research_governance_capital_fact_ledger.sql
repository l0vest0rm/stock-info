-- Governance/capital facts are a source-bound, append-only company ledger.
-- Information-preprocessing can only create candidates. A local human review
-- supplies the structured value, while all source-chain fields are copied
-- server-side from that immutable candidate; neither review nor fact writes
-- can mutate an operating model, valuation version, or generic dossier row.
create table research_governance_capital_fact_candidates (
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
  fact_key text not null,
  required_fields_json text not null default '[]',
  source_url text,
  content_url text,
  title text,
  source_name text,
  published_at text,
  mapping_config_version text not null,
  created_at integer not null,
  unique(security_code, information_id, fact_key),
  foreign key(information_id) references knowledge_information_records(information_id) on delete restrict,
  foreign key(result_id) references knowledge_document_results(result_id) on delete restrict,
  foreign key(version_id) references knowledge_document_versions(version_id) on delete restrict,
  foreign key(doc_id) references knowledge_docs(doc_id) on delete restrict
);
create index idx_research_governance_capital_candidates_security
  on research_governance_capital_fact_candidates(security_code, created_at desc);

create table research_governance_capital_fact_candidate_reviews (
  candidate_review_id text primary key,
  candidate_id text not null,
  decision text not null check (decision in ('accepted', 'rejected', 'needs_evidence')),
  review_note text not null,
  reviewed_by text not null,
  reviewed_at integer not null,
  created_at integer not null,
  foreign key(candidate_id) references research_governance_capital_fact_candidates(candidate_id) on delete restrict
);
create index idx_research_governance_capital_candidate_reviews_candidate
  on research_governance_capital_fact_candidate_reviews(candidate_id, reviewed_at desc, candidate_review_id desc);

create table research_governance_capital_fact_versions (
  governance_capital_fact_version_id text primary key,
  candidate_review_id text not null unique,
  supersedes_fact_version_id text,
  company_id text not null,
  security_code text not null,
  fact_key text not null,
  fact_status text not null check (fact_status in ('verified', 'unavailable', 'conflicting')),
  value_kind text not null check (value_kind in ('number', 'text')),
  value_number real,
  value_text text,
  unit text,
  as_of text not null,
  period text,
  source_authority text not null check (source_authority in ('issuer_disclosure', 'exchange_filing', 'regulator_or_court', 'audit_report')),
  information_id text not null,
  result_id text not null,
  run_id text not null,
  version_id text not null,
  content_hash text not null,
  doc_id text not null,
  source_url text,
  content_url text,
  source_title text,
  source_name text,
  published_at text,
  source_locator text not null,
  created_at integer not null,
  check ((fact_status = 'verified' and ((value_kind = 'number' and value_number is not null and unit is not null) or (value_kind = 'text' and value_text is not null))) or fact_status <> 'verified'),
  check ((value_kind = 'number' and value_text is null) or (value_kind = 'text' and value_number is null)),
  foreign key(candidate_review_id) references research_governance_capital_fact_candidate_reviews(candidate_review_id) on delete restrict,
  foreign key(supersedes_fact_version_id) references research_governance_capital_fact_versions(governance_capital_fact_version_id) on delete restrict,
  foreign key(company_id) references research_operating_companies(company_id) on delete restrict,
  foreign key(security_code) references research_listed_securities(security_code) on delete restrict
);
create index idx_research_governance_capital_facts_company_current
  on research_governance_capital_fact_versions(company_id, fact_key, as_of desc, created_at desc);
create index idx_research_governance_capital_facts_security
  on research_governance_capital_fact_versions(security_code, created_at desc);
