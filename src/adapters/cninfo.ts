import { bareCode, normalizeSecurityCode, securitySuffix } from "../shared/codes";
import { cachedFetchJson } from "../shared/http";
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

export async function fetchCninfoCompanyNotices(
  db: D1Database,
  code: string,
  page = 1,
  pageSize = 20,
  category = ""
): Promise<CompanyNotice[]> {
  const normalized = normalizeSecurityCode(code);
  const suffix = securitySuffix(normalized);
  const stockCode = bareCode(normalized);
  const market = cninfoMarket(suffix);
  const validStockCode = suffix === "HK" ? /^\d{5}$/.test(stockCode) : /^\d{6}$/.test(stockCode);
  if (!market || !validStockCode) {
    throw new Error(`unsupported CNINFO company notice code: ${code}`);
  }

  if (!Number.isInteger(page) || page < 1 || page > 100) {
    throw new Error(`CNINFO announcement page must be between 1 and 100: ${page}`);
  }
  const effectivePageSize = Math.min(30, Math.max(1, Math.trunc(pageSize)));
  const security = await fetchCninfoSecurity(db, stockCode);
  const orgId = security.orgId?.trim() ?? "";
  if (!orgId) {
    throw new Error(`CNINFO security organization was not found: ${normalized}`);
  }

  const body = new URLSearchParams({
    stock: `${stockCode},${orgId}`,
    tabName: "fulltext",
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
      noticeType: item.announcementTypeName?.trim() || "公告",
      pdfUrl: adjunctUrl ? new URL(adjunctUrl, `${CNINFO_PDF_ORIGIN}/`).toString() : "",
    };
  }).filter((item) => item.artCode && item.title);
}

async function fetchCninfoSecurity(
  db: D1Database,
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

function cninfoDate(value: number | undefined): string {
  if (!Number.isFinite(value)) {
    return "";
  }
  return new Date(value! + CHINA_STANDARD_TIME_OFFSET_MS).toISOString().slice(0, 10);
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, "").trim();
}
