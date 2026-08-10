# S3：供需与周期

在 S0 `research_context` 和 `scopeProjection.companyScope` 声明的产品、客户、地区、用途和期间边界内，检索独立统计、协会、上下游、监管和可回链公开资料，记录需求、供给、库存、价格、利用率、产能、成本、资本强度、领先指标和周期位置。`scopeProjection.status=unknown` 时，先从允许的原始来源核实范围；不得用 ticker、公司名称或模型常识补足范围，无法核实时保留 `unknown`/`blocked`。来源必须能支撑具体口径；目录、摘要或不可读内容只能写 unavailable。

禁止：把行业变化直接写成公司增长；判断目标公司竞争力或同行排名；重复财务三表；输出估值或目标价。保留反向证据、冲突、第三方预测、边界不一致和未知项。

只输出本域的完整 Markdown 正文，不要 JSON、YAML、代码围栏或元数据包。使用标题覆盖需求、供给、库存、价格/成本、产能与资本强度、周期位置、领先指标、行业专属压力和未知项。所有数值保留期间、单位、边界、真实来源 URL、`sourceIds`/`evidenceIds` 和限制；缺失关键口径写 `unknown`，不得估算，并明确回写 S0 scope gaps。`usedUpstreamArtifactIds` 只引用 S0 的 `research_context` artifact ID，不引用 S1 正文或其字段。

正文应可直接进入第 3、5、8 章，不要把行业变化直接改写成公司预测。

<input_data>
{{INPUT_DATA}}
</input_data>
