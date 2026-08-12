# 项目数据表与字段分析

> 生成时间：2026-08-12
> 证据范围：`data/local/stock-info.sqlite` 当前 schema + `src/**` / `web/src/**` 当前代码引用；`web/dist/**` 和 `docs/runtime-audits/**` 未作为是否仍在运行的证据。

## 2026-08-12 空表清理更新

- 本文初版是按“是否仍被代码使用”来判断删表优先级。
- 随后已按用户的明确要求，新增迁移 [`migrations/0115_drop_unused_legacy_tables.sql`](/Users/terry/git/stock-info/migrations/0115_drop_unused_legacy_tables.sql) 删除“当前本地库中所有 0 条记录的表”，并同时删除 5 张当前 `src/`、`web/src/`、`scripts/` 都没有实际读写引用的非空旧表：
  - `llm_cache_entries`
  - `research_operating_analysis_routing_confirmations`
  - `research_operating_analysis_runner_leases`
  - `research_operating_analysis_runs`
  - `research_operating_analysis_stage_artifacts`
- 之后又继续收口 `_local_migrations`：
  - [`scripts/local-db.mjs`](/Users/terry/git/stock-info/scripts/local-db.mjs) 已彻底停止读写 `_local_migrations`，本地迁移状态只认 SQLite `PRAGMA user_version`。
  - [`scripts/report-knowledge-storage.mjs`](/Users/terry/git/stock-info/scripts/report-knowledge-storage.mjs) 不再用 `_local_migrations` 作为“本地数据库存在”的哨兵，而是直接检查 SQLite 文件并查询 `sqlite_master`。
- 由于当前本地库此前已经把旧版 `0115` 记成“已执行”，后续再扩写 `0115` 内容不会自动重跑，所以新增 [`migrations/0116_finalize_unused_legacy_table_cleanup.sql`](/Users/terry/git/stock-info/migrations/0116_finalize_unused_legacy_table_cleanup.sql) 专门清掉老本地库里仍残留的几张表。
- 当前清理的实际目标可以拆成两层：
  - `0115`：为新库提供完整删表基线，覆盖 123 张当时为 0 行的表，以及 5 张无实际代码读写引用的非空旧表
  - `0116`：为已经执行过旧版 `0115` 的本地库补删残留表：`_local_migrations`、`llm_cache_entries`、`research_operating_analysis_routing_confirmations`、`research_operating_analysis_runner_leases`、`research_operating_analysis_runs`、`research_operating_analysis_stage_artifacts`
- 这次清理不是保守式 schema 收缩，而是按“空表即删”的强规则执行；因此其中包含一批虽然当前代码仍有入口、但本地库为空的 `research_*`、`knowledge_*`、`situation_*` 表。
- 因此，本文下面逐表的“保留/候选删除”判断应视为清理前的结构审计记录；真正执行结果以 `0115` + `0116` migration 为准。

## 先看结论

- 当前本地库里最明显的重复层在“专用任务账本 vs 通用任务账本”。`research_operating_analysis_*`、`information_processing_jobs` 和 `workflow_tasks` / `llm_runs` / `llm_run_artifacts` 并存，后者更像统一方向。
- 当前最强删除候选：`company_notices`、`watchlist_items`、`security_aliases`、`knowledge_ingest_runs`、`knowledge_stock_aliases`、`llm_cache_entries`、`research_dossiers`、`research_forecast_calibrations`。
- 当前空但仍有代码入口的表不要因为“空”就删，例如大量 `research_*` typed ledger、`knowledge_filtered_*`、`research_analysis_snapshots`。这些属于“功能未跑数据”而不是“已死表”。
- 字段层面，绝大多数问题不是“单列冗余”，而是“整张专用表与另一张账本职责重叠”。因此文档优先给出删表/并表建议，字段只在整表保留前提下看是否合理。

## 阅读方式

- 每张表都按“现状 / 页面或功能 / 判断 / 字段”展开。
- 字段括号里的判断含义：`保留` = 当前设计合理；`随表删除/归档` = 该表整体建议下线；`若迁移到统一表则一并迁移/收敛` = 字段本身合理，但应该并入统一账本。

## Infra

### _local_migrations
- 现状：清理前本地 123 行；当前 `src/`、`web/src/`、`scripts/` 已无任何运行时依赖。
- 页面/功能：无直接页面；清理前仅本地迁移脚本和知识库统计脚本把它当作内部元数据表。
- 判断：已删除：运行时依赖已彻底移除，并由 `0116` 正式删除。
- 字段：
  - `filename` 本地迁移文件名（随表删除/归档）；`applied_at` 迁移应用时间（随表删除/归档）。

### app_kv
- 现状：本地 962 行；主要 owner/引用：`src/modules/company/api/company.routes.ts`、`src/db/queries.ts`。
- 页面/功能：无直接页面读表；当前主要给公司研报列表/研报分析缓存用，体现在 `company.html` / `company-report` 相关功能。
- 判断：保留：当前代码仍在使用；如果未来要收缩 schema，应优先从重复任务账本和无入口空表下手。
- 字段：
  - `key` 业务字段（保留）；`value_json` JSON 值（保留）；`expires_at` 失效时间（保留）；`updated_at` 更新时间（保留）。

### http_cache
- 现状：本地 1787 行；主要 owner/引用：`src/db/queries.ts`。
- 页面/功能：无直接页面；仅后台抓取、同步与本地迁移使用。
- 判断：保留：当前代码仍在使用；如果未来要收缩 schema，应优先从重复任务账本和无入口空表下手。
- 字段：
  - `cache_key` 缓存键（保留）；`url` 来源 URL（保留）；`method` 业务字段（保留）；`status` 状态（保留）；`headers_json` JSON 载荷（保留）。
  - `body_text` 业务字段（保留）；`expires_at` 失效时间（保留）；`updated_at` 更新时间（保留）。

### sync_jobs
- 现状：本地 292 行；主要 owner/引用：`src/modules/finance/application/sync-provisional-financial-statements.ts`、`src/modules/macro/application/sync-macro-data.ts`。
- 页面/功能：无直接页面；仅后台抓取、同步与本地迁移使用。
- 判断：保留：当前代码仍在使用；如果未来要收缩 schema，应优先从重复任务账本和无入口空表下手。
- 字段：
  - `job_id` 任务 ID（保留）；`job_type` 任务类型（保留）；`status` 状态（保留）；`started_at` 开始时间（保留）；`finished_at` 结束时间（保留）。
  - `error` 错误信息（保留）；`stats_json` 统计 JSON（保留）。

## Security

### securities
- 现状：本地 98 行；主要 owner/引用：`src/modules/company/api/company.routes.ts`、`src/modules/finance/api/finance.routes.ts`、`src/modules/knowledge/application/company-code-mappings.ts`、`src/db/queries.ts`。
- 页面/功能：`/` 与顶部搜索框（`web/src/modules/home/pages/home-page.ts`、`web/src/app/layout/components/app-top-nav.ts`）的证券搜索；公司/研究页也复用证券身份。
- 判断：保留：当前代码仍在使用；如果未来要收缩 schema，应优先从重复任务账本和无入口空表下手。
- 字段：
  - `code` 证券代码（保留）；`market` 市场（保留）；`type` 类型（保留）；`name` 名称（保留）；`currency` 币种（保留）。
  - `exchange_name` 交易所名称（保留）；`source` 来源（保留）；`updated_at` 更新时间（保留）。

### security_aliases
- 现状：本地 0 行；主要 owner/引用：源码无直接引用。
- 页面/功能：当前页面无直接使用。
- 判断：强删除/归档候选：当前代码不再引用，或已被新表取代。删除前只需确认是否还有离线脚本直接读它。
- 字段：
  - `alias` 别名；`code` 对应证券；`source` 来源；`updated_at` 更新时间。当前空表且无现行代码路径，建议删除。

### security_search_prefixes
- 现状：本地 1759 行；主要 owner/引用：`src/db/queries.ts`。
- 页面/功能：`/` 与顶部搜索框（`web/src/modules/home/pages/home-page.ts`、`web/src/app/layout/components/app-top-nav.ts`）的证券搜索；公司/研究页也复用证券身份。
- 判断：保留：当前代码仍在使用；如果未来要收缩 schema，应优先从重复任务账本和无入口空表下手。
- 字段：
  - `prefix` 业务字段（保留）；`code` 证券代码（保留）；`priority` 优先级（保留）。

## Legacy Market

### company_notices
- 现状：本地 0 行；主要 owner/引用：源码无直接引用。
- 页面/功能：当前页面未走这张表。
- 判断：强删除/归档候选：当前代码不再引用，或已被新表取代。删除前只需确认是否还有离线脚本直接读它。
- 字段：
  - `notice_id` 主键；`code` 证券代码；`title` 标题；`publish_date`/`notice_type` 公告时间与类型；`source` 来源；`pdf_r2_key`/`raw_r2_key` 指向 R2 的内容键；`updated_at` 更新时间。整表当前空且无现行代码引用，字段随表一起删除。

### watchlist_items
- 现状：本地 0 行；主要 owner/引用：源码无直接引用。
- 页面/功能：当前页面未走这张表。
- 判断：强删除/归档候选：当前代码不再引用，或已被新表取代。删除前只需确认是否还有离线脚本直接读它。
- 字段：
  - `code` 主键；`enabled` 是否启用；`priority` 优先级；`tags` 标签；`updated_at` 更新时间。当前空表且无现行代码引用，建议删除。

## Knowledge Jobs

### information_processing_jobs
- 现状：本地 32 行；主要 owner/引用：`src/modules/knowledge/application/information-processing-jobs.ts`、`src/shared/local-job-protocol.ts`。
- 页面/功能：`information-processing.html` 的信息抽取状态，以及知识文档结构化处理后台任务。
- 判断：中期合并候选：这张表承担专用任务账本职责，和 `workflow_tasks` / `llm_runs` / `llm_run_artifacts` 明显重复。现阶段先保留，待迁移完成后删除。
- 字段：
  - `job_id`/`job_type` 业务任务标识；`doc_id` 文档主键；`status`、`attempt_count`、`attempt` 运行状态；`trigger_source` 触发来源；`lease_owner`/`lease_until`/`heartbeat_at` 专用租约；`last_run_id`/`last_error` 最近运行结果；`created_at`/`started_at`/`completed_at`/`updated_at` 生命周期。字段设计本身合理，但和 `workflow_tasks` + `llm_runs` 明显重复，建议迁移完成后合并删除。

## Knowledge

### knowledge_company_code_mappings
- 现状：本地 0 行；主要 owner/引用：`src/modules/knowledge/application/company-code-mappings.ts`、`src/modules/research/application/research-governance-capital-facts.ts`、`src/modules/research/application/research-statutory-operating-candidates.ts`、`src/modules/research/application/research-information-evidence.ts`。
- 页面/功能：`knowledge-news.html` 文档列表/详情、`information-processing.html` 结构化结果、`company.html` 与 `company-research.html` 对知识文档/证据的引用。
- 判断：观察项：表结构仍被代码使用，但本地为空。若确认新映射流程已完全依赖别的表，可再考虑删除。
- 字段：
  - `company_name` 公司名（随表删除/归档）；`code` 证券代码（随表删除/归档）；`security_name` 证券名（随表删除/归档）；`source` 来源（随表删除/归档）；`matched_at` 映射时间（随表删除/归档）。
  - `updated_at` 更新时间（随表删除/归档）。

### knowledge_doc_content_refs
- 现状：本地 1535 行；主要 owner/引用：`src/modules/company/api/company.routes.ts`、`src/modules/knowledge/application/information-processing.ts`、`src/modules/knowledge/api/knowledge.routes.ts`、`src/modules/research/application/forecast-ledger.ts`。
- 页面/功能：`knowledge-news.html` 文档列表/详情、`information-processing.html` 结构化结果、`company.html` 与 `company-research.html` 对知识文档/证据的引用。
- 判断：保留：当前代码仍在使用；如果未来要收缩 schema，应优先从重复任务账本和无入口空表下手。
- 字段：
  - `doc_id` 文档 ID（保留）；`content_key` 内容键（保留）；`content_url` 内容 URL（保留）；`content_type` 内容类型（保留）；`content_encoding` 内容编码（保留）。
  - `content_bytes` 内容字节数（保留）；`content_sha256` 内容哈希（保留）；`updated_at` 更新时间（保留）。

### knowledge_doc_security_links
- 现状：本地 657 行；主要 owner/引用：`src/modules/knowledge/api/knowledge.routes.ts`、`src/modules/research/application/import-statutory-disclosure-to-knowledge.ts`。
- 页面/功能：`knowledge-news.html` 文档列表/详情、`information-processing.html` 结构化结果、`company.html` 与 `company-research.html` 对知识文档/证据的引用。
- 判断：保留：当前代码仍在使用；如果未来要收缩 schema，应优先从重复任务账本和无入口空表下手。
- 字段：
  - `doc_id` 文档 ID（保留）；`code` 证券代码（保留）。

### knowledge_doc_tags
- 现状：本地 4988 行；主要 owner/引用：`src/modules/knowledge/api/knowledge.routes.ts`、`src/modules/research/application/import-statutory-disclosure-to-knowledge.ts`。
- 页面/功能：`knowledge-news.html` 文档列表/详情、`information-processing.html` 结构化结果、`company.html` 与 `company-research.html` 对知识文档/证据的引用。
- 判断：保留：当前代码仍在使用；如果未来要收缩 schema，应优先从重复任务账本和无入口空表下手。
- 字段：
  - `doc_id` 文档 ID（保留）；`tag` 业务字段（保留）。

### knowledge_docs
- 现状：本地 1775 行；主要 owner/引用：`src/modules/company/api/company.routes.ts`、`src/modules/market/api/market.routes.ts`、`src/modules/knowledge/application/information-processing.ts`、`src/modules/knowledge/api/knowledge.routes.ts`。
- 页面/功能：`knowledge-news.html` 文档列表/详情、`information-processing.html` 结构化结果、`company.html` 与 `company-research.html` 对知识文档/证据的引用。
- 判断：保留：当前代码仍在使用；如果未来要收缩 schema，应优先从重复任务账本和无入口空表下手。
- 字段：
  - `doc_id` 文档 ID（保留）；`source_type` 业务字段（保留）；`report_type` 业务字段（保留）；`source_name` 业务字段（保留）；`title` 标题（保留）。
  - `url` 来源 URL（保留）；`published_at` 发布时间（保留）；`fetched_at` 抓取时间（保留）；`event_time` 事件时间（保留）；`target_name` 目标名称（保留）。
  - `target_code` 目标代码（保留）；`discovery_method` 发现方式（保留）；`access_method` 访问方式（保留）；`summary` 摘要（保留）；`content_preview` 预览（保留）。
  - `metadata_json` 任务元数据（保留）；`recommendation_score` 推荐分（保留）；`recommendation_level` 推荐等级（保留）；`recommendation_tags_json` 推荐标签（保留）；`recommendation_reasons_json` 推荐理由（保留）。
  - `rank_score` 排序分（保留）；`source_weight` 来源权重（保留）；`updated_at` 更新时间（保留）；`sort_time` 排序时间（保留）；`source_name_normalized` 标准化来源名（保留）。
  - `target_code_normalized` 标准化证券代码（保留）。

### knowledge_document_results
- 现状：本地 262 行；主要 owner/引用：`src/modules/knowledge/application/company-code-mappings.ts`、`src/modules/knowledge/application/information-processing.ts`、`src/modules/knowledge/api/knowledge.routes.ts`、`src/modules/research/application/a-h-statutory-verification.ts`。
- 页面/功能：`knowledge-news.html` 文档列表/详情、`information-processing.html` 结构化结果、`company.html` 与 `company-research.html` 对知识文档/证据的引用。
- 判断：保留：当前代码仍在使用；如果未来要收缩 schema，应优先从重复任务账本和无入口空表下手。
- 字段：
  - `result_id` 结果 ID（保留）；`run_id` 运行 ID（保留）；`version_id` 版本 ID（保留）；`outcome` 结果类型（保留）；`created_at` 创建时间（保留）。

### knowledge_document_versions
- 现状：本地 500 行；主要 owner/引用：`src/modules/knowledge/application/company-code-mappings.ts`、`src/modules/knowledge/application/information-processing-jobs.ts`、`src/modules/knowledge/application/information-processing.ts`、`src/modules/knowledge/api/knowledge.routes.ts`。
- 页面/功能：`knowledge-news.html` 文档列表/详情、`information-processing.html` 结构化结果、`company.html` 与 `company-research.html` 对知识文档/证据的引用。
- 判断：保留：当前代码仍在使用；如果未来要收缩 schema，应优先从重复任务账本和无入口空表下手。
- 字段：
  - `version_id` 版本 ID（保留）；`doc_id` 文档 ID（保留）；`source_url` 来源 URL（保留）；`source_hash` 源哈希（保留）；`content_hash` 内容哈希（保留）。
  - `raw_content_key` 原始内容键（保留）；`normalized_content_key` 标准化内容键（保留）；`structure_json` 结构 JSON（保留）；`published_at` 发布时间（保留）；`fetched_at` 抓取时间（保留）。
  - `access_policy_json` 访问策略（保留）；`created_at` 创建时间（保留）。

### knowledge_filtered_doc_content_refs
- 现状：本地 0 行；主要 owner/引用：`src/modules/knowledge/api/knowledge.routes.ts`。
- 页面/功能：`knowledge-news.html` 的过滤队列/保留操作。当前本地库为空。
- 判断：可选删除候选：当前空表；如果过滤队列功能已不再需要，可与其 content ref 一起删除。
- 字段：
  - `doc_id` 文档 ID（随表删除/归档）；`content_key` 内容键（随表删除/归档）；`content_url` 内容 URL（随表删除/归档）；`content_type` 内容类型（随表删除/归档）；`content_encoding` 内容编码（随表删除/归档）。
  - `content_bytes` 内容字节数（随表删除/归档）；`content_sha256` 内容哈希（随表删除/归档）；`updated_at` 更新时间（随表删除/归档）。

### knowledge_filtered_docs
- 现状：本地 0 行；主要 owner/引用：`src/modules/knowledge/api/knowledge.routes.ts`、`src/modules/situation/application/sync-situation-knowledge.ts`。
- 页面/功能：`knowledge-news.html` 的过滤队列/保留操作。当前本地库为空。
- 判断：可选删除候选：当前空表；如果过滤队列功能已不再需要，可与其 content ref 一起删除。
- 字段：
  - `doc_id` 文档 ID（随表删除/归档）；`source_type` 业务字段（随表删除/归档）；`report_type` 业务字段（随表删除/归档）；`source_name` 业务字段（随表删除/归档）；`title` 标题（随表删除/归档）。
  - `url` 来源 URL（随表删除/归档）；`published_at` 发布时间（随表删除/归档）；`fetched_at` 抓取时间（随表删除/归档）；`event_time` 事件时间（随表删除/归档）；`target_name` 目标名称（随表删除/归档）。
  - `target_code` 目标代码（随表删除/归档）；`summary` 摘要（随表删除/归档）；`content_preview` 预览（随表删除/归档）；`metadata_json` 任务元数据（随表删除/归档）；`filter_method` 过滤方法（随表删除/归档）。
  - `filter_score` 过滤分（随表删除/归档）；`filter_confidence` 过滤置信度（随表删除/归档）；`filter_reasons_json` 过滤理由（随表删除/归档）；`source_file` 本地源文件（随表删除/归档）；`reviewed_status` 审核状态（随表删除/归档）。
  - `reviewed_at` 审核时间（随表删除/归档）；`updated_at` 更新时间（随表删除/归档）；`access_method` 访问方式（随表删除/归档）。

### knowledge_information_records
- 现状：本地 248 行；主要 owner/引用：`src/modules/knowledge/application/company-code-mappings.ts`、`src/modules/knowledge/application/information-processing.ts`、`src/modules/knowledge/api/knowledge.routes.ts`、`src/modules/research/application/forecast-ledger.ts`。
- 页面/功能：`knowledge-news.html` 文档列表/详情、`information-processing.html` 结构化结果、`company.html` 与 `company-research.html` 对知识文档/证据的引用。
- 判断：保留：当前代码仍在使用；如果未来要收缩 schema，应优先从重复任务账本和无入口空表下手。
- 字段：
  - `information_id` 信息 ID（保留）；`result_id` 结果 ID（保留）；`entity` 实体（保留）；`information_type` 信息类型（保留）；`category` 分类（保留）。
  - `period` 期间（保留）；`statement` 陈述文本（保留）；`sort_order` 排序（保留）；`created_at` 创建时间（保留）；`forecast_measurement_json` 预测度量 JSON（保留）。

### knowledge_ingest_runs
- 现状：本地 6 行；主要 owner/引用：源码无直接引用。
- 页面/功能：`knowledge-news.html` 文档列表/详情、`information-processing.html` 结构化结果、`company.html` 与 `company-research.html` 对知识文档/证据的引用。
- 判断：强删除/归档候选：当前代码不再引用，或已被新表取代。删除前只需确认是否还有离线脚本直接读它。
- 字段：
  - `run_id` 主键；`status` 状态；`source` 来源；`started_at`/`finished_at` 时间；`stats_json` 统计；`error` 错误。已有历史行但当前代码无读写，建议先归档再删。

### knowledge_local_content_cache
- 现状：本地 1564 行；主要 owner/引用：`src/modules/knowledge/application/information-processing.ts`、`src/modules/knowledge/api/knowledge.routes.ts`、`src/modules/research/application/import-statutory-disclosure-to-knowledge.ts`。
- 页面/功能：`knowledge-news.html` 文档列表/详情、`information-processing.html` 结构化结果、`company.html` 与 `company-research.html` 对知识文档/证据的引用。
- 判断：保留：当前代码仍在使用；如果未来要收缩 schema，应优先从重复任务账本和无入口空表下手。
- 字段：
  - `content_key` 内容键（保留）；`content_type` 内容类型（保留）；`content_encoding` 内容编码（保留）；`content_sha256` 内容哈希（保留）；`content_bytes` 内容字节数（保留）。
  - `updated_at` 更新时间（保留）。

### knowledge_local_content_cache_chunks
- 现状：本地 1564 行；主要 owner/引用：`src/modules/knowledge/application/information-processing.ts`、`src/modules/knowledge/api/knowledge.routes.ts`、`src/modules/research/application/research-auto-filing-insights.ts`、`src/modules/research/application/import-statutory-disclosure-to-knowledge.ts`。
- 页面/功能：`knowledge-news.html` 文档列表/详情、`information-processing.html` 结构化结果、`company.html` 与 `company-research.html` 对知识文档/证据的引用。
- 判断：保留：当前代码仍在使用；如果未来要收缩 schema，应优先从重复任务账本和无入口空表下手。
- 字段：
  - `content_key` 内容键（保留）；`chunk_index` 业务字段（保留）；`payload_base64` 业务字段（保留）。

### knowledge_preprocessing_decisions
- 现状：本地 507 行；主要 owner/引用：`src/modules/knowledge/application/information-processing.ts`、`src/modules/knowledge/api/knowledge.routes.ts`。
- 页面/功能：`knowledge-news.html` 文档列表/详情、`information-processing.html` 结构化结果、`company.html` 与 `company-research.html` 对知识文档/证据的引用。
- 判断：保留：当前代码仍在使用；如果未来要收缩 schema，应优先从重复任务账本和无入口空表下手。
- 字段：
  - `decision_id` 决策 ID（保留）；`version_id` 版本 ID（保留）；`action` 动作（保留）；`reason_code` 原因码（保留）；`rule_version` 规则版本（保留）。
  - `matched_source_type` 匹配来源类型（保留）；`matched_template_id` 匹配模板 ID（保留）；`duplicate_of_version_id` 重复目标版本（保留）；`details_json` 细节 JSON（保留）；`decided_at` 决策时间（保留）。

### knowledge_processing_runs
- 现状：本地 267 行；主要 owner/引用：`src/modules/knowledge/application/information-processing-jobs.ts`、`src/modules/knowledge/application/information-processing.ts`、`src/modules/knowledge/api/knowledge.routes.ts`、`src/modules/research/application/forecast-ledger.ts`。
- 页面/功能：`knowledge-news.html` 文档列表/详情、`information-processing.html` 结构化结果、`company.html` 与 `company-research.html` 对知识文档/证据的引用。
- 判断：保留：当前代码仍在使用；如果未来要收缩 schema，应优先从重复任务账本和无入口空表下手。
- 字段：
  - `run_id` 运行 ID（保留）；`version_id` 版本 ID（保留）；`stage` 阶段（保留）；`model` 模型（保留）；`returned_model` 返回模型（保留）。
  - `prompt_version` Prompt 版本（保留）；`schema_version` Schema 版本（保留）；`ontology_version` Ontology 版本（保留）；`input_hash` 输入哈希（保留）；`raw_output_key` 原始输出键（保留）。
  - `status` 状态（保留）；`usage_json` 用量 JSON（保留）；`validation_json` 校验 JSON（保留）；`retry_count` 重试次数（保留）；`error` 错误信息（保留）。
  - `started_at` 开始时间（保留）；`completed_at` 完成时间（保留）。

### knowledge_stock_aliases
- 现状：本地 1476 行；主要 owner/引用：源码无直接引用。
- 页面/功能：`knowledge-news.html` 文档列表/详情、`information-processing.html` 结构化结果、`company.html` 与 `company-research.html` 对知识文档/证据的引用。
- 判断：强删除/归档候选：当前代码不再引用，或已被新表取代。删除前只需确认是否还有离线脚本直接读它。
- 字段：
  - `alias` 别名；`code` 证券代码；`name` 名称；`source` 来源；`updated_at` 更新时间。表里有历史别名数据，但源码无现行引用，疑似被 `knowledge_company_code_mappings` / `knowledge_doc_security_links` 取代，建议确认离线脚本后归档删除。

## Tasking

### llm_cache_entries
- 现状：本地 14 行；主要 owner/引用：源码无直接引用。
- 页面/功能：无统一用户页直读表；主要通过 `information-processing.html`、`company-finance.html`、`investment-analysis.html` 的任务状态间接暴露。
- 判断：强删除/归档候选：当前代码不再引用，或已被新表取代。删除前只需确认是否还有离线脚本直接读它。
- 字段：
  - `cache_key` 主键；`provider`/`model` 模型来源；`request_json`/`response_json` 请求响应快照；`expires_at` 过期时间。当前源码无引用，建议删除。

### llm_run_artifact_links
- 现状：本地 0 行；主要 owner/引用：`src/shared/local-job-protocol.ts`。
- 页面/功能：无统一用户页直读表；主要通过 `information-processing.html`、`company-finance.html`、`investment-analysis.html` 的任务状态间接暴露。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `run_id` 运行 ID（保留）；`artifact_id` 产物 ID（保留）；`source_run_id` 关联主键（保留）；`step_key` 键值（保留）；`stage_version` 阶段版本（保留）。
  - `input_fingerprint` 输入指纹（保留）；`upstream_artifact_ids_json` 上游产物 ID 列表（保留）；`projection_version` 投影版本（保留）；`linked_at` 时间戳（保留）。

### llm_run_artifacts
- 现状：本地 964 行；主要 owner/引用：`src/shared/local-job-protocol.ts`。
- 页面/功能：无统一用户页直读表；主要通过 `information-processing.html`、`company-finance.html`、`investment-analysis.html` 的任务状态间接暴露。
- 判断：保留：当前代码仍在使用；如果未来要收缩 schema，应优先从重复任务账本和无入口空表下手。
- 字段：
  - `artifact_id`、`run_id`、`step_key` 标识一次运行的阶段产物；`upstream_artifact_ids_json`、`output_type`、`status`、`output_json`、`output_markdown`、`structure_valid`、`blocked_json`、`error_code`、`error_message`、`terminal_metadata_json` 表达产物内容和阻断；`completed_at`、`stage_version`、`input_fingerprint`、`source_ids_json`、`claim_ids_json`、`evidence_ids_json`、`unknown_ids_json`、`projection_version` 支撑审计与复用。表应保留。

### llm_runs
- 现状：本地 1078 行；主要 owner/引用：`src/modules/knowledge/application/information-processing-jobs.ts`、`src/modules/knowledge/api/knowledge.routes.ts`、`src/shared/local-job-protocol.ts`。
- 页面/功能：无统一用户页直读表；主要通过 `information-processing.html`、`company-finance.html`、`investment-analysis.html` 的任务状态间接暴露。
- 判断：保留：当前代码仍在使用；如果未来要收缩 schema，应优先从重复任务账本和无入口空表下手。
- 字段：
  - `run_id`、`task_id`、`attempt` 唯一标识一次执行；`provider`、`model`、`reasoning_effort`、`prompt_version` 记录执行配置；`input_fingerprint`、`input_as_of`、`input_json`、`prompt_json` 记录输入快照；`status`、`lease_owner`、`lease_until`、`heartbeat_at`、`current_step_key`、`progress_json`、`progress_updated_at`、`terminal_metadata_json`、`error_code`、`error_message` 支撑恢复与可观测性；`started_at`、`completed_at`、`updated_at`、`lineage_run_id` 支撑历史和复用。表应保留。

### llm_scheduler_sequence
- 现状：本地 1 行；主要 owner/引用：`src/shared/local-job-protocol.ts`。
- 页面/功能：无统一用户页直读表；主要通过 `information-processing.html`、`company-finance.html`、`investment-analysis.html` 的任务状态间接暴露。
- 判断：保留：当前代码仍在使用；如果未来要收缩 schema，应优先从重复任务账本和无入口空表下手。
- 字段：
  - `sequence_name` 序列名（保留）；`next_sequence` 下一个序号（保留）。

### llm_task_dependencies
- 现状：本地 44 行；主要 owner/引用：`src/shared/local-job-protocol.ts`。
- 页面/功能：无统一用户页直读表；主要通过 `information-processing.html`、`company-finance.html`、`investment-analysis.html` 的任务状态间接暴露。
- 判断：保留：当前代码仍在使用；如果未来要收缩 schema，应优先从重复任务账本和无入口空表下手。
- 字段：
  - `task_id` 任务 ID（保留）；`depends_on_task_id` 关联主键（保留）；`required_status` 状态字段（保留）；`created_at` 创建时间（保留）。

### llm_workflow_artifact_links
- 现状：本地 91 行；主要 owner/引用：`src/shared/local-job-protocol.ts`。
- 页面/功能：无统一用户页直读表；主要通过 `information-processing.html`、`company-finance.html`、`investment-analysis.html` 的任务状态间接暴露。
- 判断：保留：当前代码仍在使用；如果未来要收缩 schema，应优先从重复任务账本和无入口空表下手。
- 字段：
  - `parent_task_id` 父任务 ID（保留）；`child_task_id` 关联主键（保留）；`run_id` 运行 ID（保留）；`artifact_id` 产物 ID（保留）；`stage_key` 阶段键（保留）。
  - `linked_at` 时间戳（保留）。

### local_job_provider_leases
- 现状：本地 0 行；主要 owner/引用：`src/shared/local-job-protocol.ts`。
- 页面/功能：无统一用户页直读表；主要通过 `information-processing.html`、`company-finance.html`、`investment-analysis.html` 的任务状态间接暴露。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `provider_id` provider ID（保留）；`job_id` 任务 ID（保留）；`job_type` 任务类型（保留）；`attempt` 尝试序号（保留）；`lease_owner` 租约持有者（保留）。
  - `acquired_at` 租约获取时间（保留）。

### local_job_provider_slots
- 现状：本地 1 行；主要 owner/引用：`src/shared/local-job-protocol.ts`。
- 页面/功能：无统一用户页直读表；主要通过 `information-processing.html`、`company-finance.html`、`investment-analysis.html` 的任务状态间接暴露。
- 判断：保留：当前代码仍在使用；如果未来要收缩 schema，应优先从重复任务账本和无入口空表下手。
- 字段：
  - `provider_id` provider ID（保留）；`active_count` 当前占用数（保留）；`concurrency_limit` 并发上限（保留）；`updated_at` 更新时间（保留）。

### workflow_tasks
- 现状：本地 932 行；主要 owner/引用：`src/modules/knowledge/application/information-processing-jobs.ts`、`src/modules/knowledge/api/knowledge.routes.ts`、`src/shared/local-job-protocol.ts`。
- 页面/功能：无统一用户页直读表；主要通过 `information-processing.html`、`company-finance.html`、`investment-analysis.html` 的任务状态间接暴露。
- 判断：保留：当前代码仍在使用；如果未来要收缩 schema，应优先从重复任务账本和无入口空表下手。
- 字段：
  - `task_id`、`task_type`、`target_type`、`target_id`、`idempotency_key`、`protocol_version`、`prompt_version` 定义任务唯一性；`status`、`requested_model`、`requested_reasoning_effort`、`last_run_id`、`last_error_code`、`last_error_message` 表示任务状态；`metadata_json` 承载扩展元数据；`created_at`/`started_at`/`completed_at`/`updated_at` 生命周期；`priority`、`queue_sequence`、`handler_key`、`execution_mode`、`parent_task_id`、`stage_key`、`ready_at` 是统一调度所需。表应保留，并继续吸收专用任务表能力。

## Macro

### macro_alert_history
- 现状：本地 2 行；主要 owner/引用：`src/modules/macro/application/macro-repository.ts`。
- 页面/功能：`macro.html` 的看板、预警、来源健康、事件日历、回测与追溯。
- 判断：保留：当前代码仍在使用；如果未来要收缩 schema，应优先从重复任务账本和无入口空表下手。
- 字段：
  - `alert_id` 关联主键（保留）；`owner_key` 用户/owner 键（保留）；`series_id` 序列 ID（保留）；`observation_date` 观测日期（保留）；`observation_vintage_at` 观测版本时间（保留）。
  - `observed_at` 观测时间（保留）；`value` 数值（保留）；`rule_operator` 规则操作符（保留）；`rule_threshold` 规则阈值（保留）；`source_url` 来源 URL（保留）。
  - `notification_state` 通知状态（保留）；`notification_detail` 通知细节（保留）；`evaluated_at` 评估时间（保留）；`metadata_json` 任务元数据（保留）。

### macro_events
- 现状：本地 119 行；主要 owner/引用：`src/modules/macro/application/macro-repository.ts`、`src/modules/research/api/research.routes.ts`。
- 页面/功能：`macro.html` 的看板、预警、来源健康、事件日历、回测与追溯。
- 判断：保留：当前代码仍在使用；如果未来要收缩 schema，应优先从重复任务账本和无入口空表下手。
- 字段：
  - `event_id` 事件 ID（保留）；`scheduled_at` 计划时间（保留）；`region` 地区（保留）；`importance` 重要性（保留）；`title` 标题（保留）。
  - `series_id` 序列 ID（保留）；`actual` 实际值（保留）；`consensus` 一致预期（保留）；`previous` 前值（保留）；`unit` 单位（保留）。
  - `status` 状态（保留）；`source_id` 来源 ID（保留）；`source_url` 来源 URL（保留）；`metadata_json` 任务元数据（保留）；`updated_at` 更新时间（保留）。

### macro_series
- 现状：本地 25 行；主要 owner/引用：`src/modules/macro/application/macro-repository.ts`。
- 页面/功能：`macro.html` 的看板、预警、来源健康、事件日历、回测与追溯。
- 判断：保留：当前代码仍在使用；如果未来要收缩 schema，应优先从重复任务账本和无入口空表下手。
- 字段：
  - `series_id` 序列 ID（保留）；`name` 名称（保留）；`category` 分类（保留）；`region` 地区（保留）；`frequency` 频率（保留）。
  - `unit` 单位（保留）；`source_id` 来源 ID（保留）；`transmission_json` 传导配置（保留）；`regions_json` 区域列表（保留）；`license_class` 授权级别（保留）。
  - `stale_after_seconds` 过期秒数（保留）；`enabled` 启用开关（保留）；`metadata_json` 任务元数据（保留）；`updated_at` 更新时间（保留）。

### macro_series_history
- 现状：本地 20 行；主要 owner/引用：`src/modules/macro/application/macro-repository.ts`。
- 页面/功能：`macro.html` 的看板、预警、来源健康、事件日历、回测与追溯。
- 判断：保留：当前代码仍在使用；如果未来要收缩 schema，应优先从重复任务账本和无入口空表下手。
- 字段：
  - `series_id` 序列 ID（保留）；`vintages_json` JSON 载荷（保留）；`updated_at` 更新时间（保留）。

### macro_source_health
- 现状：本地 9 行；主要 owner/引用：`src/modules/macro/application/macro-repository.ts`。
- 页面/功能：`macro.html` 的看板、预警、来源健康、事件日历、回测与追溯。
- 判断：保留：当前代码仍在使用；如果未来要收缩 schema，应优先从重复任务账本和无入口空表下手。
- 字段：
  - `source_id` 来源 ID（保留）；`display_name` 展示名（保留）；`state` 状态（保留）；`last_attempt_at` 最近尝试时间（保留）；`last_success_at` 最近成功时间（保留）。
  - `consecutive_failures` 连续失败次数（保留）；`last_error` 最近错误（保留）；`next_retry_at` 下次重试时间（保留）；`latency_ms` 延迟毫秒（保留）；`metadata_json` 任务元数据（保留）。
  - `updated_at` 更新时间（保留）。

### macro_user_watch_configs
- 现状：本地 1 行；主要 owner/引用：`src/modules/macro/application/macro-repository.ts`。
- 页面/功能：`macro.html` 的看板、预警、来源健康、事件日历、回测与追溯。
- 判断：保留：当前代码仍在使用；如果未来要收缩 schema，应优先从重复任务账本和无入口空表下手。
- 字段：
  - `owner_key` 用户/owner 键（保留）；`series_id` 序列 ID（保留）；`enabled` 启用开关（保留）；`position` 排序位置（保留）；`alert_rules_json` 预警规则（保留）。
  - `display_options_json` 展示选项（保留）；`created_at` 创建时间（保留）；`updated_at` 更新时间（保留）。

## Situation

### situation_action_candidates
- 现状：本地 0 行；主要 owner/引用：`src/modules/situation/application/situation-repository.ts`。
- 页面/功能：`situation.html`、`situation-today.html`、`situation-holdings.html`、`situation-opportunities.html` 的态势、候选动作、证据和快照。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `candidate_id` 候选 ID（保留）；`owner_key` 用户/owner 键（保留）；`as_of` as-of 时间（保留）；`action_type` 动作类型（保留）；`target_type` 目标类型（保留）。
  - `target_id` 目标 ID（保留）；`priority` 优先级（保留）；`status` 状态（保留）；`prerequisites_json` 前置条件（保留）；`proposed_plan_json` 建议计划（保留）。
  - `invalidations_json` 失效条件（保留）；`evidence_json` 证据 JSON（保留）；`rule_version` 规则版本（保留）；`expires_at` 失效时间（保留）；`created_at` 创建时间（保留）。
  - `updated_at` 更新时间（保留）。

### situation_candidate_dispositions
- 现状：本地 0 行；主要 owner/引用：`src/modules/situation/application/situation-repository.ts`。
- 页面/功能：`situation.html`、`situation-today.html`、`situation-holdings.html`、`situation-opportunities.html` 的态势、候选动作、证据和快照。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `disposition_id` 关联主键（保留）；`candidate_id` 候选 ID（保留）；`owner_key` 用户/owner 键（保留）；`disposition` 处置结果（保留）；`note` 备注（保留）。
  - `created_at` 创建时间（保留）。

### situation_event_evidence
- 现状：本地 289 行；主要 owner/引用：`src/modules/situation/application/situation-repository.ts`。
- 页面/功能：`situation.html`、`situation-today.html`、`situation-holdings.html`、`situation-opportunities.html` 的态势、候选动作、证据和快照。
- 判断：保留：当前代码仍在使用；如果未来要收缩 schema，应优先从重复任务账本和无入口空表下手。
- 字段：
  - `event_id` 事件 ID（保留）；`evidence_id` 证据 ID（保留）；`role` 角色（保留）；`confidence` 置信度（保留）；`created_at` 创建时间（保留）。

### situation_events
- 现状：本地 289 行；主要 owner/引用：`src/modules/situation/application/situation-repository.ts`。
- 页面/功能：`situation.html`、`situation-today.html`、`situation-holdings.html`、`situation-opportunities.html` 的态势、候选动作、证据和快照。
- 判断：保留：当前代码仍在使用；如果未来要收缩 schema，应优先从重复任务账本和无入口空表下手。
- 字段：
  - `event_id` 事件 ID（保留）；`canonical_key` 幂等主键（保留）；`title` 标题（保留）；`occurred_at` 时间戳（保留）；`region` 地区（保留）。
  - `event_type` 事件类型（保留）；`status` 状态（保留）；`importance` 重要性（保留）；`summary` 摘要（保留）；`first_seen_at` 首次发现时间（保留）。
  - `last_seen_at` 最近发现时间（保留）；`created_at` 创建时间（保留）；`updated_at` 更新时间（保留）。

### situation_evidence
- 现状：本地 1775 行；主要 owner/引用：`src/modules/situation/application/situation-repository.ts`。
- 页面/功能：`situation.html`、`situation-today.html`、`situation-holdings.html`、`situation-opportunities.html` 的态势、候选动作、证据和快照。
- 判断：保留：当前代码仍在使用；如果未来要收缩 schema，应优先从重复任务账本和无入口空表下手。
- 字段：
  - `evidence_id` 证据 ID（保留）；`source_id` 来源 ID（保留）；`external_id` 外部 ID（保留）；`url` 来源 URL（保留）；`title` 标题（保留）。
  - `excerpt` 摘录（保留）；`published_at` 发布时间（保留）；`fetched_at` 抓取时间（保留）；`content_hash` 内容哈希（保留）；`raw_r2_key` R2 原始键（保留）。
  - `entities_json` 实体 JSON（保留）；`metadata_json` 任务元数据（保留）；`evidence_grade` 证据等级（保留）；`status` 状态（保留）；`created_at` 创建时间（保留）。

### situation_holding_profiles
- 现状：本地 0 行；主要 owner/引用：`src/modules/situation/application/situation-repository.ts`、`src/modules/research/application/research-owner-holding-snapshot-reference.ts`。
- 页面/功能：`situation.html`、`situation-today.html`、`situation-holdings.html`、`situation-opportunities.html` 的态势、候选动作、证据和快照。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `owner_key` 用户/owner 键（保留）；`code` 证券代码（保留）；`profile_json` 画像 JSON（保留）；`updated_at` 更新时间（保留）。

### situation_impacts
- 现状：本地 5864 行；主要 owner/引用：`src/modules/situation/application/situation-repository.ts`。
- 页面/功能：`situation.html`、`situation-today.html`、`situation-holdings.html`、`situation-opportunities.html` 的态势、候选动作、证据和快照。
- 判断：保留：当前代码仍在使用；如果未来要收缩 schema，应优先从重复任务账本和无入口空表下手。
- 字段：
  - `impact_id` 影响 ID（保留）；`event_id` 事件 ID（保留）；`signal_id` 信号 ID（保留）；`target_type` 目标类型（保留）；`target_id` 目标 ID（保留）。
  - `direction` 方向（保留）；`transmission` 传导链路（保留）；`confidence` 置信度（保留）；`rationale_json` 理由 JSON（保留）；`expires_at` 失效时间（保留）。
  - `created_at` 创建时间（保留）。

### situation_knowledge_imports
- 现状：本地 1775 行；主要 owner/引用：`src/modules/situation/application/sync-situation-knowledge.ts`。
- 页面/功能：`situation.html`、`situation-today.html`、`situation-holdings.html`、`situation-opportunities.html` 的态势、候选动作、证据和快照。
- 判断：保留：当前代码仍在使用；如果未来要收缩 schema，应优先从重复任务账本和无入口空表下手。
- 字段：
  - `source_scope` 业务字段（保留）；`doc_id` 文档 ID（保留）；`status` 状态（保留）；`evidence_id` 证据 ID（保留）；`reason` 原因/说明（保留）。
  - `first_seen_at` 首次发现时间（保留）；`updated_at` 更新时间（保留）。

### situation_portfolio_rules
- 现状：本地 0 行；主要 owner/引用：`src/modules/situation/application/situation-repository.ts`。
- 页面/功能：`situation.html`、`situation-today.html`、`situation-holdings.html`、`situation-opportunities.html` 的态势、候选动作、证据和快照。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `owner_key` 用户/owner 键（保留）；`rules_json` 规则 JSON（保留）；`updated_at` 更新时间（保留）。

### situation_signals
- 现状：本地 5328 行；主要 owner/引用：`src/modules/situation/application/situation-repository.ts`。
- 页面/功能：`situation.html`、`situation-today.html`、`situation-holdings.html`、`situation-opportunities.html` 的态势、候选动作、证据和快照。
- 判断：保留：当前代码仍在使用；如果未来要收缩 schema，应优先从重复任务账本和无入口空表下手。
- 字段：
  - `signal_id` 信号 ID（保留）；`subject_type` 主体类型（保留）；`subject_id` 主体 ID（保留）；`rule_id` 规则 ID（保留）；`rule_version` 规则版本（保留）。
  - `state` 状态（保留）；`score` 分数（保留）；`confidence` 置信度（保留）；`observed_at` 观测时间（保留）；`expires_at` 失效时间（保留）。
  - `input_json` 输入快照（保留）；`explanation_json` 解释 JSON（保留）；`created_at` 创建时间（保留）。

### situation_snapshots
- 现状：本地 5661 行；主要 owner/引用：`src/modules/situation/application/situation-repository.ts`。
- 页面/功能：`situation.html`、`situation-today.html`、`situation-holdings.html`、`situation-opportunities.html` 的态势、候选动作、证据和快照。
- 判断：保留：当前代码仍在使用；如果未来要收缩 schema，应优先从重复任务账本和无入口空表下手。
- 字段：
  - `snapshot_id` 快照 ID（保留）；`as_of` as-of 时间（保留）；`scope_type` 范围类型（保留）；`scope_id` 范围 ID（保留）；`state` 状态（保留）。
  - `confidence` 置信度（保留）；`summary_json` 摘要 JSON（保留）；`rule_version` 规则版本（保留）；`created_at` 创建时间（保留）。

### situation_sources
- 现状：本地 2 行；主要 owner/引用：`src/modules/situation/application/situation-repository.ts`。
- 页面/功能：`situation.html`、`situation-today.html`、`situation-holdings.html`、`situation-opportunities.html` 的态势、候选动作、证据和快照。
- 判断：保留：当前代码仍在使用；如果未来要收缩 schema，应优先从重复任务账本和无入口空表下手。
- 字段：
  - `source_id` 来源 ID（保留）；`name` 名称（保留）；`kind` 业务字段（保留）；`config_json` JSON 载荷（保留）；`health_state` 业务字段（保留）。
  - `last_attempt_at` 最近尝试时间（保留）；`last_success_at` 最近成功时间（保留）；`consecutive_failures` 连续失败次数（保留）；`last_error` 最近错误（保留）；`updated_at` 更新时间（保留）。

## Research

### research_analysis_snapshot_modules
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-risk-review.ts`、`src/modules/research/application/research-public-snapshot.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `analysis_snapshot_id` 关联主键（保留）；`module_id` 关联主键（保留）；`availability` 业务字段（保留）；`version_id` 版本 ID（保留）；`module_as_of` 业务字段（保留）。
  - `payload_json` JSON 载荷（保留）；`created_at` 创建时间（保留）。

### research_analysis_snapshots
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-public-snapshot.ts`、`src/modules/research/application/research-risk-review.ts`、`src/modules/research/application/research-owner-holding-snapshot-reference.ts`、`src/modules/research/application/research-dossier.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `analysis_snapshot_id` 关联主键（保留）；`company_id` 公司 ID（保留）；`security_code` 证券代码（保留）；`as_of` as-of 时间（保留）；`completion_level` 业务字段（保留）。
  - `state` 状态（保留）；`summary_json` 摘要 JSON（保留）；`module_status_json` JSON 载荷（保留）；`created_at` 创建时间（保留）。

### research_auto_filing_document_versions
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-auto-filing-insights.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `document_version_id` 关联主键（保留）；`security_code` 证券代码（保留）；`statutory_document_id` 关联主键（保留）；`document_kind` 业务字段（保留）；`title` 标题（保留）。
  - `published_at` 发布时间（保留）；`document_url` 引用 URL（保留）；`report_period` 业务字段（保留）；`prompt_version` Prompt 版本（保留）；`extracted_at` 时间戳（保留）。
  - `is_current` 布尔状态（保留）；`superseded_by_document_id` 关联主键（保留）；`created_at` 创建时间（保留）；`updated_at` 更新时间（保留）。

### research_auto_filing_fact_inputs
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-financial-specialty-metrics.ts`、`src/modules/research/application/research-auto-filing-insights.ts`、`src/modules/research/application/research-financial-profile.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `filing_fact_input_id` 关联主键（保留）；`source_insight_id` 关联主键（保留）；`operating_company_id` 关联主键（保留）；`security_code` 证券代码（保留）；`statutory_document_id` 关联主键（保留）。
  - `document_url` 引用 URL（保留）；`target_module` 业务字段（保留）；`fact_type` 业务字段（保留）；`fact_key` 键值（保留）；`title` 标题（保留）。
  - `statement` 陈述文本（保留）；`reported_value` 业务字段（保留）；`value_type` 业务字段（保留）；`unit` 单位（保留）；`report_period` 业务字段（保留）。
  - `evidence_quote` 业务字段（保留）；`evidence_locator` 业务字段（保留）；`extraction_method` 业务字段（保留）；`prompt_version` Prompt 版本（保留）；`model` 模型（保留）。
  - `usage_policy` 业务字段（保留）；`processed_at` 时间戳（保留）；`materialized_at` 时间戳（保留）；`subject_label` 业务字段（保留）；`segment_label` 业务字段（保留）。
  - `geography_label` 业务字段（保留）；`customer_or_channel` 业务字段（保留）；`driver_key` 键值（保留）；`exposure_key` 键值（保留）；`causal_direction` 业务字段（保留）。
  - `period_kind` 业务字段（保留）；`numeric_value` 业务字段（保留）；`currency` 币种（保留）；`amount_scale` 业务字段（保留）；`document_version_id` 关联主键（保留）。
  - `validity_status` 状态字段（保留）；`superseded_by_document_id` 关联主键（保留）；`related_security_code` 代码字段（保留）；`security_relationship_kind` 业务字段（保留）；`related_shares_per_security` 业务字段（保留）。
  - `measurement_basis` 业务字段（保留）。

### research_auto_filing_financial_profiles
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-financial-profile.ts`、`src/modules/research/application/research-auto-filing-insights.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `auto_financial_profile_id` 关联主键（保留）；`source_filing_fact_input_id` 关联主键（保留）；`security_code` 证券代码（保留）；`operating_company_id` 关联主键（保留）；`entity_type` 业务字段（保留）。
  - `as_of` as-of 时间（保留）；`source_url` 来源 URL（保留）；`source_title` 业务字段（保留）；`source_note` 业务字段（保留）；`evidence_quote` 业务字段（保留）。
  - `evidence_locator` 业务字段（保留）；`extraction_method` 业务字段（保留）；`prompt_version` Prompt 版本（保留）；`model` 模型（保留）；`processed_at` 时间戳（保留）。
  - `materialized_at` 时间戳（保留）。

### research_auto_filing_financial_specialty_facts
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-auto-filing-insights.ts`、`src/modules/research/application/research-financial-specialty-metrics.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `auto_financial_specialty_fact_id` 关联主键（保留）；`auto_financial_profile_id` 关联主键（保留）；`source_filing_fact_input_id` 关联主键（保留）；`security_code` 证券代码（保留）；`operating_company_id` 关联主键（保留）。
  - `entity_type` 业务字段（保留）；`metric_key` 键值（保留）；`reported_label` 业务字段（保留）；`reported_value` 业务字段（保留）；`value_number` 业务字段（保留）。
  - `unit` 单位（保留）；`currency` 币种（保留）；`amount_scale` 业务字段（保留）；`as_of` as-of 时间（保留）；`period_label` 业务字段（保留）。
  - `definition_note` 业务字段（保留）；`comparability_note` 业务字段（保留）；`statement` 陈述文本（保留）；`source_url` 来源 URL（保留）；`source_title` 业务字段（保留）。
  - `evidence_quote` 业务字段（保留）；`evidence_locator` 业务字段（保留）；`extraction_method` 业务字段（保留）；`prompt_version` Prompt 版本（保留）；`model` 模型（保留）。
  - `processed_at` 时间戳（保留）；`materialized_at` 时间戳（保留）。

### research_auto_filing_insights
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-auto-filing-insights.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `insight_id` 关联主键（保留）；`security_code` 证券代码（保留）；`registry` 业务字段（保留）；`statutory_document_id` 关联主键（保留）；`document_url` 引用 URL（保留）。
  - `tab_id` 关联主键（保留）；`fact_key` 键值（保留）；`title` 标题（保留）；`statement` 陈述文本（保留）；`reported_value` 业务字段（保留）。
  - `report_period` 业务字段（保留）；`evidence_quote` 业务字段（保留）；`evidence_locator` 业务字段（保留）；`extraction_method` 业务字段（保留）；`prompt_version` Prompt 版本（保留）。
  - `model` 模型（保留）；`processed_at` 时间戳（保留）；`created_at` 创建时间（保留）；`fact_type` 业务字段（保留）；`value_type` 业务字段（保留）。
  - `unit` 单位（保留）；`subject_label` 业务字段（保留）；`segment_label` 业务字段（保留）；`geography_label` 业务字段（保留）；`customer_or_channel` 业务字段（保留）。
  - `driver_key` 键值（保留）；`exposure_key` 键值（保留）；`causal_direction` 业务字段（保留）；`period_kind` 业务字段（保留）；`numeric_value` 业务字段（保留）。
  - `currency` 币种（保留）；`amount_scale` 业务字段（保留）；`related_security_code` 代码字段（保留）；`security_relationship_kind` 业务字段（保留）；`related_shares_per_security` 业务字段（保留）。
  - `measurement_basis` 业务字段（保留）。

### research_auto_filing_module_rebuilds
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-auto-filing-insights.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `rebuild_id` 关联主键（保留）；`security_code` 证券代码（保留）；`target_module` 业务字段（保留）；`source_signature` 业务字段（保留）；`source_document_count` 业务字段（保留）。
  - `source_fact_count` 业务字段（保留）；`latest_processed_at` 时间戳（保留）；`change_reason` 原因/说明（保留）；`rebuilt_at` 时间戳（保留）。

### research_auto_filing_recompute_events
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-auto-filing-insights.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `recompute_event_id` 关联主键（保留）；`security_code` 证券代码（保留）；`statutory_document_id` 关联主键（保留）；`target_module` 业务字段（保留）；`reason` 原因/说明（保留）。
  - `status` 状态（保留）；`created_at` 创建时间（保留）。

### research_auto_risk_snapshots
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-auto-filing-insights.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `auto_risk_snapshot_id` 关联主键（保留）；`security_code` 证券代码（保留）；`source_signature` 业务字段（保留）；`source_document_ids_json` JSON 载荷（保留）；`items_json` JSON 载荷（保留）。
  - `as_of` as-of 时间（保留）；`created_at` 创建时间（保留）。

### research_business_models
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-dossier.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `business_model_id` 关联主键（保留）；`company_id` 公司 ID（保留）；`as_of` as-of 时间（保留）；`status` 状态（保留）；`primary_earning_driver` 业务字段（保留）。
  - `revenue_recognition` 业务字段（保留）；`summary` 摘要（保留）；`source_type` 业务字段（保留）；`source_refs_json` JSON 载荷（保留）；`created_at` 创建时间（保留）。
  - `updated_at` 更新时间（保留）。

### research_business_segments
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-dossier.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `segment_id` 关联主键（保留）；`business_model_id` 关联主键（保留）；`name` 名称（保留）；`revenue_driver` 业务字段（保留）；`customer_scope` 业务字段（保留）。
  - `geographic_scope` 业务字段（保留）；`pricing_model` 业务字段（保留）；`cost_driver` 业务字段（保留）；`working_capital_driver` 业务字段（保留）；`capital_intensity_driver` 业务字段（保留）。
  - `source_refs_json` JSON 载荷（保留）；`sort_order` 排序（保留）。

### research_catalyst_reviews
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-catalyst-review.ts`、`src/modules/research/application/guidance-event-impact-reviews.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `catalyst_review_id` 关联主键（保留）；`catalyst_id` 关联主键（保留）；`company_id` 公司 ID（保留）；`security_code` 证券代码（保留）；`as_of` as-of 时间（保留）。
  - `review_status` 状态字段（保留）；`outcome_summary` 业务字段（保留）；`expected_vs_actual` 业务字段（保留）；`impacted_assumption_status` 状态字段（保留）；`next_action` 业务字段（保留）。
  - `source_refs_json` JSON 载荷（保留）；`reviewed_at` 审核时间（保留）；`created_at` 创建时间（保留）。

### research_catalysts
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-catalyst-review.ts`、`src/modules/research/application/research-dossier.ts`、`src/modules/research/application/research-company-focus-profile.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `catalyst_id` 关联主键（保留）；`company_id` 公司 ID（保留）；`security_code` 证券代码（保留）；`event_at` 时间戳（保留）；`event_type` 事件类型（保留）。
  - `title` 标题（保留）；`status` 状态（保留）；`impacted_assumption` 业务字段（保留）；`expected_effect` 业务字段（保留）；`outcome_note` 业务字段（保留）。
  - `source_refs_json` JSON 载荷（保留）；`created_at` 创建时间（保留）；`updated_at` 更新时间（保留）。

### research_company_financial_profiles
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-financial-profile.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `financial_profile_id` 关联主键（保留）；`company_id` 公司 ID（保留）；`source_security_code` 代码字段（保留）；`entity_type` 业务字段（保留）；`as_of` as-of 时间（保留）。
  - `source_authority` 业务字段（保留）；`source_url` 来源 URL（保留）；`source_title` 业务字段（保留）；`source_note` 业务字段（保留）；`recorded_by` 业务字段（保留）。
  - `recorded_at` 时间戳（保留）；`created_at` 创建时间（保留）。

### research_company_focus_memberships
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-company-focus-profile.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `membership_id` 关联主键（保留）；`owner_key` 用户/owner 键（保留）；`company_id` 公司 ID（保留）；`status` 状态（保留）；`supersedes_membership_id` 关联主键（保留）。
  - `created_at` 创建时间（保留）。

### research_company_focus_profile_items
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-company-focus-profile.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `focus_item_id` 关联主键（保留）；`focus_profile_id` 关联主键（保留）；`role` 角色（保留）；`target_kind` 业务字段（保留）；`target_id` 目标 ID（保留）。
  - `security_code` 证券代码（保留）；`sort_order` 排序（保留）；`created_at` 创建时间（保留）。

### research_company_focus_profile_versions
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-company-focus-profile.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `focus_profile_id` 关联主键（保留）；`company_id` 公司 ID（保留）；`version` 版本字段（保留）；`supersedes_focus_profile_id` 关联主键（保留）；`as_of` as-of 时间（保留）。
  - `status` 状态（保留）；`title` 标题（保留）；`review_by` 业务字段（保留）；`epistemic_type` 业务字段（保留）；`created_at` 创建时间（保留）。

### research_company_industry_exposures
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-industry-profile.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `exposure_id` 关联主键（保留）；`company_id` 公司 ID（保留）；`industry_profile_id` 关联主键（保留）；`as_of` as-of 时间（保留）；`version` 版本字段（保留）。
  - `status` 状态（保留）；`selection_basis` 业务字段（保留）；`primary_business_description` 业务字段（保留）；`exposure_scope_json` JSON 载荷（保留）；`exposure_share_json` JSON 载荷（保留）。
  - `epistemic_type` 业务字段（保留）；`source_refs_json` JSON 载荷（保留）；`created_at` 创建时间（保留）；`updated_at` 更新时间（保留）。

### research_company_security_relationships
- 现状：本地 8 行；主要 owner/引用：`src/modules/research/application/research-identity.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：当前代码仍在使用；如果未来要收缩 schema，应优先从重复任务账本和无入口空表下手。
- 字段：
  - `relationship_id` 关联主键（保留）；`company_id` 公司 ID（保留）；`security_code` 证券代码（保留）；`relationship_type` 业务字段（保留）；`relationship_status` 状态字段（保留）。
  - `source_url` 来源 URL（保留）；`source_note` 业务字段（保留）；`effective_from` 业务字段（保留）；`effective_to` 业务字段（保留）；`metadata_json` 任务元数据（保留）。
  - `created_at` 创建时间（保留）；`updated_at` 更新时间（保留）。

### research_company_track_exposure_shares
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-industry-comparability.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `exposure_share_id` 关联主键（保留）；`company_track_exposure_id` 关联主键（保留）；`measure` 业务字段（保留）；`value` 数值（保留）；`unit` 单位（保留）。
  - `basis_period` 业务字段（保留）；`denominator_description` 业务字段（保留）；`sort_order` 排序（保留）。

### research_company_track_exposures
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-industry-comparability.ts`、`src/modules/research/application/research-company-focus-profile.ts`、`src/modules/research/application/research-industry-kpi-transmission.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `company_track_exposure_id` 关联主键（保留）；`company_id` 公司 ID（保留）；`track_profile_id` 关联主键（保留）；`as_of` as-of 时间（保留）；`version` 版本字段（保留）。
  - `status` 状态（保留）；`selection_basis` 业务字段（保留）；`business_segment` 业务字段（保留）；`product_scope` 业务字段（保留）；`geographic_scope` 业务字段（保留）。
  - `customer_scope` 业务字段（保留）；`exposure_description` 业务字段（保留）；`epistemic_type` 业务字段（保留）；`created_at` 创建时间（保留）；`updated_at` 更新时间（保留）。

### research_competitive_markets
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-dossier.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `competitive_market_id` 关联主键（保留）；`company_id` 公司 ID（保留）；`as_of` as-of 时间（保留）；`status` 状态（保留）；`definition` 业务字段（保留）。
  - `product_scope` 业务字段（保留）；`customer_scope` 业务字段（保留）；`geography_scope` 业务字段（保留）；`period_scope` 业务字段（保留）；`structure_json` 结构 JSON（保留）。
  - `advantage_json` JSON 载荷（保留）；`erosion_paths_json` JSON 载荷（保留）；`source_type` 业务字段（保留）；`source_refs_json` JSON 载荷（保留）；`created_at` 创建时间（保留）。
  - `updated_at` 更新时间（保留）。

### research_competitors
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-dossier.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `competitor_id` 关联主键（保留）；`competitive_market_id` 关联主键（保留）；`name` 名称（保留）；`security_code` 证券代码（保留）；`competitor_type` 业务字段（保留）。
  - `comparability_note` 业务字段（保留）；`metrics_json` JSON 载荷（保留）；`source_refs_json` JSON 载荷（保留）。

### research_dossiers
- 现状：本地 0 行；主要 owner/引用：源码无直接引用。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：强删除/归档候选：当前代码不再引用，或已被新表取代。删除前只需确认是否还有离线脚本直接读它。
- 字段：
  - `dossier_id`、`company_id`、`security_code`、`created_at`、`updated_at` 只是占位头表；当前 loader 并不依赖它，建议删除。

### research_financial_analysis_results
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-financial-analysis.ts`。
- 页面/功能：`company-finance.html` 的“财务分析”结果卡片。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `security_code` 证券代码（保留）；`input_fingerprint` 输入指纹（保留）；`prompt_version` Prompt 版本（保留）；`snapshot_json` JSON 载荷（保留）；`markdown` 业务字段（保留）。
  - `citations_json` JSON 载荷（保留）；`sources_json` JSON 载荷（保留）；`terminal_evidence_json` JSON 载荷（保留）；`projected_at` 时间戳（保留）。

### research_financial_availability_observations
- 现状：本地 3 行；主要 owner/引用：`src/modules/research/application/research-identity.ts`、`src/modules/research/application/research-auto-filing-insights.ts`、`src/modules/research/application/research-fx-bridge.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：当前代码仍在使用；如果未来要收缩 schema，应优先从重复任务账本和无入口空表下手。
- 字段：
  - `observation_id` 关联主键（保留）；`security_code` 证券代码（保留）；`statement_type` 业务字段（保留）；`provider` 执行提供方（保留）；`source_role` 业务字段（保留）。
  - `availability_status` 状态字段（保留）；`as_of` as-of 时间（保留）；`latest_period` 业务字段（保留）；`reporting_currency` 业务字段（保留）；`accounting_basis` 业务字段（保留）。
  - `source_url` 来源 URL（保留）；`blocking_reason` 原因/说明（保留）；`details_json` 细节 JSON（保留）；`created_at` 创建时间（保留）。

### research_financial_specialty_fact_versions
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-company-focus-profile.ts`、`src/modules/research/application/research-financial-specialty-metrics.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `financial_specialty_fact_id` 关联主键（保留）；`financial_profile_id` 关联主键（保留）；`company_id` 公司 ID（保留）；`security_code` 证券代码（保留）；`evidence_reference_id` 关联主键（保留）。
  - `candidate_id` 候选 ID（保留）；`candidate_review_id` 关联主键（保留）；`entity_type` 业务字段（保留）；`metric_key` 键值（保留）；`reported_label` 业务字段（保留）。
  - `reported_value` 业务字段（保留）；`value_number` 业务字段（保留）；`unit` 单位（保留）；`currency` 币种（保留）；`amount_scale` 业务字段（保留）。
  - `as_of` as-of 时间（保留）；`period_label` 业务字段（保留）；`definition_note` 业务字段（保留）；`comparability_note` 业务字段（保留）；`statement` 陈述文本（保留）。
  - `source_url` 来源 URL（保留）；`content_url` 内容 URL（保留）；`source_title` 业务字段（保留）；`source_name` 业务字段（保留）；`published_at` 发布时间（保留）。
  - `source_locator` 业务字段（保留）；`metric_config_version` 版本字段（保留）；`recorded_by` 业务字段（保留）；`recorded_at` 时间戳（保留）；`created_at` 创建时间（保留）。

### research_financial_statutory_verifications
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/financial-statutory-verification.ts`、`src/modules/research/application/formal-actual-candidates.ts`、`src/modules/research/application/research-financials.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `verification_id` 关联主键（保留）；`security_code` 证券代码（保留）；`normalized_fact_id` 关联主键（保留）；`metric` 业务字段（保留）；`period_kind` 业务字段（保留）。
  - `period_start_date` 业务字段（保留）；`period_end_date` 业务字段（保留）；`fiscal_year` 业务字段（保留）；`fiscal_quarter` 业务字段（保留）；`normalized_value` 业务字段（保留）。
  - `normalized_basis_id` 关联主键（保留）；`normalized_currency` 业务字段（保留）；`normalized_accounting_standard` 业务字段（保留）；`normalized_scope` 业务字段（保留）；`normalized_revision` 业务字段（保留）。
  - `primary_source_id` 关联主键（保留）；`primary_source_type` 业务字段（保留）；`primary_document_id` 关联主键（保留）；`primary_source_url` 引用 URL（保留）；`primary_locator` 业务字段（保留）。
  - `primary_published_at` 时间戳（保留）；`statutory_provider` 业务字段（保留）；`outcome` 结果类型（保留）；`statutory_value` 业务字段（保留）；`statutory_basis_id` 关联主键（保留）。
  - `statutory_currency` 业务字段（保留）；`statutory_accounting_standard` 业务字段（保留）；`statutory_scope` 业务字段（保留）；`statutory_revision` 业务字段（保留）；`statutory_document_id` 关联主键（保留）。
  - `statutory_disclosure_url` 引用 URL（保留）；`statutory_locator` 业务字段（保留）；`statutory_published_at` 时间戳（保留）；`statutory_report_date` 业务字段（保留）；`comparison_rule_version` 版本字段（保留）。
  - `absolute_tolerance` 业务字段（保留）；`relative_tolerance` 业务字段（保留）；`absolute_delta` 业务字段（保留）；`relative_delta` 业务字段（保留）；`reason_codes_json` JSON 载荷（保留）。
  - `metadata_json` 任务元数据（保留）；`observed_at` 观测时间（保留）；`created_at` 创建时间（保留）；`canonical_comparison_key` 键值（保留）。

### research_forecast_actual_calibration_records
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/formal-actual-candidates.ts`、`src/modules/research/application/forecast-actual-calibration.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `calibration_id` 关联主键（保留）；`security_code` 证券代码（保留）；`company_id` 公司 ID（保留）；`forecast_kind` 业务字段（保留）；`forecast_id` 关联主键（保留）。
  - `actual_id` 关联主键（保留）；`metric` 业务字段（保留）；`fiscal_period` 业务字段（保留）；`currency` 币种（保留）；`normalized_unit` 业务字段（保留）。
  - `accounting_basis` 业务字段（保留）；`ownership_basis` 业务字段（保留）；`share_basis` 业务字段（保留）；`forecast_normalized_value` 业务字段（保留）；`actual_normalized_value` 业务字段（保留）。
  - `absolute_error` 业务字段（保留）；`percentage_error` 业务字段（保留）；`comparability_status` 状态字段（保留）；`comparability_reason` 原因/说明（保留）；`calibrated_at` 时间戳（保留）。

### research_forecast_calibrations
- 现状：本地 0 行；主要 owner/引用：源码无直接引用。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：强删除/归档候选：当前代码不再引用，或已被新表取代。删除前只需确认是否还有离线脚本直接读它。
- 字段：
  - `calibration_id` 主键；`forecast_id`、`actual_period`、`actual_value`、`actual_unit`、`actual_currency`、`actual_source`、`absolute_error`、`percentage_error`、`comparability_status`、`comparability_notes`、`created_at` 用于旧版预测校准。已被 `research_forecast_actual_calibration_records` 取代，建议删除。

### research_forecast_consolidation_groups
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/forecast-ledger.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `group_id` 关联主键（保留）；`consolidation_id` 关联主键（保留）；`comparison_key` 键值（保留）；`metric` 业务字段（保留）；`fiscal_year` 业务字段（保留）。
  - `currency` 币种（保留）；`normalized_unit` 业务字段（保留）；`accounting_basis` 业务字段（保留）；`ownership_basis` 业务字段（保留）；`share_basis` 业务字段（保留）。
  - `sample_count` 业务字段（保留）；`median_value` 业务字段（保留）；`mean_value` 业务字段（保留）；`min_value` 业务字段（保留）；`max_value` 业务字段（保留）。
  - `standard_deviation` 业务字段（保留）；`created_at` 创建时间（保留）。

### research_forecast_consolidation_members
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/forecast-ledger.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `consolidation_id` 关联主键（保留）；`forecast_id` 关联主键（保留）；`comparison_key` 键值（保留）；`membership_status` 状态字段（保留）；`reason_code` 原因码（保留）。
  - `created_at` 创建时间（保留）；`source_identity_id` 关联主键（保留）；`independence_group_id` 关联主键（保留）；`source_identity_assertion_id` 关联主键（保留）；`origin_source_identity_id` 关联主键（保留）。
  - `carrier_source_identity_id` 关联主键（保留）；`carrier_relation` 业务字段（保留）；`model_lineage_id` 关联主键（保留）。

### research_forecast_consolidations
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/forecast-ledger.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `consolidation_id` 关联主键（保留）；`security_code` 证券代码（保留）；`company_id` 公司 ID（保留）；`as_of` as-of 时间（保留）；`label` 业务字段（保留）。
  - `source_universe` 业务字段（保留）；`market_consensus` 业务字段（保留）；`rule_version` 规则版本（保留）；`created_at` 创建时间（保留）。

### research_forecast_model_lineages
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/forecast-ledger.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `model_lineage_id` 关联主键（保留）；`origin_source_identity_id` 关联主键（保留）；`lineage_name` 业务字段（保留）；`evidence_url` 引用 URL（保留）；`evidence_title` 业务字段（保留）。
  - `evidence_doc_id` 关联主键（保留）；`lineage_status` 状态字段（保留）；`created_by` 业务字段（保留）；`created_at` 创建时间（保留）。

### research_forecast_scenarios
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/forecast-ledger.ts`、`src/modules/research/application/formal-actual-candidates.ts`、`src/modules/research/application/guidance-event-impact-reviews.ts`、`src/modules/research/application/research-auto-filing-insights.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `scenario_id` 关联主键（保留）；`security_code` 证券代码（保留）；`company_id` 公司 ID（保留）；`scenario_name` 业务字段（保留）；`version` 版本字段（保留）。
  - `assumptions_json` JSON 载荷（保留）；`outputs_json` JSON 载荷（保留）；`evidence_refs_json` JSON 载荷（保留）；`status` 状态（保留）；`created_at` 创建时间（保留）。
  - `updated_at` 更新时间（保留）。

### research_forecast_source_identities
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/forecast-ledger.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `source_identity_id` 关联主键（保留）；`display_name` 展示名（保留）；`identity_type` 业务字段（保留）；`independence_group_id` 关联主键（保留）；`evidence_url` 引用 URL（保留）。
  - `evidence_title` 业务字段（保留）；`evidence_doc_id` 关联主键（保留）；`identity_status` 状态字段（保留）；`created_by` 业务字段（保留）；`created_at` 创建时间（保留）。

### research_forecast_source_identity_assertions
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/forecast-ledger.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `source_identity_assertion_id` 关联主键（保留）；`doc_id` 文档 ID（保留）；`version_id` 版本 ID（保留）；`content_hash` 内容哈希（保留）；`carrier_source_identity_id` 关联主键（保留）。
  - `origin_source_identity_id` 关联主键（保留）；`model_lineage_id` 关联主键（保留）；`carrier_relation` 业务字段（保留）；`evidence_url` 引用 URL（保留）；`evidence_title` 业务字段（保留）。
  - `evidence_doc_id` 关联主键（保留）；`assertion_status` 状态字段（保留）；`created_by` 业务字段（保留）；`created_at` 创建时间（保留）。

### research_forecast_source_independence_groups
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/forecast-ledger.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `independence_group_id` 关联主键（保留）；`canonical_name` 业务字段（保留）；`status` 状态（保留）；`created_by` 业务字段（保留）；`created_at` 创建时间（保留）。

### research_forecast_source_reviews
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/forecast-ledger.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `review_id` 关联主键（保留）；`security_code` 证券代码（保留）；`company_id` 公司 ID（保留）；`information_id` 信息 ID（保留）；`current_forecast_id` 关联主键（保留）。
  - `review_status` 状态字段（保留）；`review_reason` 原因/说明（保留）；`reviewed_by` 业务字段（保留）；`reviewed_at` 审核时间（保留）；`created_at` 创建时间（保留）。
  - `updated_at` 更新时间（保留）。

### research_forecast_synthesis_drafts
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/forecast-ledger.ts`、`src/modules/research/application/forecast-synthesis.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `draft_id` 关联主键（保留）；`security_code` 证券代码（保留）；`company_id` 公司 ID（保留）；`consolidation_id` 关联主键（保留）；`model` 模型（保留）。
  - `prompt_version` Prompt 版本（保留）；`content_markdown` 业务字段（保留）；`source_forecast_ids_json` JSON 载荷（保留）；`created_at` 创建时间（保留）。

### research_formal_actual_candidate_dictionary_bindings
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/formal-actual-candidates.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `candidate_id` 候选 ID（保留）；`fact_dictionary_entry_id` 关联主键（保留）；`fact_dictionary_version` 版本字段（保留）；`bound_at` 时间戳（保留）。

### research_formal_actual_candidate_reviews
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/guidance-event-impact-reviews.ts`、`src/modules/research/application/formal-actual-candidates.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `review_id` 关联主键（保留）；`candidate_id` 候选 ID（保留）；`decision` 业务字段（保留）；`reviewer` 业务字段（保留）；`reason` 原因/说明（保留）。
  - `accounting_basis` 业务字段（保留）；`ownership_basis` 业务字段（保留）；`share_basis` 业务字段（保留）；`actual_id` 关联主键（保留）；`reviewed_at` 审核时间（保留）。
  - `created_at` 创建时间（保留）。

### research_formal_actual_candidates
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/formal-actual-candidates.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `candidate_id` 候选 ID（保留）；`security_code` 证券代码（保留）；`verification_id` 关联主键（保留）；`metric` 业务字段（保留）；`forecast_metric` 业务字段（保留）。
  - `fiscal_year` 业务字段（保留）；`fiscal_period` 业务字段（保留）；`period_start_date` 业务字段（保留）；`period_end_date` 业务字段（保留）；`reported_value` 业务字段（保留）。
  - `reported_unit` 业务字段（保留）；`currency` 币种（保留）；`statutory_provider` 业务字段（保留）；`statutory_document_id` 关联主键（保留）；`statutory_disclosure_url` 引用 URL（保留）。
  - `statutory_locator` 业务字段（保留）；`statutory_published_at` 时间戳（保留）；`statutory_report_date` 业务字段（保留）；`source_binding_json` JSON 载荷（保留）；`candidate_rule_version` 版本字段（保留）。
  - `eligibility` 业务字段（保留）；`blocking_reason` 原因/说明（保留）；`created_at` 创建时间（保留）；`canonical_comparison_key` 键值（保留）。

### research_formal_actuals
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/forecast-actual-calibration.ts`、`src/modules/research/application/guidance-event-impact-reviews.ts`、`src/modules/research/application/formal-actual-candidates.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `actual_id` 关联主键（保留）；`security_code` 证券代码（保留）；`company_id` 公司 ID（保留）；`metric` 业务字段（保留）；`fiscal_year` 业务字段（保留）。
  - `fiscal_period` 业务字段（保留）；`raw_value` 业务字段（保留）；`raw_unit` 业务字段（保留）；`currency` 币种（保留）；`accounting_basis` 业务字段（保留）。
  - `ownership_basis` 业务字段（保留）；`share_basis` 业务字段（保留）；`normalized_value` 业务字段（保留）；`normalized_unit` 业务字段（保留）；`normalization_status` 状态字段（保留）。
  - `normalization_notes` 业务字段（保留）；`actual_status` 状态字段（保留）；`revision_number` 业务字段（保留）；`supersedes_actual_id` 关联主键（保留）；`restatement_note` 业务字段（保留）。
  - `filed_at` 时间戳（保留）；`source_statement` 业务字段（保留）；`source_refs_json` JSON 载荷（保留）；`created_at` 创建时间（保留）。

### research_governance_capital_fact_candidate_reviews
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-governance-capital-facts.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `candidate_review_id` 关联主键（保留）；`candidate_id` 候选 ID（保留）；`decision` 业务字段（保留）；`review_note` 业务字段（保留）；`reviewed_by` 业务字段（保留）。
  - `reviewed_at` 审核时间（保留）；`created_at` 创建时间（保留）。

### research_governance_capital_fact_candidates
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-governance-capital-facts.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `candidate_id` 候选 ID（保留）；`security_code` 证券代码（保留）；`information_id` 信息 ID（保留）；`result_id` 结果 ID（保留）；`run_id` 运行 ID（保留）。
  - `version_id` 版本 ID（保留）；`content_hash` 内容哈希（保留）；`doc_id` 文档 ID（保留）；`entity` 实体（保留）；`information_type` 信息类型（保留）。
  - `category` 分类（保留）；`period` 期间（保留）；`statement` 陈述文本（保留）；`fact_key` 键值（保留）；`required_fields_json` JSON 载荷（保留）。
  - `source_url` 来源 URL（保留）；`content_url` 内容 URL（保留）；`title` 标题（保留）；`source_name` 业务字段（保留）；`published_at` 发布时间（保留）。
  - `mapping_config_version` 版本字段（保留）；`created_at` 创建时间（保留）。

### research_governance_capital_fact_versions
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-company-focus-profile.ts`、`src/modules/research/application/research-governance-capital-facts.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `governance_capital_fact_version_id` 关联主键（保留）；`candidate_review_id` 关联主键（保留）；`supersedes_fact_version_id` 关联主键（保留）；`company_id` 公司 ID（保留）；`security_code` 证券代码（保留）。
  - `fact_key` 键值（保留）；`fact_status` 状态字段（保留）；`value_kind` 业务字段（保留）；`value_number` 业务字段（保留）；`value_range_lower` 业务字段（保留）。
  - `value_range_upper` 业务字段（保留）；`value_text` 业务字段（保留）；`unit` 单位（保留）；`as_of` as-of 时间（保留）；`period` 期间（保留）。
  - `source_authority` 业务字段（保留）；`information_id` 信息 ID（保留）；`result_id` 结果 ID（保留）；`run_id` 运行 ID（保留）；`version_id` 版本 ID（保留）。
  - `content_hash` 内容哈希（保留）；`doc_id` 文档 ID（保留）；`source_url` 来源 URL（保留）；`content_url` 内容 URL（保留）；`source_title` 业务字段（保留）。
  - `source_name` 业务字段（保留）；`published_at` 发布时间（保留）；`source_locator` 业务字段（保留）；`created_at` 创建时间（保留）。

### research_governance_records
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-governance.ts`、`src/modules/research/application/research-company-focus-profile.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `governance_record_id` 关联主键（保留）；`company_id` 公司 ID（保留）；`as_of` as-of 时间（保留）；`dimension` 业务字段（保留）；`title` 标题（保留）。
  - `statement` 陈述文本（保留）；`status` 状态（保留）；`epistemic_type` 业务字段（保留）；`source_refs_json` JSON 载荷（保留）；`created_at` 创建时间（保留）。
  - `updated_at` 更新时间（保留）。

### research_guidance_event_impact_review_target_actions
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/guidance-event-impact-reviews.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `action_id` 关联主键（保留）；`impact_review_target_id` 关联主键（保留）；`previous_state` 业务字段（保留）；`decision` 业务字段（保留）；`rationale` 业务字段（保留）。
  - `acted_by` 业务字段（保留）；`follow_up_target_id` 关联主键（保留）；`acted_at` 时间戳（保留）。

### research_guidance_event_impact_review_targets
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/guidance-event-impact-reviews.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `impact_review_target_id` 关联主键（保留）；`impact_review_id` 关联主键（保留）；`target_kind` 业务字段（保留）；`target_id` 目标 ID（保留）；`review_state` 业务字段（保留）。
  - `created_at` 创建时间（保留）。

### research_guidance_event_impact_reviews
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/guidance-event-impact-reviews.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `impact_review_id` 关联主键（保留）；`security_code` 证券代码（保留）；`company_id` 公司 ID（保留）；`source_kind` 业务字段（保留）；`source_id` 来源 ID（保留）。
  - `source_observed_at` 时间戳（保留）；`reviewer` 业务字段（保留）；`rationale` 业务字段（保留）；`source_binding_json` JSON 载荷（保留）；`created_at` 创建时间（保留）。

### research_industry_comparability_evidence_refs
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-industry-comparability.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `evidence_ref_id` 关联主键（保留）；`subject_type` 主体类型（保留）；`subject_id` 主体 ID（保留）；`source_kind` 业务字段（保留）；`source_id` 来源 ID（保留）。
  - `information_id` 信息 ID（保留）；`version_id` 版本 ID（保留）；`document_id` 关联主键（保留）；`url` 来源 URL（保留）；`title` 标题（保留）。
  - `published_at` 发布时间（保留）；`locator` 业务字段（保留）；`created_at` 创建时间（保留）。

### research_industry_kpi_driver_bindings
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-company-focus-profile.ts`、`src/modules/research/application/research-industry-kpi-transmission.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `industry_kpi_driver_binding_id` 关联主键（保留）；`security_code` 证券代码（保留）；`evidence_reference_id` 关联主键（保留）；`company_track_exposure_id` 关联主键（保留）；`industry_kpi_id` 关联主键（保留）。
  - `operating_driver_plan_id` 关联主键（保留）；`operating_driver_segment_year_id` 关联主键（保留）；`transmission_rule_id` 关联主键（保留）；`mapping_config_version` 版本字段（保留）；`input_value` 业务字段（保留）。
  - `input_unit` 业务字段（保留）；`mapping_note` 业务字段（保留）；`mapped_by` 业务字段（保留）；`mapped_at` 时间戳（保留）；`created_at` 创建时间（保留）。

### research_industry_profiles
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-industry-profile.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `industry_profile_id` 关联主键（保留）；`industry_key` 键值（保留）；`taxonomy` 业务字段（保留）；`taxonomy_version` 版本字段（保留）；`industry_name` 业务字段（保留）。
  - `parent_industry_key` 键值（保留）；`as_of` as-of 时间（保留）；`version` 版本字段（保留）；`status` 状态（保留）；`definition` 业务字段（保留）。
  - `demand_drivers_json` JSON 载荷（保留）；`supply_structure_json` JSON 载荷（保留）；`cycle_characteristics_json` JSON 载荷（保留）；`value_chain_json` JSON 载荷（保留）；`epistemic_type` 业务字段（保留）。
  - `source_refs_json` JSON 载荷（保留）；`created_at` 创建时间（保留）；`updated_at` 更新时间（保留）。

### research_industry_source_series_observations
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-industry-source-series.ts`、`src/modules/research/application/research-auto-filing-insights.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `industry_series_observation_id` 关联主键（保留）；`security_code` 证券代码（保留）；`industry_key` 键值（保留）；`metric_key` 键值（保留）；`metric_label` 业务字段（保留）。
  - `period_label` 业务字段（保留）；`numeric_value` 业务字段（保留）；`unit` 单位（保留）；`currency` 币种（保留）；`amount_scale` 业务字段（保留）。
  - `geographic_scope` 业务字段（保留）；`product_scope` 业务字段（保留）；`statistical_method` 业务字段（保留）；`source_doc_id` 关联主键（保留）；`source_url` 来源 URL（保留）。
  - `source_title` 业务字段（保留）；`source_authority` 业务字段（保留）；`evidence_quote` 业务字段（保留）；`evidence_locator` 业务字段（保留）；`extraction_method` 业务字段（保留）。
  - `prompt_version` Prompt 版本（保留）；`model` 模型（保留）；`processed_at` 时间戳（保留）；`created_at` 创建时间（保留）。

### research_industry_track_demand_drivers
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-industry-comparability.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `driver_id` 关联主键（保留）；`track_profile_id` 关联主键（保留）；`driver_kind` 业务字段（保留）；`label` 业务字段（保留）；`definition` 业务字段（保留）。
  - `indicator_name` 业务字段（保留）；`indicator_frequency` 业务字段（保留）；`leading_lagging` 业务字段（保留）；`financial_transmission` 业务字段（保留）；`sort_order` 排序（保留）。

### research_industry_track_kpis
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/api/research.routes.ts`、`src/modules/research/application/research-company-focus-profile.ts`、`src/modules/research/application/research-industry-kpi-transmission.ts`、`src/modules/research/application/research-industry-comparability.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `kpi_id` 关联主键（保留）；`track_profile_id` 关联主键（保留）；`name` 名称（保留）；`definition` 业务字段（保留）；`unit` 单位（保留）。
  - `frequency` 频率（保留）；`timing_role` 业务字段（保留）；`financial_mapping` 业务字段（保留）；`sort_order` 排序（保留）。

### research_industry_track_profiles
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-industry-comparability.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `track_profile_id` 关联主键（保留）；`industry_key` 键值（保留）；`taxonomy` 业务字段（保留）；`taxonomy_version` 版本字段（保留）；`industry_name` 业务字段（保留）。
  - `parent_industry_key` 键值（保留）；`as_of` as-of 时间（保留）；`version` 版本字段（保留）；`status` 状态（保留）；`boundary_included` 业务字段（保留）。
  - `boundary_excluded` 业务字段（保留）；`demand_equation` 业务字段（保留）；`supply_equation` 业务字段（保留）；`cycle_position` 业务字段（保留）；`valuation_primary_method` 业务字段（保留）。
  - `valuation_limitations` 业务字段（保留）；`epistemic_type` 业务字段（保留）；`created_at` 创建时间（保留）；`updated_at` 更新时间（保留）。

### research_industry_track_supply_constraints
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-industry-comparability.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `constraint_id` 关联主键（保留）；`track_profile_id` 关联主键（保留）；`constraint_kind` 业务字段（保留）；`label` 业务字段（保留）；`description` 业务字段（保留）。
  - `affected_variable` 业务字段（保留）；`direction_when_binding` 业务字段（保留）；`sort_order` 排序（保留）。

### research_industry_track_value_chain_nodes
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-industry-comparability.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `value_chain_node_id` 关联主键（保留）；`track_profile_id` 关联主键（保留）；`node_role` 业务字段（保留）；`name` 名称（保留）；`description` 业务字段（保留）。
  - `revenue_recognition_role` 业务字段（保留）；`sort_order` 排序（保留）。

### research_information_evidence_candidate_reviews
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-information-evidence.ts`、`src/modules/research/application/research-financial-specialty-metrics.ts`、`src/modules/research/application/research-operating-source-facts.ts`、`src/modules/research/application/research-industry-kpi-transmission.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `candidate_review_id` 关联主键（保留）；`candidate_id` 候选 ID（保留）；`decision` 业务字段（保留）；`review_note` 业务字段（保留）；`reviewed_by` 业务字段（保留）。
  - `reviewed_at` 审核时间（保留）；`created_at` 创建时间（保留）。

### research_information_evidence_candidates
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-information-evidence.ts`、`src/modules/research/application/research-financial-specialty-metrics.ts`、`src/modules/research/application/research-operating-source-facts.ts`、`src/modules/research/application/research-industry-kpi-transmission.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `candidate_id` 候选 ID（保留）；`security_code` 证券代码（保留）；`information_id` 信息 ID（保留）；`result_id` 结果 ID（保留）；`run_id` 运行 ID（保留）。
  - `version_id` 版本 ID（保留）；`content_hash` 内容哈希（保留）；`doc_id` 文档 ID（保留）；`entity` 实体（保留）；`information_type` 信息类型（保留）。
  - `category` 分类（保留）；`period` 期间（保留）；`statement` 陈述文本（保留）；`target_module` 业务字段（保留）；`target_field` 业务字段（保留）。
  - `required_fields_json` JSON 载荷（保留）；`source_url` 来源 URL（保留）；`content_url` 内容 URL（保留）；`title` 标题（保留）；`source_name` 业务字段（保留）。
  - `published_at` 发布时间（保留）；`mapping_config_version` 版本字段（保留）；`created_at` 创建时间（保留）。

### research_investment_analysis_results
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-investment-analysis.ts`。
- 页面/功能：`investment-analysis.html` 的投资分析结果。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `security_code` 证券代码（保留）；`input_json` 输入快照（保留）；`markdown` 业务字段（保留）；`citations_json` JSON 载荷（保留）；`sources_json` JSON 载荷（保留）。
  - `terminal_evidence_json` JSON 载荷（保留）；`projected_at` 时间戳（保留）。

### research_listed_securities
- 现状：本地 7 行；主要 owner/引用：`src/modules/research/api/research.routes.ts`、`src/modules/research/application/forecast-ledger.ts`、`src/modules/research/application/research-company-scope.ts`、`src/modules/research/application/research-company-focus-profile.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：当前代码仍在使用；如果未来要收缩 schema，应优先从重复任务账本和无入口空表下手。
- 字段：
  - `security_code` 证券代码（保留）；`company_id` 公司 ID（保留）；`venue` 上市地（保留）；`trading_currency` 交易币种（保留）；`share_class` 股权类别（保留）。
  - `depositary_ratio` 存托凭证比例（保留）；`mapping_status` 映射状态（保留）；`mapping_basis` 映射依据（保留）；`metadata_json` 任务元数据（保留）；`created_at` 创建时间（保留）。
  - `updated_at` 更新时间（保留）。

### research_management_guidance_forecasts
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-auto-filing-insights.ts`、`src/modules/research/application/guidance-event-impact-reviews.ts`、`src/modules/research/application/formal-actual-candidates.ts`、`src/modules/research/application/forecast-actual-calibration.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `guidance_forecast_id` 关联主键（保留）；`security_code` 证券代码（保留）；`company_id` 公司 ID（保留）；`guidance_date` 业务字段（保留）；`metric` 业务字段（保留）。
  - `fiscal_year` 业务字段（保留）；`fiscal_period` 业务字段（保留）；`raw_value` 业务字段（保留）；`raw_unit` 业务字段（保留）；`currency` 币种（保留）。
  - `accounting_basis` 业务字段（保留）；`ownership_basis` 业务字段（保留）；`share_basis` 业务字段（保留）；`normalized_value` 业务字段（保留）；`normalized_unit` 业务字段（保留）。
  - `normalization_status` 状态字段（保留）；`normalization_notes` 业务字段（保留）；`guidance_conditions` 业务字段（保留）；`source_statement` 业务字段（保留）；`source_refs_json` JSON 载荷（保留）。
  - `supersedes_guidance_forecast_id` 关联主键（保留）；`created_at` 创建时间（保留）。

### research_market_profit_pools_typed
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-operating-market.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `market_profit_pool_id` 关联主键（保留）；`market_space_assessment_id` 关联主键（保留）；`period_label` 业务字段（保留）；`industry_revenue` 业务字段（保留）；`sustainable_operating_margin` 业务字段（保留）。
  - `currency` 币种（保留）；`amount_scale` 业务字段（保留）；`normalization_note` 业务字段（保留）；`status` 状态（保留）；`created_at` 创建时间（保留）。
  - `updated_at` 更新时间（保留）。

### research_market_share_bridge_steps_typed
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-operating-market.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `market_share_bridge_step_id` 关联主键（保留）；`market_share_bridge_id` 关联主键（保留）；`step_kind` 业务字段（保留）；`direction` 方向（保留）；`share_delta` 业务字段（保留）。
  - `description` 业务字段（保留）；`sort_order` 排序（保留）。

### research_market_share_bridges_typed
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-operating-market.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `market_share_bridge_id` 关联主键（保留）；`market_space_assessment_id` 关联主键（保留）；`share_type` 业务字段（保留）；`period_label` 业务字段（保留）；`starting_share` 业务字段（保留）。
  - `ending_share` 业务字段（保留）；`unit` 单位（保留）；`status` 状态（保留）；`created_at` 创建时间（保留）；`updated_at` 更新时间（保留）。

### research_market_space_assessments_typed
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-operating-market.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `market_space_assessment_id` 关联主键（保留）；`company_id` 公司 ID（保留）；`operating_model_id` 关联主键（保留）；`as_of` as-of 时间（保留）；`version` 版本字段（保留）。
  - `status` 状态（保留）；`market_definition` 业务字段（保留）；`product_boundary` 业务字段（保留）；`geographic_boundary` 业务字段（保留）；`customer_boundary` 业务字段（保留）。
  - `measurement_definition` 业务字段（保留）；`epistemic_type` 业务字段（保留）；`created_at` 创建时间（保留）；`updated_at` 更新时间（保留）。

### research_market_space_estimates_typed
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-operating-market.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `market_space_estimate_id` 关联主键（保留）；`market_space_assessment_id` 关联主键（保留）；`layer` 业务字段（保留）；`method` 业务字段（保留）；`method_basis` 业务字段（保留）。
  - `amount` 业务字段（保留）；`currency` 币种（保留）；`amount_scale` 业务字段（保留）；`period_label` 业务字段（保留）；`period_kind` 业务字段（保留）。
  - `calculation_description` 业务字段（保留）；`status` 状态（保留）；`sort_order` 排序（保留）。

### research_market_space_models
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-dossier.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `market_space_id` 关联主键（保留）；`company_id` 公司 ID（保留）；`as_of` as-of 时间（保留）；`status` 状态（保留）；`market_definition` 业务字段（保留）。
  - `tam_json` JSON 载荷（保留）；`sam_json` JSON 载荷（保留）；`som_json` JSON 载荷（保留）；`profit_pool_json` JSON 载荷（保留）；`top_down_json` JSON 载荷（保留）。
  - `bottom_up_json` JSON 载荷（保留）；`transmission_json` 传导配置（保留）；`source_type` 业务字段（保留）；`source_refs_json` JSON 载荷（保留）；`created_at` 创建时间（保留）。
  - `updated_at` 更新时间（保留）。

### research_market_structure_facts
- 现状：本地 24 行；主要 owner/引用：`src/modules/research/application/research-market-structure.ts`、`src/modules/research/application/research-company-focus-profile.ts`、`src/modules/research/application/research-auto-filing-insights.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：当前代码仍在使用；如果未来要收缩 schema，应优先从重复任务账本和无入口空表下手。
- 字段：
  - `market_structure_fact_id` 关联主键（保留）；`security_code` 证券代码（保留）；`fact_key` 键值（保留）；`fact_status` 状态字段（保留）；`value_kind` 业务字段（保留）。
  - `value_number` 业务字段（保留）；`value_text` 业务字段（保留）；`unit` 单位（保留）；`measurement_basis` 业务字段（保留）；`as_of` as-of 时间（保留）。
  - `frequency` 频率（保留）；`epistemic_type` 业务字段（保留）；`source_authority` 业务字段（保留）；`source_url` 来源 URL（保留）；`source_title` 业务字段（保留）。
  - `source_note` 业务字段（保留）；`effective_from` 业务字段（保留）；`effective_to` 业务字段（保留）；`created_at` 创建时间（保留）。

### research_model_review_item_actions
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/formal-actual-candidates.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `action_id` 关联主键（保留）；`review_item_id` 关联主键（保留）；`previous_state` 业务字段（保留）；`next_state` 业务字段（保留）；`acted_by` 业务字段（保留）。
  - `resolution_note` 业务字段（保留）；`follow_up_target_kind` 业务字段（保留）；`follow_up_target_version_id` 关联主键（保留）；`acted_at` 时间戳（保留）。

### research_model_review_items
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/formal-actual-candidates.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `review_item_id` 关联主键（保留）；`security_code` 证券代码（保留）；`trigger_kind` 业务字段（保留）；`trigger_id` 关联主键（保留）；`target_kind` 业务字段（保留）。
  - `target_version_id` 关联主键（保留）；`state` 状态（保留）；`reason` 原因/说明（保留）；`evidence_json` 证据 JSON（保留）；`created_at` 创建时间（保留）。
  - `reviewed_at` 审核时间（保留）；`resolution_note` 业务字段（保留）。

### research_operating_analysis_jobs
- 现状：本地 2 行；主要 owner/引用：`src/shared/local-job-protocol.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：中期合并候选：这张表承担专用任务账本职责，和 `workflow_tasks` / `llm_runs` / `llm_run_artifacts` 明显重复。现阶段先保留，待迁移完成后删除。
- 字段：
  - `security_code` + `prompt_version` 组成业务主键；`status`、`run_id`、`attempt_count`、`last_error`、`created_at`、`started_at`、`completed_at`、`updated_at` 记录作业状态；`lease_owner`、`lease_until`、`heartbeat_at`、`attempt` 是专用租约；`webqa_conversation_id`、`webqa_task_id`、`start_new_session`、`partial_report_markdown`、`partial_reasoning_markdown`、`partial_stream_stats_json`、`prompt_json`、`reasoning_effort`、`model` 是旧 WebQA 专用字段；`job_id`、`job_type` 又和统一任务账本重复。建议合并到统一任务表后删除。

### research_operating_analysis_routing_confirmations
- 现状：本地 5 行；主要 owner/引用：源码无直接引用。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：归档候选：有历史数据但现行源码无引用，优先核对离线脚本和人工查询是否仍依赖。
- 字段：
  - `confirmation_id` 关联主键（随表删除/归档）；`security_code` 证券代码（随表删除/归档）；`company_id` 公司 ID（随表删除/归档）；`actor_key` 键值（随表删除/归档）；`routing_state_before` 业务字段（随表删除/归档）。
  - `routing_state_after` 业务字段（随表删除/归档）；`selected_template_id` 关联主键（随表删除/归档）；`scope_note` 业务字段（随表删除/归档）；`company_scope_json` JSON 载荷（随表删除/归档）；`candidate_templates_json` JSON 载荷（随表删除/归档）。
  - `source_artifact_id` 关联主键（随表删除/归档）；`created_at` 创建时间（随表删除/归档）。

### research_operating_analysis_runner_leases
- 现状：本地 1 行；主要 owner/引用：源码无直接引用。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：中期合并候选：这张表承担专用任务账本职责，和 `workflow_tasks` / `llm_runs` / `llm_run_artifacts` 明显重复。现阶段先保留，待迁移完成后删除。
- 字段：
  - `lease_name`、`owner_id`、`heartbeat_at` 是旧专用 runner 租约；可以被统一任务租约替代，建议迁移后删除。

### research_operating_analysis_runs
- 现状：本地 1 行；主要 owner/引用：源码无直接引用。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：中期合并候选：这张表承担专用任务账本职责，和 `workflow_tasks` / `llm_runs` / `llm_run_artifacts` 明显重复。现阶段先保留，待迁移完成后删除。
- 字段：
  - `run_id` 主键；`security_code`、`prompt_version`、`input_fingerprint`、`input_as_of`、`input_json` 记录输入；`report_markdown`、`reasoning_markdown`、`stream_stats_json`、`prompt_json`、`provider`、`generated_at`、`total_duration_ms` 记录结果。当前只有历史数据，现行源码基本不再直读，建议迁移到统一产物账本后删除。

### research_operating_analysis_stage_artifacts
- 现状：本地 3 行；主要 owner/引用：源码无直接引用。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：中期合并候选：这张表承担专用任务账本职责，和 `workflow_tasks` / `llm_runs` / `llm_run_artifacts` 明显重复。现阶段先保留，待迁移完成后删除。
- 字段：
  - `security_code`、`prompt_version`、`stage_key` 标识阶段；`status`、`attempt_count`、`attempt`、`lease_owner`、`started_at`、`completed_at`、`updated_at` 管理执行；`input_json`、`prompt_json`、`output_json`、`output_markdown`、`partial_output`、`blocked_json`、`last_error` 存阶段结果。与 `llm_run_artifacts` 明显重叠，建议迁移后删除。

### research_operating_companies
- 现状：本地 5 行；主要 owner/引用：`src/modules/research/application/research-company-focus-profile.ts`、`src/modules/research/application/research-dossier.ts`、`src/modules/research/application/research-identity.ts`、`src/modules/research/application/research-auto-filing-insights.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：当前代码仍在使用；如果未来要收缩 schema，应优先从重复任务账本和无入口空表下手。
- 字段：
  - `company_id` 公司 ID（保留）；`canonical_name` 业务字段（保留）；`reporting_currency` 业务字段（保留）；`fiscal_year_end` 业务字段（保留）；`identity_status` 状态字段（保留）。
  - `metadata_json` 任务元数据（保留）；`created_at` 创建时间（保留）；`updated_at` 更新时间（保留）。

### research_operating_driver_plan_years
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-operating-market.ts`、`src/modules/research/application/research-industry-kpi-transmission.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `operating_driver_plan_year_id` 关联主键（保留）；`operating_driver_plan_id` 关联主键（保留）；`fiscal_year` 业务字段（保留）；`tax_rate` 业务字段（保留）；`forecast_net_debt` 业务字段（保留）。
  - `sort_order` 排序（保留）。

### research_operating_driver_plans
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-company-focus-profile.ts`、`src/modules/research/application/research-operating-market.ts`、`src/modules/research/application/research-industry-kpi-transmission.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `operating_driver_plan_id` 关联主键（保留）；`operating_model_id` 关联主键（保留）；`scenario_name` 业务字段（保留）；`as_of` as-of 时间（保留）；`version` 版本字段（保留）。
  - `status` 状态（保留）；`valuation_currency` 业务字段（保留）；`amount_scale` 业务字段（保留）；`opening_revenue` 业务字段（保留）；`opening_net_working_capital` 业务字段（保留）。
  - `epistemic_type` 业务字段（保留）；`created_at` 创建时间（保留）；`updated_at` 更新时间（保留）。

### research_operating_driver_segment_years
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-operating-market.ts`、`src/modules/research/application/research-industry-kpi-transmission.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `operating_driver_segment_year_id` 关联主键（保留）；`operating_driver_plan_year_id` 关联主键（保留）；`operating_segment_id` 关联主键（保留）；`volume` 业务字段（保留）；`price_per_unit` 业务字段（保留）。
  - `gross_margin` 业务字段（保留）；`operating_expense_margin` 业务字段（保留）；`depreciation_amortization_margin` 业务字段（保留）；`capital_expenditure_margin` 业务字段（保留）；`net_working_capital_to_revenue` 业务字段（保留）。
  - `sort_order` 排序（保留）。

### research_operating_market_evidence_refs
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-company-focus-profile.ts`、`src/modules/research/application/research-operating-market.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `evidence_ref_id` 关联主键（保留）；`subject_type` 主体类型（保留）；`subject_id` 主体 ID（保留）；`source_kind` 业务字段（保留）；`source_id` 来源 ID（保留）。
  - `information_id` 信息 ID（保留）；`version_id` 版本 ID（保留）；`document_id` 关联主键（保留）；`url` 来源 URL（保留）；`title` 标题（保留）。
  - `published_at` 发布时间（保留）；`locator` 业务字段（保留）；`created_at` 创建时间（保留）。

### research_operating_model_contracts_typed
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-operating-market.ts`、`src/modules/research/application/research-operating-source-fact-bindings.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `contract_driver_id` 关联主键（保留）；`operating_segment_id` 关联主键（保留）；`contract_type` 业务字段（保留）；`customer_or_channel` 业务字段（保留）；`commitment_description` 业务字段（保留）。
  - `pricing_basis` 业务字段（保留）；`renewal_or_delivery_constraint` 业务字段（保留）；`start_period` 业务字段（保留）；`end_period` 业务字段（保留）；`sort_order` 排序（保留）。

### research_operating_model_growth_constraints_typed
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-operating-source-fact-bindings.ts`、`src/modules/research/application/research-operating-market.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `growth_constraint_id` 关联主键（保留）；`operating_model_id` 关联主键（保留）；`operating_segment_id` 关联主键（保留）；`constraint_kind` 业务字段（保留）；`description` 业务字段（保留）。
  - `affected_statement` 业务字段（保留）；`affected_driver` 业务字段（保留）；`invalidation_or_release_condition` 业务字段（保留）；`sort_order` 排序（保留）。

### research_operating_model_segments_typed
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-company-focus-profile.ts`、`src/modules/research/application/research-operating-market.ts`、`src/modules/research/application/research-operating-source-fact-bindings.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `operating_segment_id` 关联主键（保留）；`operating_model_id` 关联主键（保留）；`name` 名称（保留）；`product_scope` 业务字段（保留）；`customer_scope` 业务字段（保留）。
  - `geographic_scope` 业务字段（保留）；`revenue_formula` 业务字段（保留）；`revenue_recognition` 业务字段（保留）；`sort_order` 排序（保留）。

### research_operating_model_unit_economics_typed
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-operating-market.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `unit_economic_id` 关联主键（保留）；`operating_segment_id` 关联主键（保留）；`unit_name` 业务字段（保留）；`price_per_unit` 业务字段（保留）；`variable_cost_per_unit` 业务字段（保留）。
  - `currency` 币种（保留）；`amount_scale` 业务字段（保留）；`period_basis` 业务字段（保留）；`contribution_description` 业务字段（保留）；`sort_order` 排序（保留）。

### research_operating_models_typed
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-industry-kpi-transmission.ts`、`src/modules/research/application/research-operating-source-fact-bindings.ts`、`src/modules/research/application/research-company-focus-profile.ts`、`src/modules/research/application/research-operating-market.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `operating_model_id` 关联主键（保留）；`company_id` 公司 ID（保留）；`as_of` as-of 时间（保留）；`version` 版本字段（保留）；`status` 状态（保留）。
  - `model_type` 业务字段（保留）；`primary_earning_driver` 业务字段（保留）；`revenue_recognition` 业务字段（保留）；`summary` 摘要（保留）；`epistemic_type` 业务字段（保留）。
  - `created_at` 创建时间（保留）；`updated_at` 更新时间（保留）。

### research_operating_source_fact_binding_reviews
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-operating-source-fact-bindings.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `operating_source_fact_binding_review_id` 关联主键（保留）；`operating_source_fact_binding_id` 关联主键（保留）；`review_status` 状态字段（保留）；`review_note` 业务字段（保留）；`reviewed_by` 业务字段（保留）。
  - `reviewed_at` 审核时间（保留）。

### research_operating_source_fact_bindings
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-operating-source-fact-bindings.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `operating_source_fact_binding_id` 关联主键（保留）；`operating_company_id` 关联主键（保留）；`operating_source_fact_id` 关联主键（保留）；`operating_model_id` 关联主键（保留）；`target_kind` 业务字段（保留）。
  - `target_id` 目标 ID（保留）；`target_field` 业务字段（保留）；`formula` 业务字段（保留）；`applicable_period` 业务字段（保留）；`applicability_description` 业务字段（保留）。
  - `uncovered_scope` 业务字段（保留）；`created_by` 业务字段（保留）；`created_at` 创建时间（保留）。

### research_operating_source_facts
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-operating-source-facts.ts`、`src/modules/research/application/research-operating-source-fact-bindings.ts`、`src/modules/research/application/research-company-focus-profile.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `operating_source_fact_id` 关联主键（保留）；`operating_company_id` 关联主键（保留）；`source_security_code` 代码字段（保留）；`evidence_reference_id` 关联主键（保留）；`candidate_id` 候选 ID（保留）。
  - `candidate_review_id` 关联主键（保留）；`fact_kind` 业务字段（保留）；`subject_label` 业务字段（保留）；`segment_label` 业务字段（保留）；`customer_or_channel` 业务字段（保留）。
  - `period_label` 业务字段（保留）；`period_kind` 业务字段（保留）；`reported_value` 业务字段（保留）；`numeric_value` 业务字段（保留）；`unit` 单位（保留）。
  - `currency` 币种（保留）；`amount_scale` 业务字段（保留）；`scope_description` 业务字段（保留）；`comparability_note` 业务字段（保留）；`statement` 陈述文本（保留）。
  - `information_type` 信息类型（保留）；`mapping_config_version` 版本字段（保留）；`recorded_by` 业务字段（保留）；`recorded_at` 时间戳（保留）；`created_at` 创建时间（保留）。

### research_owner_holding_snapshot_references
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-owner-holding-snapshot-reference.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `reference_id` 关联主键（保留）；`owner_key` 用户/owner 键（保留）；`holding_security_code` 代码字段（保留）；`public_snapshot_id` 关联主键（保留）；`created_at` 创建时间（保留）。

### research_peer_comparison_dimensions
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-industry-comparability.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `comparison_dimension_id` 关联主键（保留）；`peer_comparison_member_id` 关联主键（保留）；`dimension` 业务字段（保留）；`status` 状态（保留）；`target_value` 业务字段（保留）。
  - `peer_value` 业务字段（保留）；`adjustment_note` 业务字段（保留）；`sort_order` 排序（保留）。

### research_peer_comparison_members
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-industry-comparability.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `peer_comparison_member_id` 关联主键（保留）；`peer_comparison_set_id` 关联主键（保留）；`company_id` 公司 ID（保留）；`security_code` 证券代码（保留）；`peer_name` 业务字段（保留）。
  - `relationship_type` 业务字段（保留）；`membership_status` 状态字段（保留）；`comparability_status` 状态字段（保留）；`exclusion_reason` 原因/说明（保留）；`sort_order` 排序（保留）。

### research_peer_comparison_sets
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-industry-comparability.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `peer_comparison_set_id` 关联主键（保留）；`company_id` 公司 ID（保留）；`track_profile_id` 关联主键（保留）；`as_of` as-of 时间（保留）；`version` 版本字段（保留）。
  - `status` 状态（保留）；`comparison_purpose` 业务字段（保留）；`selection_criteria` 业务字段（保留）；`epistemic_type` 业务字段（保留）；`created_at` 创建时间（保留）。
  - `updated_at` 更新时间（保留）。

### research_peer_universe_members
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-industry-profile.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `peer_member_id` 关联主键（保留）；`peer_universe_id` 关联主键（保留）；`company_id` 公司 ID（保留）；`security_code` 证券代码（保留）；`peer_name` 业务字段（保留）。
  - `relationship_type` 业务字段（保留）；`membership_status` 状态字段（保留）；`comparability_status` 状态字段（保留）；`exclusion_reason` 原因/说明（保留）；`comparison_dimensions_json` JSON 载荷（保留）。
  - `cross_market_metadata_json` JSON 载荷（保留）；`source_refs_json` JSON 载荷（保留）；`sort_order` 排序（保留）。

### research_peer_universes
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-industry-profile.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `peer_universe_id` 关联主键（保留）；`company_id` 公司 ID（保留）；`industry_profile_id` 关联主键（保留）；`as_of` as-of 时间（保留）；`version` 版本字段（保留）。
  - `status` 状态（保留）；`comparison_purpose` 业务字段（保留）；`selection_criteria` 业务字段（保留）；`cross_market_policy_json` JSON 载荷（保留）；`epistemic_type` 业务字段（保留）。
  - `source_refs_json` JSON 载荷（保留）；`created_at` 创建时间（保留）；`updated_at` 更新时间（保留）。

### research_provider_identifiers
- 现状：本地 1 行；主要 owner/引用：`src/modules/research/application/research-identity.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：当前代码仍在使用；如果未来要收缩 schema，应优先从重复任务账本和无入口空表下手。
- 字段：
  - `identifier_id` 关联主键（保留）；`owner_type` 业务字段（保留）；`company_id` 公司 ID（保留）；`security_code` 证券代码（保留）；`provider` 执行提供方（保留）。
  - `identifier_kind` 业务字段（保留）；`identifier_value` 业务字段（保留）；`identifier_status` 状态字段（保留）；`source_url` 来源 URL（保留）；`source_note` 业务字段（保留）。
  - `observed_at` 观测时间（保留）；`metadata_json` 任务元数据（保留）；`created_at` 创建时间（保留）；`updated_at` 更新时间（保留）。

### research_relative_valuation_comparability_gates
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/relative-valuation-ledger.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `relative_valuation_gate_id` 关联主键（保留）；`relative_valuation_ledger_id` 关联主键（保留）；`gate_kind` 业务字段（保留）；`status` 状态（保留）；`rationale` 业务字段（保留）。
  - `source_refs_json` JSON 载荷（保留）。

### research_relative_valuation_inputs
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/relative-valuation-ledger.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `relative_valuation_input_id` 关联主键（保留）；`relative_valuation_ledger_id` 关联主键（保留）；`subject_kind` 业务字段（保留）；`peer_member_id` 关联主键（保留）；`peer_member_key` 键值（保留）。
  - `input_kind` 业务字段（保留）；`input_key` 键值（保留）；`label` 业务字段（保留）；`value` 数值（保留）；`unit` 单位（保留）。
  - `currency` 币种（保留）；`amount_scale` 业务字段（保留）；`fiscal_year` 业务字段（保留）；`period_label` 业务字段（保留）；`input_as_of` 输入时点（保留）。
  - `epistemic_type` 业务字段（保留）；`source_refs_json` JSON 载荷（保留）。

### research_relative_valuation_ledgers
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/relative-valuation-ledger.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `relative_valuation_ledger_id` 关联主键（保留）；`company_id` 公司 ID（保留）；`security_code` 证券代码（保留）；`as_of` as-of 时间（保留）；`status` 状态（保留）。
  - `valuation_role` 业务字段（保留）；`valuation_archetype` 业务字段（保留）；`method` 业务字段（保留）；`peer_universe_id` 关联主键（保留）；`valuation_currency` 业务字段（保留）。
  - `security_currency` 业务字段（保留）；`applicability_rationale` 业务字段（保留）；`rationale_source_refs_json` JSON 载荷（保留）；`supersedes_ledger_id` 关联主键（保留）；`created_at` 创建时间（保留）。

### research_relative_valuation_metrics
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/relative-valuation-ledger.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `relative_valuation_metric_id` 关联主键（保留）；`relative_valuation_ledger_id` 关联主键（保留）；`subject_kind` 业务字段（保留）；`peer_member_id` 关联主键（保留）；`metric_type` 业务字段（保留）。
  - `period_basis` 业务字段（保留）；`fiscal_year` 业务字段（保留）；`definition` 业务字段（保留）；`numerator_input_id` 关联主键（保留）；`denominator_input_id` 关联主键（保留）。
  - `display_unit` 业务字段（保留）。

### research_reusable_evidence_references
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-operating-source-facts.ts`、`src/modules/research/application/research-information-evidence.ts`、`src/modules/research/application/research-industry-kpi-transmission.ts`、`src/modules/research/application/research-financial-specialty-metrics.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `evidence_reference_id` 关联主键（保留）；`candidate_id` 候选 ID（保留）；`candidate_review_id` 关联主键（保留）；`security_code` 证券代码（保留）；`target_module` 业务字段（保留）。
  - `target_field` 业务字段（保留）；`field_status` 状态字段（保留）；`information_id` 信息 ID（保留）；`result_id` 结果 ID（保留）；`run_id` 运行 ID（保留）。
  - `version_id` 版本 ID（保留）；`content_hash` 内容哈希（保留）；`doc_id` 文档 ID（保留）；`source_url` 来源 URL（保留）；`content_url` 内容 URL（保留）。
  - `title` 标题（保留）；`source_name` 业务字段（保留）；`published_at` 发布时间（保留）；`locator` 业务字段（保留）；`created_at` 创建时间（保留）。

### research_reverse_valuation_model_versions
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/formal-actual-candidates.ts`、`src/modules/research/application/guidance-event-impact-reviews.ts`、`src/modules/research/application/reverse-valuation-model-version.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `model_version_id` 关联主键（保留）；`company_id` 公司 ID（保留）；`security_code` 证券代码（保留）；`as_of` as-of 时间（保留）；`status` 状态（保留）。
  - `algorithm_version` 版本字段（保留）；`valuation_currency` 业务字段（保留）；`amount_scale` 业务字段（保留）；`security_currency` 业务字段（保留）；`price_per_security` 业务字段（保留）。
  - `price_as_of` 业务字段（保留）；`price_source_refs_json` JSON 载荷（保留）；`diluted_underlying_shares` 业务字段（保留）；`diluted_shares_source_refs_json` JSON 载荷（保留）；`underlying_shares_per_security` 业务字段（保留）。
  - `net_debt_at_valuation` 业务字段（保留）；`net_debt_source_refs_json` JSON 载荷（保留）；`fx_rate_to_valuation` 业务字段（保留）；`fx_as_of` 业务字段（保留）；`fx_source_refs_json` JSON 载荷（保留）。
  - `wacc` 业务字段（保留）；`terminal_growth` 业务字段（保留）；`terminal_ufcf_margin` 业务字段（保留）；`terminal_ebit_margin` 业务字段（保留）；`assumption_source_refs_json` JSON 载荷（保留）。
  - `outputs_json` JSON 载荷（保留）；`source_refs_json` JSON 载荷（保留）；`created_at` 创建时间（保留）；`diluted_shares_scale` 业务字段（保留）。

### research_risk_entries
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-company-focus-profile.ts`、`src/modules/research/application/research-risk-review.ts`、`src/modules/research/application/guidance-event-impact-reviews.ts`、`src/modules/research/application/research-dossier.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `risk_id` 关联主键（保留）；`company_id` 公司 ID（保留）；`security_code` 证券代码（保留）；`as_of` as-of 时间（保留）；`category` 分类（保留）。
  - `scope` 业务字段（保留）；`title` 标题（保留）；`exposure` 业务字段（保留）；`transmission` 传导链路（保留）；`loss_range` 业务字段（保留）。
  - `likelihood` 业务字段（保留）；`impact` 业务字段（保留）；`speed` 业务字段（保留）；`reversibility` 业务字段（保留）；`gross_risk` 业务字段（保留）。
  - `verified_mitigation` 业务字段（保留）；`residual_risk` 业务字段（保留）；`trigger_condition` 业务字段（保留）；`review_frequency` 业务字段（保留）；`status` 状态（保留）。
  - `source_refs_json` JSON 载荷（保留）；`created_at` 创建时间（保留）；`updated_at` 更新时间（保留）。

### research_risk_pressure_scenarios
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-risk-review.ts`、`src/modules/research/application/research-auto-filing-insights.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `scenario_id` 关联主键（保留）；`company_id` 公司 ID（保留）；`security_code` 证券代码（保留）；`as_of` as-of 时间（保留）；`scenario_key` 键值（保留）。
  - `version` 版本字段（保留）；`supersedes_scenario_id` 关联主键（保留）；`status` 状态（保留）；`scope` 业务字段（保留）；`title` 标题（保留）。
  - `transmission` 传导链路（保留）；`model_version` 版本字段（保留）；`inputs_json` JSON 载荷（保留）；`results_json` JSON 载荷（保留）；`source_refs_json` JSON 载荷（保留）。
  - `created_at` 创建时间（保留）；`updated_at` 更新时间（保留）。

### research_risk_relationships
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-company-focus-profile.ts`、`src/modules/research/application/research-risk-review.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `relationship_id` 关联主键（保留）；`company_id` 公司 ID（保留）；`security_code` 证券代码（保留）；`as_of` as-of 时间（保留）；`scope` 业务字段（保留）。
  - `relationship_type` 业务字段（保留）；`counterparty_name` 业务字段（保留）；`description` 业务字段（保留）；`transmission` 传导链路（保留）；`concentration_value` 业务字段（保留）。
  - `concentration_basis` 业务字段（保留）；`status` 状态（保留）；`epistemic_type` 业务字段（保留）；`source_refs_json` JSON 载荷（保留）；`created_at` 创建时间（保留）。
  - `updated_at` 更新时间（保留）。

### research_risk_thesis_links
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-risk-review.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `risk_thesis_link_id` 关联主键（保留）；`risk_id` 关联主键（保留）；`thesis_id` 关联主键（保留）；`relationship` 业务字段（保留）；`rationale` 业务字段（保留）。
  - `source_refs_json` JSON 载荷（保留）；`created_at` 创建时间（保留）。

### research_security_rights_links
- 现状：本地 3 行；主要 owner/引用：`src/modules/research/application/research-identity.ts`、`src/modules/research/application/research-auto-filing-insights.ts`、`src/modules/research/api/research.routes.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：当前代码仍在使用；如果未来要收缩 schema，应优先从重复任务账本和无入口空表下手。
- 字段：
  - `rights_link_id` 关联主键（保留）；`security_code` 证券代码（保留）；`related_security_code` 代码字段（保留）；`relationship_kind` 业务字段（保留）；`relationship_status` 状态字段（保留）。
  - `related_shares_per_security` 业务字段（保留）；`conversion_availability` 版本字段（保留）；`relationship_note` 业务字段（保留）；`effective_from` 业务字段（保留）；`effective_to` 业务字段（保留）。
  - `evidence_kind` 业务字段（保留）；`source_url` 来源 URL（保留）；`source_title` 业务字段（保留）；`source_note` 业务字段（保留）；`observed_at` 观测时间（保留）。
  - `metadata_json` 任务元数据（保留）；`created_at` 创建时间（保留）。

### research_security_rights_profiles
- 现状：本地 2 行；主要 owner/引用：`src/modules/research/application/research-identity.ts`、`src/modules/research/api/research.routes.ts`、`src/modules/research/application/bootstrap-research-company.ts`、`src/modules/research/application/research-auto-filing-insights.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：当前代码仍在使用；如果未来要收缩 schema，应优先从重复任务账本和无入口空表下手。
- 字段：
  - `rights_profile_id` 关联主键（保留）；`security_code` 证券代码（保留）；`rights_status` 状态字段（保留）；`holder_structure` 业务字段（保留）；`legal_issuer_name` 业务字段（保留）。
  - `voting_rights_note` 业务字段（保留）；`economic_rights_note` 业务字段（保留）；`transferability_note` 业务字段（保留）；`structural_risk_note` 业务字段（保留）；`depositary_name` 业务字段（保留）。
  - `depositary_fee_note` 业务字段（保留）；`effective_from` 业务字段（保留）；`effective_to` 业务字段（保留）；`evidence_kind` 业务字段（保留）；`source_url` 来源 URL（保留）。
  - `source_title` 业务字段（保留）；`source_note` 业务字段（保留）；`observed_at` 观测时间（保留）；`metadata_json` 任务元数据（保留）；`created_at` 创建时间（保留）。

### research_snapshot_module_differences
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-risk-review.ts`、`src/modules/research/application/research-public-snapshot.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `difference_id` 关联主键（保留）；`company_id` 公司 ID（保留）；`security_code` 证券代码（保留）；`baseline_snapshot_id` 关联主键（保留）；`current_snapshot_id` 关联主键（保留）。
  - `module_id` 关联主键（保留）；`diff_version` 版本字段（保留）；`change_type` 业务字段（保留）；`baseline_json` JSON 载荷（保留）；`current_json` JSON 载荷（保留）。
  - `fields_json` JSON 载荷（保留）；`created_at` 创建时间（保留）。

### research_source_forecasts
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/forecast-actual-calibration.ts`、`src/modules/research/application/forecast-ledger.ts`、`src/modules/research/application/formal-actual-candidates.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `forecast_id` 关联主键（保留）；`review_id` 关联主键（保留）；`information_id` 信息 ID（保留）；`version_id` 版本 ID（保留）；`doc_id` 文档 ID（保留）。
  - `security_code` 证券代码（保留）；`company_id` 公司 ID（保留）；`institution` 业务字段（保留）；`analysts_json` JSON 载荷（保留）；`forecast_date` 业务字段（保留）。
  - `metric` 业务字段（保留）；`fiscal_year` 业务字段（保留）；`fiscal_period` 业务字段（保留）；`raw_value` 业务字段（保留）；`raw_unit` 业务字段（保留）。
  - `currency` 币种（保留）；`accounting_basis` 业务字段（保留）；`ownership_basis` 业务字段（保留）；`share_basis` 业务字段（保留）；`normalized_value` 业务字段（保留）。
  - `normalized_unit` 业务字段（保留）；`normalization_status` 状态字段（保留）；`normalization_notes` 业务字段（保留）；`source_statement` 业务字段（保留）；`supersedes_forecast_id` 关联主键（保留）。
  - `created_at` 创建时间（保留）；`source_identity_id` 关联主键（保留）；`source_identity_assertion_id` 关联主键（保留）；`origin_source_identity_id` 关联主键（保留）；`carrier_source_identity_id` 关联主键（保留）。
  - `carrier_relation` 业务字段（保留）；`model_lineage_id` 关联主键（保留）；`independence_group_id` 关联主键（保留）。

### research_statutory_disclosure_documents
- 现状：本地 30 行；主要 owner/引用：`src/modules/research/application/statutory-disclosure-revision-candidates.ts`、`src/modules/research/application/bootstrap-research-company.ts`、`src/modules/research/application/statutory-disclosure-index.ts`、`src/modules/research/application/research-auto-filing-insights.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：当前代码仍在使用；如果未来要收缩 schema，应优先从重复任务账本和无入口空表下手。
- 字段：
  - `registry` 业务字段（保留）；`security_code` 证券代码（保留）；`document_id` 关联主键（保留）；`title` 标题（保留）；`published_at` 发布时间（保留）。
  - `document_url` 引用 URL（保留）；`document_type` 业务字段（保留）；`source_locator` 业务字段（保留）；`indexed_at` 时间戳（保留）。

### research_statutory_disclosure_revision_candidates
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/statutory-disclosure-revision-candidates.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `candidate_id` 候选 ID（保留）；`registry` 业务字段（保留）；`security_code` 证券代码（保留）；`document_id` 关联主键（保留）；`title` 标题（保留）。
  - `published_at` 发布时间（保留）；`document_url` 引用 URL（保留）；`source_locator` 业务字段（保留）；`report_period` 业务字段（保留）；`candidate_signals_json` JSON 载荷（保留）。
  - `rule_version` 规则版本（保留）；`discovered_at` 时间戳（保留）。

### research_statutory_disclosure_revision_reviews
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/statutory-disclosure-revision-candidates.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `review_id` 关联主键（保留）；`candidate_id` 候选 ID（保留）；`decision` 业务字段（保留）；`original_document_id` 关联主键（保留）；`affected_scope` 业务字段（保留）。
  - `reviewer` 业务字段（保留）；`reason` 原因/说明（保留）；`reviewed_at` 审核时间（保留）；`created_at` 创建时间（保留）。

### research_statutory_operating_candidate_provenance
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-information-evidence.ts`、`src/modules/research/application/research-statutory-operating-candidates.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `candidate_id` 候选 ID（保留）；`registry` 业务字段（保留）；`security_code` 证券代码（保留）；`statutory_document_id` 关联主键（保留）；`statutory_document_url` 引用 URL（保留）。
  - `statutory_source_locator` 业务字段（保留）；`knowledge_doc_id` 关联主键（保留）；`result_id` 结果 ID（保留）；`run_id` 运行 ID（保留）；`version_id` 版本 ID（保留）。
  - `content_hash` 内容哈希（保留）；`producer_version` 版本字段（保留）；`created_at` 创建时间（保留）。

### research_theses
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-company-focus-profile.ts`、`src/modules/research/application/research-risk-review.ts`、`src/modules/research/application/guidance-event-impact-reviews.ts`、`src/modules/research/application/research-dossier.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `thesis_id` 关联主键（保留）；`company_id` 公司 ID（保留）；`as_of` as-of 时间（保留）；`title` 标题（保留）；`statement` 陈述文本（保留）。
  - `status` 状态（保留）；`assessment_type` 业务字段（保留）；`invalidation_condition` 业务字段（保留）；`review_by` 业务字段（保留）；`created_at` 创建时间（保留）。
  - `updated_at` 更新时间（保留）。

### research_thesis_evidence
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-dossier.ts`、`src/modules/research/application/research-company-focus-profile.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `thesis_evidence_id` 关联主键（保留）；`thesis_id` 关联主键（保留）；`stance` 业务字段（保留）；`knowledge_information_id` 关联主键（保留）；`source_url` 来源 URL（保留）。
  - `source_title` 业务字段（保留）；`evidence_type` 业务字段（保留）；`statement` 陈述文本（保留）；`applicable_period` 业务字段（保留）；`observed_at` 观测时间（保留）。
  - `source_refs_json` JSON 载荷（保留）；`created_at` 创建时间（保留）。

### research_us_financial_period_equivalences
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/us-financial-period-equivalence.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `period_equivalence_id` 关联主键（保留）；`security_code` 证券代码（保留）；`primary_comparison_key` 键值（保留）；`primary_statement_type` 业务字段（保留）；`metric` 业务字段（保留）。
  - `primary_period_kind` 业务字段（保留）；`primary_period_start_date` 业务字段（保留）；`primary_period_end_date` 业务字段（保留）；`primary_currency` 业务字段（保留）；`sec_cik` 业务字段（保留）。
  - `sec_accession` 业务字段（保留）；`sec_namespace` 业务字段（保留）；`sec_concept` 业务字段（保留）；`sec_unit` 业务字段（保留）；`sec_period_start_date` 业务字段（保留）。
  - `sec_period_end_date` 业务字段（保留）；`sec_form` 业务字段（保留）；`evidence_url` 引用 URL（保留）；`evidence_title` 业务字段（保留）；`review_decision` 业务字段（保留）。
  - `review_reason` 原因/说明（保留）；`reviewed_by` 业务字段（保留）；`reviewed_at` 审核时间（保留）；`created_at` 创建时间（保留）。

### research_user_notes
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/domain/research-dossier.ts`、`src/modules/research/application/research-dossier.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `note_id` 关联主键（保留）；`owner_key` 用户/owner 键（保留）；`company_id` 公司 ID（保留）；`security_code` 证券代码（保留）；`note_type` 业务字段（保留）。
  - `content` 业务字段（保留）；`references_json` JSON 载荷（保留）；`created_at` 创建时间（保留）；`updated_at` 更新时间（保留）。

### research_valuation_cases
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/research-dossier.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `valuation_case_id` 关联主键（保留）；`security_code` 证券代码（保留）；`company_id` 公司 ID（保留）；`as_of` as-of 时间（保留）；`status` 状态（保留）。
  - `valuation_type` 业务字段（保留）；`method_rationale` 业务字段（保留）；`assumptions_json` JSON 载荷（保留）；`outputs_json` JSON 载荷（保留）；`sensitivity_json` JSON 载荷（保留）。
  - `source_refs_json` JSON 载荷（保留）；`created_at` 创建时间（保留）；`updated_at` 更新时间（保留）。

### research_valuation_model_versions
- 现状：本地 0 行；主要 owner/引用：`src/modules/research/application/formal-actual-candidates.ts`、`src/modules/research/application/valuation-model-version.ts`、`src/modules/research/application/guidance-event-impact-reviews.ts`。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：保留：虽然当前为空，但仍有现行代码/页面入口。
- 字段：
  - `model_version_id` 关联主键（保留）；`company_id` 公司 ID（保留）；`security_code` 证券代码（保留）；`as_of` as-of 时间（保留）；`status` 状态（保留）。
  - `model_kind` 业务字段（保留）；`algorithm_version` 版本字段（保留）；`valuation_currency` 业务字段（保留）；`amount_scale` 业务字段（保留）；`security_currency` 业务字段（保留）。
  - `fx_rate_to_security` 业务字段（保留）；`fx_as_of` 业务字段（保留）；`fx_source_refs_json` JSON 载荷（保留）；`underlying_shares_per_security` 业务字段（保留）；`model_inputs_json` JSON 载荷（保留）。
  - `operating_forecasts_json` JSON 载荷（保留）；`outputs_json` JSON 载荷（保留）；`sensitivity_json` JSON 载荷（保留）；`source_refs_json` JSON 载荷（保留）；`created_at` 创建时间（保留）。

### research_webqa_runner_leases
- 现状：本地 0 行；主要 owner/引用：源码无直接引用。
- 页面/功能：`company-research.html` 的公司研究工作台；少数结果同时被 `company-finance.html`/`investment-analysis.html` 读取。
- 判断：中期合并候选：这张表承担专用任务账本职责，和 `workflow_tasks` / `llm_runs` / `llm_run_artifacts` 明显重复。现阶段先保留，待迁移完成后删除。
- 字段：
  - `lease_name`、`owner_id`、`heartbeat_at` 是更早期的 WebQA runner 租约；当前无数据无引用，建议删除。
