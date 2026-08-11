# 深入财务分析：实现方案与验收清单

## 目标

在 `company-finance.html?code=<证券代码>` 提供单证券的「深入财务分析」页签。它以现有三表接口为唯一财务数值主来源：A/H 股使用 Eastmoney，美股使用 Yahoo；法定披露用于逐字段核验，不作为静默回退。模型只解释工程冻结的事实、确定性指标和官方附注证据，绝不补数或重算。

投资分析页只提供跳转链接；完整财务结论、证据、版本历史都归属财务页面，避免重复生成和结论漂移。

## 用户路径

1. 用户打开 `company-finance.html?code=300308.SZ`。
2. 在「深入财务分析」页签看到最新报告期、财务来源、核验状态、覆盖期间及数据缺口。
3. 用户触发生成；本地 Node runtime 创建持久 LLM task，通用调度器经 WebQA 执行。
4. 页面轮询报告状态，终态展示 Markdown、引用摘要、原始 artifact 信息与输入 fingerprint。
5. 若三表或核验输入改变，下一次生成创建新版本；仅上次失败且 prompt/code/input 指纹完全一致时可 Resume。

多证券比较仍是原有图表和表格功能；深入报告只允许一个证券代码，比较模式必须显式提示，不能混合公司数据。

## 数据与门禁

输入合同为 `financial-analysis-input.v1`，由服务端冻结：

```json
{
  "schemaVersion": "financial-analysis-input.v1",
  "securityCode": "300308.SZ",
  "asOf": "...",
  "entityType": "non_financial",
  "dataQuality": {
    "status": "available|partial|blocked",
    "sourcePolicy": "...",
    "statutoryVerification": {},
    "gaps": [],
    "incomparables": []
  },
  "periodCoverage": { "annual": [], "quarterly": [], "ttmEndDate": null },
  "reportedFacts": { "income": [], "balance": [], "cashflow": [], "perShareAndCapitalAllocation": [], "filingNotes": [] },
  "derivedObservations": [],
  "deterministicFlags": [],
  "lineage": { "factIds": [], "sourceIds": [], "evidenceIds": [], "inputFingerprint": "..." }
}
```

每项数值必须含期间、币种、会计/合并口径、事实 ID，以及经过大小约束的来源投影（`sourceId`、provider、URL/locator、发布日期）。输入覆盖近五个年度、近八个单季和可比时的 TTM；同日 FY/12M 与 Q4 不能重复累计。

只有三张主表均可用时才创建模型任务；主源请求失败或任一表为空时接口显式返回 blocked，不用空数据生成“财务结论”。法定核验尚未齐全则可生成，但必须在第一章披露为 partial。

工程层从 `ResearchFinancialQuality` 投影以下可用观测：增长/利润率、FCF、现金转换、营运资本与 CCC、净负债/流动性/利息覆盖、NOPAT/投入资本/ROIC/增量 ROIC、每股 FCF、稀释与资本配置。缺少分子、分母、前期余额或可比 basis 时必须保留 `missing`、`incomparable` 或 `not_applicable`。银行、保险、券商不套非金融指标。

风险不交给模型凭感觉发现。工程层按版本化规则产生 `deterministicFlags`：收入同比/环比和营业利润/净利润同比下滑、TTM 营业利润率收缩、CFO/净利润低于 80% 或较上期显著恶化、FCF 为负、应收/存货占收入比跳升、杠杆/利息覆盖/流动与速动比率压力、现金转换周期拉长、TTM ROIC 收缩、稀释加速。每条 flag 必须保留观测 id、期间、实际值、阈值、严重度与适用范围；未满足计算前提时不触发，也不把缺失视为安全。

商誉集中、维持性/扩张性资本开支拆分、债务期限表、审计意见、客户集中度和关联交易都需要附注结构化事实；当前三表主源未提供时会列为 `unknown`/待核验，而不会由模型猜测。后续补录这些事实可沿用相同输入合同和红旗机制。

## WebQA 边界

财务数值由结构化接口提供。WebQA 只可使用输入中已持久化的官方附注、审计、债务期限、减值、关联交易和资本配置证据解释数值；它不能用检索结果替换数值，也不得以模型记忆填补缺口。返回必须是完整的 `webqa.answer.v1`，成功以 `response.completed` 和通过输出校验为准。

报告要求八章：数据覆盖、收入与盈利、现金与营运资本、资本效率、资产负债表、每股与资本配置、红旗与监控、条件化综合结论。不得给目标价、交易建议或总分。

## 任务与接口

- 业务 task identity：`research_financial_analysis`（保存为通用 `generic_raw_model` task 的 immutable `originTaskType`，以复用全局队列、provider lease 和 artifact 表）
- handler：`generic_raw_model`；执行传输由 `originTaskTypeTransports.research_financial_analysis* = webqa` 选择 WebQA
- 读接口：`GET /api/research/company/:code/financial-analysis`
- 创建/刷新：`POST /api/research/company/:code/financial-analysis/refresh`
- Resume：`POST /api/research/company/:code/financial-analysis/resume`
- runner：独立 Node runner，经现有 generic LLM dispatcher、全局 provider lease 和 WebQA adapter 执行。

任务与 artifact 必须保存 prompt/input 版本、输入 fingerprint、原始 WebQA 结构化答案、Markdown、citation/source 投影和运行状态。生产环境保持 `LLM_RUNTIME=production`，不得调用模型。

## Todo

- [x] 定义财务分析输入/报告领域类型、快照编译器、版本化财务风险规则及单元测试。
- [x] 复用三表和 `loadResearchFinancialQuality()`，投影五年、八季、TTM、数据质量、指标和缺口。
- [x] 复用已有通用 task/run/artifact 持久化及 API，严格实现 refresh 与 Resume 资格门禁；无需重复建表。
- [x] 添加提示词、WebQA transport 路由和本地运行配置；通用 handler 复用全局调度。
- [x] 在 `company-finance.html` 增加独立「深入财务分析」页签，不阻塞原图表/三表加载。
- [x] 在投资分析页加入跳转链接，不重复生成。
- [x] 编写快照与风险规则测试，并运行研究域测试、类型检查和 Web/Node 构建。
- [x] 真实链路验证：每次生成使用不同证券，覆盖 A 股、港股、美股；检查 `response.completed`、持久 artifact、引用投影和页面/API 状态。
  - A 股 `600176.SH`：Eastmoney 三表 22/17/17 行，成功产出 14,249 字、8 个一级标题；artifact `llm-artifact:30cc7698-9699-437a-bdab-2784fe51ffaa` 已持久化，且 `completionEvidence` 为 `webqa.completion-evidence.v1`/`succeeded`。
  - 美股 `MSFT.US`：Yahoo 三表 9/9/9 行；gateway 返回带 `terminal_evidence` 的 `succeeded`，但模型仅返回 9 字首标题，业务 `artifactContract` 正确拒绝，未把传输成功误记为报告成功。
  - 港股 `00390.HK`（40/40/40）及 `03690.HK`（38/38/38）：均到达带 `terminal_evidence` 的 `succeeded`，但分别只有 10/16 字首标题，均被同一八章/800 字门禁正确拒绝。早先 `BABA.US` 的 v3 报告已验证完整 8 章 artifact；本轮以不同代码验证新终态契约和失败可见性。
