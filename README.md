# stock-info

Cloudflare Workers 股票信息站。当前实现按免费额度保守设计：单 Worker、
`Vue 3 + Vite` 前端、`Hono` API、D1 结构化缓存。R2 后续真要存原始响应或 PDF
时再加。

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

### 本地手动部署

```bash
npm run deploy
```

脚本会按下面顺序执行：

- `npm run typecheck`
- `npm run build`
- `wrangler deploy --dry-run`
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
