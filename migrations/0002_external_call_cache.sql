create table if not exists http_cache (
  cache_key text primary key,
  url text not null,
  method text not null,
  status integer not null,
  headers_json text,
  body_text text not null,
  expires_at integer not null,
  updated_at integer not null
);

create index if not exists idx_http_cache_expires_at on http_cache(expires_at);
