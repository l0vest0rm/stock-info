# stock-info

项目整体设计见 [架构文档](docs/architecture.md)；AI 产业标的研究见 [赛道图谱](docs/AI产业细分赛道中美上市公司图谱_美国代码更新版_2026-08-09.md)。

Cloudflare Workers 股票信息站。当前知识链路已收敛到固定形态：

- D1：文档索引库，只负责列表、筛选、排序、搜索、正文引用
- R2 + `content.tinfo.cc`：正文对象存储，浏览器直接访问
- R2 + `market-data.tinfo.cc`：市场历史快照对象存储，浏览器可直接访问
- Worker API：只返回结构化业务数据，不中转正文
- 旧知识 Importer pipeline：负责非资讯信息流文档的清洗、preview、标签、压缩、对象写入、D1 upsert
- 资讯信息流：本地独立采集/工程去重/`gpt-6-luna` 打标，远端仅批量接收有许可且已打标的独有内容
- Cleanup pipeline：周期性清理未引用正文对象
- Observability：分开看 Worker、D1、R2 和正文域名缓存

## 已实现

- `GET /`：`Vue + Vite` 搜索与详情页
- `GET /api/health`：Worker 与 D1 健康检查
- `GET /api/search?q=600519`：证券搜索，先查 D1，未命中再查 Eastmoney
- `GET /api/kline?code=600519&from=2026-06-01&to=2026-06-24`：股票 K 线
- `GET /api/kline?code=019785.OF&from=2026-06-01&to=2026-06-24`：基金净值
- `GET /api/finance/income?code=600519`：A 股利润表
- `GET /api/finance/balance?code=600519`：A 股资产负债表
- `GET /api/finance/cashflow?code=600519`：A 股现金流量表

市场历史快照对象路径：

- `https://market-data.tinfo.cc/kline/{fq}/{code}.json`
- `https://market-data.tinfo.cc/fund-nav/{code}.json`
- `https://market-data.tinfo.cc/financial-statements/{statementType}/{code}.json`

## 本地运行

```bash
npm install --no-audit --no-fund --omit=optional
npm install --no-audit --no-fund --ignore-scripts
npm run db:migrate:local
npm run build
npm run dev:local
```

macOS 上也可以直接用根目录脚本：

```bash
chmod +x ./start-local.sh
./start-local.sh
```

默认访问地址是 `http://127.0.0.1:8000`。

本地服务就绪后，运行唯一保留的基本接口测试：

```bash
npm run test:basic
```

它通过后端 API 检查中际旭创（`300308.SZ`）的日 K 线、三张财报、PE(TTM) 和市值。需要可用的雪球 Cookie 与上游行情／财报服务；失败时不会切换 K 线来源。

### 资讯信息流

本地页面为 `/news.html`，接口为 `/api/knowledge/feed` 和 `/api/knowledge/feed/facets`。
`config/knowledge/information-feed.json` 控制本地资讯文件变更触发的即时入库/提取、财联社采集、每日 500 次提取上限与远端发布开关。财联社源站无推送接口，因此仅采集仍每 60 秒轮询；无新增或修订内容时不运行入库/提取。腾讯原始 JSON 由仓库外的现有采集器提供，写入共享 news 目录后触发处理。资讯入库仅允许标题命中本地 `stock.short_name`、`stock_alias.alias` 或市场限定代码变形且具备公司事件线索，或者命中 `config/knowledge/information-feed-policy.json` 中配置的行业／宏观规则；未命中者不入库。拒绝标题及链接只写本地 JSONL，页面本地环境可筛选复核。生产 Worker 不调用模型，远端发布默认关闭。手动处理和检查：

```bash
npm run process:feed -- --max-documents 200 --max-tags 20
npm run reconcile:feed:dry-run # 去重规则更新后检查存量同标题重复卡片
npm run publish:feed:dry-run
```

腾讯自选股、财联社采集全文已获远端发布许可，但 `publishRemote` 开关仍关闭；手动执行发布器的 `--apply` 也会跳过远端操作。先验收本地采集、去重与打标效果，之后再应用远端 D1 迁移、验证批量发布与生产只读 API，并单独开启发布开关。链路边界见 [架构文档](docs/architecture.md)。

`start-local.sh` 最终以前台 `local-supervisor` 运行，并管理 `local-http` 与
`local-scheduler` 两个常驻角色。`local-http` 同时监听 8000 API
与 8788 知识正文端点；宏观数据直接请求 allowlist 官方来源，8791 不再有本地 relay。
调度器直接读取 `wrangler.jsonc` 的 `triggers.crons`，按 Cloudflare 一致的 UTC cron
配置调用共享 scheduled 分发函数；以后新增定时任务只维护线上同一份配置。Supervisor 的
JSON 行日志可按 `run_id`、`role`、`event` 与任务字段关联。需要立即手动执行所有已配置
cron 时，可以在已构建 Node runtime 后运行：

```bash
npm run dev:cron:once
```

知识库的 PDF 转 Markdown 不会在本地启动或运行期间自动执行：
`config/knowledge/knowledge-processing.json` 中的 `automation` 默认关闭。需要处理时，显式运行
`npm run process:knowledge` 或 `./process-knowledge-local-full.sh`；前者是增量处理，后者是全量重跑。

第一步用 `--omit=optional` 跳过容易卡住的可选依赖构建；第二步补齐
`rollup` 的平台包，但禁用安装脚本，避免 `fsevents` 之类的可选包拖慢安装。

## 中证 800 + 中证 1000 股票行业与别名

`npm run sync:csi-stock-universe` 从东财 `RPT_INDEX_CONSTITUENT` 获取中证 800（000906）和中证 1000（000852）的完整成分股，再从 `RPT_F10_ORG_BASICINFO.EM2016` 取得三级行业。默认只预览；确认后运行 `npm run sync:csi-stock-universe -- --apply`，原子写入本地 Node SQLite 的 `stock` 和 `stock_alias`。缺失或不完整的接口数据会令整次同步失败，不会部分写入。已有 `stock.short_name` 和 `updated_at` 不覆盖；东财简称作为名称映射写入。代码写在 `stock.code`，不重复存入别名表。可用 `--indexes 000906,000852`、`--db PATH`、`--batch-size` 和 `--concurrency` 复用此脚本；生产 D1 不会被该本地命令修改。

## 港股大市值与活跃股票身份

`npm run sync:hk-popular-stocks` 从东财港股主板行情按总市值取前 200 只、按成交额取前 100 只，合并去重并排除同一股票的 8xxxx 人民币柜台。默认只预览；`npm run sync:hk-popular-stocks -- --apply` 原子写入本地 `stock` 与 `stock_alias`，保留已有规范简称。可用 `--market-cap-count`、`--turnover-count`、`--db` 调整范围。身份记录只增不删，不代表当前或历史指数成员关系。东财港股行业 `f100` 与 A 股 EM2016 三级分类不是同一口径，因此本脚本不填充 `industry_level_1/2/3`；生产 D1 不会被该命令修改。


## 知识处理脚本

知识处理现在分成“本地处理”和“数据库导入”两步：

- 本地处理写本地 D1 + 本地正文缓存
- 远端导入才写 Cloudflare D1 / R2
- 两边都使用相同的 `knowledge-content/*` 内容键

对象上传到 R2 时统一带：

- `Cache-Control: public, max-age=31536000, immutable`
- 内容哈希 key
- 浏览器直连 `KNOWLEDGE_CONTENT_PUBLIC_BASE_URL`

### 资讯流信息提取

资讯流由本地 Node 运行时处理。启动 `./start-local.sh` 后使用 `npm run process:feed`；生产 Worker 不调用模型。旧“信息整理”页面和知识文档单篇信息预处理入口已停用，历史数据库表保留供已有数据读取或归档。

### `./process-knowledge-local-full.sh`

用途：本地全量重跑知识处理。

它会做这些事：

- 调用 `scripts/process-knowledge-local-full.mjs`
- 以本地模式运行 `process-knowledge-once.mjs`
- 执行 `full-rescan`
- 忽略年龄限制
- 把 `processedDir` 也作为额外输入目录重新扫描
- 结果写入本地 Node SQLite，并把正文内容写入本地正文缓存，内容键统一为 `knowledge-content/*`
- 更新本地同步状态文件 `knowledge-remote-sync.jsonl`
- 知识导入不再自动调用旧单篇信息抽取接口；资讯流提取由独立的本地 `npm run process:feed` 链路执行
- 本地导入直接对 `data/local/stock-info.sqlite` 执行分块事务；远端导入仍使用 `wrangler d1 execute --remote`
- 增量判断使用排除抓取时间、来源文件名和 mtime 等易变字段后的内容指纹；同步账本会在导入完成后原子压缩，只保留每篇文档在各目标上的最新状态

本地数据库默认是 `data/local/stock-info.sqlite`；所有本地脚本、导入与 Node HTTP
运行时均优先使用同一个 `LOCAL_DB_PATH`。需要使用其他路径时，可以显式设置：

```bash
LOCAL_DB_PATH=/absolute/path/to/stock-info.sqlite ./process-knowledge-local-full.sh
```

### 同步标普 500 股票身份

运行 `npm run db:migrate:local` 后，执行 `npm run sync:sp500-stocks`，从
`datasets/s-and-p-500-companies` 维护的成分股 CSV 获取最新列表，并将每个证券的
`SYMBOL.US` 写入 `stock`，将英文证券名写入 `stock_alias`。完整代码和 ticker
由读取程序根据 `stock.code` 识别，不重复存储为别名。
可先加 `-- --dry-run` 检查来源与数量；`-- --input /path/to/constituents.csv`
可使用保存的 CSV 重跑。需要同步生产 D1 时，显式使用
`npm run sync:sp500-stocks -- --remote`（需先完成远端迁移和 Wrangler 认证）。
脚本可重复运行，不覆盖已有的规范简称和别名，也不删除退指成分股的股票身份；
`stock`/`stock_alias` 是身份表，不存储指数成员有效期或历史名单。

韩国三星电子、SK 海力士和精选日本热门股票的身份清单位于
`config/asia-popular-stocks.json`。运行 `npm run sync:asia-popular-stocks` 写入本地
`stock`/`stock_alias`；`-- --dry-run` 预览，`-- --remote` 才写入生产 D1。
可用 `-- --manifest /path/to/stocks.json` 复用脚本处理同一格式的人工核对清单。
韩国使用 `.KS`，日本东京证交所使用 `.T`；清单只存名称类别名，不存代码变体。这只是股票身份/别名同步，
不代表当前行情、K 线或研究 API 已支持这些市场。

适合什么时候用：

- 想在本地完整重建一次知识库
- 想重新生成最新的 `knowledge-import-*.jsonl`
- 想在本地重建 SQLite，同时保持与生产一致的正文 key/元数据形态

如果需要把历史 `localfs:` 记录迁到统一的 `knowledge-content/*`，可直接执行：

```bash
npm run migrate:knowledge:localfs
```

## 过期清理

先清过期文档索引：

```bash
./cleanup-knowledge-local.sh
./cleanup-knowledge-remote.sh
```

也可以分别 dry-run / apply：

```bash
npm run cleanup:knowledge:docs:local:dry-run
npm run cleanup:knowledge:docs:local
npm run cleanup:knowledge:docs:remote:dry-run
npm run cleanup:knowledge:docs:remote
```

`cleanup-knowledge-docs.mjs` 会按 `storageRetention.knowledgeDocsMaxAgeDays`
计算 cutoff，删除早于 cutoff 的 `knowledge_docs`；关联的 tags / content refs /
security links 由外键级联删除。

`./cleanup-knowledge-remote.sh` 只清 remote D1 文档索引。R2 正文对象是否过期由
Cloudflare lifecycle rule 控制；如果需要手动核对 orphan，可单独运行下面的正文清理 dry-run。

## 正文清理

正文清理默认是单独手工执行，不会在 `deploy-cloudflare.sh` 里自动触发。本地模式对比
Node SQLite 引用和 `KNOWLEDGE_CONTENT_LOCAL_DIR` 文件；远端模式对比 Cloudflare D1 引用和 R2 对象。

本地先跑 dry-run：

```bash
npm run cleanup:knowledge:content:local:dry-run
```

本地真正删除：

```bash
npm run cleanup:knowledge:content:local
```

远端需要时先跑 dry-run，找出超过保留期的未引用对象：

```bash
npm run cleanup:knowledge:content
```

真正删除：

```bash
npm run cleanup:knowledge:content:apply
```

远端清理依赖下面这些环境变量：

```bash
export CLOUDFLARE_R2_ENDPOINT=...
export CLOUDFLARE_R2_ACCESS_KEY_ID=...
export CLOUDFLARE_R2_SECRET_ACCESS_KEY=...
```

它会：

- 读取 `knowledge_doc_content_refs` 和 `knowledge_filtered_doc_content_refs`
- 列出 `knowledge-content/*` 对象
- 报告缺失引用和未引用对象
- `--apply` 时删除超出保留期的 orphan 对象
- 覆盖更新 `kv_cache` 中 `knowledge_maintenance` namespace 的该类清理 JSON 状态

## 可观测性

汇总 Cloudflare 侧核心指标：

```bash
npm run report:cloudflare:observability -- --hours 24
```

脚本会分别尝试读取：

- Worker requests / errors / subrequests / CPU 分位数
- D1 read/write queries、rows、query duration 分位数
- `wrangler d1 insights` 查询热点
- R2 操作量和对象存储规模
- `content.tinfo.cc` 的缓存命中情况

需要的环境变量：

```bash
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_ZONE_ID=...
export CLOUDFLARE_D1_DATABASE_ID=...
export CLOUDFLARE_WORKER_SCRIPT_NAME=stock-info
export KNOWLEDGE_CONTENT_BUCKET=stock-info-knowledge-content
export KNOWLEDGE_CONTENT_HOSTNAME=content.tinfo.cc
```

### `./import-knowledge-docs-remote-latest.sh`

用途：补齐本地 `knowledge-import-*.jsonl` 历史清单里尚未进入远端的文档。

它会做这些事：

- 自动读取 `config/knowledge/knowledge-processing.json` 里的 `workDir`、`stateDir`、`database`
- 扫描 `workDir` 中全部 `knowledge-import-*.jsonl`
- 同一 `docId` 只保留最新一份清单中的版本
- 远端补齐时额外按时间窗过滤：研报最近 30 天，新闻最近 14 天
- 调用远端专用导入脚本
- 上传正文内容到 Cloudflare R2
- 写入远端 D1
- 把导入结果和同步状态写回 `knowledge-remote-sync.jsonl`
- 如果本地同步状态里已经记录过同一份源文件指纹，则直接跳过，避免重复上传和重复写 D1
- 默认使用更激进的远端导入参数：`KNOWLEDGE_CONTENT_UPLOAD_CONCURRENCY=24`、`KNOWLEDGE_IMPORT_MAX_SQL_BATCH_BYTES=2000000`
- 导入时会按文档块流式处理，默认 `KNOWLEDGE_IMPORT_DOC_CHUNK_SIZE=400`：每块先 prepare/upload，再立刻批量写远端 D1，让页面尽快看到增量结果
- 如果需要保守一点或继续提速，可以在命令前显式覆盖这些环境变量

适合什么时候用：

- 本地 `process-knowledge-local-full.sh` 跑完以后
- 想把本地历史处理结果补齐到 Cloudflare

### `./import-filtered-knowledge-docs-remote-latest.sh`

用途：把最近一次生成的 `knowledge-filtered-*.jsonl` 导入远端复核表。

它会做这些事：

- 自动选取 `workDir` 中最新的 `knowledge-filtered-*.jsonl`
- 上传相关正文到 Cloudflare R2
- 写入远端 `knowledge_filtered_docs`
- 同样复用本地同步状态文件，已同步的同源文档会跳过
- 同样默认使用 `KNOWLEDGE_CONTENT_UPLOAD_CONCURRENCY=24` 和 `KNOWLEDGE_IMPORT_MAX_SQL_BATCH_BYTES=2000000`
- 同样按 `KNOWLEDGE_IMPORT_DOC_CHUNK_SIZE` 分块流式导入，避免先把全部正文 prepare 完才开始远端可见

适合什么时候用：

- 你启用了 filtered docs 导入
- 想把筛掉的候选也同步到远端做人工复核

## 验证

```bash
npm run typecheck
curl -s 'http://localhost:8000/api/health'
curl -s 'http://localhost:8000/api/search?q=600519'
curl -s 'http://localhost:8000/api/kline?code=600519&from=2026-06-01&to=2026-06-24'
```

页面资源由 Wrangler `assets` 从 `web/dist` 提供，`/api/*` 继续由 Hono Worker 处理。

## 当前分支约定

当前先只用 `main`。

- 本地开发完成后，直接 push 到 `main`
- 生产发布统一走本机 token 部署脚本
- 等功能稳定后，再考虑加 `staging`

## Cloudflare 部署前配置

### 1. 创建资源

创建 D1：

   ```bash
   wrangler d1 create stock_info
   ```

### 2. 填写 `wrangler.jsonc`

把创建出来的 D1 `database_id` 填入默认配置。

### 3. 先初始化远端表结构

```bash
npm run db:migrate:remote
```

## Cloudflare 手动部署建议

不要手工上传 `dist`。这个项目包含：

- Worker 代码
- `web/dist` 静态资源
- D1 binding
- `wrangler.jsonc` 环境配置

当前生产发布建议是在本机先构建，再通过 `CLOUDFLARE_API_TOKEN` 手动部署。

### 当前建议的 Cloudflare 配置

- 关闭或删除 Cloudflare 上现有的 `stock-info` Git 自动部署，避免和手动部署互相覆盖
- 确认 `tinfo.cc` 这个 zone 在同一个 Cloudflare 账号下
- 确认 token 具备 Worker deploy、D1 migration 和域名路由相关权限
- `wrangler.jsonc` 中生产域名使用 `tinfo.cc` custom domain

### 本地手动部署前准备

```bash
export CLOUDFLARE_API_TOKEN=...
```

发布前预检：

```bash
npm run preflight:cloudflare:release
```

它会检查：

- token 有效性，以及当前仓库所需的 zone/Worker/D1/R2 访问权限
- `wrangler.jsonc` 中配置的 R2 bucket 是否存在
- `knowledge-content/*` cleanup dry-run
- Cloudflare observability snapshot

如果缺少 cleanup/observability 所需环境变量，会提示跳过；需要强制 observability 成功时可执行：

```bash
./scripts/preflight-cloudflare-release.sh --strict-observability
```

### 本地手动部署

部署前先通过 Chrome DevTools Protocol 生成并验证雪球 K 线 Cookie。该命令更新本地 `.dev.vars` 和忽略的本地 credential store；部署脚本另行上传 Worker secret：

```bash
npm run refresh:xueqiu-cookie
```

```bash
npm run deploy
```

脚本会按下面顺序执行：

- `npm run typecheck`
- `npm run build`
- `wrangler deploy --dry-run`
- `./scripts/preflight-cloudflare-release.sh`
- 检查 `wrangler.jsonc` 中配置的 R2 buckets 是否已存在
- `wrangler d1 migrations apply stock_info --remote`
- `wrangler deploy`
- 验证生产 `/api/health` 和 `002463.SZ` 的 `/api/kline`

`XUEQIU_COOKIE` 作为 Worker secret 管理，不写入版本化 `wrangler.jsonc`。执行 `npm run refresh:xueqiu-cookie` 从 CDP 刷新并验证后写入忽略的 `.dev.vars` 和本地 credential store；本地调度器默认每 3 小时刷新，失败 5 分钟后重试，不改生产。标准发布在部署前重新通过雪球 K 线验证本地凭据，并经 stdin 上传 Worker secret；不要把 Cookie 放到命令行参数或日志。

雪球网页可匿名查看 K 线；刷新脚本不要求登录。雪球目前只给新开的无头 Chrome 一个防护 Cookie，无法完成匿名 K 线请求；脚本因此默认使用短暂打开的可见 Chrome，在临时 profile 中访问雪球接口以建立匿名 Cookie，按 `stock.xueqiu.com` API 域名提取，并在保存前验证真实 K 线。若本机无法显示 Chrome，可用 `XUEQIU_CDP_URL` 连接已运行的可见 CDP Chrome；`XUEQIU_CHROME_HEADLESS=1` 仅供诊断，不是当前可用的刷新方式。本地刷新不会自动更新生产 Worker secret；可单独执行 `npm run sync:xueqiu-secret`，或通过 `npm run deploy` 更新并验证生产。本地 `/api/health` 只证明服务和数据库存活，不证明雪球会话有效。

发布脚本执行前后端类型检查及 schema、运行时、提示词和发布输入守卫；旧单元／页面 smoke 测试已移除。页面入口与环境策略统一定义在 `config/app/page-manifest.json`；本地构建默认 `WEB_RUNTIME=local`，生产构建使用 `npm run build:web:production`。相邻共享包的 Git revision 和实际 dist 内容由 `config/app/release-inputs.lock.json` 锁定，升级共享包时先构建并审查，再执行 `node scripts/check-release-inputs.mjs --update` 更新锁文件。发布不允许未审查的共享包漂移。


只做打包检查但不真正上线：

```bash
./deploy-cloudflare.sh --dry-run-only
```

跳过远端 migration：

```bash
./deploy-cloudflare.sh --skip-migrate
```

首发时如果还没创建 R2 bucket，可以显式让脚本创建：

```bash
./deploy-cloudflare.sh --create-missing-r2
```

跳过 preflight：

```bash
./deploy-cloudflare.sh --skip-preflight
```

### 回退

直接回到上一版：

```bash
npm run rollback:cloudflare
```

指定 Worker version 回退：

```bash
./rollback-cloudflare.sh <version-id>
```

注意：Cloudflare Worker 可以回退版本，但 D1 不会自动回退，所以 migration 需要保持向前兼容。

## 免费额度策略

- 不做全市场抓取。
- 请求路径先查 D1，缓存新鲜时直接返回。
- 未命中时只补当前查询目标。
- Cron 当前只记录 skipped job，不执行批量同步。
- 财务数据默认只抓近 5 年报表日期窗口。
- 需要留档的超大 Markdown 等对象可以进 R2，但仍应优先让 Worker 请求路径只读 D1/R2，不做在线重处理。
