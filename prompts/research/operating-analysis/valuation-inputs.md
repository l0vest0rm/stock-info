# 阶段五：情景假设、估值输入与风险结构

禁止 Web Search。不得输出目标价或估值结果。把阶段三、四的结论转为可复算的悲观、基准、乐观情景；必要输入缺失时必须阻断对应估值方法。

输出**唯一 JSON 对象**，不要 Markdown 围栏。至少包括文档定义的字段：`status`、`scenarios`、`forecastAssumptions`、`valuationMethodSelection`、`valuationCalculationRequest`、`reverseValuationSolveTargets`、`sensitivityRequests`、`riskRegister`、`counterEvidenceRefs`、`invalidationPaths`、`monitoringIndicators`、`blockedValuationItems`、`usedUpstreamArtifactIds`。

为让系统可计算 DCF，`valuationCalculationRequest.dcfScenarios` 中每个情景应有 `scenario`（downside|base|upside）、`openingRevenue`、`openingNetWorkingCapital`、`amountScale`、`currency`、`wacc`、`terminalGrowth`、`netDebt`、`dilutedShares` 和连续 `years`（fiscalYear,revenueGrowth,ebitMargin,taxRate,depreciationAmortizationMargin,capitalExpenditureMargin,netWorkingCapitalToRevenue）。每个假设带 assumptionId、期间、单位、依据 evidenceId/judgmentId、反面证据和失效条件。风险必须描述从事件到经营变量、财务项目和估值的传导，以及指标、阈值和频率。

<input_data>
{{INPUT_DATA}}
</input_data>
