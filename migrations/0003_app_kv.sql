create table if not exists app_kv (
  key text primary key,
  value_json text not null,
  expires_at integer,
  updated_at integer not null
);

create index if not exists idx_app_kv_expires_at on app_kv(expires_at);
