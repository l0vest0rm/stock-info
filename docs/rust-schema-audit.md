# Rust 本地运行表结构审计

## 范围、方法与结论

本审计按**完整保留现有业务**的约束检查 `migrations/*.sql` 与
`backend/src/**/*.rs`，不以表是否为空判断用途。未访问、迁移或修改用户实际
SQLite，未新增迁移、表或删除语句。历史 SQL 原样保留。

在临时内存 SQLite 中按文件名字典序执行全部 **156** 个历史 SQL 文件，启用
`PRAGMA foreign_keys=ON`，最终得到下列 **14** 张表；`foreign_key_check`
返回空集合，`integrity_check` 返回 `ok`。迁移编号截至 `0148`，文件总数与
编号不同；运行时继续使用排序文件位置与 `user_version`，不引入迁移记录表。
这是全新数据库的结构证据，不代替现有用户数据的业务验收或备份恢复验收。

其中 12 张表有 Rust 业务读写消费者。`users` / `auth_sessions` 对本地 Rust
已无运行时消费者；它们属于可进一步评估的退役账户表，但本次未删除账户、
凭据或会话记录。没有足够安全删除证据的表均保留。

## 最终表与 Rust 消费者

| 表 | 读取消费者 | 写入消费者 / 保留依据 |
| --- | --- | --- |
| `http_cache` | `http.rs`；雪球、公告、财报、研究证据提供方共享请求缓存 | `http.rs`、`xueqiu.rs`；鉴权失败缓存失效，不是业务账本 |
| `kv_cache` | `db.rs`、`follow.rs`、`dashboard.rs`、`observation.rs`、`portfolio.rs`、研究/宏观/财报仓库 | 上述模块；同时含永久账本与可过期缓存，不能整表清理 |
| `knowledge_docs` | `knowledge/documents.rs`、`feed.rs`、`information_records.rs`、`market.rs`、公司研报/资讯处理 | `knowledge/importer.rs`、`review.rs`、`ingest/writer.rs`、`feed_processing/extraction.rs` 与显式维护流程；正文内联列也在此表 |
| `knowledge_doc_content_refs` | 文档/资讯正文、转换、公司研报、处理队列 | 导入、review keep、采集 writer、显式本地存储维护；外键指向 `knowledge_docs` |
| `knowledge_doc_tags` | 文档/资讯分类与筛选 | 采集 writer、review keep、资讯抽取/回填；外键指向 `knowledge_docs` |
| `knowledge_doc_security_links` | 按证券筛选文档、知识证据关联 | 采集 writer、review keep；外键指向 `knowledge_docs` |
| `knowledge_information_records` | `knowledge/feed.rs`、`information_records.rs`、资讯对账/回填 | `feed_processing/extraction.rs`、`records_backfill.rs`；0142 后直接关联 `doc_id`，不恢复旧版本结果表 |
| `stock` | 采集别名归属、资讯抽取、实体匹配与对账 | `knowledge/ingest/writer.rs` 导入证券短名；仍为规范证券实体目录 |
| `stock_alias` | 采集与资讯实体匹配、信息记录回填 | `knowledge/ingest/writer.rs`；多对多别名关系，外键指向 `stock`，不能用模糊名称替代身份 |
| `macro_indicators` | `macro_data/repository.rs` 指标目录、同步到期选择 | 同一仓库更新目录、抓取租约、成功/失败、下次刷新时间 |
| `macro_data` | 宏观历史序列、窗口、派生指标 | `macro_data/repository.rs` 按指标/期间/公布时间写入正式观测 |
| `featured_reports` | `featured_reports.rs` 专题报告码、元信息与对象路径 | 同一模块本地发布与内容哈希 CAS；注册预览文件不能替代已发布报告记录 |
| `users` | 无 Rust 运行时消费者；本地 auth 路由明确 404 | 历史账户数据，0139 创建；不因本地不需要登录就自动删凭据 |
| `auth_sessions` | 无 Rust 运行时消费者；本地 auth 路由明确 404 | 历史会话数据，0139 创建；外键依赖 `users`，如将来批准删除应先删会话表 |

`maintenance.rs` 仅提供显式本地维护消费者，不可被视为自动清表授权。
历史迁移中证券表由 `knowledge_stocks` / `knowledge_stock_aliases` 在 0144
改名为 `stock` / `stock_alias`；这是身份表改名，不是删除证券业务。

## `kv_cache` 不是可统一回收的缓存表

必须永久保留且 `expires_at IS NULL` 的业务包括：

- `observation-ledger-v1`：不可变研究版本、真实 capture 后的 cohort 与冻结
  outcomes；仅 dashboard writer 追加 cohort，GET 不写入。
- `private-active-portfolio-v1`：私有组合不可变版本、真实快照、决策任务与
  what-if 提案；CAS/版本历史不能由普通缓存 upsert 或定期清理取代。
- 研究财务/投资分析与宏观模型等模块的持久任务投影：按其仓库的任务身份、
  终态与并发更新约束保存，不得仅按名称含有 cache 就回收。

Dashboard 滚动读模型 `valuation-screen-v5`、租约
`valuation-screen-v4-lease` 和提供方结果等有各自过期/失效策略；不能将这些
策略扩大到整个 `kv_cache`。历史 `app_kv` 已由 0118 按命名空间搬入此表再
删除，Rust 不应恢复旧表。

## 历史已删除或改名的业务表

下列清单来自逐个迁移执行前后的表集合差异；重复重建同名表不算业务删除，
同一迁移内的 `_old` / `_pre_*` 中间表另见后节。历史迁移后可观察到过 206
个表名，最终仍有 14 个，192 个历史表名不再存在。`llm_tasks` 与证券表的
改名在清单中明确标注，不能将其误认为当时业务已经移除。

### `0017_drop_runtime_history_row_tables.sql`

- `financial_statements`, `fund_nav`, `kline_bars`

### `0020_compact_macro_series_history.sql`

- `macro_observation_vintages`

### `0028_rebuild_information_processing_records.sql`

- `knowledge_assertion_evidence`, `knowledge_assertions`, `knowledge_claim_assertions`, `knowledge_claim_state_history`
- `knowledge_claims`, `knowledge_entities`, `knowledge_entity_aliases`, `knowledge_entity_views`
- `knowledge_evidence_spans`, `knowledge_view_item_claims`, `knowledge_view_items`

### `0098_remove_research_investment_review.sql`

- `research_investment_review_jobs`, `research_investment_review_runs`

### `0111_workflow_task_ledger_rename.sql`（改名为 `workflow_tasks`，后由 0119 删除）

- `llm_tasks`

### `0114_remove_research_web_search_packages.sql`

- `research_web_search_evidence_records`, `research_web_search_package_jobs`, `research_web_search_source_packages`

### `0115_drop_unused_legacy_tables.sql`

- `company_notices`, `knowledge_company_code_mappings`, `knowledge_filtered_doc_content_refs`, `knowledge_filtered_docs`
- `llm_cache_entries`, `llm_run_artifact_links`, `local_job_provider_leases`, `research_analysis_snapshot_modules`
- `research_analysis_snapshots`, `research_auto_filing_document_versions`, `research_auto_filing_fact_inputs`, `research_auto_filing_financial_profiles`
- `research_auto_filing_financial_specialty_facts`, `research_auto_filing_insights`, `research_auto_filing_module_rebuilds`, `research_auto_filing_recompute_events`
- `research_auto_risk_snapshots`, `research_business_models`, `research_business_segments`, `research_catalyst_reviews`
- `research_catalysts`, `research_company_financial_profiles`, `research_company_focus_memberships`, `research_company_focus_profile_items`
- `research_company_focus_profile_versions`, `research_company_industry_exposures`, `research_company_track_exposure_shares`, `research_company_track_exposures`
- `research_competitive_markets`, `research_competitors`, `research_dossiers`, `research_financial_analysis_results`
- `research_financial_specialty_fact_versions`, `research_financial_statutory_verifications`, `research_forecast_actual_calibration_records`, `research_forecast_calibrations`
- `research_forecast_consolidation_groups`, `research_forecast_consolidation_members`, `research_forecast_consolidations`, `research_forecast_model_lineages`
- `research_forecast_scenarios`, `research_forecast_source_identities`, `research_forecast_source_identity_assertions`, `research_forecast_source_independence_groups`
- `research_forecast_source_reviews`, `research_forecast_synthesis_drafts`, `research_formal_actual_candidate_dictionary_bindings`, `research_formal_actual_candidate_reviews`
- `research_formal_actual_candidates`, `research_formal_actuals`, `research_governance_capital_fact_candidate_reviews`, `research_governance_capital_fact_candidates`
- `research_governance_capital_fact_versions`, `research_governance_records`, `research_guidance_event_impact_review_target_actions`, `research_guidance_event_impact_review_targets`
- `research_guidance_event_impact_reviews`, `research_industry_comparability_evidence_refs`, `research_industry_kpi_driver_bindings`, `research_industry_profiles`
- `research_industry_source_series_observations`, `research_industry_track_demand_drivers`, `research_industry_track_kpis`, `research_industry_track_profiles`
- `research_industry_track_supply_constraints`, `research_industry_track_value_chain_nodes`, `research_information_evidence_candidate_reviews`, `research_information_evidence_candidates`
- `research_investment_analysis_results`, `research_management_guidance_forecasts`, `research_market_profit_pools_typed`, `research_market_share_bridge_steps_typed`
- `research_market_share_bridges_typed`, `research_market_space_assessments_typed`, `research_market_space_estimates_typed`, `research_market_space_models`
- `research_model_review_item_actions`, `research_model_review_items`, `research_operating_analysis_routing_confirmations`, `research_operating_analysis_runner_leases`
- `research_operating_analysis_runs`, `research_operating_analysis_stage_artifacts`, `research_operating_driver_plan_years`, `research_operating_driver_plans`
- `research_operating_driver_segment_years`, `research_operating_market_evidence_refs`, `research_operating_model_contracts_typed`, `research_operating_model_growth_constraints_typed`
- `research_operating_model_segments_typed`, `research_operating_model_unit_economics_typed`, `research_operating_models_typed`, `research_operating_source_fact_binding_reviews`
- `research_operating_source_fact_bindings`, `research_operating_source_facts`, `research_owner_holding_snapshot_references`, `research_peer_comparison_dimensions`
- `research_peer_comparison_members`, `research_peer_comparison_sets`, `research_peer_universe_members`, `research_peer_universes`
- `research_relative_valuation_comparability_gates`, `research_relative_valuation_inputs`, `research_relative_valuation_ledgers`, `research_relative_valuation_metrics`
- `research_reusable_evidence_references`, `research_reverse_valuation_model_versions`, `research_risk_entries`, `research_risk_pressure_scenarios`
- `research_risk_relationships`, `research_risk_thesis_links`, `research_snapshot_module_differences`, `research_source_forecasts`
- `research_statutory_disclosure_revision_candidates`, `research_statutory_disclosure_revision_reviews`, `research_statutory_operating_candidate_provenance`, `research_theses`
- `research_thesis_evidence`, `research_us_financial_period_equivalences`, `research_user_notes`, `research_valuation_cases`
- `research_valuation_model_versions`, `research_webqa_runner_leases`, `security_aliases`, `situation_action_candidates`
- `situation_candidate_dispositions`, `situation_holding_profiles`, `situation_portfolio_rules`, `watchlist_items`

### `0118_migrate_app_kv_to_kv_cache_and_drop_app_kv.sql`

- `app_kv`

### `0119_drop_retired_local_llm_workflow_tables.sql`

- `information_processing_jobs`, `llm_run_artifacts`, `llm_runs`, `llm_scheduler_sequence`
- `llm_task_dependencies`, `llm_workflow_artifact_links`, `local_job_provider_slots`, `research_operating_analysis_jobs`
- `workflow_tasks`

### `0121_drop_local_knowledge_content_cache.sql`

- `knowledge_local_content_cache`, `knowledge_local_content_cache_chunks`

### `0122_drop_sync_jobs.sql`

- `sync_jobs`

### `0125_drop_research_identity_rights_and_statutory_disclosure.sql`

- `research_company_security_relationships`, `research_financial_availability_observations`, `research_listed_securities`, `research_market_structure_facts`
- `research_operating_companies`, `research_provider_identifiers`, `research_security_rights_links`, `research_security_rights_profiles`
- `research_statutory_disclosure_documents`

### `0126_replace_knowledge_document_versions_with_current_state.sql`

- `knowledge_document_versions`

### `0127_drop_knowledge_preprocessing_decisions.sql`

- `knowledge_preprocessing_decisions`

### `0128_drop_knowledge_run_ledgers.sql`

- `knowledge_ingest_runs`, `knowledge_processing_runs`

### `0129_drop_situation_awareness.sql`

- `situation_event_evidence`, `situation_events`, `situation_evidence`, `situation_impacts`
- `situation_knowledge_imports`, `situation_signals`, `situation_snapshots`, `situation_sources`

### `0131_drop_retired_macro_radar.sql`

- `macro_alert_history`, `macro_events`, `macro_series`, `macro_series_history`
- `macro_source_health`, `macro_user_watch_configs`

### `0142_information_records_direct_document.sql`

- `knowledge_document_results`

### `0144_rename_stock_alias_tables.sql`（证券目录改名为当前 `stock` / `stock_alias`）

- `knowledge_stock_aliases`, `knowledge_stocks`

## 同迁移内的中间表与兼容清理

此外，历史 SQL 中存在下列显式 DROP 名称；它们未出现在任何完整迁移结束
时的表集合中，主要为重建临时表与针对既有安装的 `IF EXISTS` 兼容清理。
不能据此推断用户实际数据库曾有这些表或记录：

- `_local_migrations`, `knowledge_doc_tags_old`, `knowledge_docs_old`
- `knowledge_document_results_pre_0128`, `knowledge_filtered_docs_old`, `knowledge_information_records_pre_0128`
- `knowledge_information_records_pre_0142`, `knowledge_local_content_cache_chunks_old`, `knowledge_local_content_cache_old`
- `knowledge_stock_aliases_old`, `llm_cache`, `macro_data_pre_0132`
- `macro_indicators_pre_0132`, `research_auto_filing_insights_0053`, `research_financial_statutory_verifications_old`
- `research_governance_capital_fact_versions_v1`, `research_guidance_event_impact_review_targets_v1`, `research_guidance_event_impact_reviews_v1`
- `research_model_review_items_v1`, `research_relative_valuation_inputs_legacy_0065`, `research_relative_valuation_metrics_legacy_0065`
- `securities`, `security_search_prefixes`

## 历史表引用核对与验收边界

- 采集清理中的 `knowledge_filtered_docs` 删除受 `sqlite_master` 存在检查
  保护，完整迁移后的数据库不会执行该 DELETE。
- 低层采集 writer 的旧 filtered SQL 模式在缺表时先显式拒绝，禁止重建
  `knowledge_filtered_docs` / `knowledge_filtered_doc_content_refs`。
  新维护命令 `import-filtered` 使用现有本地 review JSONL 账本。
- `feed_processing/records_backfill.rs` 先检查信息记录表是否已具备 `doc_id`，
  当前结构只访问 `knowledge_information_records`。旧
  `knowledge_document_results` JOIN 仅用于旧结构的只读预检；应用回填要求
  已迁移 0142，不能在新结构恢复旧结果表。
- 宏观旧 radar、通用本地 LLM 工作流、行式 K 线/净值/财报历史等旧表均不
  因 Rust 重构恢复；其现有业务分别使用保留的宏观双表、业务 taskd/仓库、
  原本的对象缓存存储模型，而不是新增表。
- 审计发现并已修复 `/knowledge/file?filtered=1` 动态查询历史已删
  `knowledge_filtered_docs` 的遗留路径：现在复用 file-backed review 原始
  URL lookup，不恢复表。定向回归
  `cargo test --locked --manifest-path backend/Cargo.toml --test knowledge_docs
  filtered_file_redirect_uses_review_files_after_legacy_tables_are_dropped`
  已通过（1 passed / 0 failed），显式确认旧表不存在，并覆盖成功重定向与
  缺失/非法 URL；检查后的当前结构未发现未受 schema guard 保护的旧表 SQL。

仅证明结构、消费者引用和已知退役路径，不证明真实提供方网络、模型调用、
页面、用户现有数据迁移或后台调度通过。新增/删除表的最终决定及端到端验收
由主协调器负责；本审计没有授权任何进一步数据删除。
