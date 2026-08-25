-- DBnomics does not expose per-observation release timestamps. These two
-- immutable IMF WEO 2025-04 release datasets are therefore registered with
-- the official WEO release date (2025-04-22), not DBnomics fetch/index time.
-- WEO forecast periods are filtered at ingestion; estimates remain labelled.

insert into macro_indicators (
  id, metric_id, category_id, region_code, definition_id,
  region_name, region_sort, category_code, category_name, category_sort,
  metric_code, metric_name, metric_description, metric_sort, statistical_definition,
  name, frequency, unit, unit_format, seasonal_adjustment, measurement_kind,
  yoy_method, yoy_base_periods, yoy_display_format, mom_method, mom_base_periods, mom_display_format,
  default_trend_periods, enabled,
  source_id, source_series_id, source_url, publisher, publication_timestamp_strategy, source_batch_key,
  lead_lag, transform_method, stale_after_seconds, refresh_interval_seconds, revision_lookback_periods,
  next_fetch_at
) values
  (
    10001, 10001, 1, 'CN', 1,
    '中国大陆', 10, 'A', '经济增长与景气', 1,
    'IMF_WEO_REAL_GDP_GROWTH', '实际 GDP 年增长（IMF WEO）', 'IMF 世界经济展望的固定发布批次；仅接入发布时已经结束的年度，历史估计须按发布时点解读。', 10001, 'IMF WEO 2025年4月版；不等同于国家统计局季度实际GDP口径。',
    '中国实际 GDP 年增长（IMF WEO 2025年4月）', 'annual', '%', 'percent', 'not_applicable', 'rate',
    'not_applicable', 0, 'percent', 'not_applicable', 0, 'percent',
    15, 1,
    'dbnomics', 'IMF/WEO:2025-04/CHN.NGDP_RPCH.pcent_change', 'https://api.db.nomics.world/v22/series/IMF/WEO:2025-04/CHN.NGDP_RPCH.pcent_change?observations=1', 'IMF World Economic Outlook via DBnomics', 'dbnomics_dataset_release', 'imf-weo-2025-04:1745323200',
    'coincident', 'none', 31_536_000, 2_592_000, 0,
    0
  ),
  (
    10002, 10001, 1, 'US', 1,
    '美国', 20, 'A', '经济增长与景气', 1,
    'IMF_WEO_REAL_GDP_GROWTH', '实际 GDP 年增长（IMF WEO）', 'IMF 世界经济展望的固定发布批次；仅接入发布时已经结束的年度，历史估计须按发布时点解读。', 10001, 'IMF WEO 2025年4月版；不等同于 BEA 季度实际GDP口径。',
    '美国实际 GDP 年增长（IMF WEO 2025年4月）', 'annual', '%', 'percent', 'not_applicable', 'rate',
    'not_applicable', 0, 'percent', 'not_applicable', 0, 'percent',
    15, 1,
    'dbnomics', 'IMF/WEO:2025-04/USA.NGDP_RPCH.pcent_change', 'https://api.db.nomics.world/v22/series/IMF/WEO:2025-04/USA.NGDP_RPCH.pcent_change?observations=1', 'IMF World Economic Outlook via DBnomics', 'dbnomics_dataset_release', 'imf-weo-2025-04:1745323200',
    'coincident', 'none', 31_536_000, 2_592_000, 0,
    0
  );
