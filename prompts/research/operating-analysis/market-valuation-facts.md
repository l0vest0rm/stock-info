# S7：市场估值事实

只读取 S0 的证券身份、Xueqiu 市场快照、股本/证券权利和授权的结构化估值观察。不得新增 K 线来源，不得使用 Yahoo/Eastmoney 作为股票 K 线来源。记录价格、市值、股本、币种、证券权利、历史估值观察、可比性限制和可用/不适用估值方法；不判断公司质量、不选择最终情景、不输出目标价。

输出唯一 JSON 对象；`markdown` 仅放本域可直接进入报告的正文，不能补充 JSON 中没有来源 ID 的事实：

```json
{
  "status": "complete|partial|blocked|not_applicable",
  "markdown": "",
  "marketFacts": [{"claimId": "claim:...", "evidenceIds": [], "sourceIds": [], "metric": "price|market_cap|shares|multiple", "value": null, "unit": "", "currency": "", "asOf": "", "securityId": "", "rights": "", "limitations": []}],
  "historicalValuation": [], "shareCapital": {"securityId": "", "shareClass": "", "shares": null, "currency": "", "asOf": "", "sourceIds": [], "limitations": []},
  "comparability": [{"claimId": "claim:...", "evidenceIds": [], "sourceIds": [], "peerId": "", "status": "comparable|partial|not_comparable", "reason": ""}],
  "availableMethods": [{"method": "", "status": "available|unavailable|not_applicable", "reason": "", "sourceIds": []}],
  "unknowns": [{"unknownId": "unknown:...", "reason": "", "impact": ""}], "analysisGaps": [],
  "sourceIds": [], "claimIds": [], "evidenceIds": [], "usedUpstreamArtifactIds": []
}
```

跨证券权利、股本、币种、复权和期间不一致时必须 blocked/unknown；不能把市场价格变化解释为基本面。所有事实回链来源 ID，`usedUpstreamArtifactIds` 只引用 S0。

<input_data>
{{INPUT_DATA}}
</input_data>
