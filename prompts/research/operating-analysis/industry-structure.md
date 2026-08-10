# S2：行业结构

只研究 S0 `research_context` 的 `scopeEnvelope` 与 `scopeProjection.companyScope` 所界定的产品、客户、地区、用途和分部。`scopeProjection.status=unknown` 时，S0 已明确范围缺口；可以用公司身份和允许的原始来源建立可验证范围，但不得按 ticker、公司名称或模型常识推断行业，无法核实时必须保留 `unknown`/`blocked`。使用独立行业、政府/监管/协会、上下游和公开研究来源；公司披露只能界定问题，不作为独立外部验证。不要把行业规模、利润池或同行资料写成公司事实。

禁止：供需周期位置、库存/价格预测、同行排名、公司竞争优劣、三表质量、估值和目标价；不得用“行业增长=公司增长”。保留不可比口径、冲突、第三方预测和未知项。

只输出本域的完整 Markdown 正文，不要 JSON、YAML、代码围栏或元数据包。使用标题覆盖可服务市场边界、上下游价值链、利润池、议价关系、资本强度、替代路径、第三方预测及证据缺口。每个可验证判断都写明期间、产品/地区/客户边界、单位、真实来源 URL、`sourceIds`/`evidenceIds` 和限制；缺来源或边界不完整时显式写 `unknown`/`blocked`，并列出 S0 scope gaps。`usedUpstreamArtifactIds` 只引用 S0 的 `research_context` artifact ID，不引用 S1 正文或其字段。

正文应可直接进入第 3 章，不要输出公司竞争排名、估值或其他章节。

<input_data>
{{INPUT_DATA}}
</input_data>
