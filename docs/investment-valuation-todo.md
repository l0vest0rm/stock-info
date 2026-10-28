# 观察池估值与决策：整体 TODO

> 制定日期：2026-10-27。配套文档：`docs/investment-valuation-data-contract.md`（数据口径）、`docs/investment-valuation-coverage.md`（原型与因子）、`docs/investment-daily-review-playbook.md`（每日流程）。
> **本文件不含价格、目标价或买卖指令。** 所有条目都是工程与数据工作，用于让后续的估值判断有可靠输入。

## 0. 现状快照

| 项 | 状态 | 位置 |
|---|---|---|
| 观察池 98 家公司 | ✅ 已校验 | `config/investment-universe.json` |
| 估值原型分类 | ✅ 11 种，98/98 | `valuationArchetype` 字段（脚本生成） |
| 因子敞口 | ✅ 98/98 已写入 | `factorExposures` 字段（脚本生成） |
| 累计/单季两个财报家族 | ✅ 接口已分开，78/78 A 股审计通过 | `/finance/income/quarterly-series` |
| 财报缺失的结构化告警 | ✅ 已加 | `FinancialStatementReadModel.warnings` |
| TTM / PE / PB / PS / PCF | ✅ 恢复并修正（含金融族） | `latest-financial-valuation.ts` |
| 折旧摊销 → EBITDA | ✅ 已解锁（四口径） | 现金流量表补充资料 |
| 保守价值区间 | ✅ 第一版（锚定财报，不含目标价） | `/finance/valuation-bands` |
| 研究分级 | ✅ 98/98 写入（L1 40 / L2 35 / L3 23） | `researchPriority` / `researchBasis` |
| 估值区间可用性 | ✅ 83/97 家有可用区间（14 家美股仅因 Yahoo 代理未启动） | `npm run snapshot:valuation-bands` |
| 区间变化归因 | ✅ filing / model / price_source / unattributed | `valuation-band-review.ts` |
| 复盘留痕 | ✅ 模板 + 首份 2026-10-28 | `docs/investment-daily/` |
| 每日报告 | `not_reviewed`，0 家核验 | `config/investment-daily-report.json` |
| 公司证据链 | ✅ **97/98 家已核验**，115 条一手记录 | `evidenceRefs` / `identityVerified` |
| 一手证据覆盖 | 115/116 个证券 collected | 巨潮 160+ / HKEX 63 / SEC 358 量级 |

**一句话：数据管道与证据链已可信（P0–P2 完成），剩下的是把估值判断接进每日流程（P3）。**

---

## P0：先堵住已知的正确性风险 ✅ 已完成（2026-10-27）

这一层的目标是不让错误的估值数字流入后续流程。已完成，验收证据见
`docs/investment-valuation-data-contract.md` 的「全量审计」「金融家族」「PE(TTM) 修正留痕」三节。

### P0-1 清理旧快照并加守卫 ✅

- [x] 全量扫描 2069 个 income 快照：1967 个缺 `*INCOME` 累计家族
- [x] 一次性迁移脚本 `scripts/repair-income-snapshots.mjs`（默认 dry-run，`--delete` 才删），只清 `income`
- [x] 读取层加结构化 warning：`FinancialStatementReadModel.warnings` 的 `missing_cumulative_income_family` / `missing_annual_income_statement`
- [x] 命中旧快照自动刷新一次
- 验收：`npm run audit:quarterly-series` 对 78 家 A 股 **78/78 通过**，`families.cumulative` 全为 true

### P0-2 银行 / 保险 / 券商家族核对 ✅

- [x] 招商银行、宁波银行、兴业银行、中国平安、中国太保逐个拉 `BINCOME` / `IINCOME` + `*QC`
- [x] 确认银行营收口径：金融族营收在 `OPERATE_INCOME`，`TOTAL_OPERATE_INCOME` 恒为 0
- [x] 发现并修复真问题：金融族**不发布年内中间期单季度行**，原 5 报告期窗口导致招商银行/中国平安 `ttm*` 全空；改为 8 报告期（`src/adapters/eastmoney-report-window.ts`）
- [x] 补自检 `check:income-window`、`check:financial-read-model`
- 未覆盖：港股 01299.HK / 00388.HK（HK F10 另一套接口），V / 拉卡拉（`G` 族，已随全量审计覆盖）
- 仍未做：保险 `P/EV` 所需的新业务价值字段不在东财 F10 结构化返回中，**该原型需另找口径或明确标为不可算**

### P0-3 PE(TTM) 修正留痕 ✅

- [x] 手算中际旭创 TTM 净利 204.53 亿 = 107.97 + 136.51 − 39.95，与接口 204.5329 一致
- [x] 修正前后对照表写入数据口径文档：PE 41.69 → 33.23、PS 12.97 → 10.42
- [x] 另 6 家复查，倍数均正常返回
- 顺带发现：全观察池当时只有 7 家能算出 PE，原因是**行情接口 `push2.eastmoney.com` 对本机连续拒连**（`Remote end closed connection`），不是口径问题；`npm run audit:valuation-multiples` 可随时复测

### P0-4 自动化检查聚合 ✅

- [x] `npm run check:valuation-chain`：估值链路 6 个自检 + 观察池 Schema
- [x] `npm run check:all`：typecheck + 上述链路 + Wrangler/内联提示/建表/运行时边界
- [ ] 提交前钩子（CI 目前仍靠手动执行）

---

## P1：让估值方法真正可算

P0 完成后，这是把"方法论"变成"能算出来的数"的核心阶段。

### P1-1 折旧摊销 → 解锁 EBITDA ✅ 已完成（决策：接受 "取不到就不估算"）

**结论**：折旧摊销其实取得到，在**现金流量表补充资料**（`FA_IR_DEPR` + 三项摊销），之前只查了利润表和现金流量表正表所以漏了。

- [x] 定位字段并验证 `OILGAS_BIOLOGY_DEPR` 是 `FA_IR_DEPR` 的别名（不能相加）
- [x] 发现关键约束：补充资料**只在年报和中报披露**，一季报/三季报整块为 0
- [x] 实现四种口径：`annual` / `trailing_twelve_months` / `prior_fiscal_year` / `unavailable`，全部写入 `limitations`
- [x] 自检覆盖四种口径（`npm run check:valuation-inputs`）
- [x] 用现金流恒等式交叉验证比亚迪：净利润 + 折旧 + 减值 − 存货 − 应付 ≈ 经营现金流 ✅
- 决策落地：**不用估算值**。保险股全部报告期无补充资料，EBITDA 保持 `null` 并给显式 gap

**新发现的倍数陷阱（P1-3 必须处理）**：比亚迪/中芯的折旧 ≈ EBIT 的 5.6 倍，中际旭创仅 0.07 倍。同一把 EV/EBITDA 会系统性低估重资产制造，必须与 EV/EBIT 并列。

**未做**：保险股 LTV/内含价值口径无结构化数据源（东财 F10 不返回）。

### P1-2 保守价值区间 ✅ 已完成（第一版）

**接口**：`GET /api/finance/valuation-bands?code=&marketCap=`（`marketCap` 可选，用于填隐含列）

**设计原则**（写进代码，不靠自觉）：

- 只输出「区间倍数 + 假设」，**不输出目标价、不给买卖指令**
- 分母缺失就是 `insufficient_data` 并列出缺的键，**绝不用替代值凑一个数**
- 原型禁用项显式返回 `forbidden_for_archetype` + 原因，**不是静默省略**
- 重资本自动降级：折旧/EBIT > 1.5 时 EV/EBITDA 自动降为 auxiliary 并告警
- 每个区间都锚定财报报告期，**不锚定价格日期**

- [x] 8 类区间：PE(TTM)、前瞻 PE、EV/EBIT、EV/EBITDA、EV/营业收入、PB、FCF 收益率
- [x] 自检 `check:valuation-bands`：9 个用例覆盖禁用/缺失/负利润/部分负债/无价格
- [x] 真实数据验证：中际旭创、比亚迪、招商银行
- [x] EV 口径规则：有息负债缺失时不计算 EV，不当作零

**实测降级表现**（行情源不可用时）：

| 公司 | PE(TTM) 分母 | EV/EBIT | EV/EBITDA | 说明 |
|---|---|---|---|---|
| 中际旭创 | 204.53 亿 | 165.05 亿 | 176.36 亿 | 折旧/EBIT 0.07，EV/EBITDA 可并列 |
| 比亚迪 | 294.34 亿 | 146.95 亿 | 970.27 亿 | **自动降级 + 告警**（折旧是 EBIT 的 5.6 倍） |
| 招商银行 | 1516.96 亿 | ❌ 禁用 | ❌ 禁用 | EV 三项全部 `forbidden_for_archetype` |

**仍未做**：

- 前瞻 PE 恒为 `insufficient_data`：项目里的盈利预测来自人工整理的研究文档，当前 0 条数据
- 区间是固定默认值，需要 P1-3 的可比矩阵校准后才能称为「行业中枢」
- 价格源 `push2` 被限流时，隐含列为空（锚点不受影响）

### P1-3 行业中枢与可比公司矩阵 ✅ 已完成

**为什么先做这个**：P1-1 发现同一把 EV/EBITDA 在折旧/EBIT = 0.07 和 5.6 之间含义相反。全量实测（78 家 A 股，`npm run audit:capital-intensity`）证实这不是个别现象：

| 资本密度 | 家数 | 折旧/EBIT 范围 | 代表 |
|---|---|---|---|
| 轻（<0.5） | 34 | 0.04 – 0.48 | 贵州茅台 0.04、中际旭创 0.07、宁德时代 0.39 |
| 中（0.5–1） | 19 | 0.52 – 0.98 | 万华化学 0.81、中国海油 0.74、美的集团 0.98 |
| 重（>1） | 16 | 1.14 – 17.07 | 中芯国际 5.63、比亚迪 5.60、长城汽车 4.52、启明星辰 17.07 |
| 无法判定 | 9 | — | 3 家银行、2 家保险（无补充资料披露）+ 生益科技、华大九天、科大讯飞、张江高科 |

- [x] **11 种原型各定义可比指标**，落成代码常量（`comparability-matrix.ts` 的 `ARCHETYPE_METRICS`），不是文档描述
- [x] **禁止互相套用的黑名单落成代码**：每个原型同时声明 `allowed` 与 `forbidden`，自检断言两者永不相交
- [x] **周期中枢利润**替代 TTM：`GET /api/finance/mid-cycle-earnings?code=`，5–10 年年报，中位数为主、均值并列
- [x] **财务历史覆盖检查**：A 股可一次取 11 年年报（实测紫金矿业 2011–2025 全部返回），足够 10 年窗口
- [x] 可比矩阵 API：`GET /api/research/comparability?code=&peers=a,b,c`
- [x] EV/EBITDA 区间按资本密度分档：轻 14–28 倍、中 9–18 倍、重 5–11 倍

**周期中枢的三条硬规则**（写在 `mid-cycle-earnings.ts`）：

1. 只用年报。中报/三季报是累计口径，混进去会让最新一年被重复加权
2. 缺年份就报缺，不插值、不用 TTM 或季度补齐；不足 5 年直接 `insufficient_data`
3. **亏损年份必须保留**。剔除亏损年会系统性抬高中枢——这正是该模块要防的错误

实测（2016–2025，单位亿元）：

| 公司 | 中位数 | 均值 | 峰值/中枢 | 变异系数 | 说明 |
|---|---|---|---|---|---|
| 中远海控 | 168.94 | 313.56 | 6.5× | 1.21 | 含 2016 亏损年 −99.06；2022 峰值 1097.03 |
| 紫金矿业 | 110.91 | 160.90 | 4.7× | 0.94 | 持续增长，中枢仍然远低于 2025 的 517.77 |
| 中芯国际 | 40.15 | 44.92 | 3.0× | 0.85 | 2022 高点 121.33 后回落 |
| 贵州茅台（对照） | 495.79 | 525.37 | 1.7× | 0.43 | 非周期，中枢会抹掉成长——故原型禁用 |

**中远海控的实测结论**：TTM 净利 267.51 亿 vs 中枢 168.94 亿，相差 58%；2022 峰值是中枢的 6.5 倍。只用 TTM PE 会把它当成便宜的周期股，实际处在周期中高位区间的回落后段。估值区间现在会显式告警并要求同时给出两种口径。

**可比矩阵实测**：

- 中际旭创（轻/0.07）× 比亚迪（重/5.60）：可比 `pe_ttm`、`ev_ebit`；**拒绝** `ev_ebitda`、`fcf_yield`、`pb`，理由「资本密度不同」
- 中际旭创 × 宁德时代（轻/0.39）：可比 4 项
- 中际旭创 × 贵州茅台：全部拒绝，理由「业务模型不同」
- 中远海控 × 紫金矿业：可比 `pe_mid_cycle`、`ev_ebit`、`pe_ttm`；拒绝 `ev_ebitda`

**未做**：区间倍数仍是人工设定的默认值，尚未用真实可比公司倍数分布校准（需要价格源）。

### P1-4 补 43 家缺失的 EM2016 行业对照 ✅ 已完成（结构性上限 78/98）

**根因不是取数失败，是生成文件过期**：23 家 A 股在 EM2016 里全部有分类，只是 `config/generated/eastmoney-company-em2016-profiles.json` 自 2026-08-11 后未再同步。

- [x] 23 家 A 股逐个核实 → 全部有 EM2016 分类，已用 `sync-eastmoney-company-em2016-profiles.mjs` 重新抓取
- [x] 美股 15 家、港股 5 家：**EM2016 是东财的 A 股行业分类，港股/美股接口对每个代码都返回「返回数据为空」**，不是爬取问题
- [x] 为此新增显式状态 `em2016LookupStatus`，区分三种情况：
  - `available`（78 家）
  - `not_applicable_for_market`（20 家，结构上无对应分类，永久如此）
  - `missing`（0 家，A 股查不到才需要重新同步）
- 验收：`em2016Lookup: { available: 78, notApplicableForMarket: 20, missing: 0 }`

**结论**：这 20 家不会补上 EM2016，因为该分类体系不覆盖它们。它们的可比性只能由业务模型判定——这正是 P1-3 可比矩阵存在的理由，矩阵不依赖 EM2016。

---

## P2：让观察池从"名单"变成"有证据的档案"

当前 98 家公司的 `evidenceRefs`、`lastEvidenceDate`、`valuationAsOf`、`classificationStatus`、`watchStatus`、`researchPriority` 全部是空值或统一默认值。

### P2-1 公司身份核验

- [x] 结构化证据契约 `src/modules/research/domain/evidence-record.ts`：来源、证券、登记号、日期、URL 五要素，新闻/传闻类 `kind=secondary` 直接拒绝
- [x] 一手来源抓取 `src/modules/research/application/collect-evidence.ts`：巨潮（SH/SZ/BJ）、HKEX（HK）、SEC（US）
- [x] `GET /api/research/evidence/:code` 实测：招商银行 2 份、中芯国际 A 股 2 份、中芯国际 H 股 2 份，均 `identityVerified=true`
- [x] SEC 索引补全：`filings.recent` 只含最近约 1000 条申报，年报常被挤出；新增 `loadSecFilingIndex()` 合并 `filings.files[]` 分年文件（同时修复 XBRL 事实的来源指针缺失）
- [x] 多地上市不等价已落到代码：`canVerifyIdentity` 只认**该证券自己**的文件；A 股年报不核验 H 股
- [x] 全量 98 家跑一遍并回写 `securities[].identityVerified`：**115/116 个证券 collected，97/98 家公司 verified**
- 验收口径：`identityVerified=true` 且 `evidenceRefs` 内有一条 `security` 等于该 ticker 的一手记录

### P2-2 证据链入库

- [x] 最小证据集 = 每家证券**最近一期定期报告**（年报/半年报/季报，SEC 为 10-K/10-Q/20-F/40-F）
- [x] `evidenceRefs` 从 `string[]` 升级为结构化记录；`lastEvidenceDate` 改为派生（`scripts/sync-investment-universe-valuation.mjs` 自动重算，校验器强制"派生值 = 最新记录日期"）
- [x] 校验器 `scripts/validate-investment-universe.mjs`：拒绝新闻来源、拒绝跨证券绑定、拒绝重复记录、`verified` 公司必须每家证券都有身份来源
- [x] 回写脚本 `scripts/collect-universe-evidence.mjs`（`--dry-run` 可选），无文件时保持 `proposed`，不臆造
- [x] 首次全量回写：115 条记录（每个证券恰好一条最新定期报告），文件 173 KB

**巨潮取数根因（2026-10-28 修复）**：A 股一度大面积 `no_documents`，有三个叠加的 bug，都不是"取不到数据"：

1. **只翻公告流第一页。** 原代码取 `page 1, pageSize 50`，而公告总量 847–3,628 条。宁德时代第一页 30 条全是「H股公告（翌日披露报表）」「回购进展」，半年报排在几千条之外。
2. **标题正则漏匹配。** 正则 `第[一二三四]季度报告` 要求带「第」字，巨潮实际标题是 `2026年三季度报告`。宁德时代第一页其实**就有**这份报告，却被判成 MISS。
3. **类别后缀猜错。** 沪深分别用 `_sh` / `_sz` 时巨潮**不报错**，而是静默返回全量公告流；实测只有 `_szsh`（深沪合写）生效：

   | category | total | 结果 |
   |---|---|---|
   | `category_sjdbg_szsh` | 9 | ✅ `2026年三季度报告` |
   | `category_sjdbg_sh` | 1797 | ❌ 回落到公告流 |
   | `category_sjdbg_sz` | 1797 | ❌ 回落到公告流 |

**改法**：弃用「翻页 + 标题正则」，改为按巨潮自己的 4 个定期报告类别直接查询（新增 `fetchCninfoPeriodicReports()`）。并发改串行 + 退避重试——该接口每约 45 秒随机返回 403，而 POST 在 HTTP 层被判为不可重试，一次瞬时拒绝就会变成看起来像"这家公司没有报告"的永久失败。

**证据集口径**：初次回写把 4 个类别的全部历史写入，7,213 条、文件 2.5 MB。证据规则要求的其实是「每个证券最新一份定期报告」，按证券截断后 **115 条 / 173 KB**，语义反而更正确。

**剩余 1 家**：SK 海力士。美股 ADR `SKHY` 只提交 6-K/F-1，无 20-F/10-K；韩国线 `000660.KS` 无一手适配器。属结构性缺口，非 bug。

### P2-3 研究分级 ✅ 已完成（2026-10-28）

**根因**：分级规则只写在页面里（`investment-universe-page.ts` 的 `researchTier`），从未写入数据，所以 `researchPriority` 字段是 98 家清一色 `L1` / `research`。字段值全相同，等于没有分级。

- [x] 规则上移到 domain：`researchTierFor()`（`valuation-coverage.ts`），前端只读派生字段
- [x] 三个输入，都不涉及价格：**原型难度**（保险/地产运营/未盈利生物科技 = 3，银行/交易所/稳定现金 = 2）、**因子集中度**（唯一主导因子且方向 `mixed` 时 +1，因为收益方向无法从因子读出）、**证据完备度**（未全部核验直接 L1）
- [x] 写入 `config/investment-universe.json` 的 `researchPriority` / `watchStatus` / `researchBasis`（分级依据，可审计）
- [x] 自检 `check:valuation-coverage` 断言分级**不得塌缩成单一档**，且无证据的公司不得被提拔

实测分布 **L1 40 / L2 35 / L3 23**，`watchStatus`：`research` 40 / `priority` 58。抽样：

| 公司 | 优先级 | 依据 |
|---|---|---|
| 中国平安 | L3 | 原型 insurer + 全部证券已核验 |
| 招商银行 | L2 | 原型 bank + 全部证券已核验 |
| 中际旭创 | L1 | 原型 growth_manufacturing + 全部证券已核验 |
| SK 海力士 | L1 | 原型 cyclical_commodity + **身份未核验，先补一手文件** |

- [ ] 分级尚未加入"数据新鲜度"（如最新报告是否已过期 12 个月），需要日期窗口规则

### P2-4 因子的二次校准

- [x] **AI 算力链复核**：19 家 / 25 席位 = 76% 的算法把"目标持仓 25 席"当成了公司总数，实际是 19/98 = 19%（主导 16、次要 3）。这 19 家的主导敞口逐条核对后都是真实的（加速器、先进制程、光模块、PCB、液冷、工业自动化），**没有重复计数**，因此不拆。
- [x] **主 + 次要敞口**：`TRACK_FACTORS` 从"一个赛道一个因子"改为"主 + 次"列表，14 个因子全部至少有一个 primary 与一个 secondary 归属；校验器强制这一点，否则该因子无法表达"次要敞口"。
- [x] **方向落地**：`FactorMapping.direction`（positive / negative / mixed）＋ `reason` 写明传导路径；`factorExposures` 从 `string[]` 改为 `{factor, weight, direction}[]`。
- [x] **利率不再是单一桶**：新增 `rateSensitivity.channels` 按传导渠道分组（净息差、长端利差损、股息贴现率、贵金属实际利率、资本化率、结算利率），`unresolved` 必须为空；校验器断言"利率敞口公司必须另带一个传导因子"。
- [x] **集中度边界**：任何单一因子不得超过观察池 35%；唯一允许单公司的因子是 `geopolitical_export_control`（结构性只约束一家代工）。
- [x] 银行 / 保险 / 电力拆开：净息差、利差损、股息贴现率是三条不同路径，方向与量级都不同。
- [ ] 权重仍是定性（primary / secondary），**没有**量化 beta 或回归系数；这需要历史收益序列，属于 P3 回测范围。
- [ ] 权重仍是定性（primary / secondary），**没有**量化 beta 或回归系数；需要历史收益序列才能做，属于 P3 回测范围。

---

## P3：把估值接进每日流程

### P3-1 估值区间变化 ✅ 已完成（2026-10-28）

**难点不是展示变化，而是归因。** 同一个可见变化可以来自三个完全不同的原因：

| 归因 | 含义 | 误判后果 |
|---|---|---|
| `filing` | 公司披露了新一期报告，分母换期 | 正确信号 |
| `model` | **我们改了默认倍数或原型** | 会把自己的参数调整当成公司新闻 |
| `price_source` | 行情源不可用导致区间失效 | 会把数据故障当成估值变化 |
| `unattributed` | 无法归因 | 必须如实写明，不许猜 |

- [x] `src/modules/research/domain/valuation-band-review.ts`：快照 + 差异 + 归因
- [x] **快照不含价格**：`implied` 与 `marketCap` 在生成快照时被丢弃，只留区间、口径、报告期
- [x] 差异覆盖 8 类变化：`denominator_changed`（最常被漏的一类）、`range_changed`、`role_changed`、`became_available/unavailable/forbidden`、`archetype_changed`、`appeared/disappeared`
- [x] `scripts/snapshot-valuation-bands.mjs`：采集当日快照并与上一份对比，按归因分组输出
- [x] 自检 `check:valuation-band-review`（9 组用例，四种归因全部实际触发）

**开发中发现并修掉一个真实遗漏**：最初只比较 `status` / `range` / `role`，于是**新一期报告换了分母但倍数不变**时完全没有记录——而这恰恰是最常见的真实变化。补上 `denominator_changed` 才对。

实测（模拟上一日为旧报告期、且 EV/EBIT 倍数被改过）：

```
[filing] 300308.SZ pe_ttm: net_income_ttm@2026-03-31（150.00 亿） → net_income_ttm@2026-06-30（204.53 亿）
[model]  300308.SZ ev_ebit: 7–14x → 8–16x
```

无变化时次日对比输出 `0 band changes`，不会每日误报。

### P3-2 研究候选的机器判定 ✅ 已完成（2026-10-28）

- [x] `src/modules/research/domain/valuation-screen.ts`：只输出 `research_candidate / watch / blocked`，**不产出** `consider_buy / consider_add / consider_trim`
- [x] `scripts/screen-valuation-candidates.mjs`：全池筛选，`--market/--limit/--verdict/--json`；只读，不写任何文件
- [x] 自检 `check:valuation-screen`，已接入 `check:valuation-chain` → `check:all`
- 核心约束：账户资金与持仓永不进公开 JSON，因此机器只能判"研究候选"，不能判"可交易"；每条结果都带 `executable: false`

**只有主方法能形成候选。** 原型定义写明保险的 PE 是"辅助，不单独使用"、银行的 PE 也是辅助；若只剩辅助区间可用，只能停在 `watch` 并说明"主方法不可计算"。实测中国平安/中国太保原本以 PE 显示 66–72% 安全边际，改后正确降级为 `watch`。

**币种不一致是硬阻断。** 区间分母用报表币种、市值用交易币种：阿里/腾讯/农夫山泉以人民币报账，友邦以美元报账，五家港股全部以港币交易。跨币种相除是一个 7.8 倍的错误，但看起来仍像个数字，所以一律 `blocked`，不做隐含换算（复用了 `relative-valuation-ledger` 既有的"币种不同即抛错"原则）。

**阻断原因必须准确。** 三个真实缺陷是实测中暴露并修掉的：

| 缺陷 | 症状 | 根因 |
|---|---|---|
| 用 `band.implied.metric` 判可比性 | 688256.SH 有 30x PE 区间却报"无可用区间" | 区间引擎缺市值时会把 `implied` 整个丢掉，于是"缺行情"被误报成"无估值方法" |
| 陈旧度取第一个可用区间 | 选中的 PE 新鲜、辅助 PB 陈旧时结论乱跳 | 应取最终选中那个区间的锚点 |
| 单次取数失败即判不可筛选 | 33 家报 `quote_missing`，含茅台/五粮液 | 行情接口限流；加 3 次重试后降到 1 家，并区分 `quote_fetch_failed`（取数失败）与 `quote_missing`（确实无市值） |

**周期中枢区间不能按 120 天判陈旧。** 中枢锚在最近一个完整财年，2026 年 10 月看到 2025-12-31 锚点是**正确**的（2026 年报还没出）。按 TTM 门槛判定会把全部 10 家周期股永久阻断，改按 460 天（缺一个完整年度才算陈旧）。

实测全池（97 家已核验）：

```
byVerdict  { watch: 54, blocked: 30, research_candidate: 13 }
blocked    quote_fetch_failed 9 / currency_mismatch 5 / no_market_cap_band 14
           no_available_band 1 / quote_missing 1
```

候选全部落在 primary 方法上：3 家银行用 `pb`，10 家用 `pe_ttm`。

**同时修掉两个区间引擎缺陷**（会污染 P3-1 的快照归因）：

| 缺陷 | 影响 | 修法 |
|---|---|---|
| `pe_mid_cycle` 把窗口标签 `2016..2025` 当 `reportDate` | 锚点不是日期，周期股永远无法判陈旧；快照 diff 还会把它当成 `filing` | 改用窗口内最新年报的真实报告期，窗口降级为 assumption |
| 银行/保险的 `pe_ttm` 被设为 primary | 通用 8–18x 套在资产负债表驱动业务上，银行显示 60–70% 虚假安全边际 | 按原型降级为 auxiliary，银行主方法回落 PB |

`role_changed` 的归因原本无条件写成 `filing`，但区间角色由原型静态决定，因此改成 `model`。

归因修复还有一个**必须用旧快照实测才能发现**的坑：空字符串锚点修复后，`reportDate` 从 `""` 变成 `2026-06-30`，naive 比较 `then !== now` 会把"我们补上日期"读成 `filing`（"新一期报告让分母成立"），收益率区间还会再额外产生一条 `unattributed`。现在统一由 `anchorAdvanced()` 判定——**只有两个都能解析的日期且后者更新**才算 `filing`，其余锚点变化一律 `model`。

用当日旧快照（含三个缺陷）实测对比，修前 60 处变化被拆成 `model 16 / filing 19 / unattributed 25`（错），修后 **60 处全部 `model`**（对）——因为这一批变化确实全部来自我们。

### P3-3 复盘留痕 ✅ 已完成（2026-10-28）

- [x] `docs/investment-daily/TEMPLATE.md`：8 节固定结构，含"被否掉的假设"与"与上一日差异"
- [x] `docs/investment-daily/YYYY-MM-DD.md`：首份留痕 `2026-10-28.md`
- [x] 自检 `check:daily-notes`：只查结构，不判断分析质量
- [x] 已接入 `npm run check:all`

校验器实际拦下的错误（均实测）：

| 错误 | 是否拦下 |
|---|---|
| 模板未填（残留 `YYYY-MM-DD` / 占位表格） | ✅ |
| 写了个人持仓成本 | ✅ |
| 区间变化行没标归因 | ✅ |
| `报告日` 与文件名不一致 | ✅ |
| 同一日期两份留痕 | ✅ |
| `unattributed` 未解释原因 | ✅ |

### P3-4 回测 —— 未开始

- [ ] 用历史财务 + 历史 K 线验证估值区间是否真的能区分后续回报
- 前置：需要历史价格序列（雪球）与历史财报快照，两者当前都没有长期存档

---

## 本轮（P3-1/P3-3）顺带修掉的两个 P2 遗留缺陷

### 1. 美股代码在 API 侧解析不到发行人

观察池存的是交易所原生符号 `NVDA`，而 API 规范化后是 `NVDA.US`。`companyValuationCoverage()` 用字面量比较，于是 `NVDA.US` 返回 `null`：

```js
companyValuationArchetype("NVDA")     // growth_manufacturing ✅
companyValuationArchetype("NVDA.US")  // null ❌  → 区间落到通用 other
```

**影响**：15 家美股全部走 `other` 原型，银行/保险式的禁用规则与专用区间全部失效，且**不报错**。

修法：`sameSecurity()`（`src/shared/codes.ts`）——只在"裸符号 ↔ `.US`"之间成立，其余代码不比字面量更宽松。`601398`（池外）仍返回 `null`。

### 2. 港股估值区间恒为空

`load-valuation-bands.ts` 的 TTM 函数只认两个 A 股契约：

```ts
contract === "eastmoney_f10_income.v1" || contract === "eastmoney_f10_annual_income.v1"
```

港股行的契约是 `eastmoney_hk_f10_main_indicator.v2`，被过滤掉 → TTM 净利润为 `null` → **5 家港股的区间全部 `insufficient_data`**，理由显示为"分母缺失"，看起来像公司没有盈利。

修法：契约判断抽到 `src/modules/finance/domain/income-row-contracts.ts`，显式列出 4 个累计口径契约；**未列入的契约默认不可用**（fail closed）。

验收：港股 5/5 恢复可用，友邦 TTM = 438.17 + 292.46 − 181.40 = **549.24 亿**，与接口返回一致；A 股 78 家结果不变。

**为什么没把 Yahoo 一起加进去**：Yahoo 行的 `FISCAL_PERIOD` 是时长（`12M`/`3M`），不是"累计/单季"之分，把 3M 行喂给累计公式会重复计数。

### 3. TTM 财年基期按 12-31 推断

契约修好后港股区间能算了，但算得**不对**：TTM 的实现把"日期为 12-31 的那一行"当作上年报，而只有财年 12 月结束的公司才成立。

用户提到"港股也有季度财报接口"，核实东财 `RPT_HKF10_FN_MAININDICATOR` 确实返回一季报/中报/三季报/年报四类，`DATE_TYPE_CODE` 明确标注。季报的存在意味着**财年不必 12 月结束**——阿里（`09988.HK`）财年是 3-31。

| | 旧算法 | 正确值 |
|---|---|---|
| 阿里 TTM 归母净利 | 480.16 亿 | **735.57 亿** |
| 构成 | 780.51（三季报，被当年报）+ 106.14 − 406.49 | 1035.92（2026-03-31 年报）+ 106.14 − 406.49 |
| 偏差 | −35% | — |

且区间仍标 `available`：错数字和"算不出来"看起来一样可用。

同一个假设共四处，现全部收敛到 `src/modules/finance/domain/ttm-fiscal-calendar.ts`：

| 位置 | 后果 |
|---|---|
| `trailingCumulative` | 阿里 TTM 净利低估 35% |
| `ttmCapitalExpenditure` | 同上；A 股现金流无 `FINANCIAL_SOURCE_CONTRACT`/`FISCAL_PERIOD`，改用 `REPORT_TYPE=年报` |
| `latest-financial-valuation.ts` 的 `trailingTwelveMonths` | 阿里 PE(TTM) 恒为 `null` |
| `quarterly-ttm-series.ts` 的 `incomeFamilyOf` | 港股行落到"无契约 → 单季"，累计列全空、累计值塞进单季列、TTM 全空 |

修法：财年基期只认数据源声明的年报行（港股 `DATE_TYPE_CODE=001`、A 股 `*INCOME` 年报家族、现金流 `REPORT_TYPE=年报`、Yahoo `FISCAL_PERIOD=12M`）；上年同期按财年基期的**月份偏移**计算，不按自然年减一；缺年报返回 `null`，不回退到任一中间期。

验收：阿里 TTM 净利 735.57 亿、季报序列同期一致；港股 5/5 区间可用；A 股 78 家 TTM 新旧算法**零差异**；美股 15 家区间恢复（代理可用后仅 AMZN 缺区间，因 Yahoo 未返回市值与负债科目）。自检：`npm run check:ttm-fiscal-calendar`。

---

## 依赖关系

```
P0 数据可信（✅ 已完成）
        │
        ├─→ P1-1 EBITDA ──┐
        └─→ P1-3 可比矩阵 ─┴─→ P1-2 估值区间 ─→ P3 每日流程
P1-4 行业对照 ──→ P2-4 因子校准
P2-1 身份核验 ──→ P2-2 证据链
```

**建议顺序**：P1-1（决策点）→ P1-2 → P1-3 → P2-1/P2-2 → 其余。

P0 已交付的运维命令：

```bash
npm run check:all                              # 全量自检（提交前跑这个）
npm run audit:quarterly-series                 # 78 家 A 股季度序列审计（需本地 API）
npm run audit:valuation-multiples              # 98 家倍数可算性审计（需本地 API）
npm run repair:income-snapshots                # dry-run 统计旧快照
npm run repair:income-snapshots -- --delete    # 真正清理
```

---

## 需要你拍板的三个决策点

1. **EBITDA 怎么办**：补充资料取不到时，是接受"只有 EV/EBIT"，还是允许用估算折旧（并强制标注）？
2. **估值区间落在哪**：是只做本地研究脚本输出到 `reports/`，还是要进公开页面（涉及 JSON Schema 变更）？
3. **周期中枢利润需要 10 年财务**：现有数据够不够，要不要扩大抓取范围？

---

## 验证命令

```bash
npm run check:quarterly-series      # 两个财报家族 + 恒等式
npm run check:ttm-annual-base       # 四季度不冒充年报
npm run check:ttm-fiscal-calendar   # 财年基期不按 12-31 推断（3-31 财年、现金流、港股家族）
npm run check:valuation-inputs      # 估值口径算术
npm run check:valuation-coverage    # 原型分类、因子集中度
npm run check:investment-universe   # 观察池与每日报告 Schema
npm run typecheck:server
./start-local.sh                    # 起本地后跑 npm run test:basic
```
