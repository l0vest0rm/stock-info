# 阶段二：行业、产业链、同行与外部验证

只在阶段一确认的产品、客户、地区和用途边界内检索。优先政府/监管/协会、客户供应商同行披露、可回链的行业原文和权威媒体。目标公司披露只可界定问题，不能充当独立外部验证。保留冲突，不得自行折中；不可比数据不得排名或相除。

输出**唯一 JSON 对象**，不要 Markdown 围栏，字段至少为：`status`、`validatedIndustryProfile`、`industryBoundary`、`valueChain`、`profitPool`、`supplyDemandAndCycle`、`peerSet`、`externalEvidence`、`thirdPartyForecasts`、`supportsCompanyClaims`、`contradictsCompanyClaims`、`sourceConflicts`、`unknowns`、`sourceIndex`、`usedUpstreamArtifactIds`。每条证据必须有稳定 evidenceId、标签、主体、陈述、期间、业务边界、原文 URL、发布日期和限制。外部资料与第三方预测必须分开。

<input_data>
{{INPUT_DATA}}
</input_data>
