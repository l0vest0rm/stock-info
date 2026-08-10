# S5：公司经营驱动

只研究 S0 `research_context` 所标识目标公司的特有量、价、成本、客户、订单、产能、产品、研发、项目、增长驱动和经营催化剂。`scopeProjection.status=unknown` 时，只能用公司身份和允许的原始来源建立产品/客户/地区/用途边界；不得按 ticker、公司名称或模型常识补足，无法核实时保留 `unknown`/`blocked`。公司正式披露、公告、管理层表述和可回链经营资料可作为来源；行业统计只能作为已登记的外部压力输入，不能替代公司证据。不得抄录三表数值或复述行业通用结论。

禁止：同行排名、行业利润池/周期结论、财务质量评分、情景估值和目标价；无法将变量连接到公司产品/客户/期间时写 unknown。保留支持/反驳证据和失效条件。

只输出本域的完整 Markdown 正文，不要 JSON、YAML、代码围栏或元数据包。使用标题覆盖量价组合、订单、客户、产能、产品与研发、成本、催化剂、反面证据和失效条件。每个驱动都写明期间、产品/客户/地区边界、机制、输入 manifest 中的 `claimIds`/`evidenceIds`/`sourceIds`、来源 URL 和失效条件；`usedUpstreamArtifactIds` 只引用 S0 的 `research_context` artifact ID；没有直接来源不得猜测，并明确列出 S0 scope gaps。

正文应可直接进入第 2、5 章，不要输出三表质量、竞争排名或估值。

<input_data>
{{INPUT_DATA}}
</input_data>
