create table if not exists knowledge_docs (
  doc_id text primary key,
  source_type text not null,
  report_type text,
  source_name text,
  title text not null,
  url text,
  published_at text,
  fetched_at text,
  event_time text,
  target_name text,
  target_code text,
  discovery_method text,
  access_method text,
  summary text,
  md_text text,
  search_text text,
  metadata_json text not null default '{}',
  recommendation_score integer not null default 0,
  recommendation_level text,
  recommendation_tags_json text not null default '[]',
  recommendation_reasons_json text not null default '[]',
  rank_score integer not null default 0,
  source_weight integer not null default 0,
  updated_at integer not null
);

create index if not exists idx_knowledge_docs_source_type
  on knowledge_docs(source_type, event_time desc);

create index if not exists idx_knowledge_docs_source_name
  on knowledge_docs(source_name, event_time desc);

create index if not exists idx_knowledge_docs_target_code
  on knowledge_docs(target_code, event_time desc);

create index if not exists idx_knowledge_docs_rank
  on knowledge_docs(rank_score desc, event_time desc);

create table if not exists knowledge_doc_tags (
  doc_id text not null,
  tag text not null,
  primary key(doc_id, tag),
  foreign key(doc_id) references knowledge_docs(doc_id) on delete cascade
);

create index if not exists idx_knowledge_doc_tags_tag
  on knowledge_doc_tags(tag, doc_id);

create table if not exists knowledge_ingest_runs (
  run_id text primary key,
  status text not null,
  source text,
  started_at integer not null,
  finished_at integer,
  stats_json text,
  error text
);

create index if not exists idx_knowledge_ingest_runs_started
  on knowledge_ingest_runs(started_at desc);
