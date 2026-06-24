# Cloudflare Workers 股票信息站方案

## 目标

基于 Cloudflare Workers 搭建一个轻量股票信息网站，优先迁移本地 `licai`
中已经相对稳定的股票/基金、K 线、财报、公告等结构化信息能力。

新闻、研报、知识库、LLM 研报解析和推荐排序先不迁移，只预留后续扩展边界。

## 关键约束

- Workers 不是完整 Node.js 服务，而是 JavaScript/TypeScript Worker 运行时加
  Node.js API 兼容层。可以开启 `nodejs_compat`，但不能假设所有 Node API、
  本地文件系统、原生 SQLite、长驻进程都可用。
- Workers 单 isolate 内存限制为 128 MB，必须避免大内存缓存、全市场一次性
  拉取、长时间同步任务。
- D1 适合结构化查询，但不是大对象存储。付费版单库上限 10 GB，单行、字符串、
  BLOB 上限 2 MB。
- R2 适合存原始响应、PDF、快照、压缩 JSON 等大对象。不要把大 JSON 或 PDF
  直接塞进 D1。
- 本地 `licai` 中依赖浏览器态、Cookie 刷新、本地 redb/SQLite、PDF 转 Markdown、
  LLM 调用的链路不适合第一阶段直接搬到 Workers。

参考文档：

- Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Workers Node.js compatibility: https://developers.cloudflare.com/workers/runtime-apis/nodejs/
- D1 limits: https://developers.cloudflare.com/d1/platform/limits/
- R2 limits: https://developers.cloudflare.com/r2/platform/limits/

## 从 `licai` 裁剪迁移的范围

本地 `licai/server-rs` 目前可参考的接口边界：

- 行情和搜索：`/api/kline`、`/api/suggest`、`/api/code/name`
- 财务数据：`/api/finance/income`、`/api/finance/balance`、
  `/api/finance/cashflow`、`/api/finance/sharebonus`、
  `/api/finance/dividendyield`、`/api/finance/freeholders`、
  `/api/finance/orgholders`、`/api/finance/sharechange`、
  `/api/finance/shareadditional`
- 公司数据：`/api/company/notices`、`/api/company/restriction`
- 基金数据：`/api/fund/info`、`/api/fund/position`、
  `/api/fund/constituents`、`/api/fund/share-change`、`/api/fund/rank`、
  `/api/fund/companies`
- 13F 数据：`/api/13f/manager/list`、`/api/13f/quarters/:id`、
  `/api/13f/position/:filingId`

第一阶段建议保留：

- 搜索、代码归一化、代码到名称映射
- 股票/基金 K 线
- 财务三表和分红/股本变动等基础事件
- 基金概况、净值、持仓、排行
- 公司公告列表和 PDF 对象存储

第一阶段不迁移：

- `knowledge/*`
- `company/reports/stream`
- `report/forecast`
- 本地新闻、研报、PDF 解析、LLM 预测
- 浏览器自动刷新 Cookie、模拟登录、代理链路

## 推荐架构

### Worker 拆分

```text
stock-info/
  web-worker       对外 API 和静态前端
  sync-worker      Cron 定时刷新关注股票/基金数据
  admin-worker     手动触发回填、重建索引、导入本地数据
```

也可以先用一个 Worker 起步，但代码上仍按 `routes`、`services`、`sync` 拆开，
后续需要时再拆部署。

### 技术栈

- TypeScript
- Hono
- Zod 做 query/body 校验
- D1 作为结构化数据库
- R2 作为对象存储
- Vite + Vue 做前端
- Wrangler 管理 D1 migration、R2 binding、Cron trigger

长期维护建议使用 Hono，而不是手写原生 Worker router。原因是后续会持续增加
股票、基金、财务、公告、admin/sync 等接口，Hono 的路由分组、中间件和类型
约束能降低维护成本；相对免费额度而言，它的运行开销和包体积是可接受的。

当前实现已经拆成 `Vue + Vite` 前端和 `Hono + Workers` API：静态页面由
Wrangler `assets` 从 `web/dist` 提供，`/api/*` 继续走 Worker 路由。

## Git 部署策略

长期维护建议不要直接在 `main` 分支开发，也不要手工上传 `dist`。

建议流程：

- `feature/*`：功能开发分支
- `staging`：预发分支，部署到 `stock-info-staging`
- `main`：生产分支，部署到 `stock-info`

这样做的原因：

- 半成品不会直接进入生产
- D1 / R2 可以按环境隔离
- Cloudflare Git 自动部署能直接复用 `wrangler.jsonc` 和 build 命令
- 回滚、审计、排查都更清楚

对应资源建议：

- 生产 D1：`stock_info_prod`
- 预发 D1：`stock_info_staging`
- 生产 R2：`stock-info-raw-prod`
- 预发 R2：`stock-info-raw-staging`

### 目录结构建议

```text
stock-info/
  src/
    index.ts
    env.ts
    routes/
      health.ts
      search.ts
      kline.ts
      finance.ts
      fund.ts
      notices.ts
      admin.ts
    services/
      market.ts
      kline.ts
      finance.ts
      fund.ts
      notice.ts
      sync.ts
    adapters/
      eastmoney.ts
      yahoo.ts
      sec13f.ts
    db/
      schema.sql
      queries.ts
      migrations/
    r2/
      objects.ts
    shared/
      codes.ts
      normalize.ts
      json.ts
  web/
    src/
    vite.config.ts
  wrangler.jsonc
```

## D1 数据模型

### `securities`

证券、基金、指数、ETF 的主表。

```sql
create table securities (
  code text primary key,
  market text not null,
  type text not null,
  name text not null,
  currency text,
  exchange text,
  source text,
  updated_at integer not null
);

create index idx_securities_type_name on securities(type, name);
```

### `security_aliases`

搜索别名、拼音、供应商原始代码映射。

```sql
create table security_aliases (
  alias text not null,
  code text not null,
  source text not null,
  updated_at integer not null,
  primary key(alias, code, source)
);

create index idx_security_aliases_code on security_aliases(code);
```

### `kline_bars`

K 线明细。只存展示和筛选需要的结构化字段，原始响应放 R2。

```sql
create table kline_bars (
  code text not null,
  period text not null,
  fq text not null,
  date text not null,
  open real,
  high real,
  low real,
  close real,
  volume real,
  amount real,
  turnover real,
  pe real,
  pb real,
  market_cap real,
  source text,
  updated_at integer not null,
  primary key(code, period, fq, date)
);

create index idx_kline_bars_code_date on kline_bars(code, date);
```

### `fund_profiles`

```sql
create table fund_profiles (
  code text primary key,
  name text not null,
  company text,
  manager text,
  fund_type text,
  scale text,
  start_date text,
  updated_at integer not null
);
```

### `fund_nav`

```sql
create table fund_nav (
  code text not null,
  date text not null,
  nav real,
  accum_nav real,
  daily_return real,
  dividend real,
  split_ratio real,
  updated_at integer not null,
  primary key(code, date)
);
```

### `fund_positions`

```sql
create table fund_positions (
  fund_code text not null,
  report_date text not null,
  security_code text not null,
  security_name text,
  shares real,
  market_value real,
  nav_pct real,
  source text,
  updated_at integer not null,
  primary key(fund_code, report_date, security_code)
);

create index idx_fund_positions_security on fund_positions(security_code);
```

### `fund_ranks`

```sql
create table fund_ranks (
  snapshot_date text not null,
  rank_type text not null,
  fund_code text not null,
  return_1m real,
  return_3m real,
  return_6m real,
  return_1y real,
  return_3y real,
  scale text,
  raw_score real,
  updated_at integer not null,
  primary key(snapshot_date, rank_type, fund_code)
);
```

### `financial_statements`

财务报表的期次索引。

```sql
create table financial_statements (
  code text not null,
  statement_type text not null,
  report_date text not null,
  fiscal_period text,
  source text,
  raw_r2_key text,
  updated_at integer not null,
  primary key(code, statement_type, report_date)
);
```

### `financial_metrics`

财务报表字段明细。这样可以兼容 A 股、港股、美股字段差异。

```sql
create table financial_metrics (
  code text not null,
  statement_type text not null,
  report_date text not null,
  metric_key text not null,
  metric_label text,
  value_num real,
  value_text text,
  unit text,
  primary key(code, statement_type, report_date, metric_key)
);

create index idx_financial_metrics_lookup
  on financial_metrics(code, metric_key, report_date);
```

### `corporate_actions`

分红、送转、股本变动、限售解禁等事件。

```sql
create table corporate_actions (
  id text primary key,
  code text not null,
  action_type text not null,
  event_date text,
  report_date text,
  title text,
  payload_json text,
  source text,
  updated_at integer not null
);

create index idx_corporate_actions_code_date on corporate_actions(code, event_date);
```

### `company_notices`

公告元数据。PDF 和原始响应放 R2。

```sql
create table company_notices (
  notice_id text primary key,
  code text not null,
  title text not null,
  publish_date text,
  notice_type text,
  source text,
  pdf_r2_key text,
  raw_r2_key text,
  updated_at integer not null
);

create index idx_company_notices_code_date on company_notices(code, publish_date);
```

### `source_cache_index`

跨源缓存索引。R2 存原始响应，D1 存索引和 TTL。

```sql
create table source_cache_index (
  cache_key text primary key,
  source text not null,
  url_hash text,
  r2_key text not null,
  status integer,
  fetched_at integer not null,
  expires_at integer,
  etag text,
  content_hash text,
  error text
);

create index idx_source_cache_expires on source_cache_index(expires_at);
```

### `sync_jobs`

```sql
create table sync_jobs (
  job_id text primary key,
  job_type text not null,
  status text not null,
  started_at integer not null,
  finished_at integer,
  error text,
  stats_json text
);

create index idx_sync_jobs_type_started on sync_jobs(job_type, started_at);
```

## R2 对象布局

```text
raw/eastmoney/finance/{code}/{statement_type}/{report_date}.json.gz
raw/eastmoney/kline/{code}/{period}/{fq}/{date}.json.gz
raw/eastmoney/fund/{code}/info/{date}.html.gz
raw/eastmoney/fund/{code}/position/{report_date}.json.gz
raw/eastmoney/notice/{code}/{notice_id}.json.gz
notices/{code}/{notice_id}.pdf
snapshots/kline/{code}/{period}/{fq}.json.gz
exports/d1-seed/{date}/securities.jsonl.gz
exports/d1-seed/{date}/kline_bars.jsonl.gz
```

原则：

- D1 只存结构化查询字段。
- R2 存原始响应、PDF、快照和导入导出文件。
- D1 中所有 R2 引用都用 `r2_key`，不要存公开 URL。
- 对外访问 PDF 时走 Worker 鉴权后从 R2 读取或签名跳转。

## 数据刷新策略

### 第一阶段只刷新关注范围

不要在 Workers 上全市场抓取。先维护一个关注列表：

```sql
create table watchlist_items (
  code text primary key,
  enabled integer not null default 1,
  priority integer not null default 100,
  tags text,
  updated_at integer not null
);
```

Cron 只刷新 `watchlist_items.enabled = 1` 的股票和基金。

免费额度版本中，Cron 默认不执行批量同步，只记录一次 skipped job。等关注列表、
失败重试和限流策略明确后，再打开小批量刷新。

### K 线

- 在线 API 先查 D1。
- 若缺最近 1 到 5 个交易日，可以请求上游小范围补齐。
- 完整历史回填不要在普通用户请求中做，交给 admin job 分批执行。
- D1 写入使用批量 upsert，每批控制在较小范围，避免单次请求过长。

### 财报

- 每天或每周刷新关注股票的三表。
- 财报期次低频变化，可以设置 6 到 24 小时 TTL。
- 原始 Eastmoney 响应存 R2，解析后的字段写 `financial_metrics`。
- 字段映射从配置文件导入，不要把大段业务字段硬编码在服务逻辑里。

### 基金

- 基金概况：每天刷新。
- 基金净值：每天刷新最近数据，历史回填分批做。
- 基金持仓：季度维度，低频刷新。
- 基金排行：按类型每天生成快照。

### 公告

- 元数据进入 D1。
- PDF 进入 R2。
- 首版只做列表和 PDF 打开，不做正文解析和摘要。

## 对外 API 设计

```text
GET /api/health

GET /api/search?q=
GET /api/securities/:code

GET /api/kline?code=&period=day&fq=normal&from=&to=

GET /api/finance/income?code=
GET /api/finance/balance?code=
GET /api/finance/cashflow?code=
GET /api/finance/actions?code=&type=

GET /api/fund/info?code=
GET /api/fund/nav?code=&from=&to=
GET /api/fund/position?code=&reportDate=
GET /api/fund/rank?type=&date=&page=&pageSize=

GET /api/company/notices?code=&page=&pageSize=
GET /api/company/notices/:noticeId/pdf

POST /api/admin/sync
GET /api/admin/sync/:jobId
```

API 响应保持稳定格式：

```json
{
  "code": 200,
  "msg": "OK",
  "data": {}
}
```

错误要暴露真实原因，不做静默 fallback：

```json
{
  "code": 502,
  "msg": "eastmoney finance request failed: status=403",
  "data": null
}
```

## 前端页面设计

第一版只做实用工作台，不做复杂门户。

页面：

- 首页：搜索框、关注列表、最近更新状态。
- 股票详情页：
  - 基本信息
  - K 线图
  - 财务三表 tabs
  - 分红、股本变动、限售解禁
  - 公司公告
- 基金详情页：
  - 基金概况
  - 净值走势
  - 持仓
  - 同类排行
- 同步状态页：
  - 最近 sync job
  - 失败源和错误信息

前端可以参考 `licai/web` 的已有 Vue 页面，但不要直接搬复杂导航和知识流。

## 上游数据源边界

优先使用无需浏览器态的接口：

- Eastmoney suggest
- Eastmoney datacenter 财务接口
- Eastmoney 基金净值、基金 F10、基金排行
- Eastmoney 公告接口

谨慎使用：

- Xueqiu K 线：本地 `licai` 依赖 Cookie 和模拟刷新，在 Workers 上不稳定。
- Yahoo K 线：部分市场可能需要 Cookie/crumb，Workers 在线请求不一定稳定。

处理原则：

- 在线 Worker 请求只走稳定、无需浏览器态的接口。
- 需要 Cookie 或浏览器态的数据源，改为本地或 admin job 离线同步到 D1/R2。
- 不添加“失败就换另一个源”的隐式 fallback。多源合并必须是显式配置和可观测状态。

## 迁移步骤

### 阶段 1：基础工程

- 初始化 Workers TypeScript 项目。
- 配置 `wrangler.jsonc`、D1 binding、R2 binding、Cron trigger。
- 建立 D1 migration。
- 实现 `/api/health`。

验收：

- `wrangler dev` 可启动。
- D1 migration 可本地和远端执行。
- `/api/health` 返回当前版本、D1/R2 binding 状态。

### 阶段 2：搜索和证券主数据

- 迁移代码归一化逻辑。
- 实现 `securities`、`security_aliases`。
- 实现 `/api/search`、`/api/securities/:code`。
- 导入本地 `licai/cfg/code-name.json`、`stock-info.json` 的可用部分。

验收：

- 常用 A 股、港股、美股、基金代码能搜索。
- 未命中时能请求上游并写入 D1。

### 阶段 3：K 线

- 实现 `kline_bars`。
- 先支持关注列表代码。
- 实现最近数据增量刷新。
- 历史数据回填作为 admin job。

验收：

- `/api/kline` 可返回 D1 数据。
- 缺最近数据时能补齐小范围数据。
- 大历史回填不会阻塞普通请求。

### 阶段 4：财务数据

- 实现三表抓取、解析、字段映射。
- 原始响应写 R2。
- 结构化字段写 D1。

验收：

- 股票详情页能展示 income、balance、cashflow。
- 字段映射缺失时返回可见错误或跳过记录统计，不静默成功。

### 阶段 5：基金数据

- 实现基金概况、净值、持仓、排行。
- ETF 联接基金等特殊逻辑后置，先保证普通基金路径稳定。

验收：

- 基金详情页能展示概况、净值走势、持仓。
- 持仓报告期可切换。

### 阶段 6：公告和 R2 PDF

- 实现公告元数据同步。
- PDF 入 R2。
- 实现 PDF 读取接口。

验收：

- 股票详情页能展示公告列表。
- 点击 PDF 能打开 R2 中的对象。

### 阶段 7：部署和运维

- 接入 Cloudflare Access 保护 admin API。
- 配置 Cron。
- 增加同步失败日志和状态页。
- 增加 D1/R2 备份导出脚本。

验收：

- 线上 Worker 可访问。
- Cron 能定时刷新关注列表。
- admin 页面能看到失败原因和最近更新时间。

## 后续新闻/研报扩展预留

后续如果要迁移新闻和研报，建议新增独立表，而不是复用股票行情表：

```text
documents
document_sources
document_security_links
document_read_state
document_scores
```

原始 PDF、HTML、Markdown 仍放 R2；D1 只放元数据、证券关联、阅读状态、推荐分数。

不建议第一阶段迁移 `licai` 的完整 knowledge/report 逻辑，因为它当前依赖本地文件、
SQLite/JSONL、PDF 转换脚本和 LLM cache，和 Workers 的运行模型差异较大。
