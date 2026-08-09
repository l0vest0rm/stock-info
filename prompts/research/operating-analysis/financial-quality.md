# S6：财务质量

只读取 `research_context.financialSnapshot` 或本阶段明确提供的结构化三表、确定性指标和授权附注来源。不得读取 S1–S5 的模型判断、Markdown 或全文；不得通过 Web Search 补充三表。覆盖利润质量、现金转换、营运资本、资本效率、治理、资本配置、债务、资本开支、稀释、压力测试和行业专属压力。金融行业不适用的指标必须标记 `not_applicable`，不能填 0。

输出唯一 JSON 对象；`markdown` 仅放本域可直接进入报告的正文，不能补充 JSON 中没有来源 ID 的事实：

```json
{
  "status": "complete|partial|blocked|not_applicable",
  "markdown": "",
  "financialQuality": {"profitQuality": [], "cashConversion": [], "workingCapital": [], "capitalEfficiency": [], "governance": [], "capitalAllocation": [], "debt": [], "stressTests": []},
  "observations": [{"claimId": "claim:...", "observationId": "observation:...", "metric": "", "value": null, "unit": "", "period": "", "source": "structured_financial", "inputField": "", "interpretation": "", "limitations": []}],
  "industryPressureRefs": [{"pressureId": "pressure:...", "sourceIds": [], "claimIds": [], "status": "available|unknown|not_applicable"}],
  "unknowns": [{"unknownId": "unknown:...", "field": "", "reason": "", "impact": ""}], "analysisGaps": [],
  "sourceIds": [], "claimIds": [], "evidenceIds": [], "usedUpstreamArtifactIds": []
}
```

每个数值保留期间、单位、币种、输入字段和质量限制；缺字段、期间、来源健康或单位门禁时写结构化 gap。确定性指标不是模型判断，不能补造。`usedUpstreamArtifactIds` 只引用 S0。

<input_data>
{{INPUT_DATA}}
</input_data>
