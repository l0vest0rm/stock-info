create table if not exists kv_cache (
  namespace text not null,
  key text not null,
  value_json text not null,
  expires_at integer,
  updated_at integer not null,
  primary key (namespace, key)
);

create index if not exists idx_kv_cache_namespace_expires_at
  on kv_cache(namespace, expires_at);
