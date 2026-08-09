const text = (value) => typeof value === "string" ? value.trim() : "";

function artifact(stages, key) {
  return stages.find((item) => item.stageKey === key)?.output ?? null;
}

/** Stage Markdown owns citations; do not append a detached bibliography. */
export function assembleOperatingAnalysisReport(input, stages) {
  const statuses = stages.map((item) => `- ${item.label || item.stageKey}：${item.status}`).join("\n");
  return [
    "# 1. 研究范围与事实边界",
    `- 研究截止：${input.asOf}`,
    `- 公司：${input.company.name}（${input.security.securityCode}）`,
    "- 三张报表数值来自系统结构化财务接口；检索事实与分析判断按阶段产物区分。",
    "- 阶段状态：",
    statuses,
    "",
    text(artifact(stages, "operating_analysis")),
    "",
    text(artifact(stages, "financial_analysis")),
    "",
    text(artifact(stages, "valuation_conclusion")),
  ].filter(Boolean).join("\n\n");
}
