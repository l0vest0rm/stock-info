import { createHash } from "node:crypto";

const text = (value) => typeof value === "string" ? value.trim() : "";

function artifact(stages, key) {
  return stages.find((item) => item.stageKey === key)?.output ?? null;
}

export const LOW_DEPENDENCY_REPORT_SCHEMA_VERSION = "research-operating-analysis-report.v1";
export const LOW_DEPENDENCY_REPORT_HEADINGS = Object.freeze([
  "# 1. 研究范围与事实边界",
  "# 2. 公司概况与商业模式",
  "# 3. 行业与产业链",
  "# 4. 公司竞争地位",
  "# 5. 增长、驱动与可持续性",
  "# 6. 利润质量、现金转换与营运资本",
  "# 7. 资本效率、管理层治理与资本配置",
  "# 8. 资产负债表与压力测试",
  "# 9. 估值与市场隐含经营要求",
  "# 10. 核心风险与反面证据",
  "# 11. 后续跟踪仪表盘",
  "# 12. 最终结论",
]);

const LOW_DEPENDENCY_REPORT_OWNERS = Object.freeze({
  "1": ["research_context"],
  "2": ["company_facts", "company_operating_drivers", "operating_thesis"],
  "3": ["industry_structure", "supply_demand_cycle", "operating_thesis"],
  "4": ["competition_peers", "operating_thesis"],
  "5": ["company_operating_drivers", "supply_demand_cycle", "operating_thesis"],
  "6": ["financial_quality"],
  "7": ["financial_quality"],
  "8": ["financial_quality", "supply_demand_cycle"],
  "9": ["market_valuation_facts", "scenario_valuation", "deterministic_valuation", "investment_conclusion"],
  "10": ["scenario_valuation", "investment_conclusion"],
  "11": ["supply_demand_cycle", "scenario_valuation", "deterministic_valuation", "investment_conclusion"],
  "12": ["investment_conclusion"],
});

/**
 * Deterministically concatenate the already-owned Markdown fields from S0-S11.
 * This function never calls a model, summarizes JSON, or accepts S11 text for
 * chapters 1-8. A blocked/failed dependency returns a non-success result with
 * an explicit visible gate message; callers must persist it as such.
 */
export function assembleLowDependencyOperatingAnalysisReport({ context = {}, stages = [], runId = null } = {}) {
  const byKey = new Map((Array.isArray(stages) ? stages : []).map((stage) => [stage.stageKey, stage]));
  const blockers = [];
  const requiredKeys = [...new Set(Object.values(LOW_DEPENDENCY_REPORT_OWNERS).flat())];
  for (const key of requiredKeys) {
    const stage = byKey.get(key);
    if (!stage) blockers.push({ code: "required_stage_missing", stageKey: key });
    else if (["blocked", "failed"].includes(String(stage.status))) blockers.push({ code: "required_stage_blocked", stageKey: key, status: stage.status, reason: stage.lastError || stage.blocked || null });
    else if (!["complete", "partial", "not_applicable"].includes(String(stage.status))) blockers.push({ code: "required_stage_not_terminal", stageKey: key, status: stage.status });
  }
  for (const [chapter, owners] of Object.entries(LOW_DEPENDENCY_REPORT_OWNERS)) {
    for (const owner of owners) {
      const stage = byKey.get(owner);
      const requiresMarkdown = ["company_facts", "industry_structure", "supply_demand_cycle", "competition_peers", "company_operating_drivers", "financial_quality", "market_valuation_facts", "operating_thesis", "investment_conclusion"].includes(owner);
      if (requiresMarkdown && stage && ["complete", "partial"].includes(String(stage.status)) && !markdownFromStage(stage, chapter)) blockers.push({ code: "chapter_owner_output_missing", chapter, stageKey: owner });
    }
  }
  const reportManifest = buildReportManifest(context, byKey, runId);
  const status = blockers.length ? "blocked" : requiredKeys.some((key) => byKey.get(key)?.status === "partial") ? "partial" : "complete";
  const sections = [];
  const contextValue = object(context);
  sections.push([LOW_DEPENDENCY_REPORT_HEADINGS[0], renderContextSection(contextValue, reportManifest), renderStatusLines(stages)].filter(Boolean).join("\n\n"));
  for (let chapter = 2; chapter <= 12; chapter += 1) {
    const key = String(chapter);
    const body = LOW_DEPENDENCY_REPORT_OWNERS[key].flatMap((stageKey) => {
      if (stageKey === "investment_conclusion" && chapter < 9) return [];
      return markdownFromStage(byKey.get(stageKey), key);
    }).filter(Boolean).join("\n\n");
    sections.push([LOW_DEPENDENCY_REPORT_HEADINGS[chapter - 1], body || "（该章节暂无可用终态正文。）"].join("\n\n"));
  }
  if (status !== "complete") {
    const gateDetail = blockers.length
      ? `以下阶段未通过完成门禁，不能将本报告视为成功：\n> ${blockers.map((item) => `${item.stageKey}（${item.code}）`).join("、")}`
      : "存在部分完成阶段，不能将本报告视为成功。";
    sections.push(`\n> 报告状态：${status}。${gateDetail}`);
  }
  const markdown = sections.join("\n\n");
  return {
    schemaVersion: LOW_DEPENDENCY_REPORT_SCHEMA_VERSION,
    status,
    markdown,
    blockers,
    manifest: reportManifest,
    projectionFingerprint: createHash("sha256").update(JSON.stringify({ schemaVersion: LOW_DEPENDENCY_REPORT_SCHEMA_VERSION, runId, status, markdown, manifest: reportManifest })).digest("hex"),
  };
}

export function lowDependencyReportOwnerMap() {
  return Object.fromEntries(Object.entries(LOW_DEPENDENCY_REPORT_OWNERS).map(([chapter, owners]) => [chapter, [...owners]]));
}

function markdownFromStage(stage, chapter) {
  const output = stage?.output;
  if (typeof output === "string") return output.trim();
  if (!output || typeof output !== "object" || Array.isArray(output)) return "";
  if (output.markdownByChapter && typeof output.markdownByChapter === "object" && typeof output.markdownByChapter[chapter] === "string") return output.markdownByChapter[chapter].trim();
  if (typeof output.markdown === "string") return output.markdown.trim();
  return "";
}

function renderContextSection(context, manifest) {
  const company = object(context.company); const security = object(context.security); const boundary = object(context.reportingBoundary);
  return [`- 研究对象：${text(company.name) || "未确认公司"}（${text(security.securityCode) || "未确认证券"}）`, `- 截止时间：${text(context.asOf) || "未记录"}`, `- 最新法定期间：${text(boundary.latestFiledPeriod) || "未记录"}`, `- 来源/证据/判断：${manifest.sourceIds.length}/${manifest.evidenceIds.length}/${manifest.claimIds.length}`, `- 报告只拼接已持久化的阶段终态；未通过门禁的阶段保留为缺口。`].join("\n");
}

function renderStatusLines(stages) {
  return (Array.isArray(stages) ? stages : []).map((stage) => `- ${stage.label || stage.stageKey}：${stage.status || "queued"}`).join("\n");
}

function buildReportManifest(context, byKey, runId) {
  const result = {
    schemaVersion: "research-evidence-manifest.v1",
    runId: runId || null,
    contextVersion: text(context.contextVersion) || null,
    artifactIds: [],
    sourceIds: [],
    claimIds: [],
    evidenceIds: [],
    unknownIds: [],
    calculationIds: [],
    statuses: {},
    sourceRegistryId: text(context.sourceRegistryId) || null,
    knownSourceIds: Array.isArray(context.knownSourceIds) ? context.knownSourceIds.filter((id) => typeof id === "string" && id.trim()) : [],
    chapterOwners: lowDependencyReportOwnerMap(),
    chapterArtifactIds: Object.fromEntries(Object.keys(LOW_DEPENDENCY_REPORT_OWNERS).map((chapter) => [chapter, []])),
  };
  for (const stage of byKey.values()) {
    if (stage?.artifactId) result.artifactIds.push(stage.artifactId);
    for (const field of ["sourceIds", "claimIds", "evidenceIds", "unknownIds", "calculationIds"]) {
      const values = field === "calculationIds" ? calculationIdsFromStage(stage) : stage?.[field];
      if (Array.isArray(values)) result[field].push(...values.filter((id) => typeof id === "string" && id.trim()));
    }
    if (stage?.stageKey) result.statuses[stage.stageKey] = stage.status || null;
  }
  result.sourceIds.push(...result.knownSourceIds);
  for (const [chapter, owners] of Object.entries(LOW_DEPENDENCY_REPORT_OWNERS)) {
    result.chapterArtifactIds[chapter] = owners.flatMap((owner) => {
      const stage = byKey.get(owner);
      return stage?.artifactId ? [stage.artifactId] : [];
    }).sort();
  }
  result.knownSourceIds = [...new Set(result.knownSourceIds)].sort();
  for (const field of ["artifactIds", "sourceIds", "claimIds", "evidenceIds", "unknownIds", "calculationIds"]) result[field] = [...new Set(result[field])].sort();
  return result;
}

function calculationIdsFromStage(stage) {
  const trace = stage?.output && typeof stage.output === "object" && !Array.isArray(stage.output) ? stage.output.calculationTrace : null;
  return Array.isArray(trace) ? trace.map((item) => item && typeof item === "object" ? item.calculationId : null) : [];
}

function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }

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
