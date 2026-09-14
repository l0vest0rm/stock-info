type ReportItem = Record<string, unknown>;

const HIDDEN_REPORT_FIELDS = [
  "url",
  "detailUrl",
  "localUrl",
  "reportUrl",
  "sourceUrl",
  "pdfUrl",
  "infoCode",
  "encodeUrl",
  "reportId",
  "rptid",
  "rptId",
  "contentUrl",
  "contentKey",
  "llmRawResponse",
] as const;

function reportUrl(item: ReportItem): string {
  for (const field of ["localUrl", "url", "detailUrl"] as const) {
    const value = item[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  // Eastmoney mainland reports have a stable public PDF address. The legacy
  // HK/US dataeye lookup has no target URL (and currently returns null), so it
  // remains unopenable instead of exposing its infoCode.
  const infoCode = typeof item.infoCode === "string" ? item.infoCode.trim() : "";
  const code = typeof item.code === "string" ? item.code.trim() : "";
  return infoCode && !code.endsWith(".HK") && !code.endsWith(".US")
    ? `https://pdf.dfcfw.com/pdf/H3_${encodeURIComponent(infoCode)}_1.pdf`
    : "";
}

/**
 * The report list is the access boundary for source addresses. An authenticated
 * list grants a direct link; an anonymous list contains neither a provider
 * address nor an identifier that can reconstruct one.
 */
export function projectCompanyReportItemsForSession(items: ReportItem[], authenticated: boolean): ReportItem[] {
  return items.map((item) => {
    const target = reportUrl(item);
    const projected = { ...item };
    for (const field of HIDDEN_REPORT_FIELDS) delete projected[field];
    if (!target) return projected;
    return authenticated
      ? { ...projected, reportUrl: target }
      : { ...projected, reportLocked: true };
  });
}
