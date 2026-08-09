# 阶段一：公司事实基线

只建立截至 `asOf` 的公司事实底稿。你可以检索公司法定披露、交易所/监管公告、公司官网及 IR；不得用媒体、同行或研报替代公司事实，也不得重新搜索或抄录三张报表数值。

严格区分 `[正式披露]`、`[管理层表述]`、`[系统结构化数据]` 与 `[未知项]`。管理层目标不是已实现事实。每一条检索事实必须给出可回链原文 URL、适用期间、主体与限制；没有证据就列为未知项。

输出**唯一 JSON 对象**，不要 Markdown 围栏，字段至少为：`status`（complete|partial|blocked|not_applicable）、`scope`、`businessBoundary`、`industryProfileCandidates`、`systemFinancialDataRef`、`formalDisclosureFacts`、`managementStatements`、`reportingAndAccountingNotes`、`governanceAndCapitalAllocationFacts`、`unknowns`、`sourceIndex`、`usedUpstreamArtifactIds`。事实使用稳定 `evidenceId`，并包含标签、陈述、期间、产品/地区/客户边界、单位/币种、来源标题、URL、发布日期与 limitations。

<input_data>
{{INPUT_DATA}}
</input_data>
