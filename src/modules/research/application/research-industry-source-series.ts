import extractionConfig from "../../../../config/research-industry-source-extraction.json";
import { requestLlmText } from "../../../shared/llm-client";
import type { Bindings } from "../../../types";

type Row = Record<string, unknown>;
type Authority = "government" | "official_association" | "official_exchange" | "regulator";
type SourceDocument = { docId: string; sourceType: Authority; title: string; url: string; contentKey: string };
type Extracted = { industryKey: string; metricKey: string; metricLabel: string; periodLabel: string; numericValue: number; unit: string; currency: string | null; amountScale: string | null; geographicScope: string | null; productScope: string | null; statisticalMethod: string | null; evidenceQuote: string; evidenceLocator: string };

const config = extractionConfig as { version: string; model: "gpt-5.6-luna"; maxOutputTokens: number; allowedSourceTypes: Authority[]; systemPrompt: string; userTemplate: string };

/** Local-only source processor for already imported official/association
 * documents. It does not search the web, accept a browser-supplied number, or
 * promote a research report to an industry statistic. */
export async function syncResearchIndustrySourceSeries(env: Bindings, securityCode: string, now = Date.now()) {
  // Industry extraction is a local preparation task. A production page or
  // scheduler must read persisted observations only and can never acquire a
  // remote-model exception through this application entry point.
  if (env.LLM_RUNTIME !== "local") throw new Error("industry source extraction is only available in local LLM runtime");
  const code = required(securityCode, "securityCode").toUpperCase();
  const documents = await sourceDocuments(env.DB, code);
  const outcomes: Array<{ docId: string; status: "cached" | "processed" | "skipped"; items: number; reason?: string }> = [];
  for (const document of documents) {
    const cached = await env.DB.prepare(`select count(*) as count from research_industry_source_series_observations
      where security_code=? and source_doc_id=? and prompt_version=?`).bind(code, document.docId, config.version).first<{ count: number }>();
    if (Number(cached?.count) > 0) { outcomes.push({ docId: document.docId, status: "cached", items: Number(cached?.count) }); continue; }
    const content = await documentContent(env.DB, document.contentKey);
    if (!content) { outcomes.push({ docId: document.docId, status: "skipped", items: 0, reason: "imported_content_missing" }); continue; }
    const response = await requestLlmText(env, { model: config.model, maxTokens: config.maxOutputTokens, reasoningEffort: "low", cacheEnabled: false, messages: [
      { role: "system", content: config.systemPrompt },
      { role: "user", content: render(config.userTemplate, { SECURITY_CODE: code, TITLE: document.title, CONTENT: content }) },
    ] });
    const items = parse(response.text);
    if (!items.length) { outcomes.push({ docId: document.docId, status: "processed", items: 0 }); continue; }
    await env.DB.batch(items.map((item) => env.DB.prepare(`insert into research_industry_source_series_observations (
      industry_series_observation_id, security_code, industry_key, metric_key, metric_label, period_label, numeric_value, unit,
      currency, amount_scale, geographic_scope, product_scope, statistical_method, source_doc_id, source_url, source_title,
      source_authority, evidence_quote, evidence_locator, extraction_method, prompt_version, model, processed_at, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(security_code, source_doc_id, metric_key, period_label, prompt_version) do update set
      metric_label=excluded.metric_label, numeric_value=excluded.numeric_value, unit=excluded.unit, currency=excluded.currency,
      amount_scale=excluded.amount_scale, geographic_scope=excluded.geographic_scope, product_scope=excluded.product_scope,
      statistical_method=excluded.statistical_method, evidence_quote=excluded.evidence_quote, evidence_locator=excluded.evidence_locator,
      model=excluded.model, processed_at=excluded.processed_at`)
      .bind(`industry-series:${crypto.randomUUID()}`, code, item.industryKey, item.metricKey, item.metricLabel, item.periodLabel, item.numericValue, item.unit,
        item.currency, item.amountScale, item.geographicScope, item.productScope, item.statisticalMethod, document.docId, document.url, document.title,
        document.sourceType, item.evidenceQuote, item.evidenceLocator, `远端模型按 ${config.version} 从已导入的 ${document.sourceType} 原文提取；未输出的统计口径不补全。`, config.version, response.model, now, now)));
    outcomes.push({ docId: document.docId, status: "processed", items: items.length });
  }
  return { securityCode: code, promptVersion: config.version, documents: outcomes, processedDocuments: outcomes.filter((item) => item.status === "processed").length };
}

export async function loadResearchIndustrySourceSeries(db: D1Database, securityCode: string) {
  const code = required(securityCode, "securityCode").toUpperCase();
  try {
    const rows = await db.prepare(`select industry_series_observation_id as observationId, industry_key as industryKey, metric_key as metricKey,
      metric_label as metricLabel, period_label as periodLabel, numeric_value as numericValue, unit, currency, amount_scale as amountScale,
      geographic_scope as geographicScope, product_scope as productScope, statistical_method as statisticalMethod, source_doc_id as sourceDocId,
      source_url as sourceUrl, source_title as sourceTitle, source_authority as sourceAuthority, evidence_quote as evidenceQuote,
      evidence_locator as evidenceLocator, extraction_method as extractionMethod, prompt_version as promptVersion, model, processed_at as processedAt
      from research_industry_source_series_observations where security_code=? order by period_label desc, processed_at desc limit 200`).bind(code).all<Row>();
    const items = rows.results;
    const basis = new Set(items.map((item) => `${text(item.currency)}|${text(item.unit)}|${text(item.amountScale)}|${text(item.periodLabel)}`));
    return { availability: items.length ? "available" as const : "empty" as const, items, comparability: { status: basis.size <= 1 ? "available" as const : "partial" as const, basisCount: basis.size, rule: "行业序列只在指标、期间、币种、单位、数量级、地域与产品范围一致时可计算；不同统计口径只并列展示。" } };
  } catch (error) {
    if (String(error).includes("no such table: research_industry_source_series_observations")) return { availability: "unavailable" as const, items: [] as Row[], comparability: { status: "partial" as const, basisCount: 0, rule: "行业外部序列账本尚未初始化。" } };
    throw error;
  }
}

async function sourceDocuments(db: D1Database, code: string): Promise<SourceDocument[]> {
  const values = config.allowedSourceTypes;
  const placeholders = values.map(() => "?").join(", ");
  const rows = await db.prepare(`select doc.doc_id as docId, doc.source_type as sourceType, doc.title, doc.url, content.content_key as contentKey
    from knowledge_docs doc join knowledge_doc_content_refs content on content.doc_id=doc.doc_id
    where doc.target_code_normalized=? and doc.source_type in (${placeholders}) and doc.url like 'https://%'
    order by doc.sort_time desc limit 40`).bind(code, ...values).all<Row>();
  return rows.results.flatMap((row) => {
    const sourceType = text(row.sourceType) as Authority;
    const docId = text(row.docId); const title = text(row.title); const url = text(row.url); const contentKey = text(row.contentKey);
    return config.allowedSourceTypes.includes(sourceType) && docId && title && url && contentKey ? [{ docId, sourceType, title, url, contentKey }] : [];
  });
}
async function documentContent(db: D1Database, contentKey: string): Promise<string> {
  const rows = await db.prepare("select payload_base64 as payloadBase64 from knowledge_local_content_cache_chunks where content_key=? order by chunk_index").bind(contentKey).all<{ payloadBase64: string }>();
  if (!rows.results.length) return "";
  const raw = atob(rows.results.map((row) => row.payloadBase64).join(""));
  return new TextDecoder().decode(Uint8Array.from(raw, (value) => value.charCodeAt(0))).slice(0, 1_800_000);
}
function parse(raw: string): Extracted[] {
  let value: unknown; try { value = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, "")); } catch { throw new Error("industry source model response was not JSON"); }
  const items = value && typeof value === "object" && Array.isArray((value as Row).items) ? (value as Row).items as unknown[] : [];
  return items.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const item = candidate as Row; const industryKey = key(item.industryKey); const metricKey = key(item.metricKey); const metricLabel = text(item.metricLabel); const periodLabel = text(item.periodLabel); const numericValue = finite(item.numericValue); const unit = text(item.unit); const evidenceQuote = text(item.evidenceQuote); const evidenceLocator = text(item.evidenceLocator);
    if (!industryKey || !metricKey || !metricLabel || !periodLabel || numericValue === null || !unit || !evidenceQuote || !evidenceLocator || evidenceQuote.length > 900) return [];
    return [{ industryKey, metricKey, metricLabel, periodLabel, numericValue, unit, currency: nullable(item.currency), amountScale: nullable(item.amountScale), geographicScope: nullable(item.geographicScope), productScope: nullable(item.productScope), statisticalMethod: nullable(item.statisticalMethod), evidenceQuote, evidenceLocator }];
  }).slice(0, 30);
}
function key(value: unknown) { return text(value).toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 80); }
function text(value: unknown) { return typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : ""; }
function nullable(value: unknown) { const result = text(value); return result || null; }
function finite(value: unknown) { const result = Number(value); return Number.isFinite(result) ? result : null; }
function required(value: unknown, label: string) { const result = text(value); if (!result) throw new Error(`${label} is required`); return result; }
function render(template: string, values: Record<string, string>) { return Object.entries(values).reduce((result, [key, value]) => result.replaceAll(`{{${key}}}`, value), template); }
