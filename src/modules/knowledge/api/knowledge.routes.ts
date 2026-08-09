import { Hono } from "hono";
import { fetchEastmoneyCompanyOverview } from "../../../adapters/eastmoney";
import { getAppKv, putAppKv } from "../../../db/queries";
import { fail, ok } from '../../../shared/http';
import { externalHttpOptions } from '../../../shared/http';
import { normalizeSupportedCompanyCode } from "../../../shared/codes";
import { isLocalDevelopmentRuntime } from "../../../shared/request";
import { extractCompanyReportByLlm, type CompanyReportForecast } from "../../company/api/company.routes";
import {
  eastmoneyReportInfoCode,
  isReusableReportAnalysisCache,
  runSharedReportAnalysisTask,
  sharedReportAnalysisCacheKey,
} from "../../company/application/report-analysis-cache";
import { loadFinancialStatementReadModel } from "../../finance/application/load-financial-statements";
import { selectAnnualIncomeStatements } from "../../finance/domain/annual-income-statements";
import { INFORMATION_PROCESSING_PROMPT_VERSION, type InformationProcessingModelRequest } from "../application/information-processing";
import { listKnowledgeCompanyCodeMappings, refreshKnowledgeCompanyCodeMappings } from "../application/company-code-mappings";
import {
  claimAndPrepareInformationProcessingJob,
  completeClaimedInformationProcessingJob,
  failClaimedInformationProcessingJob,
  heartbeatInformationProcessingJob,
} from "../application/information-processing-jobs";
import type { AppEnv } from '../../../types';

export const knowledgeRoutes = new Hono<AppEnv>();

type KnowledgeDocRow = {
  doc_id: string;
  source_type: string;
  report_type: string | null;
  source_name: string | null;
  title: string;
  url: string | null;
  published_at: string | null;
  fetched_at: string | null;
  event_time: string | null;
  target_name: string | null;
  target_code: string | null;
  access_method: string | null;
  summary: string | null;
  content_key: string | null;
  content_url: string | null;
  content_preview: string | null;
  metadata_json: string | null;
  recommendation_tags_json: string | null;
  content_type: string | null;
  content_encoding: string | null;
  content_bytes: number | null;
  content_sha256: string | null;
  information_outcome: string | null;
  information_entities: string | null;
  information_types: string | null;
  information_categories: string | null;
};

type KnowledgeContentRefRow = {
  content_key: string | null;
  content_url: string | null;
  content_type: string | null;
  content_encoding: string | null;
  content_bytes: number | null;
  content_sha256: string | null;
};

type KnowledgeReportAnalysisRow = KnowledgeDocRow;

type KnowledgeReportAnalysis = {
  analysisCalled: boolean;
  analysisSucceeded?: boolean;
  forecasts: CompanyReportForecast[];
  updatedAt: number;
};

const KNOWLEDGE_REPORT_ANALYSIS_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_KNOWLEDGE_REPORT_ANALYSIS_CONCURRENCY = 2;
let knowledgeReportAnalysisActive = 0;
const knowledgeReportAnalysisWaiters: Array<() => void> = [];
const knowledgeReportAnalysisInFlight = new Map<string, Promise<KnowledgeReportAnalysis>>();

type KnowledgeDocsQuery = {
  sourceType: string;
  source: string;
  industry: string;
  code: string;
  tags: string[];
  informationTags: string[];
  informationEntity: string;
  informationCategory: string;
  q: string;
  page: number;
  pageSize: number;
};

type KnowledgeContentUrlContext = {
  local: boolean;
  origin: string;
  publicBaseUrl: string;
};

type KnowledgeFilteredDocRow = {
  doc_id: string;
  source_type: string;
  report_type: string | null;
  source_name: string | null;
  title: string;
  url: string | null;
  published_at: string | null;
  fetched_at: string | null;
  event_time: string | null;
  target_name: string | null;
  target_code: string | null;
  access_method: string | null;
  summary: string | null;
  content_key: string | null;
  content_url: string | null;
  content_type: string | null;
  content_encoding: string | null;
  content_bytes: number | null;
  content_sha256: string | null;
  content_preview: string | null;
  metadata_json: string | null;
  filter_method: string | null;
  filter_score: number;
  filter_confidence: number | null;
  filter_reasons_json: string | null;
  source_file: string | null;
  reviewed_status: string;
  reviewed_at: number | null;
  updated_at: number;
};

const KNOWLEDGE_DOC_BASE_SELECT = `select d.doc_id, d.source_type, d.report_type, d.source_name, d.title, d.url,
  d.published_at, d.fetched_at, d.event_time, d.target_name, d.target_code,
  d.access_method, d.summary, c.content_key, c.content_url, d.content_preview, d.metadata_json,
  d.recommendation_tags_json, c.content_type, c.content_encoding, c.content_bytes, c.content_sha256,
  information.outcome as information_outcome,
  (select group_concat(distinct record.entity) from knowledge_information_records record where record.result_id = information.result_id) as information_entities,
  (select group_concat(distinct record.information_type) from knowledge_information_records record where record.result_id = information.result_id) as information_types,
  (select group_concat(distinct record.category) from knowledge_information_records record where record.result_id = information.result_id) as information_categories
 from knowledge_docs d
 left join knowledge_doc_content_refs c on c.doc_id = d.doc_id
 left join knowledge_document_versions information_version on information_version.version_id = (
   select v.version_id from knowledge_document_versions v where v.doc_id = d.doc_id order by v.created_at desc, v.version_id desc limit 1
 )
 left join knowledge_document_results information on information.result_id = (
   select r.result_id from knowledge_document_results r where r.version_id = information_version.version_id order by r.created_at desc, r.result_id desc limit 1
 )`;

const KNOWLEDGE_DOC_LIST_SELECT = KNOWLEDGE_DOC_BASE_SELECT;

const KNOWLEDGE_DOC_TIME_ORDER = "d.sort_time desc, d.rank_score desc, d.doc_id desc";

const KNOWLEDGE_FILTERED_DETAIL_SELECT = `select d.doc_id, d.source_type, d.report_type, d.source_name, d.title, d.url,
  d.published_at, d.fetched_at, d.event_time, d.target_name, d.target_code, d.access_method, d.summary,
  c.content_key, c.content_url, c.content_type, c.content_encoding, c.content_bytes, c.content_sha256,
  d.content_preview, d.metadata_json, d.filter_method, d.filter_score, d.filter_confidence,
  d.filter_reasons_json, d.source_file, d.reviewed_status, d.reviewed_at, d.updated_at
 from knowledge_filtered_docs d
 left join knowledge_filtered_doc_content_refs c on c.doc_id = d.doc_id`;

const KNOWLEDGE_FILTERED_LIST_SELECT = `select d.doc_id, d.source_type, d.report_type, d.source_name, d.title, d.url,
  d.published_at, d.fetched_at, d.event_time, d.target_name, d.target_code, d.access_method, d.summary,
  null as content_key, null as content_url, null as content_type, null as content_encoding, 0 as content_bytes, null as content_sha256,
  d.content_preview, d.metadata_json, d.filter_method, d.filter_score, d.filter_confidence,
  d.filter_reasons_json, d.source_file, d.reviewed_status, d.reviewed_at, d.updated_at
 from knowledge_filtered_docs d`;

knowledgeRoutes.get("/knowledge/docs", async (c) => {
  const query = parseDocsQuery(c.req.query());
  if (query.q && !isKnowledgeTextSearchEnabled(c.env)) {
    return fail(c, 400, "keyword search is only enabled for local development");
  }
  const { whereSql, binds } = buildKnowledgeWhere(query);
  const deduped = await listKnowledgeDocsDeduped(c.env.DB, query, whereSql, binds, knowledgeContentUrlContext(c));
  return ok(c, {
    page: query.page,
    page_size: query.pageSize,
    total: deduped.total,
    has_next: deduped.hasNext,
    list: deduped.list,
  });
});

knowledgeRoutes.get("/knowledge/doc", async (c) => {
  const id = c.req.query("id")?.trim() ?? "";
  if (!id) {
    return fail(c, 400, "missing doc id");
  }
  const row = await c.env.DB.prepare(
    `${KNOWLEDGE_DOC_BASE_SELECT}
     where d.doc_id = ?`
  )
    .bind(id)
    .first<KnowledgeDocRow>();
  if (!row) {
    return fail(c, 404, `knowledge document not found: ${id}`);
  }
  const item = mapKnowledgeDocListItem(row, knowledgeContentUrlContext(c));
  await enrichKnowledgeDocCompanyMappings(c.env.DB, [item]);
  return ok(c, item);
});

knowledgeRoutes.get("/knowledge/documents/:id/structured", async (c) => {
  const document = await c.env.DB.prepare(
    `select d.doc_id, d.title, d.url, d.source_name, d.source_type, d.report_type,
            d.published_at, d.fetched_at, d.event_time, d.summary, d.content_preview,
            c.content_key, c.content_url
       from knowledge_docs d
       left join knowledge_doc_content_refs c on c.doc_id = d.doc_id
      where d.doc_id = ?`,
  ).bind(c.req.param("id")).first<Record<string, unknown>>();
  const versions = await c.env.DB.prepare(
    `select v.*, p.action as preprocessing_action, p.reason_code, p.rule_version, p.details_json
       from knowledge_document_versions v
       left join knowledge_preprocessing_decisions p on p.decision_id = (
         select p2.decision_id from knowledge_preprocessing_decisions p2 where p2.version_id = v.version_id order by p2.decided_at desc limit 1
       ) where v.doc_id = ? order by v.created_at desc`,
  ).bind(c.req.param("id")).all<Record<string, unknown>>();
  if (versions.results.length === 0) return fail(c, 404, "structured knowledge document not found");
  const result = await c.env.DB.prepare(
    `select d.* from knowledge_document_results d join knowledge_processing_runs r on r.run_id = d.run_id
      where d.version_id = ? order by d.created_at desc limit 1`,
  ).bind(String(versions.results[0].version_id)).first<Record<string, unknown>>();
  const records = result ? await c.env.DB.prepare(
    `select information_id, entity, information_type, category, period, statement, sort_order, created_at
       from knowledge_information_records where result_id = ? order by sort_order, information_id`,
  ).bind(String(result.result_id)).all<Record<string, unknown>>() : { results: [] as Record<string, unknown>[] };
  const runs = await c.env.DB.prepare("select * from knowledge_processing_runs where version_id = ? order by started_at desc")
    .bind(String(versions.results[0].version_id)).all<Record<string, unknown>>();
  return ok(c, {
    document: document ? {
      doc_id: document.doc_id,
      title: document.title,
      url: document.url,
      source_name: document.source_name,
      source_type: document.source_type,
      report_type: document.report_type,
      published_at: document.published_at,
      fetched_at: document.fetched_at,
      event_time: document.event_time,
      summary: document.summary,
      content_preview: document.content_preview,
      content_url: resolveKnowledgeContentUrl(
        document as Pick<KnowledgeContentRefRow, "content_key" | "content_url">,
        knowledgeContentUrlContext(c),
      ),
    } : null,
    versions: versions.results.map(mapInformationRow), result: result ? mapInformationRow(result) : null,
    records: records.results.map(mapInformationRow),
    runs: runs.results.map(mapInformationRow),
  });
});

knowledgeRoutes.get("/knowledge/processed-documents", async (c) => {
  const q = (c.req.query("q") || "").trim().toLowerCase();
  const outcome = (c.req.query("outcome") || "").trim();
  const page = Math.max(1, Number(c.req.query("page") || 1));
  const pageSize = Math.min(100, Math.max(1, Number(c.req.query("pageSize") || 20)));
  const conditions = [outcome ? "r.outcome = ?" : "r.outcome in ('extracted', 'needs_review')"];
  const binds: Array<string | number> = [];
  if (outcome) binds.push(outcome);
  if (q) {
    conditions.push("(lower(d.title) like ? or exists (select 1 from knowledge_information_records record where record.result_id = r.result_id and (lower(record.entity) like ? or lower(record.statement) like ? or lower(record.category) like ?)))");
    const pattern = `%${q}%`; binds.push(pattern, pattern, pattern, pattern);
  }
  const where = conditions.join(" and ");
  const base = `from knowledge_docs d
    join knowledge_document_versions v on v.version_id = (
      select v2.version_id from knowledge_document_versions v2 where v2.doc_id = d.doc_id order by v2.created_at desc limit 1
    )
    join knowledge_document_results r on r.result_id = (
      select r2.result_id from knowledge_document_results r2 where r2.version_id = v.version_id order by r2.created_at desc limit 1
    )`;
  const total = await c.env.DB.prepare(`select count(*) as count ${base} where ${where}`).bind(...binds).first<{ count: number }>();
  const rows = await c.env.DB.prepare(
    `select d.doc_id, d.title, d.source_type, d.report_type, d.source_name, d.published_at, d.event_time,
            r.outcome, r.created_at as processed_at,
            (select count(*) from knowledge_information_records record where record.result_id = r.result_id) as record_count
       ${base} where ${where} order by r.created_at desc limit ? offset ?`,
  ).bind(...binds, pageSize, (page - 1) * pageSize).all<Record<string, unknown>>();
  return ok(c, {
    page, page_size: pageSize, total: total?.count || 0,
    has_next: (page * pageSize) < (total?.count || 0), list: rows.results.map(mapInformationRow),
  });
});

knowledgeRoutes.get("/knowledge/information-records", async (c) => {
  const entity = (c.req.query("entity") || "").trim();
  const informationType = (c.req.query("information_type") || "").trim();
  const category = (c.req.query("category") || "").trim();
  const page = Math.max(1, Number(c.req.query("page") || 1));
  const pageSize = Math.min(100, Math.max(1, Number(c.req.query("pageSize") || 20)));
  const summaryConditions = [
    "r.outcome = 'extracted'",
    `v.version_id = (
      select v2.version_id from knowledge_document_versions v2
       where v2.doc_id = d.doc_id
       order by v2.created_at desc, v2.version_id desc limit 1
    )`,
    `r.result_id = (
      select r2.result_id from knowledge_document_results r2
       where r2.version_id = v.version_id
       order by r2.created_at desc, r2.result_id desc limit 1
    )`,
  ];
  const summaryBinds: Array<string | number> = [];
  if (entity) {
    summaryConditions.push("lower(record.entity) = lower(?)");
    summaryBinds.push(entity);
  }
  const conditions = [...summaryConditions];
  const binds = [...summaryBinds];
  if (informationType) {
    conditions.push("record.information_type = ?");
    binds.push(informationType);
  }
  if (category) {
    conditions.push("record.category = ?");
    binds.push(category);
  }
  const summaryWhere = summaryConditions.join(" and ");
  const where = conditions.join(" and ");
  const base = `from knowledge_information_records record
    join knowledge_document_results r on r.result_id = record.result_id
    join knowledge_document_versions v on v.version_id = r.version_id
    join knowledge_docs d on d.doc_id = v.doc_id`;
  const [total, informationTypes, categories, rows] = await Promise.all([
    c.env.DB.prepare(`select count(*) as count ${base} where ${where}`).bind(...binds).first<{ count: number }>(),
    c.env.DB.prepare(
      `select record.information_type as value, count(*) as count ${base} where ${summaryWhere}
       group by record.information_type order by count(*) desc, value asc`,
    ).bind(...summaryBinds).all<Record<string, unknown>>(),
    c.env.DB.prepare(
      `select record.category as value, count(*) as count ${base} where ${summaryWhere}
       group by record.category order by count(*) desc, value asc`,
    ).bind(...summaryBinds).all<Record<string, unknown>>(),
    c.env.DB.prepare(
      `select record.information_id, record.entity, record.information_type, record.category, record.period, record.statement,
            record.sort_order, record.created_at, d.doc_id, d.title, d.source_name, d.source_type, d.report_type,
            d.published_at, d.event_time, r.created_at as processed_at
       ${base} where ${where}
       order by d.published_at desc, record.sort_order asc, record.information_id asc limit ? offset ?`,
    ).bind(...binds, pageSize, (page - 1) * pageSize).all<Record<string, unknown>>(),
  ]);
  return ok(c, {
    entity: entity || null,
    information_type: informationType || null,
    category: category || null,
    page, page_size: pageSize, total: total?.count || 0,
    has_next: (page * pageSize) < (total?.count || 0),
    information_types: informationTypes.results.map(mapInformationRow),
    categories: categories.results.map(mapInformationRow),
    list: rows.results.map(mapInformationRow),
  });
});

knowledgeRoutes.get("/knowledge/processing-runs/:id", async (c) => {
  const run = await c.env.DB.prepare("select * from knowledge_processing_runs where run_id = ?").bind(c.req.param("id")).first<Record<string, unknown>>();
  if (!run) return fail(c, 404, "knowledge processing run not found");
  return ok(c, mapInformationRow(run));
});

knowledgeRoutes.post("/knowledge/processing-jobs", async (c) => {
  if (!isLocalInformationProcessingRuntime(c.env)) return fail(c, 404, "information processing jobs are only available in local LLM runtime");
  const body = await c.req.json().catch(() => ({})) as {
    documentId?: string;
    documentIds?: string[];
    auto?: boolean;
    concurrency?: number;
    maxDocuments?: number;
    maxAgeDays?: number;
    triggerSource?: string;
    titleKeywords?: string[];
  };
  const requestedIds = [body.documentId, ...(Array.isArray(body.documentIds) ? body.documentIds : [])]
    .map((id) => String(id || "").trim()).filter(Boolean);
  const triggerSource = normalizeInformationTriggerSource(body.triggerSource);
  const titleKeywords = (Array.isArray(body.titleKeywords) ? body.titleKeywords : [])
    .map((keyword) => String(keyword || "").trim()).filter(Boolean).slice(0, 100);
  if (requestedIds.length > 0) await enqueueInformationDocuments(c.env.DB, [...new Set(requestedIds)], triggerSource);
  if (requestedIds.length === 0 && !body.auto) return fail(c, 400, "missing documentId");
  const maxDocuments = Math.min(200, Math.max(1, Number(body.maxDocuments) || Number(body.concurrency) || 1));
  const maxAgeDays = Math.min(365, Math.max(1, Number(body.maxAgeDays) || 30));
  const automaticallyEnqueuedIds = body.auto
    ? await enqueueUnprocessedInformationDocuments(c.env.DB, maxAgeDays, maxDocuments, titleKeywords, triggerSource)
    : [];
  return ok(c, {
    automatic: Boolean(body.auto),
    enqueued: requestedIds.length,
    auto_enqueued: automaticallyEnqueuedIds.length,
    max_documents: maxDocuments,
    max_age_days: body.auto ? maxAgeDays : null,
    status: "queued",
  });
});

// These three endpoints form the local Node-runner boundary. The Worker only
// prepares/persists D1/R2 state; it must never await a remote model stream.
knowledgeRoutes.post("/knowledge/processing-jobs/claim-next", async (c) => {
  if (!isLocalInformationProcessingRuntime(c.env)) return fail(c, 404, "information processing jobs are only available in local LLM runtime");
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  if (typeof body.runnerInstanceId !== "string" || !body.runnerInstanceId.trim()) return fail(c, 400, "runnerInstanceId is required");
  try {
    return ok(c, { job: await claimAndPrepareInformationProcessingJob(c.env, body.runnerInstanceId) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // This endpoint is polled by local-job-worker. A SQLite/API failure remains
    // an explicit retryable boundary response rather than an opaque route error.
    return fail(c, 503, `information processing queue unavailable: ${message}`);
  }
});

knowledgeRoutes.post("/knowledge/processing-jobs/:jobId/complete", async (c) => {
  if (!isLocalInformationProcessingRuntime(c.env)) return fail(c, 404, "information processing jobs are only available in local LLM runtime");
  const body = await c.req.json().catch(() => null) as { request?: InformationProcessingModelRequest; text?: unknown; raw?: unknown; cached?: unknown; runnerInstanceId?: unknown; attempt?: unknown } | null;
  const request = body?.request;
  const runnerInstanceId = typeof body?.runnerInstanceId === "string" ? body.runnerInstanceId : "";
  const attempt = Number(body?.attempt);
  if (!request || typeof body?.text !== "string" || !runnerInstanceId || !Number.isInteger(attempt)) return fail(c, 400, "invalid information processing completion");
  try {
    return ok(c, await completeClaimedInformationProcessingJob(c.env, c.req.param("jobId"), { request, text: body.text, raw: body.raw, cached: body.cached === true, runnerInstanceId, attempt }));
  } catch (error) {
    return fail(c, /lease is no longer owned/.test(error instanceof Error ? error.message : String(error)) ? 409 : 400, error instanceof Error ? error.message : String(error));
  }
});

knowledgeRoutes.post("/knowledge/processing-jobs/:jobId/fail", async (c) => {
  if (!isLocalInformationProcessingRuntime(c.env)) return fail(c, 404, "information processing jobs are only available in local LLM runtime");
  const body = await c.req.json().catch(() => null) as { request?: InformationProcessingModelRequest; error?: unknown; runnerInstanceId?: unknown; attempt?: unknown } | null;
  const request = body?.request;
  const runnerInstanceId = typeof body?.runnerInstanceId === "string" ? body.runnerInstanceId : "";
  const attempt = Number(body?.attempt);
  if (!request || !runnerInstanceId || !Number.isInteger(attempt)) return fail(c, 400, "invalid information processing failure");
  const message = typeof body?.error === "string" && body.error.trim() ? body.error.trim() : "local information processing runner failed";
  try { await failClaimedInformationProcessingJob(c.env, c.req.param("jobId"), { request, error: message, runnerInstanceId, attempt }); return ok(c, { status: "failed" }); }
  catch (error) { return fail(c, /lease is no longer owned/.test(error instanceof Error ? error.message : String(error)) ? 409 : 400, error instanceof Error ? error.message : String(error)); }
});

knowledgeRoutes.post("/knowledge/processing-jobs/:jobId/heartbeat", async (c) => {
  if (!isLocalInformationProcessingRuntime(c.env)) return fail(c, 404, "information processing jobs are only available in local LLM runtime");
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const runnerInstanceId = typeof body.runnerInstanceId === "string" ? body.runnerInstanceId : "";
  const attempt = Number(body.attempt);
  if (!runnerInstanceId.trim() || !Number.isInteger(attempt)) return fail(c, 400, "runnerInstanceId and attempt are required");
  try {
    return ok(c, { active: await heartbeatInformationProcessingJob(c.env.DB, c.req.param("jobId"), runnerInstanceId, attempt) });
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

knowledgeRoutes.post("/knowledge/processing-jobs/:id/retry", async (c) => {
  if (!isLocalInformationProcessingRuntime(c.env)) return fail(c, 404, "information processing jobs are only available in local LLM runtime");
  const row = await c.env.DB.prepare("select v.doc_id from knowledge_processing_runs r join knowledge_document_versions v on v.version_id = r.version_id where r.run_id = ?")
    .bind(c.req.param("id")).first<{ doc_id: string }>();
  if (!row) return fail(c, 404, "knowledge processing run not found");
  await enqueueInformationDocuments(c.env.DB, [row.doc_id], "manual");
  return ok(c, { documentId: row.doc_id, status: "queued" });
});

knowledgeRoutes.post("/knowledge/report-analysis", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { id?: string };
  const id = String(body.id || "").trim();
  if (!id) {
    return fail(c, 400, "missing doc id");
  }
  const row = await c.env.DB.prepare(
    `${KNOWLEDGE_DOC_BASE_SELECT}
     where d.doc_id = ?`
  )
    .bind(id)
    .first<KnowledgeReportAnalysisRow>();
  if (!row) {
    return fail(c, 404, `knowledge document not found: ${id}`);
  }
  if (row.source_type !== "research_report" || row.report_type !== "company_report") {
    return fail(c, 400, "document is not a company report");
  }

  const metadata = parseJsonObject(row.metadata_json);
  const cacheKey = `knowledge-report-analysis:${id}`;
  const rawMetadata = metadata.raw && typeof metadata.raw === "object" && !Array.isArray(metadata.raw)
    ? metadata.raw as Record<string, unknown>
    : {};
  const sharedCacheKey = sharedReportAnalysisCacheKey(eastmoneyReportInfoCode(
    metadata.infoCode,
    rawMetadata.infoCode,
    row.url,
  ));
  const legacyAnalysis = await readKnowledgeReportAnalysis(c.env.DB, cacheKey);
  const sharedAnalysis = await readKnowledgeReportAnalysis(c.env.DB, sharedCacheKey);
  let analysis = legacyAnalysis || sharedAnalysis;
  if (legacyAnalysis && sharedCacheKey && !sharedAnalysis) {
    await writeKnowledgeReportAnalysis(c.env.DB, sharedCacheKey, legacyAnalysis);
  }
  if (!analysis) {
    await runSharedReportAnalysisTask(
      sharedCacheKey,
      async () => {
        await runKnowledgeReportAnalysisTask(
          id,
          knowledgeReportAnalysisConcurrency(c.env),
          async () => {
            const cached = await readKnowledgeReportAnalysis(c.env.DB, sharedCacheKey)
              || await readKnowledgeReportAnalysis(c.env.DB, cacheKey);
            if (cached) {
              return cached;
            }
            const content = await loadKnowledgeReportMarkdown(c.env, row, knowledgeContentUrlContext(c));
            if (!content) {
              throw new Error("knowledge report has no converted content and the converter is unavailable");
            }
            const forecasts = await extractCompanyReportByLlm(c, row.title, content);
            const completed = {
              analysisCalled: true,
              analysisSucceeded: true,
              forecasts,
              updatedAt: Date.now(),
            };
            await Promise.all([
              writeKnowledgeReportAnalysis(c.env.DB, cacheKey, completed),
              sharedCacheKey
                ? writeKnowledgeReportAnalysis(c.env.DB, sharedCacheKey, completed)
                : Promise.resolve(),
            ]);
            return completed;
          },
        );
      },
    );
    analysis = await readKnowledgeReportAnalysis(c.env.DB, sharedCacheKey)
      || await readKnowledgeReportAnalysis(c.env.DB, cacheKey);
    if (!analysis) {
      throw new Error("knowledge report analysis completed without a cached result");
    }
  }

  const code = normalizeKnowledgeStockCode(row.target_code || "");
  const [overview, actual2025] = code
    ? await Promise.all([
      fetchEastmoneyCompanyOverview(c.env.DB, code).catch(() => null),
      loadKnowledgeActualAnnualFinancials(c.env, code, 2025).catch(() => null),
    ])
    : [null, null];
  const forecastMetrics = buildKnowledgeReportForecastMetrics(
    analysis.forecasts,
    overview?.latestPrice ?? null,
    overview?.marketCapYi ?? null,
    actual2025,
  );
  const forecasts = forecastMetrics.map((forecast) => ({
    ...forecast,
    peg: calculateKnowledgeReportPeg(forecastMetrics, Number(forecast.year)),
  }));
  const peg2026 = calculateKnowledgeReportPeg(forecastMetrics, 2026);
  const peg2027 = calculateKnowledgeReportPeg(forecastMetrics, 2027);
  const peg2028 = calculateKnowledgeReportPeg(forecastMetrics, 2028);
  const pe2028 = forecastMetrics.find((forecast) => forecast.year === 2028)?.current_pe ?? null;
  return ok(c, {
    doc_id: id,
    report_pages: knowledgeReportPageCount(metadata),
    analysis_called: analysis.analysisCalled,
    analysis_updated_at: analysis.updatedAt,
    latest_price: overview?.latestPrice ?? null,
    market_cap_yi: overview?.marketCapYi ?? null,
    forecasts,
    peg_2026: peg2026,
    peg_2027: peg2027,
    peg_2028: peg2028,
    recommended: peg2028 !== null && peg2028 < 1 && pe2028 !== null && pe2028 < 100,
  });
});

knowledgeRoutes.get("/knowledge/filtered", async (c) => {
  if (!isLocalDevelopmentRuntime(c.env)) {
    return fail(c, 404, "filtered review is only available in local development");
  }
  const q = String(c.req.query("q") ?? "").trim();
  const page = clampInteger(c.req.query("page"), 1, 1, 10000);
  const pageSize = clampInteger(c.req.query("pageSize"), 50, 1, 100);
  const offset = (page - 1) * pageSize;
  const reviewRows = await loadLocalFilteredReviewRows();
  const keptDocIds = await loadExistingKnowledgeDocIds(c.env.DB, reviewRows.map((row) => row.docId));
  const filteredRows = reviewRows
    .filter((row) => !row.keep && !keptDocIds.has(row.docId))
    .filter((row) => !q || matchesLocalFilteredReviewQuery(row, q))
    .sort(compareLocalFilteredReviewRows);
  const pageRows = filteredRows.slice(offset, offset + pageSize);
  return ok(c, {
    page,
    page_size: pageSize,
    total: filteredRows.length,
    has_next: offset + pageSize < filteredRows.length,
    list: pageRows.map((row) => mapLocalFilteredReviewListItem(row, knowledgeContentUrlContext(c))),
  });
});

knowledgeRoutes.get("/knowledge/filtered/doc", async (c) => {
  if (!isLocalDevelopmentRuntime(c.env)) return fail(c, 404, "filtered review is only available in local development");
  const id = c.req.query("id")?.trim() ?? "";
  if (!id) return fail(c, 400, "missing doc id");
  const reviewRows = await loadLocalFilteredReviewRows();
  const keptDocIds = await loadExistingKnowledgeDocIds(c.env.DB, reviewRows.map((item) => item.docId));
  const row = reviewRows.find((item) => item.docId === id && !item.keep && !keptDocIds.has(item.docId));
  if (!row) return fail(c, 404, `filtered document not found: ${id}`);
  return ok(c, await mapLocalFilteredReviewDetail(row, knowledgeContentUrlContext(c)));
});

knowledgeRoutes.post("/knowledge/filtered/keep", async (c) => {
  if (!isLocalDevelopmentRuntime(c.env)) return fail(c, 404, "filtered review is only available in local development");
  const body = await c.req.json().catch(() => ({})) as { id?: string };
  const id = String(body.id || c.req.query("id") || "").trim();
  if (!id) return fail(c, 400, "missing doc id");
  const reviewRows = await loadLocalFilteredReviewRows();
  const keptDocIds = await loadExistingKnowledgeDocIds(c.env.DB, reviewRows.map((item) => item.docId));
  const reviewRow = reviewRows.find((item) => item.docId === id && !item.keep && !keptDocIds.has(item.docId));
  if (!reviewRow) return fail(c, 404, `filtered document not found: ${id}`);
  const localDoc = await buildLocalReviewKeptDoc(reviewRow);
  const now = Date.now();
  await c.env.DB.prepare(
    `insert into knowledge_docs (
      doc_id, source_type, report_type, source_name, title, url, published_at, fetched_at,
      event_time, target_name, target_code, discovery_method, access_method, summary,
      content_preview, metadata_json, recommendation_score, recommendation_level,
      recommendation_tags_json, recommendation_reasons_json, rank_score, source_weight,
      sort_time, source_name_normalized, target_code_normalized, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'filtered_review_keep', ?,
      ?, ?, ?, 1, 'D', ?, ?, 1, 0, ?, ?, ?, ?)
    on conflict(doc_id) do update set
      source_type=excluded.source_type,
      report_type=excluded.report_type,
      source_name=excluded.source_name,
      title=excluded.title,
      url=excluded.url,
      published_at=excluded.published_at,
      fetched_at=excluded.fetched_at,
      event_time=excluded.event_time,
      target_name=excluded.target_name,
      target_code=excluded.target_code,
      discovery_method=excluded.discovery_method,
      access_method=excluded.access_method,
      summary=excluded.summary,
      content_preview=excluded.content_preview,
      metadata_json=excluded.metadata_json,
      recommendation_tags_json=excluded.recommendation_tags_json,
      recommendation_reasons_json=excluded.recommendation_reasons_json,
      sort_time=excluded.sort_time,
      source_name_normalized=excluded.source_name_normalized,
      target_code_normalized=excluded.target_code_normalized,
      updated_at=excluded.updated_at`
  )
    .bind(
      localDoc.docId, localDoc.sourceType, localDoc.reportType || localDoc.sourceType, localDoc.sourceName,
      localDoc.title, localDoc.url, localDoc.publishedAt, localDoc.fetchedAt,
      localDoc.eventTime, localDoc.targetName, localDoc.targetCode,
      localDoc.accessMethod, localDoc.summary, localDoc.contentPreview,
      JSON.stringify(localDoc.metadata), JSON.stringify(localDoc.tags), JSON.stringify(localDoc.recommendationReasons),
      firstNonEmpty(localDoc.eventTime, localDoc.publishedAt, localDoc.fetchedAt),
      normalizeLower(localDoc.sourceName),
      normalizeUpper(localDoc.targetCode),
      now,
    )
    .run();
  await upsertKnowledgeDocContentRef(c.env.DB, {
    docId: localDoc.docId,
    content_key: localDoc.contentKey,
    content_url: "",
    content_type: localDoc.contentType,
    content_encoding: "identity",
    content_bytes: localDoc.contentBytes,
    content_sha256: localDoc.contentSha256,
  }, now);
  await replaceKnowledgeDocSecurityLinks(c.env.DB, localDoc.docId, extractKnowledgeSecurityCodes(localDoc.targetCode, localDoc.metadata));
  await replaceKnowledgeLocalContentCache(c.env.DB, {
    contentKey: localDoc.contentKey,
    contentType: localDoc.contentType,
    contentEncoding: "identity",
    content: localDoc.content,
  }, now);
  await replaceKnowledgeDocTags(c.env.DB, localDoc.docId, localDoc.tags);
  return ok(c, { kept: true, doc_id: id });
});

knowledgeRoutes.get("/knowledge/sources", async (c) => {
  const sourceType = normalizeSourceType(c.req.query("sourceType") ?? "");
  const binds: unknown[] = [];
  const filters: string[] = ["coalesce(source_name, '') != ''"];
  if (sourceType) {
    if (sourceType === "company_report") {
      filters.push("source_type = 'research_report'", "report_type = 'company_report'");
    } else if (sourceType === "industry_report") {
      filters.push("source_type = 'research_report'", "report_type = 'industry_report'");
    } else {
      filters.push("source_type = ?");
      binds.push(sourceType);
    }
  }
  const rows = await c.env.DB.prepare(
    `select source_name as name, count(*) as count
       from knowledge_docs
       where ${filters.join(" and ")}
       group by source_name
       order by count(*) desc, source_name asc
       limit 200`
  )
    .bind(...binds)
    .all<{ name: string; count: number }>();
  return ok(c, {
    list: (rows.results ?? [])
      .map((row) => ({
        key: row.name,
        name: displaySourceName(row.name),
        count: row.count,
      }))
      .filter((row) => row.name),
  });
});

knowledgeRoutes.get("/knowledge/industries", async (c) => {
  const rows = await c.env.DB.prepare(
    `select target_name as name, count(*) as count
       from knowledge_docs
       where source_type = 'research_report'
         and report_type = 'industry_report'
         and coalesce(target_name, '') != ''
       group by target_name
       order by count(*) desc, target_name asc
       limit 500`
  ).all<{ name: string; count: number }>();
  return ok(c, {
    list: (rows.results ?? []).map((row) => ({
      name: row.name,
      count: row.count,
    })),
  });
});

knowledgeRoutes.get("/knowledge/information-filters", async (c) => {
  const currentResults = `
    select v.doc_id, r.result_id, r.outcome
      from knowledge_document_versions v
      join knowledge_document_results r on r.result_id = (
        select r2.result_id from knowledge_document_results r2
         where r2.version_id = v.version_id
         order by r2.created_at desc, r2.result_id desc limit 1
      )
     where v.version_id = (
       select v2.version_id from knowledge_document_versions v2
        where v2.doc_id = v.doc_id
        order by v2.created_at desc, v2.version_id desc limit 1
     )`;
  const [entities, informationTypes, categories] = await c.env.DB.batch([
    c.env.DB.prepare(
      `with current_results as (${currentResults})
       select record.entity as name, count(*) as count
         from current_results join knowledge_information_records record on record.result_id = current_results.result_id
        where trim(coalesce(record.entity, '')) != ''
        group by record.entity
        order by count(*) desc, name asc limit 500`,
    ),
    c.env.DB.prepare(
      `with current_results as (${currentResults})
       select record.information_type as value, count(*) as count
         from current_results join knowledge_information_records record on record.result_id = current_results.result_id
        group by record.information_type order by count(*) desc, value asc`,
    ),
    c.env.DB.prepare(
      `with current_results as (${currentResults})
       select record.category as value, count(*) as count
         from current_results join knowledge_information_records record on record.result_id = current_results.result_id
        group by record.category order by count(*) desc, value asc limit 500`,
    ),
  ]);
  return ok(c, {
    entities: entities.results ?? [],
    information_types: informationTypes.results ?? [],
    categories: categories.results ?? [],
  });
});

knowledgeRoutes.post("/knowledge/company-code-mappings/refresh", async (c) => {
  if (!isLocalDevelopmentRuntime(c.env)) {
    return fail(c, 404, "company-code mapping refresh is only available in local development");
  }
  const body = await c.req.json().catch(() => ({})) as { maxCompanies?: number };
  const maxCompanies = Math.min(500, Math.max(1, Number(body.maxCompanies) || 100));
  return ok(c, await refreshKnowledgeCompanyCodeMappings(c.env, maxCompanies));
});

knowledgeRoutes.get("/knowledge/file", async (c) => {
  const id = c.req.query("id")?.trim() ?? "";
  if (!id) {
    return fail(c, 400, "missing doc id");
  }
  const row = await c.env.DB.prepare("select url from knowledge_docs where doc_id = ?")
    .bind(id)
    .first<{ url: string | null }>();
  if (!row?.url) {
    return fail(c, 404, "document file is not stored; original url is unavailable");
  }
  return c.redirect(row.url, 302);
});

knowledgeRoutes.get("/knowledge/content", async (c) => {
  const key = c.req.query("key")?.trim() ?? "";
  if (!key) {
    return fail(c, 400, "missing content key");
  }
  if (key.startsWith("localfs:")) {
    return fail(c, 410, "localfs knowledge content is no longer supported; re-import or migrate content_key to knowledge-content/*");
  }
  const redirectResponse = buildKnowledgeContentRedirectResponse(key, c.env);
  if (!redirectResponse) {
    return fail(c, 404, `knowledge content public base url is unavailable: ${key}`);
  }
  return redirectResponse;
});

function parseDocsQuery(raw: Record<string, string>): KnowledgeDocsQuery {
  return {
    sourceType: normalizeSourceType(raw.sourceType ?? ""),
    source: normalizeSource(raw.source ?? ""),
    industry: String(raw.industry ?? "").trim(),
    code: normalizeSecurityCode(raw.code ?? ""),
    tags: String(raw.tags ?? raw.tag ?? "")
      .split(",")
      .map((item) => normalizeFilter(item))
      .filter(Boolean),
    informationTags: String(raw.informationTags ?? raw.informationTag ?? "")
      .split(",")
      .map((item) => normalizeInformationTag(item))
      .filter(Boolean),
    informationEntity: String(raw.informationEntity ?? "").trim(),
    informationCategory: normalizeInformationCategory(raw.informationCategory ?? ""),
    q: String(raw.q ?? "").trim(),
    page: clampInteger(raw.page, 1, 1, 10000),
    pageSize: clampInteger(raw.pageSize, 50, 1, 100),
  };
}

function knowledgeContentUrlContext(c: { env: AppEnv["Bindings"]; req: { raw: Request } }): KnowledgeContentUrlContext {
  const url = new URL(c.req.raw.url);
  const host = c.req.raw.headers.get("host") || "";
  return {
    local: isLocalDevelopmentRuntime(c.env) || isKnowledgeTextSearchEnabled(c.env),
    origin: host ? `${url.protocol}//${host}` : url.origin,
    publicBaseUrl: String(c.env.KNOWLEDGE_CONTENT_PUBLIC_BASE_URL || "").trim(),
  };
}

function resolveKnowledgeContentUrl(
  row: Pick<KnowledgeContentRefRow, "content_key" | "content_url">,
  context: KnowledgeContentUrlContext,
): string {
  const key = String(row.content_key || "").trim();
  const storedUrl = String(row.content_url || "").trim();
  if (key && context.publicBaseUrl) {
    return `${context.publicBaseUrl.replace(/\/+$/, "")}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }
  if (storedUrl) {
    return storedUrl;
  }
  return "";
}

async function loadKnowledgeReportMarkdown(
  env: AppEnv["Bindings"],
  row: KnowledgeReportAnalysisRow,
  contentContext: KnowledgeContentUrlContext,
): Promise<string> {
  const contentUrl = resolveKnowledgeContentUrl(row, contentContext);
  if (contentUrl) {
    return fetchKnowledgeReportMarkdown(contentUrl);
  }
  const converterUrl = String(env.KNOWLEDGE_REPORT_CONVERTER_URL || "").trim();
  const sourceUrl = String(row.url || "").trim();
  if (!converterUrl || !sourceUrl.toLowerCase().includes(".pdf")) {
    return "";
  }
  const response = await fetch(converterUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ docId: row.doc_id, url: sourceUrl }),
  });
  if (!response.ok) {
    throw new Error(`knowledge report conversion failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
  }
  return (await response.text()).trim().slice(0, 12000);
}

async function fetchKnowledgeReportMarkdown(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`knowledge report content request failed: ${response.status}`);
  }
  return (await response.text()).trim().slice(0, 12000);
}

function knowledgeReportAnalysisConcurrency(env: AppEnv["Bindings"]): number {
  const value = Number(env.KNOWLEDGE_REPORT_ANALYSIS_CONCURRENCY);
  return Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_KNOWLEDGE_REPORT_ANALYSIS_CONCURRENCY;
}

async function runKnowledgeReportAnalysisTask(
  docId: string,
  concurrency: number,
  task: () => Promise<KnowledgeReportAnalysis>,
): Promise<KnowledgeReportAnalysis> {
  const existing = knowledgeReportAnalysisInFlight.get(docId);
  if (existing) {
    return existing;
  }
  const pending = runKnowledgeReportAnalysisLimited(concurrency, task)
    .finally(() => knowledgeReportAnalysisInFlight.delete(docId));
  knowledgeReportAnalysisInFlight.set(docId, pending);
  return pending;
}

async function runKnowledgeReportAnalysisLimited<T>(limit: number, task: () => Promise<T>): Promise<T> {
  if (knowledgeReportAnalysisActive >= limit) {
    await new Promise<void>((resolve) => knowledgeReportAnalysisWaiters.push(resolve));
  }
  knowledgeReportAnalysisActive += 1;
  try {
    return await task();
  } finally {
    knowledgeReportAnalysisActive -= 1;
    knowledgeReportAnalysisWaiters.shift()?.();
  }
}

async function readKnowledgeReportAnalysis(
  db: AppEnv["Bindings"]["DB"],
  key: string,
): Promise<KnowledgeReportAnalysis | null> {
  if (!key) {
    return null;
  }
  const row = await getAppKv(db, key);
  if (!row?.valueJson) {
    return null;
  }
  try {
    const parsed = JSON.parse(row.valueJson) as KnowledgeReportAnalysis;
    return isReusableReportAnalysisCache(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeKnowledgeReportAnalysis(
  db: AppEnv["Bindings"]["DB"],
  key: string,
  value: KnowledgeReportAnalysis,
): Promise<void> {
  const now = Date.now();
  await putAppKv(db, {
    key,
    valueJson: JSON.stringify(value),
    expiresAt: now + KNOWLEDGE_REPORT_ANALYSIS_CACHE_TTL_MS,
    updatedAt: now,
  });
}

function knowledgeReportPageCount(metadata: Record<string, unknown>): number | null {
  const raw = metadata.raw && typeof metadata.raw === "object" && !Array.isArray(metadata.raw)
    ? metadata.raw as Record<string, unknown>
    : {};
  const value = Number(raw.attachPages ?? metadata.attachPages ?? metadata.pageCount);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function buildKnowledgeReportForecastMetrics(
  forecasts: CompanyReportForecast[],
  latestPrice: number | null,
  marketCapYi: number | null,
  actualPreviousYear: { year: number; revenue: number | null; netProfit: number | null } | null = null,
): Array<Record<string, number | null>> {
  const sorted = forecasts
    .filter((item) => Number.isInteger(item.year))
    .sort((left, right) => left.year - right.year);
  return sorted.map((item, index) => {
    const previous = sorted[index - 1];
    const previousRevenue = previous?.revenue
      ?? (actualPreviousYear?.year === item.year - 1 ? actualPreviousYear.revenue ?? undefined : undefined);
    const previousNetProfit = previous?.netProfit
      ?? (actualPreviousYear?.year === item.year - 1 ? actualPreviousYear.netProfit ?? undefined : undefined);
    const revenueGrowth = finiteNumberOrNull(item.revenueGrowth) ?? forecastGrowth(item.revenue, previousRevenue);
    const profitGrowth = finiteNumberOrNull(item.profitGrowth) ?? forecastGrowth(item.netProfit, previousNetProfit);
    const currentPe = marketCapYi !== null && marketCapYi > 0 && item.netProfit !== undefined && item.netProfit > 0
      ? marketCapYi / item.netProfit
      : latestPrice !== null && latestPrice > 0 && item.eps !== undefined && item.eps > 0
        ? latestPrice / item.eps
        : null;
    return {
      year: item.year,
      revenue: finiteNumberOrNull(item.revenue),
      revenue_growth: revenueGrowth,
      net_profit: finiteNumberOrNull(item.netProfit),
      profit_growth: profitGrowth,
      current_pe: roundKnowledgeMetric(currentPe),
    };
  });
}

async function loadKnowledgeActualAnnualFinancials(
  env: AppEnv["Bindings"],
  code: string,
  year: number,
): Promise<{ year: number; revenue: number | null; netProfit: number | null } | null> {
  const financials = await loadFinancialStatementReadModel(env, code, "income", {
    httpOptions: externalHttpOptions(env),
  });
  if (financials.sourceHealth.status === "failed") throw new Error(financials.sourceHealth.message ?? "financial source failed");
  const { rows } = financials;
  const annual = selectAnnualIncomeStatements(rows).find((statement) => statement.fiscalYear === year);
  if (!annual) return null;
  return {
    year,
    revenue: annual.revenue === null ? null : roundKnowledgeMetric(annual.revenue / 100_000_000),
    netProfit: annual.netProfit === null ? null : roundKnowledgeMetric(annual.netProfit / 100_000_000),
  };
}

function calculateKnowledgeReportPeg(
  forecasts: Array<Record<string, number | null>>,
  year: number,
): number | null {
  const item = forecasts.find((forecast) => forecast.year === year);
  const pe = item?.current_pe;
  const growth = item?.profit_growth;
  if (pe === null || pe === undefined || growth === null || growth === undefined || pe < 0 || growth <= 0) {
    return null;
  }
  return roundKnowledgeMetric(pe / growth);
}

function forecastGrowth(current: number | undefined, previous: number | undefined): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) {
    return null;
  }
  return roundKnowledgeMetric(((current! / previous!) - 1) * 100);
}

function finiteNumberOrNull(value: number | undefined): number | null {
  return Number.isFinite(value) ? roundKnowledgeMetric(value!) : null;
}

function roundKnowledgeMetric(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function isLocalRequest(request: Request | string): boolean {
  const requestUrl = typeof request === "string" ? request : request.url;
  const headerHost = typeof request === "string" ? "" : (request.headers.get("host") || "");
  const hosts = [new URL(requestUrl).hostname, headerHost.split(":")[0]]
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return hosts.some((hostname) =>
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]"
  ) || (typeof request !== "string" && !(request as Request & { cf?: unknown }).cf);
}

function normalizeSource(value: string): string {
  const normalized = normalizeFilter(value);
  return normalized === "all" ? "" : normalized;
}

function isKnowledgeTextSearchEnabled(env: AppEnv["Bindings"]): boolean {
  return ["1", "true", "yes", "on"].includes(String(env.KNOWLEDGE_ALLOW_TEXT_SEARCH || "").trim().toLowerCase());
}

function buildKnowledgeWhere(query: KnowledgeDocsQuery): { whereSql: string; binds: unknown[] } {
  const filters: string[] = [];
  const binds: unknown[] = [];
  if (query.sourceType) {
    if (query.sourceType === "company_report") {
      filters.push("d.source_type = 'research_report'", "d.report_type = 'company_report'");
    } else if (query.sourceType === "industry_report") {
      filters.push("d.source_type = 'research_report'", "d.report_type = 'industry_report'");
    } else {
      filters.push("d.source_type = ?");
      binds.push(query.sourceType);
    }
  }
  if (query.source) {
    filters.push("d.source_name_normalized = ?");
    binds.push(query.source);
  }
  if (query.industry) {
    filters.push("lower(d.target_name) = lower(?)");
    binds.push(query.industry);
  }
  if (query.code) {
    filters.push("d.doc_id in (select l.doc_id from knowledge_doc_security_links l where l.code = ?)");
    binds.push(query.code);
  }
  if (query.informationEntity) {
    filters.push(`exists (
      select 1 from knowledge_information_records record
       where record.result_id = information.result_id
         and lower(record.entity) = lower(?)
    )`);
    binds.push(query.informationEntity);
  }
  if (query.informationCategory) {
    filters.push(`exists (
      select 1 from knowledge_information_records record
       where record.result_id = information.result_id and record.category = ?
    )`);
    binds.push(query.informationCategory);
  }
  if (query.q) {
    const like = `%${query.q.toLowerCase()}%`;
    filters.push(`(
      lower(d.title) like ?
      or lower(coalesce(d.source_name, '')) like ?
      or lower(coalesce(d.target_name, '')) like ?
      or lower(coalesce(d.target_code, '')) like ?
      or lower(coalesce(d.content_preview, '')) like ?
      or lower(coalesce(d.url, '')) like ?
    )`);
    binds.push(like, like, like, like, like, like);
  }
  for (const tag of query.tags) {
    if (tag.startsWith("recommendation:")) {
      filters.push("upper(coalesce(d.recommendation_level, '')) = ?");
      binds.push(tag.slice("recommendation:".length).toUpperCase());
      continue;
    }
    filters.push("exists (select 1 from knowledge_doc_tags t where t.doc_id = d.doc_id and lower(t.tag) = ?)");
    binds.push(tag);
  }
  for (const tag of query.informationTags) {
    if (tag === "processed") {
      filters.push("information.result_id is not null");
      continue;
    }
    const [kind, value] = tag.split(":", 2);
    if (kind === "information_type" || kind === "category") {
      filters.push(`exists (
        select 1 from knowledge_information_records record
         where record.result_id = information.result_id and record.${kind === "information_type" ? "information_type" : "category"} = ?
      )`);
      binds.push(value);
    }
  }
  return {
    whereSql: filters.length > 0 ? `where ${filters.join(" and ")}` : "",
    binds,
  };
}

function mapKnowledgeDocListItem(row: KnowledgeDocRow, contentContext: KnowledgeContentUrlContext): Record<string, unknown> {
  const metadata = parseJsonObject(row.metadata_json);
  const target = sanitizeKnowledgeTarget(row.title, row.target_name || "", row.target_code || "", metadata);
  const stockLinks = stockLinksFromMetadata(metadata, target.name, target.code);
  const recommendationTags = sanitizeKnowledgeDisplayTags(parseJsonArray(row.recommendation_tags_json), stockLinks);
  const contentUrl = resolveKnowledgeContentUrl(row, contentContext);
  const tags = [
    ...recommendationTags,
    ...(isPdf(row) ? ["pdf"] : []),
  ];
  const informationTags = informationTagsForKnowledgeDoc(row);
  return {
    doc_id: row.doc_id,
    source_type: row.source_type,
    report_type: row.report_type || row.source_type,
    source_name: displaySourceName(row.source_name),
    title: row.title,
    url: row.url || "",
    published_at: row.published_at || "",
    fetched_at: row.fetched_at || "",
    event_time: row.event_time || row.published_at || row.fetched_at || "",
    target_name: target.name,
    target_code: target.code,
    access_method: resolveKnowledgeAccessMethod(row),
    summary: row.summary || "",
    content_preview: buildKnowledgePreview(row),
    content_url: contentUrl,
    stock_links: stockLinks,
    tags: unique(tags),
    information_tags: informationTags,
    information_entities: splitInformationValues(row.information_entities),
    information_types: splitInformationValues(row.information_types),
    information_categories: splitInformationValues(row.information_categories),
    report_pages: knowledgeReportPageCount(metadata),
  };
}

function informationTagsForKnowledgeDoc(row: Pick<KnowledgeDocRow, "information_outcome" | "information_types" | "information_categories">): string[] {
  if (!row.information_outcome) return [];
  const tags = ["processed"];
  for (const type of splitInformationValues(row.information_types)) {
    const normalized = normalizeInformationTag(`information_type:${type}`);
    if (normalized) tags.push(normalized);
  }
  for (const category of splitInformationValues(row.information_categories)) {
    const normalized = normalizeInformationTag(`category:${category}`);
    if (normalized) tags.push(normalized);
  }
  return unique(tags);
}

function splitInformationValues(value: string | null): string[] {
  return unique(String(value || "").split(",").map((item) => item.trim()).filter(Boolean));
}

function mapFilteredDocListItem(row: KnowledgeFilteredDocRow, contentContext: KnowledgeContentUrlContext): Record<string, unknown> {
  const metadata = parseJsonObject(row.metadata_json);
  const filterReasons = parseJsonArray(row.filter_reasons_json);
  const target = sanitizeKnowledgeTarget(row.title, row.target_name || "", row.target_code || "", metadata);
  const stockLinks = stockLinksFromMetadata(metadata, target.name, target.code);
  const sanitizedMetadata = sanitizeKnowledgeMetadata(metadata, stockLinks);
  const contentUrl = resolveKnowledgeContentUrl(row, contentContext);
  return {
    doc_id: row.doc_id,
    source_type: row.source_type,
    report_type: row.report_type || row.source_type,
    source_name: displaySourceName(row.source_name),
    title: row.title,
    url: row.url || "",
    published_at: row.published_at || "",
    fetched_at: row.fetched_at || "",
    event_time: row.event_time || row.published_at || row.fetched_at || "",
    target_name: target.name,
    target_code: target.code,
    discovery_method: "filtered_review",
    access_method: row.access_method || "",
    summary: row.summary || "",
    content_preview: row.content_preview || "",
    content_key: row.content_key || "",
    content_url: contentUrl,
    content_type: row.content_type || "text/markdown; charset=utf-8",
    content_encoding: row.content_encoding || "identity",
    content_bytes: row.content_bytes || 0,
    content_sha256: row.content_sha256 || "",
    metadata: sanitizedMetadata,
    stock_links: stockLinks,
    tags: ["filtered"],
    recommendation: {
      level: "",
      score: row.filter_score || 0,
      tags: ["filtered"],
      reasons: filterReasons,
    },
    rankScore: row.filter_score || 0,
    rankReasons: filterReasons,
    filter: {
      method: row.filter_method || "",
      score: row.filter_score || 0,
      confidence: row.filter_confidence,
      reasons: filterReasons,
      status: row.reviewed_status,
      sourceFile: row.source_file || "",
    },
    favorited: false,
  };
}

async function mapFilteredDocDetail(
  row: KnowledgeFilteredDocRow,
  contentContext: KnowledgeContentUrlContext,
): Promise<Record<string, unknown>> {
  return {
    ...mapFilteredDocListItem(row, contentContext),
  };
}

function buildKnowledgeContentRedirectResponse(key: string, env: AppEnv["Bindings"]): Response | null {
  const baseUrl = String(env.KNOWLEDGE_CONTENT_PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  if (!baseUrl) {
    return null;
  }
  return Response.redirect(`${baseUrl}/${key.split("/").map(encodeURIComponent).join("/")}`, 302);
}

async function upsertKnowledgeDocContentRef(
  db: AppEnv["Bindings"]["DB"],
  row: { docId: string } & KnowledgeContentRefRow,
  updatedAt: number,
): Promise<void> {
  const hasRef = [
    row.content_key,
    row.content_url,
    row.content_sha256,
    row.content_bytes,
  ].some((value) => String(value ?? "").trim() !== "" && String(value ?? "0") !== "0");
  if (!hasRef) {
    await db.prepare("delete from knowledge_doc_content_refs where doc_id = ?")
      .bind(row.docId)
      .run();
    return;
  }
  await db.prepare(
    `insert into knowledge_doc_content_refs (
      doc_id, content_key, content_url, content_type, content_encoding, content_bytes, content_sha256, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(doc_id) do update set
      content_key=excluded.content_key,
      content_url=excluded.content_url,
      content_type=excluded.content_type,
      content_encoding=excluded.content_encoding,
      content_bytes=excluded.content_bytes,
      content_sha256=excluded.content_sha256,
      updated_at=excluded.updated_at`
  )
    .bind(
      row.docId,
      row.content_key || "",
      row.content_url || "",
      row.content_type || "text/markdown; charset=utf-8",
      row.content_encoding || "identity",
      row.content_bytes || 0,
      row.content_sha256 || "",
      updatedAt,
    )
    .run();
}

async function replaceKnowledgeDocSecurityLinks(
  db: AppEnv["Bindings"]["DB"],
  docId: string,
  codes: string[],
): Promise<void> {
  await db.prepare("delete from knowledge_doc_security_links where doc_id = ?")
    .bind(docId)
    .run();
  if (codes.length === 0) {
    return;
  }
  const stmt = db.prepare(
    `insert into knowledge_doc_security_links (doc_id, code)
     values (?, ?)
     on conflict(doc_id, code) do nothing`
  );
  await db.batch(codes.map((code) => stmt.bind(docId, code)));
}

function normalizeSourceType(value: string): string {
  const normalized = normalizeFilter(value);
  return normalized === "all" ? "" : normalized;
}

function normalizeFilter(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeInformationTag(value: string): string {
  const normalized = normalizeFilter(value);
  if (normalized === "processed") return normalized;
  if (/^information_type:(fact|guidance|forecast|opinion|event|relationship)$/.test(normalized)) return normalized;
  if (/^category:[a-z][a-z0-9_]{0,80}$/.test(normalized)) return normalized;
  return "";
}

function normalizeInformationCategory(value: string): string {
  const normalized = normalizeFilter(value);
  return /^[a-z][a-z0-9_]{0,80}$/.test(normalized) ? normalized : "";
}

function normalizeSecurityCode(value: string): string {
  return value.trim().toUpperCase();
}

function clampInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function parseJsonObject(value: string | null): Record<string, unknown> {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function stockLinksFromMetadata(metadata: Record<string, unknown>, targetName: string, targetCode: string): Array<Record<string, unknown>> {
  const links = Array.isArray(metadata.stockLinks) ? metadata.stockLinks : [];
  const fallback = targetName || targetCode
    ? [{ name: targetName, code: targetCode, aliases: [targetName, targetCode].filter(Boolean) }]
    : [];
  return (links.length > 0 ? links : fallback)
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .map((item) => {
      const code = normalizeKnowledgeStockCode(String(item.code || ""));
      return {
        name: String(item.name || ""),
        code,
        aliases: buildSecurityAliases(
          String(item.name || ""),
          code,
          Array.isArray(item.aliases)
            ? item.aliases.map((alias) => String(alias || "").trim()).filter(Boolean)
            : [],
        ),
      };
    })
    .filter((item) => item.code);
}

function sanitizeKnowledgeTarget(title: string, targetName: string, targetCode: string, metadata: Record<string, unknown>): { name: string; code: string } {
  const normalizedCode = normalizeKnowledgeStockCode(targetCode);
  const stockNames = Array.isArray(metadata.stockNames) ? metadata.stockNames : [];
  if (metadata.source !== "tencent_stock_news" || stockNames.length <= 1) {
    return { name: targetName, code: normalizedCode };
  }
  const baseName = securityBaseName(targetName);
  if (baseName && title.includes(baseName) && !isSecurityDisplayTag(targetName)) {
    return { name: targetName, code: normalizedCode };
  }
  return { name: "", code: "" };
}

function securityBaseName(name: string): string {
  return name
    .trim()
    .replace(/\.(SH|SZ|US|HK|BJ|PT)$/i, "")
    .replace(/-(SW|W|B|S|R)$/i, "")
    .trim();
}

function buildSecurityAliases(name: string, code: string, aliases: string[]): string[] {
  const baseName = securityBaseName(name);
  const shortName = stripSecuritySuffix(baseName);
  const bareCode = String(code || "").split(".")[0];
  return unique([
    name,
    code,
    bareCode,
    baseName,
    shortName,
    ...aliases,
  ]);
}

function stripSecuritySuffix(name: string): string {
  return String(name || "")
    .replace(/(股份有限公司|集团有限公司|控股有限公司|科技有限公司|股份|集团|控股|科技)$/u, "")
    .trim();
}

function normalizeKnowledgeStockCode(code: string): string {
  const raw = String(code || "").trim().toUpperCase();
  if (!raw) {
    return "";
  }
  const usMatch = raw.match(/^US([A-Z0-9.-]+)\.(?:OQ|NQ|N|AMEX|PK|OB)$/);
  if (usMatch) {
    return normalizeSupportedCompanyCode(`${usMatch[1]}.US`);
  }
  return normalizeSupportedCompanyCode(raw);
}

function extractKnowledgeSecurityCodes(targetCode: string | null, metadata: Record<string, unknown>): string[] {
  const links = Array.isArray(metadata.stockLinks) ? metadata.stockLinks : [];
  return unique([
    normalizeKnowledgeStockCode(String(targetCode || "")),
    ...links.map((item) => normalizeKnowledgeStockCode(String((item as Record<string, unknown>)?.code || ""))),
  ]);
}

function firstNonEmpty(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

function normalizeLower(value: string | null): string {
  return String(value || "").trim().toLowerCase();
}

function normalizeUpper(value: string | null): string {
  return String(value || "").trim().toUpperCase();
}

function sanitizeKnowledgeDisplayTags(tags: string[], stockLinks: Array<Record<string, unknown>>): string[] {
  const stockAliases = new Set<string>();
  for (const link of stockLinks) {
    for (const value of [link.name, link.code, ...(Array.isArray(link.aliases) ? link.aliases : [])]) {
      const normalized = String(value || "").trim().toLowerCase();
      if (normalized) stockAliases.add(normalized);
    }
  }
  return tags.filter((tag) => {
    const normalized = tag.trim().toLowerCase();
    if (!normalized) return false;
    if (stockAliases.has(normalized)) return false;
    return !isSecurityDisplayTag(tag);
  });
}

function sanitizeKnowledgeMetadata(
  metadata: Record<string, unknown>,
  stockLinks: Array<Record<string, unknown>>,
): Record<string, unknown> {
  if (stockLinks.length === 0) {
    return {
      ...metadata,
      stockLinks: [],
      stockCodes: [],
      stockNames: [],
    };
  }
  return {
    ...metadata,
    stockLinks,
    stockCodes: stockLinks.map((item) => String(item.code || "")).filter(Boolean),
    stockNames: stockLinks.map((item) => String(item.name || "")).filter(Boolean),
  };
}

function isSecurityDisplayTag(tag: string): boolean {
  const value = tag.trim();
  if (!value) return false;
  if (/\b(?:ETF|LOF|QDII)\b/i.test(value)) return true;
  if (/(?:概念|指数|板块|主题)\.PT$/i.test(value)) return true;
  if (/^[a-z]{2,4}[\w.:-]*$/i.test(value) && /(?:\.(?:SH|SZ|HK|US|PT)|^[a-z]{2}\d{5,})$/i.test(value)) return true;
  if (/^[036]\d{5}\.(?:SH|SZ)$/i.test(value)) return true;
  return false;
}

function parseJsonArray(value: string | null): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function resolveKnowledgeAccessMethod(row: Pick<KnowledgeDocRow, "access_method" | "content_key" | "url" | "metadata_json">): string {
  if (String(row.content_key || "").trim()) {
    return "markdown";
  }
  return row.access_method || (isPdf(row) ? "remote_pdf" : "markdown");
}

function buildKnowledgePreview(row: Pick<KnowledgeDocRow, "summary" | "content_preview" | "title">): string {
  const preview = String(row.content_preview || "").trim();
  if (preview) {
    return truncatePreview(preview, 280);
  }
  return truncatePreview(String(row.title || "").trim(), 280);
}

function truncatePreview(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max).trimEnd()}...`;
}

function displaySourceName(value: string | null): string {
  const sourceName = String(value || "").trim();
  if (!sourceName) {
    return "";
  }
  return isInternalSourceName(sourceName) ? "" : sourceName;
}

function isInternalSourceName(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "本地导入" || normalized === "local import";
}

function isPdf(row: Pick<KnowledgeDocRow, "url" | "access_method" | "metadata_json">): boolean {
  return [row.url, row.access_method, row.metadata_json]
    .some((value) => String(value || "").toLowerCase().includes(".pdf"));
}

async function listKnowledgeDocsDeduped(
  db: AppEnv["Bindings"]["DB"],
  query: KnowledgeDocsQuery,
  whereSql: string,
  binds: unknown[],
  contentContext: KnowledgeContentUrlContext,
): Promise<{ list: Record<string, unknown>[]; total: number; hasNext: boolean }> {
  const startIndex = Math.max(0, (query.page - 1) * query.pageSize);
  const endExclusive = startIndex + query.pageSize + 1;
  const batchSize = Math.min(Math.max(query.pageSize * 4, 100), 400);
  const uniqueRows: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let exhausted = false;

  while (uniqueRows.length < endExclusive && !exhausted) {
    const rows = await db.prepare(
      `${KNOWLEDGE_DOC_LIST_SELECT}
         ${whereSql}
         order by ${KNOWLEDGE_DOC_TIME_ORDER}
         limit ? offset ?`
    )
      .bind(...binds, batchSize, offset)
      .all<KnowledgeDocRow>();
    const batch = rows.results ?? [];
    if (batch.length === 0) {
      exhausted = true;
      break;
    }
    for (const row of batch) {
      const dedupeKey = knowledgeDocRowDedupeKey(row);
      const item = mapKnowledgeDocListItem(row, contentContext);
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
      uniqueRows.push(item);
    }
    offset += batch.length;
    if (batch.length < batchSize) {
      exhausted = true;
    }
  }

  const hasNext = uniqueRows.length > startIndex + query.pageSize || !exhausted;
  const list = uniqueRows.slice(startIndex, startIndex + query.pageSize);
  await enrichKnowledgeDocCompanyMappings(db, list);
  return {
    list,
    total: exhausted ? Math.max(uniqueRows.length, startIndex) : startIndex + uniqueRows.length,
    hasNext,
  };
}

async function enrichKnowledgeDocCompanyMappings(
  db: AppEnv["Bindings"]["DB"],
  items: Record<string, unknown>[],
): Promise<void> {
  const companyNames = items.flatMap((item) => Array.isArray(item.information_entities)
    ? item.information_entities.map((name) => String(name || "").trim()).filter(Boolean)
    : []);
  const mappings = await listKnowledgeCompanyCodeMappings(db, companyNames);
  const byCompany = new Map<string, Array<{ name: string; code: string }>>();
  for (const mapping of mappings) {
    const targets = byCompany.get(mapping.companyName) ?? [];
    targets.push({ name: mapping.securityName, code: mapping.code });
    byCompany.set(mapping.companyName, targets);
  }
  for (const item of items) {
    const entities = Array.isArray(item.information_entities) ? item.information_entities : [];
    const modelTargets = entities.flatMap((entity) => byCompany.get(String(entity)) ?? []);
    item.model_targets = modelTargets;
  }
}

function knowledgeDocRowDedupeKey(row: Pick<KnowledgeDocRow, "doc_id" | "source_name" | "title" | "content_preview" | "metadata_json">): string {
  const metadata = parseJsonObject(row.metadata_json);
  const source = String(metadata.source || "");
  const sourceName = String(row.source_name || "").trim().toLowerCase();
  const title = String(row.title || "").trim().toLowerCase();
  const preview = normalizeKnowledgeDedupeText(
    String(row.content_preview || row.title || "").slice(0, 320)
  ).slice(0, 180);
  if (source === "tencent_stock_news") {
    return `tencent|${sourceName}|${title}|${preview}`;
  }
  return String(row.doc_id || "");
}

function normalizeKnowledgeDedupeText(value: string): string {
  return stripKnowledgeLeadNoise(String(value || ""))
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim()
    .toLowerCase();
}

function isIgnorableKnowledgeLeadLine(value: string): boolean {
  return /^作者[丨|｜:：\s]/.test(value)
    || /^(公众号|点击上方|来源|原标题)/.test(value)
    || /加星标/.test(value);
}

function stripKnowledgeLeadNoise(value: string): string {
  let normalized = String(value || "").trim();
  normalized = normalized.replace(/^作者[丨|｜:：\s]*[^\s，。,；;:：]{1,40}\s*/u, "");
  normalized = normalized.replace(/^(公众号|点击上方)[^。！？!?]{0,80}[。！？!?]?\s*/u, "");
  normalized = normalized.replace(/^来源[：:]\s*[^\s]+\s*/u, "");
  normalized = normalized.replace(/^原标题[：:]\s*/u, "");
  if (isIgnorableKnowledgeLeadLine(normalized)) {
    const lines = normalized.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    while (lines.length > 0 && isIgnorableKnowledgeLeadLine(lines[0])) {
      lines.shift();
    }
    normalized = lines.join(" ");
  }
  return normalized.replace(/\s+/g, " ");
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}

type LocalFilteredReviewRow = {
  keep: boolean;
  title: string;
  sourceType: string;
  reportType: string;
  sourceName: string;
  targetName: string;
  targetCode: string;
  publishedAt: string;
  score: number;
  method: string;
  confidence?: number;
  reasons: string[];
  docId: string;
  file: string;
  url: string;
  accessMethod: string;
  summary: string;
  contentPreview: string;
  content: string;
};

type LocalReviewKeepDoc = {
  docId: string;
  sourceType: string;
  reportType: string;
  sourceName: string;
  title: string;
  url: string;
  publishedAt: string;
  fetchedAt: string;
  eventTime: string;
  targetName: string;
  targetCode: string;
  accessMethod: string;
  summary: string;
  contentPreview: string;
  content: string;
  contentKey: string;
  contentType: string;
  contentBytes: number;
  contentSha256: string;
  metadata: Record<string, unknown>;
  tags: string[];
  recommendationReasons: string[];
};

function getNodeBuiltin(name: string): any | null {
  const processObject = (globalThis as { process?: { getBuiltinModule?: (moduleName: string) => unknown } }).process;
  return processObject?.getBuiltinModule?.(name) ?? null;
}

function getProcessCwd(): string {
  const processObject = (globalThis as { process?: { cwd?: () => string } }).process;
  return processObject?.cwd?.() || ".";
}

async function loadLocalFilteredReviewRowsFromAsset(assets: Fetcher, requestUrl: string): Promise<LocalFilteredReviewRow[]> {
  const assetUrl = new URL("/knowledge-review/topic-filter-latest.jsonl", requestUrl);
  const response = await assets.fetch(new Request(assetUrl.toString(), { method: "GET" }));
  if (!response.ok) {
    return [];
  }
  const body = String(await response.text() || "");
  const trimmedBody = body.trimStart();
  if (trimmedBody.startsWith("<")) {
    throw new Error(`filtered review asset returned HTML instead of JSONL: ${assetUrl.pathname}`);
  }
  return body
    .split(/\r?\n/)
    .map((line: string) => line.trim())
    .filter(Boolean)
    .map((line: string) => {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      return {
        keep: Boolean(parsed.keep),
        title: String(parsed.title || ""),
        sourceType: String(parsed.sourceType || parsed.source_type || ""),
        reportType: String(parsed.reportType || parsed.report_type || parsed.sourceType || parsed.source_type || ""),
        sourceName: String(parsed.sourceName || parsed.source_name || ""),
        targetName: String(parsed.targetName || parsed.target_name || ""),
        targetCode: normalizeKnowledgeStockCode(String(parsed.targetCode || parsed.target_code || "")),
        publishedAt: String(parsed.publishedAt || parsed.published_at || ""),
        score: Number(parsed.score || 0) || 0,
        method: String(parsed.method || ""),
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : undefined,
        reasons: Array.isArray(parsed.reasons)
          ? parsed.reasons.map((item) => String(item || "").trim()).filter(Boolean)
          : [],
        docId: String(parsed.docId || parsed.doc_id || ""),
        file: String(parsed.file || ""),
        url: String(parsed.url || ""),
        accessMethod: String(parsed.accessMethod || parsed.access_method || ""),
        summary: String(parsed.summary || ""),
        contentPreview: String(parsed.contentPreview || parsed.content_preview || ""),
        content: String(parsed.content || ""),
      } satisfies LocalFilteredReviewRow;
    })
    .filter((row: LocalFilteredReviewRow) => Boolean(row.docId));
}

async function loadExistingKnowledgeDocIds(
  db: AppEnv["Bindings"]["DB"],
  docIds: string[],
): Promise<Set<string>> {
  const uniqueDocIds = unique(docIds);
  if (uniqueDocIds.length === 0) {
    return new Set<string>();
  }
  const placeholders = uniqueDocIds.map(() => "?").join(", ");
  const rows = await db.prepare(
    `select doc_id from knowledge_docs where doc_id in (${placeholders})`
  )
    .bind(...uniqueDocIds)
    .all<{ doc_id: string }>();
  return new Set((rows.results ?? []).map((row) => row.doc_id));
}

async function loadLocalFilteredReviewRows(): Promise<LocalFilteredReviewRow[]> {
  const fs = getNodeBuiltin("node:fs/promises");
  const path = getNodeBuiltin("node:path");
  if (!fs || !path) {
    return [];
  }
  const reviewDir = await resolveLocalReviewDir();
  if (!(await pathExists(reviewDir))) {
    console.log(JSON.stringify({ filteredReviewDir: reviewDir, exists: false }));
    return [];
  }
  const files = (await fs.readdir(reviewDir))
    .filter((name: string) => /^topic-filter-.*\.jsonl$/i.test(name))
    .sort((left: string, right: string) => right.localeCompare(left));
  console.log(JSON.stringify({ filteredReviewDir: reviewDir, fileCount: files.length, firstFile: files[0] || "" }));
  if (files.length === 0) {
    return [];
  }
  const body = String(await fs.readFile(path.join(reviewDir, files[0]), "utf8") || "");
  return body
    .split(/\r?\n/)
    .map((line: string) => line.trim())
    .filter(Boolean)
    .map((line: string) => {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      return {
        keep: Boolean(parsed.keep),
        title: String(parsed.title || ""),
        sourceType: String(parsed.sourceType || parsed.source_type || ""),
        reportType: String(parsed.reportType || parsed.report_type || parsed.sourceType || parsed.source_type || ""),
        sourceName: String(parsed.sourceName || parsed.source_name || ""),
        targetName: String(parsed.targetName || parsed.target_name || ""),
        targetCode: normalizeKnowledgeStockCode(String(parsed.targetCode || parsed.target_code || "")),
        publishedAt: String(parsed.publishedAt || parsed.published_at || ""),
        score: Number(parsed.score || 0) || 0,
        method: String(parsed.method || ""),
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : undefined,
        reasons: Array.isArray(parsed.reasons)
          ? parsed.reasons.map((item) => String(item || "").trim()).filter(Boolean)
          : [],
        docId: String(parsed.docId || parsed.doc_id || ""),
        file: String(parsed.file || ""),
        url: String(parsed.url || ""),
        accessMethod: String(parsed.accessMethod || parsed.access_method || ""),
        summary: String(parsed.summary || ""),
        contentPreview: String(parsed.contentPreview || parsed.content_preview || ""),
        content: String(parsed.content || ""),
      } satisfies LocalFilteredReviewRow;
    })
    .filter((row: LocalFilteredReviewRow) => Boolean(row.docId));
}

async function readLocalKnowledgeProcessingConfig(): Promise<Record<string, unknown>> {
  const fs = getNodeBuiltin("node:fs/promises");
  const path = getNodeBuiltin("node:path");
  if (!fs || !path) {
    return {};
  }
  const candidates = [
    path.resolve(getProcessCwd(), "config", "knowledge-processing.json"),
    path.resolve(getProcessCwd(), "..", "stock-info", "config", "knowledge-processing.json"),
    "/Users/terry/git/stock-info/config/knowledge-processing.json",
  ];
  for (const configFile of candidates) {
    if (!(await pathExists(configFile))) {
      continue;
    }
    try {
      return objectRecord(JSON.parse(String(await fs.readFile(configFile, "utf8") || "{}")));
    } catch {
      return {};
    }
  }
  return {};
}

async function resolveLocalReviewDir(): Promise<string> {
  const path = getNodeBuiltin("node:path");
  const config = await readLocalKnowledgeProcessingConfig();
  const cwd = getProcessCwd();
  const candidates = [
    path ? path.resolve(cwd, "data", "knowledge-review") : "",
    String(config.reviewDir || "").trim(),
    path ? path.resolve(cwd, "..", "data", "stock-info", "knowledge", "reviews") : "",
    path ? path.resolve(cwd, "..", "stock-info", "..", "data", "stock-info", "knowledge", "reviews") : "",
    "/Users/terry/git/data/stock-info/knowledge/reviews",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return candidates[0] || "../data/stock-info/knowledge/reviews";
}

async function loadLocalFilteredReviewKeptDocIds(): Promise<Set<string>> {
  const fs = getNodeBuiltin("node:fs/promises");
  const path = getNodeBuiltin("node:path");
  if (!fs || !path) {
    return new Set<string>();
  }
  const file = path.join(await resolveLocalReviewDir(), "topic-filter-kept.json");
  if (!(await pathExists(file))) {
    return new Set<string>();
  }
  try {
    const parsed = JSON.parse(String(await fs.readFile(file, "utf8") || "[]"));
    return new Set(
      Array.isArray(parsed)
        ? parsed.map((item) => String(item || "").trim()).filter(Boolean)
        : [],
    );
  } catch {
    return new Set<string>();
  }
}

async function saveLocalFilteredReviewKeptDocId(docId: string): Promise<void> {
  const fs = getNodeBuiltin("node:fs/promises");
  const path = getNodeBuiltin("node:path");
  if (!fs || !path) {
    return;
  }
  const file = path.join(await resolveLocalReviewDir(), "topic-filter-kept.json");
  const ids = await loadLocalFilteredReviewKeptDocIds();
  ids.add(docId);
  await fs.writeFile(file, `${JSON.stringify([...ids], null, 2)}\n`, "utf8");
}

function matchesLocalFilteredReviewQuery(row: LocalFilteredReviewRow, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  const haystacks = [
    row.title,
    row.sourceName,
    row.targetName,
    row.targetCode,
    row.docId,
    row.file,
    row.method,
    ...row.reasons,
  ];
  return haystacks.some((value) => String(value || "").toLowerCase().includes(needle));
}

function compareLocalFilteredReviewRows(left: LocalFilteredReviewRow, right: LocalFilteredReviewRow): number {
  if (right.score !== left.score) {
    return right.score - left.score;
  }
  return firstNonEmpty(right.publishedAt).localeCompare(firstNonEmpty(left.publishedAt));
}

function mapLocalFilteredReviewListItem(
  row: LocalFilteredReviewRow,
  _contentContext: KnowledgeContentUrlContext,
): Record<string, unknown> {
  const stockLinks = row.targetCode
    ? [{
      name: row.targetName,
      code: row.targetCode,
      aliases: buildSecurityAliases(row.targetName, row.targetCode, []),
    }]
    : [];
  return {
    doc_id: row.docId,
    source_type: "filtered_review",
    report_type: row.reportType || row.sourceType || "news",
    source_name: displaySourceName(row.sourceName),
    title: row.title,
    url: row.url,
    published_at: row.publishedAt,
    fetched_at: "",
    event_time: row.publishedAt,
    target_name: row.targetName,
    target_code: row.targetCode,
    discovery_method: "filtered_review",
    access_method: row.accessMethod || "markdown",
    summary: row.summary,
    content_preview: row.contentPreview || truncatePreview([row.reasons.join("；"), row.title].filter(Boolean).join(" "), 280),
    metadata: {
      sourceFile: row.file,
      reviewMethod: row.method,
    },
    stock_links: stockLinks,
    tags: ["filtered"],
    recommendation: {
      level: "",
      score: row.score,
      tags: ["filtered"],
      reasons: row.reasons,
    },
    rankScore: row.score,
    rankReasons: row.reasons,
    filter: {
      method: row.method,
      score: row.score,
      confidence: row.confidence ?? null,
      reasons: row.reasons,
      status: "pending",
      sourceFile: row.file,
    },
    favorited: false,
  };
}

async function mapLocalFilteredReviewDetail(
  row: LocalFilteredReviewRow,
  contentContext: KnowledgeContentUrlContext,
): Promise<Record<string, unknown>> {
  const source = await readLocalReviewSourceData(row.file);
  const content = row.content || extractLocalReviewContent(source);
  return {
    ...mapLocalFilteredReviewListItem(row, contentContext),
    url: row.url || String(source.url || source.origin_url || ""),
    access_method: row.accessMethod || inferLocalReviewAccessMethod(source, row.file, content),
    summary: row.summary || buildLocalReviewSummary(source, content),
    content_preview: row.contentPreview || buildLocalReviewPreview(content, row.title),
    content,
    metadata: {
      ...objectRecord(mapLocalFilteredReviewListItem(row, contentContext).metadata),
      sourceFile: row.file,
      source: String(source.source || source.source_name || row.sourceName || ""),
    },
  };
}

async function readLocalReviewSourceData(relativeFile: string): Promise<Record<string, unknown>> {
  const fs = getNodeBuiltin("node:fs/promises");
  const path = getNodeBuiltin("node:path");
  if (!fs || !path || !relativeFile) {
    return {};
  }
  const config = await readLocalKnowledgeProcessingConfig();
  const configuredInputDirs = Array.isArray(config.inputDirs)
    ? config.inputDirs.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const inputDirs = [
    ...configuredInputDirs,
    "/Users/terry/git/data/news",
    "/Users/terry/git/data/reports",
  ];
  for (const dir of inputDirs) {
    const fullPath = path.resolve(dir, relativeFile);
    if (!(await pathExists(fullPath))) {
      continue;
    }
    try {
      const ext = String(path.extname(fullPath) || "").toLowerCase();
      if (ext === ".json" || ext === ".jsonl") {
        const text = String(await fs.readFile(fullPath, "utf8") || "").trim();
        if (!text) {
          return {};
        }
        if (ext === ".jsonl") {
          const firstLine = text.split(/\r?\n/).map((line: string) => line.trim()).find(Boolean) || "{}";
          return objectRecord(JSON.parse(firstLine));
        }
        return objectRecord(JSON.parse(text));
      }
      if (ext === ".md" || ext === ".txt") {
        return { markdown: String(await fs.readFile(fullPath, "utf8") || "") };
      }
      return {};
    } catch {
      return {};
    }
  }
  return {};
}

function extractLocalReviewContent(source: Record<string, unknown>): string {
  const candidates = [
    source.markdown,
    source.md_text,
    source.summary,
    objectRecord(source.content).text,
    source.content,
  ];
  for (const candidate of candidates) {
    const value = typeof candidate === "string" ? candidate.trim() : "";
    if (!value) {
      continue;
    }
    if (/<[a-z][\s\S]*>/i.test(value)) {
      return normalizeHtmlSnippet(value);
    }
    return value;
  }
  return "";
}

function buildLocalReviewSummary(source: Record<string, unknown>, content: string): string {
  const summary = String(source.summary || "").trim();
  if (summary) {
    return summary;
  }
  return truncatePreview(content, 180);
}

function buildLocalReviewPreview(content: string, title: string): string {
  return truncatePreview(content || title, 280);
}

function normalizeHtmlSnippet(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function inferLocalReviewAccessMethod(source: Record<string, unknown>, relativeFile: string, content: string): string {
  const sourceUrl = String(source.url || source.origin_url || "").toLowerCase();
  const file = relativeFile.toLowerCase();
  if (String(source.accessMethod || source.access_method || "").trim()) {
    return String(source.accessMethod || source.access_method || "").trim();
  }
  if (sourceUrl.includes(".pdf") || file.endsWith(".pdf")) {
    return sourceUrl ? "remote_pdf" : "local_pdf_pending";
  }
  if (content) {
    return "markdown";
  }
  return "remote_url";
}

async function buildLocalReviewKeptDoc(row: LocalFilteredReviewRow): Promise<LocalReviewKeepDoc> {
  const source = await readLocalReviewSourceData(row.file);
  const content = row.content || extractLocalReviewContent(source);
  const contentKey = content ? `knowledge-content/local-review/${row.docId}.md` : "";
  const contentBytes = content ? new TextEncoder().encode(content).byteLength : 0;
  const metadata = sanitizeKnowledgeMetadata({
    source: String(source.source || source.source_name || row.sourceName || ""),
    inputRelativeFile: row.file,
    topicFilter: {
      keep: true,
      score: row.score,
      method: row.method,
      reasons: row.reasons,
      confidence: row.confidence ?? null,
    },
  }, row.targetCode ? [{
    name: row.targetName,
    code: row.targetCode,
    aliases: buildSecurityAliases(row.targetName, row.targetCode, []),
  }] : []);
  return {
    docId: row.docId,
    sourceType: row.sourceType || "local_news",
    reportType: row.reportType || row.sourceType || "news",
    sourceName: row.sourceName,
    title: row.title,
    url: row.url || String(source.url || source.origin_url || ""),
    publishedAt: row.publishedAt,
    fetchedAt: "",
    eventTime: row.publishedAt,
    targetName: row.targetName,
    targetCode: row.targetCode,
    accessMethod: row.accessMethod || inferLocalReviewAccessMethod(source, row.file, content),
    summary: row.summary || buildLocalReviewSummary(source, content),
    contentPreview: row.contentPreview || buildLocalReviewPreview(content, row.title),
    content,
    contentKey,
    contentType: "text/markdown; charset=utf-8",
    contentBytes,
    contentSha256: "",
    metadata,
    tags: ["review_kept"],
    recommendationReasons: row.reasons,
  };
}

async function pathExists(file: string): Promise<boolean> {
  const fs = getNodeBuiltin("node:fs/promises");
  if (!fs || !file) {
    return false;
  }
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function replaceKnowledgeLocalContentCache(
  db: AppEnv["Bindings"]["DB"],
  payload: { contentKey: string; contentType: string; contentEncoding: string; content: string },
  updatedAt: number,
): Promise<void> {
  const contentKey = String(payload.contentKey || "").trim();
  await db.prepare("delete from knowledge_local_content_cache_chunks where content_key = ?").bind(contentKey).run();
  await db.prepare("delete from knowledge_local_content_cache where content_key = ?").bind(contentKey).run();
  if (!contentKey || !payload.content) {
    return;
  }
  const bufferModule = getNodeBuiltin("node:buffer");
  const BufferCtor = bufferModule?.Buffer;
  const base64 = BufferCtor
    ? String(BufferCtor.from(payload.content, "utf8").toString("base64"))
    : bytesToBase64(new TextEncoder().encode(payload.content));
  const bytes = new TextEncoder().encode(payload.content);
  const sha256 = await sha256Hex(bytes);
  await db.prepare(
    `insert into knowledge_local_content_cache (
      content_key, content_type, content_encoding, content_sha256, content_bytes, updated_at
    ) values (?, ?, ?, ?, ?, ?)
    on conflict(content_key) do update set
      content_type=excluded.content_type,
      content_encoding=excluded.content_encoding,
      content_sha256=excluded.content_sha256,
      content_bytes=excluded.content_bytes,
      updated_at=excluded.updated_at`
  )
    .bind(contentKey, payload.contentType, payload.contentEncoding, sha256, bytes.byteLength, updatedAt)
    .run();
  const chunkInsert = db.prepare(
    `insert into knowledge_local_content_cache_chunks (content_key, chunk_index, payload_base64)
     values (?, ?, ?)
     on conflict(content_key, chunk_index) do update set payload_base64=excluded.payload_base64`
  );
  const chunkSize = 20000;
  const chunks: ReturnType<typeof chunkInsert.bind>[] = [];
  for (let index = 0; index * chunkSize < base64.length; index += 1) {
    chunks.push(chunkInsert.bind(contentKey, index, base64.slice(index * chunkSize, (index + 1) * chunkSize)));
  }
  if (chunks.length > 0) {
    await db.batch(chunks);
  }
}

async function replaceKnowledgeDocTags(
  db: AppEnv["Bindings"]["DB"],
  docId: string,
  tags: string[],
): Promise<void> {
  await db.prepare("delete from knowledge_doc_tags where doc_id = ?").bind(docId).run();
  if (tags.length === 0) {
    return;
  }
  const stmt = db.prepare(
    `insert into knowledge_doc_tags (doc_id, tag)
     values (?, ?)
     on conflict(doc_id, tag) do nothing`
  );
  await db.batch(tags.map((tag) => stmt.bind(docId, tag.toLowerCase())));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

function isLocalInformationProcessingRuntime(env: AppEnv["Bindings"]): boolean {
  return env.LLM_RUNTIME === "local" && isLocalDevelopmentRuntime(env);
}

function mapInformationRow(row: Record<string, unknown>): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key.endsWith("_json") && typeof value === "string") {
      try {
        mapped[key.slice(0, -5)] = JSON.parse(value);
        continue;
      } catch {
        // Preserve malformed historical payloads for audit rather than hiding them.
      }
    }
    mapped[key] = value;
  }
  return mapped;
}

async function enqueueInformationDocuments(
  db: AppEnv["Bindings"]["DB"],
  documentIds: string[],
  triggerSource: "automatic" | "cli" | "manual",
): Promise<void> {
  const now = Date.now();
  await db.batch(documentIds.map((docId) => db.prepare(
    `insert into information_processing_jobs (job_id, doc_id, status, attempt_count, trigger_source, created_at, updated_at)
     values (?, ?, 'queued', 0, ?, ?, ?)
     on conflict(doc_id) do update set status = 'queued', attempt_count = 0, trigger_source = excluded.trigger_source, last_run_id = null, last_error = null, updated_at = excluded.updated_at`,
  ).bind(`information-job:${crypto.randomUUID()}`, docId, triggerSource, now, now)));
}

async function enqueueUnprocessedInformationDocuments(
  db: AppEnv["Bindings"]["DB"],
  maxAgeDays: number,
  limit: number,
  titleKeywords: string[],
  triggerSource: "automatic" | "cli" | "manual",
): Promise<string[]> {
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
  const activeProcessingCutoff = Date.now() - 2 * 60 * 1000;
  const titleClause = titleKeywords.length > 0
    ? ` and (${titleKeywords.map(() => "d.title like ? escape '\\'").join(" or ")})`
    : "";
  const candidates = await db.prepare(
    `select d.doc_id
       from knowledge_docs d
      where d.sort_time >= ?
        ${titleClause}
        and not exists (
          select 1 from information_processing_jobs j
           where j.doc_id = d.doc_id
             and (j.status = 'queued' or (j.status = 'running' and j.updated_at >= ?))
        )
        and coalesce((
          select p.action
            from knowledge_preprocessing_decisions p
           where p.version_id = (
             select v3.version_id from knowledge_document_versions v3
              where v3.doc_id = d.doc_id order by v3.created_at desc limit 1
           )
           order by p.decided_at desc limit 1
        ), '') not in ('exact_duplicate', 'template_duplicate', 'pure_market_snapshot', 'empty_content')
        and not exists (
          select 1 from knowledge_document_versions v
          join knowledge_processing_runs r on r.version_id = v.version_id
          join knowledge_document_results result on result.run_id = r.run_id
          where v.version_id = (
            select v2.version_id from knowledge_document_versions v2 where v2.doc_id = d.doc_id order by v2.created_at desc limit 1
          )
            and r.stage = 'document_analysis' and r.prompt_version = ? and r.status in ('succeeded', 'needs_review')
        )
      order by d.sort_time desc, d.doc_id desc
      limit ?`,
  ).bind(cutoff, ...titleKeywords.map((keyword) => `%${escapeLike(keyword)}%`), activeProcessingCutoff, INFORMATION_PROCESSING_PROMPT_VERSION, limit).all<{ doc_id: string }>();
  const documentIds = candidates.results.map((row) => row.doc_id);
  if (documentIds.length > 0) await enqueueInformationDocuments(db, documentIds, triggerSource);
  return documentIds;
}

function normalizeInformationTriggerSource(value: unknown): "automatic" | "cli" | "manual" {
  return value === "automatic" || value === "cli" ? value : "manual";
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}
