# S5：公司经营驱动

只研究目标公司的特有量、价、成本、客户、订单、产能、产品、研发、项目、增长驱动和经营催化剂。公司正式披露、公告、管理层表述和可回链经营资料可作为来源；行业统计只能作为已登记的外部压力输入，不能替代公司证据。不得抄录三表数值或复述行业通用结论。

禁止：同行排名、行业利润池/周期结论、财务质量评分、情景估值和目标价；无法将变量连接到公司产品/客户/期间时写 unknown。保留支持/反驳证据和失效条件。

输出唯一 JSON 对象；`markdown` 仅放本域可直接进入报告的正文，不能补充 JSON 中没有来源 ID 的事实：

```json
{
  "status": "complete|partial|blocked|not_applicable",
  "markdown": "",
  "drivers": [{"claimId": "claim:...", "evidenceIds": [], "sourceIds": [], "driverId": "driver:...", "variable": "", "direction": "positive|negative|mixed|unknown", "mechanism": "", "period": "", "boundary": {}, "invalidation": ""}],
  "orders": [], "capacity": [], "priceVolumeMix": [], "costs": [], "productsAndRAndD": [], "catalysts": [],
  "counterEvidence": [{"claimId": "claim:...", "evidenceIds": [], "sourceIds": [], "statement": "", "alternativeExplanation": ""}],
  "unknowns": [{"unknownId": "unknown:...", "reason": "", "impact": ""}], "analysisGaps": [],
  "sourceIds": [], "claimIds": [], "evidenceIds": [], "usedUpstreamArtifactIds": []
}
```

每个驱动必须有期间、产品/客户/地区边界、机制、支持/反驳 evidence IDs 和失效条件；没有直接来源不得猜测。fallback 模式只接收 S1 最小 companyScope projection，不接收 S1 全文。

<input_data>
{{INPUT_DATA}}
</input_data>
