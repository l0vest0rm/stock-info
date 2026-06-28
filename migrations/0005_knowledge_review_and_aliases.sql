create table if not exists knowledge_stock_aliases (
  alias text primary key,
  code text not null,
  name text,
  source text,
  updated_at integer not null
);

create index if not exists idx_knowledge_stock_aliases_code
  on knowledge_stock_aliases(code);

create table if not exists knowledge_filtered_docs (
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

create index if not exists idx_knowledge_filtered_docs_status
  on knowledge_filtered_docs(reviewed_status, event_time desc);

create index if not exists idx_knowledge_filtered_docs_score
  on knowledge_filtered_docs(filter_score desc, event_time desc);
