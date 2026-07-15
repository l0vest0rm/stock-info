# 外部数据获取与缓存策略

本文用于 review `stock-info` 中外部数据的获取方式：哪些可以在页面请求时通过 HTTP 获取，哪些应该由 Cloudflare Cron 定时刷新，哪些应该在 Mac 本地采集/加工后直接写入 D1 或 R2。

## 判断原则

### 运行环境配置分层

项目需要明确区分本地 Mac、Cloudflare staging、Cloudflare production 的外部访问配置。
业务代码不应该判断“现在是不是本地”，而是只读取运行时配置。

| 配置层 | 用途 | 示例 |
| --- | --- | --- |
| Mac 本地 | 本地开发、真实 Chrome 采集、本地代理 | Yahoo 等域名走 `127.0.0.1:7890` |
| Cloudflare staging | 线上预发验证、低风险数据源试跑 | 默认不走代理，可使用 staging D1/R2 |
| Cloudflare prod | 正式访问 | 默认不走代理，严格缓存和限流 |

当前约定：

| 变量 | 含义 |
| --- | --- |
| `HTTP_PROXY_URL` | Worker 访问外部域名时使用的真实代理地址，本地通常是 `http://127.0.0.1:7890` |
| `HTTP_PROXY_RELAY_URL` | 本地 Worker 调用的 Node 转发入口；Node 负责通过真实代理建立新连接 |
| `HTTP_PROXY_DOMAINS` | 需要走代理的目标域名列表，例如 `yahoo.com` |
| `HTTP_DOMAIN_CONCURRENCY` | 单个目标域名最大并发，默认 `3` |

`HTTP_PROXY_*` 是 Worker/http client 的统一配置。本地 Wrangler 不能直接运行 Node 的 `ProxyAgent`，因此 `start-local.sh` 会启动仅监听回环地址的 Node 转发器；线上未配置代理时不经过该转发器。

### 统一 HTTP Client

除 LLM 调用外，所有外部 HTTP 请求都必须通过 `src/shared/http.ts` 的统一 http client：

- Worker API、Cron、同步任务共用同一套请求、缓存、限流、代理逻辑。
- 默认按目标域名限流，单域名最大 3 并发，可由 `HTTP_DOMAIN_CONCURRENCY` 调整。
- 是否走代理由目标域名和 `HTTP_PROXY_*` 配置决定，不由业务 adapter 硬编码。
- 调用方可以提供 `cacheKey` 和 `cacheTtlMs`；不提供时由请求 method/url/header/body 生成稳定 cache key。
- 未命中 D1 `http_cache` 时才真实请求外部，成功后写入缓存。
- Cookie、Authorization 等敏感 header 默认不透传到本地转发器；确实需要时必须显式 `includeSensitiveHeaders`。

调用边界：

```text
routes/services/adapters
  -> cachedFetchJson/cachedFetchText
  -> http_cache lookup
  -> per-domain limiter
  -> optional proxy by domain
  -> external fetch
  -> write http_cache
```

LLM 调用不走该 client，因为 LLM 需要独立的模型配置、成本缓存、请求日志和重试策略。

### 允许页面请求时 HTTP 获取

满足以下大部分条件时，可以在用户请求 API 时临时访问外部 HTTP：

- 接口稳定，Worker 或本地 Node 访问不容易被 403/429。
- 单次响应快，正常情况下不影响首屏体验。
- 数据量小，解析和写入 D1 成本低。
- 数据实时性较高，访问时取比定时同步更合理。
- 失败不影响页面核心功能，或者能明确显示失败原因。
- 请求结果必须进入 D1 或 HTTP cache，不能裸请求重复打上游。

典型处理方式：

```text
API request
  -> read D1/cache
  -> if miss or stale, fetch upstream with timeout/concurrency control
  -> normalize and write D1/cache
  -> return data
```

### 应改为 Cloudflare Cron 定时刷新

满足以下条件时，应该从页面请求路径移到定时任务：

- 数据变化有固定节奏，例如交易日、每日、季度。
- 页面经常访问，用户不应该等待外部接口。
- 单次拉取可能包含多页、多接口或较复杂归一化。
- 数据适合按 watchlist、热门标的、最近访问标的分批刷新。
- Worker 直接访问上游基本稳定，但不适合用户请求时同步等待。

但 Cron 不应该理解为“全市场穷尽同步”。股票、基金、K 线这类数据的代码空间很大，
而真实访问通常高度集中在少数标的上。免费额度和 D1 写入成本都不适合定期扫描全量市场。

Cron 的合理范围应该来自热度和配置：

- watchlist 或手工配置的核心标的。
- 最近 N 天访问过的标的。
- 最近同步失败但仍有访问需求的标的。
- 首页、组合、持仓页面明确依赖的标的。

长尾标的采用按需补齐：首次访问时小范围获取并写 D1，之后再根据访问热度决定是否进入
Cron 维护范围。

典型处理方式：

```text
scheduled event
  -> read refresh scope from D1
  -> fetch upstream in small batches
  -> normalize/upsert D1
  -> record sync status and errors

API request
  -> read D1
  -> return data or visible "not synced" state
```

### 应由 Mac 本地采集/加工后写 D1/R2

满足以下条件时，不应该在 Worker 或页面请求时抓取：

- 需要真实浏览器、Cookie、CDP、登录态或反爬绕不过去。
- Node/Worker HTTP 即使补 header/cookie 也容易 403/429。
- 数据体积大，超过 D1 单条写入或请求体限制，需要分片。
- 需要 PDF 转 Markdown、LLM 摘要、去重、打分等重加工。
- 外部调用成本高或耗时长，不应该由用户访问触发。

典型处理方式：

```text
Mac local job
  -> browser/CDP/API/file processing
  -> normalize/chunk
  -> write remote D1 directly or call admin API
  -> put large raw/markdown objects in R2 when needed

API request
  -> read D1/R2 only
```

## 数据分类表

| 数据 | 当前/目标页面 | 推荐方式 | 存储 | 原因 | 当前状态 | 待确认 |
| --- | --- | --- | --- | --- | --- | --- |
| A 股 K 线 | `company.html` | 请求时获取 + 写 D1；常用标的 Cron 预热 | D1 | 东财接口稳定，实时性较高，数据结构规则 | 已接东财 | 补区间覆盖和过期策略 |
| 港股 K 线 | `company.html` | 请求时获取 + 写 D1；常用标的 Cron 预热 | D1 | 可按需取，但要观察上游稳定性 | 部分走 Yahoo/其它源 | 是否能稳定切到东财 |
| 美股 K 线 | `company.html` | 短期请求时获取 + 缓存；中期 Cron/本地同步 | D1 | Yahoo 可能限流，页面不应频繁打上游 | 当前有 Yahoo 路径 | 是否找东财美股 K 线替代 |
| 基金净值/K 线 | `fund.html` | 请求时获取 + 写 D1；关注基金 Cron | D1 | 东财基金数据稳定，变化频率低于行情 | 已有东财路径 | 补基金持仓同步范围 |
| 搜索建议/代码名称 | 全站搜索框 | 请求时获取 + 短 TTL 缓存 | D1/http_cache | 数据小，适合交互式请求 | 东财 + Yahoo | 美股搜索是否必须保留 Yahoo |
| 公司基础概览 | 公司页头部 | D1 优先；缺失时请求时获取并缓存 | D1 | 页面通用依赖，不能慢；行情可短 TTL | 东财/A 股较合理 | 美股/港股源统一 |
| 公司公告列表 | `company-notice.html` | 请求时按页获取 + 缓存；常用标的 Cron | D1 | 公告低频但页面按需分页 | 东财路径 | 是否保存公告详情/PDF 元数据 |
| 财报三表 | `company-finance.html`、估值指标 | Cron 或本地同步写 D1；页面只读 D1 | D1，必要时 R2 原始响应 | 季度数据，低频变化，不应页面打开时打外部 | 当前仍有请求时路径 | 美股/港股优先东财 endpoint，避免 Yahoo |
| 股本结构 | `company-shares.html` | Cron 或请求时一次获取后长 TTL D1 | D1 | 低频变化，页面不该重复拉 | 部分已迁移 | 各市场数据源 |
| 分红融资 | `company-dividend.html` | Cron 或请求时一次获取后长 TTL D1 | D1 | 低频变化，适合缓存 | 部分已迁移 | 港股/美股兼容 |
| 股东/机构持仓 | `company-holders.html` | Cron 同步 | D1 | 数据多、低频、可能多页 | 部分已迁移 | 同步范围和历史期数 |
| 研报列表/元数据 | `research-news.html` | Mac 本地处理后写 D1 | D1 | 来源多、需要去重/分类/推荐 | 已有只读查询模型和导入脚本 | 新闻源、保留周期 |
| 研报 PDF | 研报详情/附件 | Mac 本地下载/转换，线上默认不保存 PDF | 外部 URL + D1 元数据 | PDF 大，Worker 不适合处理，D1 不存 PDF | 已明确不入 D1 | 是否需要少量 PDF 留档到 R2 |
| PDF 转 Markdown | 研报/资讯 | Mac 本地处理后写 D1 `md_text` | D1 | CPU/IO/格式处理成本高，不由 Worker 执行 | 已有 D1 字段和导入脚本 | 超大 Markdown 是否分片或进 R2 |
| 新闻资讯 | `research-news.html` | Mac 本地或 Cron 聚合后写 D1 | D1 | 需要过滤、去重、推荐，不应前端触发抓取 | 已有只读查询模型 | 新闻源、保留周期 |
| LLM 摘要/推荐分 | 研报资讯、公司研报 | 本地/任务侧生成并缓存 | D1 | 成本高、慢、必须缓存 | 已有静态字段 | 模型、缓存 key、重算规则 |
| 美股期权链 | `company-option.html` | Mac 本地 Chrome 采集后写 D1；页面只读 D1 | D1 分片 | Yahoo 浏览器可用，Node/Worker 模拟易 429 | 已验证 MU 本地缓存 | 定时采集频率和标的范围 |
| 期权策略/对比 | `company-option.html` | 页面本地计算，基础数据读 D1 | 无或 D1 保存用户策略 | 纯计算，不需要外部 HTTP | 已在前端计算 | 是否保存常用策略 |
| 13F 季度数据 | `13f.html` | Cron 或本地同步 | D1/R2 | 低频、批量、适合离线 | 部分迁移 | 数据源和增量策略 |

## 页面请求路径建议

### `company.html`

页面可以触发轻量行情/K 线请求，但应 D1/cache 优先：

- K 线：请求时获取可以保留，常用标的 Cron 预热。
- 概览：D1/cache 优先，短 TTL。
- 财务衍生指标：不要因为缺财报而在页面实时打慢接口；应从 D1 财报计算。

### `company-finance.html`

目标是只读 D1：

- 页面请求 `/api/finance/income|balance|cashflow`。
- 后端优先读 D1。
- 缺失时短期可返回空数组和同步状态；不要实时走 Yahoo。
- 财报同步由 Cron 或本地脚本处理。

### `company-option.html`

目标是只读 D1：

- `/api/options/us` 只读 D1 分片缓存。
- 缺失时返回明确错误，例如 `option chain not synced`。
- 本地脚本通过真实 Chrome/Yahoo 页面采集并写 D1。
- 页面不应该因为财报预取失败弹出 429/500。

### `research-news.html`

目标是只读已加工数据：

- 新闻/研报元数据读 D1。
- PDF 不进入 D1；页面展示本地加工后的 Markdown，第一阶段直接读 D1 `md_text`。
- 推荐分、摘要、标签由本地/任务侧预先生成。
- 页面交互只做公开筛选、搜索、分页和详情查看；暂不做登录、收藏、阅读状态或行为反馈。

本地加工路径：

```text
download pdf/html/news
  -> pdf to markdown on Mac
  -> LLM extracts summary/tags/recommendation/rank fields
  -> write JSON/JSONL
  -> npm run import:knowledge:docs -- --file out/knowledge-docs.jsonl --remote
```

默认的一次性处理入口：

```text
./process-knowledge.sh
```

脚本会先调用东财 `reportapi.eastmoney.com/report/list` 抓取个股研报和行业研报列表，
写入 `/Users/terry/git/data/reports`，再处理 `/Users/terry/git/data/reports` 和
`/Users/terry/git/data/news` 目录及其子目录里的新增 `.json`、`.jsonl`、
`.md`、`.txt`、`.pdf` 文件，生成导入 JSONL，写入 D1，然后把成功文件移动到
`/Users/terry/git/data/stock-info/knowledge/processed`。失败文件移动到
`/Users/terry/git/data/stock-info/knowledge/failed` 并保留错误日志。
默认写本地 D1；需要写远端时用 `./process-knowledge.sh --remote`，或在
`config/knowledge-processing.json` 中把 `remote` 改为 `true`。

默认每次按上次处理水位继续推进，避免每天执行时反复从头扫描同一批历史 backlog：

```text
./process-knowledge.sh
```

默认不按运行时长截断，而是按来源日期限制处理窗口：新闻只处理最近
`maxNewsAgeDays` 天，研报只处理最近 `maxReportAgeDays` 天。当前默认是新闻 14 天、
研报 60 天；这个窗口在 `config/knowledge-processing.json` 里调整。日期优先从文件路径/
文件名里的 `YYYY-MM-DD` 或 `YYYYMMDD` 推断，取不到时使用文件 mtime。超出窗口的历史文件
本次跳过并留在原目录，不会被移动或入库。

东财研报列表抓取有单独断点：
`/Users/terry/git/data/stock-info/knowledge/state/eastmoney-report-fetch-state.json`
会记录上次成功抓取的 `lastEndTime`。正常重复执行时从 `lastEndTime - overlapDays`
开始抓，默认只重叠 1 天，避免接口延迟或当天补发；只有首次执行或长期未执行时，才最多
回看 `eastmoneyReports.lookbackDays` 天，未单独配置时跟随 `maxReportAgeDays`。

本地文件扫描也有断点：成功处理的源文件会移动到 `processed`，失败文件移动到 `failed`；
同时 `/Users/terry/git/data/stock-info/knowledge/state/local-scan-state.json` 会记录上次成功
扫描的开始时间。下一次只处理这个时间点之后变化的目录和文件；如果脚本中途失败，不推进
这个扫描时间水位，下一次还能继续处理本轮未完整完成的变化。

重复执行时还会按 D1 中已有的 `doc_id` 去重：`knowledge_docs` 和
`knowledge_filtered_docs` 任一表里已存在的文档都会跳过。这样东财当天列表或本地新闻
再次出现时，不会重复做 PDF 转 Markdown、主题过滤和导入；整文件都是已处理文档时会直接
归档到 `processed`。

项目不长期依赖 `licai` 的数据库。日常新增新闻/研报必须由 `stock-info` 自己的采集
或本地加工流程产出。

为了控制处理时间、D1 写入和 Cloudflare 免费额度，入库前默认启用 `AI产业链` 主题过滤。
脚本会先用本地关键词过滤，只保留大模型、算力、AI 芯片、服务器、数据中心、存储、
半导体、先进封装、光模块/CPO 等相关内容。不相关文件会移动到 `processed`，
但不会写入 D1。

每次本地执行都会在 `/Users/terry/git/data/stock-info/knowledge/reviews` 写一份
`topic-filter-*.md` 和 `topic-filter-*.jsonl`，其中包含保留和被过滤掉的标题、分数、
命中原因和源文件路径，用来复核过滤规则是否过严或过松。Cloudflare 线上页面只查询 D1，
因此只会看到过滤后入库的内容。

LLM 增强默认关闭。需要本地批量抽取摘要、标签和推荐分时，先配置 API key，再设置
`KNOWLEDGE_PROCESS_LLM=1 ./process-knowledge.sh`；这样不会在普通无参数执行时消耗
模型额度。

对“本地关键词不确定”的内容，可以启用豆包 mini 做主题复核：

```text
KNOWLEDGE_PROCESS_TOPIC_LLM=1 ./process-knowledge.sh
```

默认模型配置在 `config/knowledge-processing.json`：`doubao-seed-2-0-mini-260215`，
API key 读取 `VOLC_ARK_API_KEY`。复核会把边界样本按标题/摘要列表批量提交，
默认每批最多 50 条；不会对所有新闻/研报逐条调用模型。

## 当前需要优先调整的接口

| 接口 | 当前问题 | 建议目标 |
| --- | --- | --- |
| `/api/finance/income?code=MU.US` | 不应实时走 Yahoo；用户确认用东财即可 | 接入东财美股财报 endpoint，写 D1；页面读 D1 |
| `/api/options/us?code=MU.US` | 已证明 Worker/Node 模拟 Yahoo 不稳定 | 保持本地 Chrome 采集写 D1，接口读 D1 |
| `/api/kline?code=MU.US` | 如果仍走 Yahoo，长期可能同样限流 | 优先寻找东财美股 K 线；否则常用美股定时/本地同步 |
| 搜索框美股建议 | Yahoo suggest 可能受代理/限流影响 | D1 本地证券表优先；Yahoo 只作为可失败补充 |

## 热度分层策略

不能把“定时任务”设计成全量扫描。更合理的是按访问热度分层：

| 层级 | 范围 | 获取方式 | 刷新策略 | 说明 |
| --- | --- | --- | --- | --- |
| 核心标的 | 手工 watchlist、持仓、首页固定标的 | Cron + D1 | 高频小批量刷新 | 用户最可能访问，值得预热 |
| 热标的 | 最近 N 天访问过、访问次数较多 | Cron + D1 | 中频刷新，过期后降级 | 由访问日志或 `security_access` 统计驱动 |
| 冷标的 | 偶发访问 | 请求时小窗口获取 + D1 | 不进入 Cron，除非反复访问 | 避免为长尾浪费额度 |
| 大历史 | 很长时间范围的历史 K 线、全量财报历史 | 本地回填或 admin job | 手工触发 | 不在用户请求和普通 Cron 中完成 |

### 对 K 线的具体原则

K 线的问题不是单个标的大，而是标的数量非常多。策略应是：

- 不做全市场每日 K 线同步。
- 用户首次访问某个冷门标的时，只拉页面需要的区间或合理默认区间。
- 写入 D1 后记录访问时间、访问次数、最近请求区间。
- Cron 只维护核心/热标的的最近增量，例如最近 30 到 120 个交易日。
- 长历史回填只在用户明确访问长区间、或者本地脚本/admin job 手工触发时做。
- D1 查询应能判断已有区间是否覆盖请求区间，缺口只补缺口，不重复全量拉取。

建议增加或完善的元数据：

| 表/字段 | 用途 |
| --- | --- |
| `security_access` | 记录标的访问次数、最近访问时间、最近页面 |
| `kline_sync_state` | 记录每个 code/period/fq 的已覆盖区间、最近同步时间、失败信息 |
| `watchlist_items` | 手工或组合驱动的核心同步范围 |
| `sync_jobs` | 记录 Cron/admin job 的执行结果和错误 |

### 对财报/公告的分层

财报和公告也不适合全市场穷尽同步：

- 核心/热标的由 Cron 定期刷新。
- 冷标的页面请求时可以返回已有 D1 数据和“未同步/可触发同步”状态。
- 如果上游接口稳定且数据量小，冷标的首次访问可以按需同步最近几期。
- 需要多页、多源、LLM 加工的内容不在页面请求中同步。

## 存储原则

### D1

适合：

- 结构化行数据。
- 可分页/筛选/排序的元数据。
- K 线、财报、公告、新闻、研报索引、期权分片。
- 同步状态、失败原因、更新时间。

不适合：

- 大型原始响应整包。
- PDF、图片、长 Markdown。
- 超大 JSON 单条写入。

### R2

适合：

- PDF 原文。
- 转换后的 Markdown。
- 大型原始响应快照。
- 需要长期保留但不常参与 SQL 查询的对象。

### HTTP cache / `app_kv`

适合：

- 短 TTL 上游响应缓存。
- 小型配置/会话/分片 meta。
- 近期请求结果。

不适合：

- 需要复杂查询的数据主表。
- 长期业务事实的唯一来源。

## Review 待定问题

- 美股/港股财报是否全部可以用东财 F10 数据源覆盖。
- 美股 K 线是否切到东财，还是对常用标的用本地同步。
- Cron 范围以 watchlist、最近访问、还是手工配置标的列表为准。
- 期权链刷新频率：盘中、每日、按需手工触发，还是只同步关注标的。
- 研报 Markdown 放 D1 分片还是 R2 对象。
- 是否需要 admin API，还是全部使用本地脚本直写远端 D1。
