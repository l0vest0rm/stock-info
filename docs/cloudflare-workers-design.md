# Cloudflare Workers 版 licai 迁移方案

## 目标

把本地 `licai` 中股票、基金、K 线、财报、公告以及后续新闻/研报能力迁移到
当前 `stock-info` 项目和 Cloudflare Workers。`licai` 后续会逐步废弃，所有线上
能力最终都必须由 `stock-info` 承接。

迁移方式不是重做一个新站，而是尽量完整复用 `licai/web` 前端页面、样式和交互，
同时把后端接口从 Rust/Axum 重写为 TypeScript/Hono Worker。

第一批验收页面以：

```text
company.html?code=300308.SZ&from=1735689600000
```

为基准。迁移阶段先完整搬迁页面和接口，不做“迁移一个页面就对比一次”的验收。
等整体迁移完成后，再本地同时启动 `licai` 和 `stock-info`，集中对比页面内容、
接口响应和图表。本地总体验收一致后再提交到 `main` 触发 Cloudflare 部署。
对比只用于最终验收，不是长期双系统依赖。

## 运行时约束

- Workers 是 V8 isolate 运行时，不是完整 Node.js 服务器。可以开启
  `nodejs_compat`，但不能依赖本地文件系统、原生 SQLite、长驻进程、CDP 浏览器。
- 免费额度适合请求时小范围补数据、低频 Cron、小批量 D1 写入，不适合全市场扫描。
- D1 负责结构化查询数据：K 线、财报字段、公告元数据、新闻/研报元数据、同步状态。
- R2 负责确实需要留档的大对象或原始对象：原始响应、压缩 JSON、超大 Markdown、快照。
  研报 PDF 第一阶段不进入 Cloudflare，D1 最多保存本地转换后的 Markdown 内容。
- 浏览器态、Cookie 刷新、PDF 转 Markdown、LLM 解析等任务放在 Mac 本地或独立任务侧，
  通过远程 D1 或受控 API 写入 Cloudflare。

## 最终所有权

`stock-info` 是未来唯一承载项目，`licai` 只是迁移期的源代码参考和验收对照。

最终状态：

- 前端页面、样式、运行时代码都在 `stock-info/web`。
- 对外 API、定时任务、admin 导入都在 `stock-info/src`。
- 结构化数据在 Cloudflare D1。
- 原始响应、Markdown、大对象在 R2。
- Mac 本地只保留导入、加工、Cookie 刷新、PDF 转 Markdown、LLM 批处理等任务脚本。
- 线上访问不依赖 `licai` 的服务、文件、数据库或缓存。

迁移期允许从 `licai` 复制代码，但每个功能完成后都要在 `stock-info` 内形成完整实现：

- 页面源码复制到 `stock-info/web`。
- API 合约复制并用 TypeScript 实现。
- 数据表、导入脚本、同步任务进入 `stock-info`。
- 验收通过后，对应功能不再从 `licai` 读取运行时状态。

## 总体架构

```text
licai/
  web/                         迁移期前端源码参考和对照服务
  server-rs/                   迁移期接口语义参考

stock-info/
  web/                         尽量从 licai/web 迁移，不重新设计样式
  src/
    index.ts                   Hono 入口、assets、scheduled
    routes/                    兼容 licai 的 /api/* 路由
    services/                  业务编排：缓存、D1、上游源、入库
    adapters/                  Eastmoney/Xueqiu/Yahoo/公告/基金等源适配
    db/                        D1 查询、迁移、批量 upsert
    shared/                    http、代码归一化、日期、响应格式、限流
    sync/                      Cron 和回填任务
    import/                    本地直写远端 D1 的数据模型和脚本
  migrations/                  D1 schema
  docs/                        迁移设计和验收记录
```

部署上先保持一个 Worker：

```text
Browser -> stock-info Worker
  /company.html, /js/*, /css/*   -> Assets: web/dist
  /api/*                         -> Hono routes
  scheduled event                -> sync jobs
```

后续如果 Cron、admin 导入、公开 API 的资源隔离需求变强，再拆成：

```text
web-worker     对外页面和查询 API
sync-worker    Cron 定时加工
admin-worker   本地导入、回填、重建索引
```

## 数据分层

### 1. 请求时临时获取并写 D1

适合用户访问时按需补齐，且单次耗时可控的数据。

当前优先项：

- 股票/基金 K 线
- 股票概览和实时估值
- 公司公告最近列表
- 搜索建议和代码名称解析

处理流程：

```text
GET /api/kline
  -> 查询 D1 是否覆盖请求区间且未过期
  -> 未命中或过期时请求上游小范围数据
  -> 解析为结构化 rows
  -> 批量 upsert 到 D1
  -> 返回 licai 兼容响应
```

要求：

- 首次请求应尽量控制在 1 秒以内；如果稳定超过目标，就改为定时或 admin 回填。
- 普通请求只补最近小窗口，不做全历史大回填。
- 命中 D1 时应在几十毫秒级返回。
- 错误要暴露真实上游状态，不做静默 fallback。

本地已验证的 K 线路径：

- `300308.SZ` 东财首次请求约 520ms。
- 写入 D1 后同路由约 12ms。
- 这符合“请求时取并落 D1”的第一阶段模型。

### 2. Cloudflare 定时任务处理

适合低频、关注列表范围、可切片处理的数据。

当前优先项：

- watchlist 中股票的财报三表刷新
- watchlist 中基金净值和持仓刷新
- 公告元数据刷新
- 最近 K 线小窗口预热
- 同步任务状态和失败记录

处理流程：

```text
scheduled event
  -> 创建 sync_jobs 记录
  -> 读取 watchlist_items
  -> 按任务类型和优先级小批量执行
  -> 每个上游域名走并发限制
  -> D1 upsert 结构化数据
  -> 必要时 R2 保存原始响应
  -> 更新 sync_jobs stats/error
```

免费额度策略：

- 默认只跑关注列表，不做全市场。
- 每次 Cron 设置最大处理数量和最大耗时。
- 失败任务记录错误和源 URL，不无限重试。
- 大回填必须走 admin job 或本地导入。

### 3. Mac 本地加工后写入 Cloudflare

适合依赖本地文件、浏览器、PDF、LLM、长任务的数据。

当前优先项：

- 新闻、研报元数据
- PDF 转 Markdown
- LLM 研报字段抽取和摘要
- 需要 CDP/Cookie 的数据源
- 大批量历史回填

采用一种主写入方式：本地脚本直接写远端 D1。

```text
Mac 本地加工脚本
  -> 读取本地抓取结果、PDF 转 Markdown 结果、LLM 结构化结果
  -> 生成幂等 SQL 或批量参数
  -> wrangler d1 execute stock_info --remote --file ...
  -> 写入远端 D1
```

执行原则：

- 本地脚本负责校验、去重、幂等 upsert、批量大小控制和导入日志。
- 远端 D1 是结构化数据的最终落点。
- R2 写入只在确实需要保存 Markdown 或原始大对象时引入。
- 不把 admin ingest API 作为第一阶段方案；除非后续需要浏览器外部系统写入，再单独设计。
- 研报 PDF 本身不必进入 Cloudflare；第一阶段保存 Markdown 到 D1 `md_text`，
  只有超大 Markdown 或原始响应确实需要留档时再写 R2。

## 前端迁移策略

原则：尽量不要重做前端。

`stock-info/web` 应从 `licai/web` 迁移，而不是继续维护一套差异很大的 Vue 新页面。
具体策略：

- 复制 `licai/web/src` 中目标页面、partials、runtime、样式、构建脚本。
- 复制 `licai/web/src/company.html`、`company-pages-runtime.ts`、`chart.ts`、
  `legacy-runtime.ts`、`api.ts` 等页面依赖。
- 保留页面 DOM 结构、Bootstrap/DataTables/ECharts 风格。
- 只有当 Worker 环境要求接口路径或静态资源路径变化时，做最小适配。
- 不优先改样式，不新增卡片化重设计，不把原页面重写成另一套 UI。

第一阶段页面迁移顺序：

1. `company.html`
2. `company-finance.html`
3. `company-notice.html`
4. `fund.html`
5. `fund-position.html`
6. `research-news.html`

页面迁移期间不逐页对比 `licai`。先按页面和接口清单整体迁移，等核心页面、
共享运行时代码和后端接口全部进入 `stock-info` 后，再做集中对比验收。

## 后端接口迁移策略

后端只迁移 `/api/*` 合约，不迁移 Rust 运行时本身。

迁移原则：

- 先读 `licai/server-rs` 中对应 handler，保持参数、响应结构和错误语义一致。
- TypeScript 代码按 `routes -> services -> adapters -> db/shared` 分层。
- 业务源适配只在 `adapters` 中处理，上层不拼接上游 URL。
- D1 查询和 upsert 只在 `db` 中处理，上层不写 SQL 字符串。
- 大字段映射、指标名、分类、源配置放 JSON/config，不写在服务逻辑里。

第一批接口：

```text
GET /api/kline
GET /api/suggest
GET /api/code/name
GET /api/company/overview
GET /api/company/notices
GET /api/finance/income
GET /api/finance/balance
GET /api/finance/cashflow
```

后续接口：

```text
GET /api/fund/info
GET /api/fund/position
GET /api/fund/constituents
GET /api/fund/rank
GET /api/knowledge/news
GET /api/knowledge/file
本地导入脚本直接写远端 D1，第一阶段不提供公开 ingest API。
```

## 公共模块

### HTTP 客户端

需要抽一个 Worker 版公共 HTTP 层，替代零散 `fetch`。

能力：

- 默认浏览器 UA、Referer、Accept-Language。
- JSON/JSONP/text/bytes 解析。
- 错误消息保留 status 和截断 body。
- 按域名限并发，例如：
  - `push2his.eastmoney.com`: 1 到 2
  - `datacenter-web.eastmoney.com`: 2
  - `stock.xueqiu.com`: 1
- 超时控制。
- 可选 D1/R2 cache index。
- 请求日志只记录高价值失败，不刷屏。

不做：

- 不做隐式多源 fallback。
- 不在 HTTP 层吞错。
- 不在 HTTP 层内置业务 URL。

### 代码归一化

从 `licai/server-rs/src/common.rs` 迁移为 TypeScript：

- A 股：`300308.SZ`、`601138.SH`
- 北交所：`.BJ`
- 场内基金：`.SF`、`.ZF`
- 场外基金：`.OF`
- 港股：`.HK`
- 美股：`.US`、`.O`、`.N`
- 韩股：`.KS`、`.KQ`

所有路由入口先归一化，D1 主键也使用归一化代码。

### LLM client

Worker 和本地脚本侧需要一个 TypeScript 版 `llm-client`，接口风格参考本地共享
Rust `llm-client`，但不要把 Rust crate 作为运行时依赖。

第一阶段只预留模块和类型，不接入新闻/研报：

```text
src/shared/llm/
  client.ts
  providers.ts
  types.ts
```

后续研报解析时再实现：

- 模型配置集中管理。
- 并发限制。
- 失败可见。
- 可选 D1/R2 缓存。
- 本地脚本和 Worker 内部任务使用同一请求/响应模型。

## K 线数据源策略

优先 Eastmoney，因为不需要 CDP。

当前 Eastmoney A 股 K 线请求需要贴近东财页面请求：

- `fields1=f1..f13`
- `fields2=f51..f61`
- `ut=fa5fd1943c7b386f172d6893dbfba10b`
- `rtntype=6`
- `Referer: https://quote.eastmoney.com/`
- 浏览器 UA
- `Cookie: nid18=1`

本地 `wrangler dev --local` 已验证这组参数能返回 `300308.SZ` K 线并写入 D1。

如果线上 Worker 仍被 Eastmoney 拒绝，再切 Xueqiu，但不是在 Worker 里跑 CDP。
Xueqiu 方案：

```text
Mac 本地定时任务
  -> 通过 CDP 打开雪球，获取有效 cookie
  -> 生成 D1 upsert SQL 或调用 wrangler d1 execute
  -> 写入 source_credentials

Worker /api/kline
  -> 读取存储的 Xueqiu cookie
  -> 使用从 licai 迁移的雪球 K 线请求和解析逻辑
  -> 写入 kline_bars
  -> 返回兼容响应
```

Cookie 存储：

```sql
create table source_credentials (
  source text primary key,
  credential_type text not null,
  payload_json text not null,
  updated_at integer not null,
  expires_at integer
);
```

要求：

- Cookie 过期时返回明确错误。
- 不做 Eastmoney 失败自动切 Xueqiu；数据源切换必须是显式配置。

## D1 数据模型

当前已有基础表，后续按迁移补齐。

核心表：

```sql
securities(code, market, type, name, currency, exchange_name, source, updated_at)
security_aliases(alias, code, source, updated_at)
kline_bars(code, period, fq, date, open, close, high, low, volume, amount, amplitude, pct_change, change_amount, turnover, source, updated_at)
fund_nav(code, date, nav, accum_nav, daily_return, subscription_status, redemption_status, updated_at)
financial_statements(code, statement_type, report_date, fiscal_period, payload_json, source, raw_r2_key, updated_at)
company_notices(notice_id, code, title, publish_date, notice_type, source, pdf_r2_key, raw_r2_key, updated_at)
watchlist_items(code, enabled, priority, tags, updated_at)
sync_jobs(job_id, job_type, status, started_at, finished_at, error, stats_json)
```

建议新增：

```sql
source_cache_index(cache_key, source, url_hash, r2_key, status, fetched_at, expires_at, etag, content_hash, error)
source_credentials(source, credential_type, payload_json, updated_at, expires_at)
research_items(id, source, title, publish_time, item_type, url, code, tags_json, summary, md_r2_key, payload_json, updated_at)
research_documents(id, item_id, title, publish_time, source, md_text, md_r2_key, payload_json, updated_at)
fund_positions(fund_code, report_date, security_code, security_name, shares, market_value, nav_pct, source, updated_at)
fund_profiles(code, name, company, manager, fund_type, scale, start_date, payload_json, updated_at)
```

## R2 对象布局

```text
raw/eastmoney/kline/{code}/{period}/{fq}/{yyyymmdd}.json.gz
raw/eastmoney/finance/{code}/{statement_type}/{report_date}.json.gz
raw/eastmoney/notices/{code}/{notice_id}.json.gz
raw/xueqiu/kline/{code}/{period}/{fq}/{yyyymmdd}.json.gz
research/md/{source}/{yyyy}/{id}.md
research/raw/{source}/{yyyy}/{id}.json.gz
snapshots/kline/{code}/{period}/{fq}.json.gz
exports/d1-seed/{date}/{table}.jsonl.gz
```

PDF 策略：

- 外部 PDF 不默认搬入 R2。
- 本地可把 PDF 转 Markdown，然后优先写 D1 `md_text`。
- R2 `research/md/*` 只作为超大 Markdown 或长期留档的后续扩展。
- 只有需要稳定留档的 PDF 才进入 R2。

## 集中本地验证流程

迁移阶段先完成页面、共享前端运行时代码、后端接口、D1 schema 和本地导入脚本。
不要迁移一个页面就对比一次，避免把时间耗在半成品差异上。整体迁移完成后，
再集中做本地总体验证，不直接 push 消耗 Cloudflare 构建次数。

`licai` 只作为迁移期对照服务；总体验收通过后，后续开发以 `stock-info` 为准。

```text
1. 启动 licai
   cd /Users/terry/git/licai
   ./licai-server.sh

2. 启动 stock-info
   cd /Users/terry/git/stock-info
   npm run build
   npm run db:migrate:local
   npm run dev:worker

3. 打开对照页面
   licai:      http://127.0.0.1:8080/company.html?code=300308.SZ&from=1735689600000
   stock-info: http://127.0.0.1:8788/company.html?code=300308.SZ&from=1735689600000

4. 集中对比
   - 页面结构和样式
   - K 线图
   - 代码名称、行情指标
   - 财报表格
   - 公告列表
   - 控件行为
   - 网络请求状态
```

验收标准：

- 已迁移页面主要内容一致。
- 已迁移接口关键字段一致。
- 新 Worker 版没有隐藏失败。
- D1 命中路径和上游补齐路径都可验证。
- 本地脚本可直接写远端 D1，并且导入可重复执行。
- 本地通过后，再提交到 `main` 触发 Cloudflare 构建。

## 迁移阶段

### 阶段 0：收敛当前方向

- 停止继续维护差异很大的新 `CompanyApp.vue` 页面。
- 记录当前 Eastmoney K 线修复结果。
- 确认 `web/dist` 由 Cloudflare build 产出，不提交构建产物。

### 阶段 1：迁移 licai company 页面

- 复制 `licai/web` 中 company 页面依赖。
- 调整 Vite 多页面构建。
- Worker assets 输出 `company.html` 和对应 JS/CSS。
- 后端补齐 company 页面实际调用的 `/api/*`。
- 暂不做逐页对比，纳入整体迁移后的集中验收。

### 阶段 2：补齐股票接口

- `/api/kline`
- `/api/suggest`
- `/api/code/name`
- `/api/finance/*`
- `/api/company/notices`
- `/api/company/restriction`
- 分红、股本、持有人等低频接口

### 阶段 3：基金接口

- 基金概况
- 净值
- 持仓
- 份额变化
- 排行
- ETF/场内基金特殊代码归一化

### 阶段 4：定时任务和本地 D1 导入

- `sync_jobs`
- `watchlist_items`
- Cron 小批量刷新
- 本地导入脚本直接写远端 D1
- Xueqiu cookie 本地刷新并写入远端 D1

### 阶段 5：新闻和研报

- 迁移 `research-news.html` 页面。
- 本地完成抓取、PDF 转 Markdown、LLM 处理。
- Markdown/元数据通过本地脚本写入远端 D1，PDF 不入 D1。
- Worker 只负责查询和展示，推荐排序使用预先写入的静态分数，不做请求时 LLM 或复杂个性化排序。

### 阶段 6：废弃 licai 运行依赖

- 清点 `stock-info` 中仍引用 `/Users/terry/git/licai` 的脚本、文档和临时路径。
- 把仍需要保留的本地加工能力迁移到 `stock-info/scripts` 或 `stock-info/tools`。
- 确认线上 Worker、远端 D1/R2、本地导入脚本都不依赖 `licai` 运行态。
- 保留 `licai` 作为历史归档或只读参考，不再作为功能入口。

## 部署策略

当前只用 `main` 分支。

- 本地验证通过。
- 提交到 `main`。
- Cloudflare 上关闭 `stock-info` 的 Git 自动部署，避免和本机手动发布互相覆盖。
- 本机执行 `./deploy-cloudflare.sh`，在本地完成 `typecheck`、`build`、`wrangler deploy --dry-run`。
- 脚本会读取 `wrangler.jsonc` 里的 `r2_buckets`，正式发布前逐个校验 bucket 是否存在；只有显式传 `--create-missing-r2` 才会代为创建。
- 远端 D1 migration 通过脚本显式执行。
- 再执行正式 `wrangler deploy`。
- Worker 通过 `assets.directory=./web/dist` 提供页面。
- 生产域名通过 `wrangler.jsonc` 中的 `routes[].custom_domain=true` 绑定到 `tinfo.cc`。

当前已经明确切换到 token 部署模式。不要再保留第二条 Git 自动部署链路。

## 当前风险

- Eastmoney K 线本地 Worker 已通，但线上 Cloudflare 出口仍可能被上游区别对待。
- `licai/web` 是多页面 legacy/Vue 混合结构，迁移时要优先保持构建链路一致。
- DataTables、Bootstrap、ECharts 等静态依赖路径需要逐项确认。
- D1 写入批次和免费额度需要控制，不能把 licai 本地缓存行为原样搬到 Worker。
- 本地导入远端 D1/R2 必须补鉴权、幂等和错误记录。
