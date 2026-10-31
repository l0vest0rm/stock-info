# 本地 Rust 后端迁移与验收

## 实现边界

后端现由 `backend/` 的 Rust 模块提供，默认入口为 `./start-local.sh`，与
`./start-rust.sh` 使用同一原生应用。没有代理 Node、嵌入 JavaScript 或通过
子进程调用 TypeScript 业务实现。旧后端 `src/` 整树与后端 JS/TS 实现已移除；
Node 仅用于前端/提示词构建、测试编排和支持的离线分析，不是运行时兜底。
前端共享类型/合同位于 `shared/`，前端专用校验位于 web 域。

Cloudflare 部署、远端维护源码、Worker 类型及对应运行时依赖均已删除；cron 使用
`config/app/local-runtime.json`，研究结果不自动向云端发布。本次没有操作、删除或
下线既有线上资源；本地 `.wrangler` 数据、`.dev.vars`、数据库、对象和研究报告不随
源码清理删除。历史 SQL 迁移仍完整保留。

全量业务的 Rust 模块映射见 [架构](architecture.md)。未知 API 返回 404，不再用
“部分迁移 API 返回 501”作为正常运行状态；有意退役的云登录/通用模型入口保留明确拒绝。

## 保持的共享契约

- HTTP 路径、`{code,msg,data}` 包装及字段语义不因实现语言改变。
- `AppState` 共享 `db`、`root`、`http`、配置/对象目录与 `TaskTracker`；接受的后台
  工作不随页面关闭消失，退出时等待收尾。
- `db.run` 在阻塞池执行 SQLite；账本事务、不可变历史与 CAS 不得拆成独立写入。
- `kv_cache` 永久研究/私有组合命名空间不得按缓存清理。
- `HttpClient` 统一超时、域并发、Yahoo 本地代理及缓存；提供方专用验证先于持久化。
  雪球 Cookie 拒绝与未知提供方失败不可缓存为有效数据、泄露密钥或触发换源。
- `ObjectStore` 约束路径、符号链接与原子替换。正文端口不能暴露私有 API。
- 原样保留排序历史迁移和 SQLite `user_version`。156 个历史文件、14 张最终表，
  无新增迁移跟踪表、业务表或删表；不以空表判断无用。见 [表结构审计](rust-schema-audit.md)。

## 业务验收矩阵

以下仍是后续修改必须维持的验收门槛，不因 Rust 编译或健康检查成功而豁免：

| 范围 | 必须维持的行为 / 证据 |
| --- | --- |
| 行情与身份 | 雪球股票 K 线、东方财富基金净值、规范证券身份、缓存新鲜度；Cookie 失败不换源 |
| 财报与公司 | 各市场报表、季度/TTM、普通股权益 PB、分红/股本、公司资料、公告/研报与估值输入 |
| 基金/13F/期权 | 既有字段、分页、来源约束与页面消费者 |
| 观察池 | GET 只读、前台按需 HTTP≤2，无观察池 cron/轮询、全局≤2 lease/fencing、依赖版本、不可变 cohort/冻结 outcomes |
| 私有组合 | 39 上限、公司合并、现金/价格/FX、CAS/不可变历史、任务复开、what-if 与真实快照分离 |
| 知识资讯 | 导入/标签/筛选/全文/正文、对象生命周期、回调、去重、提取、回填与对账 |
| 研究与宏观 | 官方来源、本机 CEA workflow/LLM 提交/恢复/配额/对账；读取不提交、模型与用户结论分离 |
| 专题报告 | PDF 清理不跳过、页面与证据可追溯、工程处理审计；可选 Python 工具依赖明确失败 |
| 进程与调度 | 双端口占用安全、UTC cron、Cookie 启动验证和主动续期、关闭页面不取消任务、优雅退出 |
| 页面与完整基线 | 本地资产、真实 API/页面、完整 `npm run test:basic`；不弱化断言或伪造缓存 |

Rust 隔离回归覆盖上述各模块的合同、错误与事务路径。原 TypeScript 差分 oracle
不再保留为可执行后端代码：完整输入与历史期望冻结为 JSON fixture，provenance 记录
源提交、原生成器哈希、解压 JSON 哈希及确切条数。机会评估 343 例、screen/PIT 65 例
维持完整字段/数组和原数值容差断言；其他既有 goldens 同样保留。不得从当前 Rust
实现生成期望，不能因迁移删减断言。见 `backend/tests/fixtures/README.md`。

离线分析中的共享确定性计算改经原生 `--analysis-json` 桥，无数据库、凭据、提供方或
监听器副作用；不恢复 Node 后端。生成的提取合同改为
`config/generated/information-records-contract.json`，保持原合同版本和哈希。
无挂载/无消费者的旧工作台及退役表应用代码移除，不添加新 API 或数据库表。

这些实现边界不表示每个外部提供方、每个真实模型工作流或所有页面交互都已在线验收。
真实来源响应、凭据、调度、API 和页面是不同证据层，应独立记录。

## 删除旧源码后的验证（2026-10-31）

- 旧 `src/` 不存在，重新生成资源也不会恢复它；后端 JS/TS 文件及旧云依赖为零。
  保留的 76 个 Node 工具通过语法检查，未发现无法解析的本地导入。
- `npm run check:rust` 的格式、严格 clippy 及 405 项测试通过；常规忽略的 1 项
  Python PDF renderer 测试已显式另行执行并通过。
- 19 项原有 selftest 改为实际调用 Rust，原 539 处断言保持并全部执行通过。
  固定历史期望包含 343/65/87/219 组完整样本，不用当前实现生成期望。
- `check:all`、前端类型检查/构建、本地资源 4 项测试、路由守卫与无新增表守卫通过；
  115 条冻结路由均有原生挂载，55 项前端 API 引用没有缺口；历史 156 份迁移未变。
- 默认启动脚本在只读备份得到的隔离库、独立对象副本与 18000/18788 端口启动成功；
  完整 `test:basic` 通过真实 K 线、三表、PE/市值及 10 条研报前瞻引用检查。
  CEA 验证财报日期列唯一且无浏览器异常。原有 8000 服务未停止或重启，用户库未用于迁移测试。

本轮未调用真实付费模型或重跑全部供应商、长期配额及全部 cron；上述范围不作扩大解释。

## 清理前运行时验证记录（2026-10-30）

以下是删除旧源码前已观测到的运行时证据，不作为本轮源码清理后的最终门禁通过记录。
清理后必须重跑原生回归、生成合同/哈希、前端构建与完整 API 基线。

- 在只读备份得到的隔离 SQLite、独立对象副本与 18000/18788 端口上，原生服务的
  完整 `npm run test:basic` 通过：真实雪球 K 线、三张财报、公司 PE/市值，以及
  10 条研报的前瞻引用检查；未弱化原有断言。
- 独立临时 Chrome/profile 的原生 Cookie 刷新验证了 6032 条真实 K 线，只写隔离
  credential store，未改用户凭据或关闭用户浏览器。
- 真实下一分钟 UTC cron 在空观察池、模型禁用、独立 SQLite 的 fixture 中完成；
  SIGTERM 后退出码 0，SQLite integrity 为 `ok`。这证明计时器到业务分发及关闭链路，
  不证明全部真实供应商 cron、长期配额或真实模型任务。
- 原生专题报告 helper 通过默认发现的真实清理器执行：自生成 3 页 PDF 清理为 2 页，
  保留页像素不变，输入/输出/处理器 SHA 可核验，未调用模型。
- 前端构建/类型与本地资源检查通过，构建检查覆盖 252 个本地资源引用，无远程 UI 依赖。
- 使用默认 `./start-local.sh` 在隔离副本和闲置端口启动，健康响应为 `runtime=rust`，
  常驻进程是原生二进制；该入口上的完整 `test:basic` 再次通过。
- CEA 验证真实财报页面：修复展示层混用累计/单季导致的重复季度，最新日期列唯一，
  保留原始累计数据与 TTM；宏观页可读取并显示既有研究报告，未触发重新生成。
- 可选真实 PDF renderer 隔离测试已显式执行并通过（它在常规 Rust 测试中仍默认忽略）。


上述证据不表示所有页面操作、所有外部提供方和真实 CEA workflow/LLM 端到端流程都已执行。
后续修改仍须重跑相应门禁，不以此文档代替运行验证，也不将未执行的可选测试记录为通过。

## 运行与验证

```sh
npm install --include=dev --no-audit --no-fund
./start-local.sh
# 另一终端，对运行中服务执行完整基线：
npm run test:basic
npm run check:rust
npm run check:rust-routes
npm run check:runtime-boundaries
npm run check:no-new-tables
npm run typecheck
npm run check:web-assets
```

默认 API/页面为 `http://127.0.0.1:8000`，正文为 8788。隔离验证需同时指定闲置端口、
数据库与两个对象目录；示例中的新目录仅用于测试，不要直接指向现有用户库：

```sh
PORT=18000 KNOWLEDGE_CONTENT_LOCAL_PORT=18788 \
LOCAL_DATA_DIR=/absolute/path/to/isolated-proof \
LOCAL_MARKET_DATA_DIR=/absolute/path/to/isolated-proof/market-data \
KNOWLEDGE_CONTENT_LOCAL_DIR=/absolute/path/to/isolated-proof/knowledge-content \
LOCAL_SCHEDULER=0 XUEQIU_COOKIE_REFRESH=0 ./start-local.sh
BASIC_TEST_BASE_URL=http://127.0.0.1:18000 npm run test:basic
```

关闭调度器只是隔离 API 证明，不能作为 cron 验收。`test:basic` 需要真实历史数据和
有效雪球 Cookie/上游；只创建空库不会自动具备这些前提。应通过只读备份和单独对象副本
准备隔离数据，不能对真实数据库执行迁移、删表或清缓存来取得测试证据。

`npm run build:prompts` 同时生成估值依赖 revision；源或配置变更后重建，并用
`node scripts/build-valuation-revision.mjs --check` 校验。页面资产变更后重建 `web/dist`。

专题报告的可选真实 PDF 工程验收使用自生成材料，不访问用户报告或调用模型：

```sh
python3 backend/src/featured_workflow/tools/verify-pdf-workflow.py \
  --binary /absolute/path/to/stock-info-local --out /absolute/path/to/pdf-proof
```

需安装 Python 3、PyMuPDF 和经审查的 `attachments-to-markdown` skill；默认发现及
`FEATURED_PDF_CLEANER` 规则见 [README](../README.md)。此证明只覆盖清理/提取工程链路，
不是模型研究、外部发布或全部 PDF 模板的验收。真实模型与提供方配额仍需要各自可用的
网络/凭据和独立端到端证据；本地运行不意味着离线运行。

## 浏览器研究正文读取与恢复

- 站点选择器由 `config/workflows/chatgpt-research.yaml` 管理：先证明本次回答完成，再读取唯一最终正文；思考摘要和搜索进度不是研究正文。等待、Markdown 和 HTML 留证共用正文定位规则，不以首个/最后一个匹配项兜底。
- `config/app/web-research.json` 的 `readOnlyLocatorUpdates` 是已审阅的旧结果 locator 升级规则。宿主只将配置与原 opaque checkpoint 交给 SDK；SDK 验证冻结工作流和输入身份、只读后缀及原 selector，保留原游标和会话 URL，并在首次读取前持久确认升级审计。禁止重写冻结 YAML、改游标或重发已提交提示词。
- 本地 workflow 状态保留 `errorCode`、`failedStep`、`matchCount`，页面展示脱敏错误而非 provider 原始错误。`startedAt` 首次领取时固定；旧任务回退到 `createdAt`。`updatedAt` 只能用于缺失完成时间时的结束边界，不能当开始时间；时间证据缺失或倒置显示未知。
- 自动回归：`node web/scripts/company-report-timing.test.mjs`、Rust workflow/company tests、CEA SDK workflow tests。`cea_checkpoint_recovery_live` 是显式 ignored 验收：从只读导出的 run/binding 快照恢复，SQLite 隔离，但必须保留原 SDK 输出目录身份，会写入该任务的真实结果 artifacts；不打开用户数据库，不发送提示词。
