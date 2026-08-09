# S8：经营论题与因果链

禁止 Web Search，禁止新增事实、来源、估值或目标价。只使用输入中的 S0 compact financial trend 与 S1–S5 明确投影；不得读取上游 Markdown 全文，也不得用模型常识填补缺口。

把需求→销量/价格/组合→收入→利润率（必要时延伸到现金/资本）的传导写成可证伪链。每个跨域判断必须有稳定 `judgmentId`，并列出支持/反面证据、替代解释、关键变量和失效条件。缺证据时保留 `unknowns`/`analysisGaps`，不得把推测写成事实。S8 只补跨域判断，不重写 S1–S5 的事实正文。

只输出一个 JSON 对象；`markdown` 只能包含 S8 的经营论题正文，不得包含估值章节或未在结构化字段中回链的事实：

```json
{
  "status": "complete|partial|blocked|not_applicable",
  "markdown": "",
  "causalChain": [{
    "judgmentId": "judgment:...",
    "variablePath": "demand.volume.price.revenue.margin",
    "from": "",
    "to": "",
    "mechanism": "",
    "direction": "positive|negative|mixed|unknown",
    "confidence": "high|medium|low",
    "claimIds": [],
    "sourceIds": [],
    "supportingEvidenceIds": [],
    "counterEvidenceIds": [],
    "alternativeExplanations": [],
    "invalidationConditions": []
  }],
  "sourceIds": [], "claimIds": [], "evidenceIds": [], "unknownIds": [], "analysisGaps": [],
  "usedUpstreamArtifactIds": []
}
```

所有 ID 必须来自输入 manifest 或其显式投影；不得使用数组位置作为身份。若 S1–S5 终态缺失，返回 `blocked` 并列出最小可回流的 `analysisGaps`/事实域；不要用新的 S8 事实掩盖缺口。

<input_data>
{{INPUT_DATA}}
</input_data>
