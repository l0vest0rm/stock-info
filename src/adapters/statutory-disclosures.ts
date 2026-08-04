import { fetchCninfoCompanyNotices } from "./cninfo";
import { bareCode, normalizeSecurityCode, securitySuffix } from "../shared/codes";
import { cachedFetchJson, type ExternalHttpOptions } from "../shared/http";
import type { CompanyNotice } from "../types";

/**
 * An official filing index is deliberately separate from financial-statement
 * loading.  It identifies the immutable source document that a later field
 * extractor may cite; it never supplies a replacement financial data source.
 */
export type StatutoryDisclosureRegistry = "cninfo" | "hkex";

export type StatutoryDisclosureDocument = {
  registry: StatutoryDisclosureRegistry;
  securityCode: string;
  /** Native registry identifier; do not synthesize it from the URL. */
  documentId: string;
  title: string;
  /** Registry release date, expressed in the registry's local market date. */
  publishedAt: string;
  documentUrl: string;
  documentType: string | null;
  /** Reproducible registry locator for an auditor or a later field extractor. */
  sourceLocator: string;
};

export type StatutoryDisclosureFailureCode =
  | "unsupported_security"
  | "invalid_date_range"
  | "issuer_not_found"
  | "upstream_request_failed"
  | "upstream_response_invalid";

export type StatutoryDisclosureIndex = {
  registry: StatutoryDisclosureRegistry | null;
  securityCode: string;
  documents: StatutoryDisclosureDocument[];
  availability: "available" | "not_found" | "unavailable";
  failure: { code: StatutoryDisclosureFailureCode; message: string; retryable: boolean } | null;
};

export type StatutoryDisclosureIndexOptions = {
  /** CNINFO page (1-100); HKEX uses this solely to set `rowRange`. */
  page?: number;
  pageSize?: number;
  /** HKEX only.  A single-code lookup must stay within HKEX's 12-month limit. */
  fromDate?: string;
  toDate?: string;
  httpOptions?: ExternalHttpOptions;
};

type HkexActiveSecurity = { i?: number; c?: string };
type HkexTitleSearchResponse = {
  result?: string;
  recordCnt?: number | string;
};
type HkexTitleSearchRow = {
  NEWS_ID?: string | number;
  TITLE?: string;
  SHORT_TEXT?: string;
  DATE_TIME?: string;
  FILE_LINK?: string;
  FILE_TYPE?: string;
};

const HKEX_ORIGIN = "https://www1.hkexnews.hk";
const HKEX_ACTIVE_SECURITIES_URL = `${HKEX_ORIGIN}/ncms/script/eds/activestock_sehk_e.json`;
const HKEX_INACTIVE_SECURITIES_URL = `${HKEX_ORIGIN}/ncms/script/eds/inactivestock_sehk_e.json`;
const HKEX_TITLE_SEARCH_URL = `${HKEX_ORIGIN}/search/titleSearchServlet.do`;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Selects exactly one statutory registry for the supported A/H universe.
 * It is intentionally not a candidate list, so an unavailable HKEX result
 * cannot silently become a CNINFO result (or vice versa).
 */
export function statutoryRegistryForSecurity(code: string): StatutoryDisclosureRegistry | null {
  const suffix = securitySuffix(normalizeSecurityCode(code));
  if (["SH", "SZ", "BJ"].includes(suffix)) return "cninfo";
  if (suffix === "HK") return "hkex";
  return null;
}

export async function fetchStatutoryDisclosureIndex(
  db: D1Database,
  code: string,
  options: StatutoryDisclosureIndexOptions = {},
): Promise<StatutoryDisclosureIndex> {
  const securityCode = normalizedOrOriginal(code);
  const registry = statutoryRegistryForSecurity(securityCode);
  if (!registry) return unavailable(null, securityCode, "unsupported_security", "Only SH, SZ, BJ, and HK securities have a statutory disclosure index.", false);
  return registry === "cninfo"
    ? fetchCninfoStatutoryDisclosureIndex(db, securityCode, options)
    : fetchHkexStatutoryDisclosureIndex(db, securityCode, options);
}

export async function fetchCninfoStatutoryDisclosureIndex(
  db: D1Database,
  code: string,
  options: Pick<StatutoryDisclosureIndexOptions, "page" | "pageSize"> = {},
): Promise<StatutoryDisclosureIndex> {
  const securityCode = normalizedOrOriginal(code);
  if (statutoryRegistryForSecurity(securityCode) !== "cninfo") {
    return unavailable("cninfo", securityCode, "unsupported_security", "CNINFO statutory filing lookup is restricted to SH, SZ, and BJ securities.", false);
  }
  try {
    const notices = await fetchCninfoCompanyNotices(db, securityCode, options.page, options.pageSize);
    const documents = cninfoNoticesToStatutoryDocuments(securityCode, notices);
    if (notices.length > 0 && documents.length === 0) {
      throw new InvalidStatutoryResponseError("CNINFO returned announcements but none contained an id, release date, title, and PDF URL.");
    }
    return documents.length ? available("cninfo", securityCode, documents) : notFound("cninfo", securityCode);
  } catch (error) {
    return unavailable("cninfo", securityCode, invalidResponse(error) ? "upstream_response_invalid" : "upstream_request_failed", message(error), !invalidResponse(error));
  }
}

export async function fetchHkexStatutoryDisclosureIndex(
  db: D1Database,
  code: string,
  options: Pick<StatutoryDisclosureIndexOptions, "pageSize" | "fromDate" | "toDate" | "httpOptions"> = {},
): Promise<StatutoryDisclosureIndex> {
  const securityCode = normalizedOrOriginal(code);
  if (statutoryRegistryForSecurity(securityCode) !== "hkex") {
    return unavailable("hkex", securityCode, "unsupported_security", "HKEX statutory filing lookup is restricted to HK securities.", false);
  }
  const stockCode = bareCode(securityCode);
  if (!/^\d{5}$/.test(stockCode)) {
    return unavailable("hkex", securityCode, "unsupported_security", "HKEX statutory filing lookup requires a five-digit HK stock code.", false);
  }
  const range = resolveHkexDateRange(options.fromDate, options.toDate);
  if (!range) {
    return unavailable("hkex", securityCode, "invalid_date_range", "HKEX title search requires an inclusive date range of at most 366 days (YYYY-MM-DD).", false);
  }
  const rowRange = boundedInteger(options.pageSize, 100, 1, 1000);
  try {
    const active = await cachedFetchJson(db, HKEX_ACTIVE_SECURITIES_URL, undefined, 7 * DAY_MS, options.httpOptions) as HkexActiveSecurity[];
    if (!Array.isArray(active)) throw new InvalidStatutoryResponseError("HKEX active-security index was not an array.");
    let issuer = active.find((item) => String(item.c ?? "").trim() === stockCode && Number.isInteger(item.i));
    if (!issuer) {
      // This is the same HKEX registry, not a financial-data fallback.  It
      // keeps historical issuer documents addressable after a delisting.
      const inactive = await cachedFetchJson(db, HKEX_INACTIVE_SECURITIES_URL, undefined, 7 * DAY_MS, options.httpOptions) as HkexActiveSecurity[];
      if (!Array.isArray(inactive)) throw new InvalidStatutoryResponseError("HKEX inactive-security index was not an array.");
      issuer = inactive.find((item) => String(item.c ?? "").trim() === stockCode && Number.isInteger(item.i));
    }
    if (!issuer?.i) return unavailable("hkex", securityCode, "issuer_not_found", `HKEX active-security index did not contain ${stockCode}.`, false);
    const url = new URL(HKEX_TITLE_SEARCH_URL);
    for (const [key, value] of Object.entries({
      sortDir: "0", sortByOptions: "DateTime", category: "0", market: "SEHK", stockId: String(issuer.i),
      documentType: "", fromDate: range.from, toDate: range.to, title: "", searchType: "1",
      t1code: "", t2Gcode: "", t2code: "", rowRange: String(rowRange), lang: "E",
    })) url.searchParams.set(key, value);
    const payload = await cachedFetchJson(db, url.toString(), undefined, 30 * 60 * 1000, options.httpOptions) as HkexTitleSearchResponse;
    const rows = parseHkexTitleSearchRows(payload);
    const documents = hkexRowsToStatutoryDocuments(securityCode, rows);
    if (rows.length > 0 && documents.length === 0) {
      throw new InvalidStatutoryResponseError("HKEX title search returned rows but none contained an id, release date, title, and document URL.");
    }
    return documents.length ? available("hkex", securityCode, documents) : notFound("hkex", securityCode);
  } catch (error) {
    return unavailable("hkex", securityCode, invalidResponse(error) ? "upstream_response_invalid" : "upstream_request_failed", message(error), !invalidResponse(error));
  }
}

export function cninfoNoticesToStatutoryDocuments(securityCode: string, notices: CompanyNotice[]): StatutoryDisclosureDocument[] {
  return notices.flatMap((notice) => {
    const documentId = String(notice.artCode ?? "").trim();
    const documentUrl = String(notice.pdfUrl ?? "").trim();
    const title = String(notice.title ?? "").trim();
    const publishedAt = String(notice.noticeDate ?? "").trim();
    if (!documentId || !documentUrl || !title || !publishedAt) return [];
    return [{
      registry: "cninfo", securityCode, documentId, title, publishedAt, documentUrl,
      documentType: String(notice.noticeType ?? "").trim() || null,
      sourceLocator: `CNINFO announcementId=${documentId}`,
    }];
  });
}

export function parseHkexTitleSearchRows(payload: unknown): HkexTitleSearchRow[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new InvalidStatutoryResponseError("HKEX title-search response was not an object.");
  const result = (payload as HkexTitleSearchResponse).result;
  if (typeof result !== "string") throw new InvalidStatutoryResponseError("HKEX title-search response did not contain a string result.");
  let rows: unknown;
  try { rows = JSON.parse(result); } catch { throw new InvalidStatutoryResponseError("HKEX title-search result was not valid JSON."); }
  if (!Array.isArray(rows)) throw new InvalidStatutoryResponseError("HKEX title-search result was not an array.");
  return rows.filter((row): row is HkexTitleSearchRow => Boolean(row && typeof row === "object" && !Array.isArray(row)));
}

export function hkexRowsToStatutoryDocuments(securityCode: string, rows: HkexTitleSearchRow[]): StatutoryDisclosureDocument[] {
  return rows.flatMap((row) => {
    const documentId = String(row.NEWS_ID ?? "").trim();
    const fileLink = String(row.FILE_LINK ?? "").trim();
    const title = stripHtml(String(row.TITLE ?? "")).trim();
    const publishedAt = hkexPublishedDate(String(row.DATE_TIME ?? ""));
    if (!documentId || !fileLink || !title || !publishedAt) return [];
    let documentUrl: string;
    try { documentUrl = new URL(fileLink, `${HKEX_ORIGIN}/`).toString(); } catch { return []; }
    return [{
      registry: "hkex", securityCode, documentId, title, publishedAt, documentUrl,
      documentType: String(row.FILE_TYPE ?? "").trim() || null,
      sourceLocator: `HKEXnews NEWS_ID=${documentId}`,
    }];
  });
}

function resolveHkexDateRange(fromDate?: string, toDate?: string): { from: string; to: string } | null {
  const end = toDate ? parseIsoDate(toDate) : utcDay(new Date());
  if (!end) return null;
  const start = fromDate ? parseIsoDate(fromDate) : addUtcDays(end, -365);
  if (!start || start.getTime() > end.getTime() || (end.getTime() - start.getTime()) / DAY_MS > 366) return null;
  return { from: compactDate(start), to: compactDate(end) };
}

function parseIsoDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}
function utcDay(date: Date): Date { return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())); }
function addUtcDays(date: Date, days: number): Date { return new Date(date.getTime() + days * DAY_MS); }
function compactDate(date: Date): string { return date.toISOString().slice(0, 10).replaceAll("-", ""); }
function hkexPublishedDate(value: string): string {
  const match = value.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+\d{2}:\d{2})?$/);
  if (!match) return "";
  const [, day, month, year] = match;
  const iso = `${year}-${month}-${day}`;
  return parseIsoDate(iso) ? iso : "";
}
function stripHtml(value: string): string { return value.replace(/<[^>]*>/g, "").replace(/&(?:#x2f|#47);/gi, "/").replace(/&amp;/gi, "&").trim(); }
function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  const candidate = value ?? fallback;
  return Number.isFinite(candidate) ? Math.min(max, Math.max(min, Math.trunc(candidate))) : fallback;
}
function normalizedOrOriginal(code: string): string { try { return normalizeSecurityCode(code); } catch { return code.trim().toUpperCase(); } }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
class InvalidStatutoryResponseError extends Error { constructor(message: string) { super(message); this.name = "InvalidStatutoryResponseError"; } }
function invalidResponse(error: unknown): boolean { return error instanceof InvalidStatutoryResponseError; }
function available(registry: StatutoryDisclosureRegistry, securityCode: string, documents: StatutoryDisclosureDocument[]): StatutoryDisclosureIndex { return { registry, securityCode, documents, availability: "available", failure: null }; }
function notFound(registry: StatutoryDisclosureRegistry, securityCode: string): StatutoryDisclosureIndex { return { registry, securityCode, documents: [], availability: "not_found", failure: null }; }
function unavailable(registry: StatutoryDisclosureRegistry | null, securityCode: string, code: StatutoryDisclosureFailureCode, message: string, retryable: boolean): StatutoryDisclosureIndex { return { registry, securityCode, documents: [], availability: "unavailable", failure: { code, message, retryable } }; }
