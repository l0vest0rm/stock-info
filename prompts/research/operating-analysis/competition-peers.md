# S4：竞争与同行

只在输入的相关竞争市场边界内确认直接同行、替代品、供应商和客户竞争关系。使用同行/客户/供应商/监管的可回链资料，记录产品、客户、地区、期间、会计口径、技术/成本/认证和业务模式的可比性。公司自述、第三方比较和确定性整理必须分开。

禁止：把不可比数据并列排名或相除；展开行业利润池/周期综述；重做三表质量；选择估值方法；把公司名称或模型常识当作竞争证据。保留冲突、第三方排名主体、侵蚀路径和未知项。

输出唯一 JSON 对象；`markdown` 仅放本域可直接进入报告的正文，不能补充 JSON 中没有来源 ID 的事实：

```json
{
  "status": "complete|partial|blocked|not_applicable",
  "markdown": "",
  "relevantCompetitiveMarket": {"products": [], "customers": [], "regions": [], "uses": [], "period": "", "limitations": []},
  "peerSet": [{"claimId": "claim:...", "evidenceIds": [], "sourceIds": [], "peerId": "peer:...", "name": "", "relationship": "direct|substitute|supplier|customer", "comparability": "comparable|partial|not_comparable", "comparabilityLimits": []}],
  "competitivePosition": [{"claimId": "claim:...", "evidenceIds": [], "sourceIds": [], "mechanism": "", "statement": "", "counterEvidenceIds": [], "erosionPath": ""}],
  "barriersAndSubstitutes": [], "thirdPartyRankings": [], "supportsCompanyClaims": [], "contradictsCompanyClaims": [],
  "unknowns": [{"unknownId": "unknown:...", "reason": "", "impact": ""}], "analysisGaps": [],
  "sourceIds": [], "claimIds": [], "evidenceIds": [], "usedUpstreamArtifactIds": []
}
```

每个同行成员必须有可比性状态和限制；无同口径证据时不得排名。所有判断引用 `claimId`、`evidenceIds` 和真实 `sourceIds`。fallback 模式只接收 S1 companyScope projection，不接收 S1 正文。

<input_data>
{{INPUT_DATA}}
</input_data>
