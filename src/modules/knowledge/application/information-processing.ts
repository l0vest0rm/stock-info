import preprocessingConfig from "../../../../config/knowledge-preprocessing.json";
import ontologyConfig from "../../../../config/knowledge-ontology.json";
import {
  INFORMATION_PROCESSING_DOCUMENT_ANALYSIS_SYSTEM_PROMPT,
  INFORMATION_PROCESSING_DOCUMENT_ANALYSIS_USER_PROMPT,
} from "../../../generated/prompt-text";
import { requestLlmText } from "../../../shared/llm-client";
import type { Bindings } from "../../../types";

const MODEL = "gpt-5.6-luna" as const;
const MAX_OUTPUT_TOKENS = 2500;
const SCHEMA_VERSION = "information-records-v2";
export const INFORMATION_PROCESSING_PROMPT_VERSION = "information-processing-v19";
const ONTOLOGY_VERSION = ontologyConfig.version;

type InformationType = "fact" | "guidance" | "forecast" | "opinion" | "event" | "relationship";
type PeriodPolicy = "required" | "optional" | "forbidden";
type CategoryRule = { informationTypes: InformationType[]; periodPolicy: PeriodPolicy };
const informationExtractionConfig = ontologyConfig.informationExtraction as {
  modelContractVersion: string;
  informationTypes: InformationType[];
  categories: Record<string, CategoryRule>;
};
const INFORMATION_TYPES = new Set<InformationType>(informationExtractionConfig.informationTypes);
const CATEGORY_RULES = informationExtractionConfig.categories;

type SourceDocument = {
  doc_id: string;
  source_type: string;
  report_type: string | null;
  title: string;
  url: string | null;
  content_url: string | null;
  published_at: string | null;
  fetched_at: string | null;
  content_key: string | null;
  content_sha256: string | null;
  content_preview: string | null;
};

type PreprocessingAction = "pass" | "exact_duplicate" | "template_duplicate" | "pure_market_snapshot" | "empty_content" | "fetch_error";
type JsonRecord = Record<string, unknown>;

export type InformationProcessResult = {
  versionId: string;
  runId: string | null;
  action: PreprocessingAction | "reused";
  outcome?: "extracted" | "no_information" | "needs_review";
  recordCount: number;
  needsReview: boolean;
};

export type InformationProcessingModelRequest = {
  runId: string;
  versionId: string;
  model: typeof MODEL;
  maxTokens: number;
  instructions: string;
  input: string;
};

export type PreparedInformationProcessing =
  | { kind: "complete"; result: InformationProcessResult }
  | { kind: "model"; request: InformationProcessingModelRequest };

export async function processInformationDocument(env: Bindings, docId: string): Promise<InformationProcessResult> {
  // This processor owns a remote-model call. Keep the production prohibition
  // at the application boundary so a scheduler cannot create a partial run or
  // bypass an API-level local-runtime guard.
  if (env.LLM_RUNTIME !== "local") throw new Error("information processing is only available in local LLM runtime");
  const prepared = await prepareInformationDocument(env, docId);
  if (prepared.kind === "complete") return prepared.result;
  try {
    const response = await requestLlmText(env, {
      model: prepared.request.model,
      maxTokens: prepared.request.maxTokens,
      reasoningEffort: "low",
      cacheEnabled: false,
      messages: [
        { role: "system", content: prepared.request.instructions },
        { role: "user", content: prepared.request.input },
      ],
      targetType: "knowledge_document",
      targetId: prepared.request.versionId,
      idempotencyKey: `information-document:${prepared.request.versionId}:${INFORMATION_PROCESSING_PROMPT_VERSION}`,
      promptVersion: INFORMATION_PROCESSING_PROMPT_VERSION,
      priority: 500,
    });
    return await completeInformationProcessing(env, prepared.request, response.text, response.raw, response.cached);
  } catch (error) {
    await failInformationProcessing(env, prepared.request, error);
    throw error;
  }
}

/**
 * Executes only D1/R2 preparation. The returned model request is deliberately
 * transport-neutral so the local Node runner, not the Worker, owns long SSE.
 */
export async function prepareInformationDocument(env: Bindings, docId: string): Promise<PreparedInformationProcessing> {
  if (env.LLM_RUNTIME !== "local") throw new Error("information processing is only available in local LLM runtime");
  const document = await env.DB.prepare(
    `select d.doc_id, d.source_type, d.report_type, d.title, d.url, d.published_at, d.fetched_at,
            c.content_key, c.content_url, c.content_sha256, d.content_preview
       from knowledge_docs d left join knowledge_doc_content_refs c on c.doc_id = d.doc_id where d.doc_id = ?`,
  ).bind(docId).first<SourceDocument>();
  if (!document) throw new Error(`knowledge document not found: ${docId}`);

  const content = await loadDocumentContent(env, document);
  const contentHash = await digestHex(content || document.content_preview || "");
  const version = await ensureVersion(env.DB, document, contentHash);
  const gate = await preprocess(env.DB, document, content, contentHash, version.versionId);
  if (gate.action !== "pass") {
    return { kind: "complete", result: { versionId: version.versionId, runId: null, action: gate.action, recordCount: 0, needsReview: false } };
  }

  const completed = await env.DB.prepare(
    `select r.run_id, d.outcome from knowledge_processing_runs r
       join knowledge_document_results d on d.run_id = r.run_id
      where r.version_id = ? and r.stage = 'document_analysis' and r.prompt_version = ? and r.status = 'succeeded'
      order by r.completed_at desc limit 1`,
  ).bind(version.versionId, INFORMATION_PROCESSING_PROMPT_VERSION).first<{ run_id: string; outcome: "extracted" | "no_information" }>();
  if (completed) {
    return { kind: "complete", result: { versionId: version.versionId, runId: completed.run_id, action: "reused", outcome: completed.outcome, recordCount: 0, needsReview: false } };
  }

  const runId = `knowledge-run:${crypto.randomUUID()}`;
  const inputHash = await digestHex(JSON.stringify({ contentHash, prompt: INFORMATION_PROCESSING_PROMPT_VERSION, schema: SCHEMA_VERSION, ontology: ONTOLOGY_VERSION }));
  const startedAt = Date.now();
  await env.DB.prepare(
    `insert into knowledge_processing_runs (run_id, version_id, stage, model, prompt_version, schema_version, ontology_version, input_hash, status, started_at)
     values (?, ?, 'document_analysis', ?, ?, ?, ?, ?, 'running', ?)`,
  ).bind(runId, version.versionId, MODEL, INFORMATION_PROCESSING_PROMPT_VERSION, SCHEMA_VERSION, ONTOLOGY_VERSION, inputHash, startedAt).run();

  return {
    kind: "model",
    request: {
      runId,
      versionId: version.versionId,
      model: MODEL,
      maxTokens: MAX_OUTPUT_TOKENS,
      instructions: INFORMATION_PROCESSING_DOCUMENT_ANALYSIS_SYSTEM_PROMPT,
      input: render(INFORMATION_PROCESSING_DOCUMENT_ANALYSIS_USER_PROMPT, {
        TITLE: document.title,
        SOURCE_TYPE: document.source_type,
        REPORT_TYPE: document.report_type || "",
        PUBLISHED_AT: document.published_at || "",
        CONTENT: content,
        CATEGORY_CATALOG: categoryCatalogForPrompt(),
      }),
    },
  };
}

export async function completeInformationProcessing(
  env: Bindings,
  request: InformationProcessingModelRequest,
  text: string,
  raw: unknown,
  cached = false,
): Promise<InformationProcessResult> {
  try {
    const returnedModel = assertExpectedReturnedModel(raw);
    const rawOutputKey = await saveRawOutput(env, request.runId, raw);
    const analysis = parseStructuredAnalysis(text);
    const status = analysis.outcome === "needs_review" ? "needs_review" : "succeeded";
    const recordCount = await persistStructuredResult(env.DB, request.runId, request.versionId, analysis);
    await env.DB.prepare(
      `update knowledge_processing_runs set returned_model = ?, raw_output_key = ?, status = ?, usage_json = ?, validation_json = ?, completed_at = ? where run_id = ?`,
    ).bind(returnedModel, rawOutputKey, status, JSON.stringify({ cached }), JSON.stringify({ valid: true, mode: "text_first" }), Date.now(), request.runId).run();
    return { versionId: request.versionId, runId: request.runId, action: "pass", outcome: analysis.outcome, recordCount, needsReview: status === "needs_review" };
  } catch (error) {
    await failInformationProcessing(env, request, error);
    throw error;
  }
}

export async function failInformationProcessing(env: Bindings, request: Pick<InformationProcessingModelRequest, "runId" | "versionId">, _error: unknown): Promise<void> {
  await discardFailedInformationAttempt(env.DB, request.runId, request.versionId);
}

type InformationRecord = {
  entity: string;
  informationType: InformationType;
  category: string;
  period: string | null;
  statement: string;
  /** Null unless a third-party forecast has a complete source-declared measurement contract. */
  forecastMeasurement: ForecastMeasurement | null;
};

type ForecastMeasurement = {
  fiscalYear: number;
  rawValue: number;
  rawUnit: "currency" | "ten_thousand_currency" | "million_currency" | "hundred_million_currency" | "billion_currency" | "percent" | "currency_per_share";
  currency: string | null;
  accountingBasis: "gaap" | "non_gaap" | "adjusted" | "unspecified";
  ownershipBasis: "attributable_to_parent" | "consolidated" | "common_shareholders" | "unspecified";
  shareBasis: "basic" | "diluted" | "unspecified";
};

const FORECAST_MEASUREMENT_CATEGORIES = new Set(["revenue", "revenue_growth", "net_profit", "net_profit_growth", "gross_margin", "eps", "operating_cash_flow"]);
const FORECAST_RAW_UNITS = new Set<ForecastMeasurement["rawUnit"]>(["currency", "ten_thousand_currency", "million_currency", "hundred_million_currency", "billion_currency", "percent", "currency_per_share"]);
const FORECAST_ACCOUNTING_BASES = new Set<ForecastMeasurement["accountingBasis"]>(["gaap", "non_gaap", "adjusted", "unspecified"]);
const FORECAST_OWNERSHIP_BASES = new Set<ForecastMeasurement["ownershipBasis"]>(["attributable_to_parent", "consolidated", "common_shareholders", "unspecified"]);
const FORECAST_SHARE_BASES = new Set<ForecastMeasurement["shareBasis"]>(["basic", "diluted", "unspecified"]);

type StructuredAnalysis = {
  outcome: "extracted" | "no_information" | "needs_review";
  records: InformationRecord[];
  rejectedRecordCount: number;
};

export function parseStructuredAnalysis(raw: string): StructuredAnalysis {
  const parsed = object(parseJsonResponse(raw));
  if (!Array.isArray(parsed.records)) throw new Error("document analysis must include a records array");
  const sourceRecords = parsed.records;
  const accepted: InformationRecord[] = [];
  let rejectedRecordCount = Math.max(0, sourceRecords.length - 3);
  for (const item of sourceRecords.slice(0, 3)) {
    const record = parseInformationRecord(item);
    if (record) accepted.push(record);
    else rejectedRecordCount += 1;
  }
  return {
    outcome: sourceRecords.length === 0 ? "no_information" : (accepted.length > 0 && rejectedRecordCount === 0 ? "extracted" : "needs_review"),
    records: accepted,
    rejectedRecordCount,
  };
}

function parseInformationRecord(value: unknown): InformationRecord | null {
  const raw = object(value);
  const entity = text(raw.entity);
  const informationType = text(raw.informationType) as InformationType;
  const category = text(raw.category);
  const statement = text(raw.statement);
  const rule = CATEGORY_RULES[category];
  if (!entity || entity.length > 120 || !statement || statement.length > 120 || !statement.includes(entity) || !INFORMATION_TYPES.has(informationType) || !rule) return null;
  if (!rule.informationTypes.includes(informationType)) return null;
  const period = nullableText(raw.period);
  if (rule.periodPolicy === "required" && !period) return null;
  if (rule.periodPolicy === "forbidden" && period) return null;
  if (period && !isPeriodExpression(period)) return null;
  // A rejected measurement must not discard the source-level record.  It only
  // means this record is not a machine-readable forecast amount and remains
  // unavailable to the forecast ledger until a later document version carries
  // a complete, source-declared value contract.
  const forecastMeasurement = informationType === "forecast" && FORECAST_MEASUREMENT_CATEGORIES.has(category)
    ? parseForecastMeasurement(raw.forecastMeasurement, period)
    : null;
  return { entity, informationType, category, period, statement, forecastMeasurement };
}

function parseForecastMeasurement(value: unknown, period: string | null): ForecastMeasurement | null {
  const raw = object(value);
  if (!Number.isInteger(raw.fiscalYear) || !Number.isFinite(raw.rawValue)
    || typeof raw.rawUnit !== "string" || !FORECAST_RAW_UNITS.has(raw.rawUnit as ForecastMeasurement["rawUnit"])
    || typeof raw.accountingBasis !== "string" || !FORECAST_ACCOUNTING_BASES.has(raw.accountingBasis as ForecastMeasurement["accountingBasis"])
    || typeof raw.ownershipBasis !== "string" || !FORECAST_OWNERSHIP_BASES.has(raw.ownershipBasis as ForecastMeasurement["ownershipBasis"])
    || typeof raw.shareBasis !== "string" || !FORECAST_SHARE_BASES.has(raw.shareBasis as ForecastMeasurement["shareBasis"])) return null;
  const fiscalYear = Number(raw.fiscalYear);
  if (fiscalYear < 1900 || fiscalYear > 2200 || !forecastPeriodMatchesFiscalYear(period, fiscalYear)) return null;
  if (raw.currency !== undefined && raw.currency !== null && !text(raw.currency)) return null;
  return {
    fiscalYear,
    rawValue: Number(raw.rawValue),
    rawUnit: raw.rawUnit as ForecastMeasurement["rawUnit"],
    currency: raw.currency === undefined || raw.currency === null ? null : text(raw.currency),
    accountingBasis: raw.accountingBasis as ForecastMeasurement["accountingBasis"],
    ownershipBasis: raw.ownershipBasis as ForecastMeasurement["ownershipBasis"],
    shareBasis: raw.shareBasis as ForecastMeasurement["shareBasis"],
  };
}

function forecastPeriodMatchesFiscalYear(period: string | null, fiscalYear: number): boolean {
  return period === `${fiscalYear}FY` || period === `${fiscalYear}Q1`
    || period === `${fiscalYear}Q2` || period === `${fiscalYear}Q3` || period === `${fiscalYear}Q4`;
}

function isPeriodExpression(value: string): boolean {
  if (value.length > 24 || /[\n\r{}\[\]]/.test(value)) return false;
  if (/^\d{4}(?:Q[1-4]|H[12]|FY)$/.test(value)) return true;
  if (/^截至\d{4}-\d{2}-\d{2}$/.test(value)) return true;
  if (/^(?:近|最近|过去|未来)\d{1,2}(?:天|周|个月|月|季度|年)$/.test(value)) return true;
  return /^\d{4}年(?:第?[一二三四1-4]季度|上半年|下半年|全年|前\d{1,2}个月)$/.test(value);
}

function parseJsonResponse(value: string): unknown {
  const normalized = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(normalized);
  } catch {
    throw new Error("document analysis must be valid JSON");
  }
}

export async function persistStructuredResult(db: D1Database, runId: string, versionId: string, analysis: StructuredAnalysis): Promise<number> {
  const now = Date.now();
  const resultId = `knowledge-information-result:${crypto.randomUUID()}`;
  await db.prepare(
      `insert into knowledge_document_results (
       result_id, run_id, version_id, outcome, created_at
     ) values (?, ?, ?, ?, ?)`,
  ).bind(
    resultId, runId, versionId, analysis.outcome, now,
  ).run();
  const recordStatements = analysis.records.map((record, sortOrder) => db.prepare(
    `insert into knowledge_information_records (
      information_id, result_id, entity, information_type, category, period, statement, forecast_measurement_json, sort_order, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    `knowledge-information-record:${crypto.randomUUID()}`, resultId, record.entity, record.informationType,
    record.category, record.period, record.statement, JSON.stringify(record.forecastMeasurement ?? {}), sortOrder, now,
  ));
  if (recordStatements.length > 0) await db.batch(recordStatements);
  return analysis.records.length;
}

async function loadDocumentContent(env: Bindings, document: SourceDocument): Promise<string> {
  if (!document.content_key) return document.content_preview || "";
  const fromBucket = await env.KNOWLEDGE_CONTENT_BUCKET?.get(document.content_key);
  if (fromBucket) return await fromBucket.text();
  const header = await env.DB.prepare("select content_encoding from knowledge_local_content_cache where content_key = ?")
    .bind(document.content_key).first<{ content_encoding: string }>();
  const chunks = await env.DB.prepare("select payload_base64 from knowledge_local_content_cache_chunks where content_key = ? order by chunk_index")
    .bind(document.content_key).all<{ payload_base64: string }>();
  if (!header || chunks.results.length === 0) return document.content_preview || "";
  if (header.content_encoding !== "identity") {
    const localBaseUrl = env.LLM_RUNTIME === "local" ? String(env.KNOWLEDGE_CONTENT_PUBLIC_BASE_URL || "").replace(/\/$/, "") : "";
    const urls = [
      localBaseUrl ? `${localBaseUrl}/${document.content_key}` : "",
      document.content_url || "",
    ].filter((url, index, values) => Boolean(url) && values.indexOf(url) === index);
    if (urls.length === 0) throw new Error(`unsupported local knowledge content encoding: ${header.content_encoding}`);
    let lastStatus = 0;
    for (const url of urls) {
      const response = await fetch(url);
      if (response.ok) return (await response.text()).trim();
      lastStatus = response.status;
    }
    const location = localBaseUrl ? "local cache or source" : "source";
    throw new Error(`knowledge document content unavailable in ${location}: ${lastStatus || "unavailable"}`);
  }
  return new TextDecoder().decode(base64ToBytes(chunks.results.map((row) => row.payload_base64).join("")));
}

async function ensureVersion(db: D1Database, document: SourceDocument, contentHash: string): Promise<{ versionId: string }> {
  const known = await db.prepare("select version_id from knowledge_document_versions where doc_id = ? and content_hash = ?")
    .bind(document.doc_id, contentHash).first<{ version_id: string }>();
  if (known) return { versionId: known.version_id };
  const versionId = `knowledge-version:${crypto.randomUUID()}`;
  await db.prepare(
    `insert into knowledge_document_versions (version_id, doc_id, source_url, source_hash, content_hash, raw_content_key, normalized_content_key, published_at, fetched_at, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(versionId, document.doc_id, document.url, document.content_sha256, contentHash, document.content_key, document.content_key, document.published_at, document.fetched_at, Date.now()).run();
  return { versionId };
}

export async function discardFailedInformationAttempt(db: D1Database, runId: string, versionId: string): Promise<void> {
  await db.batch([
    db.prepare(`delete from knowledge_information_records where result_id in (
      select result_id from knowledge_document_results where run_id = ?
    )`).bind(runId),
    db.prepare("delete from knowledge_document_results where run_id = ?").bind(runId),
    db.prepare("delete from knowledge_processing_runs where run_id = ?").bind(runId),
  ]);
  const remainingRun = await db.prepare("select 1 from knowledge_processing_runs where version_id = ? limit 1")
    .bind(versionId).first();
  if (remainingRun) return;
  await db.batch([
    db.prepare("delete from knowledge_preprocessing_decisions where version_id = ?").bind(versionId),
    db.prepare("delete from knowledge_document_versions where version_id = ?").bind(versionId),
  ]);
}

async function preprocess(
  db: D1Database,
  document: SourceDocument,
  content: string,
  contentHash: string,
  versionId: string,
): Promise<{ action: PreprocessingAction }> {
  const clean = content.trim();
  let action: PreprocessingAction = "pass";
  let reasonCode = "eligible_content";
  let templateId: string | null = null;
  let duplicateOfVersionId: string | null = null;
  if (clean.length < preprocessingConfig.minimumContentRequirements.minimumNonWhitespaceChars) {
    action = "empty_content"; reasonCode = "minimum_content_not_met";
  } else if (preprocessingConfig.sourceTypeExclusions.includes(document.source_type)) {
    action = "pure_market_snapshot"; reasonCode = "excluded_source_type";
  } else if (!preprocessingConfig.reportAndAnnouncementBypasses.includes(document.source_type)) {
    const lowValueTitleRule = preprocessingConfig.lowValueTitleRules.find((candidate) => new RegExp(candidate.titlePattern, "i").test(document.title));
    if (lowValueTitleRule) {
      action = "pure_market_snapshot"; reasonCode = "low_value_title"; templateId = lowValueTitleRule.id;
    }
    const rule = !lowValueTitleRule && preprocessingConfig.exactTemplateRules.find((candidate) => {
      const titleMatches = new RegExp(candidate.titlePattern, "i").test(document.title);
      const bodyMatches = new RegExp(candidate.bodyPattern, "i").test(clean);
      const operational = /(?:公告|订单|产能|产品|收入|利润|客户|行业|经营|业绩|发布)/.test(clean);
      return titleMatches && bodyMatches && (!candidate.requiresNoOperatingNarrative || !operational);
    });
    if (rule) { action = "pure_market_snapshot"; reasonCode = "exact_market_template"; templateId = rule.id; }
  }
  if (action === "pass" && preprocessingConfig.duplicatePolicies.sameContentHash === "exact_duplicate") {
    const duplicate = await db.prepare(
      "select version_id from knowledge_document_versions where content_hash = ? and version_id != ? order by created_at asc limit 1",
    ).bind(contentHash, versionId).first<{ version_id: string }>();
    if (duplicate) {
      action = "exact_duplicate"; reasonCode = "same_content_hash"; duplicateOfVersionId = duplicate.version_id;
    }
  }
  if (action === "pass" && document.url?.trim() && preprocessingConfig.duplicatePolicies.sameSourceAndNormalizedUrl === "exact_duplicate") {
    const duplicate = await db.prepare(
      "select version_id from knowledge_document_versions where source_url = ? and version_id != ? order by created_at asc limit 1",
    ).bind(document.url.trim(), versionId).first<{ version_id: string }>();
    if (duplicate) {
      action = "exact_duplicate"; reasonCode = "same_source_url"; duplicateOfVersionId = duplicate.version_id;
    }
  }
  await db.prepare(
    `insert into knowledge_preprocessing_decisions (decision_id, version_id, action, reason_code, rule_version, matched_source_type, matched_template_id, duplicate_of_version_id, details_json, decided_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(`knowledge-gate:${crypto.randomUUID()}`, versionId, action, reasonCode, preprocessingConfig.ruleVersion, document.source_type, templateId, duplicateOfVersionId, JSON.stringify({ contentHash }), Date.now()).run();
  return { action };
}

function categoryCatalogForPrompt(): string {
  return Object.entries(CATEGORY_RULES)
    .map(([category, rule]) => `${category}: ${rule.informationTypes.join("|")}；period=${rule.periodPolicy}`)
    .join("\n");
}

function render(template: string, values: Record<string, string>): string { return Object.entries(values).reduce((result, [key, value]) => result.replaceAll(`{{${key}}}`, value), template); }
function object(value: unknown): JsonRecord { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {}; }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : String(value ?? "").trim(); }
function nullableText(value: unknown): string | null {
  const result = text(value);
  return result && !/^(?:无|不详|暂无|-)$/.test(result) ? result : null;
}
async function digestHex(value: string): Promise<string> { const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)); return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
function base64ToBytes(value: string): Uint8Array { const binary = atob(value); return Uint8Array.from(binary, (char) => char.charCodeAt(0)); }

function assertExpectedReturnedModel(raw: unknown): string {
  const candidate = object(raw).model;
  const returnedModel = typeof candidate === "string" && candidate.trim() ? candidate.trim() : MODEL;
  if (returnedModel !== MODEL) throw new Error(`information processing model mismatch: expected=${MODEL} returned=${returnedModel}`);
  return returnedModel;
}

async function saveRawOutput(env: Bindings, runId: string, raw: unknown): Promise<string | null> {
  if (!env.RAW_BUCKET || raw === undefined) return null;
  const key = `knowledge-processing-runs/${runId}.json`;
  await env.RAW_BUCKET.put(key, JSON.stringify(raw), { httpMetadata: { contentType: "application/json" } });
  return key;
}
