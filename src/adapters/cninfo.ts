import type { Database } from "../platform/contracts";
import { bareCode, normalizeSecurityCode, securitySuffix } from "../shared/codes";
import { cachedFetchJson, retryOnRejection } from "../shared/http";
import type { CompanyNotice } from "../types";

type CninfoSecurityResponse = {
  code?: string;
  orgId?: string;
};

type CninfoAnnouncementResponse = {
  announcements?: Array<{
    announcementId?: string;
    announcementTitle?: string;
    announcementTime?: number;
    announcementTypeName?: string | null;
    adjunctUrl?: string;
  }> | null;
};

const CNINFO_ORIGIN = "https://www.cninfo.com.cn";
const CNINFO_PDF_ORIGIN = "https://static.cninfo.com.cn";
const CHINA_STANDARD_TIME_OFFSET_MS = 8 * 60 * 60 * 1000;

export function supportsCninfoCompanyNotices(code: string): boolean {
  return ["SH", "SZ", "BJ", "HK"].includes(securitySuffix(normalizeSecurityCode(code)));
}

// CNINFO exposes investor-relations materials through the same disclosure
// endpoint, but under its separate `relation` tab.  The stock-detail page
// only exposes that tab for Shenzhen-listed companies.
export function supportsCninfoCompanyResearch(code: string): boolean {
  return securitySuffix(normalizeSecurityCode(code)) === "SZ";
}

export async function fetchCninfoCompanyNotices(
  db: Database,
  code: string,
  page = 1,
  pageSize = 20,
  category = ""
): Promise<CompanyNotice[]> {
  return fetchCninfoCompanyDisclosure(db, code, page, pageSize, {
    tabName: "fulltext",
    category,
    fallbackNoticeType: "公告",
  });
}

export async function fetchCninfoCompanyResearch(
  db: Database,
  code: string,
  page = 1,
  pageSize = 20
): Promise<CompanyNotice[]> {
  if (!supportsCninfoCompanyResearch(code)) {
    throw new Error(`unsupported CNINFO company research code: ${code}`);
  }
  return fetchCninfoCompanyDisclosure(db, code, page, pageSize, {
    tabName: "relation",
    category: "",
    fallbackNoticeType: "公司调研",
  });
}

/**
 * Periodic financial reports only, via CNINFO's own report categories.
 *
 * Use this instead of filtering `fetchCninfoCompanyNotices`: the announcement
 * feed is ordered by recency, so a company with 3,000 announcements has its
 * half-year report far past any single page, and titles vary ("2026年三季度
 * 报告" carries no 第).  Asking the registry for the category is both correct
 * and cheaper than paging.
 */
export async function fetchCninfoPeriodicReports(
  db: Database,
  code: string,
  pageSize = 30,
): Promise<CompanyNotice[]> {
  const normalized = normalizeSecurityCode(code);
  const suffix = securitySuffix(normalized);
  const categories = (Object.keys(CNINFO_PERIODIC_CATEGORIES) as Array<keyof typeof CNINFO_PERIODIC_CATEGORIES>)
    .map((kind) => cninfoCategoryCode(suffix, kind))
    .filter((value): value is string => Boolean(value));
  if (categories.length === 0) {
    throw new Error(`unsupported CNINFO periodic report code: ${code}`);
  }
  // One query per category: the registry returns each category newest-first, so
  // the first page of each already contains the latest annual/interim/quarterly
  // report without paging through the announcement stream.
  //
  // These run sequentially on purpose.  CNINFO rate-limits this endpoint: firing
  // four category requests at once returns 403 with an empty body, which would be
  // reported as `source_failed` and read as "the company files nothing".
  const pages: CompanyNotice[][] = [];
  for (const category of categories) {
    pages.push(await retryOnRejection(() => fetchCninfoCompanyDisclosure(db, normalized, 1, pageSize, {
      tabName: "fulltext",
      category,
      fallbackNoticeType: "定期报告",
    })));
    // Spacing the category calls keeps them under the interface limit that a
    // four-in-a-row burst trips.
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return pages.flat();
}

async function fetchCninfoCompanyDisclosure(
  db: Database,
  code: string,
  page: number,
  pageSize: number,
  options: { tabName: "fulltext" | "relation"; category: string | readonly string[]; fallbackNoticeType: string }
): Promise<CompanyNotice[]> {
  const normalized = normalizeSecurityCode(code);
  const suffix = securitySuffix(normalized);
  const stockCode = bareCode(normalized);
  const market = cninfoMarket(suffix);
  const validStockCode = suffix === "HK" ? /^\d{5}$/.test(stockCode) : /^\d{6}$/.test(stockCode);
  if (!market || !validStockCode) {
    throw new Error(`unsupported CNINFO company disclosure code: ${code}`);
  }
  if (!Number.isInteger(page) || page < 1 || page > 100) {
    throw new Error(`CNINFO announcement page must be between 1 and 100: ${page}`);
  }
  // CNINFO silently ignores `category` when pageSize exceeds 30: the response
  // falls back to the unfiltered announcement stream.  Keeping the cap is what
  // makes a category query actually filtered.
  const effectivePageSize = Math.min(30, Math.max(1, Math.trunc(pageSize)));
  const security = await fetchCninfoSecurity(db, stockCode);
  const orgId = security.orgId?.trim() ?? "";
  if (!orgId) {
    throw new Error(`CNINFO security organization was not found: ${normalized}`);
  }
  const category: string = Array.isArray(options.category) ? options.category.join(";") : String(options.category);

  const body = new URLSearchParams({
    stock: `${stockCode},${orgId}`,
    tabName: options.tabName,
    pageSize: String(effectivePageSize),
    pageNum: String(page),
    column: market.column,
    category,
    plate: market.plate,
    seDate: "",
    searchkey: "",
    secid: "",
    sortName: "",
    sortType: "",
    isHLtitle: "true",
  });
  const response = (await cachedFetchJson(
    db,
    `${CNINFO_ORIGIN}/new/hisAnnouncement/query`,
    cninfoPostInit(body, `${CNINFO_ORIGIN}/new/disclosure/stock?stockCode=${stockCode}&orgId=${encodeURIComponent(orgId)}`),
    30 * 60 * 1000
  )) as CninfoAnnouncementResponse;

  return (response.announcements ?? []).map((item) => {
    const adjunctUrl = item.adjunctUrl?.trim() ?? "";
    return {
      artCode: item.announcementId?.trim() ?? "",
      title: stripHtml(item.announcementTitle ?? ""),
      noticeDate: cninfoDate(item.announcementTime),
      noticeType: item.announcementTypeName?.trim() || options.fallbackNoticeType,
      pdfUrl: adjunctUrl ? new URL(adjunctUrl, `${CNINFO_PDF_ORIGIN}/`).toString() : "",
    };
  }).filter((item) => item.artCode && item.title);
}

async function fetchCninfoSecurity(
  db: Database,
  stockCode: string
): Promise<CninfoSecurityResponse> {
  const url = new URL(`${CNINFO_ORIGIN}/new/information/topSearch/query`);
  url.searchParams.set("keyWord", stockCode);
  url.searchParams.set("maxNum", "10");
  const items = (await cachedFetchJson(
    db,
    url.toString(),
    { method: "POST" },
    30 * 24 * 60 * 60 * 1000
  )) as CninfoSecurityResponse[];
  return items.find((item) => item.code === stockCode) ?? {};
}

function cninfoPostInit(body: URLSearchParams, referer: string): RequestInit {
  return {
    method: "POST",
    headers: {
      Accept: "application/json, text/javascript, */*; q=0.01",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Origin: CNINFO_ORIGIN,
      Referer: referer,
      "X-Requested-With": "XMLHttpRequest",
    },
    body: body.toString(),
  };
}

function cninfoMarket(suffix: string): { column: string; plate: string } | null {
  if (suffix === "SH") {
    return { column: "sse", plate: "sh" };
  }
  if (suffix === "SZ") {
    return { column: "szse", plate: "sz" };
  }
  if (suffix === "BJ") {
    return { column: "bj", plate: "bj;third" };
  }
  if (suffix === "HK") {
    return { column: "hke", plate: "hk" };
  }
  return null;
}

/**
 * CNINFO's own periodic-report categories.
 *
 * The feed is an announcement stream: at any time its first page is board
 * resolutions and "翌日披露报表", so a periodic report is not on page 1 and
 * filtering titles cannot find it.  The registry already labels these four
 * categories, so the periodic report is queried directly instead of scanned.
 */
const CNINFO_PERIODIC_CATEGORIES = {
  annual: "category_ndbg",
  interim: "category_bndbg",
  q1: "category_yjdbg",
  q3: "category_sjdbg",
} as const;

/** CNINFO suffixes the periodic-report categories with the market, e.g. `_szsh`. */
function cninfoCategoryCode(suffix: string, kind: keyof typeof CNINFO_PERIODIC_CATEGORIES): string | null {
  if (!cninfoMarket(suffix)) return null;
  // CNINFO (not the exchange) names this suffix: both SSE and SZSE filings use
  // `_szsh`, i.e. "Shenzhen/Shanghai".  Guessing `_sh` / `_sz` does not error —
  // it silently returns the unfiltered announcement stream, so a wrong suffix
  // looks like "this company has no periodic reports".
  const categoryMarket = suffix === "HK" ? "hk" : "szsh";
  return `${CNINFO_PERIODIC_CATEGORIES[kind]}_${categoryMarket}`;
}

function cninfoDate(value: number | undefined): string {
  if (!Number.isFinite(value)) {
    return "";
  }
  return new Date(value! + CHINA_STANDARD_TIME_OFFSET_MS).toISOString().slice(0, 10);
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, "").trim();
}
