# 全球宏观市场监测页设计方案

## 1. 目标与边界

新增“宏观”页面，用统一框架观察影响美股、A 股、港股和韩国股市的宏观环境，回答：

1. 当前增长、通胀、流动性、信用和外部风险分别处于什么状态；
2. 哪些变化主要影响企业盈利、折现率、风险溢价或跨境资金；
3. 四个市场对同一冲击的敏感度有何差异；
4. 数据何时更新、是否修订、是否过期，以及下一项重要事件是什么。

页面是研究与观测工具，不生成单一“买入/卖出”结论，也不把宏观数据的上升或下降机械解释为股市利好或利空。

## 2. 领域模型

- **指标（Indicator）**：由官方机构或获授权的数据源发布的原始时间序列。
- **观测值（Observation）**：某指标在特定统计期、特定发布时间公布的值；同一统计期可以有多个修订版本。
- **事件（Event）**：央行会议、经济数据发布、财政或监管公告等有明确时间的事项。
- **信号（Signal）**：依据指标水平、趋势、意外程度、阈值和时效性形成的可解释状态。
- **传导渠道（Transmission Channel）**：宏观变化影响股票的路径，分为盈利、折现率、风险溢价和资金流。
- **市场状态（Market State）**：估值、盈利修正、成交、资金和市场宽度等价格或交易层信息，不与宏观指标混为一类。

## 3. 宏观因子框架

| 一级因子 | 典型指标 | 主要传导 |
| --- | --- | --- |
| 增长 | GDP、PMI、新订单、工业产出、零售、出口 | 企业收入和盈利预期 |
| 通胀 | CPI、PPI、核心 PCE、工资、通胀预期 | 央行政策、实际利率、利润率 |
| 利率与流动性 | 政策利率、国债收益率、实际利率、央行资产负债表 | 估值折现率和融资成本 |
| 信用 | 社融、贷款、信用利差、银行放贷标准 | 经济周期、融资可得性和违约风险 |
| 汇率与跨境资金 | 美元、人民币、港元、韩元、跨境资金 | 外资流向、进口成本和盈利换算 |
| 商品与供应链 | 原油、铜、黄金、运价、库存 | 通胀、成本和资源品盈利 |
| 政策与外部风险 | 财政、监管、关税、出口管制、地缘事件 | 风险溢价和行业估值 |

所有因子最终通过四条路径影响股票：

```text
宏观变化
├─ 盈利：收入、成本、利润率
├─ 折现率：名义利率、实际利率、期限溢价
├─ 风险溢价：信用风险、政策不确定性、地缘风险
└─ 资金流：汇率、套息、跨境配置、杠杆
```

## 4. 市场差异

| 市场 | 特有核心因素 | 建议对照指数 |
| --- | --- | --- |
| 美股 | 美联储反应函数、实际利率、非农和通胀、国债供给、信用利差、科技资本开支 | 标普 500、纳斯达克、罗素 2000 |
| A 股 | 社融与信用脉冲、人民银行流动性、房地产、财政和产业政策、人民币、出口 | 沪深 300、中证 1000、创业板 |
| 港股 | 中国盈利周期、美元利率、联系汇率、HIBOR、离岸风险溢价、南向资金 | 恒生指数、国企指数、恒生科技 |
| 韩国 | 半导体周期、前 20 日出口、全球电子需求、韩元、外资流、油价和家庭负债 | KOSPI、KOSDAQ |

典型跨市场关系：

- 美国实际利率上升通常压制长久期成长估值，港股科技和韩国成长板块也会受到外溢影响；
- 中国信用和增长改善直接支持 A 股盈利，对港股和韩国出口链也有较强传导；
- 美元走强通常增加人民币和韩元压力，并收紧香港离岸流动性；
- 半导体周期上行对 KOSPI 最敏感，同时支持美股科技、A 股电子和港股科技；
- 油价上涨利好能源生产企业，但对韩国等能源进口经济体的贸易条件偏负面；
- 风险厌恶上升时，港股和韩国通常比以内资为主的 A 股更快反映跨境资金压力。

以上方向均是“其他条件不变”的基础方向。信号必须允许状态依赖，例如收益率因增长改善而上涨，与因通胀失控而上涨，对股市的含义不同。

## 5. 页面信息架构

### 5.1 首屏

1. 全球五维状态：增长、通胀、流动性、信用、外部风险；
2. 数据健康：最近同步时间、过期数据源数、失败数据源数；
3. 最近变化：近 24 小时或最近一次发布中变化最大的指标；
4. 未来七天：高重要性经济事件。

### 5.2 市场卡片

为美股、A 股、港股和韩国分别展示：

- 盈利环境；
- 折现率压力；
- 风险溢价；
- 资金流或汇率；
- 最主要的三个支持因素和三个压力因素。

### 5.3 热力图与详情

- 市场 × 因子敏感度热力图；
- 指标多序列走势图；
- 经济日历；
- 首次值与修订值；
- 来源、统计期、发布时间、更新时间、下次发布时间、数据质量。

## 6. 信号规则

每项指标分别生成以下状态，不直接压缩成单一总分：

1. **水平**：相对历史分位或稳健 Z-score；
2. **趋势**：1 个月、3 个月和 6 个月变化；
3. **意外**：实际值与市场一致预期之差，并按历史预测误差标准化；
4. **阈值**：是否跨越制度性或历史阈值；
5. **质量**：是否初值、是否修订、是否缺失或过期。

颜色代表对某个市场维度的支持或压力，不代表原始数值上涨或下跌。所有聚合状态必须能追溯到贡献指标，避免黑箱分数。

## 7. 数据源与授权分层

### A 层：官方、结构化、优先自动化

- 美国：Federal Reserve、New York Fed、BLS、BEA、U.S. Treasury、EIA；
- 香港：HKMA Open API、香港政府统计处、data.gov.hk；
- 韩国：Bank of Korea ECOS、KOSIS；
- 全球：IMF、OECD、BIS、World Bank。

### B 层：官方但接口稳定性需要专项维护

- 中国国家统计局、人民银行、外管局、海关、财政部、中国货币网；
- 韩国海关及部分政府部门的网页或下载文件。

采集时保存原始来源 URL、解析版本和失败状态，结构变化必须显式告警。

### C 层：商业版权或实时行情

- S&P Global PMI、完整 ISM 历史；
- ICE DXY、实时 VIX；
- CME、ICE、LME 及交易所实时行情。

未核实授权前不作为首期核心数据，可展示官方替代指标或来源链接。

## 8. 数据模型

建议新增 D1 表：

```text
macro_series
  series_id, name, category, frequency, unit, source,
  regions_json, transmission_json, license_class, updated_at

macro_observation_vintages
  series_id, observation_date, value, released_at, observed_at,
  vintage, revision_number, is_preliminary, quality_status, source_url

macro_events
  event_id, scheduled_at, region, importance, title,
  actual, consensus, previous, source, source_url, updated_at
```

同一 `series_id + observation_date` 必须允许保存不同 vintage，不能让修订值覆盖首次发布值。大体积原始响应放 R2；上游短期请求缓存复用 D1 `http_cache`；同步游标可使用 `app_kv`。

## 9. API

- `GET /api/macro/dashboard?regions=us,cn,hk,kr`：首屏卡片、最近变化及数据健康；
- `GET /api/macro/series?ids=...&from=...&to=...&transform=level|yoy|mom|zscore`：时间序列；
- `GET /api/macro/events?from=...&to=...&regions=...&importance=...`：经济日历；
- `GET /api/macro/status`：数据源最近成功、最近尝试、过期和错误状态。
- `GET /api/macro/signals`：市场 × 因子的可审计贡献；
- `GET /api/macro/revisions?id=...`：首次值和修订 vintage；
- `GET /api/macro/research/scenario`：指定 `asOf` 的历史情景回放；
- `GET /api/macro/research/correlation`：宏观指标与四市场基准的滚动相关性；
- `GET /api/macro/research/industries`：配置驱动的行业敏感度；
- `GET /api/macro/research/backtest`：支持立即可用的回顾性模式，以及按首次入库可用时间执行的严格点时无前视模式；
- `GET/PUT /api/macro/watch`、`GET /api/macro/alerts/evaluate`：关注与阈值规则；
- `POST /api/macro/sync`：仅本地开发环境可用的手工同步入口。

指数和代理资产对照线继续使用现有 `/api/kline`，宏观观测值不写入 K 线契约。项目规定所有 K 线只能使用东方财富，不增加 Yahoo、腾讯等备用来源；韩国指数需要先验证并补齐 Eastmoney `secid` 映射。

## 10. 仓库落地

### 前端

- `web/src/macro.html`
- `web/src/config/macro.json`
- `web/src/modules/macro/pages/macro-page.ts`
- `web/src/modules/macro/components/`
- 修改 `web/src/config/navigation.json`
- 修改 `web/scripts/build-vue-pages.mjs`
- 将 `macro` 加入 `web/scripts/page-build-config.mjs` 的 `pagesWithoutLegacyRuntime`

新页面自包含 Vue 状态，不接入旧的 `legacy-runtime.ts` 和 CustomEvent 桥。图表使用当前页面运行时已提供的 ECharts，但实现独立的小型宏观图表组件。

### 后端

- `src/modules/macro/api/macro.routes.ts`
- `src/modules/macro/application/`
- `src/modules/macro/domain/`
- `src/modules/macro/config/series.json`
- 按供应商拆分 `src/adapters/` 实现
- 在 `src/app/router.ts` 挂载宏观路由
- 新增 D1 migration

当前定时任务每 15 分钟只触发财务同步。接入宏观同步前，先把 scheduled handler 改成显式任务调度器，避免新增 cron 后重复执行无关任务。不同指标按 15 分钟、日频、月/季频分层检查，并记录每个来源的 freshness 和错误。

## 11. 分期实施

### 第一阶段：页面 MVP

- 全球五维状态；
- 四个市场卡片；
- 20 至 30 个核心官方指标目录；
- 指标详情和可视化；
- 未来七天经济日历；
- 数据来源、更新时间和异常状态。

### 第二阶段：信号与修订

- 数据意外指数；
- 跨市场因子热力图；
- 首次值与修订值对比；
- 自定义关注指标和告警。

### 第三阶段：研究工具

- 历史情景回放；
- 因子与指数滚动相关性；
- 行业敏感度；
- 宏观状态与市场表现回测。

## 12. 第一阶段验收标准

1. `macro.html` 可从顶级导航进入，并能在桌面和移动端正常展示；
2. 首屏一次请求返回四市场状态和数据健康信息；
3. 指标列表能够按市场、因子和频率筛选；
4. 每项数据都显示来源、统计期、发布时间和 freshness；
5. 数据过期或抓取失败时显式降级，不显示为正常；
6. 时间序列有序、无重复，并能区分首次值与修订值；
7. 本地通过 `./start-local.sh`、`GET /api/health` 和 `npm run test:smoke:pages` 验证。

## 13. 实施状态（2026-07-30）

| 阶段 | 状态 | 已交付 |
| --- | --- | --- |
| 第一阶段：页面 MVP | 完成 | 五维状态、四市场卡片、25 项指标目录、筛选与走势图、七日经济日历、来源和 freshness、桌面/移动端布局 |
| 第二阶段：信号与修订 | 完成 | 60 期标准化信号、市场 × 因子热力图、不可覆盖的 vintage、首次值/修订值、服务端关注与阈值规则 |
| 第三阶段：研究工具 | 完成 | `asOf` 情景回放、四市场滚动相关性、12 个市场行业组合敏感度、首次入库可用时间约束的无前视回测 |

完成是指代码路径、存储、接口和页面交互已经落地。某一官方源尚未配置密钥、上游超时或当前没有发布事件时，页面会显示缺失、过期或失败，不会用模拟值填充。

四个研究基准全部使用东方财富 K 线：

| 市场 | 内部代码 | 已验证 Eastmoney `secid` |
| --- | --- | --- |
| 美股 | `SPX.US` | `100.SPX` |
| A 股 | `000300.SH` | `1.000300` |
| 港股 | `HSI.HK` | `100.HSI` |
| 韩国 | `KS11.UI` | `100.KS11` |

## 14. 配置与运维

### 14.1 可选密钥

- `FRED_API_KEY`：可选；配置后使用FRED JSON API及其realtime vintage，未配置时使用FRED官方公开CSV和官方release calendar页面；
- `BOK_ECOS_API_KEY`：韩国央行 ECOS；
- `KOSIS_API_KEY`：韩国 KOSIS；
- `EASTMONEY_COOKIE`：项目既有港股 K 线访问配置，宏观模块不新增其他 K 线来源。

ECOS、KOSIS等必须使用密钥的来源在未配置时记录为 `disabled`；请求失败记录为 `failed`，包含最近尝试、最近成功、连续失败数和错误信息。FRED不再强制依赖密钥。

### 14.2 同步调度

`wrangler.jsonc` 中保留两类独立 cron：

- `*/15 * * * *`：原有财务同步；
- `17 * * * *`：宏观数据同步。

`src/app/scheduled.ts` 按 cron 表达式分发任务，新增宏观 cron 不会重复触发财务同步。本地标准启动仍使用 `./start-local.sh`；本地可通过 `POST /api/macro/sync` 手工同步。由于Wrangler本地Worker访问FRED域名会超时，启动脚本同时运行仅允许FRED/BLS官方域名的 `local-macro-fetch-relay.mjs`，绑定为 `MACRO_FETCH_RELAY_URL`；生产Worker未配置该变量时仍直接访问官方源。生产环境需先执行远程 D1 migration，再部署Worker，不能以本地Wrangler验证替代生产验证。

### 14.3 本地验证

```bash
npm run typecheck
npm run build:web
npm run test:macro
npm run test:smoke:pages
```

`test:macro` 覆盖转换、贡献计算、滚动相关性、情景回放、无前视交易规则、vintage 存储和官方适配器 fixture。页面 smoke 覆盖 dashboard、转换序列、修订、信号、行业敏感度、情景、相关性、回测、关注/告警和数据源状态。

## 15. 数据边界与长期运行说明

1. NY Fed、HKMA和FRED官方公开CSV均可无密钥同步。BLS API在当前网络超时时，使用FRED官方CSV中的同源BLS序列映射；来源URL和映射保持可审计。
2. ECOS、KOSIS在配置密钥并核实表代码后启用。国家统计局、人民银行、韩国MOTIE当前没有经过验证的稳定结构化契约，保持 `disabled`，不以抓网页或第三方数据伪装成功。
3. 首次同步获得的大段历史是“回填”，并不代表系统在历史时点已经知道这些值。严格点时回测只使用每个统计期的首次 vintage，并以 `max(releasedAt, vintageAt)` 作为可用日期；因此刚上线时样本可能为零，样本会随每日同步自然积累。回顾性模式使用当前修订值和统计期日期，可立即计算，但接口和页面明确标记 `lookAheadSafe=false`。
4. 行业敏感度是配置权重模型而非价格回归结论，返回每个指标的贡献和覆盖率，便于审计与后续校准。
5. 告警规则已能服务端保存和执行；邮件、短信或推送属于外部通知授权与基础设施，不在本地页面实现中假设存在。

### 15.1 本地联调基线（2026-07-30）

- `POST /api/macro/sync`：4个抓取任务全部成功，首次写入19,864条；
- 25项目录中20项已有官方历史值，FRED、BLS、NY Fed、HKMA状态均为 `healthy`；
- 未来7天官方日历返回13项；四市场相关性均有有效样本；12个行业组合均可计算分数；
- 回顾性回测在美股、A股、港股、韩国四个基准分别产生有效样本，同时保留严格点时模式；
- `npm run test:smoke:pages`：76项全部通过。
