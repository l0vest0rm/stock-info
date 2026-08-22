-- Keep only the newest structured result for each current document. Runtime
-- attempts and maintenance executions are transient; their latest cursor or
-- status belongs in a fixed kv_cache JSON, not an append-only run ledger.
create temp table _current_knowledge_results as
select current.result_id, current.version_id, current.outcome, current.created_at
  from knowledge_document_results current
 where not exists (
   select 1 from knowledge_document_results newer
    where newer.version_id = current.version_id
      and (newer.created_at > current.created_at or (newer.created_at = current.created_at and newer.result_id > current.result_id))
 );

create temp table _current_knowledge_information_records as
select record.information_id, record.result_id, record.entity, record.information_type,
       record.category, record.period, record.statement, record.forecast_measurement_json,
       record.sort_order, record.created_at
  from knowledge_information_records record
  join _current_knowledge_results result on result.result_id = record.result_id;

drop table knowledge_information_records;
drop table knowledge_document_results;
drop table knowledge_processing_runs;
drop table knowledge_ingest_runs;

create table knowledge_document_results (
  result_id text primary key,
  version_id text not null unique,
  outcome text not null check (outcome in ('extracted', 'no_information', 'needs_review')),
  created_at integer not null
);

create table knowledge_information_records (
  information_id text primary key,
  result_id text not null,
  entity text not null,
  information_type text not null check (information_type in ('fact', 'guidance', 'forecast', 'opinion', 'event', 'relationship')),
  category text not null,
  period text,
  statement text not null,
  forecast_measurement_json text not null default '{}',
  sort_order integer not null,
  created_at integer not null,
  unique(result_id, sort_order),
  foreign key(result_id) references knowledge_document_results(result_id) on delete restrict
);

insert into knowledge_document_results (result_id, version_id, outcome, created_at)
select result_id, version_id, outcome, created_at from _current_knowledge_results;

insert into knowledge_information_records (
  information_id, result_id, entity, information_type, category, period, statement,
  forecast_measurement_json, sort_order, created_at
)
select information_id, result_id, entity, information_type, category, period, statement,
       forecast_measurement_json, sort_order, created_at
  from _current_knowledge_information_records;

create index idx_knowledge_document_results_version on knowledge_document_results(version_id, created_at desc);
create index idx_knowledge_information_records_result on knowledge_information_records(result_id, sort_order);
create index idx_knowledge_information_records_category_type on knowledge_information_records(category, information_type);
create index idx_knowledge_information_records_entity_category on knowledge_information_records(entity, category);
