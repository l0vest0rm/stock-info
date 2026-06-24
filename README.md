# stock-info

Cloudflare Workers 股票信息站。当前实现按免费额度保守设计：单 Worker、
`Vue 3 + Vite` 前端、`Hono` API、D1 结构化缓存、R2 预留但首版不主动写大对象。

## 已实现

- `GET /`：`Vue + Vite` 搜索与详情页
- `GET /api/health`：D1/R2 binding 健康检查
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

## 分支与环境约定

- `main`：生产分支，只放可部署代码
- `staging`：预发分支，对应 Cloudflare staging 环境
- 功能开发：`feature/*` 分支，本地验证通过后合并到 `staging` 或 `main`

推荐发布路径：

1. 在 `feature/*` 分支开发并本地验证
2. 合并到 `staging`，触发预发部署
3. 预发通过后再合并到 `main`
4. `main` 自动触发生产部署

## Cloudflare 部署前配置

### 1. 创建环境资源

生产和预发不要共用 D1 / R2，至少拆成两套。

生产 D1：

   ```bash
   wrangler d1 create stock_info_prod
   ```

预发 D1：

   ```bash
   wrangler d1 create stock_info_staging
   ```

生产 R2：

   ```bash
   wrangler r2 bucket create stock-info-raw-prod
   ```

预发 R2：

   ```bash
   wrangler r2 bucket create stock-info-raw-staging
   ```

### 2. 填写 `wrangler.jsonc`

把上面创建出来的 D1 `database_id` 分别填到：

- 默认环境：生产
- `env.staging`：预发

### 3. 先初始化远端表结构

预发：

```bash
wrangler d1 migrations apply stock_info_staging --remote --env staging
```

生产：

   ```bash
   npm run db:migrate:remote
   ```

## Cloudflare Git 部署建议

不要手工上传 `dist`。这个项目包含：

- Worker 代码
- `web/dist` 静态资源
- D1 / R2 binding
- `wrangler.jsonc` 环境配置

更合适的是让 Cloudflare 直接连 Git 仓库构建和部署。

### 建议的 Cloudflare 配置

在 Cloudflare Workers 控制台创建两个环境：

- Production
  - Branch: `main`
  - Build command: `npm install --no-audit --no-fund --ignore-scripts && npm run build`
  - Deploy command: `npx wrangler deploy`

- Staging
  - Branch: `staging`
  - Build command: `npm install --no-audit --no-fund --ignore-scripts && npm run build`
  - Deploy command: `npx wrangler deploy --env staging`

如果你想把类型检查也放进 CI，可以把 build command 改成：

```bash
npm install --no-audit --no-fund --ignore-scripts && npm run typecheck && npm run build
```

### 本地手动部署

预发：

```bash
npx wrangler deploy --env staging
```

生产：

   ```bash
   npm run deploy
   ```

## 免费额度策略

- 不做全市场抓取。
- 请求路径先查 D1，缓存新鲜时直接返回。
- 未命中时只补当前查询目标。
- Cron 当前只记录 skipped job，不执行批量同步。
- 财务数据默认只抓近 5 年报表日期窗口。
- R2 作为后续原始响应和 PDF 存储预留，首版接口不主动写 R2。
