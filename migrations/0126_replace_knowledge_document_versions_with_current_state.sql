-- Historical information-processing data is intentionally discarded.  Each
-- document now has exactly one current processing state; no old content
-- version, run, result, preprocessing decision, or extracted record remains.
delete from knowledge_information_records;
delete from knowledge_document_results;
delete from knowledge_processing_runs;
delete from knowledge_preprocessing_decisions;

drop table knowledge_document_results;
drop table knowledge_processing_runs;
drop table knowledge_preprocessing_decisions;
drop table knowledge_document_versions;

alter table knowledge_docs add column processing_content_hash text;
alter table knowledge_docs add column processing_updated_at integer;

create table knowledge_preprocessing_decisions (
  decision_id text primary key,
  version_id text not null,
  action text not null check (action in ('pass','exact_duplicate','template_duplicate','pure_market_snapshot','empty_content','fetch_error')),
  reason_code text not null,
  rule_version text not null,
  matched_source_type text,
  matched_template_id text,
  duplicate_of_version_id text,
  details_json text not null default '{}',
  decided_at integer not null
);
create index idx_knowledge_preprocessing_version on knowledge_preprocessing_decisions(version_id, decided_at desc);

create table knowledge_processing_runs (
  run_id text primary key,
  version_id text not null,
  stage text not null check (stage in ('document_analysis','long_document_chunk','long_document_merge','claim_reconcile','entity_view','targeted_review')),
  model text not null,
  returned_model text,
  prompt_version text not null,
  schema_version text not null,
  ontology_version text not null,
  input_hash text not null,
  raw_output_key text,
  status text not null check (status in ('queued','running','succeeded','failed','needs_review','skipped')),
  usage_json text not null default '{}',
  validation_json text not null default '{}',
  retry_count integer not null default 0,
  error text,
  started_at integer not null,
  completed_at integer
);
create index idx_knowledge_processing_runs_version on knowledge_processing_runs(version_id, started_at desc);
create index idx_knowledge_processing_runs_status on knowledge_processing_runs(status, started_at desc);

create table knowledge_document_results (
  result_id text primary key,
  run_id text not null unique,
  version_id text not null,
  outcome text not null check (outcome in ('extracted', 'no_information', 'needs_review')),
  created_at integer not null,
  foreign key(run_id) references knowledge_processing_runs(run_id) on delete restrict
);
create index idx_knowledge_document_results_version on knowledge_document_results(version_id, created_at desc);

-- Compatibility read model for callers that use the historical name. It has
-- one row per currently processed document and no independent storage.
create view knowledge_document_versions as
select
  d.doc_id as version_id,
  d.doc_id,
  d.url as source_url,
  c.content_sha256 as source_hash,
  d.processing_content_hash as content_hash,
  c.content_key as raw_content_key,
  c.content_key as normalized_content_key,
  '{}' as structure_json,
  d.published_at,
  d.fetched_at,
  '{}' as access_policy_json,
  d.processing_updated_at as created_at
from knowledge_docs d
left join knowledge_doc_content_refs c on c.doc_id=d.doc_id
where d.processing_content_hash is not null;
