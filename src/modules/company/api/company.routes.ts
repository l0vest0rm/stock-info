import { Context, Hono } from "hono";
import { getAppKv, putAppKv } from "../../../db/queries";
import { fetchEastmoneyCompanyNotices, fetchEastmoneyCompanyOverview } from "../../../adapters/eastmoney";
import { fetchCninfoCompanyNotices, supportsCninfoCompanyNotices } from "../../../adapters/cninfo";
import { loadKline } from "../../market/application/load-kline";
import { loadFinancialStatementReadModel } from "../../finance/application/load-financial-statements";
import { selectAnnualIncomeStatements } from "../../finance/domain/annual-income-statements";
import { getSecurity } from "../../security/application/search-securities";
import { bareCode, inferSecurityType, normalizeSecurityCode, securityMarket } from "../../../shared/codes";
import { cachedFetchJson, externalHttpOptions, fail, ok, requireQuery } from "../../../shared/http";
import { requestLlmText, type LlmWebSearchMetadata, type SupportedLlmModel } from "../../../shared/llm-client";
import {
  NEWS_REPORT_ANALYZE_SYSTEM_PROMPT,
  NEWS_REPORT_ANALYZE_USER_PROMPT,
  REPORT_ANALYZE_SYSTEM_PROMPT,
  REPORT_ANALYZE_USER_PROMPT,
  REPORT_DISCOVERY_SYSTEM_PROMPT,
  REPORT_DISCOVERY_USER_PROMPT,
} from "../../../generated/prompt-text";
import type { AppEnv, CompanyOverview, KlineBar } from "../../../types";
import {
  eastmoneyReportInfoCode,
  isReusableReportAnalysisCache,
  runSharedReportAnalysisTask,
  sharedReportAnalysisCacheKey,
} from "../application/report-analysis-cache";
import {
  claimNextGenericLlmTaskRun,
  completeGenericLlmRun,
  createGenericLlmTask,
  failGenericLlmRun,
  heartbeatGenericLlmRun,
  loadGenericLlmRun,
  loadGenericLlmRunArtifacts,
  loadGenericLlmTask,
  loadGenericLlmTaskByIdentity,
  requeueGenericLlmTask,
  writeGenericLlmRunArtifact,
  GENERIC_LLM_RAW_MODEL_ARTIFACT_STEP,
} from "../../../shared/local-job-protocol";

export const companyRoutes = new Hono<AppEnv>();

export type CompanyReportForecast = {
  year: number;
  revenue?: number;
  revenueGrowth?: number;
  netProfit?: number;
  profitGrowth?: number;
  eps?: number;
  pe?: number;
  computedNetProfit?: number;
  computedNetProfitAsOf?: number;
  computedPe?: number;
  computedPeAsOf?: number;
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
  targetPrice?: number | null;
  analysisSucceeded?: boolean;
};

type SharedReportAnalysis = {
  analysisCalled: boolean;
  forecasts: CompanyReportForecast[];
  targetPrice?: number | null;
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
  delta?: string;
  status?: "queued" | "running" | "completed" | "failed" | "blocked";
};
type LlmExtractionOptions = { onText?: (delta: string) => Promise<void> | void; onStatus?: (status: "queued" | "running" | "completed" | "failed" | "blocked") => Promise<void> | void; targetId?: string; idempotencyKey?: string };

export type CompanyReportDiscoveryCandidate = {
  title: string;
  institution?: string;
  publishedAt?: string;
  url?: string;
  forecasts: CompanyReportForecast[];
  valuation?: CompanyReportValuation;
};

type CompanyReportDiscoveryRunInput = {
  taskId: string;
  runId: string;
  attempt: number;
  runnerInstanceId: string;
  response: {
    model: string;
    text: string;
    webSearch?: CompanyReportDiscoveryWebSearchMetadata;
  };
};

export type CompanyReportDiscoveryWebSearchMetadata = LlmWebSearchMetadata & {
  /** The provider reached a terminal `response.completed` event. */
  responseCompleted?: boolean;
  /** Terminal Responses status retained for incomplete-stream diagnostics. */
  responseStatus?: string;
  /** A Web Search tool call reached its completed event/status. */
  webSearchCallCompleted?: boolean;
  /** The local WebQA gateway completed the browser-backed request. */
  transport?: "webqa";
};

type SinaCompanyReport = {
  title: string;
  url: string;
  orgName: string;
  publishDate: string;
  rating: string;
};

const REPORT_SOURCE_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const REPORT_SOURCE_CACHE_VERSION = "v5";
const REPORT_PAGE_SIZE = 10;
const REPORT_SOURCE_POOL_SIZE = 100;
const REPORT_FORECAST_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REPORT_FORECAST_PROMPT_VERSION = "company-report-forecast.v2";
const REPORT_RECENT_DAYS = 90;
const REPORT_FORECAST_MAX_CALLS = 10;
const NEWS_REPORT_CANDIDATE_LIMIT = 40;
const NEWS_REPORT_ANALYSIS_MAX_CALLS = 5;
const NEWS_REPORT_ANALYSIS_CACHE_VERSION = "v1";
const REPORT_LLM_MODEL: SupportedLlmModel = "gpt-5.6-luna";
const REPORT_DISCOVERY_PROMPT_VERSION = "company-report-discovery.v3";
const REPORT_DISCOVERY_TASK_TYPE = "company_report_discovery";
const REPORT_DISCOVERY_REASONING_EFFORT = "xhigh";
const REPORT_DISCOVERY_MAX_REPORTS = 20;
export const COMPANY_REPORT_DISCOVERY_JOB_TIMEOUT_MS = 60 * 60 * 1000;

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

// The discovery control is intentionally advertised only by the local LLM
// runtime.  The page uses this read-only capability/status projection instead
// of inferring local mode from its hostname or build configuration.
companyRoutes.get("/company/reports/discovery-capability", async (c) => {
  if (c.env.LLM_RUNTIME !== "local") {
    return fail(c, 404, "company report discovery is only available in local LLM runtime");
  }
  const code = requireQuery(c, "code");
  if (code instanceof Response) {
    return code;
  }
  const normalized = normalizeSecurityCode(code);
  if (!isCnCode(normalized)) {
    return ok(c, { enabled: false, code: normalized, task: null });
  }
  const taskId = c.req.query("taskId")?.trim() || "";
  const task = taskId
    ? await loadGenericLlmTask(c.env.DB, taskId)
    : await loadGenericLlmTaskByIdentity(c.env.DB, {
      taskType: REPORT_DISCOVERY_TASK_TYPE,
      targetType: "security",
      targetId: normalized,
      idempotencyKey: `company-report-discovery:${reportDiscoveryRecentSince()}`,
      promptVersion: REPORT_DISCOVERY_PROMPT_VERSION,
    });
  const matchingTask = task && task.taskType === REPORT_DISCOVERY_TASK_TYPE && task.targetType === "security" && task.targetId === normalized
    ? task
    : null;
  const lastRun = matchingTask?.lastRunId
    ? await loadGenericLlmRun(c.env.DB, matchingTask.lastRunId)
    : null;
  const execution = matchingTask
    ? {
      runId: lastRun?.taskId === matchingTask.taskId ? lastRun.runId : null,
      attempt: lastRun?.taskId === matchingTask.taskId ? lastRun.attempt : null,
      status: lastRun?.taskId === matchingTask.taskId ? lastRun.status : null,
      model: lastRun?.taskId === matchingTask.taskId ? lastRun.model : matchingTask.requestedModel,
      reasoningEffort: lastRun?.taskId === matchingTask.taskId ? lastRun.reasoningEffort : matchingTask.requestedReasoningEffort,
    }
    : null;
  return ok(c, {
    enabled: true,
    code: normalized,
    task: matchingTask ? { ...matchingTask, execution } : null,
  });
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
          if (event.delta) {
            controller.enqueue(encodeSseData({ type: "delta", text: event.delta }));
          }
          if (event.status === "queued") controller.enqueue(encodeSseData({ type: "queued" }));
          if (event.status === "running") controller.enqueue(encodeSseData({ type: "claimed" }));
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

// Web Search report discovery is an explicit local job. A normal report page
// GET/SSE remains read-only and only serves the materialized source pool.
companyRoutes.post("/company/reports/discover", async (c) => {
  if (c.env.LLM_RUNTIME !== "local") {
    return fail(c, 404, "company report discovery is only available in local LLM runtime");
  }
  const code = requireQuery(c, "code");
  if (code instanceof Response) {
    return code;
  }
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try {
    return ok(c, await enqueueCompanyReportDiscovery(c.env.DB, code, body.force === true, Date.now(), body.reasoningEffort));
  } catch (error) {
    return fail(c, 400, error instanceof Error ? error.message : String(error));
  }
});

// Local Node runner boundary. The Worker prepares/claims/completes the job;
// the runner, not this request handler, owns the long remote model call.
companyRoutes.post("/company/report-discovery-tasks/claim-next", async (c) => {
  if (c.env.LLM_RUNTIME !== "local") {
    return fail(c, 404, "company report discovery is only available in local LLM runtime");
  }
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  if (typeof body.runnerInstanceId !== "string" || !body.runnerInstanceId.trim()) {
    return fail(c, 400, "runnerInstanceId is required");
  }
  try {
    return ok(c, await claimNextCompanyReportDiscoveryTaskRun(c.env.DB, body.runnerInstanceId));
  } catch (error) {
    return fail(c, 400, error instanceof Error ? error.message : String(error));
  }
});

companyRoutes.post("/company/report-discovery-runs/:runId/complete", async (c) => {
  if (c.env.LLM_RUNTIME !== "local") {
    return fail(c, 404, "company report discovery is only available in local LLM runtime");
  }
  try {
    const body = await c.req.json<unknown>();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return fail(c, 400, "company report discovery result is required");
    }
    const payload = body as {
      taskId?: unknown;
      model?: unknown;
      text?: unknown;
      runnerInstanceId?: unknown;
      attempt?: unknown;
      webSearch?: CompanyReportDiscoveryWebSearchMetadata;
    };
    if (typeof payload.taskId !== "string" || !payload.taskId.trim()
      || typeof payload.runnerInstanceId !== "string" || !payload.runnerInstanceId.trim()
      || !Number.isInteger(payload.attempt) || typeof payload.model !== "string" || typeof payload.text !== "string") {
      return fail(c, 400, "taskId, model, text, runnerInstanceId and attempt are required");
    }
    return ok(c, await completeCompanyReportDiscoveryRun(c, {
      taskId: payload.taskId,
      runId: c.req.param("runId"),
      attempt: payload.attempt as number,
      runnerInstanceId: payload.runnerInstanceId,
      response: { model: payload.model, text: payload.text, webSearch: payload.webSearch },
    }));
  } catch (error) {
    return fail(c, 400, error instanceof Error ? error.message : String(error));
  }
});

companyRoutes.post("/company/report-discovery-runs/:runId/fail", async (c) => {
  if (c.env.LLM_RUNTIME !== "local") {
    return fail(c, 404, "company report discovery is only available in local LLM runtime");
  }
  try {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    if (typeof body.taskId !== "string" || !body.taskId.trim()
      || typeof body.runnerInstanceId !== "string" || !body.runnerInstanceId.trim()
      || !Number.isInteger(body.attempt)) {
      return fail(c, 400, "taskId, runnerInstanceId and attempt are required");
    }
    const task = await loadGenericLlmTask(c.env.DB, body.taskId);
    if (!task || task.taskType !== REPORT_DISCOVERY_TASK_TYPE) return fail(c, 400, "company report discovery task was not found");
    const result = await failGenericLlmRun(c.env.DB, {
      taskId: body.taskId,
      runId: c.req.param("runId"),
      attempt: body.attempt as number,
      leaseOwner: body.runnerInstanceId,
      errorCode: "provider_failed",
      errorMessage: String(body.error || "local company report discovery runner failed").slice(0, 1600),
      terminalMetadata: { taskType: REPORT_DISCOVERY_TASK_TYPE },
    });
    return ok(c, result);
  } catch (error) {
    return fail(c, 400, error instanceof Error ? error.message : String(error));
  }
});

companyRoutes.post("/company/report-discovery-runs/:runId/heartbeat", async (c) => {
  if (c.env.LLM_RUNTIME !== "local") {
    return fail(c, 404, "company report discovery is only available in local LLM runtime");
  }
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  if (typeof body.taskId !== "string" || !body.taskId.trim()
    || typeof body.runnerInstanceId !== "string" || !body.runnerInstanceId.trim()
    || !Number.isInteger(body.attempt)) {
    return fail(c, 400, "taskId, runnerInstanceId and attempt are required");
  }
  try {
    const active = await heartbeatGenericLlmRun(c.env.DB, c.req.param("runId"), body.taskId, body.attempt as number, body.runnerInstanceId);
    return ok(c, { active });
  } catch (error) {
    return fail(c, 400, error instanceof Error ? error.message : String(error));
  }
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
    marketDate: latest?.date ?? null,
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
    psTtm: latest?.ps ?? null,
    pcfTtm: latest?.pcf ?? null,
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
    marketDate: latest.date,
    latestPrice: latest.close,
    pctChange: latest.pctChange,
    changeAmount: latest.changeAmount,
    turnover: latest.turnover,
    marketCapYi: latest.marketCapital !== null ? latest.marketCapital / 100_000_000 : null,
    peTtm: latest.peTtm,
    pb: latest.pb,
    psTtm: latest.ps,
    pcfTtm: latest.pcf,
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
  const [sourceItems, overview, actualAnnualProfitByYear] = await Promise.all([
    getCompanyReportsSource(c, code, page),
    fetchCompanyReportPeOverview(c, code),
    loadActualAnnualProfitByYear(c, code),
  ]);
  let items = sourceItems;
  if (page === 1) {
    await ensureReportForecastsForItemsWithProgress(c, code, items, overview, actualAnnualProfitByYear, onProgress);
  } else {
    onProgress({ progress: { completed: 0, total: 0, title: "" } });
  }
  items = await annotateReportItemsWithForecasts(c, items);
  return applyCurrentPeToReportItems(items, overview, actualAnnualProfitByYear);
}

export function calculateCurrentForecastPe(
  forecast: CompanyReportForecast,
  overview: Pick<CompanyOverview, "marketCapYi" | "latestPrice">,
): number | undefined {
  const netProfit = positiveNumberOrUndefined(forecast.netProfit);
  const marketCapYi = positiveNumberOrUndefined(overview.marketCapYi);
  if (netProfit !== undefined && marketCapYi !== undefined) {
    return round2(marketCapYi / netProfit);
  }
  const eps = positiveNumberOrUndefined(forecast.eps);
  const latestPrice = positiveNumberOrUndefined(overview.latestPrice);
  return eps !== undefined && latestPrice !== undefined ? round2(latestPrice / eps) : undefined;
}

export function calculateCurrentForecastNetProfit(
  forecast: CompanyReportForecast,
  overview: Pick<CompanyOverview, "marketCapYi" | "latestPrice">,
): number | undefined {
  const eps = positiveNumberOrUndefined(forecast.eps);
  const marketCapYi = positiveNumberOrUndefined(overview.marketCapYi);
  const latestPrice = positiveNumberOrUndefined(overview.latestPrice);
  if (eps === undefined || marketCapYi === undefined || latestPrice === undefined) {
    return undefined;
  }
  return round2((marketCapYi / latestPrice) * eps);
}

function applyCurrentPeToReportItems(
  items: Array<Record<string, unknown>>,
  overview: CompanyOverview | null,
  actualAnnualProfitByYear = new Map<number, number>(),
): Array<Record<string, unknown>> {
  if (!overview) {
    return items;
  }
  return items.map((item) => {
    const computedPeByYear = Object.fromEntries(
      [...actualAnnualProfitByYear].flatMap(([year, netProfit]) => {
        const computedPe = calculateCurrentForecastPe({ year, netProfit }, overview);
        return computedPe === undefined ? [] : [[year, computedPe]];
      }),
    );
    if (!Array.isArray(item.forecasts)) {
      return Object.keys(computedPeByYear).length > 0
        ? { ...item, computedPeByYear, computedPeAsOf: overview.updatedAt }
        : item;
    }
    const forecasts = item.forecasts as CompanyReportForecast[];
    const withCurrentPe = forecasts.map((forecast) => {
      const computedPe = calculateCurrentForecastPe(forecast, overview);
      const computedNetProfit = forecast.netProfit === undefined
        ? calculateCurrentForecastNetProfit(forecast, overview)
        : undefined;
      if (computedPe === undefined && computedNetProfit === undefined) {
        return forecast;
      }
      return {
        ...forecast,
        ...(computedPe !== undefined ? { computedPe, computedPeAsOf: overview.updatedAt } : {}),
        ...(computedNetProfit !== undefined ? { computedNetProfit, computedNetProfitAsOf: overview.updatedAt } : {}),
      };
    });
    return {
      ...item,
      forecasts: withCurrentPe,
      ...(Object.keys(computedPeByYear).length > 0 ? { computedPeByYear, computedPeAsOf: overview.updatedAt } : {}),
    };
  });
}

async function fetchCompanyReportPeOverview(c: Context<AppEnv>, code: string): Promise<CompanyOverview | null> {
  const normalized = normalizeSecurityCode(code);
  if (!isCnCode(normalized)) {
    return null;
  }
  try {
    return await fetchEastmoneyCompanyOverview(c.env.DB, normalized);
  } catch (error) {
    console.warn("company report PE overview unavailable", {
      code: normalized,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function loadActualAnnualProfitByYear(c: Context<AppEnv>, code: string): Promise<Map<number, number>> {
  try {
    const financials = await loadFinancialStatementReadModel(c.env, code, "income", {
      httpOptions: externalHttpOptions(c.env),
    });
    if (financials.sourceHealth.status === "failed") throw new Error(financials.sourceHealth.message ?? "financial source failed");
    const { rows } = financials;
    return new Map(selectAnnualIncomeStatements(rows)
      .filter((statement) => statement.netProfit !== null)
      .map((statement) => [statement.fiscalYear, round2(statement.netProfit! / 100_000_000)]));
  } catch (error) {
    console.warn("company report PE financials unavailable", {
      code: normalizeSecurityCode(code),
      error: error instanceof Error ? error.message : String(error),
    });
    return new Map();
  }
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
    return paginateCompanyReports(cached.map(normalizeCompanyReportProvenance), page);
  }
  console.info("company report Web Search discovery is not started by read-only report GET", {
    code: normalized,
    llmRuntime: c.env.LLM_RUNTIME || "unset",
  });
  const merged = await loadCompanyReportSourcePool(c, normalized);
  await writeAppJson(c.env.DB, cacheKey, merged, REPORT_SOURCE_CACHE_TTL_MS);
  return paginateCompanyReports(merged, page);
}

async function loadCompanyReportSourcePool(
  c: Context<AppEnv>,
  code: string,
  discovered: Array<Record<string, unknown>> = [],
): Promise<Array<Record<string, unknown>>> {
  const normalized = normalizeSecurityCode(code);
  const [eastmoneyItems, sinaItems, newsReportCandidates] = await Promise.all([
    fetchEastmoneyCompanyReports(c, normalized, 1, REPORT_SOURCE_POOL_SIZE),
    fetchSinaCompanyReportsLite(c, normalized, 1).catch((error) => {
      console.warn("company report Sina source unavailable", { code: normalized, error: error instanceof Error ? error.message : String(error) });
      return [] as Array<Record<string, unknown>>;
    }),
    fetchKnowledgeNewsReportCandidates(c, normalized).catch((error) => {
      console.warn("company report knowledge source unavailable", { code: normalized, error: error instanceof Error ? error.message : String(error) });
      return [] as Array<Record<string, unknown>>;
    }),
  ]);
  return filterRecentCompanyReports(
    mergeCompanyReportsPreferPrimary(
      mergeCompanyReportsPreferPrimary(
        mergeCompanyReportsPreferPrimary(eastmoneyItems.map(normalizeCompanyReportProvenance), sinaItems.map(normalizeCompanyReportProvenance)),
        newsReportCandidates.map(normalizeCompanyReportProvenance),
      ),
      discovered.map((item) => ({ ...item, provenance: "web_search" })),
    ),
  );
}

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

export async function enqueueCompanyReportDiscovery(
  db: D1Database,
  securityCode: string,
  force = false,
  now = Date.now(),
  requestedReasoningEffort?: unknown,
) {
  const code = normalizeSecurityCode(securityCode);
  if (!isCnCode(code)) throw new Error("company report discovery only supports mainland company codes");
  const reasoningEffort = normalizeCompanyReportDiscoveryReasoningEffort(requestedReasoningEffort);
  const recentSince = reportDiscoveryRecentSince(now);
  const created = await createGenericLlmTask(db, {
    taskType: REPORT_DISCOVERY_TASK_TYPE,
    targetType: "security",
    targetId: code,
    idempotencyKey: `company-report-discovery:${recentSince}`,
    promptVersion: REPORT_DISCOVERY_PROMPT_VERSION,
    handlerKey: REPORT_DISCOVERY_TASK_TYPE,
    model: REPORT_LLM_MODEL,
    reasoningEffort,
    metadata: { securityCode: code, recentSince, maxReports: REPORT_DISCOVERY_MAX_REPORTS },
    now,
  });
  let task = created.task;
  let requeued = false;
  if (force && (task.status === "completed" || task.status === "failed" || task.status === "blocked")) {
    requeued = await requeueGenericLlmTask(db, task.taskId, now);
    task = await loadGenericLlmTask(db, task.taskId) || task;
  }
  // A queued, deduplicated task may receive an explicit diagnostic choice
  // after it was first created. Persist the choice before the worker claims it;
  // running/terminal tasks are left untouched unless force requeued them above.
  if (task.status === "queued") {
    await db.prepare(`update llm_tasks set requested_model=?, requested_reasoning_effort=?, updated_at=?
      where task_id=? and status='queued'`).bind(REPORT_LLM_MODEL, reasoningEffort, now, task.taskId).run();
    task = await loadGenericLlmTask(db, task.taskId) || task;
  }
  return { accepted: true, task, deduplicated: created.deduplicated && !requeued, requeued };
}

export async function claimNextCompanyReportDiscoveryTaskRun(
  db: D1Database,
  runnerInstanceId: string,
) {
  const claimed = await claimNextGenericLlmTaskRun(db, runnerInstanceId, {
    provider: "openai",
    model: REPORT_LLM_MODEL,
  });
  if (!claimed) return null;
  try {
    const prepared = await prepareCompanyReportDiscoveryExecution(db, claimed.task.targetId, claimed.task.taskId);
  return {
    task: claimed.task,
    run: claimed.run,
    request: {
      ...prepared,
      taskId: claimed.task.taskId,
      runId: claimed.run.runId,
      attempt: claimed.run.attempt,
      runnerInstanceId,
      taskType: claimed.task.taskType,
      targetType: claimed.task.targetType,
      targetId: claimed.task.targetId,
      idempotencyKey: claimed.task.idempotencyKey,
      protocolVersion: claimed.task.protocolVersion,
      progress: claimed.run.progress,
    },
  };
  } catch (error) {
    await failGenericLlmRun(db, {
      taskId: claimed.task.taskId,
      runId: claimed.run.runId,
      attempt: claimed.run.attempt,
      leaseOwner: runnerInstanceId,
      errorCode: "prepare_failed",
      errorMessage: error instanceof Error ? error.message : String(error),
    }).catch(() => {});
    throw error;
  }
}

export async function prepareCompanyReportDiscoveryExecution(
  db: D1Database,
  securityCode: string,
  taskId: string,
) {
  const code = normalizeSecurityCode(securityCode);
  const task = await loadGenericLlmTask(db, taskId);
  if (!task || task.taskType !== REPORT_DISCOVERY_TASK_TYPE || task.targetType !== "security" || task.targetId !== code) {
    throw new Error("company report discovery task was not found while preparing execution");
  }
  // Tasks created before the reasoning selector existed have a NULL field;
  // treat that persisted absence as the default max while still rejecting an
  // explicit null request at the API boundary.
  const reasoningEffort = normalizeCompanyReportDiscoveryReasoningEffort(task.requestedReasoningEffort ?? undefined);
  const security = await db.prepare("select name from securities where code=?").bind(code).first<{ name?: unknown }>();
  const recentSince = reportDiscoveryRecentSince();
  return {
    securityCode: code,
    model: REPORT_LLM_MODEL,
    reasoningEffort,
    maxOutputTokens: 8192,
    jobTimeoutMs: COMPANY_REPORT_DISCOVERY_JOB_TIMEOUT_MS,
    promptVersion: REPORT_DISCOVERY_PROMPT_VERSION,
    instructions: REPORT_DISCOVERY_SYSTEM_PROMPT,
    input: renderCompanyReportDiscoveryPrompt(REPORT_DISCOVERY_USER_PROMPT, {
      SECURITY_CODE: code,
      COMPANY_NAME: text(security?.name) || code,
      RECENT_SINCE: recentSince,
    }),
  };
}

async function completeCompanyReportDiscoveryRun(
  c: Context<AppEnv>,
  input: CompanyReportDiscoveryRunInput,
) {
  const task = await loadGenericLlmTask(c.env.DB, input.taskId);
  if (!task || task.taskType !== REPORT_DISCOVERY_TASK_TYPE || task.targetType !== "security") {
    throw new Error("company report discovery task was not found");
  }
  const run = await loadGenericLlmRun(c.env.DB, input.runId);
  assertActiveCompanyReportDiscoveryRun(run, input, task.taskId);
  if (input.response.model !== REPORT_LLM_MODEL) throw new Error("company report discovery response model mismatch");
  try {
    const webSearch = input.response.webSearch;
    const citations = validateCompanyReportDiscoveryWebSearch(webSearch);
    const parsed = parseCompanyReportDiscoveryWithDiagnostics(input.response.text, task.targetId, citations);
    if (parsed.rejected > 0) {
      console.warn("company report discovery rejected candidates", { code: task.targetId, rejected: parsed.rejected });
    }
    const discoveredRows = parsed.reports.map((item) => mapCompanyReportDiscoveryCandidate(item, task.targetId));
    const sourceRows = await loadCompanyReportSourcePool(c, task.targetId, discoveredRows);
    const cacheKey = `company-reports-source:${REPORT_SOURCE_CACHE_VERSION}:${normalizeSecurityCode(task.targetId)}`;
    await writeAppJson(c.env.DB, cacheKey, sourceRows, REPORT_SOURCE_CACHE_TTL_MS);
    const projection = {
      securityCode: normalizeSecurityCode(task.targetId),
      reportsFound: parsed.reports.length,
      reportsRejected: parsed.rejected,
      sourceRows: sourceRows.length,
      cachedAt: Date.now(),
    };
    await writeGenericLlmRunArtifact(c.env.DB, {
      runId: input.runId,
      taskId: input.taskId,
      attempt: input.attempt,
      leaseOwner: input.runnerInstanceId,
      stepKey: "company_report_discovery",
      outputType: "json",
      status: "complete",
      structureValid: true,
      output: { response: input.response, projection },
      terminalMetadata: projection,
    });
    const terminal = await completeGenericLlmRun(c.env.DB, {
      runId: input.runId,
      taskId: input.taskId,
      attempt: input.attempt,
      leaseOwner: input.runnerInstanceId,
      status: "completed",
      terminalMetadata: projection,
    });
    return { ...terminal, projection };
  } catch (error) {
    await failGenericLlmRun(c.env.DB, {
      runId: input.runId,
      taskId: input.taskId,
      attempt: input.attempt,
      leaseOwner: input.runnerInstanceId,
      errorCode: "projection_failed",
      errorMessage: error instanceof Error ? error.message : String(error),
      terminalMetadata: { taskType: REPORT_DISCOVERY_TASK_TYPE },
    }).catch(() => {});
    throw error;
  }
}

function assertActiveCompanyReportDiscoveryRun(
  run: Awaited<ReturnType<typeof loadGenericLlmRun>>,
  input: CompanyReportDiscoveryRunInput,
  taskId: string,
): asserts run is NonNullable<Awaited<ReturnType<typeof loadGenericLlmRun>>> {
  if (!run || run.taskId !== taskId || run.status !== "running" || run.attempt !== input.attempt
    || run.leaseOwner !== input.runnerInstanceId || !run.leaseUntil || run.leaseUntil < Date.now()) {
    throw new Error("company report discovery run lease is no longer owned by this runner");
  }
}

function mapCompanyReportDiscoveryCandidate(
  candidate: CompanyReportDiscoveryCandidate,
  securityCode: string,
): Record<string, unknown> {
  return {
    code: normalizeSecurityCode(securityCode),
    title: candidate.title,
    pages: 0,
    forecasts: candidate.forecasts,
    ...(candidate.valuation?.targetPrice !== undefined ? { targetPrice: candidate.valuation.targetPrice } : {}),
    ...(candidate.institution ? { orgName: candidate.institution, orgSName: candidate.institution } : {}),
    ...(candidate.publishedAt ? { publishDate: candidate.publishedAt } : {}),
    ...(candidate.url ? { url: candidate.url } : {}),
    ...(candidate.valuation && Object.keys(candidate.valuation).length > 0 ? { valuation: candidate.valuation } : {}),
    provenance: "web_search",
  };
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
     left join knowledge_doc_content_refs r on r.doc_id = d.doc_id
     where d.target_code_normalized = ?
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
  overview: CompanyOverview | null,
  actualAnnualProfitByYear: Map<number, number>,
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
    items: applyCurrentPeToReportItems(items, overview, actualAnnualProfitByYear),
  });
  for (let index = 0; index < candidates.length; index += 1) {
    const item = candidates[index];
    try {
      await ensureSingleReportForecast(c, normalized, item, {
        onText: (delta) => onProgress({ delta }),
        onStatus: (status) => onProgress({ status }),
      });
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
        items: applyCurrentPeToReportItems(await annotateReportItemsWithForecasts(c, items), overview, actualAnnualProfitByYear),
      });
    }
  }
}

async function ensureSingleReportForecast(
  c: Context<AppEnv>,
  code: string,
  item: Record<string, unknown>,
  callbacks: Pick<LlmExtractionOptions, "onText" | "onStatus"> = {},
): Promise<void> {
  if (isKnowledgeNewsReportCandidate(item)) {
    await ensureKnowledgeNewsReportAnalysis(c, item, callbacks);
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

  await runSharedReportAnalysisTask(sharedCacheKey, async () => {
    const completedByAnotherRequest = await readSharedReportAnalysis(c.env.DB, sharedCacheKey);
    if (completedByAnotherRequest?.analysisCalled) {
      return;
    }
    const reportContent = await loadReportContentForForecast(c, item);
    if (!reportContent) {
      return;
    }
    const analysis = await extractCompanyReportAnalysisByLlm(c, text(item.title), reportContent.content, {
      onText: callbacks.onText,
      onStatus: callbacks.onStatus,
      targetId: reportId,
      idempotencyKey: `company-report-forecast:${reportId}`,
    });
    const updatedAt = Date.now();
    const extraction: ReportForecastExtraction = {
      reportId,
      code,
      title: text(item.title),
      source: reportContent.source,
      updatedAt,
      forecasts: analysis.forecasts,
      targetPrice: analysis.targetPrice,
      analysisSucceeded: true,
    };
    await Promise.all([
      writeAppJson(c.env.DB, cacheKey, extraction, REPORT_FORECAST_CACHE_TTL_MS),
      writeSharedReportAnalysis(c.env.DB, item, analysis.forecasts, updatedAt, analysis.targetPrice),
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
  callbacks: Pick<LlmExtractionOptions, "onText" | "onStatus"> = {},
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
    const docId = text(item.knowledgeDocId);
    const analysis = await extractCompanyNewsReportByLlm(c, text(item.title), content, {
      onText: callbacks.onText,
      onStatus: callbacks.onStatus,
      targetId: docId,
      idempotencyKey: `company-news-report:${docId}`,
    });
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

type CompanyReportLlmRawResponse = Record<string, unknown> | string | null;

type CompanyReportLlmTaskIdentity = {
  taskType: string;
  targetType: string;
  targetId: string;
  idempotencyKey: string;
  promptVersion: string;
};

/**
 * Keep the exact report object returned by the discovery model.  The model's
 * report list is persisted as a terminal artifact; only the one candidate
 * whose canonical URL/report identity matches this row is returned.
 */
export function findCompanyReportDiscoveryRawReport(
  artifactOutput: unknown,
  item: Record<string, unknown>,
): Record<string, unknown> | null {
  const output = asRecord(artifactOutput);
  const response = asRecord(output?.response);
  const parsed = parseJsonObjectFromText(text(response?.text));
  const reports = parsed?.reports;
  if (!Array.isArray(reports)) {
    return null;
  }
  return reports.find((candidate) => (
    isRecord(candidate) && companyReportRawIdentityMatches(candidate, item)
  )) as Record<string, unknown> | undefined || null;
}

function companyReportLlmTaskIdentity(item: Record<string, unknown>): CompanyReportLlmTaskIdentity | null {
  if (isKnowledgeNewsReportCandidate(item)) {
    const docId = text(item.knowledgeDocId);
    return docId ? {
      taskType: "generic_raw_model",
      targetType: "company_news_report",
      targetId: docId,
      idempotencyKey: `company-news-report:${docId}`,
      promptVersion: NEWS_REPORT_ANALYSIS_CACHE_VERSION,
    } : null;
  }
  const reportId = companyReportId(item);
  return reportId ? {
    taskType: "generic_raw_model",
    targetType: "company_report_forecast",
    targetId: reportId,
    idempotencyKey: `company-report-forecast:${reportId}`,
    promptVersion: REPORT_FORECAST_PROMPT_VERSION,
  } : null;
}

export function normalizeCompanyReportLlmRawResponse(output: unknown): CompanyReportLlmRawResponse {
  const record = asRecord(output);
  const outputText = text(record?.text);
  if (!outputText) {
    return null;
  }
  return parseJsonObjectFromText(outputText) || outputText;
}

async function loadCompanyReportLlmRawResponse(
  c: Context<AppEnv>,
  item: Record<string, unknown>,
): Promise<CompanyReportLlmRawResponse | undefined> {
  if (c.env.LLM_RUNTIME !== "local") {
    return undefined;
  }
  try {
    const discovery = await loadCompanyReportDiscoveryRawReport(c.env.DB, item);
    if (discovery) {
      return discovery;
    }
    const identity = companyReportLlmTaskIdentity(item);
    if (!identity) {
      return undefined;
    }
    const task = await loadGenericLlmTaskByIdentity(c.env.DB, identity);
    if (!task || task.status !== "completed" || !task.lastRunId) {
      return null;
    }
    const run = await loadGenericLlmRun(c.env.DB, task.lastRunId);
    if (!run || run.taskId !== task.taskId || run.status !== "completed") {
      return null;
    }
    const artifact = (await loadGenericLlmRunArtifacts(c.env.DB, run.runId))
      .find((candidate) => candidate.stepKey === GENERIC_LLM_RAW_MODEL_ARTIFACT_STEP && candidate.status === "complete");
    return artifact ? normalizeCompanyReportLlmRawResponse(artifact.output) : null;
  } catch (error) {
    console.warn("company report raw model response unavailable", {
      title: text(item.title),
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function loadCompanyReportDiscoveryRawReport(
  db: D1Database,
  item: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const code = normalizeSecurityCode(text(item.code));
  if (!code) {
    return null;
  }
  const row = await db.prepare(`
    select task_id as taskId
      from llm_tasks
     where task_type=? and target_type='security' and target_id=?
       and prompt_version=? and status='completed'
     order by coalesce(completed_at, updated_at) desc, updated_at desc
     limit 1
  `).bind(REPORT_DISCOVERY_TASK_TYPE, code, REPORT_DISCOVERY_PROMPT_VERSION).first<{ taskId?: unknown }>();
  const taskId = text(row?.taskId);
  if (!taskId) {
    return null;
  }
  const task = await loadGenericLlmTask(db, taskId);
  if (!task || task.taskType !== REPORT_DISCOVERY_TASK_TYPE || task.targetType !== "security"
    || task.targetId !== code || task.status !== "completed" || !task.lastRunId) {
    return null;
  }
  const run = await loadGenericLlmRun(db, task.lastRunId);
  if (!run || run.taskId !== task.taskId || run.status !== "completed") {
    return null;
  }
  const artifact = (await loadGenericLlmRunArtifacts(db, run.runId))
    .find((candidate) => candidate.stepKey === REPORT_DISCOVERY_TASK_TYPE && candidate.status === "complete");
  return artifact ? findCompanyReportDiscoveryRawReport(artifact.output, item) : null;
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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
        const llmRawResponse = await loadCompanyReportLlmRawResponse(c, item);
        results.push({
          ...item,
          forecastSource: "llm_news_report",
          forecasts: analysis.forecasts,
          valuation: analysis.valuation,
          llmRawResponse,
        });
      }
      continue;
    }
    const reportId = companyReportId(item);
    if (!reportId) {
      results.push(item);
      continue;
    }
    const llmRawResponse = await loadCompanyReportLlmRawResponse(c, item);
    const shared = await readSharedReportAnalysis(c.env.DB, sharedReportCacheKeyForItem(item));
    const cached = hasReportAnalysisValues(shared)
      ? shared
      : await readAppJson<ReportForecastExtraction>(c.env.DB, reportForecastCacheKey(reportId));
    if (hasReportAnalysisValues(cached)) {
      const targetPrice = positiveNumberOrUndefined(cached.targetPrice)
        ?? positiveNumberOrUndefined(item.targetPrice);
      results.push({
        ...item,
        forecastSource: "llm_report_source",
        llmRawResponse,
        forecasts: cached.forecasts.length > 0
          ? mergeForecastRows(cached.forecasts, Array.isArray(item.forecasts)
            ? item.forecasts as CompanyReportForecast[]
            : [])
          : item.forecasts,
        ...(targetPrice !== undefined ? { targetPrice } : {}),
      });
      continue;
    }
    if (Array.isArray(item.forecasts) && item.forecasts.length > 0) {
      results.push({ ...item, llmRawResponse });
      continue;
    }
    results.push({ ...item, llmRawResponse });
  }
  return results;
}

function hasReportAnalysisValues(
  value: Pick<ReportForecastExtraction, "forecasts" | "targetPrice"> | SharedReportAnalysis | null | undefined,
): value is Pick<ReportForecastExtraction, "forecasts" | "targetPrice"> {
  return Boolean(value && Array.isArray(value.forecasts)
    && (value.forecasts.length > 0 || positiveNumberOrUndefined(value.targetPrice) !== undefined));
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

export type CompanyReportAnalysis = {
  forecasts: CompanyReportForecast[];
  targetPrice: number | null;
};

export async function extractCompanyReportAnalysisByLlm(
  c: Context<AppEnv>,
  title: string,
  content: string,
  options: LlmExtractionOptions = {},
): Promise<CompanyReportAnalysis> {
  if (c.env.LLM_RUNTIME !== "local") throw new Error("company report LLM extraction is only available in local LLM runtime");
  const trimmed = trimText(formatCompanyReportTextForLlm(content), 12000);
  if (!trimmed) {
    return { forecasts: [], targetPrice: null };
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
    targetType: "company_report_forecast",
    targetId: options.targetId || title,
    idempotencyKey: options.idempotencyKey,
    promptVersion: REPORT_FORECAST_PROMPT_VERSION,
    priority: 500,
    onText: options.onText,
    onStatus: options.onStatus,
  });
  return parseCompanyReportAnalysis(response.text);
}

/** Backward-compatible forecast-only helper used by knowledge processing. */
export async function extractCompanyReportByLlm(
  c: Context<AppEnv>,
  title: string,
  content: string,
  options: LlmExtractionOptions = {},
): Promise<CompanyReportForecast[]> {
  const analysis = await extractCompanyReportAnalysisByLlm(c, title, content, options);
  return analysis.forecasts;
}

export async function extractCompanyNewsReportByLlm(
  c: Context<AppEnv>,
  title: string,
  content: string,
  options: LlmExtractionOptions = {},
): Promise<Omit<CompanyNewsReportAnalysis, "analysisCalled" | "analysisSucceeded" | "updatedAt">> {
  if (c.env.LLM_RUNTIME !== "local") throw new Error("company news report LLM extraction is only available in local LLM runtime");
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
    targetType: "company_news_report",
    targetId: options.targetId || title,
    idempotencyKey: options.idempotencyKey,
    promptVersion: NEWS_REPORT_ANALYSIS_CACHE_VERSION,
    priority: 500,
    onText: options.onText,
    onStatus: options.onStatus,
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
  return parseCompanyReportAnalysis(textBody).forecasts;
}

export function parseCompanyReportTargetPrice(value: unknown): number | null {
  return positiveNumberOrUndefined(value) ?? null;
}

export function parseCompanyReportAnalysis(textBody: string): CompanyReportAnalysis {
  const parsed = parseJsonObjectFromText(textBody);
  if (!parsed || !Array.isArray(parsed.forecasts)) {
    throw new Error("LLM forecast response did not contain a forecasts array");
  }
  return {
    forecasts: parseCompanyReportForecastRows(parsed.forecasts),
    targetPrice: parseCompanyReportTargetPrice(parsed.targetPrice),
  };
}

export function parseCompanyReportDiscovery(
  textBody: string,
  securityCode: string,
  citations: Array<{ title: string; url: string }>,
): CompanyReportDiscoveryCandidate[] {
  return parseCompanyReportDiscoveryWithDiagnostics(textBody, securityCode, citations).reports;
}

function parseCompanyReportDiscoveryWithDiagnostics(
  textBody: string,
  _securityCode: string,
  citations: Array<{ title: string; url: string }>,
): { reports: CompanyReportDiscoveryCandidate[]; rejected: number } {
  const parsed = parseJsonObjectFromText(textBody);
  if (!parsed || !Array.isArray(parsed.reports)) {
    throw new Error("company report discovery response did not contain a reports array");
  }
  const cited = new Set(compactCompanyReportCitations(citations).map((item) => canonicalCompanyReportUrl(item.url)).filter(Boolean));
  const hasCitationMetadata = cited.size > 0;
  let rejected = 0;
  const reports = parsed.reports.flatMap((value): CompanyReportDiscoveryCandidate[] => {
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
    const valuation = row.valuation && typeof row.valuation === "object" && !Array.isArray(row.valuation)
      ? parseCompanyReportValuation(row.valuation as Record<string, unknown>)
      : {};
    return [{
      title,
      ...(institution ? { institution } : {}),
      ...(publishedAt ? { publishedAt } : {}),
      ...(url ? { url } : {}),
      forecasts,
      ...(Object.keys(valuation).length > 0 ? { valuation } : {}),
    }];
  });
  return { reports, rejected };
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

function renderCompanyReportDiscoveryPrompt(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce((result, [key, value]) => result.replaceAll(`{{${key}}}`, value), template);
}

function reportDiscoveryRecentSince(now = Date.now()): string {
  return new Date(now - REPORT_RECENT_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function normalizeCompanyReportDate(value: string): string {
  const raw = value.trim();
  const match = raw.match(/^(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (match) {
    const month = match[2].padStart(2, "0");
    const day = match[3].padStart(2, "0");
    const iso = `${match[1]}-${month}-${day}`;
    return Number.isFinite(Date.parse(iso)) ? iso : "";
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : "";
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
  const forecasts = value
    .map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
      }
      const row = value as Record<string, unknown>;
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
  return `report-forecast:v6:${reportId}`;
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
  targetPrice?: number | null,
): Promise<void> {
  const cacheKey = sharedReportCacheKeyForItem(item);
  if (!cacheKey) {
    return;
  }
  await writeAppJson(db, cacheKey, {
    analysisCalled: true,
    analysisSucceeded: true,
    forecasts,
    ...(positiveNumberOrUndefined(targetPrice) !== undefined ? { targetPrice: positiveNumberOrUndefined(targetPrice) } : {}),
    updatedAt,
  } satisfies SharedReportAnalysis, REPORT_FORECAST_CACHE_TTL_MS);
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

function filterRecentCompanyReports(items: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const cutoff = Date.now() - REPORT_RECENT_DAYS * 24 * 60 * 60 * 1000;
  return items.filter((item) => {
    const sortTime = companyReportSortTime(item);
    // Discovery intentionally keeps candidates whose date is unavailable or
    // unparseable; the prompt treats publication date as optional and the
    // source can be checked later. Dated rows still obey the recent cutoff.
    return sortTime === 0 || sortTime >= cutoff;
  });
}

function companyReportSortTime(item: Record<string, unknown>): number {
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

function normalizeCompanyReportProvenance(item: Record<string, unknown>): Record<string, unknown> {
  return {
    ...item,
    provenance: text(item.provenance) === "web_search" ? "web_search" : "existing",
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
