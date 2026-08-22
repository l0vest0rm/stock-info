# 数据表梳理与收缩评审清单

> 最近核验：2026-08-19（本地 SQLite 快照；`PRAGMA user_version=136`）
>
> 目标：按用户可见页面与后台功能说明每张**当前存在**的数据表的职责，并给出可共同评审的保留、删除或优化方向。本文同时记录已实施迁移与已批准但尚未实施的删除，状态以本地 schema、迁移和当前源码为准。
>
> 证据：`data/local/stock-info.sqlite` 的 `sqlite_master`、`dbstat`、行数；`src/**`、`scripts/**`、`web/src/**` 的当前引用；迁移 `0119_drop_retired_local_llm_workflow_tables.sql` 至 `0128_drop_knowledge_run_ledgers.sql`。`web/dist` 不作为运行时证据。

## 先看结论

- 当前本地库有 **23 张业务表**；表页合计约 **414.7 MiB**，索引约 **4.8 MiB**，SQLite 文件本身约 **465 MiB**（其中还会包含空闲页及 WAL 状态）。`0120` 至 `0128` 已删除 18 张历史缓存、运行日志、研究身份、版本和预处理留痕表。问题首先是缓存体积和生命周期，不是“研究表数量”本身。
- `http_cache` 单表约 **356.4 MiB（约 86% 的表页）**。它是可再生 HTTP 缓存，应该优先建立按来源/用途的 TTL、大小预算和淘汰任务；不能删掉表或全量清空来代替缓存策略。
- `kv_cache` 约 **19.4 MiB**，已承担多个业务结果投影（公司研报、财务/投资分析、信息处理检查点）。保留该表，但要把 namespace、TTL、单键大小和清理责任写成明确契约，防止再次成为无边界通用存储。
- `sync_jobs` 已由 `0122` 删除。每种同步只使用一个固定 `kv_cache` key：宏观为 `sync_state/macro-data`，财务预告为 `sync_state/financial-provisional`；财务的分来源/报告期续跑游标是后者 JSON 的 `checkpoints` 成员，不再占用独立 key。
- 本地知识正文已只保存在 `KNOWLEDGE_CONTENT_BUCKET`（本地文件系统 / 生产 R2）。重复的 `knowledge_local_content_cache` / `_chunks` 已由 `0121` 删除。
- 态势模块存在一条需要深入评审的重复投影：`knowledge_docs`、`situation_knowledge_imports`、`situation_evidence` 当前均为 3,835 行；每个导入均指向一个证据，证据 URL 与知识文档 URL 3,835/3,835 相同。它可能是合理的“独立证据领域模型”，也可能是双写冗余；在确认未来是否需要非知识库来源证据前，**不能直接删除** `situation_evidence`。
- 现有 `0119` 已明确删除已退役的本地 LLM/队列账本；当前本地库已经没有这些表。新库/远端是否已应用该迁移必须作为部署核验项，不能从本地快照推断。

## 评审口径

| 标记 | 含义 |
| --- | --- |
| 保留 | 当前页面/API 或后台业务直接依赖，职责清晰。 |
| 优化 | 表继续保留，但要补生命周期、容量、索引或写入边界。 |
| 评审候选 | 有可验证的重叠、仅离线脚本使用或可再生属性；先完成列出的验证，再决定迁移。 |
| 已计划删除 | 已有迁移明确删除，且现行源码无生产者/消费者；仍需单独核验迁移覆盖。 |
| 已实施删除 | 迁移已存在且当前本地 schema 不含该表；仍须按环境核验远端 D1。 |
| 已批准、待实施 | 已获删除/收敛决定，但当前 schema 或源码仍依赖；不得按已删除处理。 |

以下“体量”是最近核验时本地 `dbstat` 的表页大小，不含其索引；“入口”列既包含页面，也包含只在后台/脚本中运行的功能。

## 最新 schema 状态核验

| 分类 | 表 | 当前本地状态 | 依据 |
| --- | --- | --- | --- |
| 已实施删除 | `securities`、`security_search_prefixes` | 不存在 | `0120_drop_security_discovery_cache.sql`；`sqlite_master` 无匹配表。 |
| 已实施删除 | `knowledge_local_content_cache`、`knowledge_local_content_cache_chunks` | 不存在 | `0121_drop_local_knowledge_content_cache.sql`；`sqlite_master` 无匹配表。 |
| 已实施删除 | `sync_jobs` | 不存在 | `0122` 已应用；同步状态和游标已分别收敛到各类型唯一的 `kv_cache` JSON。 |
| 已实施删除 | 9 张 `research_*` 身份、权利与法定披露表 | 不存在 | `0125_drop_research_identity_rights_and_statutory_disclosure.sql` 已应用。 |
| 已实施删除 | `knowledge_document_versions` | 表不存在；有同名当前状态视图 | `0126` 清理全部历史处理数据；视图每篇已处理文档最多一行，不存版本历史。 |
| 已实施删除 | `knowledge_preprocessing_decisions` | 不存在 | `0127` 已删除；准入判断不再保存为状态或跳过账本。 |
| 已实施删除 | `knowledge_processing_runs`、`knowledge_ingest_runs` | 不存在 | `0128` 已删除；批量游标及清理状态改为各类型固定 `kv_cache` JSON。 |
| 仍是评审候选 | `knowledge_stock_aliases`、`situation_evidence` | 存在 | 尚未获删除决定，需先验证替代契约和恢复需求。 |
| 保留 / 优化 | 其余 23 张当前业务表 | 存在 | 仍有明确页面/API/后台职责；按各节的容量与生命周期建议治理。 |

## 页面 / 功能到表的总览

| 页面或功能 | 主要表组 |
| --- | --- |
| 首页、全局搜索、公司入口 | 上游证券建议接口，以及通用 `http_cache` / `kv_cache`；本地 `securities` 与 `security_search_prefixes` 已删除 |
| 公司详情、公司研报、投资分析、财务与行业研究 | `knowledge_*` 文档和结构化结果、`kv_cache` 业务结果投影；原 `research_*` 身份/证券权利/法定披露能力已删表，残留接口须下线或改造 |
| 信息整理、知识文档弹窗、公司新闻/研报文档 | 全部 `knowledge_*` 表 |
| 宏观页 | 全部 `macro_*` 表 |
| 态势感知、持仓、机会、证据、事件详情 | 全部 `situation_*` 表，输入来自 `knowledge_docs` |
| 抓取、同步、外部 HTTP、运行状态 | `http_cache`、`kv_cache`；不对应独立前台页面 |

## 一、通用平台与缓存

| 表 | 当前数据 | 页面 / 功能 | 作用 | 评审结论 |
| --- | ---: | --- | --- | --- |
| `http_cache` | 2,533 行 / 356.4 MiB | 所有外部抓取与同步 | 以 `cache_key` 保存 URL、请求方法、响应状态/头/正文和过期时间，减少重复外部请求。 | **优化，P0**：保留。按调用方/来源定义 TTL 与最大体积，定期删除已过期正文并记录命中率；先统计最大 `url`/调用方，再决定是否把超大正文迁往对象存储。 |
| `kv_cache` | 987 行 / 19.4 MiB | 公司研报、财务/投资分析、信息处理后台 | `namespace + key` 的通用业务结果投影；保存 JSON、过期时间和更新时间。 | **优化，P1**：保留。为每个 namespace 注册 owner、JSON schema、TTL、单值上限与清理任务；可承载受 TTL 约束的业务运行审计，但禁止重建 taskd 内部任务账本或写入无期限原始大文本。 |
| `sync_jobs` | 已删除 | 财务预告、宏观数据等后台同步 | 曾记录每次同步任务的状态、起止时间、错误和统计，但没有读取方、状态查询 API 或恢复逻辑。 | **已实施删除**：`0122` 删除该表。每个同步类型只覆盖写一个 `kv_cache` JSON；财务状态、统计和全部来源/报告期游标都在 `sync_state/financial-provisional` 的同一值中。 |

## 二、证券身份与搜索

| 表 | 当前数据 | 页面 / 功能 | 作用 | 评审结论 |
| --- | ---: | --- | --- | --- |
| `securities` | 已删除 | 首页搜索、公司页、财务页、研究页 | 曾是已发现证券的非权威 write-through 缓存。 | **已实施删除**：`0120_drop_security_discovery_cache.sql` 已删除该表；运行时已改为使用上游建议接口，当前 `sqlite_master` 无此表。 |
| `security_search_prefixes` | 已删除 | 首页和顶部证券搜索 | 曾为 `securities` 预计算前缀候选与优先级的派生索引。 | **已实施删除**：随 `securities` 由 `0120` 删除；当前 `sqlite_master` 无此表。 |

## 三、知识文档与信息整理

### 文档主数据、检索关系与内容定位

| 表 | 当前数据 | 页面 / 功能 | 作用 | 评审结论 |
| --- | ---: | --- | --- | --- |
| `knowledge_docs` | 3,835 行 / 11.0 MiB | 信息整理、知识文档弹窗、公司页研报/资讯、研究页 | 文档目录与展示元数据：来源、标题、URL、时间、证券、摘要、访问方式和排序信息。 | **保留**：知识域主实体；清理应通过文档生命周期，而不是孤立删附属表。 |
| `knowledge_doc_content_refs` | 3,359 行 / 1.3 MiB | 文档详情、信息处理、研究取证 | 将文档连接到内容键/URL、编码、大小及 SHA-256，不直接承载正文。 | **保留**：内容存储定位与完整性边界。 |
| `knowledge_doc_security_links` | 1,284 行 / 72 KiB | 文档按公司筛选、公司页和研究取证 | 多对多连接文档与证券代码。 | **保留**：不能用 `knowledge_docs.target_code` 替代，因为一篇文档可关联多证券。 |
| `knowledge_doc_tags` | 10,798 行 / 648 KiB | 文档筛选、信息整理 | 多对多文档标签。 | **保留，观察索引**：标签量正常；若筛选变慢，再核验 `(tag, doc_id)` 查询计划。 |
| `knowledge_stock_aliases` | 2,414 行 / 156 KiB | 导入脚本的公司名到证券代码解析 | 导入时使用的本地别名词典，不直接供页面/API 查询。 | **评审候选，P2**：先确认导入脚本仍需要“来源化别名”语义；若只需搜索别名，应合并进可重建的搜索/证券别名契约。不可因为页面未直读就删。 |

### 版本、处理链路和结构化产物

| 表 | 当前数据 | 页面 / 功能 | 作用 | 评审结论 |
| --- | ---: | --- | --- | --- |
| `knowledge_document_versions` | 已删除（视图） | 信息整理 API 兼容读取 | 曾保存历史正文版本。现为 `knowledge_docs` 当前处理哈希的只读视图，每篇文档最多一行。 | **已实施删除**：`0126` 清理 598 条历史版本及其处理数据，不再保存旧正文版本。 |
| `knowledge_preprocessing_decisions` | 已删除 | 信息整理预处理 | 曾记录去重、过滤和模板命中决定。 | **已实施删除**：`0127` 删除表；同样的准入判断在单次处理内计算，不再留存。 |
| `knowledge_processing_runs` | 已删除 | 信息整理 | 曾记录每次模型调用的模型、提示词、状态和原始输出定位。 | **已实施删除**：`0128` 后调用 ID 只在请求中存在，不保存 run 或原始输出。 |
| `knowledge_document_results` | 0 行 | 信息整理 | 当前运行的总体结果壳，记录 outcome。 | **保留，当前状态**：不再关联历史版本。 |
| `knowledge_information_records` | 0 行 | `information-processing.html`、研究事实提取 | 当前处理结果提取的实体、指标、期间、报表和预测测量。 | **保留**：历史已按决定清理；重新处理后生成当前记录。 |
| `knowledge_ingest_runs` | 已删除 | 导入、清理与存储审计脚本 | 曾按每次执行追加状态、统计和错误。 | **已实施删除**：`0128` 后每种维护任务以其类型为 key 覆盖写入 `kv_cache/knowledge_maintenance` JSON。 |

### 本地内容缓存

| 表 | 当前数据 | 页面 / 功能 | 作用 | 评审结论 |
| --- | ---: | --- | --- | --- |
| `knowledge_local_content_cache` | 已删除 | 本地导入与历史 chunk 读取路径 | 曾是 SQLite 副本的元信息与编码/哈希；同一内容的定位和校验信息已在 `knowledge_doc_content_refs`，正文在本地对象文件中。 | **已实施删除**：`0121_drop_local_knowledge_content_cache.sql` 与 chunks 同时删除。 |
| `knowledge_local_content_cache_chunks` | 已删除 | 曾供信息处理、两处本地研究抽取 | 曾按 `content_key + chunk_index` 保存 Base64 正文。其 3,411 个 key 与本地文件系统 3,411 个文件完全一一对应。 | **已实施删除，P1 完成**：所有读取改为 `KNOWLEDGE_CONTENT_BUCKET`；导入/API 双写和启动物化均已移除，并由 `0121` 删除两表。 |

## 四、宏观页与宏观同步

| 表 | 当前数据 | 页面 / 功能 | 作用 | 评审结论 |
| --- | ---: | --- | --- | --- |
| `macro_series` | 25 行 / 12 KiB | `macro.html` | 宏观指标目录、地区/频率/单位、来源、传导关系和启用状态。 | **保留**：宏观模块配置主表。 |
| `macro_series_history` | 20 行 / 1.9 MiB | `macro.html` 的修订/历史视图 | 每个指标的版本化观测历史 JSON。 | **优化，P2**：保留历史语义，但 20 行占 1.9 MiB；定义每指标最大 vintage 数和压缩/归档策略，防止单 JSON 行无界增长。 |
| `macro_events` | 303 行 / 76 KiB | `macro.html` 日历 | 宏观事件的时间、地区、重要性、预期/实际/前值和来源。 | **保留**。 |
| `macro_source_health` | 9 行 / 4 KiB | `macro.html` 状态、后台同步 | 数据源探测结果、连续失败与下次重试。 | **保留**：运行状态，不应被当作历史事件表。 |
| `macro_user_watch_configs` | 1 行 / 4 KiB | `macro.html` 自选/告警设置 | 用户/owner 对指标的关注、排序、告警与展示偏好。 | **保留**：用户配置。 |
| `macro_alert_history` | 4 行 / 4 KiB | `macro.html` 告警历史 | 已计算告警、阈值、通知状态和来源。 | **保留，优化**：定义告警审计保留期，避免与 watch 配置混在一起无限累积。 |

## 五、公司研究身份、权利与法定披露

这九表已由 `0125` 从本地 schema 删除。原来服务 `company-research.html`、`company-finance.html`、`investment-analysis.html` 和研究 API 的源码仍有直接 SQL 引用；这些入口尚未清理，触发时会因缺表失败，必须下线或改造成现有数据源后才能恢复使用。

| 表 | 当前数据 | 页面 / 功能 | 作用 | 评审结论 |
| --- | ---: | --- | --- | --- |
| `research_operating_companies` | 已删除 | 公司研究身份 | 曾保存公司规范身份、报告币种、财年结束日与身份状态。 | **已实施删除**：源码清理待完成。 |
| `research_listed_securities` | 已删除 | 公司/行业研究 | 曾保存公司实体到上市证券的映射。 | **已实施删除**：源码清理待完成。 |
| `research_company_security_relationships` | 已删除 | 公司研究 | 曾保存有有效期的公司—证券关系事实。 | **已实施删除**：源码清理待完成。 |
| `research_provider_identifiers` | 已删除 | 研究抓取适配 | 曾保存 provider 外部标识。 | **已实施删除**：源码清理待完成。 |
| `research_financial_availability_observations` | 已删除 | 财务分析/自动归档 | 曾保存财务报表可用性观测。 | **已实施删除**：源码清理待完成。 |
| `research_security_rights_profiles` | 已删除 | 公司研究的股权/权利结构 | 曾保存证券权利档案。 | **已实施删除**：源码清理待完成。 |
| `research_security_rights_links` | 已删除 | 公司研究的股权/权利结构 | 曾保存证券之间的 ADR、转换或权利关系。 | **已实施删除**：源码清理待完成。 |
| `research_market_structure_facts` | 已删除 | 公司研究、行业研究 | 曾保存可溯源的市场结构事实。 | **已实施删除**：源码清理待完成。 |
| `research_statutory_disclosure_documents` | 已删除 | 法定披露导入、公司研究 | 曾保存法定披露索引。 | **已实施删除**：源码清理待完成。 |

## 六、态势感知

| 表 | 当前数据 | 页面 / 功能 | 作用 | 评审结论 |
| --- | ---: | --- | --- | --- |
| `situation_sources` | 2 行 / 4 KiB | 态势同步、状态展示 | 态势来源配置与健康状态。 | **保留**：态势输入边界。 |
| `situation_evidence` | 3,835 行 / 3.8 MiB | `situation-evidence.html`、事件详情 | 可引用证据的 URL、标题、摘要、哈希、来源、实体、等级和原始内容键。 | **评审候选，P1**：当前全部来自 `knowledge:selected-feed`，且与知识文档一一映射。先确认是否保留独立外部证据入口；若不保留，可让知识文档为真相源，仅保留态势所需投影/链接。 |
| `situation_knowledge_imports` | 3,835 行 / 456 KiB | 知识→态势同步 | 每个知识文档的导入状态、对应 evidence ID、原因和首次发现时间。 | **保留，随上项共同评审**：它是幂等同步检查点；若移除独立证据表，需要改为 `doc_id` 直接驱动的处理状态，不能单独删除。 |
| `situation_events` | 660 行 / 548 KiB | `situation.html`、事件详情 | 归并后的事件：规范键、时间、地区、类型、重要性、摘要和首次/最近发现时间。 | **保留**：态势事件主实体。 |
| `situation_event_evidence` | 661 行 / 84 KiB | 事件详情证据链 | 事件与证据多对多关系，含角色和置信度。 | **保留**：即使证据底座收敛，关系表仍需要。 |
| `situation_signals` | 5,424 行 / 8.3 MiB | 态势首页、持仓/机会 | 规则版本对主体的打分、置信度、输入和解释，以及过期时间。 | **优化，P1**：保留。按 `expires_at` 清除失效信号，并按 scope/rule 只留可展示的近期历史；其 JSON 是第二大态势存储。 |
| `situation_impacts` | 6,627 行 / 1.3 MiB | 态势首页、持仓/机会 | 事件/信号对公司、证券或组合的方向、传导、置信度和理由。 | **优化，P2**：保留。随事件/信号过期或归档；核验失效 impact 是否仍被 API 读取。 |
| `situation_snapshots` | 5,763 行 / 9.3 MiB | 态势首页、持仓、机会 | 指定时点和范围的态势状态、摘要和规则版本。 | **优化，P1**：保留。按 scope 设置快照密度与保留期；这是最大态势表，应避免每次同步全量重复 JSON。 |

## 已退役的本地 LLM / 队列表

这不是“当前 36 张表”中的一部分。`migrations/0119_drop_retired_local_llm_workflow_tables.sql` 已将以下表定义为已退役：

- `llm_workflow_artifact_links`、`llm_task_dependencies`、`llm_run_artifact_links`、`llm_run_artifacts`、`llm_runs`、`workflow_tasks`、`llm_scheduler_sequence`、`local_job_provider_slots`
- `information_processing_jobs`、`research_operating_analysis_jobs`

迁移注释与当前路由一致：本地通用 LLM scheduler 已返回 410；请求内业务直接处理，异步任务由 taskd 管理，业务结果投影到 `kv_cache`。本地当前 schema 已不含这十张表。

**本地状态：已实施删除。** `0119` 已在当前本地 schema 生效；部署前仍要逐环境核验远端迁移是否已应用、taskd 投影是否存在、以及无遗留 SQL 读写，不能从本地状态推断远端已完成。

## 推荐的 review 顺序

1. **`sync_jobs` 收敛：已完成。** `0122` 删除该表，`0123`、`0124` 将旧财务游标合并并清理。`sync_state/macro-data` 与 `sync_state/financial-provisional` 分别是宏观和财务的唯一状态 key，后者 JSON 包含全部游标。后续只需为 `http_cache`、`kv_cache`、`situation_signals`、`situation_snapshots`、`macro_series_history` 补 owner、TTL、容量上限、清理任务和观测指标。
2. **决定态势证据模型：** 明确是否永远需要独立于知识库的外部证据来源。若答案是否定的，设计一次迁移，把 `situation_evidence` 收敛为 `knowledge_docs` 的投影/视图契约，同时迁移 `situation_event_evidence` 的引用；若答案是肯定的，则保留两表并消除当前重复字段的双写。
3. **证券发现缓存删除：已完成。** `securities` 与 `security_search_prefixes` 已由 `0120` 删除，运行时已改用上游建议接口；仍需在部署时核验远端 D1 迁移。
4. **收敛本地知识正文：已完成。** 本地 `KNOWLEDGE_CONTENT_BUCKET`/文件系统已成为唯一正文源；`knowledge_local_content_cache` 与 `_chunks` 的读写、启动物化和双写已移除，并由 `0121` 删除两表。
5. **审计脚本专用表：** `knowledge_ingest_runs` 已收敛为 `kv_cache` 当前状态；继续对 `knowledge_stock_aliases` 的真实调用和恢复需求做一次运行级验证，再决定是否删除。
6. **完成研究域代码清理：** 九张 `research_*` 身份、证券权利和法定披露表已由 `0125` 删除，但当前源码仍有直接 SQL。将对应接口明确下线或改造成现有数据源，并做目标页面/API 验证；在此之前不可把这些能力视为可用。

## 防回归规则

- 禁止再采用“本地空表即删”的规则。空表可能是新功能、远端数据、首次运行前状态，或仍被运行时合约依赖。
- 每张新表或新增 namespace 必须同时写明：产品/API owner、主键与真相源、可再生性、保留期、容量预算、清理 owner、以及本地/Cloudflare D1 的迁移和验证方式。
- 删除任何表之前，必须完成：当前源码读写审计、远端 D1 schema 与行数核验、历史数据迁移/归档方案、以及目标页面/API 的真实行为验证。
