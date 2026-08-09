# S2：行业结构

只研究 `research_context.scopeEnvelope`（或无可靠范围时输入中的最小 `companyScope`）界定的产品、客户、地区、用途和分部。使用独立行业、政府/监管/协会、上下游和公开研究来源；公司披露只能界定问题，不作为独立外部验证。不要把行业规模、利润池或同行资料写成公司事实。

禁止：供需周期位置、库存/价格预测、同行排名、公司竞争优劣、三表质量、估值和目标价；不得用“行业增长=公司增长”。保留不可比口径、冲突、第三方预测和未知项。

输出唯一 JSON 对象；`markdown` 仅放本域可直接进入报告的正文，不能补充 JSON 中没有来源 ID 的事实：

```json
{
  "status": "complete|partial|blocked|not_applicable",
  "markdown": "",
  "industryBoundary": {"products": [], "customers": [], "regions": [], "uses": [], "period": "", "comparabilityLimits": []},
  "valueChain": [{"claimId": "claim:...", "evidenceIds": [], "sourceIds": [], "statement": "", "role": "supplier|customer|substitute|channel", "unknowns": []}],
  "profitPool": [{"claimId": "claim:...", "evidenceIds": [], "sourceIds": [], "scope": {}, "metric": "revenue|gross_profit|operating_profit", "period": "", "unit": "", "statement": "", "comparabilityLimits": []}],
  "marketStructure": [],
  "thirdPartyForecasts": [{"claimId": "claim:...", "evidenceIds": [], "sourceIds": [], "forecastSubject": "", "period": "", "metric": "", "value": null, "unit": "", "limitations": []}],
  "supportsCompanyClaims": [], "contradictsCompanyClaims": [],
  "unknowns": [{"unknownId": "unknown:...", "reason": "", "impact": ""}],
  "analysisGaps": [], "sourceIds": [], "claimIds": [], "evidenceIds": [], "usedUpstreamArtifactIds": []
}
```

每个可验证判断必须回链 `sourceIds`/`evidenceIds`，不同期间、产品、地区、收入/出货口径不得相除或排名。`thirdPartyForecasts` 与行业事实分开；缺来源或边界不完整时显式 unknown/blocked。`usedUpstreamArtifactIds` 只能引用 S0，或 fallback 模式下引用 S1 的 companyScope projection，不得引用 S1 全文。

<input_data>
{{INPUT_DATA}}
</input_data>
