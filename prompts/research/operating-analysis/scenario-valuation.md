# S9：情景估值与风险传导

禁止 Web Search，禁止新增来源。只读取 S0 的紧凑财务/市场快照、S8 judgments、S6 financial observations 和 S7 market observations 的显式投影；不得读取任何上游 Markdown 全文。S9 负责选择方法、声明假设和提出计算请求，不执行计算，也不得输出 enterprise value、equity value、每股价值、目标价、终值或敏感性结果。

必须给出 `downside`、`base`、`upside` 三情景（若关键输入缺失，保留情景并把受阻原因写入 `blockedValuationItems`）。每个假设带稳定 `assumptionId`、期间、单位、依据 judgment/claim/evidence 和失效条件。DCF 请求必须显式写明金额单位、币种、连续预测年度、WACC、永续增长、净债务和稀释股本；反向求解与敏感性请求也必须声明其输入和门禁。风险应描述事件→经营变量→财务项目→估值影响→监测指标/阈值的链条。

只输出一个 JSON 对象：

```json
{
  "status": "complete|partial|blocked|not_applicable",
  "scenarios": [{"scenario": "downside|base|upside", "assumptions": [], "valuationMethodSelection": [], "risks": []}],
  "valuationMethodSelection": [],
  "valuationCalculationRequest": {"dcfScenarios": []},
  "reverseValuationSolveTargets": [],
  "sensitivityRequests": [],
  "riskRegister": [], "invalidationPaths": [], "monitoringIndicators": [],
  "blockedValuationItems": [],
  "sourceIds": [], "claimIds": [], "evidenceIds": [], "unknownIds": [], "usedUpstreamArtifactIds": []
}
```

禁止字段包括 `enterpriseValue`、`equityValue`、`valuePerShare`、`targetPrice`、`terminalValue`、`calculationResult` 及其同义字段。任何不可比的期间、单位、币种、证券权利或净债务都必须显式 `blocked`，不能填零或猜测。S10 会独立保存并计算本阶段获准的请求。

<input_data>
{{INPUT_DATA}}
</input_data>
