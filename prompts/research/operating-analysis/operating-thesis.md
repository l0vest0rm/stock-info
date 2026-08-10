# S8：经营论题与因果链

禁止 Web Search，禁止新增事实、来源、估值或目标价。只使用输入中的 S0 compact financial trend 与 S1–S5 的明确 manifest/projection；不得读取或重写上游完整 Markdown，也不得用模型常识填补缺口。

把需求→销量/价格/组合→收入→利润率（必要时延伸到现金/资本）的传导写成可证伪链。每个跨域判断都写明稳定 `judgmentId`、支持/反面证据、替代解释、关键变量和失效条件。缺证据时保留 `unknown`/`analysis gap`，不得把推测写成事实。S8 只补跨域判断，不重写 S1–S5 的事实正文。

只输出 S8 的完整 Markdown 正文，不要 JSON、YAML、代码围栏或元数据包。使用标题覆盖核心因果链、支持与冲突、关键变量、替代解释、失效条件和最小可回流缺口；正文只允许进入第 2–5 章，不得出现估值章节。正文中的 `sourceIds`、`claimIds`、`evidenceIds`、`unknownIds` 和 judgment IDs 必须来自输入 manifest 或其显式 projection，不得使用数组位置。若 S1–S5 终态缺失，清楚写 `blocked`、影响范围和最小 `analysis gap`，不要用新的 S8 事实掩盖缺口。

<input_data>
{{INPUT_DATA}}
</input_data>
