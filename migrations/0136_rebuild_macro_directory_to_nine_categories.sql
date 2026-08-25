-- Rebuild the persisted macro directory around the documented nine-category,
-- sixty-concept taxonomy.  This is a catalog migration only: macro_data stays
-- append-only and every existing fact continues to reference its original
-- concrete indicator id.
--
-- Legacy rows that stored a derived display measure, combined two concepts, or
-- used a different denominator remain in the catalog for audit/history but
-- are unscheduled and disabled.  They receive a retired identity rather than
-- being repurposed as a new raw series.

create temp table macro_directory_0136 (
  metric_id integer primary key,
  category_id integer not null,
  category_code text not null,
  category_name text not null,
  category_sort integer not null,
  metric_code text not null,
  metric_name text not null,
  metric_description text not null,
  metric_sort integer not null
);

insert into macro_directory_0136 values
  (1, 1, 'A', '增长、需求与领先调查', 1, 'A01', '实际 GDP', '总产出；本国季度口径与年度 WEO 口径是不同统计定义。', 1),
  (2, 1, 'A', '增长、需求与领先调查', 1, 'A02', '名义 GDP', '名义收入、税基和债务承受能力的基础。', 2),
  (3, 1, 'A', '增长、需求与领先调查', 1, 'A03', '工业产出', '制造、采矿和公用事业实体活动。', 3),
  (4, 1, 'A', '增长、需求与领先调查', 1, 'A04', '实际居民消费支出', '经价格调整后的居民需求。', 4),
  (5, 1, 'A', '增长、需求与领先调查', 1, 'A05', '零售销售', '高频终端商品消费，不替代实际消费支出。', 5),
  (6, 1, 'A', '增长、需求与领先调查', 1, 'A06', '固定资本形成', '企业、政府和住宅资本形成；不以固定资产投资替代。', 6),
  (7, 1, 'A', '增长、需求与领先调查', 1, 'A07', '制造业景气调查', '制造业扩张或收缩扩散指数。', 7),
  (8, 1, 'A', '增长、需求与领先调查', 1, 'A08', '服务业景气调查', '服务业扩张或收缩扩散指数。', 8),
  (9, 1, 'A', '增长、需求与领先调查', 1, 'A09', '新订单', '调查中的前瞻需求分项。', 9),
  (10, 1, 'A', '增长、需求与领先调查', 1, 'A10', '库存销售比', '主动补库、被动累库和去库存阶段。', 10),
  (11, 1, 'A', '增长、需求与领先调查', 1, 'A11', '产能利用率', '产能约束、投资意愿和价格压力。', 11),
  (12, 1, 'A', '增长、需求与领先调查', 1, 'A12', '消费者信心', '居民就业、收入和耐用品需求的领先调查。', 12),
  (13, 2, 'B', '就业与居民收入', 2, 'B01', '失业率', '劳动力市场松紧的总览。', 1),
  (14, 2, 'B', '就业与居民收入', 2, 'B02', '就业人数', '就业水平或可明确定义的当期就业变动。', 2),
  (15, 2, 'B', '就业与居民收入', 2, 'B03', '劳动参与率', '劳动力供给是否退出或回流。', 3),
  (16, 2, 'B', '就业与居民收入', 2, 'B04', '职位空缺数', '职位空缺水平；不能把数误称为率。', 4),
  (17, 2, 'B', '就业与居民收入', 2, 'B05', '名义工资/劳动报酬', '劳动成本和名义居民收入。', 5),
  (18, 2, 'B', '就业与居民收入', 2, 'B06', '实际可支配收入', '扣除价格后的居民购买力。', 6),
  (19, 3, 'C', '通胀与成本', 3, 'C01', '总 CPI', '居民消费价格总指数；同比和环比年化是展示测度。', 1),
  (20, 3, 'C', '通胀与成本', 3, 'C02', '核心 CPI', '剔除预先声明的高波动项目后的价格指数。', 2),
  (21, 3, 'C', '通胀与成本', 3, 'C03', '核心服务价格', '服务端、工资和内需相关的黏性价格。', 3),
  (22, 3, 'C', '通胀与成本', 3, 'C04', '住房/租金价格', 'CPI 中住房或租金分项，不与房价指数混同。', 4),
  (23, 3, 'C', '通胀与成本', 3, 'C05', '终端需求 PPI', '必须声明生产阶段，不使用含义不明的 PPI。', 5),
  (24, 3, 'C', '通胀与成本', 3, 'C06', '进口价格', '外部成本传导和汇率冲击。', 6),
  (25, 3, 'C', '通胀与成本', 3, 'C07', '市场隐含通胀补偿', '债券市场定价的通胀补偿。', 7),
  (26, 3, 'C', '通胀与成本', 3, 'C08', '居民/企业通胀预期', '调查型预期，不能与市场隐含补偿合并。', 8),
  (27, 4, 'D', '利率、货币与信贷', 4, 'D01', '政策利率', '货币当局直接设定或目标利率。', 1),
  (28, 4, 'D', '利率、货币与信贷', 4, 'D02', '2 年期国债收益率', '短中端政策路径定价。', 2),
  (29, 4, 'D', '利率、货币与信贷', 4, 'D03', '10 年期国债收益率', '长端无风险利率和期限溢价。', 3),
  (30, 4, 'D', '利率、货币与信贷', 4, 'D04', '广义货币存量', '流动性存量；增速由展示层计算。', 4),
  (31, 4, 'D', '利率、货币与信贷', 4, 'D05', '私人部门信贷存量', '居民和企业信贷余额；增速由展示层计算。', 5),
  (32, 4, 'D', '利率、货币与信贷', 4, 'D06', '银行贷款标准', '银行信贷供给和风险偏好的调查指标。', 6),
  (33, 5, 'E', '财政与主权债务', 5, 'E01', '财政总体余额/GDP', '一般政府净借贷/净放贷。', 1),
  (34, 5, 'E', '财政与主权债务', 5, 'E02', '基础财政余额/GDP', '剔除利息支出后的财政余额。', 2),
  (35, 5, 'E', '财政与主权债务', 5, 'E03', '政府总债务/GDP', '必须标注政府覆盖范围和债务口径。', 3),
  (36, 5, 'E', '财政与主权债务', 5, 'E04', '利息支出/财政收入', '利率变化对财政可持续性的压力。', 4),
  (37, 5, 'E', '财政与主权债务', 5, 'E05', '国债净发行', '影响债券供给、期限溢价和流动性。', 5),
  (38, 5, 'E', '财政与主权债务', 5, 'E06', '结构性财政余额/潜在 GDP', '财政立场的可比较原始代理；财政脉冲为展示测度。', 6),
  (39, 6, 'F', '外部部门与汇率', 6, 'F01', '经常账户/GDP', '对外经常收支的综合结果。', 1),
  (40, 6, 'F', '外部部门与汇率', 6, 'F02', '实际出口量', '商品和服务出口量，不用名义金额替代。', 2),
  (41, 6, 'F', '外部部门与汇率', 6, 'F03', '实际进口量', '商品和服务进口量，不用名义金额替代。', 3),
  (42, 6, 'F', '外部部门与汇率', 6, 'F04', '官方外汇储备', '对固定或管理汇率经济体尤其重要。', 4),
  (43, 6, 'F', '外部部门与汇率', 6, 'F05', '短期外债', '存量风险；短债/外储覆盖率为展示测度。', 5),
  (44, 6, 'F', '外部部门与汇率', 6, 'F06', '实际有效汇率', '贸易竞争力口径，优先于未说明的名义有效汇率。', 6),
  (45, 6, 'F', '外部部门与汇率', 6, 'F07', 'FDI 净流入', '长期跨境资本流。', 7),
  (46, 6, 'F', '外部部门与汇率', 6, 'F08', '证券投资净流入', '对利率、汇率和风险偏好敏感的跨境资本流。', 8),
  (47, 7, 'G', '房地产与居民资产负债表', 7, 'G01', '房价指数', '住宅资产价格指数；同比为展示测度。', 1),
  (48, 7, 'G', '房地产与居民资产负债表', 7, 'G02', '住宅成交/销售', '成交量或销售量，必须声明统计范围。', 2),
  (49, 7, 'G', '房地产与居民资产负债表', 7, 'G03', '住宅投资', '住宅建设及相关资本形成。', 3),
  (50, 7, 'G', '房地产与居民资产负债表', 7, 'G04', '新发放按揭利率', '居民边际购房融资成本。', 4),
  (51, 7, 'G', '房地产与居民资产负债表', 7, 'G05', '居民债务/可支配收入', '居民杠杆；不用 GDP 分母替代可支配收入。', 5),
  (52, 8, 'H', '金融市场与风险', 8, 'H01', '宽基股票价格指数', '原始价格指数；收益率为展示测度。', 1),
  (53, 8, 'H', '金融市场与风险', 8, 'H02', '隐含波动率', '市场定价的不确定性与尾部风险。', 2),
  (54, 8, 'H', '金融市场与风险', 8, 'H03', '金融条件指数', '利率、信用、股价和汇率的可复核综合指标。', 3),
  (55, 9, 'I', '全球商品与供给冲击', 9, 'I01', '布伦特原油价格', '全球原油基准。', 1),
  (56, 9, 'I', '全球商品与供给冲击', 9, 'I02', '区域天然气价格', '必须标注区域基准。', 2),
  (57, 9, 'I', '全球商品与供给冲击', 9, 'I03', '工业金属价格指数', '制造、基建和全球需求敏感指标。', 3),
  (58, 9, 'I', '全球商品与供给冲击', 9, 'I04', '农产品价格指数', '食品通胀、天气和供给扰动。', 4),
  (59, 9, 'I', '全球商品与供给冲击', 9, 'I05', '黄金价格', '避险、美元和实际利率敏感资产。', 5),
  (60, 9, 'I', '全球商品与供给冲击', 9, 'I06', '全球航运运价', '全球贸易和物流瓶颈。', 6);

-- These are the only legacy rows whose existing raw observation identity is
-- sufficiently specific to retain as an enabled definition-0 series.  All
-- other legacy rows are kept as retired audit records below.
create temp table macro_legacy_remap_0136 (
  legacy_metric_id integer primary key,
  metric_id integer not null
);

insert into macro_legacy_remap_0136 values
  (1, 1), (2, 2), (10, 11), (11, 13), (12, 14), (13, 15),
  (18, 20), (20, 23), (24, 25), (25, 27), (27, 28), (28, 29),
  (33, 32), (34, 33), (35, 34), (36, 35), (37, 36), (40, 39),
  (43, 42), (48, 48), (49, 49), (50, 50), (52, 12), (54, 53),
  (55, 54), (57, 56), (58, 57), (59, 58);

-- Move the old numeric identities out of the unique key first.  The exact
-- id/metric relationship identifies the original two-region bootstrap rows
-- and avoids touching later catalog entries.
update macro_indicators
set metric_id = 1000000 + metric_id
where metric_id between 1 and 60
  and definition_id = 0
  and id = metric_id * 10 + case region_code when 'CN' then 1 when 'US' then 2 else -1 end;

-- 0134 created WEO GDP as a spurious abstract metric.  It is A01 at a
-- different definition, so reserve its target identity before the remap.
update macro_indicators
set metric_id = 1000001
where id in (10001, 10002)
  and metric_id = 10001
  and definition_id = 1;

-- Restore valid legacy rows to their new metric identities.
update macro_indicators
set metric_id = (
  select remap.metric_id
  from macro_legacy_remap_0136 remap
  where remap.legacy_metric_id = macro_indicators.metric_id - 1000000
)
where metric_id between 1000001 and 1000060
  and exists (
    select 1 from macro_legacy_remap_0136 remap
    where remap.legacy_metric_id = macro_indicators.metric_id - 1000000
  );

update macro_indicators
set metric_id = 1
where id in (10001, 10002)
  and metric_id = 1000001
  and definition_id = 1;

-- Retire, rather than reinterpret, every remaining bootstrap row.  Their
-- facts retain the original indicator id and remain queryable for audit.
update macro_indicators
set
  category_id = 99,
  category_code = 'R',
  category_name = '已退休遗留目录',
  category_sort = 99,
  metric_code = 'RETIRED_M' || printf('%02d', metric_id - 1000000),
  metric_name = '已退休：' || name,
  metric_description = '旧目录记录；其身份是派生展示测度、含混合统计对象或错误分母，不能重解释为九类60项中的原始指标。既有 macro_data 原始事实保留不变。',
  metric_sort = metric_id - 1000000,
  statistical_definition = '已退休遗留统计定义；保留用于历史审计，不参与当前原始指标目录。',
  unit_format = 'number',
  measurement_kind = 'retired_legacy',
  yoy_method = 'not_applicable',
  yoy_base_periods = 0,
  yoy_display_format = 'number',
  mom_method = 'not_applicable',
  mom_base_periods = 0,
  mom_display_format = 'number',
  enabled = 0,
  refresh_interval_seconds = 0,
  next_fetch_at = null,
  fetch_lease_until = null,
  last_error = coalesce(last_error || '\n', '') || 'retired by macro directory migration 0136'
where metric_id between 1000001 and 1000060;

-- Apply one shared directory declaration to every active concrete definition,
-- including the retained native series and the WEO annual definition.
update macro_indicators
set
  category_id = (select category_id from macro_directory_0136 d where d.metric_id = macro_indicators.metric_id),
  category_code = (select category_code from macro_directory_0136 d where d.metric_id = macro_indicators.metric_id),
  category_name = (select category_name from macro_directory_0136 d where d.metric_id = macro_indicators.metric_id),
  category_sort = (select category_sort from macro_directory_0136 d where d.metric_id = macro_indicators.metric_id),
  metric_code = (select metric_code from macro_directory_0136 d where d.metric_id = macro_indicators.metric_id),
  metric_name = (select metric_name from macro_directory_0136 d where d.metric_id = macro_indicators.metric_id),
  metric_description = (select metric_description from macro_directory_0136 d where d.metric_id = macro_indicators.metric_id),
  metric_sort = (select metric_sort from macro_directory_0136 d where d.metric_id = macro_indicators.metric_id),
  statistical_definition = case
    when id in (10001, 10002) then statistical_definition
    else '保留的既有具体序列；统计口径、频率、单位和展示规则由该目录行声明，并在来源接入时复核。'
  end,
  unit_format = case
    when instr(unit, '%') > 0 then 'percent'
    when unit = 'index' then 'decimal_2'
    else 'number'
  end,
  measurement_kind = case
    when instr(unit, '%') > 0 then 'rate'
    when unit = 'index' then 'index'
    else 'level'
  end,
  yoy_method = case when instr(unit, '%') > 0 then 'native' else 'percent_change' end,
  yoy_base_periods = case when instr(unit, '%') > 0 then 0 else case frequency when 'annual' then 1 when 'quarterly' then 4 when 'monthly' then 12 else 0 end end,
  yoy_display_format = 'percent',
  mom_method = case when instr(unit, '%') > 0 then 'not_applicable' else 'percent_change' end,
  mom_base_periods = case when instr(unit, '%') > 0 then 0 else 1 end,
  mom_display_format = 'percent'
where enabled = 1
  and metric_id between 1 and 60;

-- A metric must remain visible even before a verified regional source is
-- registered.  Fill only the missing CN/US definition-0 identities; active
-- retained rows win by the unique key and keep their original indicator ids.
insert into macro_indicators (
  id, metric_id, category_id, region_code, definition_id,
  region_name, region_sort, category_code, category_name, category_sort,
  metric_code, metric_name, metric_description, metric_sort, statistical_definition,
  name, frequency, unit, unit_format, seasonal_adjustment, measurement_kind,
  yoy_method, yoy_base_periods, yoy_display_format, mom_method, mom_base_periods, mom_display_format,
  default_trend_periods, enabled,
  stale_after_seconds, refresh_interval_seconds, revision_lookback_periods, next_fetch_at
)
select
  20000 + d.metric_id * 10 + r.id_suffix,
  d.metric_id, d.category_id, r.region_code, 0,
  r.region_name, r.region_sort, d.category_code, d.category_name, d.category_sort,
  d.metric_code, d.metric_name, d.metric_description, d.metric_sort,
  '未映射目录占位：须在验证统计机构、统计定义、频率、单位、修订和发布时间后替换；不得将镜像或派生值写入 macro_data。',
  r.region_name || d.metric_name || '（待验证来源）', 'annual', '未配置', 'number', 'not_applicable', 'unknown',
  'not_configured', 0, 'number', 'not_configured', 0, 'number',
  12, 1,
  0, 0, 0, null
from macro_directory_0136 d
cross join (
  select 'CN' as region_code, '中国大陆' as region_name, 10 as region_sort, 1 as id_suffix
  union all select 'US', '美国', 20, 2
) r
where true
on conflict(metric_id, region_code, definition_id) do nothing;

-- `definition_id=1` is the immutable IMF WEO 2025-04 annual definition of
-- A01, while definition 0 remains the domestic high-frequency identity.
update macro_indicators
set
  metric_id = 1,
  category_id = 1,
  category_code = 'A',
  category_name = '增长、需求与领先调查',
  category_sort = 1,
  metric_code = 'A01',
  metric_name = '实际 GDP',
  metric_description = '总产出；本国季度口径与年度 WEO 口径是不同统计定义。',
  metric_sort = 1
where id in (10001, 10002)
  and definition_id = 1;

drop table macro_legacy_remap_0136;
drop table macro_directory_0136;
