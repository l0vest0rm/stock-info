-- Preserve the newest local follow configuration while retiring the versioned key.
insert into app_kv (key, value_json, expires_at, updated_at)
select 'companies-follow-config', value_json, expires_at, updated_at
from app_kv
where key = 'companies-follow-config:v1'
on conflict(key) do update set
  value_json = excluded.value_json,
  expires_at = excluded.expires_at,
  updated_at = excluded.updated_at
where excluded.updated_at > app_kv.updated_at;

delete from app_kv where key = 'companies-follow-config:v1';
