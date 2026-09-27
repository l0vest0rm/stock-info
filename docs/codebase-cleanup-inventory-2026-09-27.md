# 代码库功能与可达性盘点（清理前基线）

盘点日期：2026-09-27。范围：仓库跟踪的页面源码、`scripts/` 与仓库根目录可执行脚本、`*.test.*` 测试，以及 Worker／本地 Node 的定时入口。**这是代码与构建契约盘点，不等于生产流量统计或删除清单。** 未登录生产站点、未执行远端写入；“可达”指路由和构建策略允许，不保证上游数据、凭证及任务服务可用。

> **后续清理记录（2026-09-27）**：本文件保留删除前的盘点快照，便于追溯清理依据。已按确认删除 `/knowledge-config.html`、`/index.html`、`/index-position.html` 及旧 `knowledge-news-page` 的页面入口、组件、专属 runtime／导航／配置；同步移除知识采集配置／执行占位 API 与指数持仓空数组 API。现行 `/news.html` 资讯流、`/api/kline`、基金页面、知识采集 CLI／scheduler 均保留。清理后 manifest 为 **31 页（公开构建 25、本地专用 6）**；下文 34 页表格是清理前基线，不是当前页面清单。

## 0. 判定口径与关键结论

依据：`config/app/page-manifest.json` 是 HTML 和 JS 构建输入；`web/scripts/page-build-config.mjs` 按 `runtime` 过滤；`src/app/router.ts` 处理首页重定向、登录、仅本地页和精选研报鉴权；`web/src/config/navigation.json` 控制菜单；`src/app/scheduled.ts`、`src/platform/node/local-cron.ts`、`scripts/local-supervisor.mjs` 与两份 `config/knowledge/*.json` 控制定时作业。`verify:architecture` 会发现全部单元测试（排除 smoke/live/e2e 命名）。

| 盘点项 | 结果 |
|---|---|
| 页面 | Manifest **34** 页：`runtime=all` 27 页、`runtime=local` 7 页。生产构建只产出 27 页；本地构建产出全部 34 页。`/` 提供首页，直接 `/home.html` 为 301 到 `/`。 |
| 页面内“有代码但看不到” | `web/src/modules/research/components/` 的 **23** 个旧研究工作台组件未被任何页面入口引用；其 `/api/research/...` 细粒度请求多数也没有对应当前路由。`web/src/modules/knowledge/pages/knowledge-news-page.ts` 与其兼容入口 `web/src/pages/knowledge-news-page.ts` 没有 manifest 页面入口，不是现在的 `/news.html`。 |
| 旧调用 | `web/src/analysis-task-queue.ts` 中的 `/api/report/analyze` 无现行后端路由；其类虽由旧页面注册器动态构造并传入上下文，但 `company-pages-runtime.ts` 只声明字段、未调用，属于高可信不可运行链。 |
| 定时 | Worker 有 2 个启用 cron；本地 Node 重用这 2 个 cron，另有 15 秒 taskd 结果协调、资讯源监听／财联社轮询及雪球 Cookie 刷新。知识采集 cron **配置禁用**；资讯远端自动发布 **配置禁用**。 |
| 脚本／测试 | `scripts/` 根目录 66 个非测试 `.mjs`，`scripts/lib/` 34 个非测试模块；根目录 12 个 `.sh`，`scripts/preflight-cloudflare-release.sh` 1 个，`scripts/extract-featured-report.py` 1 个；全仓 148 个 `*.test.*`（scripts 45、src 89、web/src 14）。npm 别名／回测参数组合不算新的实现文件。 |

**状态标记**：`公开`＝生产构建且路由可请求；`本地`＝生产构建剔除并由 Worker 路由拒绝；`生产专用`＝本地路由拒绝；`入口缺失`＝没有 manifest 构建入口；`非菜单`＝可能由其他页面链接或手输 URL 进入，不能据此判为废弃。`all` 页面仍可能因数据源、权限或本地任务边界而只有部分子功能可用。

## 1. 页面维度

### 1.1 全页面、子功能和后端接口

表中接口均加 `/api` 前缀；`C` 表示共用接口，见表后解释。列表为页面实际入口及其 legacy runtime 的静态调用链，不把未挂载的旧研究组件算进去。查询参数略。`POST` 特别注明；其余默认 GET。

| 页面 | 可见／可达状态 | 页面子功能 | 调用后端接口（含共用） |
|---|---|---|---|
| `/home.html`（实际 `/`） | 公开；直接文件 URL 301；主菜单首页 | 功能导航、研究路径、标的／研报码入口；本地才显示资讯引导 | 无页面专属 API；全局搜索见 C |
| `/macro.html` | 公开；主菜单 | 宏观指标目录、分类筛选、概览和时间序列、宏观分析报告；本地可刷新／恢复／同步任务 | `/macro/catalog`、`/macro/overview`、`/macro/series`、`/macro/analysis`；本地 POST `/macro/analysis/{refresh,resume,sync}`；C |
| `/companies-filter.html` | 公开；公司菜单 | 条件筛选、分页排序、关注切换、近 90 天研报数、指标图表 | `/companies/filter`、`/companies/report/cnt`、`/kline`、`/code/name`；C |
| `/companies-change.html` | 公开；公司菜单 | 今日／5 日／10 日涨跌排名、板块 | `/companies/change`；C |
| `/sector-flow.html` | 公开；公司菜单 | 板块资金流与领涨股 | `/sector/flow`；C |
| `/companies-holding.html` | 公开；公司菜单 | 机构持仓排名、报告期／排序筛选 | `/companies/holding/rank`；C |
| `/institutional-tracks.html` | 公开；公司菜单 | 机构 Top300 行业分类、机构评级、估值／回撤／涨幅筛选、个股估值详情 | `/company/info`、`/company/overview`、`/finance/balance`、`/finance/income`、`/finance/dividendyield`、`/report/forecast`、`/knowledge/docs`、`/kline`；C。页面还读取本地静态快照 JSON，不是 API |
| `/companies-follow.html` | 公开；公司菜单 | 浏览器本地关注名单、风险预算／止损配置、业绩预测、行情与财务汇总 | `/companies/follow/forecast`（本地路由；生产不提供写入）、`/company/overview`、`/report/forecast`、`/kline`、`/finance/income`、`/code/name`；C |
| `/company.html` | 公开；个股菜单 | K 线、复权、估值与分红叠加、区间表现表、对比标的 | `/kline`、`/company/info`、`/finance/income`、`/finance/sharechange`、`/finance/dividendyield`、`/code/name`；C |
| `/investment-analysis.html` | 公开；个股菜单 | 12 章投资研究报告、目录／来源／任务状态、工程输入；本地刷新／恢复／同步 | `/research/company/:code/investment-analysis`、本地 POST 同路径 `/{refresh,resume,sync}`；页面行情摘要另用 `/company/overview`、`/kline`、`/finance/income`、`/finance/sharechange`；C |
| `/company-finance.html` | 公开；个股菜单 | 财务指标图表、同比／环比、报表比较、财务分析报告；本地刷新／恢复／同步 | `/finance/{income,balance,cashflow}`、`/research/company/:code/financial-analysis`、本地 POST 同路径 `/{refresh,resume,sync}`；`/kline`；C |
| `/company-holders.html` | 公开；个股菜单 | 十大流通股东季度对比、机构持仓 | `/finance/freeholders`、`/finance/orgholders`；C |
| `/company-dividend.html` | 公开；个股菜单 | 分红事件／股息率、增发明细、事件日价格 | `/finance/dividendyield`、`/finance/sharebonus`、`/finance/shareadditional`、`/kline`；C |
| `/company-shares.html` | 公开；个股菜单 | 限售解禁、总股本和股份结构变动 | `/company/restriction`、`/finance/sharechange`；C |
| `/company-notice.html` | 公开；个股菜单 | 公告分类／时间筛选、公告链接、公司调研 | `/company/notices`；C |
| `/company-report.html` | 公开；个股菜单；**无 legacy 页入口** | 研报列表与预测／估值字段、知识文档预览；研报发现／流式进度仅本地可用 | `/company/reports`、本地 `/company/reports/discovery-capability`、`/company/reports/stream`、POST `/company/reports/discover` 与 `/company/reports/discover/sync`、`/knowledge/doc`、`/knowledge/file`；C。`/report/url` 后端仍仅返回 `null` |
| `/funds.html` | 公开；主菜单 | 基金类型／公司筛选、基金排行／分页 | `/fund/rank`、`/fund/companies`；C |
| `/fund.html` | 公开；基金菜单 | 净值／价格走势、基本资料、复权与日期区间 | `/fund/info`、`/kline`（基金 `.OF` 为净值历史，非股票 K 线）；C |
| `/fund-position.html` | 公开；基金菜单 | 基金季度持仓对比、ETF 成分、资产配置、份额变化、与重仓股价格走势 | `/fund/position`、`/fund/asset-allocation`、`/fund/constituents`、`/fund/share-change`、`/kline`、`/code/name`；C |
| `/fund-notice.html` | 公开；基金菜单 | 基金公告分类、列表和原文链接 | `/fund/notices`；C |
| `/fund-compare.html` | 公开；基金菜单 | 多基金／ETF 可比数据对照 | `/fund/compare`；C |
| `/index.html` | 公开；标的类型对应指数菜单；非主菜单 | 指数 K 线、复权、对比、比率和起点对齐 | `/kline`、`/code/name`；C |
| `/index-position.html` | 公开；指数菜单 | 指数调仓日期、成分股新旧期对比 | `/index/positionDates`、`/index/position`；C |
| `/13f.html` | 公开；主菜单 | 13F 机构列表、管理规模、进入季度持仓 | `/13f/manager/list`；C |
| `/13f-position.html` | 公开；**非菜单**，由 13F 页进入 | 机构季度选择、持仓及股数／价值变化、标的走势 | `/13f/quarters/:id`、`/13f/position/:filingId`、`/kline`、`/code/name`；C |
| `/featured-report.html` | 公开构建；**生产需登录**；主菜单 | 输入研报码、原 PDF／翻译／摘要阅读 | `/featured-reports/:code`；登录态由 `/auth/me` 等认证流程维护；C |
| `/login.html` | **生产专用**；不在菜单 | 登录、忘记密码／重置密码、登出相关会话 | `/auth/me`、POST `/auth/{login,logout,password-reset/request,password-reset/confirm}`。本地 Node 对该页返回 404 |
| `/news.html` | **本地**；本地主菜单 | 资讯卡片、状态／标签／时间筛选、故事详情；不是旧知识新闻页 | `/knowledge/feed`、`/knowledge/feed/facets`、`/knowledge/feed/story`；C |
| `/company-news.html` | **本地**；本地个股菜单 | 公司资讯／研报知识卡片、收藏、文档弹窗 | `/knowledge/docs`、`/knowledge/doc`、`/knowledge/file`；C |
| `/company-trade.html` | **本地**；本地个股菜单 | K 线技术买卖建议、建仓／持仓／卖出场景与执行价位 | `/kline`；C |
| `/company-option.html` | **本地**；本地个股菜单 | 美股期权链、构造及比较策略组合 | `/options/us/summary`、`/options/us/contracts`；C |
| `/company-option-theta.html` | **本地**；本地个股菜单 | 合约时间价值／Theta 表、到期区间筛选和重算 | `/options/us/summary`、`/options/us/contracts`；C |
| `/option-strategy.html` | **本地**；本地主菜单 | 期权腿录入、组合到期收益曲线、本地保存与加载、标的搜索／价格刷新 | `/search`、`/kline`；C。组合主要保存在浏览器端 |
| `/knowledge-config.html` | **本地、非菜单**；手输 URL 可达 | 旧知识采集配置表单、来源状态和手动触发控件；**保存／触发接口只返回 `not-migrated`，并不执行** | `/knowledge/ingest-config` GET/POST、POST `/knowledge/ingest-run`；C |

**C：跨页共用链路**：顶部标的搜索／建议使用 `/suggest`、`/search`、`/code/name`（具体由布局和旧控件选择）；个股／基金／指数信息条借助 `/company/info`、`/fund/info`、`/kline`、`/finance/income`、`/finance/sharechange` 等。不能把“所有页面共享布局”误读为每页一定发送全部请求；请求依页面类型、当前标的与控件触发。`/api/health` 是运维探针，不是页面子功能。

### 1.2 有代码但不可见／不可运行的重点

| 代码位置 | 静态证据 | 当前判断／清理前要核实 |
|---|---|
| 7 个 `runtime=local` 页面及其 JS | 生产构建过滤且 `router.ts` 对其路径返回 404；本地菜单才显示本地项 | **非废弃**，只是环境隔离。删除会影响本地投研工作流；先确认是否仍要保留本地产品。 |
| `web/src/modules/knowledge/pages/knowledge-news-page.ts`、`web/src/pages/knowledge-news-page.ts` | Manifest 的 `/news.html` 入口是 `information-feed-page.ts`；旧组件仅被兼容入口导入，兼容入口不在构建输入 | 高可信旧页残留；先检查历史书签或外部构建工具，再删。 |
| `web/src/modules/research/components/*.ts`（23 个） | 当前 `investment-analysis-page.ts` 只渲染 Markdown 报告；`research.routes.ts` 明确只发布投资／财务分析读写合同；工作台组件无页面入口引用 | 高可信**不可见旧工作台**。其中细粒度 `research/company/...`、`research/industry/tracks` 请求不会命中现行 API；评估依赖后可成组清理。不要误删当前研究 domain/application/read-model。 |
| `web/src/analysis-task-queue.ts` | 旧注册器创建实例，但当前 company runtime 仅在 context 类型声明，不调用；脚本向不存在的 `/api/report/analyze` POST | 高可信失效队列 UI／调用；应连同注册器的注入一起清理，不应为了保留它重加生产 LLM 路由。 |
| `/knowledge-config.html` 的配置／执行控件 | `src/modules/local-data/api/local-data.routes.ts` 的 POST 保存固定返回 `{saved:false, reason:'not-migrated'}`，POST 执行固定返回 `{started:false, reason:'not-migrated'}`；GET 给出静态默认配置／空来源 | **页面可达但主要操作无效**，比仅“隐藏”更明确。清理或重做之前确认是否还有本地使用者；不能把它描述成实际采集调度控制台。 |
| `web/src/pages/*.ts` 与 `web/src/*-runtime.ts`、`web/src/{api,layout,chart,date,format,table}.ts` 等顶层转发文件 | 多数只重新导入／导出 `modules/` 或 `platform/`；manifest 入口已指向模块路径 | **兼容壳**，不是独立页面。逐一查全仓及外部脚本引用后可清理；不要按文件数重复算页面。 |
| `/report/url`、`/knowledge/filtered*` 与若干本地写入 API | 路由仍存在，某些只有旧页／导入脚本调用；`/report/url` 当前固定 `null` | “没有菜单”不等于可删 API；需查 CLI、远端客户端和数据迁移调用。尤其知识过滤 API 不应仅按前端未用删除。 |

## 2. 脚本维度

### 2.1 可执行功能脚本（`scripts/` 根目录 66 个）

表内每个文件出现一次；“手动”表示无 npm 别名但可直接运行，不等于废弃。配置／诊断工具列在这里而不是测试表。`scripts/generated/*` 是构建产物，不单独执行。

| 类别 | 文件 | 作用／触发 |
|---|---|---|
| 构建与边界 | `build-prompts.mjs`、`build-node-local-runtime.mjs` | 生成提示词模块；打包本地 Node server/cron。由 `build:*` 调用。 |
| 构建与边界 | `check-no-inline-prompts.mjs`、`check-no-new-tables.mjs`、`check-no-wrangler-local.mjs`、`check-runtime-boundaries.mjs`、`check-release-inputs.mjs`、`verify-architecture.mjs` | 提示词、建表白名单、本地不能依赖 Wrangler、运行时／页面分界、发布输入锁与全量架构／单测门禁。 |
| 构建与边界 | `verify-page-artifacts.mjs`、`apply-remote-migrations.mjs`、`local-db.mjs` | 检查本地／生产页面产物；应用远端 D1 迁移；本地 SQLite 迁移。 |
| 本地运行 | `local-supervisor.mjs`、`local-knowledge-content-server.mjs`、`knowledge-ingest-scheduler.mjs`、`information-feed-scheduler.mjs`、`run-with-bounded-log.mjs` | 本地 HTTP／调度托管、知识内容服务、知识采集 cron、资讯文件监听／CLS 轮询、限量日志包装。前两类由 `start-local.sh` 链接；知识采集当前配置禁用。 |
| 市场／研究 | `analyze-buy-point.mjs`、`analyze-institutional-stop-loss.mjs`、`earnings-research.mjs`、`fund-quarterly-research.mjs` | 买点分析、机构重仓股止损报告、业绩预告估值研究、基金季报研究。后两个有 npm 入口；止损脚本仅手动入口。 |
| 市场／研究 | `generate-institutional-track-snapshot.mjs`、`classify-institutional-track-snapshot.mjs`、`sync-institutional-track-keywords.mjs`、`sync-eastmoney-company-em2016-profiles.mjs` | 生成／重分类机构赛道静态快照、同步关键词和东方财富公司资料。快照供页面读取；不是定时任务。 |
| 回测 | `backtest-current-institutional-top100-reduce-add.mjs`、`backtest-institutional-top100-risk-rules.mjs`、`backtest-multi-asset-allocation.mjs` | 机构持仓减仓／加仓网格、多风险规则、跨资产配置回测；`package.json` 的 Top100/300 与 3/5 年别名只是同一实现的不同参数。第二个仅手动入口。 |
| 新闻／知识采集 | `fetch-cls-news.mjs`、`fetch-eastmoney-reports.mjs`、`process-knowledge-once.mjs`、`process-knowledge-local-full.mjs`、`filter-existing-knowledge-docs.mjs` | 财联社快讯、东财研报采集；一轮文档解析／筛选／入本地库；全量本地运行；对已有文档重新过滤。采集链由 `process-knowledge.sh` 串联，但其自动 cron 当前禁用。 |
| 新闻／知识导入 | `import-knowledge-docs.mjs`、`import-knowledge-docs-remote.mjs`、`import-knowledge-docs-remote-latest.mjs`、`import-filtered-knowledge-docs.mjs`、`import-filtered-knowledge-docs-remote.mjs`、`import-filtered-knowledge-docs-remote-latest.mjs` | 普通／人工筛选知识文档入库，本地与远端及“最新批次”包装。远端可触及 D1/R2，默认不要以清理脚本试跑。 |
| 知识存储治理 | `cleanup-knowledge-docs.mjs`、`cleanup-knowledge-content.mjs`、`migrate-localfs-knowledge-content.mjs`、`backfill-knowledge-pdf-metadata.mjs`、`report-knowledge-storage.mjs`、`seed-knowledge-sample.mjs` | 文档／内容清理、旧本地文件转 R2、PDF 元数据补录、占用报告、测试数据种子。清理可 dry-run；不是默认自动保留策略。 |
| 资讯处理 | `information-feed.mjs`、`publish-information-feed.mjs`、`reconcile-information-feed-local.mjs`、`backfill-information-feed-relevance.mjs`、`backfill-information-records.mjs` | 本地资讯提取／标注、向远端发布、重复卡片修复、相关性重评、旧信息记录迁移；资讯处理由本地 scheduler 触发，远端自动发布目前关闭。 |
| 精选研报 | `prepare-featured-report.mjs`、`extract-featured-report.py`（另见下节）、`publish-featured-report.mjs` | PDF 清洗／提取、翻译摘要与审阅、人工确认后上传 R2 并提交远端索引；使用根目录 `.sh` 包装。 |
| 凭证与发布 | `refresh-xueqiu-cookie.mjs`、`refresh-eastmoney-cookie.mjs`、`sync-xueqiu-secret.mjs`、`sync-mail-secrets.mjs`、`verify-cloudflare-token.mjs`、`report-cloudflare-observability.mjs` | Cookie 刷新、Worker secret 同步、令牌校验和云端观测报告。雪球刷新由本地 supervisor 自动触发；同步 secret 属部署运维，不是 cron。 |
| 临时诊断／审计 | `audit-local-runtime.mjs`、`run-route-1-final-report-doubao-stream.mjs` | 只读本地运行证据审计；对固定 300308.SZ/Route 1 提示词的豆包流式实验。后者依赖本地诊断输入，未挂 npm／生产任务，应列入优先复核候选。 |
| 验收与测试入口 | `smoke-pages.mjs`、`smoke-release.mjs`、`smoke-featured-reports.mjs`、`verify-investment-analysis-read-model.mjs`、`test-information-records.mjs` | 页面／发布／精选研报在线 smoke、投资分析读模型验证、信息记录测试聚合器；需要目标环境或测试条件。 |

另有独立根脚本：`start-local.sh`（标准本地构建、迁移、启动、健康等待），`deploy-cloudflare.sh`（架构验证、生产构建、Wrangler dry-run、远端迁移／部署），`rollback-cloudflare.sh`（Worker 版本回滚），`process-knowledge.sh`、`process-knowledge-local-full.sh`、`process-information-feed-local.sh`（采集／处理包装与本地 LLM 标记），`import-knowledge-docs-remote-latest.sh`、`import-filtered-knowledge-docs-remote-latest.sh`（远端批次包装），`cleanup-knowledge-local.sh`、`cleanup-knowledge-remote.sh`（**直接 apply** 的清理包装），`prepare-featured-report.sh`、`publish-featured-report.sh`（精选研报构建／发布包装）。此外 `scripts/preflight-cloudflare-release.sh` 验证发布前条件，`scripts/extract-featured-report.py` 负责 PDF 文本／页面提取。

前端构建脚本另在 `web/scripts/`：`page-build-config.mjs` 校验 manifest 并按 local/production 选择页面；`build-html.mjs` 展开 HTML 局部模板、复制静态资源并生成 robots/sitemap；`build-vue-pages.mjs` 将布局、Vue 页面及过渡 legacy runtime 合为 Vite 入口；`build-legacy-pages.mjs` 只是指向 Vue 构建的**兼容入口**。`web/vite.layout.config.ts` 是开发服务器配置，不是独立业务作业。`data/local/runtime/server.mjs` 与 `cron.cjs` 是 `build-node-local-runtime.mjs` 生成的本地运行产物，不应按源码手工编辑。

### 2.2 `scripts/lib/`：34 个被复用的功能模块，不是独立任务

| 模块组 | 文件（省略 `scripts/lib/` 前缀） | 作用 |
|---|---|---|
| 投研／行情 | `buy-point-analysis.mjs`、`earnings-research.mjs`、`fund-quarterly-research.mjs`、`institutional-track-classification.mjs`、`local-company-code-resolver.mjs` | 计算、模型化及代码归一化，供同名 CLI／页面快照生成使用。 |
| Cookie／外部内容 | `xueqiu-cookie.mjs`、`eastmoney-cookie.mjs`、`eastmoney-report-content.mjs`、`cls-news.mjs` | Cookie 验证／提取、东财研报内容与 CLS 快讯规范化。 |
| 精选研报 | `featured-report-batches.mjs`、`featured-report-cleaning.mjs`、`featured-report-files.mjs`、`featured-report-local.mjs`、`featured-report-review.mjs`、`featured-report-selection.mjs` | 翻译分批、PDF 清洗、文件／校验、本地登记、审阅服务、正文选择。 |
| 资讯 | `information-feed-company-candidates.mjs`、`information-feed-dedupe.mjs`、`information-feed-extraction.mjs`、`information-feed-rejection-audit.mjs`、`information-feed-relevance.mjs`、`information-feed-source.mjs`、`information-feed-window.mjs` | 公司候选、去重、提取、拒绝审计、相关性、来源、时间窗规则。 |
| 信息记录 | `information-records-backfill.mjs`、`information-records-fixture.mjs`、`information-records-publication-plan.mjs`、`information-records-publish.mjs`、`information-records-reconcile.mjs`、`information-records-store.mjs` | 信息记录迁移、测试夹具、发布计划、发布／对账／存储。 |
| 知识导入 | `knowledge-filename-parser.mjs`、`knowledge-import-sync.mjs`、`knowledge-stock-alias-statements.mjs`、`knowledge-topic-filter.mjs` | 文件名、导入一致性、股票别名 SQL、主题过滤。 |
| 本地基础设施 | `local-d1-sqlite.mjs`、`local-runtime-request.mjs` | 本地 D1/SQLite 适配与请求适配。 |

脚本根目录另有被主脚本导入而非独立运行的 `knowledge-content-r2.mjs`、`knowledge-defaults.mjs` 和 `information-feed-scheduler.mjs`；表 2.1 按文件位置列出，但清理时按调用链判断。`scripts/generated/information-records-contract.mjs`、`scripts/generated/prompt-text.mjs` 随构建产生，不应手工修改。

### 2.3 测试脚本（全仓 148 个）

| 位置／数量 | 覆盖功能与完整文件名（省略列首路径前缀） |
|---|---|
| `scripts/` 根，15 | 架构／配置／发布边界：`architecture-contracts.test.mjs`、`check-no-inline-prompts.test.mjs`、`check-no-new-tables.test.mjs`、`check-no-wrangler-local.test.mjs`、`config-layout.test.mjs`、`local-node-bindings.test.mjs`；精选研报提取：`extract-featured-report.test.mjs`；资讯／信息记录：`information-feed-import-guard.test.mjs`、`information-feed-publish-guard.test.mjs`、`information-feed-relevance-gate.test.mjs`、`information-feed-scheduler.test.mjs`、`information-records-migration.test.mjs`；知识：`knowledge-cleanup-boundary.test.mjs`、`knowledge-ingest-scheduler.test.mjs`、`knowledge-stock-aliases.test.mjs`。 |
| `scripts/lib/`，30 | 投研／源：`buy-point-analysis.test.mjs`、`cls-news.test.mjs`、`companies-follow-stop-loss.test.mjs`、`earnings-research.test.mjs`、`eastmoney-cookie.test.mjs`、`eastmoney-report-content.test.mjs`、`fund-quarterly-research.test.mjs`、`institutional-track-classification.test.mjs`、`kline-drawdown.test.mjs`、`xueqiu-cookie.test.mjs`；精选研报：`featured-report-batches.test.mjs`、`featured-report-files.test.mjs`、`featured-report-local.test.mjs`、`featured-report-selection.test.mjs`；资讯：`information-feed-company-candidates.test.mjs`、`information-feed-dedupe.test.mjs`、`information-feed-extraction.test.mjs`、`information-feed-rejection-audit.test.mjs`、`information-feed-relevance.test.mjs`、`information-feed-source.test.mjs`、`information-feed-window.test.mjs`；信息记录：`information-records-backfill.test.mjs`、`information-records-publish.test.mjs`、`information-records-reconcile.test.mjs`、`information-records-store.test.mjs`；知识：`knowledge-filename-parser.test.mjs`、`knowledge-import-sync.test.mjs`、`knowledge-topic-filter.test.mjs`；本地基础／搜索：`local-d1-sqlite.test.mjs`、`security-search-routing.test.mjs`。 |
| `src/`，89 | 适配器 5、应用入口／数据库／认证 3、公司与精选报告 6、财务 6、知识 1、宏观 6、行情 1、报告同步 1、研究 53、安全 1、共享运行时 6。研究测试涵盖 SEC／A-H 法定披露、财务与投资分析、预测修订、估值／场景／风险、任务对账与数据读模型。完整文件索引见下节；`verify:architecture` 自动发现全部。 |
| `web/src/`，14 | 搜索路由 1；机构赛道评级／估值 4；公司 PE 和研报控制器 2；宏观格式 1；期权域逻辑 4；旧数据服务 1；taskd 报告 UI 1。 |

`npm run test:*` 是按专题选取的快捷集合；**不是 148 个测试的完整清单**。清理后应以 `npm run verify:architecture` 跑全量单元门禁，并按涉及页面跑 `npm run test:smoke:pages`。`smoke-*`、`verify-investment-analysis-read-model.mjs` 是环境验收脚本，不属于 `*.test.*` 数量。

### 2.4 `src/` 和 `web/src/` 测试文件全量索引

以下与 2.3 的 scripts 两行合起来覆盖全部 148 个测试文件。按目录归类说明作用；同名测试属于不同层的独立用例。

| 目录／数量 | 覆盖作用 | 文件名 |
|---|---|---|
| `src/adapters/`（5） | 外部数据适配：公告／研报、雪球 K 线、Yahoo 财报 | `cninfo.test.mjs`、`eastmoney-finance-report-type.test.mjs`、`statutory-disclosures.test.mjs`、`xueqiu.test.mjs`、`yahoo-finance.test.mjs` |
| `src/app/`（1） | HTTP 路由与环境隔离 | `router.test.mjs` |
| `src/db/`（1） | D1 查询与读写合同 | `queries.test.mjs` |
| `src/modules/auth/`（1） | 登录和认证安全 | `auth.test.mjs` |
| `src/modules/company/api/`（5） | 公司研报访问、发现、分析缓存与响应格式 | `company-architecture.test.mjs`、`company-report-access.test.mjs`、`company-report-analysis-cache.test.mjs`、`company-report-discovery.test.mjs`、`company-report-text-format.test.mjs` |
| `src/modules/featured-reports/api/`（1） | 精选研报读取／发布 API | `featured-reports.routes.test.mjs` |
| `src/modules/finance/application/`（1） | 最新财务估值投影 | `latest-financial-valuation.test.mjs` |
| `src/modules/finance/domain/`（5） | 年度利润、股息、财报归一化、临时财报同步 | `annual-income-statements.test.mjs`、`dividend-yield.test.mjs`、`financial-read-model.test.mjs`、`financial-statement-foundation.test.mjs`、`sync-provisional-financial-statements.test.mjs` |
| `src/modules/knowledge/api/`（1） | 信息记录 API | `information-records.routes.test.mjs` |
| `src/modules/macro/adapters/`（1） | 宏观源适配 | `adapters.test.ts` |
| `src/modules/macro/api/`（1） | 宏观 API | `macro.routes.test.mjs` |
| `src/modules/macro/application/`（3） | 宏观同步、存储、分析任务 | `macro-analysis.test.mjs`、`macro-storage.test.mjs`、`sync-macro-data.test.ts` |
| `src/modules/macro/config/`（1） | 指标目录与来源映射 | `indicators.test.mjs` |
| `src/modules/market/application/`（1） | 雪球 K 线加载 | `load-kline.test.mjs` |
| `src/modules/report-sync/api/`（1） | 报告远端同步合同 | `report-sync.routes.test.mjs` |
| `src/modules/research/adapters/`（2） | A/H 法定 PDF 与 SEC XBRL | `a-h-statutory-pdf.test.mjs`、`sec-xbrl.test.mjs` |
| `src/modules/research/api/`（1） | 现行研究 API 边界及旧工作台路由不再注册 | `research-investment-analysis.route.test.mjs` |
| `src/modules/research/application/`（7） | 研究输入、财务／投资报告、法定核验与任务对账 | `financial-statutory-verification.test.mjs`、`reconcile-research-results.test.mjs`、`research-context.test.mjs`、`research-financial-analysis.test.mjs`、`research-fx-bridge.test.mjs`、`research-investment-analysis.test.mjs`、`sec-statutory-verification.test.mjs` |
| `src/modules/research/domain/`（43） | 预测、披露、质量、行业、估值、情景、风险和研究能力域规则 | `financial-analysis.test.mjs`、`financial-statutory-verification.test.mjs`、`forecast-actual-calibration-storage.test.mjs`、`forecast-actual-calibration.test.mjs`、`forecast-consolidation.test.mjs`、`forecast-coverage.test.mjs`、`forecast-public-snapshot.test.mjs`、`forecast-revision.test.mjs`、`formal-actual-candidate.test.mjs`、`formal-actual-health.test.mjs`、`formal-disclosure-coverage-matrix.test.mjs`、`guidance-event-impact-review-storage.test.mjs`、`guidance-event-impact-review.test.mjs`、`management-guidance-revision.test.mjs`、`operating-scenario-valuation.test.mjs`、`relative-valuation-ledger.test.mjs`、`research-capabilities.test.mjs`、`research-catalyst-review.test.mjs`、`research-company-focus-profile-application.test.mjs`、`research-company-focus-profile.test.mjs`、`research-coverage.test.mjs`、`research-data-requirements.test.mjs`、`research-depth.test.mjs`、`research-dossier.test.mjs`、`research-evidence-company-scope.test.mjs`、`research-financial-comparison-identity.test.mjs`、`research-financial-profile.test.mjs`、`research-financial-quality.test.mjs`、`research-foundation.test.mjs`、`research-identity.test.mjs`、`research-industry-comparability.test.mjs`、`research-industry-kpi-transmission.test.mjs`、`research-industry-profile.test.mjs`、`research-market-structure.test.mjs`、`research-operating-market.test.mjs`、`research-review-queue.test.mjs`、`research-risk-review.test.mjs`、`research-source-provenance.test.mjs`、`research-valuation.test.mjs`、`reverse-valuation-model-version.test.mjs`、`statutory-disclosure-revision-candidate.test.mjs`、`us-financial-period-equivalence.test.mjs`、`valuation-model-version.test.mjs` |
| `src/modules/security/application/`（1） | 证券搜索与代码处理 | `search-securities.test.mjs` |
| `src/shared/`（6） | HTTP／LLM／taskd 客户端与报告工作流 | `http.test.mjs`、`llm-client.test.mjs`、`local-direct-llm.test.mjs`、`request.test.mjs`、`taskd-client.test.mjs`、`taskd-report-workflow.test.mjs` |
| `web/src/app/layout/`（1） | 前端搜索与页面路由 | `security-search-route.test.ts` |
| `web/src/modules/companies/domain/`（4） | 机构赛道表现、评级和估值 | `institutional-track-financial-valuation.test.mjs`、`institutional-track-growth-valuation.test.mjs`、`institutional-track-performance.test.mjs`、`institutional-track-rating.test.mjs` |
| `web/src/modules/company/domain/`（1） | 公司 PE TTM 计算 | `pe-ttm.test.mjs` |
| `web/src/modules/company/runtime/`（1） | 研报页控制器 | `company-report-controller.test.ts` |
| `web/src/modules/macro/pages/`（1） | 宏观值格式化 | `macro-value-format.test.mjs` |
| `web/src/modules/options/domain/`（4） | 期权价格、合约键、到期日及策略计算 | `latest-kline-price.test.mjs`、`option-contract-key.test.mjs`、`recent-expirations.test.mjs`、`strategy-calculator.test.mjs` |
| `web/src/platform/legacy/`（1） | 旧页数据服务 | `legacy-data-services.test.ts` |
| `web/src/shared/taskd/`（1） | taskd 报告 UI | `taskd-report-ui.test.mjs` |

## 3. 定时处理维度

| 环境／触发 | 默认配置与启用状态 | 处理链与作用 | 外部副作用／注意 |
|---|---|---|---|
| Cloudflare Worker cron | `wrangler.jsonc` `*/15 * * * *`，**启用**，UTC | `src/app/worker.ts` → `scheduled.ts` → `syncProvisionalFinancialStatements`：按最近已完成季度抓东财业绩快报／预告，补充临时财报并维护断点与同步状态 | 写 D1 同步状态及市场数据 R2；不调用远端 LLM |
| Cloudflare Worker cron | `17 * * * *`，**启用**，UTC | `syncMacroData`：按目录登记的到期指标从 FRED、BLS、DBnomics 获取并保存可追溯发布时间的宏观序列 | 写宏观 D1；凭证或来源映射不足会退避，不是页面刷新触发 |
| 本地 Node cron | `src/platform/node/local-cron.ts` 从同一 `wrangler.jsonc` 读两个表达式，**本地 supervisor 启用** | 在本地 SQLite/R2 适配上执行同两项同步；`npm run dev:cron:once` 可单次执行 | 本地成功≠生产成功；不应把本地 Node 当 Worker 服务 |
| 本地 Node 周期任务 | 每 15 秒，**启用**，仅 `LLM_RUNTIME=local` | 轮询 taskd 并投影投资研究、宏观分析、公司研报发现结果；随后把完成的授权报告发布到生产 | 不是重新提交模型任务；远端发布失败在下次 tick 重试。生产 Worker 无此轮询 |
| 本地知识采集 | `config/knowledge/knowledge-processing.json`：`automation.enabled=false`、cron `*/15 * * * *`、`runOnStart=false` | 若开启才会 `knowledge-ingest-scheduler.mjs` → `process-knowledge.sh` → 东财研报／CLS 采集 → 知识处理／导入 | **当前不会自动运行**；但手动脚本仍可运行。`storageRetention.enabled=false`，不自动清理知识文档 |
| 本地资讯处理 | `config/knowledge/information-feed.json`：`enabled=true`、`runOnStart=true`；CLS 每 60 秒，源文件变化 300ms 防抖 | `information-feed-scheduler.mjs` 启动先采集和处理；监听 `/Users/terry/git/data/news` JSON/JSONL；采集无变更不会因轮询反复标注；失败 30 秒重试、标签每日额度到期续跑 | `publishRemote=false`：默认只处理本地资讯，**不会自动发远端**。手动 `publish-information-feed.mjs --apply` 是另一链路 |
| 本地雪球 Cookie | `local-supervisor.mjs` 启动先校验；默认每 10,800 秒（3 小时）刷新，失败 300 秒重试 | 调 `refresh-xueqiu-cookie.mjs`，保存忽略跟踪的本地凭证状态 | 与生产 Worker secret 更新分开；本地刷新不等于生产已更新 |
| 本地守护／健康 | supervisor 默认每 5 秒检查 HTTP 和内容服务健康，按受限次数重启本仓子进程 | 保障本地服务生命周期 | 运维定时器，非业务数据处理；页面中的报告状态 polling 也不是服务端 cron |

配置里 `remoteImportRetention` 是**执行远端“最新批次导入”时的保留策略**，不是独立定时清理任务。`refresh-eastmoney-cookie.mjs`、机构赛道快照、回测、精选研报发布、生产部署／迁移均无仓库内自动 cron；外部 CI、系统 crontab、人工任务若存在不在本报告可证范围。

## 4. 建议清理顺序与验收门槛

1. **先定产品边界**：明确 7 个 local 页面是否继续存在；别把“生产看不到”误认为无用。精选研报、研究读模型以及脚本发布链有跨环境合同，不能单删前端。
2. **第一批低耦合候选**：旧 `knowledge-news-page` 两级入口、未挂载的 `research/components`、无效 `analysis-task-queue`。删除前对全仓 import／动态 import、构建输出、外部脚本与历史 URL 做一次确认；工作台组件中的未实现 API 不应作为保留现行 Worker 路由的理由。
3. **再处理兼容壳和手动诊断脚本**：逐一确认顶层 re-export 被谁依赖；固定标的实验脚本、旧回测变体与存储清理脚本由负责人决定保留／归档。没有 npm 入口或自动调度**仅表示手动**，不足以判废弃。
4. **按依赖整链删除**：页面 → 入口／runtime → API → application/domain → 数据／迁移。对 D1/R2 先做只读引用与存量盘点；本仓不允许未经批准新增表，删除旧表同样需单独迁移与数据保留决策。
5. **验收**：每批运行 `npm run verify:architecture`、生产和本地 `build:web` 并用 `verify-page-artifacts.mjs` 比对 manifest；页面／路由变化用 `./start-local.sh` + `/api/health` + `npm run test:smoke:pages`；生产层另验证 Wrangler 配置、迁移、部署与真实 URL。不要用本地成功替代远端证明。

本次静态验收：`npm run build:web:production` + `node scripts/verify-page-artifacts.mjs --production`、`npm run build:web` + `node scripts/verify-page-artifacts.mjs --local` **均通过**。没有启动本地服务（盘点时 `127.0.0.1:8000` 未监听），没有进行浏览器或真实生产流量验证，因此“组件无人使用”是仓库内引用结论，不代表外部客户端绝对没有依赖。
