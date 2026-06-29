create table if not exists llm_cache_entries (
  cache_key text primary key,
  provider text not null,
  model text not null,
  request_json text not null,
  response_json text not null,
  expires_at integer not null
);

create index if not exists idx_llm_cache_entries_expires_at on llm_cache_entries(expires_at);
