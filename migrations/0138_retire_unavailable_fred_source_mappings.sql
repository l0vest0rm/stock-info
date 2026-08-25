-- Live FRED API verification found these legacy code candidates no longer
-- exist in the authenticated observations API.  A failed code is not an
-- alternate source contract, so make the concepts visible-but-unmapped until
-- a reviewed replacement is registered.

update macro_indicators
set
  source_id = null,
  source_series_id = null,
  source_url = null,
  publisher = null,
  publication_timestamp_strategy = null,
  source_batch_key = null,
  statistical_definition = '未映射目录占位：原 FRED 代码已在实时 API 核验中不可用；须登记可复核的统计定义、频率、单位和发布时间契约，不能以近似指标替代。',
  frequency = 'annual',
  unit = '未配置',
  unit_format = 'number',
  seasonal_adjustment = 'not_applicable',
  measurement_kind = 'unknown',
  yoy_method = 'not_configured',
  yoy_base_periods = 0,
  yoy_display_format = 'number',
  mom_method = 'not_configured',
  mom_base_periods = 0,
  mom_display_format = 'number',
  stale_after_seconds = 0,
  refresh_interval_seconds = 0,
  revision_lookback_periods = 0,
  next_fetch_at = null,
  fetch_lease_until = null,
  last_error = 'source mapping withdrawn: FRED observations API returned series does not exist'
where region_code = 'US'
  and definition_id = 0
  and metric_id in (7, 9, 59)
  and source_id = 'fred';
