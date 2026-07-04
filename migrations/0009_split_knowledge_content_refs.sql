pragma foreign_keys = off;

drop index if exists idx_knowledge_docs_source_type;
drop index if exists idx_knowledge_docs_source_name;
drop index if exists idx_knowledge_docs_target_code;
drop index if exists idx_knowledge_docs_rank;
drop index if exists idx_knowledge_doc_tags_tag;
drop index if exists idx_knowledge_filtered_docs_status;
drop index if exists idx_knowledge_filtered_docs_score;

alter table knowledge_docs rename to knowledge_docs_old;
alter table knowledge_doc_tags rename to knowledge_doc_tags_old;
alter table knowledge_filtered_docs rename to knowledge_filtered_docs_old;

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

insert into knowledge_docs (
  doc_id, source_type, report_type, source_name, title, url, published_at, fetched_at,
  event_time, target_name, target_code, discovery_method, access_method, summary,
  content_preview, metadata_json, recommendation_score, recommendation_level,
  recommendation_tags_json, recommendation_reasons_json, rank_score, source_weight, updated_at
)
select
  doc_id, source_type, report_type, source_name, title, url, published_at, fetched_at,
  event_time, target_name, target_code, discovery_method, access_method, summary,
  content_preview, metadata_json, recommendation_score, recommendation_level,
  recommendation_tags_json, recommendation_reasons_json, rank_score, source_weight, updated_at
from knowledge_docs_old;

create index idx_knowledge_docs_source_type
  on knowledge_docs(source_type, event_time desc);

create index idx_knowledge_docs_source_name
  on knowledge_docs(source_name, event_time desc);

create index idx_knowledge_docs_target_code
  on knowledge_docs(target_code, event_time desc);

create index idx_knowledge_docs_rank
  on knowledge_docs(rank_score desc, event_time desc);

create table knowledge_doc_content_refs (
  doc_id text primary key,
  content_key text,
  content_url text,
  content_type text not null default 'text/markdown; charset=utf-8',
  content_encoding text not null default 'identity',
  content_bytes integer not null default 0,
  content_sha256 text,
  updated_at integer not null,
  foreign key(doc_id) references knowledge_docs(doc_id) on delete cascade
);

create index idx_knowledge_doc_content_refs_content_key
  on knowledge_doc_content_refs(content_key);

insert into knowledge_doc_content_refs (
  doc_id, content_key, content_url, content_type, content_encoding, content_bytes, content_sha256, updated_at
)
select
  doc_id, content_key, content_url, content_type, content_encoding, content_bytes, content_sha256, updated_at
from knowledge_docs_old
where coalesce(content_key, '') != ''
  or coalesce(content_url, '') != ''
  or coalesce(content_sha256, '') != ''
  or coalesce(content_bytes, 0) != 0;

create table knowledge_doc_tags (
  doc_id text not null,
  tag text not null,
  primary key(doc_id, tag),
  foreign key(doc_id) references knowledge_docs(doc_id) on delete cascade
);

insert into knowledge_doc_tags (doc_id, tag)
select doc_id, tag
from knowledge_doc_tags_old;

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

insert into knowledge_filtered_docs (
  doc_id, source_type, report_type, source_name, title, url, published_at, fetched_at,
  event_time, target_name, target_code, summary, content_preview, metadata_json,
  filter_method, filter_score, filter_confidence, filter_reasons_json, source_file,
  reviewed_status, reviewed_at, updated_at
)
select
  doc_id, source_type, report_type, source_name, title, url, published_at, fetched_at,
  event_time, target_name, target_code, summary, content_preview, metadata_json,
  filter_method, filter_score, filter_confidence, filter_reasons_json, source_file,
  reviewed_status, reviewed_at, updated_at
from knowledge_filtered_docs_old;

create index idx_knowledge_filtered_docs_status
  on knowledge_filtered_docs(reviewed_status, event_time desc);

create index idx_knowledge_filtered_docs_score
  on knowledge_filtered_docs(filter_score desc, event_time desc);

create table knowledge_filtered_doc_content_refs (
  doc_id text primary key,
  content_key text,
  content_url text,
  content_type text not null default 'text/markdown; charset=utf-8',
  content_encoding text not null default 'identity',
  content_bytes integer not null default 0,
  content_sha256 text,
  updated_at integer not null,
  foreign key(doc_id) references knowledge_filtered_docs(doc_id) on delete cascade
);

create index idx_knowledge_filtered_doc_content_refs_content_key
  on knowledge_filtered_doc_content_refs(content_key);

insert into knowledge_filtered_doc_content_refs (
  doc_id, content_key, content_url, content_type, content_encoding, content_bytes, content_sha256, updated_at
)
select
  doc_id, content_key, content_url, content_type, content_encoding, content_bytes, content_sha256, updated_at
from knowledge_filtered_docs_old
where coalesce(content_key, '') != ''
  or coalesce(content_url, '') != ''
  or coalesce(content_sha256, '') != ''
  or coalesce(content_bytes, 0) != 0;

drop table knowledge_docs_old;
drop table knowledge_doc_tags_old;
drop table knowledge_filtered_docs_old;

pragma foreign_keys = on;
