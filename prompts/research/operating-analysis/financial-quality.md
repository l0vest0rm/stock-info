# S6：财务质量

只读取 `research_context.financialSnapshot` 或本阶段明确提供的结构化三表、确定性指标和授权附注来源。不得读取 S1–S5 的模型判断、Markdown 或全文；不得通过 Web Search 补充三表。覆盖利润质量、现金转换、营运资本、资本效率、治理、资本配置、债务、资本开支、稀释、压力测试和行业专属压力。金融行业不适用的指标必须标记 `not_applicable`，不能填 0。

只输出本域的完整 Markdown 正文，不要 JSON、YAML、代码围栏或元数据包。使用标题覆盖利润质量、现金转换、营运资本、资本效率、治理与资本配置、债务/资本开支/稀释、压力测试和数据缺口。每个数值保留期间、单位、币种、输入字段、结构化来源 URL、`sourceIds`/`evidenceIds` 和质量限制；缺字段、期间、来源健康或单位门禁时写结构化 gap/`unknown`。确定性指标不是模型判断，不能补造。`usedUpstreamArtifactIds` 只引用 S0。

正文应可直接进入第 6–8 章，不要写商业模式、竞争结论或估值。

<input_data>
{{INPUT_DATA}}
</input_data>
