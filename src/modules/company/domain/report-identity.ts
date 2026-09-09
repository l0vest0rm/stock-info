import { normalizeSecurityCode } from "../../../shared/codes";
import {
  asRecord,
  parseJsonArrayFromText,
  text,
  isRecord,
  firstNonEmpty,
  normalizeCompanyReportDate,
} from "./report-values";
import { type CompanyReportForecast } from "./report-types";

/**
 * Keep the exact report object returned by the latest discovery taskd result.
 */
export function findCompanyReportDiscoveryRawReport(
  artifactOutput: unknown,
  item: Record<string, unknown>,
): Record<string, unknown> | null {
  const output = asRecord(artifactOutput);
  const response = asRecord(output?.response);
  const reports = parseJsonArrayFromText(text(response?.text));
  if (!Array.isArray(reports)) {
    return null;
  }
  return reports.find((candidate) => (
    isRecord(candidate) && companyReportRawIdentityMatches(candidate, item)
  )) as Record<string, unknown> | undefined || null;
}

function companyReportRawIdentityMatches(
  candidate: Record<string, unknown>,
  item: Record<string, unknown>,
): boolean {
  const candidateUrls = companyReportRawUrls(candidate);
  const itemUrls = companyReportRawUrls(item);
  if (candidateUrls.length > 0 && itemUrls.length > 0 && candidateUrls.some((url) => itemUrls.includes(url))) {
    return true;
  }
  const candidateIds = companyReportRawIds(candidate);
  const itemIds = companyReportRawIds(item);
  return candidateIds.length > 0 && itemIds.some((id) => candidateIds.includes(id));
}

function companyReportRawUrls(value: Record<string, unknown>): string[] {
  return ["url", "detailUrl", "sourceUrl", "reportUrl"].flatMap((key) => {
    const url = canonicalCompanyReportUrl(text(value[key]));
    return url ? [url] : [];
  });
}

function companyReportRawIds(value: Record<string, unknown>): string[] {
  const values = ["infoCode", "reportId", "rptid", "rptId", "id"].map((key) => text(value[key])).filter(Boolean);
  const urls = companyReportRawUrls(value);
  const ids = new Set<string>();
  for (const raw of [...values, ...urls]) {
    const infoCode = raw.match(/AP\d{12,}/i)?.[0];
    if (infoCode) ids.add(infoCode.toUpperCase());
    const rptid = raw.match(/(?:rptid|reportid)[\/_-]?([A-Za-z0-9_-]+)/i)?.[1];
    if (rptid) ids.add(rptid.toLowerCase());
    if (/^\d{8,}$/.test(raw)) ids.add(raw);
  }
  return [...ids];
}

export function mergeCompanyReportsPreferPrimary(
  primary: Array<Record<string, unknown>>,
  supplements: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  const merged: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const item of [...primary, ...supplements]) {
    const normalized = normalizeCompanyReportProvenance(item);
    const dedupKeys = companyReportDedupKeys(normalized);
    if (!dedupKeys.length) {
      // Do not invent an identity from a partial hit missing URL, date, and
      // institution. Keep it as an independent row instead of silently
      // dropping it; keyed rows continue to use the deterministic merge path.
      if (text(normalized.provenance) === "web_search") {
        merged.push(normalized);
      }
      continue;
    }
    const priorIndex = merged.findIndex((candidate) => {
      const candidateKeys = new Set(companyReportDedupKeys(candidate));
      return dedupKeys.some((key) => candidateKeys.has(key));
    });
    if (priorIndex >= 0) {
      merged[priorIndex] = mergePrimaryReportWithSupplement(merged[priorIndex], normalized);
      continue;
    }
    if (dedupKeys.some((key) => seen.has(key))) continue;
    dedupKeys.forEach((key) => seen.add(key));
    merged.push(normalized);
  }
  merged.sort((left, right) => companyReportSortTime(right) - companyReportSortTime(left));
  return merged;
}

export function companyReportSortTime(item: Record<string, unknown>): number {
  const parsed = Date.parse(text(item.publishDate).slice(0, 10));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function companyReportDedupKey(item: Record<string, unknown>): string {
  return companyReportDedupKeys(item)[0] || "";
}

export function companyReportDedupKeys(item: Record<string, unknown>): string[] {
  const keys: string[] = [];
  const url = canonicalCompanyReportUrl(firstNonEmpty([text(item.url), text(item.detailUrl)]));
  if (url) keys.push(`url:${url}`);
  const nativeId = companyReportNativeId(item);
  if (nativeId) keys.push(`native:${nativeId}`);
  const code = normalizeSecurityCode(text(item.code));
  const title = normalizeReportTitleCore(text(item.title));
  const org = normalizeReportOrgName(firstNonEmpty([text(item.orgSName), text(item.orgName), text(item.org), text(item.institution)]));
  if (!code || !title || !org) return keys;
  const date = normalizeCompanyReportDate(firstNonEmpty([text(item.publishDate), text(item.publishedAt)]));
  keys.push(date
    ? `identity:${code}|date:${date}|title:${title}|org:${org}`
    : `identity-no-date:${code}|title:${title}|org:${org}`);
  return keys;
}

function companyReportNativeId(item: Record<string, unknown>): string {
  const infoCode = text(item.infoCode);
  if (infoCode) return `eastmoney:${infoCode.toLowerCase()}`;
  const docId = text(item.knowledgeDocId) || text(item.doc_id);
  if (docId) return `knowledge:${docId}`;
  return "";
}

export function canonicalCompanyReportUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    if (!/^https?:$/.test(url.protocol)) return "";
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_|spm|from|source|ref|referrer|share|clickid|sessionid)/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

export function companyReportId(item: Record<string, unknown>): string {
  const infoCode = text(item.infoCode);
  if (infoCode) {
    return `eastmoney:${infoCode}`;
  }
  const url = text(item.url);
  if (url) {
    return `sina:${url}`;
  }
  const title = text(item.title);
  if (!title) {
    return "";
  }
  return `${normalizeSecurityCode(text(item.code))}|${text(item.publishDate).slice(0, 10)}|${title}`;
}

export function isCnCode(code: string): boolean {
  return [".SZ", ".SH", ".BJ"].some((suffix) => code.endsWith(suffix));
}

function normalizeDedupText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[ \t\n\r　:："'"]/g, "")
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .replace(/[－—–]/g, "-");
}

export function normalizeReportTitleCore(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const colonIndex = Math.max(trimmed.indexOf("："), trimmed.indexOf(":"));
  const prefix = colonIndex >= 0 ? trimmed.slice(0, colonIndex) : "";
  const hasCompanyPrefix = /^[\u4e00-\u9fa5A-Za-z0-9]+(?:\(\d{6}(?:\.[A-Z]{2})?\))\s*$/.test(prefix);
  let afterColon = hasCompanyPrefix ? trimmed.slice(colonIndex + 1) : trimmed;
  if (!hasCompanyPrefix) {
    afterColon = afterColon.replace(/^[\u4e00-\u9fa5A-Za-z0-9]+(?:\(\d{6}(?:\.[A-Z]{2})?\))\s*[：:]?/, "");
  }
  return normalizeDedupText(
    afterColon
      .replace(/[，,、。！？!?\-]/g, "")
  );
}

function normalizeReportOrgName(value: string): string {
  return normalizeDedupText(
    value
      .replace(/[（(]香港[）)]/g, "")
      .replace(/(股份)?有限责任公司|股份有限公司|有限公司/g, "")
  );
}

export function mergeForecastRows(
  preferred: CompanyReportForecast[],
  fallback: CompanyReportForecast[]
): CompanyReportForecast[] {
  const merged = new Map<number, CompanyReportForecast>();
  for (const item of fallback) {
    merged.set(item.year, { ...item });
  }
  for (const item of preferred) {
    merged.set(item.year, {
      ...(merged.get(item.year) ?? { year: item.year }),
      ...item,
    });
  }
  return [...merged.values()].sort((left, right) => left.year - right.year);
}

function mergePrimaryReportWithSupplement(
  primary: Record<string, unknown>,
  supplement: Record<string, unknown>
): Record<string, unknown> {
  const primaryForecasts = Array.isArray(primary.forecasts) ? primary.forecasts as CompanyReportForecast[] : [];
  const supplementForecasts = Array.isArray(supplement.forecasts) ? supplement.forecasts as CompanyReportForecast[] : [];
  const primaryValuation = primary.valuation && typeof primary.valuation === "object" && !Array.isArray(primary.valuation)
    ? primary.valuation as Record<string, unknown>
    : {};
  const supplementValuation = supplement.valuation && typeof supplement.valuation === "object" && !Array.isArray(supplement.valuation)
    ? supplement.valuation as Record<string, unknown>
    : {};
  return {
    ...supplement,
    ...primary,
    ...(text(supplement.url) ? { detailUrl: text(supplement.url) } : {}),
    ...(primaryForecasts.length || supplementForecasts.length
      ? { forecasts: mergeForecastRows(primaryForecasts, supplementForecasts) }
      : {}),
    ...(Object.keys(primaryValuation).length || Object.keys(supplementValuation).length
      ? { valuation: { ...supplementValuation, ...primaryValuation } }
      : {}),
    provenance: text(primary.provenance) === "web_search" && text(supplement.provenance) !== "web_search"
      ? "existing"
      : (text(primary.provenance) || text(supplement.provenance) || "existing"),
  };
}

export function normalizeCompanyReportProvenance(item: Record<string, unknown>): Record<string, unknown> {
  return {
    ...item,
    provenance: text(item.provenance) === "web_search" ? "web_search" : "existing",
  };
}
