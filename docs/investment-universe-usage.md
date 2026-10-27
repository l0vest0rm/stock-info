# A股优先的98家公司观察池：配置、前端与每日复盘

- **唯一可写的观察池主数据**：`config/investment-universe.json`。
- **历史快照**：`docs/宽基式优质公司组合_细分赛道与98家观察池_2026-10-27.md` 是初版，已移出日常覆盖的32家公司见 `docs/archive/investment-universe-deferred-2026-10-27.json`。不应与JSON双向覆盖。
- **每日策略研究**：`config/investment-daily-report.json`；参考 [A股优先每日研究复盘流程](investment-daily-review-playbook.md)。无当日核验必须维持 `not_reviewed`，不生成买入或换仓建议。
- **日常校验**：`npm run check:investment-universe` 校验公司池、市场结构及日报契约；修改JSON后再执行 `npm run build:web`。
- **历史源核对选项**：观察池已经重组，因此 `node scripts/validate-investment-universe.mjs --check-source --json` 将返回 `sourceCheckSkipped=true`，不再错误声明与初版Markdown完全一致。

## 主数据结构

`sectors` 表示 11 个研究用一级行业；`tracks` 表示 37 个细分研究赛道；`companies` 表示 98 家经营公司，每家公司有一个 `primarySectorId`、一个 `primaryTrackId` 和不随股票代码、名称或排序变化而重排的 `co-NNNN` 稳定 ID。

同一经营公司多地上市的证券放在该公司的 `securities` 数组中，当前合计117条，不算额外的经营公司。`preferredMarket` / `preferredTicker` 决定首选研究证券；有A股的公司优先A股。当前首选研究市场：**A股78家，美股15家，港股5家**。证券字段记录 `ticker`、`market`、`exchange`、`securityType`、`sourceCode`、`identityVerified`，其中 `securityType=unverified` 或 `identityVerified=false` 明确表示尚待核验上市身份/权利；不能由此认定 A/H/ADR/韩股可互换、可交易、税费一致或存托比例已确认。

`portfolioIllustration`、`strategyPreferences.illustrative25HoldingSlots`（参考25席位：A股21、美股3、港股1）与 `riskGuidelinesIllustrative` 都是示例策略预算，不是实际持仓。A股与海外账户资金分开核对，绝不自动交易。

## 观察状态

| 字段 | 允许值 | 含义 |
| --- | --- | --- |
| `watchStatus` | `research`、`priority`、`paused`、`excluded` | 研究池/重点跟踪/暂停/剔除 |
| `researchPriority` | `L0`、`L1`、`L2`、`L3` | 基础身份、常规监测、深度研究、接近交易候选的研究深度 |
| `classificationStatus` | `proposed`、`verified` | 研究分组草案/有日期和证据的主营分类 |
| `lastEvidenceDate` | `YYYY-MM-DD` 或 `null` | 上次支持本条判断的来源日期 |
| `valuationAsOf` | `YYYY-MM-DD` 或 `null` | 估值数据对应日期，不与不同日期报价混算 |

初始化时，98 家公司的 `watchStatus` 均为 `research`、`researchPriority` 为 `L1`，主营分类为 `proposed`。初始 `themeTags`、`factorExposures`、`evidenceRefs` 均为空数组，表示**尚未逐家公司建立证据**，并非风险或主题敞口不存在。

## 修改与安全边界

1. **修改公司/赛道名单只编辑 JSON**；原始 Markdown 是解释和历史快照，避免同时维护两份权威名单。
2. 新增公司使用下一个未使用过的稳定 ID，**不得重新编号**已有 `co-NNNN`；更名、换代码、多地上市只变更公司属性或证券记录。
3. 每家公司只有一个主赛道；交叉产业属性写在 `themeTags` 与 `factorExposures`，不要重复创建同一经营公司。
4. 只有在补入来源、证据日期后，才能将 `classificationStatus` 改成 `verified`；其余研究字段保持空值而不是猜测。
5. 编辑后运行 `npm run check:investment-universe`；增加或删除公司时审查并同步 `scope.baselineCounts`，且公司总数不可超过 100。
6. 个人持仓、交易成本、证券可交易性、买入计划均不应进入公开共享研究配置，应由 stock-info 的私有数据通道独立维护。
7. 当前 `scope.automaticMonitoringEnabled=false`。配置本身**不会**自动抓取公告、执行 AI 分析、更新估值、创建订阅或部署网页。动态资讯与研究输出继续存入已有 D1/R2/投研管线，勿不断膨胀这一 JSON。

## 前端观察池页面

- 页面入口：`/investment-universe.html`（公司子导航中的「行业观察池」）。本地 Node 服务启动后访问 `http://127.0.0.1:8000/investment-universe.html`。
- 数据源：页面构建时导入观察池 `config/investment-universe.json` 和公开日报 `config/investment-daily-report.json`，**不另存第二份观察池**。修改后运行 `npm run check:investment-universe && npm run build:web`。
- 功能：A股优先排序、78/15/5市场分布；行业/赛道/首选研究市场筛选、公司搜索、双视图、公司详情、CSV导出，以及最近一份**证据核验后的公开日报**。首次默认显示「尚未复盘」，不会虚构策略建议。
- 详情中的「站内查询」仅跳转已有公司页面，不表示所列上市证券已经核实。暂不展示个人持仓、成本、实时估值，也不提供在网页上修改 JSON 的操作。
- 这套页面可随下一次正常 Web 构建进入生产资源，但**新建页面并不代表已部署线上**；新页面设置了 `noindex`。其静态候选信息不应当视为用户的私人持仓数据。

## 使用示例

```bash
npm run check:investment-universe
node scripts/validate-investment-universe.mjs --json
jq '[.companies[] | select(.primaryTrackId == "IT-05") | {id, displayName, securities, watchStatus}]' config/investment-universe.json
jq '[.companies[] | select(.researchPriority == "L1") | {id, primaryTrackId, displayName}]' config/investment-universe.json
```

**适用范围：** 本文档只说明静态研究主数据和校验契约；不证明公司最新财务表现、估值便宜、证券身份已确认、AI 自动跟踪已接入或实际持仓已完成分散化。
