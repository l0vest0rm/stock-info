import { normalizeSecurityCode } from "../../../shared/codes";
import { REPORT_DISCOVERY_REASONING_EFFORT, REPORT_RECENT_DAYS } from "./report-policy";
import {
  text,
  asRecord,
  positiveNumberOrUndefined,
  parseJsonArrayFromText,
  nonEmptyTextOrUndefined,
  normalizeCompanyReportDate,
  trimText,
} from "./report-values";
import {
  type CompanyReportDiscoveryWebSearchMetadata,
  type CompanyReportDiscoveryCandidate,
  type CompanyReportValuation,
} from "./report-types";
import { canonicalCompanyReportUrl } from "./report-identity";
import { parseCompanyReportForecastRows, parseCompanyReportTargetPrice } from "./report-analysis";

export function normalizeCompanyReportDiscoveryReasoningEffort(value: unknown): string {
  if (value === undefined) {
    return REPORT_DISCOVERY_REASONING_EFFORT;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("company report discovery reasoningEffort must be a non-empty string");
  }
  // The request is intentionally not restricted to a hard-coded enum. Keep
  // the selected provider value (apart from surrounding transport whitespace)
  // so diagnostics can exercise provider-supported efforts such as `none`.
  return value.trim();
}

export function companyReportDiscoveryTaskName(securityCode: string): string {
  return `company:report-discovery:${normalizeSecurityCode(securityCode)}`;
}

export function validateCompanyReportDiscoveryTerminalEvidence(evidence: Record<string, unknown> | null): void {
  if (
    text(evidence?.schemaVersion) !== "webqa.completion-evidence.v1"
    || text(evidence?.outcome) !== "succeeded"
  ) {
    throw new Error("company report discovery taskd result lacks terminal WebQA completion evidence");
  }
}

export function companyReportDiscoveryWebQaSearch(citations: unknown[], sources: unknown[]): CompanyReportDiscoveryWebSearchMetadata {
  const records = [...citations, ...sources];
  const normalizedCitations = records.flatMap((item) => {
    const record = asRecord(item);
    const url = text(record?.url);
    return url ? [{ title: text(record?.title) || url, url }] : [];
  });
  return { searched: true, queries: [], citations: normalizedCitations, responseCompleted: true, responseStatus: "completed", webSearchCallCompleted: true, transport: "webqa" };
}

export function mapCompanyReportDiscoveryCandidate(
  candidate: CompanyReportDiscoveryCandidate,
  securityCode: string,
): Record<string, unknown> {
  const targetPrice = positiveNumberOrUndefined(candidate.targetPrice)
    ?? positiveNumberOrUndefined(candidate.valuation?.targetPrice);
  return {
    code: normalizeSecurityCode(securityCode),
    title: candidate.title,
    pages: 0,
    forecasts: candidate.forecasts,
    ...(targetPrice !== undefined ? { targetPrice } : {}),
    ...(candidate.institution ? { orgName: candidate.institution, orgSName: candidate.institution } : {}),
    ...(candidate.publishedAt ? { publishDate: candidate.publishedAt } : {}),
    ...(candidate.url ? { url: candidate.url } : {}),
    ...(candidate.valuation && Object.keys(candidate.valuation).length > 0 ? { valuation: candidate.valuation } : {}),
    provenance: "web_search",
  };
}

export function parseCompanyReportDiscovery(
  textBody: string,
  securityCode: string,
  citations: Array<{ title: string; url: string }>,
): CompanyReportDiscoveryCandidate[] {
  return parseCompanyReportDiscoveryWithDiagnostics(textBody, securityCode, citations).reports;
}

export function parseCompanyReportDiscoveryWithDiagnostics(
  textBody: string,
  _securityCode: string,
  citations: Array<{ title: string; url: string }>,
): { reports: CompanyReportDiscoveryCandidate[]; rejected: number } {
  const reports = parseJsonArrayFromText(textBody);
  if (!reports) {
    throw new Error("company report discovery response was not a JSON array");
  }
  const cited = new Set(compactCompanyReportCitations(citations).map((item) => canonicalCompanyReportUrl(item.url)).filter(Boolean));
  const hasCitationMetadata = cited.size > 0;
  let rejected = 0;
  const accepted = reports.flatMap((value): CompanyReportDiscoveryCandidate[] => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      rejected += 1;
      return [];
    }
    const row = value as Record<string, unknown>;
    const rawTitle = nonEmptyTextOrUndefined(row.title);
    const institution = nonEmptyTextOrUndefined(row.institution);
    const publishedAt = normalizeCompanyReportDate(text(row.publishedAt)) || undefined;
    const url = canonicalCompanyReportDiscoveryUrl(row.url);
    // A partial search hit is still useful when it has either a title or a
    // valid source URL.  If only the URL is present, derive a deterministic
    // display title from that URL without guessing the report identity.
    const title = rawTitle || (url ? companyReportDiscoveryTitleFromUrl(url) : undefined);
    if (!title || (hasCitationMetadata && url && !cited.has(url))) {
      rejected += 1;
      return [];
    }
    const forecasts = Array.isArray(row.forecasts) ? parseCompanyReportForecastRows(row.forecasts) : [];
    const legacyValuation = row.valuation && typeof row.valuation === "object" && !Array.isArray(row.valuation)
      ? parseCompanyReportValuation(row.valuation as Record<string, unknown>)
      : {};
    const targetPrice = parseCompanyReportTargetPrice(row.targetPrice);
    const valuation = row.valuation && typeof row.valuation === "object" && !Array.isArray(row.valuation)
      ? parseCompanyReportValuation(row.valuation as Record<string, unknown>)
      : {};
    return [{
      title,
      ...(institution ? { institution } : {}),
      ...(publishedAt ? { publishedAt } : {}),
      ...(url ? { url } : {}),
      forecasts,
      ...((targetPrice !== null || legacyValuation.targetPrice !== undefined)
        ? { targetPrice: targetPrice ?? legacyValuation.targetPrice ?? null }
        : {}),
      ...(Object.keys(valuation).length > 0 ? { valuation } : {}),
    }];
  });
  return { reports: accepted, rejected };
}

/** The structured field expects a URL, but ChatGPT Web can render it as a Markdown link. */
function canonicalCompanyReportDiscoveryUrl(value: unknown): string | undefined {
  const raw = text(value);
  const markdownUrl = raw.match(/^\[[^\]]*\]\((https?:\/\/[^\s)]+)\)$/i)?.[1];
  return canonicalCompanyReportUrl(markdownUrl || raw) || undefined;
}

function parseCompanyReportValuation(value: Record<string, unknown>): CompanyReportValuation {
  return {
    ...(nonEmptyTextOrUndefined(value.rating) ? { rating: nonEmptyTextOrUndefined(value.rating) } : {}),
    ...(positiveNumberOrUndefined(value.targetPrice) !== undefined ? { targetPrice: positiveNumberOrUndefined(value.targetPrice) } : {}),
    ...(nonEmptyTextOrUndefined(value.targetPriceCurrency) ? { targetPriceCurrency: nonEmptyTextOrUndefined(value.targetPriceCurrency) } : {}),
    ...(positiveNumberOrUndefined(value.targetPe) !== undefined ? { targetPe: positiveNumberOrUndefined(value.targetPe) } : {}),
    ...(nonEmptyTextOrUndefined(value.valuationMethod) ? { valuationMethod: nonEmptyTextOrUndefined(value.valuationMethod) } : {}),
  };
}

function compactCompanyReportCitations(
  citations: Array<{ title: string; url: string }>,
): Array<{ title: string; url: string }> {
  const seen = new Set<string>();
  return citations.flatMap((citation) => {
    const url = canonicalCompanyReportUrl(text(citation?.url));
    if (!url || seen.has(url)) return [];
    seen.add(url);
    return [{ title: text(citation?.title) || url, url }];
  });
}

export function validateCompanyReportDiscoveryWebSearch(
  webSearch: CompanyReportDiscoveryWebSearchMetadata | undefined,
): Array<{ title: string; url: string }> {
  if (!webSearch?.searched) {
    throw new Error("company report discovery Web Search did not run");
  }
  if (webSearch.responseCompleted !== true || webSearch.responseStatus !== "completed") {
    throw new Error("company report discovery Web Search response was incomplete");
  }
  if (webSearch.webSearchCallCompleted !== true) {
    throw new Error("company report discovery Web Search call did not complete");
  }
  // Some provider responses expose no URL-citation annotations even though the
  // completed tool call returned report URLs in the model output.  Keep any
  // metadata citations for stricter candidate matching when present, but do
  // not make their availability a terminal success condition.
  return compactCompanyReportCitations(webSearch.citations || []);
}

export function renderCompanyReportDiscoveryPrompt(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((result, [key, value]) => result.replaceAll(`{{${key}}}`, value), template);
}

export function reportDiscoveryRecentSince(now = Date.now()): string {
  return new Date(now - REPORT_RECENT_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function companyReportDiscoveryTitleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/+|\/+$/g, "");
    const title = `${parsed.hostname}${path ? `/${path}` : ""}`
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim();
    return trimText(title || url, 240);
  } catch {
    return trimText(url, 240);
  }
}
