create table if not exists knowledge_local_content_cache (
  content_key text primary key,
  content_type text not null,
  content_encoding text not null,
  content_sha256 text not null,
  content_bytes integer not null default 0,
  payload_base64 text not null,
  updated_at integer not null
);

create index if not exists idx_knowledge_local_content_cache_updated_at
  on knowledge_local_content_cache(updated_at desc);
