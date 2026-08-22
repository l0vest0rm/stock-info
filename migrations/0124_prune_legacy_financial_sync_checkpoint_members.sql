-- 0123 retains only report-period checkpoint members. This also removes the
-- pre-report-period member names produced by older local versions.
update kv_cache
set value_json = json_remove(
      value_json,
      '$.checkpoints."financial-provisional-sync:performance_report"',
      '$.checkpoints."financial-provisional-sync:performance_forecast"'
    )
where namespace = 'sync_state'
  and key = 'financial-provisional';
