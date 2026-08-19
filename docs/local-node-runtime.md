# 本地 Node 运行时

日常本地开发不运行 Wrangler。`npm run dev:local` 和 `./start-local.sh` 使用 Node 的
HTTP 服务、`node:sqlite` 和文件系统对象存储；生产仍由 Cloudflare Worker、D1、R2
和 `wrangler.jsonc` 负责。

## 边界

`src/app/router.ts` 与 `src/app/scheduled.ts` 是两套运行时共享的业务入口：

- 生产 `src/app/worker.ts` 仅把 Cloudflare 的 `fetch` 与 `scheduled` 事件转交给它们。
- 本地 `src/platform/node/local-server.ts` 用相同路由处理 Node HTTP 请求。
- 本地 `src/platform/node/local-cron.ts` 从 `wrangler.jsonc` 的 `triggers.crons` 读取
  生产 cron 定义，并直接调用相同的 `dispatchScheduledTask`。

因此不会通过本地 HTTP 或模拟 `/cdn-cgi` 端点伪造 scheduled 事件。

## 本地绑定

| 生产绑定 | 本地实现 | 默认位置 |
| --- | --- | --- |
| D1 `DB` | `node:sqlite` D1-compatible adapter | `data/local/stock-info.sqlite` |
| R2 `MARKET_DATA_BUCKET` | 文件对象存储 | `data/local/market-data` |
| R2 `RAW_BUCKET` | 文件对象存储 | `data/local/raw` |
| R2 `KNOWLEDGE_CONTENT_BUCKET` | 文件对象存储 / 本地正文服务 | `KNOWLEDGE_CONTENT_LOCAL_DIR` |
| Assets | `web/dist` 文件服务 | `web/dist` |

本地数据库由 `npm run db:migrate:local` 对全部 `migrations/*.sql` 顺序执行并记录在
`_local_migrations`。`LOCAL_DB_PATH` 是所有本地数据库工具和 HTTP 运行时共享的首选覆盖项，
默认 `data/local/stock-info.sqlite`；`LOCAL_DATA_DIR` 只保留为未设置 `LOCAL_DB_PATH` 时的目录兼容项。
`LOCAL_MARKET_DATA_DIR`、`LOCAL_RAW_DATA_DIR` 和 `LOCAL_ASSETS_DIR` 分别覆盖其文件存储路径。

本地 SQLite 使用 WAL、`busy_timeout=30000`、foreign keys 和单个 `BEGIN IMMEDIATE` 批处理事务。
HTTP 写入与一次性维护脚本可以并存；维护脚本只在锁等待超时后显式失败，不会静默跳过记录。
HTTP 批量写入等待锁超过 100ms 会输出 `local_sqlite_write_lock_wait` JSON 日志，供本地运行日志检索。

### taskd 调用凭据

投资分析、财务分析和公司报告发现通过 taskd 执行。首次本地配置时，将 taskd 为
`stock-info` 签发的调用方 token 写入仓库根目录的忽略文件 `.dev.vars`：

```text
STOCK_INFO_TASKD_CALLER_TOKEN="<taskd-stock-info-caller-token>"
```

`createLocalBindings()` 会在 HTTP 服务启动前加载该文件；日常直接运行
`./start-local.sh` 即可，不需要在 shell 中传入或导出 token。`TASKD_BASE_URL` 与
`TASKD_NAMESPACE` 由启动脚本默认设为 `https://task.m2ai.cc` 和 `stock-info`。
不要把 token 写入 `wrangler.jsonc`、源码或提交到 Git；生产 Worker 不允许调用 taskd。

本地页面/API 读取 taskd 业务状态时，先读本地 `kv_cache` 中的业务快照。只有本地缓存已经是
`queued`、`running` 这类中间态时，才继续向 taskd 对账；从未提交过任务或已经是稳态结果时，
不应把 taskd 当成默认查询源。

## 命令

```bash
npm run db:migrate:local
npm run stats:knowledge:storage -- --local
npm run cleanup:knowledge:docs:local:dry-run
npm run cleanup:knowledge:content:local:dry-run
npm run check:wrangler-local
npm run dev:local
npm run dev:cron
npm run dev:cron:once
npm run test:local-runtime
```

本地路径禁止执行 `wrangler ... --local`；`npm run check:wrangler-local` 会检查该门禁。
Wrangler 仅保留给远端 D1、production dry-run 与部署。

`./start-local.sh` 会先按“命令属于本仓库的 `local-supervisor.mjs` 且工作目录属于本仓库”
识别并优雅停止上一套本地运行时，再只执行一次 prompts、`web/dist` 与 Node runtime 构建，
迁移显式本地 SQLite 并物化正文文件。随后它以 `exec` 交给前台 `local-supervisor`，后者管理
两个常驻角色：`local-http`（8000 API 与同进程 8788 正文监听）和 `local-scheduler`。
启动流程不会按任意端口或模糊命令杀进程；8000 或 8788 若由无关进程
占用，仍会明确失败且不修改现有 listener。

调度器从 `wrangler.jsonc` 读取生产 cron 定义，并在自身进程中调用共享的
`dispatchScheduledTask`；知识导入、PDF 转换和 Cookie 刷新是受控的一次性子进程。宏观数据
直接访问 allowlist 中的官方来源，不再启动 8791 relay。Cookie 刷新只在真实 K 线验证成功后
原子更新本地 credential store，HTTP 进程无需重启；写入 `.dev.vars` 或 `wrangler.jsonc`
仅限显式手动命令，且不会自动部署生产。

## Cloudflare 发布门禁

Wrangler 只用于线上边界：`npm run db:migrate:remote`、`npm run deploy` 和
`npx wrangler deploy --dry-run`。后者必须继续通过，确保共享业务代码仍能由生产
Worker 打包并获得 D1、R2、Assets 与 cron 绑定。
