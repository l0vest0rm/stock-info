# stock-info

本地股票信息与投资研究站。后端为 `backend/` 中的原生 Rust 应用（Axum / Tokio /
SQLite），前端为 Vue / Vite。**不再部署 Cloudflare**；没有 Node 后端代理或业务兜底。
旧后端 `src/`、Cloudflare 代码及后端 TypeScript/JavaScript 实现已移除；Node 仅用于
前端、提示词构建、测试编排和支持的离线分析工具，后端目录不保留 JS/TS 实现。

## 本地运行

需要 Rust 工具链与 Node.js 26.10.0；不再依赖相邻 `shared-ts` 工作区或 Cloudflare 工具链。

```sh
npm install --include=dev --no-audit --no-fund
./start-local.sh
```

- 默认页面/API：`http://127.0.0.1:8000`；知识正文兼容端口：`http://127.0.0.1:8788`。
- `start-local.sh` 与 `start-rust.sh` 使用同一原生后端，构建提示词、页面和 Rust 后直接
  exec 二进制。构建前检查两个端口，先用 SIGTERM 停止本 checkout 的旧原生实例，最多等待
  30 秒优雅退出；超时不强杀，其他服务占用则报错。CLI 命令不停止服务。
  Ctrl-C 请求优雅退出并等待已接受任务。
- 默认只监听 loopback，不提供远程登录服务。`/api/health` 返回运行时与 SQLite 健康状态，
  不代表提供方凭据、模型服务或所有业务都可用。
- 静态资源来自 `web/dist`，Bootstrap、ECharts、Marked 等页面依赖随本地构建提供，
  不依赖运行时 CDN。源码变更后需要重建。

### 数据与凭据

SQLite 使用 `LOCAL_DB_PATH`，否则为 `LOCAL_DATA_DIR/stock-info.sqlite`，默认
`data/local/stock-info.sqlite`。市场对象默认位于数据目录的 `market-data/`，正文对象
默认位于 `knowledge-content/`；分别可用 `LOCAL_MARKET_DATA_DIR` 和
`KNOWLEDGE_CONTENT_LOCAL_DIR` 覆盖。启动脚本会兼容检测已有的旧正文缓存位置，
迁移验证时请显式指定独立目录，避免触及原有对象。

保留全部 156 个历史迁移及 `user_version` 协议，不增加迁移记录表。本次没有新增或删除表；
最终 14 张表与消费者见 [表结构审计](docs/rust-schema-audit.md)。`kv_cache` 同时包含缓存
和永久研究/私有组合账本，不能整表清空。未使用的账户表也未擅自删除。

凭据放在忽略提交的 `.dev.vars`、环境变量及本地 credential store，不能写入版本化配置、
命令参数或日志。启动脚本显式设置 `LLM_RUNTIME=local`；直接执行原生二进制时必须显式
设置该值才能运行模型任务。本地运行不等于离线：行情、财报、官方来源、CEA 网页研究和模型
仍依赖可用网络、代理及授权凭据。

### 直接模型 API

所有直接 API 调用（资讯提取、主题审核、研报提取/翻译、基金研究）统一读取
`config/app/llm.json`：`deepseek-v4.1-flash`、`http://127.0.0.1:9470/v1`、
`chat_completions`，凭据仅从 `ROUTING_API_KEY` 环境变量读取（也可放在忽略的
`.dev.vars`）。旧的 OPENAI/FUND_RESEARCH/KNOWLEDGE_PROCESS 路由覆盖和 Codex
认证文件不再用于这些调用，避免误用旧模型或凭据；各功能原有启用开关不变。

协议适配、文本历史转换、SSE/终止证据和模型一致性检查在共享原生
`../input-helper/input-gateway/crates/llm-client/src/direct.rs`，不在业务层区分模型。
切回 GPT 只需修改此 JSON 中的模型、地址、凭据环境变量名和协议
（`responses` 或 `chat_completions`），然后执行 `npm run build:prompts` 并构建/重启。
该生成步骤同步资讯提取模型指纹，并在版本化生成清单中保留旧模型的完整提取合同；
不要删除生成清单后重新生成。已完成翻译检查点保留，不冒充新模型输出。

宏观/财务/投资分析和研报发现改为 **本机 CEA SDK workflow 直接执行**，不再连接
taskd，不使用上述直接 API 配置。请先启动已安装的本机 CEA Server，并在所选持久
Profile 登录 ChatGPT。默认端点 `ws://127.0.0.1:9876/api/v1/ws`，可用 `CEA_ENDPOINT`
覆盖；Profile 可用 `LOCAL_WEB_RESEARCH_PROFILE` 覆盖。

`config/app/web-research.json` 单独配置网页模型、模型菜单位置和思考强度，YAML 在
`config/workflows/chatgpt-research.yaml`。模型菜单位置仅用于定位，发送前必须精确
读回模型名及思考强度；不匹配就失败，不默默换模型。当前配置选 `GPT-5.6 Sol`。
原生 SDK 新增的通用 `text_equals`/`text_contains` 谓词随相邻 CEA 源码构建，不要求
替换正在运行的 CEA Server。

执行记录与租约保存在现有 `kv_cache`，不新增数据库表。网页结果仍写入原有业务
namespace；每次运行的冻结 YAML、输入、SDK checkpoint 与结果位于私有
`LOCAL_DATA_DIR/web-research/` 和执行记录中。`LOCAL_SCHEDULER=0` 仅关闭 cron，
不关闭用户明确提交任务的执行器。页面关闭不停止执行；后端退出会停止本地动作，
重启后从已确认 checkpoint 续执行，已提交动作不自动重放。

本机执行诊断：`GET /api/research/web-workflows/{runId}`；恢复及停止分别为同路径的
`POST /resume`、`POST /cancel`。停止不撤回 ChatGPT 已收到的请求。执行 ID 与模型
来源不混用：旧 taskd 报告保留，旧在途任务须人工核对，不能转成新的 CEA 任务。
私有执行文件不由内容监听器公开提供，也不自动发布报告。
数据库字段、状态机和验收边界见 [本机网页研究](docs/local-web-research.md)。

`npm run check:llm` 验证配置切换/历史保留、两种协议、流式终止及禁止重放。
真实模型烟测只发送合成 JSON 请求，使用临时数据库，不提交网页研究任务：

```sh
LLM_RUNTIME=local cargo test --locked --manifest-path backend/Cargo.toml --test llm_runtime real_configured_llm_stream_and_json -- --ignored
```

### 雪球 Cookie 与数据来源

股票 K 线只使用雪球，基金净值历史只使用东方财富。Yahoo 只用于美股财报及期权，
美股财报使用配置的 Yahoo 代理；不得作为股票 K 线或其他市场数据的备用源。

```sh
npm run refresh:xueqiu-cookie
```

此命令使用本机 Chrome CDP，在保存前验证真实雪球 K 线，写入忽略的 `.dev.vars` 与
本地 credential store。默认使用临时 profile 的可见 Chrome；`XUEQIU_CDP_URL` 可指定
已有可见 CDP Chrome，`XUEQIU_CHROME_HEADLESS=1` 仅供诊断，不能假设能通过雪球防护。
启动时验证凭据，默认每三小时主动刷新，失败五分钟后重试；失效会明确失败而不换源。

### PDF 与专题报告依赖

PDF 渲染、提取和专题报告清理需要 Python 3、PyMuPDF，以及单独安装并审查的
`attachments-to-markdown` skill（保留其脚本、配置和相关资源，不只复制单个脚本）。
清理器依次查找相邻 `skills/attachments-to-markdown/scripts/clean-pdf.py` 和用户
`.codex/skills`、`.agents/skills`、`git/skills` 下的同路径。
`FEATURED_PDF_CLEANER=/absolute/path/to/clean-pdf.py` 可显式指定；指定路径无效时不再回退。
缺少清理器会明确失败，不跳过清理。清理审计保留处理器路径/哈希，原始正文、页码和证据可追溯。

## 功能与命令

完整业务接口由 Rust 模块提供：证券搜索、行情与财报、公司与基金、公告/研报发现、
观察池与估值、不可变研究历史、私有组合及 what-if、知识库/资讯、宏观研究、期权、
13F/机构持仓、专题报告、CEA 网页研究/模型任务与后台调度。接口延续现有 `{code,msg,data}` 契约。
私有组合和研究编辑仅允许本机同源访问，不对外发布；确认操作不是交易执行。

| 操作 | 入口 |
| --- | --- |
| 本地服务 / 原生 CLI 帮助 | `./start-local.sh` / `./start-rust.sh --help` |
| 仅迁移本地数据库 | `npm run db:migrate:local` |
| 手动执行一轮后台任务 | `npm run dev:cron:once` |
| 知识增量 / 历史全量 / 资讯处理 | `npm run process:knowledge` / `./process-knowledge-local-full.sh` / `npm run process:feed` |
| 资讯对账 / 相关性回填预览 | `npm run reconcile:feed:dry-run` / `npm run backfill:feed:relevance:dry-run` |
| 证券身份同步 | `npm run sync:csi-stock-universe`、`sync:sp500-stocks`、`sync:hk-popular-stocks`、`sync:asia-popular-stocks` |
| 研究 | `npm run research:earnings`、`research:fund-quarterly`、`analyze:buy-point` |
| 存储检查 / 正文清理预览 | `npm run stats:knowledge:storage` / `npm run cleanup:knowledge:content:local:dry-run` |
| PDF 元数据回填预览 | `npm run backfill:knowledge:pdf-metadata`（默认 dry-run；确认后追加 `-- --apply`） |

PDF 元数据回填的 `--db-file PATH` 只接受已存在的 SQLite，不会创建或迁移该指定库。

修改型命令应先查看帮助和 dry-run；维护删除需要显式 `--apply`。研究输出写入忽略的
`reports/` 或 `data/local/`。所有支持入口仅操作本地数据，不提供远端迁移、上传、部署或自动发布。

离线分析脚本需要估值筛选、PIT 或快照比较等共享计算时，通过原生 `--analysis-json`
桥传递纯 JSON；桥不打开数据库、不读取凭据、不请求提供方，也不启动 HTTP 服务。
前端 API 类型位于 `shared/`，前端专用校验留在 web 域，不复用已删除的后端 TS 模块。

Cron 配置唯一来源是 `config/app/local-runtime.json`，时区 UTC；Rust 进程内调度器
执行财报补齐、滚动观察池、宏观与结果对账等任务。关闭页面不会取消后台任务。
知识处理的自动化开关来自 `config/knowledge/knowledge-processing.json`，默认关闭；
手动处理和模型调用仍需明确授权及运行环境。

## 验证

```sh
npm run check:rust             # 格式、严格 clippy、Rust 隔离回归
npm run check:rust-routes      # 原路由合同与原生装配守卫
npm run check:no-new-tables
npm run check:runtime-boundaries
npm run typecheck
npm run check:web-assets
npm run test:basic             # 另一个终端中，对运行中的本地 API 验证
```

`test:basic` 编排原生隔离账本/缓存/并发检查，以及 `300308.SZ` 的真实 K 线、三张财报、
PE(TTM)、市值及研报前瞻引用检查。它需要有效雪球 Cookie、财报/研报上游与已有历史数据；
不得删减断言或编造缓存以获得通过。`BASIC_TEST_BASE_URL` 可指定独立验收端口。
隔离测试不代表真实模型、所有市场提供方、长期调度配额或全部页面交互已经验收。

验证时使用独立端口、数据库及对象目录，不能为测试迁移、清空用户真实数据库。
实现与验收边界见 [Rust 迁移说明](docs/local-rust-migration.md)、[架构](docs/architecture.md)
及 [项目指令](AGENTS.md)。旧后端差分期望已冻结为完整 JSON fixture，保留来源版本与
哈希，Rust 测试不依赖 Node 或旧后端源码；不能用当前 Rust 输出重写期望值。
云部署/远端维护源码与依赖已删除，本次没有删除或下线任何既有云资源。

## 研究与业务说明

- [观察池主数据](config/investment-universe.json)、[每日复盘规则](docs/investment-daily-review-playbook.md)、[维护指南](docs/investment-universe-usage.md)
- [私有组合工作流](docs/active-portfolio-workflow.md)
- [AI 产业细分赛道图谱](docs/AI产业细分赛道中美上市公司图谱_美国代码更新版_2026-08-09.md)
- [按公司组织的长期研究档案](docs/company-research/README.md)（首例：[亨通光电 600487.SH](docs/company-research/600487.SH/README.md)）
- [光纤光缆行业供需与价格研究](docs/industry-research/optical-fiber/README.md)（数据、预测与未核验线索分开管理）

历史提交中的云部署流程不再受支持。旧部署工具产生的本地数据、忽略的凭据和既有研究报告
不属于待删源码，不能因代码清理而删除。
观察池输出是带独立计算时间和来源日期的滚动读模型，不是共同估值日回测，也不是买卖建议。

### Embedded acquisition

The Rust backend embeds the shared `../sub2me/crates/acquisition` crate. Acquisition runs in-process and writes to the existing `LOCAL_DB_PATH`; no extra service/database or automatic model/publication task is created. Only three acquisition control tables are required; results use existing `knowledge_docs` through replacement `RecordStorage`, without `acquisition_records`. See [task configuration and explicit Sub2Me handoff](config/acquisitions/README.md). New tasks start paused; an explicit handoff preserves the source task status.
