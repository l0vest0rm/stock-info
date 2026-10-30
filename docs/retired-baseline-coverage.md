# 删除旧后端后的 basic 验收覆盖

`npm run test:basic` 不再编译、导入或执行旧后端 TS/JS。测试入口仍是 Node 编排，
先串行运行下列 **Rust 实现**的隔离回归，再保留原有真实运行中 API 断言。
测试编排不是业务实现，也不启动 Node 后端；任何 Cargo 失败、零测试、忽略测试、
缺失套件回执均使 basic 失败。所有隔离写入使用测试创建的临时 SQLite/对象目录。

## 原检查到原生检查的映射

| 原检查 | 原生验收归属 |
| --- | --- |
| spot identity、绝对市值、交易所日期、无效 symbol/currency/cap/time | `dashboard_cache::quote_contract_preserves_exchange_date_absolute_units_and_rejects_wrong_identity`；`retired_baseline_contract::stock_quote_rejections_and_hong_kong_exchange_date_keep_basic_contract` |
| HTML/null/缺字段/失效 Cookie/提供方错误，缺 Cookie 不可读缓存或发网络 | `retired_baseline_contract` 的 quote rejection 与独立子进程 missing-cookie 测试 |
| 真实 SQLite GET 只读、单标的 single-flight、全局两槽、fresh reuse/batch no-op、revision 过滤、fencing/takeover、异常释放、过期回收、HTTP batch≤2、research version 失效 | `dashboard_cache::real_sqlite_cache_leases_fencing_reuse_and_research_revision`，并补有真实路由、cron≤12/并发≤2、请求断开不取消工作回归 |
| 行业路径、缺失/过期/重复/非法证据、场景算术与稀释、无效输入、review 门禁、捕获后入场、成熟/缺 benchmark/不可用数据 | `observation::{every_industry_missing_data_fails_closed_and_evidence_is_reviewed,scenarios_match_earnings_model_and_reject_invalid_inputs,forward_returns_start_after_capture_and_missing_data_remain_null}` |
| research CAS/concurrent write、immutable history/cohorts、永久存储、冻结成熟 outcome | `observation::immutable_history_cas_and_daily_cohorts` 及 `reviewed_records_require_industry_and_scenario_evidence` |
| research 私有 Host/Origin、本地路由、非法 code、content type、版本查询、CAS 409 | `observation::version_routes_body_validation_and_conflict_status` 和 `observation_integration::assembled_editor_is_local_same_origin_read_only_and_versioned` |
| portfolio 现金/FX/全分母、公司多上市合并、39 上限、风险阈值、stale/future/revision、semantic task identity/data gate | `portfolio_contract::differential_typescript_domain_fixtures_preserve_complete_outputs_and_task_ids` 的完整冻结输出及原生验证测试 |
| portfolio 快照字段/日期/币种/重复项/负数，proposal 锁定 date/rules/price/FX、NAV/turnover/funding/cost/不改实仓 | `portfolio_contract::{snapshot_validation_rejects_invalid_dates_fields_fx_and_duplicates,proposal_locks_date_rules_price_and_fx_and_does_not_mutate_snapshot}` 及完整冻结 comparisons |
| portfolio GET 只读、CAS/并发、immutable 永久 namespace、decision 不移除风险、伪造/defer/trade 拒绝、snapshot version/history | `portfolio_contract::ledger_get_is_read_only_and_cas_is_immutable_across_concurrent_writes` |
| portfolio proposal separate/stale funding/basis、unknown cost 不可确认、确认不是成交 | `portfolio_contract::proposal_decisions_are_separate_from_actual_holdings_and_validate_funding_and_basis` |
| portfolio 私有 Host/Origin/Sec-Fetch-Site、no-store、415/413、history | `portfolio_contract::routes_keep_read_privacy_content_type_size_and_history_contracts` |
| opportunity 原 17 组规则、每次 scenario/quality/seasonality/workflow/signal/price/forward 调用的完整输出 | `retired_baseline_contract::every_original_basic_opportunity_and_valuation_call_keeps_its_full_output`；另运行 `dashboard_domain_opportunity` 的更大政策矩阵 |
| 研报预测发布日期锚定、保存提取优先、缺日期/空值不可猜年份，提供方标识/LLM字段脱敏、未授权客户端不得得到链接 | `retired_baseline_contract::report_forecasts_keep_publication_years_and_unauthorized_clients_never_receive_links`；运行中原研报 EPS/来源/API 调用断言原样保留 |
| 估值档位 9 个边界（包括 NaN）、安全边际下限、无历史不伪造、auxiliary/blocked 不可估值、yield 反算 | 同上，保留全部 9 次 band、4 次 assess 完整比较 |

已退役的 Cloudflare 环境开关断言由“无 Cloudflare 后端/部署代码”的工程守卫替代；
本地私有 Host/Origin/内容类型/账本权限并未移除。原云匿名研报 projection 模式已退役，
本地授权客户端可读规范 reportUrl；非本地 Host 或跨 Origin 客户端整个请求 403 且 data=null，
不会得到链接或可重建链接的标识。脱敏检查仍覆盖本地 projection，未新增匿名运行时 API。Rust 应用的运行身份检查保留在真实
`/api/health` 验收中，不能用 TypeScript APP_RUNTIME fixture 冒充原生执行。

## 固定 fixture 的来源与边界

`backend/tests/fixtures/retired-baseline.json.gz` 是**数据**，不含可执行旧业务源码。
在删除源码前，以 `9ebbeef` 中原 basic 估值边界和原机会规则 checker 运行全部原始
断言并捕获，原 17 组规则全部通过，记录 **87 次完整输入/输出**：9 band、4 assess、
70 opportunity、4 price。fixture 内含原 checker/实现/config 的 SHA-256 与来源 commit。
仅移除不可比较的 `assess.computedAt`（原生仍断言为有效 RFC3339），NaN 经 JSON 编码为
null 并在原生边界比较时还原为 `f64::NAN`。比较覆盖完整对象字段与数组长度，不只取几个
“看起来正确”的字段；数值采用原差分测试的明确浮点容差。

这是本地隔离回归的覆盖映射，不是运行中 API、真实提供方、模型或长期 cron 的新通过记录。
真实 K 线/三表/公司 PE 和市值/研报引用/滚动看板/私有工作区的原 API 断言仍由 basic
在运行中服务上执行，不能通过冻结 fixture 跳过这些调用。
