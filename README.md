# stock-info

Cloudflare Workers 股票信息站。当前知识链路已收敛到固定形态：

- D1：文档索引库，只负责列表、筛选、排序、搜索、正文引用
- R2 + `content.tinfo.cc`：正文对象存储，浏览器直接访问
- R2 + `market-data.tinfo.cc`：市场历史快照对象存储，浏览器可直接访问
- Worker API：只返回结构化业务数据，不中转正文
- Importer pipeline：唯一负责内容清洗、preview、标签、压缩、对象写入、D1 upsert
- Cleanup pipeline：周期性清理未引用正文对象
- Observability：分开看 Worker、D1、R2 和正文域名缓存

## 已实现

- `GET /`：`Vue + Vite` 搜索与详情页
- `GET /api/health`：Worker 与 D1 健康检查
- `GET /api/search?q=600519`：证券搜索，先查 D1，未命中再查 Eastmoney
- `GET /api/securities/:code`：证券主数据
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
npm run dev:worker -- --port 8787
```

macOS 上也可以直接用根目录脚本：

```bash
chmod +x ./start-local.sh
./start-local.sh
```

默认访问地址是 `http://127.0.0.1:8787`。

第一步用 `--omit=optional` 跳过容易卡住的可选依赖构建；第二步补齐
`rollup` 的平台包，但禁用安装脚本，避免 `fsevents` 之类的可选包拖慢安装。

## 知识处理脚本

知识处理现在分成“本地处理”和“数据库导入”两步：

- 本地处理写本地 D1 + 本地正文缓存
- 远端导入才写 Cloudflare D1 / R2
- 两边都使用相同的 `knowledge-content/*` 内容键

对象上传到 R2 时统一带：

- `Cache-Control: public, max-age=31536000, immutable`
- 内容哈希 key
- 浏览器直连 `KNOWLEDGE_CONTENT_PUBLIC_BASE_URL`

### `./process-knowledge-local-full.sh`

用途：本地全量重跑知识处理。

它会做这些事：

- 调用 `scripts/process-knowledge-local-full.mjs`
- 以本地模式运行 `process-knowledge-once.mjs`
- 执行 `full-rescan`
- 忽略年龄限制
- 把 `processedDir` 也作为额外输入目录重新扫描
- 结果写入本地 D1，并把正文内容写入本地正文缓存，内容键统一为 `knowledge-content/*`
- 更新本地同步状态文件 `knowledge-remote-sync.jsonl`

适合什么时候用：

- 想在本地完整重建一次知识库
- 想重新生成最新的 `knowledge-import-*.jsonl`
- 想在本地重建 D1，同时保持与生产一致的正文 key/元数据形态

如果需要把历史 `localfs:` 记录迁到统一的 `knowledge-content/*`，先停掉本地
`wrangler dev`，再执行：

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

正文清理默认是单独手工执行，不会在 `deploy-cloudflare.sh` 里自动触发。需要时先跑 dry-run，对比远端 D1 引用和远端 R2 对象，找出超过保留期的未引用对象：

```bash
npm run cleanup:knowledge:content
```

真正删除：

```bash
npm run cleanup:knowledge:content:apply
```

清理脚本依赖下面这些环境变量：

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
- 记录一条 `knowledge_ingest_runs` 运行记录

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

- 自动读取 `config/knowledge-processing.json` 里的 `workDir`、`stateDir`、`database`
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
curl -s 'http://localhost:8787/api/health'
curl -s 'http://localhost:8787/api/search?q=600519'
curl -s 'http://localhost:8787/api/kline?code=600519&from=2026-06-01&to=2026-06-24'
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
- `curl https://tinfo.cc/api/health`

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
