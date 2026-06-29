drop table if exists knowledge_doc_tags;
drop table if exists knowledge_docs;
drop table if exists knowledge_filtered_docs;

create table knowledge_docs (
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
  content_key text,
  content_url text,
  content_type text not null default 'text/markdown; charset=utf-8',
  content_encoding text not null default 'identity',
  content_bytes integer not null default 0,
  content_sha256 text,
  content_preview text,
  metadata_json text not null default '{}',
  recommendation_score integer not null default 0,
  recommendation_level text,
  recommendation_tags_json text not null default '[]',
  recommendation_reasons_json text not null default '[]',
  rank_score integer not null default 0,
  source_weight integer not null default 0,
  updated_at integer not null
);

create index idx_knowledge_docs_source_type
  on knowledge_docs(source_type, event_time desc);

create index idx_knowledge_docs_source_name
  on knowledge_docs(source_name, event_time desc);

create index idx_knowledge_docs_target_code
  on knowledge_docs(target_code, event_time desc);

create index idx_knowledge_docs_rank
  on knowledge_docs(rank_score desc, event_time desc);

create table knowledge_doc_tags (
  doc_id text not null,
  tag text not null,
  primary key(doc_id, tag),
  foreign key(doc_id) references knowledge_docs(doc_id) on delete cascade
);

create index idx_knowledge_doc_tags_tag
  on knowledge_doc_tags(tag, doc_id);

create table knowledge_filtered_docs (
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
  summary text,
  content_key text,
  content_url text,
  content_type text not null default 'text/markdown; charset=utf-8',
  content_encoding text not null default 'identity',
  content_bytes integer not null default 0,
  content_sha256 text,
  content_preview text,
  metadata_json text not null default '{}',
  filter_method text,
  filter_score integer not null default 0,
  filter_confidence real,
  filter_reasons_json text not null default '[]',
  source_file text,
  reviewed_status text not null default 'pending',
  reviewed_at integer,
  updated_at integer not null
);

create index idx_knowledge_filtered_docs_status
  on knowledge_filtered_docs(reviewed_status, event_time desc);

create index idx_knowledge_filtered_docs_score
  on knowledge_filtered_docs(filter_score desc, event_time desc);
