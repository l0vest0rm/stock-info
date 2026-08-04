-- Registry document pointers are immutable source evidence, not normalized
-- financial facts.  Extraction/verification adds separate observations later.
create table research_statutory_disclosure_documents (
  registry text not null check (registry in ('cninfo', 'hkex', 'sec')),
  security_code text not null,
  document_id text not null,
  title text not null,
  published_at text not null,
  document_url text not null,
  document_type text,
  source_locator text not null,
  indexed_at integer not null,
  primary key (registry, security_code, document_id)
);
create index idx_research_statutory_disclosure_documents_lookup
  on research_statutory_disclosure_documents(security_code, published_at desc, indexed_at desc);
