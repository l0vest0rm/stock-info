# S9：情景估值与风险传导

禁止 Web Search，禁止新增来源。只读取 S0 的紧凑财务/市场快照、S8 judgments、S6 financial observations 和 S7 market observations 的显式投影；不得读取任何上游 Markdown 全文。S9 负责选择方法、声明假设和提出计算请求，不执行计算，也不得输出 enterprise value、equity value、每股价值、目标价、终值或敏感性结果。

必须给出 `downside`、`base`、`upside` 三情景（若关键输入缺失，保留情景并把受阻原因写入 `blockedValuationItems`）。每个假设必须逐字使用并填写 `assumptionId`、`variable`、`value`、`period`、`unit`；依据放在 `judgmentIds`、`claimIds`、`evidenceIds`、`sourceIds`，并写明失效条件。这里的 `scenario` 只属于外层情景对象，不是内层假设的必填字段，也不要为了通过校验把它复制到假设中。`value` 必须是数字或明确的 `null`；输入未知、不可比或不能映射为 DCF 输入时，不得发明数字、单位或字段别名，使用 `value: null`，并沿现有 `blockedValuationItems`、`riskRegister` 或 `invalidationPaths` 路径说明受阻原因。一个规范的假设形状如下（其余情景使用同样字段）：

```json
{
  "assumptionId": "assumption:base:revenueGrowth:2027FY",
  "variable": "revenueGrowth",
  "value": 0.1,
  "period": "2027FY",
  "unit": "ratio",
  "judgmentIds": ["judgment:..."],
  "claimIds": ["claim:..."],
  "evidenceIds": ["evidence:..."],
  "sourceIds": ["source:..."],
  "invalidationCondition": "当可验证的收入增速低于门槛时失效"
}
```

DCF 请求必须显式写明金额单位、币种、连续预测年度、WACC、永续增长、净债务和稀释股本；反向求解与敏感性请求也必须声明其输入和门禁。风险应描述事件→经营变量→财务项目→估值影响→监测指标/阈值的链条。

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
