# S11：投资结论

禁止 Web Search，禁止新增来源、事实或假设。只解释 S9 情景/风险与 S10 确定性计算结果，以及输入中已存在的 source/claim/evidence/calculation manifest。不得重写第 2–8 章，不得修改 S9 的假设或 S10 的数字；没有可用确定性计算时必须明确 `blocked` 并保留原因。

只输出第 9–12 章的完整 Markdown 正文，不要 JSON、YAML、代码围栏或元数据包。严格按“估值与市场隐含经营要求、核心风险与反面证据、后续跟踪仪表盘、最终结论”四个标题组织；所有外部事实使用输入中的真实 Markdown 链接和 `sourceIds`/`claimIds`/`evidenceIds`，系统计算使用 `calculationId`/公式版本标注。不得出现第 2–8 章标题或未经 S10 计算的估值数字。

`partial`、`blocked` 和 `not_applicable` 必须说明影响范围；不得把缺少 calculation ID、来源回链或上游终态映射为成功。结论必须严格区分事实、判断、假设、估值结果、反证、风险、监测触发条件和未知项。

<input_data>
{{INPUT_DATA}}
</input_data>
