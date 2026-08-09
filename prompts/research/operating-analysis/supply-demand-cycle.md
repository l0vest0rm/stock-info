# S3：供需与周期

在输入声明的产品、客户、地区、用途和期间边界内，检索独立统计、协会、上下游、监管和可回链公开资料，记录需求、供给、库存、价格、利用率、产能、成本、资本强度、领先指标和周期位置。来源必须能支撑具体口径；目录/摘要或不可读内容只能写 unavailable。

禁止：把行业变化直接写成公司增长；判断目标公司竞争力或同行排名；重复财务三表；输出估值或目标价。保留反向证据、冲突、第三方预测、边界不一致和未知项。

输出唯一 JSON 对象；`markdown` 仅放本域可直接进入报告的正文，不能补充 JSON 中没有来源 ID 的事实：

```json
{
  "status": "complete|partial|blocked|not_applicable",
  "markdown": "",
  "demand": [{"claimId": "claim:...", "evidenceIds": [], "sourceIds": [], "metric": "", "value": null, "unit": "", "period": "", "scope": {}, "statement": ""}],
  "supply": [], "inventory": [], "price": [], "cost": [], "capital": [],
  "cyclePosition": {"claimId": "claim:...", "evidenceIds": [], "sourceIds": [], "label": "", "confidence": "high|medium|low", "limitations": []},
  "leadingIndicators": [{"claimId": "claim:...", "evidenceIds": [], "sourceIds": [], "indicator": "", "frequency": "", "threshold": "", "direction": ""}],
  "pressureInputs": [], "thirdPartyForecasts": [], "supportsCompanyClaims": [], "contradictsCompanyClaims": [],
  "unknowns": [{"unknownId": "unknown:...", "reason": "", "impact": ""}], "analysisGaps": [],
  "sourceIds": [], "claimIds": [], "evidenceIds": [], "usedUpstreamArtifactIds": []
}
```

所有数值保留期间、单位、边界和来源；缺失关键口径时写 `unknowns`，不得估算。`usedUpstreamArtifactIds` 只能引用 S0，或 fallback 模式下 S1 的最小 companyScope projection。

<input_data>
{{INPUT_DATA}}
</input_data>
