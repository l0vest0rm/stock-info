-- 0132 intentionally does not invent display or calculation semantics while
-- rebuilding the catalog.  Existing 0130 rows nevertheless need a visible,
-- data-owned directory identity immediately after upgrade.  This migration
-- only fills previously empty display fields; verified source onboarding must
-- later replace the explicitly unconfigured measurement rules.

update macro_indicators
set
  region_name = case
    when region_name <> '' then region_name
    when region_code = 'CN' then '中国大陆'
    when region_code = 'US' then '美国'
    else region_code
  end,
  region_sort = case when region_sort <> 0 then region_sort else 1000 end,
  category_code = case
    when category_code <> '' then category_code
    when category_id = 1 then 'A'
    when category_id = 2 then 'B'
    when category_id = 3 then 'C'
    when category_id = 4 then 'D'
    when category_id = 5 then 'E'
    when category_id = 6 then 'F'
    when category_id = 7 then 'G'
    when category_id = 8 then 'H'
    else 'C' || category_id
  end,
  category_name = case
    when category_name <> '' then category_name
    when category_id = 1 then '经济增长与景气'
    when category_id = 2 then '就业与居民收入'
    when category_id = 3 then '通胀与价格'
    when category_id = 4 then '货币、利率与信贷'
    when category_id = 5 then '财政与政府债务'
    when category_id = 6 then '外部部门与汇率'
    when category_id = 7 then '房地产与居民资产负债'
    when category_id = 8 then '市场、风险与大宗商品'
    else '分类 ' || category_id
  end,
  category_sort = case when category_sort <> 0 then category_sort else category_id end,
  metric_code = case when metric_code <> '' then metric_code else 'M' || printf('%03d', metric_id) end,
  metric_name = case
    when metric_name <> '' then metric_name
    when region_code = 'CN' and name like '中国%' then substr(name, 3)
    when region_code = 'US' and name like '美国%' then substr(name, 3)
    else name
  end,
  metric_description = case when metric_description <> '' then metric_description else '目录迁移记录；请以已验证来源补充统计说明。' end,
  metric_sort = case when metric_sort <> 0 then metric_sort else metric_id end,
  statistical_definition = case when statistical_definition <> '' then statistical_definition else '迁移目录；待来源接入复核' end,
  unit_format = case when unit_format <> 'number' then unit_format when unit = '%' then 'percent' else 'number' end,
  measurement_kind = case when measurement_kind <> 'level' then measurement_kind else 'unknown' end,
  yoy_method = case when statistical_definition <> '' then yoy_method else 'not_configured' end,
  yoy_display_format = case when statistical_definition <> '' then yoy_display_format else 'number' end,
  mom_method = case when statistical_definition <> '' then mom_method else 'not_configured' end,
  mom_display_format = case when statistical_definition <> '' then mom_display_format else 'number' end;
