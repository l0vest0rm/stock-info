# stock-info 架构

## 运行时与边界

本仓库是共享业务核心的模块化单体。生产运行在 Cloudflare Worker，本地开发运行在 Node；两者复用 Hono 路由、业务模块和定时任务分发，不共享数据库实例。

```text
浏览器 → web/dist → src/app/router.ts → src/modules/* → 平台绑定与上游适配器
                         ├─ 生产：src/app/worker.ts → Cloudflare D1 / R2 / Assets
                         └─ 本地：src/platform/node/* → SQLite / 本地对象目录 / 静态文件
```

- `src/app/router.ts` 是 HTTP 路由与页面策略的装配点；`config/app/page-manifest.json` 同时约束页面构建和本地专属页面的可见性。
- `src/app/scheduled.ts` 分发生产 Worker scheduled event；本地调度器读取 `wrangler.jsonc` 中相同的 cron 定义并调用它。本地资讯处理另由 `scripts/local-supervisor.mjs` 的变更触发调度负责，不依赖生产 cron。
- `src/modules/*` 承载按领域划分的 API、应用与领域逻辑；`src/adapters`、`src/platform`、`src/db` 负责外部源及运行时能力。共享业务代码不得直接依赖本地文件系统或 Node 专有数据库实现。
- `migrations/` 是 D1 schema 来源；本地 SQLite 通过适配层执行同一套迁移。结构化索引保存在 D1/SQLite，大对象及知识正文保存在 R2/本地对象目录，页面按内容 URL 读取正文。

## 数据与任务链路

- 行情、财务、基金、宏观、知识、资讯和投资研究各由相应业务模块提供 API。股票 K 线只使用雪球；基金净值历史只使用东方财富。美股财务使用 Yahoo，且本地须经配置的代理；上游失败不静默换源。
- 知识导入在本地完成清洗、处理和入库；远端 D1/R2 发布是独立步骤。本地处理成功不代表生产可见，须分别通过生产 API 或远端存储验证。
- 资讯采集后先以 `config/knowledge/information-feed-policy.json` 的 `relevance` 和 `whitelist` 做投资相关性门禁，通过后才进入本地入库和模型提取。行业与宏观规则独立放行；公司规则只使用 `stock.information_feed_focus=1` 的证券及其 `stock_alias`，且仍须命中公司事件。新增股票默认不属于资讯重点公司，不能仅凭“净利润”等事件词放行。该标记由人工按证券代码维护，例如 `update stock set information_feed_focus=1 where code='300308.SZ'`；调整后运行 `npm run backfill:feed:relevance:dry-run` 检查影响，再运行 `npm run backfill:feed:relevance` 重评已有资讯。通过的门禁在 `feed.investmentGate` 中保存命中的主体／领域与事件关键词，资讯卡片展示记录主体，提取详情展示保留依据。提取允许以来源明确谈论的产品、技术或行业主题为主体记录有归属的行业观点，但白名单放行不强制模型产出记录。新提取合同保留旧合同的读取与发布兼容，避免既有记录因提示词变更而从资讯页消失。拒绝标题、链接与原因只追加至本地 `data/local/information-feed-relevance-rejected.jsonl`；本地资讯页可筛选复核。`config/knowledge/information-feed.json` 控制触发、每日提取上限和远端发布开关。
- `knowledge_information_records` 仅供资讯页及其提取、发布、回填和对账链路使用，不提供独立实体记录查询 API。通用知识库过期清理和黑名单过滤按 `source_type` 排除 `information_feed`，不读取资讯记录表或提取状态；其它来源不因历史提取记录而豁免清理。历史迁移保留不改写。
- 公司投资研究区分来源资料、确定性派生观察、模型草稿和用户研究结论。经营公司与上市证券不是同一对象；未经确认的映射不得把证券行情或来源记录升级为共享公司事实。

### 资讯提取合同

- `config/knowledge/knowledge-ontology.json` 是主体类型、信息类型、业务类别和期间约束的唯一目录。模型输入包含主体类型、类别中文名及必要的语义边界；`npm run build:prompts` 同时从该目录生成前端类别标签，不能单独维护另一套类别。
- 主体、信息类型、业务类别是三个独立维度。公司专属事项仍以公司为主体；行业层面的事实或判断可以“光刻胶”等明确主题为主体，不要求整篇文章没有公司名，也不另建“行业观点”类别。匿名公司的具体事项不能改挂到产品主题上。
- 类别覆盖公司指标与事件、产业经营供需及宏观经济。`production_volume` 区分实际产量与产能/出货；`operating_status` 与 `project_progress` 区分运营变化和建设节点；`inflation` 区分总体物价判断与商品价格、政策立场。新增需求、供给、库存、经济运行、财政、汇率、流动性、资源发现及交易状态后共 69 类，不增设“行业观点”等跨业务兜底。类别说明明确重叠边界，已有投资和资本开支类别允许行业合计预测，不为信息类型或主体范围另建类别。
- 白名单是相关性门禁，不是强制产出要求。提取保留原文已有的有价值分析，不生成自己的推论；无法归类的重要信息保存在待审候选中，候选不自动成为正式类别。确无有效信息才返回空结果。
- 提示词与解析器共同约束期间、类型和字段。解析失败保留失败状态及具体字段原因，不静默丢掉不合规条目或硬改类别；数值预测的原始单位、期间和口径约束保持不变。
- 当前提取合同为 `feed-tag-v8`；`information-feed-legacy-contracts.json` 冻结已产生数据的 v5/v6/v7 合同，读取和发布预览接受显式列出的历史合同。本地旧存储回填只验证 v5，不把历史结果冒充新提示词产物。新增类别不追改旧记录的类别或哈希，重提取才生成新合同记录；远端发布仍受原有独立的上线门禁约束。

## LLM 与发布隔离

远程模型调用仅允许显式 `LLM_RUNTIME=local` 的本地 Node 处理链路；生产固定 `LLM_RUNTIME=production`，只读取已物化结果或接收受控发布，不执行模型提取或回退调用。本地任务结果、远端 D1/R2 可见性和生产页面必须分别验收。

## 开发与验证入口

- 本地：`./start-local.sh` 构建前端和 Node 产物、类型检查、迁移本地 SQLite，并在 `http://127.0.0.1:8000` 提供服务；`GET /api/health` 是基础健康检查。
- 唯一保留的自动化测试：本地服务启动后运行 `npm run test:basic`，通过后端 API 验证中际旭创的日 K 线、三张财报、PE(TTM) 和市值。页面／路由与资讯链路变更另行手工验收。
- 生产：`wrangler.jsonc`、远端 D1 migration、部署脚本和真实生产 URL 分别检查；本地 Node 验证不能替代生产验证。生产只使用 Cloudflare Worker、D1、R2 和 Assets，不作为长驻 Node 服务运行。

研究输出和运行时审计属于生成物，默认写到忽略的 `reports/` 或 `data/local/`，不写入 `docs/`。
