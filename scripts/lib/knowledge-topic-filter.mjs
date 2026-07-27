function normalizedValues(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
}

export function topicFilterBypassDecision(doc, filter) {
  const sourceType = String(doc?.sourceType || "").trim();
  const reportType = String(doc?.reportType || "").trim();
  const bypassSourceTypes = new Set(normalizedValues(filter?.bypassSourceTypes));
  const bypassReportTypes = new Set(normalizedValues(filter?.bypassReportTypes));
  if (!bypassSourceTypes.has(sourceType) && !bypassReportTypes.has(reportType)) {
    return null;
  }
  return {
    keep: true,
    method: "report_bypass",
    score: 0,
    reasons: ["研报不执行主题过滤"],
  };
}

export function shouldKeepOriginalReportPdf(doc, config) {
  if (String(config?.reportPdfMode || "").trim() !== "original_link") {
    return false;
  }
  const sourceType = String(doc?.sourceType || "").trim();
  const reportType = String(doc?.reportType || "").trim();
  const url = String(doc?.url || "").trim().toLowerCase();
  const isReport = sourceType === "research_report"
    || ["company_report", "industry_report", "research_report"].includes(reportType);
  return isReport && url.includes(".pdf");
}
