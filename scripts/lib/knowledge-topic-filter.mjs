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

export function topicFilterKeywordDecision(doc, filter) {
  const haystack = String(doc?.title || "").toLowerCase();
  const matchedCore = matchedKeywords(haystack, filter?.coreKeywords);
  const matchedSupport = matchedKeywords(haystack, filter?.supportKeywords);
  const matchedDenyBypass = matchedKeywords(haystack, filter?.denyBypassKeywords);
  const matchedDeny = matchedDenyBypass.length
    ? []
    : matchedKeywords(haystack, filter?.denyKeywords);
  const score = matchedCore.length * 2 + matchedSupport.length - matchedDeny.length * 2;
  const reasons = [
    ...matchedCore.map((item) => `核心:${item}`),
    ...matchedSupport.map((item) => `相关:${item}`),
    ...matchedDenyBypass.map((item) => `优先:${item}`),
    ...matchedDeny.map((item) => `排除:${item}`),
  ];
  return { score, reasons };
}

function matchedKeywords(haystack, keywords) {
  return [...new Set(normalizedValues(keywords).filter((keyword) => haystack.includes(keyword.toLowerCase())))];
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
