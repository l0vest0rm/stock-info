# stock-info 架构

## 原生本地运行时

本项目是本地模块化单体，后端为 Rust / Axum / Tokio / Rusqlite。Cloudflare
部署代码和远端维护入口已删除，不存在 Node 后端或远端发布路径。
旧后端 `src/` 整树及其 TypeScript/JavaScript 实现不再保留；Git 历史可供追溯，
但不是运行时依赖。

```text
浏览器 → web/dist → backend/src/lib.rs（Axum 装配）→ Rust 业务模块
                      ├─ SQLite：现有索引、缓存、不可变账本
                      ├─ 本地对象目录：正文、PDF、市场历史快照
                      └─ 统一 HTTP / taskd 适配器 → 获授权上游
原生调度器 / CLI ────────────────────────────┘
```

- `./start-local.sh` 委托 `./start-rust.sh` 构建提示词、前端和 Rust，再 exec
  原生二进制。Node 只用于前端/提示词构建、测试编排和支持的离线分析工具。
  Rust 回归不再运行原后端 TypeScript oracle，而读取冻结的完整 JSON 历史期望。
- `backend/src/main.rs` 管理命令行、两个 loopback 监听器及优雅关闭；8000 为默认
  API/页面端口，8788 为兼容正文端口。先绑定两个端口，成功后才打开/迁移数据库。
  端口冲突不终止已有进程；退出等待被接受的业务任务与调度器收尾。
- `backend/src/lib.rs` 装配 API 与静态资源。`config/app/page-manifest.json` 约束
  页面构建与可见性；`web/dist` 提供本地静态依赖。私有 API 不挂载到正文监听器，
  正文 CORS 仅允许对应本地 API origin。
- `AppState` 共享 `Database`、`HttpClient`、项目根、authority 和 `TaskTracker`。
  后台业务通过跟踪器登记，浏览器断开不等于取消已接受的工作。

## 模块与数据合同

| 领域 | Rust 所有者 |
| --- | --- |
| 搜索、股票 K 线、基金净值、市场快照 | `market.rs`、`xueqiu.rs`、`eastmoney.rs` |
| 各市场财报、季度/TTM/普通股权益 | `finance.rs`、`finance/` |
| 公司、公告/研报、基金 | `company.rs`、`company/`、`fund.rs` |
| 滚动估值与覆盖度 | `dashboard.rs`、`dashboard/`、`coverage.rs` |
| 观察研究、不可变历史与 cohort | `observation.rs` |
| 私有组合、任务、what-if | `portfolio.rs`、`portfolio/` |
| 知识、资讯、导入、正文与维护 | `knowledge.rs`、`knowledge/`、`feed_processing/`、`maintenance.rs` |
| 研究、taskd/LLM 与原生研究 CLI | `research.rs`、`research/`、`research_cli/` |
| 宏观、期权、13F | `macro_data/`、`options.rs`、`thirteenf.rs` |
| 专题报告、PDF 工程处理 | `featured_reports.rs`、`featured_workflow.rs`、`featured_workflow/` |
| 回调、订阅、原生同步与调度 | `runtime_jobs.rs`、`sync_cli/`、`scheduler.rs` |
| 无状态离线分析 JSON 桥 | `analysis_cli.rs` |

`shared/` 仅保留前端 API 合同/类型，web 域持有前端专用校验，不再依赖旧后端
TS 源码。离线分析脚本用原生 `--analysis-json` 复用确定性计算：JSON 输入/输出，
不打开数据库、不读取凭据、不调用提供方，也不启动监听器。

HTTP 延续 `{code,msg,data}` 和既有字段语义；未知 API 为 404，退役的通用模型入口
明确拒绝而非执行旧业务。内部错误响应脱敏，不把 SQL、路径、私有记录或提供方响应泄露给客户端。

`db.rs` 在阻塞线程中执行 SQLite；历史 SQL 按文件名排序，选择、执行和
`user_version` 递增同属迁移事务。156 个历史文件产生 14 张表，无新增表、删表或迁移
跟踪表。详见 [结构审计](rust-schema-audit.md)。`users` / `auth_sessions` 不再有
Rust 消费者，但未擅自删除历史账户与会话。

`kv_cache` 不只是缓存：`observation-ledger-v1` 与
`private-active-portfolio-v1` 是 null expiry 的永久账本。版本写入须不可变、事务化
并保留 CAS；不能用普通缓存 upsert 或整表清理替代。私有数据仅允许 loopback Host
和同源请求，不得进入公开配置、前端 bundle 或推送发布。

## 数据源与本地对象

- 股票 K 线只用雪球，基金净值历史只用东方财富。Yahoo 只用于美股财报与期权；
  美股财报经配置代理，不作为其他行情或市场的兜底。无有效雪球 Cookie 时明确失败。
- `http.rs` 统一超时、按域并发、代理和缓存；提供方响应验证先于缓存持久化。
  非成功响应只保留有界的内部校验信息，不在日志/错误格式化中泄露响应体。
- `storage.rs` 提供路径/符号链接边界检查及原子对象写入。市场对象和知识正文使用
  各自本地目录；数据库和文件系统不是一个原子事务，孤儿对象需按引用和保留期审计，
  不能因此删除永久账本。
- 外部导入使用独立 Bearer secret 的 `POST /api/internal/knowledge/import`。
  导入方负责授权、相关性与来源身份；服务端验证、计算稳定版本 ID 与 SHA-256，
  ≤4 KiB 纯文本存 SQLite 内联列，长正文先落本地对象再写数据库引用。重试幂等，
  原文变更产生新版本；来源原文不冒充模型提取记录或已验证事实。
- 历史文件提取/回填与外部原文导入是不同合同。原生订阅回调与本地工程处理入口
  保持各自认证、原始输入和去重边界，不把回调交付直接升级为已处理知识。

## 调度与研究隔离

`config/app/local-runtime.json` 是 UTC cron 唯一来源。Rust 调度器执行财报补齐、
每分钟观察池及宏观任务，同时对账已提交任务。观察池 GET 只读；HTTP refresh 至多
处理 2 个到期证券，cron 每次至多 12 个，共享 SQLite lease/fencing 限制全局同时
计算 2 个。计算时间、依赖 revision、来源日期分别保留，不制造共同估值日。

启动时先验证/必要时刷新雪球 Cookie；定期主动更新，失败按重试间隔处理。
`LOCAL_SCHEDULER=0` 可关闭调度器，`XUEQIU_COOKIE_REFRESH=0` 可关闭其凭据维护，
隔离测试应显式选择，不能把关闭调度后的 API smoke 当作调度验收。

只有显式 `LLM_RUNTIME=local` 才允许模型工作。配置凭据不自动启用模型，GET 和
历史结果读取不应提交模型任务。taskd 提交、恢复、结果对账、配额与模型草稿的状态
不能混同为用户研究结论；必须分别验证。没有自动远端发布或真实交易执行。

PDF 工程处理可调用独立安装的 Python / PyMuPDF 和经审查的 PDF cleaner，
不使用 Node 业务运行时。清理器显式路径优先，缺失失败，不以原文直通替代；处理
审计记录输入/输出与处理器哈希。安装和发现规则见 [README](../README.md)。

### 资讯提取合同

- `config/generated/information-records-contract.json` 保存当前和允许读取的历史提取合同；
  由 `npm run build:prompts` 生成，保持原始合同版本/哈希，Rust 直接消费 JSON，
  不再从后端生成 TypeScript 中解析。移动文件不是重写历史合同或改变记录来源的理由。
- `config/knowledge/knowledge-ontology.json` 是主体类型、信息类型、业务类别和期间约束的唯一目录。模型输入包含主体类型、类别中文名及必要的语义边界；`npm run build:prompts` 同时从该目录生成前端类别标签，不能单独维护另一套类别。
- 主体、信息类型、业务类别是三个独立维度。公司专属事项仍以公司为主体；行业层面的事实或判断可以“光刻胶”等明确主题为主体，不要求整篇文章没有公司名，也不另建“行业观点”类别。匿名公司的具体事项不能改挂到产品主题上。
- 类别覆盖公司指标与事件、产业经营供需及宏观经济。`production_volume` 区分实际产量与产能/出货；`operating_status` 与 `project_progress` 区分运营变化和建设节点；`inflation` 区分总体物价判断与商品价格、政策立场。新增需求、供给、库存、经济运行、财政、汇率、流动性、资源发现及交易状态后共 69 类，不增设“行业观点”等跨业务兜底。类别说明明确重叠边界，已有投资和资本开支类别允许行业合计预测，不为信息类型或主体范围另建类别。
- 白名单是相关性门禁，不是强制产出要求。提取保留原文已有的有价值分析，不生成自己的推论；无法归类的重要信息保存在待审候选中，候选不自动成为正式类别。确无有效信息才返回空结果。
- 提示词与解析器共同约束期间、类型和字段。解析失败保留失败状态及具体字段原因，不静默丢掉不合规条目或硬改类别；数值预测的原始单位、期间和口径约束保持不变。
- 历史文件处理链路的当前提取合同以 `config/knowledge/information-feed.json` 的 `tagContract` 和生成的合同为准；`information-feed-legacy-contracts.json` 显式列出可读取的历史合同。本地旧存储回填不把历史结果冒充新提示词产物。新增类别不追改旧记录的类别或哈希，重提取才生成新合同记录；不再提供远端发布流程。

## 工程与验收

- `npm run check:rust`：格式、严格 clippy 与隔离 Rust 回归。
- `npm run check:rust-routes`：原路径合同及原生路由装配守卫。
- `npm run check:no-new-tables`、`check:runtime-boundaries`：结构与本地运行边界。
- `npm run typecheck`、`check:web-assets`：前端/共享合同类型与本地资源。
- `npm run test:basic`：保留完整断言，对真实运行中的 API 验证市场/财报/估值及
  前瞻引用，前置隔离账本、缓存和并发回归。上游不可用应诊断，不应删减断言。

`backend/tests/fixtures/README.md` 和 provenance 清单说明冻结期望来源。机会评估与
screen/PIT 分别保留完整 343 和 65 组输入/期望，Rust 保持完整字段、数组长度与数值
容差断言，不因删除 TS oracle 而只比子集。其他既有 JSON goldens 同样保留；
不得用被测 Rust 实现重生成期望。旧未挂载工作台和已退役表的无消费者应用代码删除，
不构成新增数据库表或恢复旧 API 的理由。

按 [迁移验收说明](local-rust-migration.md) 区分隔离合同、真实上游、页面和后台证据。
单次健康检查或模块测试不证明完整业务，也不证明真实模型、长期配额和所有外部源可用。
测试不得迁移/删除用户真实数据库；研究结果和审计生成物写入忽略目录。
代码清理没有删除或下线既有云资源，也不授权清空用户数据。忽略的 `.dev.vars`、
`.wrangler` 本地数据、SQLite、对象文件和既有研究报告必须保留，不以工具名称判定可删。
