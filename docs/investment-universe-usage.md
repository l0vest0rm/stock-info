# A股优先的98家公司观察池：配置、前端与每日复盘

- **唯一可写的观察池主数据**：`config/investment-universe.json`。
- **历史快照**：`docs/宽基式优质公司组合_细分赛道与98家观察池_2026-10-27.md` 是初版，已移出日常覆盖的32家公司见 `docs/archive/investment-universe-deferred-2026-10-27.json`。不应与JSON双向覆盖。
- **每日策略研究**：`config/investment-daily-report.json`；参考 [A股优先每日研究复盘流程](investment-daily-review-playbook.md)。无当日核验必须维持 `not_reviewed`，不生成买入或换仓建议。
- **日常校验**：`npm run check:investment-universe` 校验公司池、市场结构及日报契约；修改JSON后再执行 `npm run build:web`。
- **历史源核对选项**：观察池已经重组，因此 `node scripts/validate-investment-universe.mjs --check-source --json` 将返回 `sourceCheckSkipped=true`，不再错误声明与初版Markdown完全一致。

## 主数据结构

`sectors` 表示 11 个研究用一级行业；`tracks` 表示 37 个细分研究赛道；`companies` 表示 98 家经营公司，每家公司有一个 `primarySectorId`、一个 `primaryTrackId` 和不随股票代码、名称或排序变化而重排的 `co-NNNN` 稳定 ID。

同一经营公司多地上市的证券放在该公司的 `securities` 数组中，当前合计117条，不算额外的经营公司。`preferredMarket` / `preferredTicker` 决定首选研究证券；有A股的公司优先A股。当前首选研究市场：**A股78家，美股15家，港股5家**。证券字段记录 `ticker`、`market`、`exchange`、`securityType`、`sourceCode`、`identityVerified`，其中 `securityType=unverified` 或 `identityVerified=false` 明确表示尚待核验上市身份/权利；不能由此认定 A/H/ADR/韩股可互换、可交易、税费一致或存托比例已确认。

`portfolioIllustration`、`strategyPreferences.illustrative25HoldingSlots`（参考25席位：A股21、美股3、港股1）与 `riskGuidelinesIllustrative` 都是示例策略预算，不是实际持仓。

### 估值原型与因子敞口（派生字段）

- 每家公司的 `valuationArchetype`、`factorExposures`、`themeTags` 由 `scripts/sync-investment-universe-valuation.mjs` 从 `src/modules/research/domain/valuation-coverage.ts` 推导写入，**不要手工编辑**。
- 修改赛道或新增公司后执行 `npm run sync:investment-universe:valuation`；`npm run check:investment-universe` 会拒绝未知枚举。
- 只读查询：`GET /api/research/valuation-coverage`；方法说明见 [估值覆盖](investment-valuation-coverage.md)。
- 这些字段只表达“该用哪种估值方法”和“方向性因子敞口”，不含价格、目标价或买卖建议。A股与海外账户资金分开核对，绝不自动交易。

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

## 动态估值看板（2026-10-28）

- 打开或刷新 `investment-universe.html`：先 GET `/api/research/valuation-screen` 读缓存与目标名单，再以并发 2 请求 POST `/api/research/valuation-screen/refresh/:code`。每个公司在服务端重新取数、计算、缓存，页面逐行替换；不是浏览器计算，也不是手工填 JSON。
- 按证券使用现有 `kv_cache` 的 `valuation-screen-v3` 命名空间，保留7天；每行有计算时间。数据库租约跨页/跨 Worker 隔离重复计算，带过期写入保护。GET 不触发计算；关闭页面会停止尚未发起的刷新。没有依赖 Worker 响应后的长时间任务，也没有新增后台常驻任务或数据库表。
- 每轮行情/三大财报显式绕过对应 HTTP/财报快照缓存请求原数据源，然后更新正常缓存。年度中枢历史仍沿用既有历史源缓存策略。行情来自雪球日线直接市值；港美股日线无市值时，仅请求东方财富带日期的行情市值（不是替代K线）。不使用 PE×利润反推市值。雪球失败不切换K线源；缺少日期或行情超过7个自然日时不作当前估值。
- 档位是**规则区间位置**：低于下限=低估；区间下半段=合理偏低；上半段=合理；超过上限至1.2倍上限=偏贵；再高=明显偏贵。它不等于公司专属内在价值。行业/商业模式决定主方法；只有辅助方法、币种不一致、关键数据失败或增长否决时显示无法判断。
- 新看板的 `assessment.conservativeMargin = 1 - 市值 / 价值区间下限`；收益率区间需先反向转换为价值区间。与旧筛选模型的 `position.marginOfSafety`（区间上限距离）不同，页面只展示新的保守口径，不展示旧字段。
- 历史3/5年PE分位使用雪球每日直接市值和披露时点可知的累计财报重建；不使用供应商可能回填未来利润的历史PE。要求每年不少于180个有效样本且覆盖窗口85%以上；缺披露日、不适用、币种不可比、样本不足时留空并显示样本数。历史重述仍是限制，不能当作严格未修订回测数据。
- 最近单季营收/利润同比与TTM利润同比来自现有季度序列。无单季数据不把半年报伪装成季度。未来估值合同 `future: null`，待以后接入有来源、日期与情景的预测；不通过LLM自动补数。
- 验收：`./start-local.sh` → `/api/health` → 页面检查自动刷新与详情 → `npm run test:basic`（包含看板契约与档位/安全边际边界）。Cloudflare部署需独立授权与验收，本地结果不能视为线上验收。

### 研究优先布局

页面采用全宽布局，不提供侧栏。顶部机会雷达由后台 `opportunity` 契约驱动，展示综合研究优先、历史折价、盈利兑现、未来预期差、回撤线索及风险/数据待核查。每组最多6家公司、每行业最多2家；阶段优先、同阶段按观察池固定顺序，不按信号数打分，也不是持仓配置建议。雷达独立于下方筛选。

完整观察池上方集中提供搜索、机会阶段、机会类型、估值、行业、赛道、市场、研究层级、观察状态和排序。详情全宽展开，含三道验证、四类线索、数据期间/来源、缺口、待核查项和失效条件。每日复盘位于底部默认折叠。

### 四类机会与验证（opportunity-v1）

- 历史折价：适用PE主方法的非金融、非周期公司，3年和5年分位均不超过20%。只称相对历史便宜，不称内在低估。
- 盈利兑现：TTM利润同比至少20%，连续两个正式单季营收同比至少10%、利润同比至少20%。不将半年报当单季，不将增长当超预期，不用PE小于增速直接判定低估。
- 未来预期差：`future: null`，显示未覆盖。页面其他机构预测参考不自动成为未来估值；后续须验证预测来源/日期、EPS及稀释、币种、期间和估值情景。
- 回撤：仅雪球前复权价格；20/60/120交易日分别下跌至少15%/20%/30%，或距252交易日最高收盘价至少回撤30%。不足窗口、过期、缺值和重复日期不按零处理；获取失败不换源、不使用未复权替代。
- 数据、经营、估值三道门均通过且有线索，才升级为“研究候选”。经营门检查两年TTM利润、收入、同期间现金转化和负债；金融/周期公司待行业专用质量验证，不直接通过。利润收缩或现金净流出优先风险核查。估值门是现有行业规则区间，不是内在价值认证。
- 经营现金流/利润只是初筛代理，不替代扣非利润及摊薄EPS分析。美股现金流累计口径未统一时保留缺失，不推算通过。尚不覆盖行业相对收益、公司专属护城河和市场预期快照。
- 所有门的“通过”只表示量化初筛通过；下一步证据与失效条件仍保留。阈值统一维护于 `config/investment-opportunity-policy.json`，尚未完成无幸存者偏差的样本外检验。
- API `schemaVersion: 3`；结果包含 `policyVersion`。缓存策略版本不匹配时不复用。保留原有逐公司刷新、租约及缓存机制；计算超过10分钟或本次失败时，页面不再将旧候选作为当前优先项。
- `npm run test:basic` 同时覆盖真实本地API契约及12组机会规则边界，包括空值、过期/未来日期、短历史、复权缺失、行业不适用、现金流风险与高增长高估值。没有新增测试入口、数据库表或自动交易。

### 同比与环比联合核查

盈利兑现同比线索保持独立；升级研究候选还要求最新正式单季营收、归母利润环比可比且不下降。环比下降只进入待核查，不据此认定经营恶化，需复核季节性、上年同期环比与一次性因素。计算使用相邻自然季度的单季值，不使用累计或TTM；缺季、非正式披露或上季基数非正时留空、不通过。页面列表、雷达及证据详情展示环比，详情保留比较期间。政策版本升级为 opportunity-v2-qoq，旧缓存不会继续作为新规则结果展示。

### 东财 / 新浪未来估值参考

打开公司详情时，观察池通过 `/api/company/reports?readOnly=1` 按需读取现有研报，展示逐份报告的机构、发布日期、预测年度、EPS、归母净利润、研报PE、行情快照重算PE及目标价。读取不会触发LLM提取；生产仍只读取已有提取。原文链接遵循现有登录权限；同一报告的东财/新浪合并记录不作为两份独立预测。

相对年度按报告发布日期归属，缺日期不推断；没有预测时明确留空。目前该来源链路仅覆盖A股。研报参考与情景内在价值、市场预期差分开，不改变自动筛选门槛，不自动合成为一致预期。行情获取时间不等于交易时间，目标期限/币种/复权及股本口径仍需核验。
