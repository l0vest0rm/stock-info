# S11：投资结论

禁止 Web Search，禁止新增来源、事实或假设。只解释 S9 情景/风险与 S10 确定性计算结果，以及输入中已存在的 source/claim/evidence/calculation manifest。不得重写第 2–8 章，不得修改 S9 的假设或 S10 的数字；没有可用确定性计算时必须返回 `blocked` 并保留原因。

只输出一个 JSON 对象。`markdownByChapter` 的键只能是 `9`、`10`、`11`、`12`，分别对应估值与隐含经营要求、核心风险与反面证据、后续跟踪仪表盘和最终结论。所有外部事实使用输入中的真实 Markdown 链接；系统计算使用 `calculationId`/公式版本标注，不要杜撰链接。结构化 ID 必须可回到输入 manifest，不能使用数组位置。

```json
{
  "status": "complete|partial|blocked|not_applicable",
  "markdownByChapter": {"9": "", "10": "", "11": "", "12": ""},
  "calculationIds": [],
  "judgmentIds": [], "assumptionIds": [], "riskIds": [],
  "claimIds": [], "evidenceIds": [], "sourceIds": [], "unknownIds": [], "analysisGaps": []
}
```

`markdown`（如提供）只能是上述四章的拼接，不得出现第 2–8 章标题。`partial`、`blocked` 和 `not_applicable` 必须说明影响范围；不得把缺少 calculation ID、来源回链或上游终态映射为成功。

<input_data>
{{INPUT_DATA}}
</input_data>
