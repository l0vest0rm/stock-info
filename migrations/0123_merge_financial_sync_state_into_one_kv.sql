-- Keep the complete financial-provisional sync state and all source/report-period
-- cursors in one fixed kv_cache JSON record. Existing per-source keys are
-- normalized to reportDate:source members of checkpoints.
insert into kv_cache (namespace, key, value_json, expires_at, updated_at)
select
  'sync_state',
  'financial-provisional',
  json_object(
    'status', 'idle',
    'startedAt', null,
    'finishedAt', null,
    'error', null,
    'stats', null,
    'checkpoints', json_group_object(
      case
        when key like 'financial-provisional-sync:performance_report:%'
          then substr(key, length('financial-provisional-sync:performance_report:') + 1) || ':performance_report'
        when key like 'financial-provisional-sync:performance_forecast:%'
          then substr(key, length('financial-provisional-sync:performance_forecast:') + 1) || ':performance_forecast'
      end,
      json(case when json_valid(value_json) then value_json else '{}' end)
    )
  ),
  null,
  max(updated_at)
from kv_cache
where namespace = 'financial_provisional_sync'
  and (
    key like 'financial-provisional-sync:performance_report:%'
    or key like 'financial-provisional-sync:performance_forecast:%'
  )
having count(*) > 0
on conflict(namespace, key) do update set
  value_json = json_set(
    kv_cache.value_json,
    '$.checkpoints',
    json_extract(excluded.value_json, '$.checkpoints')
  ),
  expires_at = null,
  updated_at = excluded.updated_at;

delete from kv_cache where namespace = 'financial_provisional_sync';
