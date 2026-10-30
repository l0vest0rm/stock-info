# 本地 Rust 后端迁移与验收

## 实现边界

后端现由 `backend/` 的 Rust 模块提供，默认入口为 `./start-local.sh`，与
`./start-rust.sh` 使用同一原生应用。没有代理 Node、嵌入 JavaScript 或通过
子进程调用 TypeScript 业务实现。Node 仍用于前端/提示词构建、工程测试、
TypeScript 差分 oracle 及保留的离线分析，不是运行时兜底。

Cloudflare 根部署配置、部署/回滚入口及 npm 远端写入命令已退役；cron 使用
`config/app/local-runtime.json`，研究结果不再自动同步生产。历史远端维护源码和
Worker 类型不构成支持流程。本次没有操作、删除或下线既有线上资源。

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
| 观察池 | GET 只读、HTTP≤2/cron≤12、全局≤2 lease/fencing、依赖版本、不可变 cohort/冻结 outcomes |
| 私有组合 | 39 上限、公司合并、现金/价格/FX、CAS/不可变历史、任务复开、what-if 与真实快照分离 |
| 知识资讯 | 导入/标签/筛选/全文/正文、对象生命周期、回调、去重、提取、回填与对账 |
| 研究与宏观 | 官方来源、taskd/LLM 提交/恢复/配额/对账；读取不提交、模型与用户结论分离 |
| 专题报告 | PDF 清理不跳过、页面与证据可追溯、工程处理审计；可选 Python 工具依赖明确失败 |
| 进程与调度 | 双端口占用安全、UTC cron、Cookie 启动验证和主动续期、关闭页面不取消任务、优雅退出 |
| 页面与完整基线 | 本地资产、真实 API/页面、完整 `npm run test:basic`；不弱化断言或伪造缓存 |

Rust 隔离回归覆盖上述各模块的合同、错误与事务路径，TypeScript reference 保留
作为差分测试依据；这不表示每个外部提供方、每个真实模型工作流或所有页面交互都已
在线验收。真实来源响应、凭据、调度、API 和页面是不同证据层，应独立记录。

## 已观测验证（2026-10-30）

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
- 最终 `npm run check:rust` 通过：格式、严格 clippy、391 项测试通过；常规套件中
  1 项依赖 Python 的 PDF 测试默认忽略，已按上一项另行执行。`check:all`、前端类型、
  路由装配守卫、无新增表守卫及估值 revision 校验均通过。

上述证据不表示所有页面操作、所有外部提供方和真实 taskd/LLM 端到端流程都已执行。
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
