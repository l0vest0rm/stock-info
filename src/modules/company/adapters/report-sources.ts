import { bareCode, normalizeSecurityCode } from "../../../shared/codes";
import { cachedFetchJson, externalHttpOptions } from "../../../shared/http";
import { type AppEnv } from "../../../types";
import { REPORT_PAGE_SIZE, REPORT_SOURCE_CACHE_TTL_MS, REPORT_FORECAST_CACHE_TTL_MS } from "../domain/report-policy";
import { text } from "../domain/report-values";
import { readAppJson, writeAppJson } from "./report-storage";
import { type SinaCompanyReport } from "../domain/report-types";

export async function fetchEastmoneyCompanyReports(
  env: AppEnv["Bindings"],
  code: string,
  page: number,
  pageSize = REPORT_PAGE_SIZE,
): Promise<Array<Record<string, unknown>>> {
  const normalized = normalizeSecurityCode(code);
  const stockCode = bareCode(normalized);
  if (!stockCode) {
    return [];
  }
  const url = new URL("https://reportapi.eastmoney.com/report/list");
  const params: Record<string, string> = {
    cb: "jQuery",
    industryCode: "*",
    pageSize: String(pageSize),
    industry: "*",
    rating: "*",
    ratingChange: "*",
    beginTime: "2022-01-01",
    endTime: "2040-12-31",
    pageNo: String(page),
    fields: "",
    qType: "0",
    orgCode: "",
    code: stockCode,
    rcode: "",
    _: String(Date.now()),
  };
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const payload = (await cachedFetchJson(
    env.DB,
    url.toString(),
    {
      headers: {
        Referer: "https://data.eastmoney.com/report/",
      },
    },
    6 * 60 * 60 * 1000,
    externalHttpOptions(env)
  )) as {
    data?: Array<Record<string, unknown>>;
  };
  const items = Array.isArray(payload?.data) ? payload.data : [];
  return items.map((item) => mapEastmoneyCompanyReportItem(item, normalized));
}

function mapEastmoneyCompanyReportItem(
  item: Record<string, unknown>,
  normalizedCode: string
): Record<string, unknown> {
  return {
    ...item,
    code: normalizedCode,
    stockCode: text(item.stockCode),
    stockName: text(item.stockName),
    title: text(item.title),
    orgName: text(item.orgName),
    orgSName: text(item.orgSName),
    publishDate: text(item.publishDate),
    infoCode: text(item.infoCode),
    attachPages: text(item.attachPages),
    url: reportPdfUrl(item),
    predictThisYearEps: text(item.predictThisYearEps),
    predictNextYearEps: text(item.predictNextYearEps),
    predictNextTwoYearEps: text(item.predictNextTwoYearEps),
    predictThisYearProfit: text(item.predictThisYearProfit),
    predictNextYearProfit: text(item.predictNextYearProfit),
    predictNextTwoYearProfit: text(item.predictNextTwoYearProfit),
    sRatingName: text(item.sRatingName),
  };
}

export async function fetchSinaCompanyReportsLite(
  env: AppEnv["Bindings"],
  code: string,
  page: number
): Promise<Array<Record<string, unknown>>> {
  const symbol = sinaReportSymbol(code);
  if (!symbol) {
    return [];
  }
  const url = new URL("https://stock.finance.sina.com.cn/stock/go.php/vReport_List/kind/search/index.phtml");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("t1", "all");
  url.searchParams.set("p", String(page));
  const html = await fetchDecodedPageCached(env, `sina-report-list:${symbol}:${page}`, url.toString(), REPORT_SOURCE_CACHE_TTL_MS);
  return parseSinaCompanyReportsList(html).map((report) => ({
    code: normalizeSecurityCode(code),
    title: report.title,
    url: report.url,
    publishDate: normalizeSinaReportDate(report.publishDate),
    orgName: report.orgName,
    orgSName: report.orgName,
    sRatingName: report.rating,
    pages: 0,
  }));
}

export async function loadEastmoneyReportPdfText(env: AppEnv["Bindings"], infoCode: string): Promise<string> {
  const cacheKey = `eastmoney-report-pdf-text:${infoCode}`;
  const cached = await readAppJson<{ text: string }>(env.DB, cacheKey);
  if (cached?.text) {
    return cached.text;
  }
  const response = await fetch(reportPdfUrl({ infoCode }), {
    headers: {
      Referer: "https://data.eastmoney.com/report/",
      "User-Agent": "Mozilla/5.0 (compatible; stock-info-worker/0.1; +https://workers.cloudflare.com/)",
    },
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!response.ok || !new TextDecoder().decode(bytes.slice(0, 5)).startsWith("%PDF")) {
    throw new Error(`Eastmoney report PDF request failed: infoCode=${infoCode} status=${response.status}`);
  }
  const { getDocument, GlobalWorkerOptions } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  GlobalWorkerOptions.workerSrc = "pdfjs-dist/legacy/build/pdf.worker.mjs";
  const pdf = await getDocument({ data: bytes }).promise;
  const pages = await Promise.all(
    Array.from({ length: Math.min(pdf.numPages, 30) }, async (_, index) => {
      const page = await pdf.getPage(index + 1);
      const textContent = await page.getTextContent();
      return textContent.items
        .map((part) => ("str" in part ? part.str : ""))
        .join(" ");
    }),
  );
  const textValue = pages.join("\n").trim();
  if (!textValue) {
    throw new Error(`Eastmoney report PDF has no extractable text: infoCode=${infoCode}`);
  }
  await writeAppJson(env.DB, cacheKey, { text: textValue }, REPORT_FORECAST_CACHE_TTL_MS);
  return textValue;
}

function sinaReportSymbol(code: string): string | null {
  const normalized = normalizeSecurityCode(code);
  if (normalized.endsWith(".SZ")) {
    return `sz${bareCode(normalized).toLowerCase()}`;
  }
  if (normalized.endsWith(".SH")) {
    return `sh${bareCode(normalized).toLowerCase()}`;
  }
  if (normalized.endsWith(".BJ")) {
    return `bj${bareCode(normalized).toLowerCase()}`;
  }
  return null;
}

function parseSinaCompanyReportsList(html: string): SinaCompanyReport[] {
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const anchorRegex = /<a[^>]+href=["']([^"']*vReport_Show[^"']*)["'][^>]*>([\s\S]*?)<\/a>/i;
  const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
  const reports: SinaCompanyReport[] = [];
  const seen = new Set<string>();
  for (const row of html.matchAll(rowRegex)) {
    const fragment = row[1] ?? "";
    const anchor = fragment.match(anchorRegex);
    if (!anchor) {
      continue;
    }
    const url = normalizeSinaUrl(anchor[1] ?? "");
    const anchorHtml = anchor[0] ?? "";
    const anchorTitle = anchorHtml.match(/title=["']([^"']+)["']/i)?.[1] ?? "";
    const title = stripHtml(anchorTitle || anchor[2] || "");
    if (!url || !title || seen.has(url)) {
      continue;
    }
    seen.add(url);
    const cells = [...fragment.matchAll(tdRegex)]
      .map((match) => stripHtml(match[1] ?? ""))
      .filter(Boolean);
    const dateIndex = cells.findIndex(looksLikeSinaDate);
    const orgName = dateIndex >= 0 ? cells[dateIndex + 1] ?? "" : "";
    reports.push({
      title,
      url,
      orgName: orgName && looksLikeSinaOrgName(orgName) ? orgName : firstMatchingField(cells, looksLikeSinaOrgName),
      publishDate: firstMatchingField(cells, looksLikeSinaDate),
      rating: firstMatchingField(cells, looksLikeSinaRating),
    });
  }
  return reports;
}

export function extractSinaReportContent(html: string): string {
  const blockMatch = html.match(/<div[^>]+class=["'][^"']*blk_container[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
  if (blockMatch) {
    const blockText = stripHtml(blockMatch[1] ?? "");
    if (blockText.length > 120) {
      return blockText;
    }
  }
  const patterns = [
    /<div[^>]+id=["']artibody["'][^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]+class=["'][^"']*article[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]+class=["'][^"']*report-content[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]+class=["'][^"']*content[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  ];
  let best = "";
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (!match) {
      continue;
    }
    const textValue = stripHtml(match[1] ?? "");
    if (textValue.length > best.length) {
      best = textValue;
    }
  }
  return best || stripHtml(html);
}

function normalizeSinaUrl(href: string): string | null {
  const trimmed = href.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("//")) {
    return `https:${trimmed}`;
  }
  if (trimmed.startsWith("/")) {
    return `https://stock.finance.sina.com.cn${trimmed}`;
  }
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed;
  }
  return null;
}

function normalizeSinaReportDate(value: string): string {
  const match = value.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (!match) {
    return value.trim();
  }
  return `${match[1]}-${String(Number(match[2])).padStart(2, "0")}-${String(Number(match[3])).padStart(2, "0")} 00:00:00.000`;
}

function firstMatchingField(values: string[], matcher: (value: string) => boolean): string {
  return values.find((value) => matcher(value)) ?? "";
}

function looksLikeSinaDate(value: string): boolean {
  return /\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(value);
}

function looksLikeSinaOrgName(value: string): boolean {
  return Boolean(value)
    && !looksLikeSinaDate(value)
    && ["证券", "投顾", "投资", "资本", "研究", "银行", "国际", "基金"].some((marker) => value.includes(marker));
}

function looksLikeSinaRating(value: string): boolean {
  return ["买入", "增持", "中性", "减持", "卖出", "推荐", "审慎推荐", "强烈推荐"].some((marker) => value.includes(marker));
}

function stripHtml(input: string): string {
  return compressWhitespace(
    input
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;|&#160;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
  );
}

function compressWhitespace(value: string): string {
  return value.split(/\s+/).filter(Boolean).join(" ").trim();
}

export async function fetchDecodedPageCached(
  env: AppEnv["Bindings"],
  cacheKey: string,
  url: string,
  ttlMs: number
): Promise<string> {
  const cached = await readAppJson<{ text: string }>(env.DB, cacheKey);
  if (cached?.text) {
    return cached.text;
  }
  const response = await fetch(url, {
    headers: {
      Referer: "https://finance.sina.com.cn/",
      "User-Agent": "Mozilla/5.0 (compatible; stock-info-worker/0.1; +https://workers.cloudflare.com/)",
    },
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!response.ok) {
    throw new Error(`request failed: status=${response.status} body=${new TextDecoder().decode(bytes).slice(0, 300)}`);
  }
  const charset = inferCharset(response.headers.get("content-type"));
  const textValue = new TextDecoder(charset).decode(bytes);
  await writeAppJson(env.DB, cacheKey, { text: textValue }, ttlMs);
  return textValue;
}

function inferCharset(contentType: string | null): string {
  const match = contentType?.match(/charset=([^;]+)/i);
  const charset = match?.[1]?.trim().toLowerCase() ?? "utf-8";
  return charset === "gbk" || charset === "gb2312" ? "gbk" : "utf-8";
}

function reportPdfUrl(item: Record<string, unknown>): string {
  const infoCode = text(item.infoCode);
  if (!infoCode) {
    return "";
  }
  return `https://pdf.dfcfw.com/pdf/H3_${encodeURIComponent(infoCode)}_1.pdf`;
}
