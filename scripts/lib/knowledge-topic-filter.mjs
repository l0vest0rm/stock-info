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
  if (filter?.mode === "blacklist") {
    return blacklistDecision(doc, filter);
  }
  const haystack = documentSearchText(doc).toLowerCase();
  const hasStockLink = hasSourceStockLink(doc);
  const matchedCore = matchedKeywords(haystack, filter?.coreKeywords);
  const matchedSupport = matchedKeywords(haystack, filter?.supportKeywords);
  const matchedDenyBypass = matchedKeywords(haystack, filter?.denyBypassKeywords);
  const matchedDeny = matchedDenyBypass.length
    ? []
    : matchedKeywords(haystack, filter?.denyKeywords);
  const score = matchedCore.length * 2 + matchedSupport.length + (hasStockLink ? 2 : 0) - matchedDeny.length * 2;
  const reasons = [
    ...(hasStockLink ? ["股票关联"] : []),
    ...matchedCore.map((item) => `核心:${item}`),
    ...matchedSupport.map((item) => `相关:${item}`),
    ...matchedDenyBypass.map((item) => `优先:${item}`),
    ...matchedDeny.map((item) => `排除:${item}`),
  ];
  return { score, reasons };
}

function blacklistDecision(doc, filter) {
  const haystack = documentSearchText(doc).toLowerCase();
  const title = String(doc?.title || "").toLowerCase();
  const labels = documentLabels(doc).toLowerCase();
  const hasStockLink = hasSourceStockLink(doc);
  const marketMatches = matchedKeywords(haystack, filter?.marketOverrideKeywords);
  if (hasStockLink || marketMatches.length > 0) {
    return {
      score: 0,
      blocked: false,
      reasons: [
        ...(hasStockLink ? ["股票关联"] : []),
        ...marketMatches.map((item) => `市场信号:${item}`),
      ],
    };
  }
  const matchedRules = normalizedRules(filter?.blacklistRules)
    .filter((rule) => matchesBlacklistRule(rule, title, labels));
  return {
    score: matchedRules.length > 0 ? -2 * matchedRules.length : 0,
    blocked: matchedRules.length > 0,
    reasons: matchedRules.map((rule) => `黑名单:${rule.id}`),
  };
}

function normalizedRules(value) {
  return Array.isArray(value)
    ? value.filter((rule) => rule && typeof rule === "object" && String(rule.id || "").trim())
    : [];
}

function matchesBlacklistRule(rule, title, labels) {
  const titleAll = normalizedValues(rule.titleAll);
  const titleAny = normalizedValues(rule.titleAny);
  const labelAll = normalizedValues(rule.labelAll);
  const labelAny = normalizedValues(rule.labelAny);
  const configured = titleAll.length + titleAny.length + labelAll.length + labelAny.length;
  if (configured === 0) return false;
  return titleAll.every((term) => title.includes(term.toLowerCase()))
    && (titleAny.length === 0 || titleAny.some((term) => title.includes(term.toLowerCase())))
    && labelAll.every((term) => labels.includes(term.toLowerCase()))
    && (labelAny.length === 0 || labelAny.some((term) => labels.includes(term.toLowerCase())));
}

function hasSourceStockLink(doc) {
  const metadata = doc?.metadata && typeof doc.metadata === "object" ? doc.metadata : {};
  return [doc?.stockLinks, metadata.stockList, metadata.stockNames, metadata.stockCodes]
    .some((value) => Array.isArray(value) && value.length > 0);
}

function documentSearchText(doc) {
  const metadata = doc?.metadata && typeof doc.metadata === "object" ? doc.metadata : {};
  const subjects = Array.isArray(metadata.subjects)
    ? metadata.subjects.map((subject) => subject?.subject_name || subject?.subjectName || subject?.name || "")
    : [];
  const stockList = Array.isArray(metadata.stockList)
    ? metadata.stockList.map((stock) => stock?.StockName || stock?.stockName || stock?.name || stock?.StockID || stock?.stockId || stock?.code || "")
    : [];
  return [
    doc?.title,
    doc?.summary,
    ...(Array.isArray(doc?.tags) ? doc.tags : []),
    ...(Array.isArray(metadata.stockNames) ? metadata.stockNames : []),
    ...(Array.isArray(metadata.stockCodes) ? metadata.stockCodes : []),
    ...subjects,
    ...stockList,
  ].map((value) => String(value || "").trim()).filter(Boolean).join(" ");
}

function documentLabels(doc) {
  const metadata = doc?.metadata && typeof doc.metadata === "object" ? doc.metadata : {};
  const subjects = Array.isArray(metadata.subjects)
    ? metadata.subjects.map((subject) => subject?.subject_name || subject?.subjectName || subject?.name || "")
    : [];
  return [
    ...(Array.isArray(doc?.tags) ? doc.tags : []),
    ...subjects,
  ].map((value) => String(value || "").trim()).filter(Boolean).join(" ");
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
