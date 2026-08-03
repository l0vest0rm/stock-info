-- Replace the assertion/claim graph with the per-document information-record model.
-- Imported documents and their content references/caches are intentionally preserved.

delete from information_processing_jobs;
delete from knowledge_view_item_claims;
delete from knowledge_view_items;
delete from knowledge_entity_views;
delete from knowledge_claim_state_history;
delete from knowledge_claim_assertions;
delete from knowledge_claims;
delete from knowledge_assertion_evidence;
delete from knowledge_assertions;
delete from knowledge_evidence_spans;
delete from knowledge_document_results;
delete from knowledge_processing_runs;
delete from knowledge_preprocessing_decisions;
delete from knowledge_entity_aliases;
delete from knowledge_entities;
delete from knowledge_document_versions;

drop table knowledge_view_item_claims;
drop table knowledge_view_items;
drop table knowledge_entity_views;
drop table knowledge_claim_state_history;
drop table knowledge_claim_assertions;
drop table knowledge_claims;
drop table knowledge_assertion_evidence;
drop table knowledge_assertions;
drop table knowledge_evidence_spans;
drop table knowledge_entity_aliases;
drop table knowledge_entities;
drop table knowledge_document_results;

create table knowledge_document_results (
  result_id text primary key,
  run_id text not null unique,
  version_id text not null,
  outcome text not null check (outcome in ('extracted', 'no_information', 'needs_review')),
  created_at integer not null,
  foreign key(run_id) references knowledge_processing_runs(run_id) on delete restrict,
  foreign key(version_id) references knowledge_document_versions(version_id) on delete restrict
);
create index idx_knowledge_document_results_version on knowledge_document_results(version_id, created_at desc);

create table knowledge_information_records (
  information_id text primary key,
  result_id text not null,
  subject text not null,
  information_type text not null check (information_type in ('fact', 'guidance', 'forecast', 'opinion', 'event', 'relationship')),
  category text not null,
  period text,
  statement text not null,
  sort_order integer not null,
  created_at integer not null,
  unique(result_id, sort_order),
  foreign key(result_id) references knowledge_document_results(result_id) on delete restrict
);
create index idx_knowledge_information_records_result on knowledge_information_records(result_id, sort_order);
create index idx_knowledge_information_records_subject_category on knowledge_information_records(subject, category);
create index idx_knowledge_information_records_category_type on knowledge_information_records(category, information_type);

-- Only pre-v15 information-extraction requests are discarded; unrelated LLM cache
-- entries remain available to their own workflows.
delete from llm_cache_entries
 where request_json like '%单篇来源断言提取器%'
    or request_json like '%information-processing-v14%';
