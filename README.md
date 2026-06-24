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
- Cloudflare 只绑定 `main` 自动部署
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

## Cloudflare Git 部署建议

不要手工上传 `dist`。这个项目包含：

- Worker 代码
- `web/dist` 静态资源
- D1 binding
- `wrangler.jsonc` 环境配置

更合适的是让 Cloudflare 直接连 Git 仓库构建和部署。

### 当前建议的 Cloudflare 配置

在 Cloudflare Workers 控制台只配置一套生产自动部署：

- Branch: `main`
- Build command: `npm install --no-audit --no-fund --ignore-scripts && npm run build`
- Deploy command: `npx wrangler deploy`

如果你想把类型检查也放进 CI，可以把 build command 改成：

```bash
npm install --no-audit --no-fund --ignore-scripts && npm run typecheck && npm run build
```

### 本地手动部署

```bash
npm run deploy
```

## 免费额度策略

- 不做全市场抓取。
- 请求路径先查 D1，缓存新鲜时直接返回。
- 未命中时只补当前查询目标。
- Cron 当前只记录 skipped job，不执行批量同步。
- 财务数据默认只抓近 5 年报表日期窗口。
- 原始响应和 PDF 暂不入库；后续真需要对象存储时再补 R2。
