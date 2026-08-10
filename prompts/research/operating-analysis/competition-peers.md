# S4：竞争与同行

只在 S0 `research_context` 的 `scopeProjection.companyScope` 所声明的相关竞争市场边界内确认直接同行、替代品、供应商和客户竞争关系。`scopeProjection.status=unknown` 时，先用允许的原始来源核实边界；不得按 ticker、公司名称或模型常识推断竞争市场，无法核实时保留 `unknown`/`blocked`。使用同行/客户/供应商/监管的可回链资料，记录产品、客户、地区、期间、会计口径、技术/成本/认证和业务模式的可比性。公司自述、第三方比较和确定性整理必须分开。

禁止：把不可比数据并列排名或相除；展开行业利润池/周期综述；重做三表质量；选择估值方法；把公司名称或模型常识当作竞争证据。保留冲突、第三方排名主体、侵蚀路径和未知项。

只输出本域的完整 Markdown 正文，不要 JSON、YAML、代码围栏或元数据包。使用标题覆盖竞争市场边界、同行/替代品集合、逐项可比性与限制、竞争机制、壁垒、替代和侵蚀路径、支持/反驳证据及未知项（`unknown`）。每个判断都引用输入 manifest 中真实的 `claimIds`、`evidenceIds`、`sourceIds` 和 URL；`usedUpstreamArtifactIds` 只引用 S0 的 `research_context` artifact ID；无同口径证据时不得排名，并明确列出 S0 scope gaps。

正文应可直接进入第 4 章，不要输出估值或行业周期结论。

<input_data>
{{INPUT_DATA}}
</input_data>
