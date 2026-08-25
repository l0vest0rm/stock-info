-- 0134 can have been synchronized before the ingestion filter existed.
-- Keep WEO projection periods out of the raw-observation ledger and align
-- already-migrated directory copy with the completed-year contract.

delete from macro_data
where indicator_id in (10001, 10002)
  and period_day >= 20250101;

update macro_indicators
set metric_description = 'IMF 世界经济展望的固定发布批次；仅接入发布时已经结束的年度，历史估计须按发布时点解读。'
where id in (10001, 10002);
