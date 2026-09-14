import type { Database } from "../../../platform/contracts";
import { fetchEastmoneyCompanyOverview } from "../../../adapters/eastmoney";
import { loadFinancialStatementReadModel } from "../../finance/application/load-financial-statements";
import { selectAnnualIncomeStatements } from "../../finance/domain/annual-income-statements";
import { normalizeSecurityCode } from "../../../shared/codes";
import { externalHttpOptions } from "../../../shared/http";
import { taskdCallerClient, type TaskdTask } from "../../../shared/taskd-client";
import { extractTaskdWebQaResult } from "../../../shared/taskd-webqa-result";
import { observeTaskdReport, submitTaskdReport } from "../../../shared/taskd-report-workflow";
import { REPORT_DISCOVERY_PROMPT } from "../../../generated/prompt-text";
import { type AppEnv, type CompanyOverview } from "../../../types";
import {
  eastmoneyReportInfoCode,
  isReusableReportAnalysisCache,
  runSharedReportAnalysisTask,
  sharedReportAnalysisCacheKey,
} from "./report-analysis-cache";
import {
  type ReportForecastStreamEvent,
  type KnowledgeNewsReportCandidateRow,
  type ReportForecastFailure,
  type LlmExtractionOptions,
  type ReportForecastExtraction,
  type CompanyNewsReportAnalysis,
  type CompanyReportForecast,
  type SharedReportAnalysis,
  type StoredCompanyReportDiscoveryValue,
  type StoredCompanyReportDiscoveryReport,
  type StoredCompanyReportDiscoveryTask,
} from "../domain/report-types";
import { applyCurrentPeToReportItems } from "../domain/report-valuation";
import {
  isCnCode,
  normalizeCompanyReportProvenance,
  mergeCompanyReportsPreferPrimary,
  companyReportId,
  findCompanyReportDiscoveryRawReport,
  mergeForecastRows,
  companyReportSortTime,
} from "../domain/report-identity";
import { round2, text, firstNonEmpty, positiveNumberOrUndefined } from "../domain/report-values";
import {
  REPORT_SOURCE_CACHE_VERSION,
  REPORT_SOURCE_CACHE_TTL_MS,
  REPORT_SOURCE_POOL_SIZE,
  REPORT_DISCOVERY_TASK_TYPE,
  REPORT_LLM_MODEL,
  COMPANY_REPORT_DISCOVERY_JOB_TIMEOUT_MS,
  REPORT_DISCOVERY_PROMPT_VERSION,
  REPORT_PAGE_SIZE,
  NEWS_REPORT_CANDIDATE_LIMIT,
  NEWS_REPORT_ANALYSIS_MAX_CALLS,
  REPORT_FORECAST_MAX_CALLS,
  REPORT_FORECAST_CACHE_TTL_MS,
  NEWS_REPORT_ANALYSIS_CACHE_VERSION,
  REPORT_RECENT_DAYS,
} from "../domain/report-policy";
import {
  readAppJson,
  writeAppJson,
  readStoredCompanyReportDiscovery,
  listCompanyReportDiscoveriesToReconcile,
  writeStoredCompanyReportDiscovery,
} from "../adapters/report-storage";
import {
  fetchEastmoneyCompanyReports,
  fetchSinaCompanyReportsLite,
  loadEastmoneyReportPdfText,
  fetchDecodedPageCached,
  extractSinaReportContent,
} from "../adapters/report-sources";
import {
  normalizeCompanyReportDiscoveryReasoningEffort,
  companyReportDiscoveryTaskName,
  reportDiscoveryRecentSince,
  renderCompanyReportDiscoveryPrompt,
  validateCompanyReportDiscoveryTerminalEvidence,
  companyReportDiscoveryWebQaSearch,
  validateCompanyReportDiscoveryWebSearch,
  parseCompanyReportDiscoveryWithDiagnostics,
  mapCompanyReportDiscoveryCandidate,
} from "../domain/report-discovery";
import {
  isSuccessfulReportAnalysis,
  normalizeCompanyReportRawResponseText,
  hasReportAnalysisValues,
} from "../domain/report-analysis";
import { extractCompanyReportAnalysisWithRawByLlm, extractCompanyNewsReportByLlm } from "./analyze-company-report";

export async function getCompanyReportsWithProgress(
  env: AppEnv["Bindings"],
  code: string,
  page: number,
  onProgress: (event: ReportForecastStreamEvent) => void
): Promise<Array<Record<string, unknown>>> {
  const [sourceItems, overview, actualAnnualProfitByYear] = await Promise.all([
    getCompanyReportsSource(env, code, page),
    fetchCompanyReportPeOverview(env, code),
    loadActualAnnualProfitByYear(env, code),
  ]);
  let items = sourceItems;
  // Production reads persisted forecasts; extraction belongs to the local runtime.
  if (page === 1 && env.LLM_RUNTIME === "local") {
    const failures = await ensureReportForecastsForItemsWithProgress(env, code, items, overview, actualAnnualProfitByYear, onProgress);
    if (failures.length > 0) onProgress({ failures });
  } else {
    onProgress({ progress: { completed: 0, total: 0, title: "" } });
  }
  items = await annotateReportItemsWithForecasts(env, items);
  return applyCurrentPeToReportItems(items, overview, actualAnnualProfitByYear);
}

async function fetchCompanyReportPeOverview(env: AppEnv["Bindings"], code: string): Promise<CompanyOverview | null> {
  const normalized = normalizeSecurityCode(code);
  if (!isCnCode(normalized)) {
    return null;
  }
  try {
    return await fetchEastmoneyCompanyOverview(env.DB, normalized);
  } catch (error) {
    console.warn("company report PE overview unavailable", {
      code: normalized,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function loadActualAnnualProfitByYear(env: AppEnv["Bindings"], code: string): Promise<Map<number, number>> {
  try {
    const financials = await loadFinancialStatementReadModel(env, code, "income", {
      httpOptions: externalHttpOptions(env),
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
  env: AppEnv["Bindings"],
  code: string,
  page: number
): Promise<Array<Record<string, unknown>>> {
  const normalized = normalizeSecurityCode(code);
  if (!isCnCode(normalized)) {
    return [];
  }
  return paginateCompanyReports(await loadMaterializedCompanyReportSourcePool(env, normalized), page);
}

/**
 * The page read and discovery submission share this materialization boundary.
 * Discovery must not depend on the page request winning a cache-write race.
 */
async function loadMaterializedCompanyReportSourcePool(
  env: AppEnv["Bindings"],
  code: string,
): Promise<Array<Record<string, unknown>>> {
  const normalized = normalizeSecurityCode(code);
  const cacheKey = `company-reports-source:${REPORT_SOURCE_CACHE_VERSION}:${normalized}`;
  const cached = await readAppJson<Array<Record<string, unknown>>>(env.DB, cacheKey);
  if (Array.isArray(cached)) {
    return cached.map(normalizeCompanyReportProvenance);
  }
  console.info("company report source pool cache miss; materializing source pool", {
    code: normalized,
    llmRuntime: env.LLM_RUNTIME || "unset",
  });
  const merged = await loadCompanyReportSourcePool(env, normalized);
  await writeAppJson(env.DB, cacheKey, merged, REPORT_SOURCE_CACHE_TTL_MS);
  return merged;
}

async function loadCompanyReportSourcePool(
  env: AppEnv["Bindings"],
  code: string,
  discovered: Array<Record<string, unknown>> = [],
): Promise<Array<Record<string, unknown>>> {
  const normalized = normalizeSecurityCode(code);
  const [eastmoneyItems, sinaItems, newsReportCandidates] = await Promise.all([
    fetchEastmoneyCompanyReports(env, normalized, 1, REPORT_SOURCE_POOL_SIZE),
    fetchSinaCompanyReportsLite(env, normalized, 1).catch((error) => {
      console.warn("company report Sina source unavailable", { code: normalized, error: error instanceof Error ? error.message : String(error) });
      return [] as Array<Record<string, unknown>>;
    }),
    fetchKnowledgeNewsReportCandidates(env, normalized).catch((error) => {
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

export async function enqueueCompanyReportDiscovery(
  env: AppEnv["Bindings"],
  securityCode: string,
  requestedReasoningEffort?: unknown,
) {
  if (env.LLM_RUNTIME !== "local") throw new Error("company report discovery is only available in local LLM runtime");
  const code = normalizeSecurityCode(securityCode);
  if (!isCnCode(code)) throw new Error("company report discovery only supports mainland company codes");
  const reasoningEffort = normalizeCompanyReportDiscoveryReasoningEffort(requestedReasoningEffort);
  await loadMaterializedCompanyReportSourcePool(env, code);
  const prepared = await prepareCompanyReportDiscoveryExecution(env.DB, code, reasoningEffort);
  const name = companyReportDiscoveryTaskName(code);
  const task = await submitTaskdReport(env, { name, taskType: REPORT_DISCOVERY_TASK_TYPE, model: REPORT_LLM_MODEL,
    reasoningEffort: prepared.reasoningEffort as "low" | "medium" | "high" | "xhigh", waitTimeoutMs: prepared.jobTimeoutMs, prompt: prepared.prompt });
  const stored = await persistCompanyReportDiscoveryTaskSnapshot(env.DB, code, await readStoredCompanyReportDiscovery(env.DB, code), task);
  return { accepted: true, task: stored.task };
}

export async function prepareCompanyReportDiscoveryExecution(
  db: Database,
  securityCode: string,
  requestedReasoningEffort?: unknown,
) {
  const code = normalizeSecurityCode(securityCode);
  if (!isCnCode(code)) throw new Error("company report discovery only supports mainland company codes");
  const reasoningEffort = normalizeCompanyReportDiscoveryReasoningEffort(requestedReasoningEffort);
  const recentSince = reportDiscoveryRecentSince();
  const knownReports = await loadCachedCompanyReportDiscoveryKnownReports(db, code);
  return {
    securityCode: code,
    model: REPORT_LLM_MODEL,
    reasoningEffort,
    maxOutputTokens: 8192,
    jobTimeoutMs: COMPANY_REPORT_DISCOVERY_JOB_TIMEOUT_MS,
    promptVersion: REPORT_DISCOVERY_PROMPT_VERSION,
    prompt: renderCompanyReportDiscoveryPrompt(REPORT_DISCOVERY_PROMPT, {
      SECURITY_CODE: code,
      COMPANY_NAME: code,
      RECENT_SINCE: recentSince,
      KNOWN_REPORTS_JSON: JSON.stringify(knownReports),
    }),
  };
}

/**
 * The report page materializes its current source pool in kv_cache before a
 * discovery job is normally queued. Pass only stable report identity fields
 * back to the model: forecast/target-price fields neither identify a report nor
 * help it find a new one.
 */
async function loadCachedCompanyReportDiscoveryKnownReports(
  db: Database,
  code: string,
): Promise<Array<{ title: string; institution: string; publishedAt: string; url: string }>> {
  const cacheKey = `company-reports-source:${REPORT_SOURCE_CACHE_VERSION}:${normalizeSecurityCode(code)}`;
  const cached = await readAppJson<Array<Record<string, unknown>>>(db, cacheKey);
  if (!Array.isArray(cached)) return [];
  return cached.map((item) => ({
    title: text(item.title),
    institution: firstNonEmpty([text(item.orgSName), text(item.orgName), text(item.org), text(item.institution)]),
    publishedAt: firstNonEmpty([text(item.publishDate), text(item.publishedAt)]),
    url: firstNonEmpty([text(item.url), text(item.detailUrl)]),
  })).filter((item) => item.title || item.url);
}

async function projectCompanyReportDiscovery(env: AppEnv["Bindings"], securityCode: string, task: TaskdTask) {
  const result = extractTaskdWebQaResult(task.result);
  validateCompanyReportDiscoveryTerminalEvidence(result.terminalEvidence);
  const responseText = text(result.content.markdown);
  const webSearch = companyReportDiscoveryWebQaSearch(result.citations, result.sources);
  const citations = validateCompanyReportDiscoveryWebSearch(webSearch);
  const code = normalizeSecurityCode(securityCode);
  const parsed = parseCompanyReportDiscoveryWithDiagnostics(responseText, code, citations);
  if (parsed.rejected > 0) console.warn("company report discovery rejected candidates", { code, rejected: parsed.rejected });
  const discoveredRows = parsed.reports.map((item) => mapCompanyReportDiscoveryCandidate(item, code));
  const sourceRows = await loadCompanyReportSourcePool(env, code, discoveredRows);
  await writeAppJson(env.DB, `company-reports-source:${REPORT_SOURCE_CACHE_VERSION}:${code}`, sourceRows, REPORT_SOURCE_CACHE_TTL_MS);
  const projection = { securityCode: code, reportsFound: parsed.reports.length, reportsRejected: parsed.rejected, sourceRows: sourceRows.length, cachedAt: Date.now() };
  await writeStoredCompanyReportDiscovery(env.DB, code, mergeStoredCompanyReportDiscovery(
    await readStoredCompanyReportDiscovery(env.DB, code),
    {
      report: { response: { text: responseText }, projection },
      task: companyReportDiscoveryTaskView(task),
      lastSuccessfulCompletedAt: task.completedAt ?? projection.cachedAt,
    },
  ));
  return projection;
}

function companyReportDiscoveryTaskView(task: TaskdTask) {
  return {
    name: task.name,
    status: companyReportDiscoveryStatus(task.status),
    errorMessage: task.errorMessage,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt,
  };
}

function companyReportDiscoveryStatus(status: TaskdTask["status"]): "queued" | "running" | "completed" | "failed" | "blocked" {
  if (status === "queued" || status === "leased") return "queued";
  if (status === "running") return "running";
  if (status === "succeeded") return "completed";
  if (status === "failed") return "failed";
  return "blocked";
}

function paginateCompanyReports(items: Array<Record<string, unknown>>, page: number): Array<Record<string, unknown>> {
  const offset = (page - 1) * REPORT_PAGE_SIZE;
  return items.slice(offset, offset + REPORT_PAGE_SIZE);
}

async function fetchKnowledgeNewsReportCandidates(
  env: AppEnv["Bindings"],
  code: string,
): Promise<Array<Record<string, unknown>>> {
  const rows = await env.DB.prepare(
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
  env: AppEnv["Bindings"],
  code: string,
  items: Array<Record<string, unknown>>,
  overview: CompanyOverview | null,
  actualAnnualProfitByYear: Map<number, number>,
  onProgress: (event: ReportForecastStreamEvent) => void
): Promise<ReportForecastFailure[]> {
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
  const failures: ReportForecastFailure[] = [];
  onProgress({
    progress: { completed: 0, total: candidates.length, title: "" },
    items: applyCurrentPeToReportItems(items, overview, actualAnnualProfitByYear),
  });
  for (let index = 0; index < candidates.length; index += 1) {
    const item = candidates[index];
    try {
      await ensureSingleReportForecast(env, normalized, item, {
        onText: (delta) => onProgress({ delta }),
        onStatus: (status) => onProgress({ status }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ title: text(item.title), message });
      console.error("company report forecast extraction failed", {
        code: normalized,
        title: text(item.title),
        error: message,
      });
    } finally {
      onProgress({
        progress: {
          completed: index + 1,
          total: candidates.length,
          title: text(item.title),
        },
        items: applyCurrentPeToReportItems(await annotateReportItemsWithForecasts(env, items), overview, actualAnnualProfitByYear),
      });
    }
  }
  return failures;
}

async function ensureSingleReportForecast(
  env: AppEnv["Bindings"],
  code: string,
  item: Record<string, unknown>,
  callbacks: Pick<LlmExtractionOptions, "onText" | "onStatus"> = {},
): Promise<void> {
  if (isKnowledgeNewsReportCandidate(item)) {
    await ensureKnowledgeNewsReportAnalysis(env, item, callbacks);
    return;
  }
  const reportId = companyReportId(item);
  if (!reportId) {
    return;
  }
  const cacheKey = reportForecastCacheKey(reportId);
  const cached = await readAppJson<ReportForecastExtraction>(env.DB, cacheKey);
  // Sina reports have no Eastmoney AP code and therefore no shared cache key.
  // A successful per-report cache is still terminal, including a legitimate
  // empty forecast response, so do not re-call the model on every page load.
  if (isSuccessfulReportAnalysis(cached)) {
    return;
  }
  const sharedCacheKey = sharedReportCacheKeyForItem(item);
  let shared = await readSharedReportAnalysis(env.DB, sharedCacheKey);
  if (shared?.analysisCalled) {
    return;
  }

  await runSharedReportAnalysisTask(sharedCacheKey, async () => {
    const completedByAnotherRequest = await readSharedReportAnalysis(env.DB, sharedCacheKey);
    if (completedByAnotherRequest?.analysisCalled) {
      return;
    }
    const reportContent = await loadReportContentForForecast(env, item);
    if (!reportContent) {
      return;
    }
    const extractionResult = await extractCompanyReportAnalysisWithRawByLlm(env, text(item.title), reportContent.content, {
      onText: callbacks.onText,
    });
    const analysis = extractionResult.analysis;
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
      rawResponseText: extractionResult.rawResponseText,
    };
    await Promise.all([
      writeAppJson(env.DB, cacheKey, extraction, REPORT_FORECAST_CACHE_TTL_MS),
      writeSharedReportAnalysis(env.DB, item, analysis.forecasts, updatedAt, analysis.targetPrice, extractionResult.rawResponseText),
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
  env: AppEnv["Bindings"],
  item: Record<string, unknown>,
  callbacks: Pick<LlmExtractionOptions, "onText" | "onStatus"> = {},
): Promise<void> {
  const cacheKey = knowledgeNewsReportAnalysisCacheKey(item);
  if (!cacheKey || await readKnowledgeNewsReportAnalysis(env.DB, cacheKey)) {
    return;
  }
  await runSharedReportAnalysisTask(cacheKey, async () => {
    if (await readKnowledgeNewsReportAnalysis(env.DB, cacheKey)) {
      return;
    }
    const content = await loadKnowledgeNewsReportContent(env, item);
    if (!content) {
      return;
    }
    const docId = text(item.knowledgeDocId);
    const analysis = await extractCompanyNewsReportByLlm(env, text(item.title), content, {
      onText: callbacks.onText,
      onStatus: callbacks.onStatus,
      targetId: docId,
      idempotencyKey: `company-news-report:${docId}`,
    });
    await writeAppJson(env.DB, cacheKey, {
      ...analysis,
      analysisCalled: true,
      analysisSucceeded: true,
      updatedAt: Date.now(),
    } satisfies CompanyNewsReportAnalysis, REPORT_FORECAST_CACHE_TTL_MS);
  });
}

async function loadKnowledgeNewsReportContent(
  env: AppEnv["Bindings"],
  item: Record<string, unknown>,
): Promise<string> {
  const key = text(item.contentKey);
  const publicBaseUrl = text(env.KNOWLEDGE_CONTENT_PUBLIC_BASE_URL).replace(/\/+$/, "");
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
  db: Database,
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
    && Object.prototype.hasOwnProperty.call(cached, "targetPrice")
    ? cached
    : null;
}

async function loadCompanyReportDiscoveryRawReport(
  env: AppEnv["Bindings"],
  item: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const code = normalizeSecurityCode(text(item.code));
  if (!code) {
    return null;
  }
  const stored = await loadCompanyReportDiscoverySnapshot(env, code);
  if (!stored?.report?.response.text) {
    return null;
  }
  return findCompanyReportDiscoveryRawReport(stored.report, item);
}

async function annotateReportItemsWithForecasts(
  env: AppEnv["Bindings"],
  items: Array<Record<string, unknown>>
): Promise<Array<Record<string, unknown>>> {
  const results: Array<Record<string, unknown>> = [];
  for (const item of items) {
    if (isKnowledgeNewsReportCandidate(item)) {
      const analysis = await readKnowledgeNewsReportAnalysis(env.DB, knowledgeNewsReportAnalysisCacheKey(item));
      if (analysis?.isCompanyReport) {
        const llmRawResponse = await loadCompanyReportDiscoveryRawReport(env, item)
          ?? normalizeCompanyReportRawResponseText(analysis.rawResponseText);
        results.push({
          ...item,
          forecastSource: "llm_news_report",
          forecasts: analysis.forecasts,
          targetPrice: analysis.targetPrice,
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
    const discoveryLlmRawResponse = await loadCompanyReportDiscoveryRawReport(env, item);
    const shared = await readSharedReportAnalysis(env.DB, sharedReportCacheKeyForItem(item));
    const reportCache = await readAppJson<ReportForecastExtraction>(env.DB, reportForecastCacheKey(reportId));
    const cached = hasReportAnalysisValues(shared) || isSuccessfulReportAnalysis(shared)
      ? shared
      : reportCache;
    const llmRawResponse = discoveryLlmRawResponse ?? normalizeCompanyReportRawResponseText(cached?.rawResponseText);
    if (hasReportAnalysisValues(cached) || isSuccessfulReportAnalysis(cached)) {
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

async function loadReportContentForForecast(
  env: AppEnv["Bindings"],
  item: Record<string, unknown>
): Promise<{ content: string; source: string } | null> {
  const infoCode = eastmoneyReportInfoCode(item.infoCode, item.url, item.detailUrl);
  if (infoCode) {
    const content = await loadEastmoneyReportPdfText(env, infoCode);
    return content ? { content, source: "eastmoney_pdf" } : null;
  }
  const url = text(item.detailUrl) || text(item.url);
  if (!url) {
    return null;
  }
  const html = await fetchDecodedPageCached(env, `sina-report-detail:${url}`, url, REPORT_FORECAST_CACHE_TTL_MS);
  const content = extractSinaReportContent(html);
  return content ? { content, source: "sina_html" } : null;
}

function reportForecastCacheKey(reportId: string): string {
  return `report-forecast:v6:${reportId}`;
}

function sharedReportCacheKeyForItem(item: Record<string, unknown>): string {
  const infoCode = eastmoneyReportInfoCode(item.infoCode, item.url, item.detailUrl);
  return sharedReportAnalysisCacheKey(infoCode);
}

async function readSharedReportAnalysis(
  db: Database,
  cacheKey: string,
): Promise<SharedReportAnalysis | null> {
  if (!cacheKey) {
    return null;
  }
  const cached = await readAppJson<SharedReportAnalysis>(db, cacheKey);
  return isReusableReportAnalysisCache(cached) ? cached : null;
}

async function writeSharedReportAnalysis(
  db: Database,
  item: Record<string, unknown>,
  forecasts: CompanyReportForecast[],
  updatedAt: number,
  targetPrice?: number | null,
  rawResponseText?: string,
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
    ...(text(rawResponseText) ? { rawResponseText: text(rawResponseText) } : {}),
    updatedAt,
  } satisfies SharedReportAnalysis, REPORT_FORECAST_CACHE_TTL_MS);
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

function reportNeedsLlmExtraction(item: Record<string, unknown>): boolean {
  return text(item.detailUrl).includes("sina.com.cn") || text(item.url).includes("sina.com.cn");
}

function reportForecastNeedsLlmRefresh(item: Record<string, unknown>): boolean {
  if (!reportNeedsLlmExtraction(item) && !eastmoneyReportInfoCode(item.infoCode, item.url, item.detailUrl)) {
    return false;
  }
  return true;
}

export async function loadCompanyReportDiscoverySnapshot(
  env: AppEnv["Bindings"],
  securityCode: string,
): Promise<StoredCompanyReportDiscoveryValue | null> {
  const code = normalizeSecurityCode(securityCode);
  return readStoredCompanyReportDiscovery(env.DB, code);
}

/** Explicit observation/projection; normal report-page reads never contact taskd. */
export async function syncCompanyReportDiscovery(env: AppEnv["Bindings"], securityCode: string): Promise<StoredCompanyReportDiscoveryValue | null> {
  if (env.LLM_RUNTIME !== "local") throw new Error("company report discovery synchronization is only available in local LLM runtime");
  const code = normalizeSecurityCode(securityCode);
  let stored = await readStoredCompanyReportDiscovery(env.DB, code);
  if (env.LLM_RUNTIME !== "local" || !shouldQueryTaskdForCompanyReportDiscovery(stored)) {
    return stored;
  }
  if (!stored?.task) return stored;
  const state = await observeTaskdReport({
    client: taskdCallerClient(env), expected: { ...stored.task, taskId: null },
    project: (task) => projectCompanyReportDiscovery(env, code, task),
  });
  switch (state.state) {
    case "projected":
      return await readStoredCompanyReportDiscovery(env.DB, code);
    case "pending":
    case "failed":
    case "interrupted":
    case "superseded":
      stored = await persistCompanyReportDiscoveryTaskSnapshot(env.DB, code, stored, state.task);
      return stored;
    case "missing":
      if (stored?.task) {
        stored = await persistCompanyReportDiscoveryTaskSnapshot(env.DB, code, stored, null);
      }
      return stored;
  }
}

/** Local lifecycle polling across all report-search keys, without a new table. */
export async function reconcileCompanyReportDiscoveries(env: AppEnv["Bindings"], onError: (code: string, error: unknown) => void = () => {}): Promise<{ inspected: number; failed: number }> {
  if (env.LLM_RUNTIME !== "local") return { inspected: 0, failed: 0 };
  const codes = await listCompanyReportDiscoveriesToReconcile(env.DB);
  let failed = 0;
  for (const code of codes) {
    try { await syncCompanyReportDiscovery(env, code); }
    catch (error) { failed += 1; onError(code, error); }
  }
  return { inspected: codes.length, failed };
}

async function persistCompanyReportDiscoveryTaskSnapshot(
  db: Database,
  securityCode: string,
  current: StoredCompanyReportDiscoveryValue | null,
  task: TaskdTask | null,
): Promise<StoredCompanyReportDiscoveryValue> {
  const stored = mergeStoredCompanyReportDiscovery(current, {
    task: task ? companyReportDiscoveryTaskView(task) : null,
    lastSuccessfulCompletedAt: task?.status === "succeeded"
      ? (task.completedAt ?? current?.lastSuccessfulCompletedAt ?? null)
      : current?.lastSuccessfulCompletedAt ?? null,
  });
  await writeStoredCompanyReportDiscovery(db, securityCode, stored);
  return stored;
}

function shouldQueryTaskdForCompanyReportDiscovery(value: StoredCompanyReportDiscoveryValue | null): boolean {
  return value?.task?.status === "queued" || value?.task?.status === "running";
}

function mergeStoredCompanyReportDiscovery(
  current: StoredCompanyReportDiscoveryValue | null,
  patch: {
    report?: StoredCompanyReportDiscoveryReport | null;
    task?: StoredCompanyReportDiscoveryTask | null;
    lastSuccessfulCompletedAt?: number | null;
  },
): StoredCompanyReportDiscoveryValue {
  return {
    report: patch.report !== undefined ? patch.report : current?.report ?? null,
    task: patch.task !== undefined ? patch.task : current?.task ?? null,
    lastSuccessfulCompletedAt: patch.lastSuccessfulCompletedAt !== undefined
      ? patch.lastSuccessfulCompletedAt
      : current?.lastSuccessfulCompletedAt ?? null,
  };
}
