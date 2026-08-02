import { Context, Hono } from "hono";
import { getAppKv, putAppKv } from "../../../db/queries";
import { fetchEastmoneyCompanyNotices, fetchEastmoneyCompanyOverview } from "../../../adapters/eastmoney";
import { fetchCninfoCompanyNotices, supportsCninfoCompanyNotices } from "../../../adapters/cninfo";
import { loadKline } from "../../market/application/load-kline";
import { getSecurity } from "../../security/application/search-securities";
import { bareCode, inferSecurityType, normalizeSecurityCode, securityMarket } from "../../../shared/codes";
import { cachedFetchJson, externalHttpOptions, fail, ok, requireQuery } from "../../../shared/http";
import { requestLlmText, type SupportedLlmModel } from "../../../shared/llm-client";
import {
  NEWS_REPORT_ANALYZE_SYSTEM_PROMPT,
  NEWS_REPORT_ANALYZE_USER_PROMPT,
  REPORT_ANALYZE_SYSTEM_PROMPT,
  REPORT_ANALYZE_USER_PROMPT,
} from "../../../generated/prompt-text";
import type { AppEnv, CompanyOverview, KlineBar } from "../../../types";
import {
  eastmoneyReportInfoCode,
  isReusableReportAnalysisCache,
  runSharedReportAnalysisTask,
  sharedReportAnalysisCacheKey,
} from "../application/report-analysis-cache";

export const companyRoutes = new Hono<AppEnv>();

export type CompanyReportForecast = {
  year: number;
  revenue?: number;
  revenueGrowth?: number;
  netProfit?: number;
  profitGrowth?: number;
  eps?: number;
  pe?: number;
};

export type CompanyReportValuation = {
  rating?: string;
  targetPrice?: number;
  targetPriceCurrency?: string;
  targetPe?: number;
  valuationMethod?: string;
};

type ReportForecastExtraction = {
  reportId: string;
  code: string;
  title: string;
  source: string;
  updatedAt: number;
  forecasts: CompanyReportForecast[];
  analysisSucceeded?: boolean;
};

type SharedReportAnalysis = {
  analysisCalled: boolean;
  forecasts: CompanyReportForecast[];
  updatedAt: number;
  analysisSucceeded?: boolean;
};

type CompanyNewsReportAnalysis = {
  analysisCalled: true;
  analysisSucceeded: true;
  isCompanyReport: boolean;
  forecasts: CompanyReportForecast[];
  valuation: CompanyReportValuation;
  updatedAt: number;
};

type ReportForecastProgress = {
  completed: number;
  total: number;
  title: string;
};

type ReportForecastStreamEvent = {
  progress?: ReportForecastProgress;
  items?: Array<Record<string, unknown>>;
};

type SinaCompanyReport = {
  title: string;
  url: string;
  orgName: string;
  publishDate: string;
  rating: string;
};

const REPORT_SOURCE_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const REPORT_SOURCE_CACHE_VERSION = "v3";
const REPORT_PAGE_SIZE = 10;
const REPORT_SOURCE_POOL_SIZE = 100;
const REPORT_FORECAST_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REPORT_RECENT_DAYS = 90;
const REPORT_FORECAST_MAX_CALLS = 10;
const NEWS_REPORT_CANDIDATE_LIMIT = 40;
const NEWS_REPORT_ANALYSIS_MAX_CALLS = 5;
const NEWS_REPORT_ANALYSIS_CACHE_VERSION = "v1";
const REPORT_LLM_MODEL: SupportedLlmModel = "gpt-5.6-luna";

companyRoutes.get("/company/overview", async (c) => {
  const code = requireQuery(c, "code");
  if (code instanceof Response) {
    return code;
  }
  const data = await fetchCompanyOverview(c, code);
  return ok(c, data);
});

companyRoutes.get("/company/info", async (c) => {
  const code = requireQuery(c, "code");
  if (code instanceof Response) {
    return code;
  }
  const overview = await fetchCompanyOverview(c, code);
  return ok(c, {
    code: overview.code,
    secCode: overview.code.split(".")[0],
    shortName: overview.name,
    name: overview.name,
    market: overview.market,
    type: overview.type,
    latestPrice: overview.latestPrice,
    marketCapYi: overview.marketCapYi,
    peTtm: overview.peTtm,
    pb: overview.pb,
  });
});

companyRoutes.get("/company/notices", async (c) => {
  const code = noticeCode(c);
  if (!code) {
    return fail(c, 400, "Missing code parameter");
  }
  const page = Number(c.req.query("page") ?? "1") || 1;
  const pageSize = Number(c.req.query("pageSize") ?? "20") || 20;
  const category = c.req.query("category")?.trim() ?? "";
  const data = supportsCninfoCompanyNotices(code)
    ? await fetchCninfoCompanyNotices(c.env.DB, code, page, pageSize, category)
    : await fetchEastmoneyCompanyNotices(c.env.DB, code, page, pageSize);
  return ok(
    c,
    data.map((item) => ({
      art_code: item.artCode,
      title: item.title,
      notice_date: item.noticeDate,
      columns: [{ column_name: item.noticeType }],
      pdf_url: item.pdfUrl,
    }))
  );
});

companyRoutes.get("/company/reports", async (c) => {
  const code = requireQuery(c, "code");
  if (code instanceof Response) {
    return code;
  }
  const page = positivePage(c.req.query("page"));
  const items = await getCompanyReportsWithProgress(c, code, page, () => undefined);
  return ok(c, items);
});

companyRoutes.get("/company/reports/stream", async (c) => {
  const code = requireQuery(c, "code");
  if (code instanceof Response) {
    return code;
  }
  const page = positivePage(c.req.query("page"));
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const items = await getCompanyReportsWithProgress(c, code, page, (event) => {
          if (event.progress) {
            controller.enqueue(
              encodeSseData({
                type: "progress",
                completed: event.progress.completed,
                total: event.progress.total,
                title: event.progress.title,
              })
            );
          }
          if (event.items) {
            controller.enqueue(encodeSseData({ type: "partial", data: event.items }));
          }
        });
        controller.enqueue(encodeSseData({ type: "result", data: items }));
      } catch (error) {
        controller.enqueue(
          encodeSseData({
            type: "error",
            error: error instanceof Error ? error.message : String(error),
          })
        );
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
    },
  });
});

companyRoutes.get("/report/forecast", async (c) => {
  const code = requireQuery(c, "code");
  if (code instanceof Response) {
    return code;
  }
  const items = await getCompanyReportsWithProgress(c, code, 1, () => undefined);
  return ok(c, aggregateForecastsForCode(code, items));
});

companyRoutes.get("/notice/pdf", async (c) => {
  const artCode = requireQuery(c, "artCode");
  if (artCode instanceof Response) {
    return artCode;
  }
  return ok(c, `https://pdf.dfcfw.com/pdf/H3_${encodeURIComponent(artCode)}_1.pdf`);
});

companyRoutes.get("/report/url", (c) => ok(c, null));

function noticeCode(c: Context<AppEnv>): string {
  const direct = c.req.query("code")?.trim();
  if (direct) {
    return direct;
  }
  const stock = c.req.query("stock")?.trim();
  const type = c.req.query("type")?.trim();
  if (!stock) {
    return "";
  }
  return type ? `${stock}.${type.toUpperCase()}` : stock;
}

async function fetchCompanyOverview(c: Context<AppEnv>, code: string): Promise<CompanyOverview> {
  try {
    const normalized = normalizeSecurityCode(code);
    const [eastmoneyOverview, kline] = await Promise.all([
      fetchEastmoneyCompanyOverview(c.env.DB, normalized),
      loadKline(c.env, normalized, "day", "normal", "1990-01-01", today()),
    ]);
    return applyXueqiuKlineOverview(eastmoneyOverview, kline.rows);
  } catch (err) {
    if (!isUnsupportedEastmoneyCompanyError(err)) {
      throw err;
    }
    return fetchGlobalCompanyOverview(c, code);
  }
}

async function fetchGlobalCompanyOverview(c: Context<AppEnv>, code: string): Promise<CompanyOverview> {
  const normalized = normalizeSecurityCode(code);
  const httpOptions = externalHttpOptions(c.env);
  const [security, kline] = await Promise.all([
    getSecurity(c.env.DB, normalized, { httpOptions }).catch(() => null),
    loadKline(c.env, normalized, "day", "normal", "1990-01-01", today())
      .catch(() => ({ rows: [] as KlineBar[] })),
  ]);
  const rows = kline.rows.filter((row): row is KlineBar => "close" in row && row.close !== null);
  const latest = rows.at(-1);
  const previous = rows.length > 1 ? rows.at(-2) : undefined;
  const latestPrice = latest?.close ?? null;
  const previousPrice = previous?.close ?? null;
  const changeAmount = latestPrice !== null && previousPrice !== null ? latestPrice - previousPrice : null;
  return {
    code: normalized,
    name: security?.name || normalized,
    market: securityMarket(normalized),
    type: inferSecurityType(normalized),
    latestPrice,
    pctChange:
      changeAmount !== null && previousPrice !== null && previousPrice !== 0
        ? (changeAmount * 100) / previousPrice
        : null,
    changeAmount,
    turnover: latest?.turnover ?? null,
    marketCapYi: latest?.marketCapital !== null && latest?.marketCapital !== undefined
      ? latest.marketCapital / 100_000_000
      : null,
    peTtm: latest?.peTtm ?? null,
    pb: latest?.pb ?? null,
    source: latest?.source ?? "local",
    updatedAt: Date.now(),
  };
}

function applyXueqiuKlineOverview(
  eastmoneyOverview: CompanyOverview,
  rows: Array<KlineBar | { date: string }>
): CompanyOverview {
  const latest = rows.filter((row): row is KlineBar => "close" in row).at(-1);
  if (!latest) {
    throw new Error(`Xueqiu K-line is empty for company overview: ${eastmoneyOverview.code}`);
  }
  return {
    ...eastmoneyOverview,
    latestPrice: latest.close,
    pctChange: latest.pctChange,
    changeAmount: latest.changeAmount,
    turnover: latest.turnover,
    marketCapYi: latest.marketCapital !== null ? latest.marketCapital / 100_000_000 : null,
    peTtm: latest.peTtm,
    pb: latest.pb,
    source: "xueqiu",
    updatedAt: latest.updatedAt,
  };
}

async function fetchEastmoneyCompanyReports(
  c: Context<AppEnv>,
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
    c.env.DB,
    url.toString(),
    {
      headers: {
        Referer: "https://data.eastmoney.com/report/",
      },
    },
    6 * 60 * 60 * 1000,
    externalHttpOptions(c.env)
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

async function getCompanyReportsWithProgress(
  c: Context<AppEnv>,
  code: string,
  page: number,
  onProgress: (event: ReportForecastStreamEvent) => void
): Promise<Array<Record<string, unknown>>> {
  let items = await getCompanyReportsSource(c, code, page);
  if (page === 1) {
    await ensureReportForecastsForItemsWithProgress(c, code, items, onProgress);
  } else {
    onProgress({ progress: { completed: 0, total: 0, title: "" } });
  }
  items = await annotateReportItemsWithForecasts(c, items);
  return items;
}

async function getCompanyReportsSource(
  c: Context<AppEnv>,
  code: string,
  page: number
): Promise<Array<Record<string, unknown>>> {
  const normalized = normalizeSecurityCode(code);
  if (!isCnCode(normalized)) {
    return [];
  }
  const cacheKey = `company-reports-source:${REPORT_SOURCE_CACHE_VERSION}:${normalized}`;
  const cached = await readAppJson<Array<Record<string, unknown>>>(c.env.DB, cacheKey);
  if (Array.isArray(cached)) {
    return paginateCompanyReports(cached, page);
  }
  const [eastmoneyItems, sinaItems, newsReportCandidates] = await Promise.all([
    fetchEastmoneyCompanyReports(c, normalized, 1, REPORT_SOURCE_POOL_SIZE),
    fetchSinaCompanyReportsLite(c, normalized, 1).catch(() => []),
    fetchKnowledgeNewsReportCandidates(c, normalized),
  ]);
  const merged = filterRecentCompanyReports(
    mergeCompanyReportsPreferPrimary(
      mergeCompanyReportsPreferPrimary(eastmoneyItems, sinaItems),
      newsReportCandidates,
    ),
  );
  await writeAppJson(c.env.DB, cacheKey, merged, REPORT_SOURCE_CACHE_TTL_MS);
  return paginateCompanyReports(merged, page);
}

function paginateCompanyReports(items: Array<Record<string, unknown>>, page: number): Array<Record<string, unknown>> {
  const offset = (page - 1) * REPORT_PAGE_SIZE;
  return items.slice(offset, offset + REPORT_PAGE_SIZE);
}

async function fetchSinaCompanyReportsLite(
  c: Context<AppEnv>,
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
  const html = await fetchDecodedPageCached(c, `sina-report-list:${symbol}:${page}`, url.toString(), REPORT_SOURCE_CACHE_TTL_MS);
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

type KnowledgeNewsReportCandidateRow = {
  doc_id: string;
  source_name: string | null;
  title: string;
  url: string | null;
  published_at: string | null;
  fetched_at: string | null;
  event_time: string | null;
  summary: string | null;
  content_preview: string | null;
  content_key: string | null;
  content_url: string | null;
};

async function fetchKnowledgeNewsReportCandidates(
  c: Context<AppEnv>,
  code: string,
): Promise<Array<Record<string, unknown>>> {
  const rows = await c.env.DB.prepare(
    `select d.doc_id, d.source_name, d.title, d.url, d.published_at, d.fetched_at, d.event_time,
      d.summary, d.content_preview, r.content_key, r.content_url
     from knowledge_docs d
     join knowledge_doc_security_links l on l.doc_id = d.doc_id
     left join knowledge_doc_content_refs r on r.doc_id = d.doc_id
     where l.code = ?
       and d.report_type = 'news'
       and d.source_type in ('local_news', 'web_news')
       and (
         d.title like '%研报%'
         or d.title like '%首次覆盖%'
         or d.title like '%买入评级%'
         or d.title like '%维持%评级%'
         or d.title like '%上调%评级%'
         or d.title like '%下调%评级%'
         or d.title like '%目标价%'
         or d.title like '%目标价格%'
         or d.content_preview like '%首次覆盖%'
         or d.content_preview like '%目标价%'
       )
     order by d.sort_time desc, d.doc_id desc
     limit ?`
  )
    .bind(code, NEWS_REPORT_CANDIDATE_LIMIT)
    .all<KnowledgeNewsReportCandidateRow>();
  return (rows.results ?? []).map((row) => ({
    code,
    title: row.title,
    url: row.url || "",
    publishDate: row.event_time || row.published_at || row.fetched_at || "",
    orgName: row.source_name || "资讯",
    orgSName: row.source_name || "资讯",
    knowledgeNewsReport: true,
    knowledgeDocId: row.doc_id,
    contentPreview: row.content_preview || "",
    summary: row.summary || "",
    contentKey: row.content_key || "",
    contentUrl: row.content_url || "",
  }));
}

async function ensureReportForecastsForItemsWithProgress(
  c: Context<AppEnv>,
  code: string,
  items: Array<Record<string, unknown>>,
  onProgress: (event: ReportForecastStreamEvent) => void
): Promise<void> {
  const normalized = normalizeSecurityCode(code);
  const newsCandidates = items
    .filter(isKnowledgeNewsReportCandidate)
    .slice(0, NEWS_REPORT_ANALYSIS_MAX_CALLS);
  const standardCandidates = items
    .filter((item) => normalizeSecurityCode(text(item.code)) === normalized)
    .filter((item) => !isKnowledgeNewsReportCandidate(item))
    .filter((item) => reportForecastNeedsLlmRefresh(item))
    .slice(0, REPORT_FORECAST_MAX_CALLS - newsCandidates.length);
  const candidates = [...newsCandidates, ...standardCandidates];
  onProgress({
    progress: { completed: 0, total: candidates.length, title: "" },
    items,
  });
  for (let index = 0; index < candidates.length; index += 1) {
    const item = candidates[index];
    try {
      await ensureSingleReportForecast(c, normalized, item);
    } catch (error) {
      console.error("company report forecast extraction failed", {
        code: normalized,
        title: text(item.title),
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      onProgress({
        progress: {
          completed: index + 1,
          total: candidates.length,
          title: text(item.title),
        },
        items: await annotateReportItemsWithForecasts(c, items),
      });
    }
  }
}

async function ensureSingleReportForecast(
  c: Context<AppEnv>,
  code: string,
  item: Record<string, unknown>
): Promise<void> {
  if (isKnowledgeNewsReportCandidate(item)) {
    await ensureKnowledgeNewsReportAnalysis(c, item);
    return;
  }
  const reportId = companyReportId(item);
  if (!reportId) {
    return;
  }
  const cacheKey = reportForecastCacheKey(reportId);
  const sharedCacheKey = sharedReportCacheKeyForItem(item);
  let shared = await readSharedReportAnalysis(c.env.DB, sharedCacheKey);
  if (shared?.analysisCalled) {
    return;
  }
  const cached = await readAppJson<ReportForecastExtraction>(c.env.DB, cacheKey);
  if (cached?.forecasts?.length || cached?.analysisSucceeded === true) {
    await writeSharedReportAnalysis(c.env.DB, item, cached.forecasts, cached.updatedAt);
    return;
  }

  await runSharedReportAnalysisTask(sharedCacheKey, async () => {
    const completedByAnotherRequest = await readSharedReportAnalysis(c.env.DB, sharedCacheKey);
    if (completedByAnotherRequest?.analysisCalled) {
      return;
    }
    const reportContent = await loadReportContentForForecast(c, item);
    if (!reportContent) {
      return;
    }
    const forecasts = await extractCompanyReportByLlm(c, text(item.title), reportContent.content);
    const updatedAt = Date.now();
    const extraction: ReportForecastExtraction = {
      reportId,
      code,
      title: text(item.title),
      source: reportContent.source,
      updatedAt,
      forecasts,
      analysisSucceeded: true,
    };
    await Promise.all([
      writeAppJson(c.env.DB, cacheKey, extraction, REPORT_FORECAST_CACHE_TTL_MS),
      writeSharedReportAnalysis(c.env.DB, item, forecasts, updatedAt),
    ]);
  });
}

function isKnowledgeNewsReportCandidate(item: Record<string, unknown>): boolean {
  return item.knowledgeNewsReport === true && Boolean(text(item.knowledgeDocId));
}

function knowledgeNewsReportAnalysisCacheKey(item: Record<string, unknown>): string {
  const docId = text(item.knowledgeDocId);
  return docId ? `company-news-report-analysis:${NEWS_REPORT_ANALYSIS_CACHE_VERSION}:${docId}` : "";
}

async function ensureKnowledgeNewsReportAnalysis(
  c: Context<AppEnv>,
  item: Record<string, unknown>,
): Promise<void> {
  const cacheKey = knowledgeNewsReportAnalysisCacheKey(item);
  if (!cacheKey || await readKnowledgeNewsReportAnalysis(c.env.DB, cacheKey)) {
    return;
  }
  await runSharedReportAnalysisTask(cacheKey, async () => {
    if (await readKnowledgeNewsReportAnalysis(c.env.DB, cacheKey)) {
      return;
    }
    const content = await loadKnowledgeNewsReportContent(c, item);
    if (!content) {
      return;
    }
    const analysis = await extractCompanyNewsReportByLlm(c, text(item.title), content);
    await writeAppJson(c.env.DB, cacheKey, {
      ...analysis,
      analysisCalled: true,
      analysisSucceeded: true,
      updatedAt: Date.now(),
    } satisfies CompanyNewsReportAnalysis, REPORT_FORECAST_CACHE_TTL_MS);
  });
}

async function loadKnowledgeNewsReportContent(
  c: Context<AppEnv>,
  item: Record<string, unknown>,
): Promise<string> {
  const key = text(item.contentKey);
  const publicBaseUrl = text(c.env.KNOWLEDGE_CONTENT_PUBLIC_BASE_URL).replace(/\/+$/, "");
  const contentUrl = key && publicBaseUrl
    ? `${publicBaseUrl}/${key.split("/").map(encodeURIComponent).join("/")}`
    : text(item.contentUrl);
  if (contentUrl) {
    const response = await fetch(contentUrl);
    if (!response.ok) {
      throw new Error(`knowledge news content request failed: ${response.status}`);
    }
    const content = (await response.text()).trim();
    if (content) {
      return content.slice(0, 12000);
    }
  }
  return firstNonEmpty([text(item.contentPreview), text(item.summary)]).slice(0, 12000);
}

async function readKnowledgeNewsReportAnalysis(
  db: D1Database,
  cacheKey: string,
): Promise<CompanyNewsReportAnalysis | null> {
  if (!cacheKey) {
    return null;
  }
  const cached = await readAppJson<CompanyNewsReportAnalysis>(db, cacheKey);
  return cached?.analysisCalled === true
    && cached.analysisSucceeded === true
    && typeof cached.isCompanyReport === "boolean"
    && Array.isArray(cached.forecasts)
    && cached.valuation && typeof cached.valuation === "object"
    ? cached
    : null;
}

async function annotateReportItemsWithForecasts(
  c: Context<AppEnv>,
  items: Array<Record<string, unknown>>
): Promise<Array<Record<string, unknown>>> {
  const results: Array<Record<string, unknown>> = [];
  for (const item of items) {
    if (isKnowledgeNewsReportCandidate(item)) {
      const analysis = await readKnowledgeNewsReportAnalysis(c.env.DB, knowledgeNewsReportAnalysisCacheKey(item));
      if (analysis?.isCompanyReport) {
        results.push({
          ...item,
          forecastSource: "llm_news_report",
          forecasts: analysis.forecasts,
          valuation: analysis.valuation,
        });
      }
      continue;
    }
    const reportId = companyReportId(item);
    if (!reportId) {
      results.push(item);
      continue;
    }
    const shared = await readSharedReportAnalysis(c.env.DB, sharedReportCacheKeyForItem(item));
    const cached = shared?.forecasts?.length
      ? shared
      : await readAppJson<ReportForecastExtraction>(c.env.DB, reportForecastCacheKey(reportId));
    if (cached?.forecasts?.length) {
      results.push({
        ...item,
        forecastSource: "llm_report_source",
        forecasts: mergeForecastRows(cached.forecasts, Array.isArray(item.forecasts)
          ? item.forecasts as CompanyReportForecast[]
          : []),
      });
      continue;
    }
    if (Array.isArray(item.forecasts) && item.forecasts.length > 0) {
      results.push(item);
      continue;
    }
    results.push(item);
  }
  return results;
}

async function loadReportContentForForecast(
  c: Context<AppEnv>,
  item: Record<string, unknown>
): Promise<{ content: string; source: string } | null> {
  const infoCode = eastmoneyReportInfoCode(item.infoCode, item.url, item.detailUrl);
  if (infoCode) {
    const content = await loadEastmoneyReportPdfText(c, infoCode);
    return content ? { content, source: "eastmoney_pdf" } : null;
  }
  const url = text(item.detailUrl) || text(item.url);
  if (!url) {
    return null;
  }
  const html = await fetchDecodedPageCached(c, `sina-report-detail:${url}`, url, REPORT_FORECAST_CACHE_TTL_MS);
  const content = extractSinaReportContent(html);
  return content ? { content, source: "sina_html" } : null;
}

async function loadEastmoneyReportPdfText(c: Context<AppEnv>, infoCode: string): Promise<string> {
  const cacheKey = `eastmoney-report-pdf-text:${infoCode}`;
  const cached = await readAppJson<{ text: string }>(c.env.DB, cacheKey);
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
  await writeAppJson(c.env.DB, cacheKey, { text: textValue }, REPORT_FORECAST_CACHE_TTL_MS);
  return textValue;
}

export async function extractCompanyReportByLlm(
  c: Context<AppEnv>,
  title: string,
  content: string,
): Promise<CompanyReportForecast[]> {
  const trimmed = trimText(formatCompanyReportTextForLlm(content), 12000);
  if (!trimmed) {
    return [];
  }
  const prompt = REPORT_ANALYZE_USER_PROMPT
    .replace("{{TITLE}}", title)
    .replace("{{CONTENT}}", trimmed);
  const response = await requestLlmText(c.env, {
    model: REPORT_LLM_MODEL,
    messages: [
      { role: "system", content: REPORT_ANALYZE_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    maxTokens: 4096,
    cacheTtlMs: REPORT_FORECAST_CACHE_TTL_MS,
  });
  return parseCompanyReportForecasts(response.text);
}

export async function extractCompanyNewsReportByLlm(
  c: Context<AppEnv>,
  title: string,
  content: string,
): Promise<Omit<CompanyNewsReportAnalysis, "analysisCalled" | "analysisSucceeded" | "updatedAt">> {
  const trimmed = trimText(formatCompanyReportTextForLlm(content), 12000);
  if (!trimmed) {
    return {
      isCompanyReport: false,
      forecasts: [],
      valuation: {},
    };
  }
  const prompt = NEWS_REPORT_ANALYZE_USER_PROMPT
    .replace("{{TITLE}}", title)
    .replace("{{CONTENT}}", trimmed);
  const response = await requestLlmText(c.env, {
    model: REPORT_LLM_MODEL,
    messages: [
      { role: "system", content: NEWS_REPORT_ANALYZE_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    maxTokens: 4096,
    cacheTtlMs: REPORT_FORECAST_CACHE_TTL_MS,
  });
  return parseCompanyNewsReportAnalysis(response.text);
}

export function formatCompanyReportTextForLlm(content: string): string {
  let formatted = content
    .replace(/\r\n?/g, "\n")
    .replace(/[\u00a0\u200b\ufeff]/g, " ");
  for (let pass = 0; pass < 4; pass += 1) {
    const next = formatted.replace(/([\u3400-\u9fff])[\t ]+([\u3400-\u9fff])/g, "$1$2");
    if (next === formatted) {
      break;
    }
    formatted = next;
  }
  return formatted.replace(/\b(20\d?)\s(\d)/g, "$1$2");
}

export function parseCompanyReportForecasts(textBody: string): CompanyReportForecast[] {
  const parsed = parseJsonObjectFromText(textBody);
  if (!parsed || !Array.isArray(parsed.forecasts)) {
    throw new Error("LLM forecast response did not contain a forecasts array");
  }
  return parseCompanyReportForecastRows(parsed.forecasts);
}

export function parseCompanyNewsReportAnalysis(textBody: string): Omit<CompanyNewsReportAnalysis, "analysisCalled" | "analysisSucceeded" | "updatedAt"> {
  const parsed = parseJsonObjectFromText(textBody);
  if (!parsed || typeof parsed.isCompanyReport !== "boolean" || !Array.isArray(parsed.forecasts)) {
    throw new Error("LLM news report response did not contain the required fields");
  }
  if (!parsed.isCompanyReport) {
    return { isCompanyReport: false, forecasts: [], valuation: {} };
  }
  const valuation = parsed.valuation && typeof parsed.valuation === "object" && !Array.isArray(parsed.valuation)
    ? parsed.valuation as Record<string, unknown>
    : {};
  return {
    isCompanyReport: true,
    forecasts: parseCompanyReportForecastRows(parsed.forecasts),
    valuation: {
      ...(nonEmptyTextOrUndefined(valuation.rating) ? { rating: nonEmptyTextOrUndefined(valuation.rating) } : {}),
      ...(positiveNumberOrUndefined(valuation.targetPrice) !== undefined ? { targetPrice: positiveNumberOrUndefined(valuation.targetPrice) } : {}),
      ...(nonEmptyTextOrUndefined(valuation.targetPriceCurrency) ? { targetPriceCurrency: nonEmptyTextOrUndefined(valuation.targetPriceCurrency) } : {}),
      ...(positiveNumberOrUndefined(valuation.targetPe) !== undefined ? { targetPe: positiveNumberOrUndefined(valuation.targetPe) } : {}),
      ...(nonEmptyTextOrUndefined(valuation.valuationMethod) ? { valuationMethod: nonEmptyTextOrUndefined(valuation.valuationMethod) } : {}),
    },
  };
}

function parseCompanyReportForecastRows(value: unknown[]): CompanyReportForecast[] {
  const rows = value as Array<Record<string, unknown>>;
  const forecasts = rows
    .map((row) => {
      const year = Number(row.year);
      if (!Number.isInteger(year) || year <= 0) {
        return null;
      }
      const revenue = numberOrUndefined(row.revenue);
      const revenueGrowth = numberOrUndefined(row.revenueGrowth);
      const netProfit = numberOrUndefined(row.netProfit);
      const profitGrowth = numberOrUndefined(row.profitGrowth);
      const eps = numberOrUndefined(row.eps);
      const pe = numberOrUndefined(row.pe);
      if (revenue === undefined && netProfit === undefined && eps === undefined && pe === undefined) {
        return null;
      }
      return {
        year,
        ...(revenue !== undefined ? { revenue: revenue } : {}),
        ...(revenueGrowth !== undefined ? { revenueGrowth } : {}),
        ...(netProfit !== undefined ? { netProfit: netProfit } : {}),
        ...(profitGrowth !== undefined ? { profitGrowth } : {}),
        ...(eps !== undefined ? { eps: eps } : {}),
        ...(pe !== undefined ? { pe: pe } : {}),
      };
    })
    .filter((row): row is CompanyReportForecast => Boolean(row));
  forecasts.sort((left, right) => left.year - right.year);
  return forecasts;
}

function aggregateForecastsForCode(
  code: string,
  items: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  const normalized = normalizeSecurityCode(code);
  const grouped = new Map<number, Record<"revenue" | "revenueGrowth" | "netProfit" | "profitGrowth", number[]>>();
  for (const item of items) {
    if (normalizeSecurityCode(text(item.code)) !== normalized) {
      continue;
    }
    const forecasts = Array.isArray(item.forecasts) ? item.forecasts as Array<Record<string, unknown>> : [];
    for (const forecast of forecasts) {
      const year = Number(forecast.year);
      if (!Number.isInteger(year)) {
        continue;
      }
      if (!grouped.has(year)) {
        grouped.set(year, {
          revenue: [],
          revenueGrowth: [],
          netProfit: [],
          profitGrowth: [],
        });
      }
      const values = grouped.get(year)!;
      for (const field of ["revenue", "revenueGrowth", "netProfit", "profitGrowth"] as const) {
        const value = numberOrUndefined(forecast[field]);
        const requiresPositiveValue = field === "revenue" || field === "netProfit";
        if (value !== undefined && (!requiresPositiveValue || value > 0)) {
          values[field].push(value);
        }
      }
    }
  }
  return [...grouped.entries()]
    .map(([year, values]) => ({
      year,
      ...Object.fromEntries(
        Object.entries(values)
          .filter(([, fieldValues]) => fieldValues.length > 0)
          .map(([field, fieldValues]) => [
            field,
            round2(fieldValues.reduce((sum, value) => sum + value, 0) / fieldValues.length),
          ])
      ),
    }))
    .filter((forecast) => Object.keys(forecast).length > 1)
    .sort((left, right) => Number(left.year) - Number(right.year));
}



function reportForecastCacheKey(reportId: string): string {
  return `report-forecast:v4:${reportId}`;
}

function sharedReportCacheKeyForItem(item: Record<string, unknown>): string {
  const infoCode = eastmoneyReportInfoCode(item.infoCode, item.url, item.detailUrl);
  return sharedReportAnalysisCacheKey(infoCode);
}

async function readSharedReportAnalysis(
  db: D1Database,
  cacheKey: string,
): Promise<SharedReportAnalysis | null> {
  if (!cacheKey) {
    return null;
  }
  const cached = await readAppJson<SharedReportAnalysis>(db, cacheKey);
  return isReusableReportAnalysisCache(cached) ? cached : null;
}

async function writeSharedReportAnalysis(
  db: D1Database,
  item: Record<string, unknown>,
  forecasts: CompanyReportForecast[],
  updatedAt: number,
): Promise<void> {
  const cacheKey = sharedReportCacheKeyForItem(item);
  if (!cacheKey) {
    return;
  }
  await writeAppJson(db, cacheKey, {
    analysisCalled: true,
    analysisSucceeded: true,
    forecasts,
    updatedAt,
  } satisfies SharedReportAnalysis, REPORT_FORECAST_CACHE_TTL_MS);
}

function mergeCompanyReportsPreferPrimary(
  primary: Array<Record<string, unknown>>,
  supplements: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  const merged: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const supplementsByKey = new Map<string, Array<Record<string, unknown>>>();
  for (const item of supplements) {
    const key = companyReportMergeKey(item);
    if (!key) {
      continue;
    }
    if (!supplementsByKey.has(key)) {
      supplementsByKey.set(key, []);
    }
    supplementsByKey.get(key)!.push(item);
  }
  for (const item of primary) {
    const key = companyReportMergeKey(item);
    const supplement = key ? supplementsByKey.get(key)?.shift() : undefined;
    const mergedItem = supplement ? mergePrimaryReportWithSupplement(item, supplement) : item;
    const dedupKey = companyReportDedupKey(mergedItem);
    if (!dedupKey || seen.has(dedupKey)) {
      continue;
    }
    seen.add(dedupKey);
    merged.push(mergedItem);
  }
  for (const item of supplements) {
    const dedupKey = companyReportDedupKey(item);
    if (!dedupKey || seen.has(dedupKey)) {
      continue;
    }
    seen.add(dedupKey);
    merged.push(item);
  }
  merged.sort((left, right) => companyReportSortTime(right) - companyReportSortTime(left));
  return merged;
}

function filterRecentCompanyReports(items: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const cutoff = Date.now() - REPORT_RECENT_DAYS * 24 * 60 * 60 * 1000;
  return items.filter((item) => companyReportSortTime(item) >= cutoff);
}

function companyReportSortTime(item: Record<string, unknown>): number {
  const parsed = Date.parse(text(item.publishDate).slice(0, 10));
  return Number.isFinite(parsed) ? parsed : 0;
}

function companyReportDedupKey(item: Record<string, unknown>): string {
  return `${normalizeReportTitleCore(text(item.title))}|${normalizeReportOrgName(firstNonEmpty([text(item.orgSName), text(item.orgName), text(item.org)]))}`;
}

function companyReportMergeKey(item: Record<string, unknown>): string {
  const org = normalizeReportOrgName(firstNonEmpty([text(item.orgSName), text(item.orgName), text(item.org)]));
  const title = normalizeReportTitleCore(text(item.title));
  if (!org || !title) {
    return "";
  }
  return `${org}|${title}`;
}

function companyReportId(item: Record<string, unknown>): string {
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

function reportNeedsLlmExtraction(item: Record<string, unknown>): boolean {
  return text(item.detailUrl).includes("sina.com.cn") || text(item.url).includes("sina.com.cn");
}

function reportForecastNeedsLlmRefresh(item: Record<string, unknown>): boolean {
  if (!reportNeedsLlmExtraction(item) && !eastmoneyReportInfoCode(item.infoCode, item.url, item.detailUrl)) {
    return false;
  }
  return true;
}

function isCnCode(code: string): boolean {
  return [".SZ", ".SH", ".BJ"].some((suffix) => code.endsWith(suffix));
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

function extractSinaReportContent(html: string): string {
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


function mergeForecastRows(
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
  return {
    ...supplement,
    ...primary,
    ...(text(supplement.url) ? { detailUrl: text(supplement.url) } : {}),
  };
}

async function fetchDecodedPageCached(
  c: Context<AppEnv>,
  cacheKey: string,
  url: string,
  ttlMs: number
): Promise<string> {
  const cached = await readAppJson<{ text: string }>(c.env.DB, cacheKey);
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
  await writeAppJson(c.env.DB, cacheKey, { text: textValue }, ttlMs);
  return textValue;
}

function inferCharset(contentType: string | null): string {
  const match = contentType?.match(/charset=([^;]+)/i);
  const charset = match?.[1]?.trim().toLowerCase() ?? "utf-8";
  return charset === "gbk" || charset === "gb2312" ? "gbk" : "utf-8";
}

async function readAppJson<T>(db: D1Database, key: string): Promise<T | null> {
  const row = await getAppKv(db, key);
  if (!row?.valueJson) {
    return null;
  }
  try {
    return JSON.parse(row.valueJson) as T;
  } catch {
    return null;
  }
}

async function writeAppJson(db: D1Database, key: string, value: unknown, ttlMs: number): Promise<void> {
  const now = Date.now();
  await putAppKv(db, {
    key,
    valueJson: JSON.stringify(value),
    expiresAt: now + Math.max(1, ttlMs),
    updatedAt: now,
  });
}

function parseJsonObjectFromText(value: string): Record<string, unknown> | null {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    const parsed = JSON.parse(value.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function trimText(value: string, maxChars: number): string {
  return value.trim().slice(0, Math.max(0, maxChars));
}

function numberOrUndefined(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : Number(String(value).replaceAll(",", "").replace(/%$/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function positiveNumberOrUndefined(value: unknown): number | undefined {
  const parsed = numberOrUndefined(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function nonEmptyTextOrUndefined(value: unknown): string | undefined {
  const normalized = text(value);
  return normalized ? normalized : undefined;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function firstNonEmpty(values: string[]): string {
  return values.find((value) => value.trim()) ?? "";
}

function reportPdfUrl(item: Record<string, unknown>): string {
  const infoCode = text(item.infoCode);
  if (!infoCode) {
    return "";
  }
  return `https://pdf.dfcfw.com/pdf/H3_${encodeURIComponent(infoCode)}_1.pdf`;
}

function positivePage(value: string | undefined): number {
  const page = Number(value ?? "1");
  return Number.isInteger(page) && page > 0 ? page : 1;
}

function encodeSseData(payload: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function isUnsupportedEastmoneyCompanyError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith("unsupported company code:");
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
