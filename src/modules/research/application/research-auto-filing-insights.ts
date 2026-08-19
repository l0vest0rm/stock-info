import extractionConfig from "../../../../config/research-filing-extraction.json";
import { requestLocalDirectLlmText } from "../../../shared/local-direct-llm";
import { isSupportedCompanyCode, normalizeSecurityCode } from "../../../shared/codes";
import type { Bindings } from "../../../types";
import { insertSecurityRightsLink, upsertCompanySecurityRelationship } from "./research-identity";
import { insertResearchMarketStructureFact } from "./research-market-structure";
import { insertResearchRiskPressureScenario } from "./research-risk-review";
import { recordManagementGuidanceForecast } from "./forecast-actual-calibration";
import { saveForecastScenario } from "./forecast-ledger";
import { researchFinancialSpecialtyMetricConfigVersion, researchFinancialSpecialtyMetricDefinition } from "../domain/research-financial-specialty-metrics";

type TabId = "business" | "market" | "financial" | "industry" | "forecast" | "risk";
type TargetModule = "operating" | "market" | "governance" | "industry" | "forecast" | "risk";
type Registry = "cninfo" | "hkex" | "sec";
type Row = Record<string, unknown>;
type Filing = { registry: Registry; documentId: string; title: string; publishedAt: string; documentUrl: string; documentType: string | null; sourceLocator: string };
type DocumentKind = "annual" | "interim" | "event" | "other";
type ExtractedStructure = { subjectLabel: string | null; segmentLabel: string | null; geographyLabel: string | null; customerOrChannel: string | null; driverKey: string | null; exposureKey: string | null; causalDirection: string | null; periodKind: string | null; numericValue: number | null; currency: string | null; amountScale: string | null; relatedSecurityCode: string | null; securityRelationshipKind: string | null; relatedSharesPerSecurity: number | null; measurementBasis: string | null };
type Extracted = { tabId: TabId; factType: string; factKey: string; title: string; statement: string; reportedValue: string | null; valueType: string; unit: string | null; reportPeriod: string | null; evidenceQuote: string; evidenceLocator: string } & ExtractedStructure;

const config = extractionConfig as { version: string; model: "gpt-5.6-luna"; maxOutputTokens: number; maxItemsPerTab?: Partial<Record<TabId, number>>; systemPrompt: string; userTemplate: string; businessUnitEconomicsFactKeyContract?: string; businessFinancialTransmissionFactKeyContract?: string; businessDriverTreeFactKeyContract?: string; marketScenarioFactKeyContract?: string; industryTransmissionFactKeyContract?: string; industryDurabilityFactKeyContract?: string; factTypes: Record<TabId, string[]> };
const tabs = new Set<TabId>(["business", "market", "financial", "industry", "forecast", "risk"]);
const valueTypes = new Set(["qualitative", "amount", "count", "ratio", "range", "date", "unavailable"]);
const driverKeys = new Set(["volume", "price", "mix", "share", "capacity", "cost", "working_capital", "capital_allocation", "demand", "supply", "policy", "competition", "governance", "other"]);
const exposureKeys = new Set(["customer", "geography", "supplier", "technology", "regulation", "liquidity", "leverage", "execution", "other"]);
const causalDirections = new Set(["supports", "pressures", "uncertain"]);
const periodKinds = new Set(["historical", "current", "future_guidance", "event", "other"]);
const securityRelationshipKinds = new Set(["same_operating_company_different_security", "adr_underlying_security", "other_security_right"]);
const measurementBases = new Set(["period_end_outstanding", "weighted_average_eps"]);
const financialEntityTypes = new Set(["non_financial", "bank", "insurer", "broker", "financial_other"]);
const financialSpecialtyEntityTypes = new Set(["bank", "insurer", "broker"]);

export async function extractResearchAutoFilingInsights(env: Bindings, securityCode: string, documentId: string, now = Date.now()) {
  // Route guards are not a sufficient production boundary: this application
  // service can also be invoked by a future scheduler. Keep the LLM runtime
  // invariant next to the only remote-model call site.
  if (env.LLM_RUNTIME !== "local") throw new Error("automatic filing extraction is only available in local LLM runtime");
  const code = required(securityCode, "securityCode").toUpperCase();
  const filing = await env.DB.prepare(`select registry, document_id as documentId, title, published_at as publishedAt, document_url as documentUrl,
      document_type as documentType, source_locator as sourceLocator from research_statutory_disclosure_documents
      where security_code=? and document_id=? order by indexed_at desc limit 1`).bind(code, required(documentId, "documentId")).first<Row>();
  if (!filing) throw new Error("indexed statutory disclosure document not found");
  const source = filingRow(filing);
  // A statutory document ID is immutable in the official registries.  The
  // same document under the same prompt contract must be reused, not sent to
  // the remote model repeatedly by a periodic bootstrap task.
  const cached = await env.DB.prepare(`select count(*) as count, max(processed_at) as processedAt, max(model) as model
    from research_auto_filing_insights where security_code=? and statutory_document_id=? and prompt_version=?`)
    .bind(code, source.documentId, config.version).first<{ count: number; processedAt: number | null; model: string | null }>();
  if (Number(cached?.count) > 0) {
    const materialized = await materializeResearchAutoFilingFactInputs(env.DB, code, source.documentId, now);
    const version = await syncResearchAutoFilingDocumentVersion(env.DB, code, source, config.version, materialized.targetModules, now);
    const guidance = await syncResearchAutoManagementGuidance(env.DB, code, now);
    const scenarios = await syncResearchAutoForecastScenarios(env.DB, code, now);
    return { securityCode: code, documentId: source.documentId, sourceUrl: source.documentUrl, promptVersion: config.version,
      model: cached?.model ?? config.model, processedAt: cached?.processedAt ?? now, items: Number(cached?.count), materialized, version, guidance, scenarios, cached: true };
  }
  const content = await filingContent(env.DB, source.documentUrl);
  if (!content) throw new Error("indexed statutory disclosure has not been imported to the local knowledge content cache");
  const response = await requestLocalDirectLlmText(env, {
    model: config.model,
    maxTokens: config.maxOutputTokens,
    instructions: config.systemPrompt,
    input: [{ role: "user", content: [{ type: "input_text", text: `${render(config.userTemplate, { SECURITY_CODE: code, TITLE: source.title, PUBLISHED_AT: source.publishedAt, CONTENT: content })}\n\n单位经济结构化契约：${config.businessUnitEconomicsFactKeyContract || "未配置；不得输出不可配对的单位经济计算。"}\n\n商业传导结构化契约：${config.businessFinancialTransmissionFactKeyContract || "未配置；不得输出经营因果传导。"}\n\n商业驱动树结构化契约：${config.businessDriverTreeFactKeyContract || "未配置；不得输出驱动树节点。"}\n\n市场情景结构化契约：${config.marketScenarioFactKeyContract || "未配置；不得输出市场三情景计算。"}\n\n行业到公司传导契约：${config.industryTransmissionFactKeyContract || "未配置；不得输出行业到公司传导。"}\n\n行业竞争持续性契约：${config.industryDurabilityFactKeyContract || "未配置；不得输出市场边界或持续期。"}` }] }],
  });
  const items = parse(response.text);
  const statements = items.map((item) => env.DB.prepare(`insert into research_auto_filing_insights (
      insight_id, security_code, registry, statutory_document_id, document_url, tab_id, fact_type, fact_key, title, statement,
      reported_value, value_type, unit, report_period, evidence_quote, evidence_locator, subject_label, segment_label, geography_label,
      customer_or_channel, driver_key, exposure_key, causal_direction, period_kind, numeric_value, currency, amount_scale,
      related_security_code, security_relationship_kind, related_shares_per_security, measurement_basis,
      extraction_method, prompt_version, model, processed_at, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(security_code, statutory_document_id, tab_id, fact_key, prompt_version) do update set
      fact_type=excluded.fact_type, title=excluded.title, statement=excluded.statement, reported_value=excluded.reported_value,
      value_type=excluded.value_type, unit=excluded.unit, report_period=excluded.report_period,
      evidence_quote=excluded.evidence_quote, evidence_locator=excluded.evidence_locator, extraction_method=excluded.extraction_method,
      subject_label=excluded.subject_label, segment_label=excluded.segment_label, geography_label=excluded.geography_label,
      customer_or_channel=excluded.customer_or_channel, driver_key=excluded.driver_key, exposure_key=excluded.exposure_key,
      causal_direction=excluded.causal_direction, period_kind=excluded.period_kind, numeric_value=excluded.numeric_value,
      currency=excluded.currency, amount_scale=excluded.amount_scale, related_security_code=excluded.related_security_code,
      security_relationship_kind=excluded.security_relationship_kind, related_shares_per_security=excluded.related_shares_per_security,
      measurement_basis=excluded.measurement_basis, model=excluded.model, processed_at=excluded.processed_at`)
      .bind(`auto-filing-insight:${crypto.randomUUID()}`, code, source.registry, source.documentId, source.documentUrl, item.tabId, item.factType, item.factKey, item.title, item.statement,
        item.reportedValue, item.valueType, item.unit, item.reportPeriod, item.evidenceQuote, item.evidenceLocator,
        item.subjectLabel, item.segmentLabel, item.geographyLabel, item.customerOrChannel, item.driverKey, item.exposureKey,
        item.causalDirection, item.periodKind, item.numericValue, item.currency, item.amountScale,
        item.relatedSecurityCode, item.securityRelationshipKind, item.relatedSharesPerSecurity, item.measurementBasis,
        `远端模型按 ${config.version} 的受限 JSON 模板从本地已导入法定披露原文提取；未输出的字段不补全。`, config.version, response.model, now, now));
  // A successful rerun supersedes the prior prompt version for this exact
  // source document.  This keeps the page a source-document read model rather
  // than a growing pile of duplicate model renderings.
  await env.DB.batch([
    env.DB.prepare("delete from research_auto_filing_insights where security_code=? and statutory_document_id=?").bind(code, source.documentId),
    ...statements,
  ]);
  const materialized = await materializeResearchAutoFilingFactInputs(env.DB, code, source.documentId, now);
  const version = await syncResearchAutoFilingDocumentVersion(env.DB, code, source, config.version, materialized.targetModules, now);
  const guidance = await syncResearchAutoManagementGuidance(env.DB, code, now);
  const scenarios = await syncResearchAutoForecastScenarios(env.DB, code, now);
  return { securityCode: code, documentId: source.documentId, sourceUrl: source.documentUrl, promptVersion: config.version, model: response.model, processedAt: now, items: items.length, materialized, version, guidance, scenarios, cached: false };
}

export async function loadResearchAutoFilingInsights(db: D1Database, securityCode: string) {
  const rows = await db.prepare(`select registry, statutory_document_id as documentId, document_url as documentUrl, tab_id as tabId,
      coalesce(fact_type, case tab_id when 'business' then 'business_model' when 'market' then 'market_definition' when 'financial' then 'audit' when 'industry' then 'industry_kpi' when 'forecast' then 'management_guidance' when 'risk' then 'risk_exposure' end) as factType,
      fact_key as factKey, title, statement, reported_value as reportedValue,
      coalesce(value_type, case when reported_value is null or reported_value='' then 'unavailable' else 'qualitative' end) as valueType,
      unit, report_period as reportPeriod, evidence_quote as evidenceQuote, evidence_locator as evidenceLocator,
      subject_label as subjectLabel, segment_label as segmentLabel, geography_label as geographyLabel, customer_or_channel as customerOrChannel,
      driver_key as driverKey, exposure_key as exposureKey, causal_direction as causalDirection, period_kind as periodKind,
      numeric_value as numericValue, currency, amount_scale as amountScale, related_security_code as relatedSecurityCode,
      security_relationship_kind as securityRelationshipKind, related_shares_per_security as relatedSharesPerSecurity,
      measurement_basis as measurementBasis, extraction_method as extractionMethod,
      prompt_version as promptVersion, model, processed_at as processedAt
    from research_auto_filing_insights where security_code=? order by processed_at desc, tab_id, title limit 100`)
    .bind(required(securityCode, "securityCode").toUpperCase()).all<Row>();
  return { availability: rows.results.length ? "available" as const : "empty" as const, items: rows.results };
}

/**
 * Projects only already-saved, source-bound extraction rows into the company
 * research input layer.  No model is called here; no number is transformed,
 * inferred, or made eligible for valuation.  A provisional single-security
 * issuer domain is sufficient because the projection remains security-bound.
 */
export async function materializeResearchAutoFilingFactInputs(db: D1Database, securityCode: string, documentId: string, now = Date.now()) {
  const code = required(securityCode, "securityCode").toUpperCase();
  const statutoryDocumentId = required(documentId, "documentId");
  const company = await db.prepare("select company_id as companyId from research_listed_securities where security_code=?").bind(code).first<{ companyId: string | null }>();
  const rows = await db.prepare(`select insight_id as insightId, security_code as securityCode, statutory_document_id as documentId,
      document_url as documentUrl, tab_id as tabId, fact_type as factType, fact_key as factKey, title, statement,
      reported_value as reportedValue, coalesce(value_type, case when reported_value is null or reported_value='' then 'unavailable' else 'qualitative' end) as valueType,
      unit, report_period as reportPeriod, evidence_quote as evidenceQuote, evidence_locator as evidenceLocator,
      subject_label as subjectLabel, segment_label as segmentLabel, geography_label as geographyLabel, customer_or_channel as customerOrChannel,
      driver_key as driverKey, exposure_key as exposureKey, causal_direction as causalDirection, period_kind as periodKind,
      numeric_value as numericValue, currency, amount_scale as amountScale, related_security_code as relatedSecurityCode,
      security_relationship_kind as securityRelationshipKind, related_shares_per_security as relatedSharesPerSecurity,
      measurement_basis as measurementBasis, extraction_method as extractionMethod,
      prompt_version as promptVersion, model, processed_at as processedAt
    from research_auto_filing_insights where security_code=? and statutory_document_id=?`)
    .bind(code, statutoryDocumentId).all<Row>();
  const statements: D1PreparedStatement[] = [
    db.prepare("delete from research_auto_filing_fact_inputs where security_code=? and statutory_document_id=?").bind(code, statutoryDocumentId),
    ...rows.results.map((row) => {
      const tabId = text(row.tabId) as TabId;
      return db.prepare(`insert into research_auto_filing_fact_inputs (
          filing_fact_input_id, source_insight_id, operating_company_id, security_code, statutory_document_id, document_url,
          target_module, fact_type, fact_key, title, statement, reported_value, value_type, unit, report_period,
          evidence_quote, evidence_locator, subject_label, segment_label, geography_label, customer_or_channel, driver_key, exposure_key,
          causal_direction, period_kind, numeric_value, currency, amount_scale, related_security_code, security_relationship_kind,
          related_shares_per_security, measurement_basis, extraction_method, prompt_version, model, usage_policy, processed_at, materialized_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'source_bound_evidence_only_no_valuation', ?, ?)`)
        .bind(`auto-filing-fact-input:${text(row.insightId)}`, text(row.insightId), company?.companyId ?? null, code, statutoryDocumentId,
          text(row.documentUrl), targetModule(tabId), text(row.factType) || defaultFactType(tabId), text(row.factKey), text(row.title), text(row.statement),
          nullable(row.reportedValue), validValueType(row.valueType), nullable(row.unit), nullable(row.reportPeriod), text(row.evidenceQuote), text(row.evidenceLocator),
          nullable(row.subjectLabel), nullable(row.segmentLabel), nullable(row.geographyLabel), nullable(row.customerOrChannel), nullable(row.driverKey), nullable(row.exposureKey),
          nullable(row.causalDirection), nullable(row.periodKind), finiteNumber(row.numericValue), nullable(row.currency), nullable(row.amountScale),
          nullable(row.relatedSecurityCode), nullable(row.securityRelationshipKind), finitePositiveNumber(row.relatedSharesPerSecurity), nullable(row.measurementBasis),
          text(row.extractionMethod), text(row.promptVersion), text(row.model), number(row.processedAt, now), now);
    }),
  ];
  await db.batch(statements);
  return { availability: rows.results.length ? "available" as const : "empty" as const, items: rows.results.length, targetModules: [...new Set(rows.results.map((row) => targetModule(text(row.tabId) as TabId)))] };
}

/** Records official-document succession and emits automatic module rebuild signals.
 * Older filings remain readable historical evidence; only their current-input
 * role changes.  There is deliberately no human review state in this flow. */
export async function syncResearchAutoFilingDocumentVersion(db: D1Database, securityCode: string, source: Filing, promptVersion: string, targetModules: TargetModule[], now = Date.now()) {
  const code = required(securityCode, "securityCode").toUpperCase();
  const documentKind = classifyDocumentKind(source);
  const newest = await db.prepare(`select statutory_document_id as documentId, published_at as publishedAt
    from research_auto_filing_document_versions where security_code=? and document_kind=? order by published_at desc, updated_at desc limit 1`)
    .bind(code, documentKind).first<{ documentId: string; publishedAt: string }>();
  const isCurrent = !newest || source.documentId === newest.documentId || source.publishedAt >= newest.publishedAt;
  const report = await db.prepare(`select max(report_period) as reportPeriod from research_auto_filing_insights where security_code=? and statutory_document_id=?`)
    .bind(code, source.documentId).first<{ reportPeriod: string | null }>();
  const versionId = `auto-filing-document-version:${code}:${source.documentId}`;
  const statements: D1PreparedStatement[] = [];
  if (isCurrent) {
    statements.push(
      db.prepare(`update research_auto_filing_document_versions set is_current=0, superseded_by_document_id=?, updated_at=?
        where security_code=? and document_kind=? and statutory_document_id<>? and is_current=1`).bind(source.documentId, now, code, documentKind, source.documentId),
      db.prepare(`update research_auto_filing_fact_inputs set validity_status='historical', superseded_by_document_id=?
        where security_code=? and document_version_id in (
          select document_version_id from research_auto_filing_document_versions
          where security_code=? and document_kind=? and statutory_document_id<>?
        ) and validity_status='current'`).bind(source.documentId, code, code, documentKind, source.documentId),
    );
  }
  statements.push(
    db.prepare(`insert into research_auto_filing_document_versions (
      document_version_id, security_code, statutory_document_id, document_kind, title, published_at, document_url, report_period,
      prompt_version, extracted_at, is_current, superseded_by_document_id, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(security_code, statutory_document_id) do update set title=excluded.title, published_at=excluded.published_at,
      document_url=excluded.document_url, report_period=excluded.report_period, prompt_version=excluded.prompt_version,
      extracted_at=excluded.extracted_at, is_current=excluded.is_current, superseded_by_document_id=excluded.superseded_by_document_id, updated_at=excluded.updated_at`)
      .bind(versionId, code, source.documentId, documentKind, source.title, source.publishedAt, source.documentUrl, report?.reportPeriod ?? null,
        promptVersion, now, isCurrent ? 1 : 0, isCurrent ? null : newest?.documentId ?? null, now, now),
    db.prepare(`update research_auto_filing_fact_inputs set document_version_id=?, validity_status=?, superseded_by_document_id=?
      where security_code=? and statutory_document_id=?`).bind(versionId, isCurrent ? "current" : "historical", isCurrent ? null : newest?.documentId ?? null, code, source.documentId),
    ...targetModules.map((targetModule) => db.prepare(`insert or ignore into research_auto_filing_recompute_events (
        recompute_event_id, security_code, statutory_document_id, target_module, reason, status, created_at
      ) values (?, ?, ?, ?, ?, 'pending', ?)`)
      .bind(`auto-filing-recompute:${code}:${source.documentId}:${targetModule}`, code, source.documentId, targetModule,
        `新的或重跑的 ${documentKind} 法定披露已形成来源绑定输入，目标模块需从当前输入重建。`, now)),
  );
  await db.batch(statements);
  return { documentVersionId: versionId, documentKind, current: isCurrent, supersedesDocumentId: isCurrent ? newest?.documentId ?? null : null, recomputeEvents: targetModules.length };
}

export async function loadResearchAutoFilingDocumentVersions(db: D1Database, securityCode: string) {
  const code = required(securityCode, "securityCode").toUpperCase();
  try {
    const [versions, events] = await Promise.all([
      db.prepare(`select document_version_id as documentVersionId, statutory_document_id as documentId, document_kind as documentKind,
        title, published_at as publishedAt, document_url as documentUrl, report_period as reportPeriod, prompt_version as promptVersion,
        extracted_at as extractedAt, is_current as isCurrent, superseded_by_document_id as supersededByDocumentId, updated_at as updatedAt
        from research_auto_filing_document_versions where security_code=? order by published_at desc, updated_at desc limit 80`).bind(code).all<Row>(),
      db.prepare(`select recompute_event_id as recomputeEventId, statutory_document_id as documentId, target_module as targetModule,
        reason, status, created_at as createdAt from research_auto_filing_recompute_events where security_code=? order by created_at desc limit 120`).bind(code).all<Row>(),
    ]);
    return { availability: versions.results.length ? "available" as const : "empty" as const, versions: versions.results, recomputeEvents: events.results };
  } catch (error) {
    if (String(error).includes("no such table: research_auto_filing_document_versions")) return { availability: "unavailable" as const, versions: [] as Row[], recomputeEvents: [] as Row[] };
    throw error;
  }
}

/** Consumes only automatic dependency events created by a new statutory filing.
 * It never changes a source fact, accepts a model conclusion, or waits for a
 * person.  Each rebuilt module is pinned to the exact current fact set that
 * was available at the time of the rebuild. */
export async function rebuildResearchAutoFilingReadModels(db: D1Database, securityCode: string, now = Date.now()) {
  const code = required(securityCode, "securityCode").toUpperCase();
  try {
    const events = await db.prepare(`select recompute_event_id as recomputeEventId, target_module as targetModule, reason
      from research_auto_filing_recompute_events where security_code=? and status='pending' order by created_at, recompute_event_id`)
      .bind(code).all<{ recomputeEventId: string; targetModule: TargetModule; reason: string }>();
    const grouped = new Map<TargetModule, { eventIds: string[]; reasons: string[] }>();
    for (const event of events.results) {
      const known = grouped.get(event.targetModule) ?? { eventIds: [], reasons: [] };
      known.eventIds.push(event.recomputeEventId); known.reasons.push(event.reason); grouped.set(event.targetModule, known);
    }
    const statements: D1PreparedStatement[] = [];
    const rebuilt: Array<{ targetModule: TargetModule; sourceFactCount: number; sourceDocumentCount: number; sourceSignature: string }> = [];
    for (const [targetModule, group] of grouped) {
      const facts = await db.prepare(`select statutory_document_id as documentId, filing_fact_input_id as inputId, processed_at as processedAt
        from research_auto_filing_fact_inputs where security_code=? and target_module=? and validity_status='current'
        order by statutory_document_id, filing_fact_input_id`).bind(code, targetModule).all<{ documentId: string; inputId: string; processedAt: number | null }>();
      const ids = facts.results.map((item) => `${item.documentId}:${item.inputId}`).join("|");
      const signature = await sha256Hex(`${code}|${targetModule}|${ids}`);
      const sourceDocumentCount = new Set(facts.results.map((item) => item.documentId)).size;
      const latestProcessedAt = facts.results.reduce<number | null>((latest, item) => item.processedAt && (!latest || item.processedAt > latest) ? item.processedAt : latest, null);
      statements.push(
        db.prepare(`insert or ignore into research_auto_filing_module_rebuilds (
          rebuild_id, security_code, target_module, source_signature, source_document_count, source_fact_count, latest_processed_at, change_reason, rebuilt_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(`auto-filing-rebuild:${code}:${targetModule}:${signature}`, code, targetModule, signature, sourceDocumentCount, facts.results.length, latestProcessedAt, group.reasons.join("；").slice(0, 2000), now),
        ...group.eventIds.map((eventId) => db.prepare("update research_auto_filing_recompute_events set status='consumed' where recompute_event_id=? and status='pending'").bind(eventId)),
      );
      rebuilt.push({ targetModule, sourceFactCount: facts.results.length, sourceDocumentCount, sourceSignature: signature });
      if (targetModule === "risk") await saveResearchAutoRiskSnapshot(db, code, signature, now);
    }
    if (statements.length) await db.batch(statements);
    // A filing extraction is evidence, not by itself a valuation input.  The
    // small exception below is deliberately narrow: an explicitly labelled
    // period-end share count (or an explicit ADS ratio) has all of the
    // security-level fields required by the market-structure contract.  It is
    // projected as its own append-only fact rather than being copied into a
    // model or inferred from EPS, market value, or another security.
    const marketStructureMaterialization = await materializeResearchAutoMarketStructureFacts(db, code, now);
    const riskPressureMaterialization = await materializeResearchAutoRiskPressureScenarios(db, code, now);
    const financialSpecialtyMaterialization = await syncResearchAutoFinancialSpecialtyInputs(db, code, now);
    // The reconciliation consumes only the facts just persisted above. It is
    // automatic and idempotent; if the related security has not yet reached
    // the same point in its own official-document chain, it returns a block
    // rather than creating a speculative relationship.
    const securityReconciliation = await reconcileResearchAutoSecurityStructure(db, code, now);
    return { availability: "available" as const, securityCode: code, rebuilt, consumedEvents: events.results.length, marketStructureMaterialization, riskPressureMaterialization, financialSpecialtyMaterialization, securityReconciliation };
  } catch (error) {
    if (String(error).includes("no such table: research_auto_filing_module_rebuilds")) return { availability: "unavailable" as const, securityCode: code, rebuilt: [], consumedEvents: 0 };
    throw error;
  }
}

/**
 * Projects only explicit financial-entity and specialty-metric extraction
 * contracts into the page read model.  This stays separate from the retired
 * human evidence/review ledger: a statutory source input is enough only when
 * its entity, value, definition, scope and units all pass deterministic
 * gates.  Otherwise the page receives a precise automatic block reason.
 */
export async function syncResearchAutoFinancialSpecialtyInputs(db: D1Database, securityCode: string, now = Date.now()) {
  const code = required(securityCode, "securityCode").toUpperCase();
  try {
    const rows = await db.prepare(`select filing_fact_input_id as inputId, operating_company_id as operatingCompanyId,
        statutory_document_id as documentId, document_url as documentUrl, fact_type as factType, fact_key as factKey,
        title, statement, reported_value as reportedValue, value_type as valueType, unit, report_period as reportPeriod,
        evidence_quote as evidenceQuote, evidence_locator as evidenceLocator, subject_label as subjectLabel,
        segment_label as segmentLabel, numeric_value as numericValue, currency, amount_scale as amountScale,
        extraction_method as extractionMethod, prompt_version as promptVersion, model, processed_at as processedAt
      from research_auto_filing_fact_inputs where security_code=? and target_module='governance' and validity_status='current'
        and fact_type in ('financial_entity_profile', 'financial_specialty_metric')
      order by processed_at desc, filing_fact_input_id`).bind(code).all<Row>();
    const profiles = new Map<string, { profileId: string; entityType: string; asOf: string; documentId: string; companyId: string }>();
    const profileStatements: D1PreparedStatement[] = [];
    const createdProfiles: Array<{ inputId: string; entityType: string; profileId: string }> = [];
    const blocked: Array<{ inputId: string; factKey: string; reason: string }> = [];
    for (const row of rows.results.filter((item) => text(item.factType) === "financial_entity_profile")) {
      const inputId = text(row.inputId); const parsed = financialEntityProfileFactKey(row.factKey); const asOf = text(row.reportPeriod);
      const companyId = text(row.operatingCompanyId); const sourceUrl = text(row.documentUrl);
      const reason = !inputId ? "source_input_id_missing"
        : !parsed ? "financial_entity_profile_fact_key_invalid"
          : !companyId ? "operating_company_mapping_missing"
            : !dateOnly(asOf) ? "financial_entity_profile_report_period_must_be_yyyy_mm_dd"
              : !/^https:\/\//i.test(sourceUrl) ? "official_https_source_url_missing"
                : !text(row.statement) || !text(row.evidenceQuote) || !text(row.evidenceLocator) ? "source_bound_profile_evidence_missing"
                  : null;
      if (reason) { blocked.push({ inputId, factKey: text(row.factKey), reason }); continue; }
      const profileId = `auto-filing-financial-profile:${inputId}`;
      const sourceNote = `来源绑定自动实体识别：${text(row.evidenceQuote)}；定位：${text(row.evidenceLocator)}；加工：${text(row.extractionMethod)}`;
      profileStatements.push(db.prepare(`insert into research_auto_filing_financial_profiles (
          auto_financial_profile_id, source_filing_fact_input_id, security_code, operating_company_id, entity_type, as_of,
          source_url, source_title, source_note, evidence_quote, evidence_locator, extraction_method, prompt_version, model,
          processed_at, materialized_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(source_filing_fact_input_id) do update set entity_type=excluded.entity_type, as_of=excluded.as_of,
          source_url=excluded.source_url, source_title=excluded.source_title, source_note=excluded.source_note,
          evidence_quote=excluded.evidence_quote, evidence_locator=excluded.evidence_locator, extraction_method=excluded.extraction_method,
          prompt_version=excluded.prompt_version, model=excluded.model, processed_at=excluded.processed_at, materialized_at=excluded.materialized_at`)
        .bind(profileId, inputId, code, companyId, parsed, asOf, sourceUrl, text(row.title) || "发行人法定披露", sourceNote,
          text(row.evidenceQuote), text(row.evidenceLocator), text(row.extractionMethod), text(row.promptVersion), text(row.model), number(row.processedAt, now), now));
      profiles.set(`${text(row.documentId)}|${parsed!}|${asOf}`, { profileId, entityType: parsed!, asOf, documentId: text(row.documentId), companyId });
      createdProfiles.push({ inputId, entityType: parsed!, profileId });
    }
    if (profileStatements.length) await db.batch(profileStatements);
    const specialtyStatements: D1PreparedStatement[] = [];
    const createdFacts: Array<{ inputId: string; metricKey: string; factId: string }> = [];
    for (const row of rows.results.filter((item) => text(item.factType) === "financial_specialty_metric")) {
      const inputId = text(row.inputId); const parsed = financialSpecialtyFactKey(row.factKey); const asOf = text(row.reportPeriod);
      const companyId = text(row.operatingCompanyId); const sourceUrl = text(row.documentUrl); const definition = parsed ? researchFinancialSpecialtyMetricDefinition(parsed.metricKey) : null;
      const profile = parsed ? profiles.get(`${text(row.documentId)}|${parsed.entityType}|${asOf}`) : undefined;
      const value = finiteNumber(row.numericValue); const unit = text(row.unit); const currency = nullable(row.currency); const amountScale = nullable(row.amountScale);
      const reason = !inputId ? "source_input_id_missing"
        : !parsed ? "financial_specialty_fact_key_invalid"
          : !definition ? "financial_specialty_metric_not_configured"
            : definition.entityType !== parsed.entityType ? "financial_specialty_metric_entity_mismatch"
              : !profile ? "matching_source_bound_financial_entity_profile_missing"
                : companyId !== profile.companyId ? "financial_specialty_profile_company_scope_mismatch"
                  : !dateOnly(asOf) ? "financial_specialty_report_period_must_be_yyyy_mm_dd"
                    : value === null ? "explicit_numeric_value_missing"
                      : unit !== definition.normalizedUnit ? "financial_specialty_unit_mismatch"
                        : definition.requiresCurrency !== Boolean(currency) ? "financial_specialty_currency_contract_invalid"
                          : definition.requiresAmountScale !== Boolean(amountScale) ? "financial_specialty_amount_scale_contract_invalid"
                            : !text(row.subjectLabel) ? "financial_specialty_definition_missing"
                              : !text(row.segmentLabel) ? "financial_specialty_comparability_scope_missing"
                                : !text(row.reportedValue) || !text(row.statement) || !text(row.evidenceQuote) || !text(row.evidenceLocator) ? "source_bound_financial_specialty_evidence_missing"
                                  : !/^https:\/\//i.test(sourceUrl) ? "official_https_source_url_missing"
                                    : null;
      if (reason) { blocked.push({ inputId, factKey: text(row.factKey), reason }); continue; }
      const factId = `auto-filing-financial-specialty:${inputId}`;
      specialtyStatements.push(db.prepare(`insert into research_auto_filing_financial_specialty_facts (
          auto_financial_specialty_fact_id, auto_financial_profile_id, source_filing_fact_input_id, security_code, operating_company_id,
          entity_type, metric_key, reported_label, reported_value, value_number, unit, currency, amount_scale, as_of, period_label,
          definition_note, comparability_note, statement, source_url, source_title, evidence_quote, evidence_locator,
          extraction_method, prompt_version, model, processed_at, materialized_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(source_filing_fact_input_id) do update set auto_financial_profile_id=excluded.auto_financial_profile_id,
          entity_type=excluded.entity_type, metric_key=excluded.metric_key, reported_label=excluded.reported_label,
          reported_value=excluded.reported_value, value_number=excluded.value_number, unit=excluded.unit, currency=excluded.currency,
          amount_scale=excluded.amount_scale, as_of=excluded.as_of, period_label=excluded.period_label,
          definition_note=excluded.definition_note, comparability_note=excluded.comparability_note, statement=excluded.statement,
          source_url=excluded.source_url, source_title=excluded.source_title, evidence_quote=excluded.evidence_quote,
          evidence_locator=excluded.evidence_locator, extraction_method=excluded.extraction_method, prompt_version=excluded.prompt_version,
          model=excluded.model, processed_at=excluded.processed_at, materialized_at=excluded.materialized_at`)
        .bind(factId, profile!.profileId, inputId, code, companyId, parsed!.entityType, parsed!.metricKey,
          text(row.title) || parsed!.metricKey, text(row.reportedValue), value, unit, currency, amountScale, asOf, asOf,
          text(row.subjectLabel), text(row.segmentLabel), text(row.statement), sourceUrl, text(row.title) || "发行人法定披露",
          text(row.evidenceQuote), text(row.evidenceLocator), text(row.extractionMethod), text(row.promptVersion), text(row.model), number(row.processedAt, now), now));
      createdFacts.push({ inputId, metricKey: parsed!.metricKey, factId });
    }
    if (specialtyStatements.length) await db.batch(specialtyStatements);
    return { availability: rows.results.length ? "available" as const : "empty" as const, createdProfiles, createdFacts, blocked,
      rule: `仅使用 financial_entity_profile 与 financial_specialty_metric 的来源绑定法定披露输入；指标字典版本 ${researchFinancialSpecialtyMetricConfigVersion()}，不走人工证据或审核链。` };
  } catch (error) {
    if (/no such table|no such column/i.test(String(error))) return { availability: "unavailable" as const, createdProfiles: [], createdFacts: [], blocked: [], reason: "storage_not_initialized" };
    throw error;
  }
}

/**
 * Materializes only issuer-disclosed securities facts that meet the exact
 * per-share gate.  This does not turn a weighted-average EPS denominator into
 * an outstanding share count, and it deliberately refuses a free-text number
 * without its date, unit, official URL and measurement basis.
 *
 * The market-structure table is append-only.  Replaying a rebuild therefore
 * first looks up the same source identity and leaves the existing fact intact.
 */
export async function materializeResearchAutoMarketStructureFacts(db: D1Database, securityCode: string, now = Date.now()) {
  const code = required(securityCode, "securityCode").toUpperCase();
  try {
    const rows = await db.prepare(`select filing_fact_input_id as inputId, statutory_document_id as documentId,
      document_url as documentUrl, fact_type as factType, fact_key as factKey, title, statement, unit,
      report_period as reportPeriod, numeric_value as numericValue, related_shares_per_security as relatedSharesPerSecurity,
      measurement_basis as measurementBasis, evidence_quote as evidenceQuote, evidence_locator as evidenceLocator,
      extraction_method as extractionMethod
      from research_auto_filing_fact_inputs where security_code=? and target_module='governance' and validity_status='current'
        and ((fact_type='share_count' and fact_key in ('basic_shares', 'diluted_shares')) or fact_type='adr_ratio')
      order by processed_at desc, filing_fact_input_id`).bind(code).all<Row>();
    const created: Array<{ inputId: string; factKey: string; marketStructureFactId: string }> = [];
    const blocked: Array<{ inputId: string; factKey: string; reason: string }> = [];
    for (const row of rows.results) {
      const inputId = text(row.inputId);
      const factType = text(row.factType);
      const sourceUrl = text(row.documentUrl);
      const asOf = text(row.reportPeriod);
      const factKey = factType === "adr_ratio" ? "adr_ratio" : text(row.factKey);
      const value = factType === "adr_ratio" ? finitePositiveNumber(row.relatedSharesPerSecurity) : finitePositiveNumber(row.numericValue);
      const unit = factType === "adr_ratio" ? "underlying securities per ADR/ADS" : text(row.unit);
      const measurementBasis = factType === "adr_ratio" ? null : enumOrNull(row.measurementBasis, measurementBases);
      const reason = !inputId ? "source_input_id_missing"
        : !/^https:\/\//i.test(sourceUrl) ? "official_https_source_url_missing"
          : !/^\d{4}-\d{2}-\d{2}$/.test(asOf) ? "report_period_must_be_yyyy_mm_dd"
            : value === null ? "explicit_positive_numeric_value_missing"
              : !unit ? "source_unit_missing"
                : factType !== "adr_ratio" && measurementBasis !== "period_end_outstanding" ? "period_end_outstanding_basis_required"
                  : null;
      if (reason) { blocked.push({ inputId, factKey, reason }); continue; }
      const existing = await db.prepare(`select market_structure_fact_id as marketStructureFactId from research_market_structure_facts
        where security_code=? and fact_key=? and as_of=? and source_url=? and coalesce(measurement_basis,'')=coalesce(?, '') limit 1`)
        .bind(code, factKey, asOf, sourceUrl, measurementBasis).first<{ marketStructureFactId: string }>();
      if (existing?.marketStructureFactId) { created.push({ inputId, factKey, marketStructureFactId: existing.marketStructureFactId }); continue; }
      const marketStructureFactId = `auto-filing-market-structure:${code}:${inputId}`;
      await insertResearchMarketStructureFact(db, {
        marketStructureFactId, securityCode: code, factKey, factStatus: "verified", valueKind: "number", valueNumber: value,
        valueText: null, unit, measurementBasis: measurementBasis as "period_end_outstanding" | null,
        asOf, frequency: "event", epistemicType: "observed_fact", sourceAuthority: "issuer_disclosure", sourceUrl,
        sourceTitle: text(row.title) || "发行人法定披露", sourceNote: `来源绑定自动物化：${text(row.evidenceQuote)}；定位：${text(row.evidenceLocator)}；加工：${text(row.extractionMethod)}`,
        effectiveFrom: asOf, effectiveTo: null, createdAt: now,
      });
      created.push({ inputId, factKey, marketStructureFactId });
    }
    return { availability: rows.results.length ? "available" as const : "empty" as const, created, blocked,
      rule: "仅物化具有官方 HTTPS 原文、YYYY-MM-DD 报告期、明确正数与单位的 basic_shares/diluted_shares（且必须为期末在外股数）或 ADR/ADS 比例；EPS 加权平均分母、稀释描述和自由文本不会解锁每股估值。" };
  } catch (error) {
    if (/no such table|no such column/i.test(String(error))) return { availability: "unavailable" as const, created: [], blocked: [], reason: "storage_not_initialized" };
    throw error;
  }
}

export async function loadResearchAutoFilingModuleRebuilds(db: D1Database, securityCode: string) {
  const code = required(securityCode, "securityCode").toUpperCase();
  try {
    const rows = await db.prepare(`select rebuild_id as rebuildId, target_module as targetModule, source_signature as sourceSignature,
      source_document_count as sourceDocumentCount, source_fact_count as sourceFactCount, latest_processed_at as latestProcessedAt,
      change_reason as changeReason, rebuilt_at as rebuiltAt from research_auto_filing_module_rebuilds
      where security_code=? order by rebuilt_at desc limit 80`).bind(code).all<Row>();
    return { availability: rows.results.length ? "available" as const : "empty" as const, items: rows.results };
  } catch (error) {
    if (String(error).includes("no such table: research_auto_filing_module_rebuilds")) return { availability: "unavailable" as const, items: [] as Row[] };
    throw error;
  }
}

export async function loadResearchAutoFilingFactInputs(db: D1Database, securityCode: string) {
  const code = required(securityCode, "securityCode").toUpperCase();
  try {
    const rows = await db.prepare(`select filing_fact_input_id as filingFactInputId, operating_company_id as operatingCompanyId,
        security_code as securityCode, statutory_document_id as documentId, document_url as documentUrl, target_module as targetModule,
        fact_type as factType, fact_key as factKey, title, statement, reported_value as reportedValue, value_type as valueType,
        unit, report_period as reportPeriod, evidence_quote as evidenceQuote, evidence_locator as evidenceLocator,
        subject_label as subjectLabel, segment_label as segmentLabel, geography_label as geographyLabel, customer_or_channel as customerOrChannel,
        driver_key as driverKey, exposure_key as exposureKey, causal_direction as causalDirection, period_kind as periodKind,
        numeric_value as numericValue, currency, amount_scale as amountScale, related_security_code as relatedSecurityCode,
        security_relationship_kind as securityRelationshipKind, related_shares_per_security as relatedSharesPerSecurity,
        measurement_basis as measurementBasis, document_version_id as documentVersionId,
        validity_status as validityStatus, superseded_by_document_id as supersededByDocumentId,
        extraction_method as extractionMethod, prompt_version as promptVersion, model, usage_policy as usagePolicy,
        processed_at as processedAt, materialized_at as materializedAt
      from research_auto_filing_fact_inputs where security_code=? order by processed_at desc, target_module, title limit 150`).bind(code).all<Row>();
    return { availability: rows.results.length ? "available" as const : "empty" as const, reason: rows.results.length ? null : "no_materialized_filing_facts", items: rows.results };
  } catch (error) {
    if (String(error).includes("no such table: research_auto_filing_fact_inputs")) return { availability: "unavailable" as const, reason: "storage_not_initialized", items: [] as Row[] };
    throw error;
  }
}

/** Read-only operating-driver tree.  It does not invent volume/price splits:
 * a branch exists only when the current statutory input explicitly supplied
 * an operating subject and/or configured driver facet. */
export async function loadResearchAutoBusinessDriverTree(db: D1Database, securityCode: string) {
  const code = required(securityCode, "securityCode").toUpperCase();
  try {
    const rows = await db.prepare(`select filing_fact_input_id as inputId, statutory_document_id as documentId, document_url as documentUrl,
      fact_type as factType, fact_key as factKey, title, statement, reported_value as reportedValue, numeric_value as numericValue,
      unit, currency, amount_scale as amountScale, report_period as reportPeriod,
        subject_label as subjectLabel, segment_label as segmentLabel, geography_label as geographyLabel, customer_or_channel as customerOrChannel,
        driver_key as driverKey, period_kind as periodKind, evidence_quote as evidenceQuote, evidence_locator as evidenceLocator,
        extraction_method as extractionMethod, processed_at as processedAt, validity_status as validityStatus
      from research_auto_filing_fact_inputs where security_code=? and target_module='operating' and validity_status='current'
      order by processed_at desc, title limit 80`).bind(code).all<Row>();
    const items = rows.results;
    const driverTree = sourceBoundBusinessDriverTree(items);
    const unitEconomics = sourceBoundUnitEconomics(items);
    const financialTransmission = sourceBoundBusinessFinancialTransmission(items);
    return {
      availability: items.length ? "available" as const : "empty" as const,
      branches: driverTree.branches, driverTree, unitEconomics, financialTransmission,
      transmission: {
        status: financialTransmission.status === "available" ? "partial" as const : "blocked" as const,
        rule: financialTransmission.rule,
        missing: driverTree.missing,
      },
    };
  } catch (error) {
    if (String(error).includes("no such table: research_auto_filing_fact_inputs")) return { availability: "unavailable" as const, branches: [], transmission: { status: "blocked" as const, rule: "经营输入账本尚未初始化。", missing: ["storage"] } };
    throw error;
  }
}

function sourceBoundBusinessDriverTree(items: Row[]) {
  const specifications = [
    { kind: "segment", label: "产品/分部", match: (item: Row) => text(item.factType) === "segment" || Boolean(text(item.segmentLabel)) },
    { kind: "geography", label: "地区", match: (item: Row) => text(item.factType) === "geography" || Boolean(text(item.geographyLabel)) },
    { kind: "customer", label: "客户/渠道", match: (item: Row) => text(item.factType) === "customer" || Boolean(text(item.customerOrChannel)) },
    { kind: "contract", label: "合同/收入确认", match: (item: Row) => text(item.factType) === "contract" },
    { kind: "pricing", label: "价格", match: (item: Row) => text(item.driverKey) === "price" },
    { kind: "volume", label: "销量/出货", match: (item: Row) => text(item.driverKey) === "volume" },
    { kind: "capacity", label: "产能", match: (item: Row) => text(item.driverKey) === "capacity" },
    { kind: "cost", label: "成本", match: (item: Row) => text(item.driverKey) === "cost" },
    { kind: "constraint", label: "增长约束", match: (item: Row) => text(item.factType) === "constraint" },
  ];
  const blocked: Array<{ inputId: string; kind: string; reason: string }> = [];
  const branches = specifications.map((specification) => {
    const candidates = items.filter(specification.match);
    const nodes = candidates.map((item) => {
      const missing = [
        !text(item.subjectLabel) ? "subject_label" : null,
        !dateOnly(text(item.reportPeriod)) ? "report_period" : null,
        !text(item.documentUrl) ? "document_url" : null,
        !text(item.evidenceQuote) ? "evidence_quote" : null,
        !text(item.evidenceLocator) ? "evidence_locator" : null,
      ].filter((value): value is string => Boolean(value));
      const status = missing.length ? "blocked" as const : "available" as const;
      if (status === "blocked") blocked.push({ inputId: text(item.inputId), kind: specification.kind, reason: missing.join("_") });
      return { ...item, kind: specification.kind, status, missing };
    });
    const available = nodes.filter((node) => node.status === "available");
    return { kind: specification.kind, label: specification.label, items: nodes, availability: available.length ? "available" as const : candidates.length ? "blocked" as const : "missing" as const };
  });
  const missing = branches.filter((branch) => branch.availability !== "available").map((branch) => branch.kind);
  return {
    branches,
    nodes: branches.flatMap((branch) => branch.items),
    missing,
    blocked,
    rule: "驱动树节点必须来自当前证券的 current 法定披露输入，并具备原文对象、报告期、原始文件、连续摘录和定位。产品/分部、地区、客户/渠道、合同、价格、销量、产能、成本和约束缺失时逐项阻断，不用新闻、行业常识或其他证券补齐。",
  };
}

function sourceBoundBusinessFinancialTransmission(items: Row[]) {
  const stages = new Set(["revenue", "gross_profit", "net_profit", "operating_cash_flow"]);
  const drivers = new Set(["volume", "price", "mix", "capacity", "cost", "working_capital"]);
  const blocked: Array<{ inputId: string; reason: string }> = [];
  const candidates = items.filter((item) => text(item.factKey).startsWith("business_transmission__"));
  const entries = candidates.flatMap((item) => {
    const match = /^business_transmission__([a-z0-9_-]+)__(volume|price|mix|capacity|cost|working_capital)__(revenue|gross_profit|net_profit|operating_cash_flow)$/i.exec(text(item.factKey));
    const inputId = text(item.inputId); const subject = text(item.subjectLabel); const period = text(item.reportPeriod); const driver = text(item.driverKey);
    if (!match || !subject || !dateOnly(period) || !drivers.has(driver) || driver !== match[2] || !stages.has(match[3])) {
      blocked.push({ inputId, reason: !match ? "business_transmission_fact_key_invalid" : !subject ? "business_transmission_subject_missing" : !dateOnly(period) ? "business_transmission_report_period_invalid" : "business_transmission_driver_key_invalid" });
      return [];
    }
    return [{ ...item, stage: match[3], driver, subject, status: "available" as const }];
  });
  return {
    status: entries.length ? "available" as const : "blocked" as const,
    entries,
    blocked,
    rule: "只有原文以 business_transmission 受控事实明确给出“经营因素 → 收入、毛利、净利或经营现金流”时才解释因果。没有该证据的财务环节只展示来源绑定财务桥和公式，不把普通经营事实升级为因果。",
  };
}

function sourceBoundUnitEconomics(items: Row[]) {
  const candidates = items.filter((item) => text(item.factType) === "unit_economics");
  const grouped = new Map<string, { label: string; documentId: string; reportPeriod: string; numerator?: Row; denominator?: Row }>();
  const blocked: Array<{ inputId: string; reason: string }> = [];
  for (const item of candidates) {
    const parsed = /^unit_economics__([a-z0-9_-]+)__(numerator|denominator)$/i.exec(text(item.factKey));
    const inputId = text(item.inputId); const subject = text(item.subjectLabel); const period = text(item.reportPeriod); const documentId = text(item.documentId);
    if (!parsed || !subject || !dateOnly(period) || finiteNumber(item.numericValue) === null || !text(item.unit)) {
      blocked.push({ inputId, reason: !parsed ? "unit_economics_fact_key_invalid" : !subject ? "unit_economics_subject_missing" : !dateOnly(period) ? "unit_economics_report_period_invalid" : finiteNumber(item.numericValue) === null ? "unit_economics_numeric_value_missing" : "unit_economics_unit_missing" });
      continue;
    }
    const key = `${documentId}|${period}|${subject}|${parsed[1]}`;
    const group = grouped.get(key) ?? { label: subject, documentId, reportPeriod: period };
    if (parsed[2] === "numerator") group.numerator = item; else group.denominator = item;
    grouped.set(key, group);
  }
  const itemsOut = [...grouped.values()].map((group) => {
    const numeratorValue = finiteNumber(group.numerator?.numericValue); const denominatorValue = finiteNumber(group.denominator?.numericValue);
    const missing = [!group.numerator ? "numerator" : null, !group.denominator ? "denominator" : null, denominatorValue === 0 ? "denominator_zero" : null].filter((item): item is string => Boolean(item));
    return { ...group, status: missing.length || numeratorValue === null || denominatorValue === null ? "blocked" as const : "available" as const,
      value: !missing.length && numeratorValue !== null && denominatorValue !== null ? finiteNumber(numeratorValue / denominatorValue) : null, missing };
  });
  return { availability: candidates.length ? "available" as const : "empty" as const, items: itemsOut, blocked,
    rule: "仅计算同一法定文件、同一报告期、同一原文对象的 unit_economics 分子 ÷ 分母；两者均为原文直接数值且分母非零。不会从收入、销量、毛利率或行业均值补造。" };
}

/** Computes only the eligibility of a market-space calculation.  It never
 * fabricates TAM, SAM, SOM, market share, or a profit pool from prose. */
export async function loadResearchAutoMarketSpaceInputs(db: D1Database, securityCode: string) {
  const code = required(securityCode, "securityCode").toUpperCase();
  try {
    const rows = await db.prepare(`select filing_fact_input_id as inputId, document_url as documentUrl, statutory_document_id as documentId,
      fact_type as factType, fact_key as factKey, title, statement, reported_value as reportedValue, numeric_value as numericValue,
      unit, currency, amount_scale as amountScale, report_period as reportPeriod, subject_label as subjectLabel, segment_label as segmentLabel, geography_label as geographyLabel,
      evidence_quote as evidenceQuote, evidence_locator as evidenceLocator, extraction_method as extractionMethod, processed_at as processedAt
      from research_auto_filing_fact_inputs where security_code=? and target_module='market' and validity_status='current'
      order by processed_at desc, title limit 100`).bind(code).all<Row>();
    // A market-space bridge may use an external official/association industry
    // total, but never a report headline or an unsourced industry estimate.
    // The company filing remains mandatory for SAM and obtainable-share input.
    let industryItems: Array<Row & { sourceKind: string }> = [];
    try {
      const industry = await db.prepare(`select industry_series_observation_id as inputId, source_doc_id as documentId,
        source_url as documentUrl, industry_key as subjectLabel, metric_key as factKey, metric_label as title,
        metric_label as statement, cast(numeric_value as text) as reportedValue, numeric_value as numericValue,
        unit, currency, amount_scale as amountScale, period_label as reportPeriod, geographic_scope as geographyLabel,
        product_scope as segmentLabel, evidence_quote as evidenceQuote, evidence_locator as evidenceLocator,
        extraction_method as extractionMethod, processed_at as processedAt, source_authority as sourceAuthority
        from research_industry_source_series_observations where security_code=?
        order by period_label desc, processed_at desc limit 100`).bind(code).all<Row>();
      industryItems = industry.results.map((item): Row & { sourceKind: string } => ({ ...item, factType: marketFactTypeFromIndustryMetric(text(item.factKey)), sourceKind: "official_industry_series" }));
    } catch (error) {
      if (!String(error).includes("no such table: research_industry_source_series_observations")) throw error;
    }
    const items: Array<Row & { sourceKind: string }> = [
      ...rows.results.map((item): Row & { sourceKind: string } => ({ ...item, sourceKind: "issuer_filing" })),
      ...industryItems,
    ];
    const types = new Set(items.map((item) => text(item.factType)));
    const required = [
      { key: "tam_input", label: "行业总量 / TAM 原始输入", present: types.has("tam_input") },
      { key: "sam_boundary", label: "产品、地区或客户可服务边界 / SAM", present: types.has("sam_boundary") },
      { key: "share", label: "公司份额或可得份额桥 / SOM", present: types.has("share") || types.has("order") || types.has("capacity") },
      { key: "profit_pool", label: "行业收入与利润率 / 利润池", present: types.has("profit_pool") },
    ];
    const missing = required.filter((item) => !item.present).map((item) => item.key);
    const marketCalculation = sourceBoundMarketCalculation(items);
    const scenario = sourceBoundMarketScenarios(items);
    return {
      availability: items.length ? "available" as const : "empty" as const,
      items,
      requirements: required,
      calculation: {
        status: !missing.length && marketCalculation.status === "eligible" ? "eligible" as const : "blocked" as const,
        missing: [...missing, ...marketCalculation.missing],
        basisCount: marketCalculation.basisCount,
        rule: "SOM = SAM × 可得份额；可得利润池 = SOM × 已披露利润率。TAM 可来自已导入的政府/官方协会/交易所/监管原始序列，SAM 与可得份额必须来自当前公司披露；所有输入还须有同一行业/产品或地域边界、币种、单位、期间与口径，并满足 TAM ≥ SAM ≥ SOM。",
        inputs: marketCalculation.inputs,
        conflicts: marketCalculation.conflicts,
        candidateSetCount: marketCalculation.candidateSetCount,
        derived: marketCalculation.derived,
        scenario,
      },
    };
  } catch (error) {
    if (String(error).includes("no such table: research_auto_filing_fact_inputs")) return { availability: "unavailable" as const, items: [] as Row[], requirements: [], calculation: { status: "blocked" as const, missing: ["storage"], basisCount: 0, rule: "市场输入账本尚未初始化。" } };
    throw error;
  }
}

function sourceBoundMarketCalculation(items: Row[]) {
  const amount = (item: Row) => finiteNumber(item.numericValue) !== null && Boolean(text(item.currency) && text(item.unit) && text(item.amountScale) && text(item.subjectLabel) && validResearchPeriod(text(item.reportPeriod)));
  const ratio = (item: Row) => ratioValue(item) !== null && Boolean(text(item.subjectLabel) && validResearchPeriod(text(item.reportPeriod)));
  const tamCandidates = items.filter((item) => text(item.factType) === "tam_input" && amount(item));
  const samCandidates = items.filter((item) => text(item.factType) === "sam_boundary" && amount(item));
  const shareCandidates = items.filter((item) => text(item.factType) === "share" && ratio(item));
  const marginCandidates = items.filter((item) => text(item.factType) === "profit_pool" && ratio(item));
  const candidateSets: Array<{ tam: Row; sam: Row; share: Row; margin: Row }> = [];
  for (const tam of tamCandidates) for (const sam of samCandidates) {
    if (!sameAmountBasis(tam, sam) || !sameMarketFamily(tam, sam) || !tamCanContainSam(tam, sam)) continue;
    for (const share of shareCandidates) for (const margin of marginCandidates) {
      if (sameServiceScope(sam, share) && sameServiceScope(sam, margin)) candidateSets.push({ tam, sam, share, margin });
    }
  }
  const selected = candidateSets.length === 1 ? candidateSets[0] : null;
  const tamValue = finiteNumber(selected?.tam.numericValue); const samValue = finiteNumber(selected?.sam.numericValue);
  const shareRatio = selected ? ratioValue(selected.share) : null; const marginRatio = selected ? ratioValue(selected.margin) : null;
  const som = samValue !== null && shareRatio !== null ? finiteNumber(samValue * shareRatio) : null;
  const profit = som !== null && marginRatio !== null ? finiteNumber(som * marginRatio) : null;
  const hierarchyValid = tamValue !== null && samValue !== null && som !== null && tamValue >= samValue && samValue >= som;
  const missing = [
    !tamCandidates.length ? "tam_numeric_currency_unit_scale_scope_period" : null,
    !samCandidates.length ? "sam_numeric_currency_unit_scale_scope_period" : null,
    !shareCandidates.length ? "share_ratio_scope_period" : null,
    !marginCandidates.length ? "profit_margin_ratio_scope_period" : null,
    tamCandidates.length && samCandidates.length && !candidateSets.length ? "market_family_or_service_scope_or_basis_not_comparable" : null,
    candidateSets.length > 1 ? "multiple_comparable_candidate_sets" : null,
    selected && !hierarchyValid ? "tam_sam_som_hierarchy" : null,
  ].filter((value): value is string => Boolean(value));
  const states = [
    { key: "tam", label: "TAM", item: selected?.tam ?? tamCandidates[0] ?? null, present: tamCandidates.length > 0, accepted: Boolean(selected), reason: !tamCandidates.length ? "需要数值、币种、单位、缩放、市场对象和报告期齐全的行业总量。" : selected ? "已纳入唯一同口径计算集合。" : "存在候选，但未形成唯一可比较计算集合。" },
    { key: "sam", label: "SAM", item: selected?.sam ?? samCandidates[0] ?? null, present: samCandidates.length > 0, accepted: Boolean(selected), reason: !samCandidates.length ? "需要数值、币种、单位、缩放、可服务对象和报告期齐全的公司侧边界。" : selected ? "已纳入唯一同口径计算集合。" : "存在候选，但未形成唯一可比较计算集合。" },
    { key: "share", label: "可得份额", item: selected?.share ?? shareCandidates[0] ?? null, present: shareCandidates.length > 0, accepted: Boolean(selected), reason: !shareCandidates.length ? "需要同一可服务边界、同一报告期的来源绑定份额比例。订单或产能不会被自动当作份额。" : selected ? "已纳入唯一同口径计算集合。" : "存在候选，但未形成唯一可比较计算集合。" },
    { key: "margin", label: "利润率", item: selected?.margin ?? marginCandidates[0] ?? null, present: marginCandidates.length > 0, accepted: Boolean(selected), reason: !marginCandidates.length ? "需要同一可服务边界、同一报告期的来源绑定利润率比例。" : selected ? "已纳入唯一同口径计算集合。" : "存在候选，但未形成唯一可比较计算集合。" },
  ];
  return {
    status: !missing.length ? "eligible" as const : "blocked" as const,
    missing, inputs: states, conflicts: candidateSets.length > 1 ? ["multiple_comparable_candidate_sets"] : [], candidateSetCount: candidateSets.length,
    basisCount: selected ? new Set([`${text(selected.tam.currency)}|${text(selected.tam.unit)}|${text(selected.tam.amountScale)}|${text(selected.tam.reportPeriod)}`, `${text(selected.sam.currency)}|${text(selected.sam.unit)}|${text(selected.sam.amountScale)}|${text(selected.sam.reportPeriod)}`]).size : 0,
    derived: selected && hierarchyValid && profit !== null ? { tam: tamValue, sam: samValue, som, profit, currency: text(selected.tam.currency), unit: text(selected.tam.unit), amountScale: text(selected.tam.amountScale), reportPeriod: text(selected.tam.reportPeriod), inputs: selected } : null,
  };
}
function marketFactTypeFromIndustryMetric(metricKey: string): "tam_input" | "profit_pool" | "industry_kpi" {
  // This is a controlled vocabulary bridge, not semantic classification of
  // prose.  An extractor must emit one of these explicit metric keys for an
  // external series to enter a TAM or margin gate.
  if (["tam", "market_size", "market_revenue", "industry_revenue", "addressable_market"].includes(metricKey)) return "tam_input";
  if (["profit_margin", "industry_profit_margin", "market_profit_margin"].includes(metricKey)) return "profit_pool";
  return "industry_kpi";
}
function sameAmountBasis(left: Row | null, right: Row | null): boolean {
  if (!left || !right || finiteNumber(left.numericValue) === null || finiteNumber(right.numericValue) === null) return false;
  return text(left.currency) === text(right.currency) && text(left.unit) === text(right.unit)
    && text(left.amountScale) === text(right.amountScale) && text(left.reportPeriod) === text(right.reportPeriod)
    && Boolean(text(left.currency) && text(left.unit) && text(left.amountScale) && text(left.reportPeriod));
}
function sameMarketFamily(left: Row | null, right: Row | null): boolean {
  if (!left || !right) return false;
  const leftSubject = text(left.subjectLabel); const rightSubject = text(right.subjectLabel);
  // The source must name the same market family, geography and reporting
  // period before even a TAM/SAM hierarchy can be assessed.
  return Boolean(leftSubject && rightSubject && leftSubject === rightSubject
    && text(left.geographyLabel) === text(right.geographyLabel)
    && text(left.reportPeriod) === text(right.reportPeriod));
}
function tamCanContainSam(tam: Row, sam: Row): boolean {
  // A TAM may be broader than a SAM, but the issuer must not silently pair a
  // different product scope. An empty TAM segment is explicitly the broad
  // family scope; otherwise the two segment labels must be identical.
  const tamSegment = text(tam.segmentLabel); const samSegment = text(sam.segmentLabel);
  return !tamSegment || tamSegment === samSegment;
}
function sameServiceScope(left: Row, right: Row): boolean {
  return sameMarketFamily(left, right) && text(left.segmentLabel) === text(right.segmentLabel);
}
function ratioValue(item: Row): number | null {
  const raw = finiteNumber(item.numericValue); if (raw === null) return null;
  const unit = text(item.unit).toLowerCase();
  if (unit === "%" || unit === "percent" || unit === "percentage") return raw / 100;
  if (unit === "ratio" || unit === "倍" || unit === "x") return raw >= 0 && raw <= 1 ? raw : null;
  return raw >= 0 && raw <= 1 ? raw : null;
}

function sourceBoundMarketScenarios(items: Row[]) {
  const candidates = items.filter((item) => text(item.factType) === "market_scenario");
  const grouped = new Map<string, { scenario: "downside" | "base" | "upside"; label: string; subjectLabel: string; geographyLabel: string; reportPeriod: string; demand?: Row; share?: Row; margin?: Row }>();
  const blocked: Array<{ inputId: string; reason: string }> = [];
  for (const item of candidates) {
    const parsed = /^market_(downside|base|upside)__(demand|share|margin)__([a-z0-9_-]+)$/i.exec(text(item.factKey));
    const inputId = text(item.inputId); const subject = text(item.subjectLabel); const geography = text(item.geographyLabel); const period = text(item.reportPeriod);
    if (!parsed || !subject || !dateOnly(period)) {
      blocked.push({ inputId, reason: !parsed ? "market_scenario_fact_key_invalid" : !subject ? "market_scenario_subject_missing" : "market_scenario_report_period_invalid" });
      continue;
    }
    const scenario = parsed[1] as "downside" | "base" | "upside"; const metric = parsed[2] as "demand" | "share" | "margin";
    const key = `${scenario}|${parsed[3]}|${subject}|${geography}|${period}`;
    const group = grouped.get(key) ?? { scenario, label: parsed[3], subjectLabel: subject, geographyLabel: geography, reportPeriod: period };
    if (group[metric]) { blocked.push({ inputId, reason: `market_scenario_duplicate_${metric}` }); continue; }
    group[metric] = item; grouped.set(key, group);
  }
  const scenarioItems = [...grouped.values()].map((group) => {
    const demandValue = finiteNumber(group.demand?.numericValue); const share = group.share ? ratioValue(group.share) : null; const margin = group.margin ? ratioValue(group.margin) : null;
    const demandBasisReady = Boolean(group.demand && demandValue !== null && text(group.demand.currency) && text(group.demand.unit) && text(group.demand.amountScale));
    const missing = [!demandBasisReady ? "demand_amount_currency_unit_scale" : null, share === null ? "share_ratio" : null, margin === null ? "margin_ratio" : null].filter((item): item is string => Boolean(item));
    const som = !missing.length && demandValue !== null && share !== null ? finiteNumber(demandValue * share) : null;
    const profit = som !== null && margin !== null ? finiteNumber(som * margin) : null;
    return { ...group, status: !missing.length && som !== null && profit !== null ? "eligible" as const : "blocked" as const, missing, derived: som === null || profit === null ? null : { som, profit, currency: text(group.demand?.currency), unit: text(group.demand?.unit), amountScale: text(group.demand?.amountScale) } };
  });
  const requiredScenarios = ["downside", "base", "upside"] as const;
  const absent = requiredScenarios.filter((scenario) => !scenarioItems.some((item) => item.scenario === scenario));
  return {
    status: scenarioItems.length && !scenarioItems.some((item) => item.status === "blocked") && !absent.length ? "eligible" as const : "blocked" as const,
    items: scenarioItems, blocked, missing: [...absent.map((scenario) => `source_bound_${scenario}_scenario`), ...scenarioItems.flatMap((item) => item.missing)],
    rule: "每个上行、基准、下行情景都必须在原文中明示，并以同一对象、地区、报告期的需求金额、可得份额和利润率组成；工程计算 SOM = 需求 × 份额、利润池 = SOM × 利润率，不从历史值、区间或模型观点生成情景。",
  };
}

/** Source-bound risk ledger projection.  Each statutory item remains a
 * separate exposure record unless the filing itself provided its transmission,
 * trigger, mitigation, speed, reversibility or risk-assessment facet;
 * unrelated risk paragraphs are never merged. */
export async function loadResearchAutoRiskLedger(db: D1Database, securityCode: string) {
  const code = required(securityCode, "securityCode").toUpperCase();
  try {
    const rows = await db.prepare(`select filing_fact_input_id as inputId, statutory_document_id as documentId, document_url as documentUrl,
      fact_type as factType, fact_key as factKey, title, statement, reported_value as reportedValue, report_period as reportPeriod,
      subject_label as subjectLabel, exposure_key as exposureKey, causal_direction as causalDirection, period_kind as periodKind,
      evidence_quote as evidenceQuote, evidence_locator as evidenceLocator, extraction_method as extractionMethod, processed_at as processedAt
      from research_auto_filing_fact_inputs where security_code=? and target_module='risk' and validity_status='current'
      order by processed_at desc, title limit 100`).bind(code).all<Row>();
    const items = rows.results.map((item) => {
      const type = text(item.factType);
      const fields = {
        exposure: type === "risk_exposure" ? text(item.statement) : null,
        transmission: type === "transmission" ? text(item.statement) : null,
        trigger: type === "trigger" ? text(item.statement) : null,
        mitigation: type === "mitigation" ? text(item.statement) : null,
        speed: type === "risk_speed" ? text(item.statement) : null,
        reversibility: type === "risk_reversibility" ? text(item.statement) : null,
        grossAssessment: type === "gross_risk_assessment" ? text(item.statement) : null,
        residualAssessment: type === "residual_risk_assessment" ? text(item.statement) : null,
      };
      const missing = Object.entries(fields).filter(([, value]) => !value).map(([key]) => key);
      return { ...item, fields, status: missing.length ? "partial" as const : "available" as const, missing };
    });
    return {
      availability: items.length ? "available" as const : "empty" as const,
      items,
      limitations: "损失金额、风险发生速度、可逆性、毛/剩余风险和压力情景均不会从风险类别或措辞推断；只有法定原文明示的相应事实才显示，量化压力另需完整的来源绑定基准、冲击与公式。",
    };
  } catch (error) {
    if (String(error).includes("no such table: research_auto_filing_fact_inputs")) return { availability: "unavailable" as const, items: [] as Row[], limitations: "风险输入账本尚未初始化。" };
    throw error;
  }
}

/**
 * Quantified risk is a separate gate from the qualitative risk ledger.  A
 * paragraph describing a risk must never be converted into a loss estimate.
 * This reader only groups explicit, source-bound baseline, shock and formula
 * records when the extractor gave them the same disclosed scenario label.
 */
export async function loadResearchAutoRiskQuantitativeInputGate(db: D1Database, securityCode: string) {
  const code = required(securityCode, "securityCode").toUpperCase();
  try {
    const rows = await db.prepare(`select filing_fact_input_id as inputId, statutory_document_id as documentId,
      document_url as documentUrl, fact_type as factType, fact_key as factKey, title, statement,
      reported_value as reportedValue, value_type as valueType, numeric_value as numericValue, unit,
      currency, amount_scale as amountScale, report_period as reportPeriod, subject_label as subjectLabel,
      evidence_quote as evidenceQuote, evidence_locator as evidenceLocator, extraction_method as extractionMethod,
      processed_at as processedAt
      from research_auto_filing_fact_inputs where security_code=? and target_module='risk' and validity_status='current'
        and fact_type in ('quantitative_baseline', 'quantitative_shock', 'stress_formula')
      order by processed_at desc, statutory_document_id, fact_key limit 100`).bind(code).all<Row>();
    const items = rows.results;
    const groups = new Map<string, Row[]>();
    for (const item of items) {
      // A field label and a native document id are both required join keys.
      // Do not combine e.g. one customer-concentration percentage from an
      // annual report with an unrelated FX shock from a later 6-K.
      const stress = stressFactDescriptor(item);
      const scenarioKey = stress ? `${text(item.documentId)}|${text(item.subjectLabel).toLowerCase()}|${stress.metric}` : "";
      if (!scenarioKey) continue;
      groups.set(scenarioKey, [...(groups.get(scenarioKey) ?? []), item]);
    }
    const scenarios = [...groups.entries()].map(([scenarioKey, sourceItems]) => {
      const byType = (factType: string) => sourceItems.filter((item) => text(item.factType) === factType);
      const baseline = byType("quantitative_baseline");
      const shock = byType("quantitative_shock");
      const formula = byType("stress_formula");
      const descriptor = stressFactDescriptor(sourceItems[0]);
      const formulaKind = formula.length === 1 ? stressFactDescriptor(formula[0])?.formulaKind ?? null : null;
      const missing = [
        baseline.length === 1 ? null : "one_source_bound_baseline",
        shock.length === 1 ? null : "one_source_bound_shock",
        formula.length === 1 ? null : "one_source_bound_formula",
        descriptor?.metric ? null : "supported_stress_metric_in_fact_key",
        formulaKind ? null : "explicit_supported_formula_in_fact_key",
        baseline.length === 1 && finiteNumber(baseline[0].numericValue) === null ? "numeric_baseline_value" : null,
        shock.length === 1 && finiteNumber(shock[0].numericValue) === null ? "numeric_shock_value" : null,
      ].filter((value): value is string => Boolean(value));
      const sourceDocuments = [...new Set(sourceItems.map((item) => text(item.documentId)).filter(Boolean))];
      return {
        scenarioKey,
        label: text(sourceItems[0]?.subjectLabel),
        documentId: text(sourceItems[0]?.documentId),
        metric: descriptor?.metric ?? null,
        formulaKind,
        status: missing.length ? "blocked" as const : "input_ready" as const,
        missing,
        sourceDocuments,
        inputs: sourceItems,
      };
    });
    const ungrouped = items.filter((item) => !text(item.subjectLabel));
    return {
      availability: items.length ? "available" as const : "empty" as const,
      items,
      scenarios,
      ungrouped,
      rule: "压力结果只在同一法定披露明确给出并以同一风险/情景对象标识的量化基准、冲击和公式都入账后，才可交给已版本化的工程模型执行。此门禁不从风险段落推断概率、损失、速度、可逆性或剩余风险，也不在页面计算结果。",
    };
  } catch (error) {
    if (String(error).includes("no such table: research_auto_filing_fact_inputs")) {
      return { availability: "unavailable" as const, items: [] as Row[], scenarios: [] as Row[], ungrouped: [] as Row[], rule: "风险输入账本尚未初始化。" };
    }
    throw error;
  }
}

/**
 * Writes a versioned pressure result only where a filing supplied all three
 * required ingredients and encoded the formula in the controlled fact key.
 * The expression is deliberately tiny and deterministic; prose such as
 * "would adversely affect" never becomes a stress result.
 */
export async function materializeResearchAutoRiskPressureScenarios(db: D1Database, securityCode: string, now = Date.now()) {
  const code = required(securityCode, "securityCode").toUpperCase();
  const gate = await loadResearchAutoRiskQuantitativeInputGate(db, code);
  if (gate.availability !== "available") return { availability: gate.availability, created: [], blocked: [] as Array<{ scenarioKey: string; reason: string }> };
  try {
    const company = await db.prepare("select company_id as companyId from research_listed_securities where security_code=?").bind(code).first<{ companyId: string | null }>();
    const created: Array<{ scenarioId: string; scenarioKey: string; version: number }> = [];
    const blocked: Array<{ scenarioKey: string; reason: string }> = [];
    for (const raw of gate.scenarios as Array<Record<string, unknown>>) {
      const scenarioKey = text(raw.scenarioKey);
      if (text(raw.status) !== "input_ready") { blocked.push({ scenarioKey, reason: "quantitative_input_gate_blocked" }); continue; }
      const inputs = Array.isArray(raw.inputs) ? raw.inputs as Row[] : [];
      const baseline = inputs.find((item) => text(item.factType) === "quantitative_baseline");
      const shock = inputs.find((item) => text(item.factType) === "quantitative_shock");
      const formula = inputs.find((item) => text(item.factType) === "stress_formula");
      const descriptor = formula ? stressFactDescriptor(formula) : null;
      const baselineValue = finiteNumber(baseline?.numericValue); const shockValue = finiteNumber(shock?.numericValue);
      if (!baseline || !shock || !formula || baselineValue === null || shockValue === null || !descriptor?.metric || !descriptor.formulaKind) {
        blocked.push({ scenarioKey, reason: "formula_or_numeric_input_missing" }); continue;
      }
      const stressed = applyStressFormula(descriptor.formulaKind, baselineValue, shockValue, text(baseline.unit), text(shock.unit));
      if (stressed === null) { blocked.push({ scenarioKey, reason: "formula_units_not_compatible" }); continue; }
      const documentId = text(baseline.documentId);
      const persistentScenarioKey = `filing:${slug(text(baseline.subjectLabel))}:${descriptor.metric}`;
      const stableScenarioId = `auto-risk-pressure:${code}:${documentId}:${descriptor.metric}:${slug(text(baseline.subjectLabel))}`;
      const existing = await db.prepare("select scenario_id as scenarioId, version from research_risk_pressure_scenarios where scenario_id=?")
        .bind(stableScenarioId).first<{ scenarioId: string; version: number }>();
      if (existing) { created.push({ scenarioId: existing.scenarioId, scenarioKey, version: existing.version }); continue; }
      const previous = await db.prepare(`select scenario_id as scenarioId, version from research_risk_pressure_scenarios
        where security_code=? and scenario_key=? order by version desc limit 1`).bind(code, persistentScenarioKey).first<{ scenarioId: string; version: number }>();
      const refs = [baseline, shock, formula].map((item) => ({ sourceKind: "filing" as const, documentId: text(item.documentId), url: text(item.documentUrl), title: text(item.title) || "法定披露量化压力输入", locator: text(item.evidenceLocator) }));
      const version = (previous?.version ?? 0) + 1;
      await insertResearchRiskPressureScenario(db, {
        scenarioId: stableScenarioId, companyId: company?.companyId ?? null, securityCode: code, asOf: now, scenarioKey: persistentScenarioKey,
        version, supersedesScenarioId: previous?.scenarioId ?? null, status: "draft", scope: "operating_company",
        title: `${text(baseline.subjectLabel) || "法定披露风险"} · ${descriptor.metric} 压力情景`,
        transmission: `工程按 ${descriptor.formulaKind} 对同一法定披露中的明确基准与冲击执行计算；不引入概率、速度、剩余风险或其他来源。`,
        modelVersion: "research-auto-filing-risk-stress.v1",
        inputs: [{ key: descriptor.metric, label: descriptor.metric, baseline: baselineValue, stressed, unit: text(baseline.unit) || null, epistemicType: "observed_fact", sourceReferences: refs.slice(0, 2) }],
        results: [{ key: descriptor.metric, label: `${descriptor.metric} 压力结果`, value: stressed, unit: text(baseline.unit) || null, explanation: `公式：${descriptor.formulaKind}；${text(formula.evidenceQuote)}` }],
        sourceReferences: refs, createdAt: now, updatedAt: now,
      });
      created.push({ scenarioId: stableScenarioId, scenarioKey: persistentScenarioKey, version });
    }
    return { availability: "available" as const, created, blocked, rule: "仅执行受控 factKey 中声明的 baseline_plus_shock、baseline_times_one_plus_shock 或 baseline_times_one_minus_shock；其他自然语言公式、单位不匹配或不完整输入一律阻断。" };
  } catch (error) {
    if (/no such table/i.test(String(error))) return { availability: "unavailable" as const, created: [], blocked: [] as Array<{ scenarioKey: string; reason: string }>, reason: "storage_not_initialized" };
    throw error;
  }
}

type StressFormulaKind = "baseline_plus_shock" | "baseline_times_one_plus_shock" | "baseline_times_one_minus_shock";
function stressFactDescriptor(item: Row | undefined): { metric: "revenue" | "operating_cash_flow" | "net_debt"; formulaKind: StressFormulaKind | null } | null {
  const match = /^risk_[a-z0-9_]+__(revenue|operating_cash_flow|net_debt)__(baseline|shock|baseline_plus_shock|baseline_times_one_plus_shock|baseline_times_one_minus_shock)$/i.exec(text(item?.factKey));
  if (!match) return null;
  return { metric: match[1].toLowerCase() as "revenue" | "operating_cash_flow" | "net_debt", formulaKind: match[2].startsWith("baseline_") ? match[2] as StressFormulaKind : null };
}
function applyStressFormula(kind: StressFormulaKind, baseline: number, shock: number, baselineUnit: string, shockUnit: string): number | null {
  if (kind === "baseline_plus_shock") return baselineUnit && baselineUnit === shockUnit ? finiteNumber(baseline + shock) : null;
  const ratio = shockUnit === "%" ? shock / 100 : shockUnit === "ratio" ? shock : null;
  if (ratio === null) return null;
  return finiteNumber(baseline * (kind === "baseline_times_one_plus_shock" ? 1 + ratio : 1 - ratio));
}
function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "unlabelled"; }

/** Freezes an automatic, source-only risk snapshot after a new current risk
 * fact set is rebuilt. It does not calculate probability, loss or residual
 * risk; its only job is to make factual changes between filings observable. */
async function saveResearchAutoRiskSnapshot(db: D1Database, securityCode: string, sourceSignature: string, now: number) {
  const rows = await db.prepare(`select statutory_document_id as documentId, fact_key as factKey, fact_type as factType,
      title, statement, subject_label as subjectLabel, exposure_key as exposureKey, evidence_locator as evidenceLocator,
      processed_at as processedAt from research_auto_filing_fact_inputs
      where security_code=? and target_module='risk' and validity_status='current' order by statutory_document_id, fact_key`)
    .bind(securityCode).all<Row>();
  const items = rows.results.map((item) => ({ documentId: text(item.documentId), factKey: text(item.factKey), factType: text(item.factType), title: text(item.title), statement: text(item.statement), subjectLabel: nullable(item.subjectLabel), exposureKey: nullable(item.exposureKey), evidenceLocator: text(item.evidenceLocator), processedAt: finiteNumber(item.processedAt) }));
  const documentIds = [...new Set(items.map((item) => item.documentId).filter(Boolean))];
  await db.prepare(`insert or ignore into research_auto_risk_snapshots (
    auto_risk_snapshot_id, security_code, source_signature, source_document_ids_json, items_json, as_of, created_at
  ) values (?, ?, ?, ?, ?, ?, ?)`).bind(`auto-risk-snapshot:${securityCode}:${sourceSignature}`, securityCode, sourceSignature, JSON.stringify(documentIds), JSON.stringify(items), now, now).run();
}

export async function loadResearchAutoRiskSnapshotHistory(db: D1Database, securityCode: string) {
  const code = required(securityCode, "securityCode").toUpperCase();
  try {
    const rows = await db.prepare(`select auto_risk_snapshot_id as snapshotId, source_signature as sourceSignature,
      source_document_ids_json as sourceDocumentIdsJson, items_json as itemsJson, as_of as asOf, created_at as createdAt
      from research_auto_risk_snapshots where security_code=? order by as_of desc limit 12`).bind(code).all<Row>();
    // Source document ids are stored as JSON strings, while risk items are
    // objects.  Do not parse both with the object-array reader: doing so
    // erases the source chain from an otherwise valid frozen snapshot.
    const items = rows.results.map((row) => ({ ...row, sourceDocumentIds: jsonStringArray(row.sourceDocumentIdsJson), riskItems: jsonArray(row.itemsJson) }));
    const current = items[0] as Row | undefined; const prior = items[1] as Row | undefined;
    const currentItems = jsonArray(current?.riskItems); const priorItems = jsonArray(prior?.riskItems);
    const currentKeys = new Set(currentItems.map((item) => riskSnapshotKey(item)));
    const priorKeys = new Set(priorItems.map((item) => riskSnapshotKey(item)));
    const added = [...currentKeys].filter((key) => !priorKeys.has(key)); const removed = [...priorKeys].filter((key) => !currentKeys.has(key));
    return {
      availability: items.length ? "available" as const : "empty" as const,
      items,
      difference: current && prior ? {
        status: "available" as const,
        currentSnapshotId: text(current.snapshotId), priorSnapshotId: text(prior.snapshotId), added, removed,
        addedItems: currentItems.filter((item) => !priorKeys.has(riskSnapshotKey(item))),
        removedItems: priorItems.filter((item) => !currentKeys.has(riskSnapshotKey(item))),
        rule: "工程只对两份已冻结风险快照中的 documentId、factKey、factType 与原文陈述逐项比较；新增/移除仅表示来源事实集变化，不推断风险大小、发生概率或变化原因。",
        processedAt: finiteNumber(current.createdAt) ?? finiteNumber(current.asOf),
      } : { status: "blocked" as const, reason: "至少需要两份来源绑定风险快照才可比较变化。" },
    };
  } catch (error) {
    if (String(error).includes("no such table: research_auto_risk_snapshots")) return { availability: "unavailable" as const, items: [] as Row[], difference: { status: "blocked" as const, reason: "自动风险快照账本尚未初始化。" } };
    throw error;
  }
}

/** Read-only industry and competition projection.  The company filing can
 * establish its exposure to demand, supply or policy, but it cannot by itself
 * establish a peer set, market boundary, ranking or a moat duration. */
export async function loadResearchAutoIndustryCompetitionInputs(db: D1Database, securityCode: string) {
  const code = required(securityCode, "securityCode").toUpperCase();
  try {
    const rows = await db.prepare(`select filing_fact_input_id as inputId, statutory_document_id as documentId, document_url as documentUrl,
      fact_type as factType, fact_key as factKey, title, statement, reported_value as reportedValue, report_period as reportPeriod,
      subject_label as subjectLabel, related_security_code as relatedSecurityCode,
      driver_key as driverKey, causal_direction as causalDirection, period_kind as periodKind,
      evidence_quote as evidenceQuote, evidence_locator as evidenceLocator, extraction_method as extractionMethod, processed_at as processedAt
      from research_auto_filing_fact_inputs where security_code=? and target_module='industry' and validity_status='current'
      order by processed_at desc, title limit 100`).bind(code).all<Row>();
    const items = rows.results;
    const available = new Set(items.map((item) => text(item.factType)));
    const requiredCoverage = [
      { key: "demand", label: "需求与行业 KPI", present: available.has("demand") || available.has("industry_kpi") },
      { key: "supply", label: "供给、产能或技术路线", present: available.has("supply") },
      { key: "competition", label: "竞争或替代关系", present: available.has("competition") },
      { key: "barrier", label: "壁垒的可证实要素", present: available.has("barrier") },
      { key: "counterevidence", label: "竞争反证", present: available.has("counterevidence") },
      { key: "policy", label: "政策/监管约束", present: available.has("policy") },
    ];
    const missing = requiredCoverage.filter((item) => !item.present).map((item) => item.key);
    const peerInputs = items.filter((item) => ["competition", "counterevidence"].includes(text(item.factType)));
    const boundaryLabels = new Set(items
      .filter((item) => /^industry_boundary__[a-z0-9_-]+$/i.test(text(item.factKey)) && Boolean(text(item.subjectLabel)))
      .map((item) => text(item.subjectLabel)));
    const candidateCodes = [...new Set(peerInputs.map((item) => validRelatedSecurityCode(item.relatedSecurityCode)).filter((item): item is string => Boolean(item)))];
    const [candidateSecurities, financialAvailability, operatingFacts, companyFinancialAvailability] = await Promise.all([
      candidateCodes.length
        ? db.prepare(`select security.security_code as securityCode, security.venue, security.mapping_status as mappingStatus,
            company.canonical_name as canonicalName
            from research_listed_securities security
            left join research_operating_companies company on company.company_id=security.company_id
            where security.security_code in (${candidateCodes.map(() => "?").join(",")})`).bind(...candidateCodes).all<Row>()
        : Promise.resolve({ results: [] as Row[] }),
      candidateCodes.length
        ? db.prepare(`select security_code as securityCode, statement_type as statementType,
            availability_status as availabilityStatus, latest_period as latestPeriod, as_of as asOf
            from research_financial_availability_observations
            where security_code in (${candidateCodes.map(() => "?").join(",")}) and source_role='primary_structured'
            order by as_of desc`).bind(...candidateCodes).all<Row>()
        : Promise.resolve({ results: [] as Row[] }),
      db.prepare(`select filing_fact_input_id as inputId, statutory_document_id as documentId, document_url as documentUrl,
        fact_type as factType, fact_key as factKey, title, statement, reported_value as reportedValue,
        report_period as reportPeriod, subject_label as subjectLabel, driver_key as driverKey,
        causal_direction as causalDirection, evidence_quote as evidenceQuote, evidence_locator as evidenceLocator,
        extraction_method as extractionMethod, processed_at as processedAt
        from research_auto_filing_fact_inputs where security_code=? and target_module='operating' and validity_status='current'
        order by processed_at desc, title limit 100`).bind(code).all<Row>(),
      db.prepare(`select statement_type as statementType, availability_status as availabilityStatus,
        latest_period as latestPeriod, as_of as asOf
        from research_financial_availability_observations
        where security_code=? and source_role='primary_structured' order by as_of desc`).bind(code).all<Row>(),
    ]);
    const candidateByCode = new Map(candidateSecurities.results.map((item) => [text(item.securityCode), item]));
    const latestFinancials = new Map<string, Map<string, Row>>();
    for (const observation of financialAvailability.results) {
      const candidateCode = text(observation.securityCode);
      const statementType = text(observation.statementType);
      if (!candidateCode || !statementType) continue;
      const byStatement = latestFinancials.get(candidateCode) ?? new Map<string, Row>();
      // Results are newest first, so preserve the first source-bound observation
      // for each statement rather than combining different collection dates.
      if (!byStatement.has(statementType)) byStatement.set(statementType, observation);
      latestFinancials.set(candidateCode, byStatement);
    }
    const currentMarket = researchMarketForCode(code);
    const peerCandidates = peerInputs.map((item) => {
      const relatedSecurityCode = validRelatedSecurityCode(item.relatedSecurityCode);
      const security = relatedSecurityCode ? candidateByCode.get(relatedSecurityCode) : undefined;
      const candidateMarket = relatedSecurityCode ? researchMarketForCode(relatedSecurityCode) : null;
      const financials = relatedSecurityCode ? latestFinancials.get(relatedSecurityCode) : undefined;
      const sourceMissing = [
        !text(item.documentUrl) ? "document_url" : null,
        !text(item.reportPeriod) ? "report_period" : null,
        !text(item.statement) ? "statement" : null,
        !text(item.evidenceQuote) ? "evidence_quote" : null,
        !text(item.evidenceLocator) ? "evidence_locator" : null,
        !text(item.extractionMethod) ? "extraction_method" : null,
        finiteNumber(item.processedAt) === null ? "processed_at" : null,
      ].filter((value): value is string => Boolean(value));
      const boundaryStatus = text(item.subjectLabel) && boundaryLabels.has(text(item.subjectLabel)) ? "matched" as const : "missing" as const;
      const availableFinancialStatements = ["income", "balance", "cashflow"].filter((statementType) => ["verified_available", "partially_available"].includes(text(financials?.get(statementType)?.availabilityStatus)));
      const verifiedFinancialStatements = ["income", "balance", "cashflow"].filter((statementType) => text(financials?.get(statementType)?.availabilityStatus) === "verified_available");
      const financialInputStatus = availableFinancialStatements.length === 3 ? "available" as const : financials?.size ? "partial" as const : "missing" as const;
      const financialVerificationStatus = verifiedFinancialStatements.length === 3 ? "verified" as const : availableFinancialStatements.length === 3 ? "pending" as const : "unavailable" as const;
      const reportedPeriods = ["income", "balance", "cashflow"].map((statementType) => nullable(financials?.get(statementType)?.latestPeriod)).filter((period): period is string => Boolean(period)).sort();
      const financialLatestPeriod = reportedPeriods.length ? reportedPeriods[reportedPeriods.length - 1] : null;
      const exclusionReason = !relatedSecurityCode
        ? "法定原文未明确给出可规范化的上市证券代码；不会从公司名称、行业标签或常识猜测同行。"
        : relatedSecurityCode === code
          ? "原文代码与当前研究证券相同，不能作为同行候选。"
          : boundaryStatus !== "matched"
            ? "竞争事实没有与当前证券法定披露的明确行业边界逐字对应，不能构成边界内同行候选。"
            : sourceMissing.length
              ? `竞争事实的来源字段不完整（缺少：${sourceMissing.join("、")}），不能自动纳入。`
          : !currentMarket || !candidateMarket || candidateMarket !== currentMarket
            ? "候选证券与当前证券不属于同一市场类型，不能进入同市场可比候选。"
            : !security
              ? "原文给出的证券代码尚未建立独立的上市证券记录，不能自动纳入。"
              : text(security.mappingStatus) !== "confirmed"
                ? `候选证券的公司—证券映射为 ${text(security.mappingStatus) || "未记录"}，不能作为独立可比证券。`
              : financialInputStatus === "missing"
                ? "候选证券尚无独立的主来源三表可用性记录，不能作为可比候选。"
                : financialInputStatus === "partial"
                  ? `候选证券独立三表主源覆盖不完整（当前可得：${availableFinancialStatements.length ? availableFinancialStatements.join("、") : "无"}），不能作为可比候选。`
                  : null;
      return {
        candidateName: nullable(security?.canonicalName) ?? nullable(item.subjectLabel) ?? text(item.title),
        candidateSecurityCode: relatedSecurityCode,
        candidateMarket,
        relationshipType: text(item.factType),
        membershipStatus: exclusionReason ? "excluded" as const : "eligible" as const,
        mappingStatus: nullable(security?.mappingStatus),
        boundaryStatus,
        sourceCompleteness: sourceMissing.length ? "partial" as const : "complete" as const,
        missing: sourceMissing,
        financialInputStatus,
        financialVerificationStatus,
        financialLatestPeriod,
        exclusionReason: exclusionReason ?? `法定原文明确代码、同市场类型、独立证券记录及三表主来源可用性均已满足；${financialVerificationStatus === "verified" ? "三表已法定核验。" : "法定交叉核验仍待后续自动链完成。"}仅作为可比候选，不构成竞争排名、市场份额或壁垒结论。`,
        title: text(item.title), statement: text(item.statement), subjectLabel: nullable(item.subjectLabel), factKey: text(item.factKey), documentUrl: text(item.documentUrl), reportPeriod: nullable(item.reportPeriod), evidenceQuote: text(item.evidenceQuote), evidenceLocator: text(item.evidenceLocator), extractionMethod: text(item.extractionMethod), processedAt: finiteNumber(item.processedAt),
      };
    });
    const companyFinancialStatements = new Map<string, Row>();
    for (const observation of companyFinancialAvailability.results) {
      const statementType = text(observation.statementType);
      if (statementType && !companyFinancialStatements.has(statementType)) companyFinancialStatements.set(statementType, observation);
    }
    const transmission = sourceBoundIndustryCompanyTransmission(items, operatingFacts.results);
    const durability = sourceBoundIndustryDurability({
      industryItems: items,
      operatingItems: operatingFacts.results,
      peerCandidates,
      companyFinancialStatements,
    });
    return {
      availability: items.length ? "available" as const : "empty" as const,
      items,
      requiredCoverage,
      peerCandidates,
      transmission,
      durability,
    };
  } catch (error) {
    // A partially migrated local database must degrade the industry tab to a
    // visible input-store block rather than reject the whole page read.
    if (/no such table|no such column/i.test(String(error))) return { availability: "unavailable" as const, items: [] as Row[], requiredCoverage: [] as Array<{ key: string; label: string; present: boolean }>, peerCandidates: [] as Row[], durability: { status: "blocked" as const, missing: ["storage"], rule: "行业输入或同行候选账本尚未初始化。" } };
    throw error;
  }
}

/** A company-impact chain is deliberately narrower than an industry fact.
 * The two statutory extracts must name the same operating object, driver and
 * period. The final labels are deterministic financial anchors, not a model
 * forecast of magnitude or direction. */
function sourceBoundIndustryCompanyTransmission(industryItems: Row[], operatingItems: Row[]) {
  const driverKeys = new Set(["volume", "price", "mix", "cost", "working_capital"]);
  const blocked: Array<{ inputId: string; reason: string }> = [];
  type TransmissionItem = { status: "blocked"; industry: Row; companyDriver: null; financialAnchors: string[]; missing: string[] }
    | { status: "available"; industry: Row; companyDriver: Row; financialAnchors: string[]; missing: string[] };
  const items = industryItems.flatMap<TransmissionItem>((industry) => {
    const match = /^industry_transmission__([a-z0-9_-]+)__(volume|price|mix|cost|working_capital)$/i.exec(text(industry.factKey));
    const inputId = text(industry.inputId);
    const subject = text(industry.subjectLabel); const driverKey = text(industry.driverKey); const period = text(industry.reportPeriod);
    if (!match || !subject || !driverKeys.has(driverKey) || driverKey !== match[2] || !dateOnly(period)) {
      blocked.push({ inputId, reason: !match ? "industry_transmission_fact_key_invalid" : !subject ? "industry_transmission_subject_missing" : !driverKeys.has(driverKey) || driverKey !== match[2] ? "industry_transmission_driver_key_invalid" : "industry_transmission_report_period_invalid" });
      return [];
    }
    const companyDriver = operatingItems.find((operating) => text(operating.subjectLabel) === subject && text(operating.driverKey) === driverKey && text(operating.reportPeriod) === period);
    if (!companyDriver) {
      blocked.push({ inputId, reason: "company_operating_driver_same_subject_driver_period_missing" });
      return [{ status: "blocked" as const, industry, companyDriver: null, financialAnchors: financialAnchorsForDriver(driverKey), missing: ["company_operating_driver_same_subject_driver_period"] }];
    }
    return [{ status: "available" as const, industry, companyDriver, financialAnchors: financialAnchorsForDriver(driverKey), missing: [] as string[] }];
  });
  return {
    status: items.length && items.some((item) => item.status === "available") ? "available" as const : "blocked" as const,
    items,
    blocked,
    rule: "只有 industry_transmission 受控事实与当前证券 business 事实的原文对象、driverKey 和报告期完全一致时，才展示行业变量 → 公司驱动 → 财务锚点。财务锚点是确定性观察位置，不是根据行业变量估算的收入、利润或现金流。",
  };
}

function financialAnchorsForDriver(driverKey: string) {
  if (driverKey === "working_capital") return ["营运资本", "经营现金流"];
  if (driverKey === "cost") return ["营业成本", "毛利 / 归母净利", "经营现金流"];
  return ["收入", "毛利 / 归母净利", "经营现金流"];
}

/** Competition durability never upgrades a collection of company statements
 * into a moat conclusion. It reports source-bound support, erosion evidence
 * and falsification conditions, and only exposes a duration when the filing
 * itself supplied one under the controlled fact-key contract. */
function sourceBoundIndustryDurability(input: { industryItems: Row[]; operatingItems: Row[]; peerCandidates: Array<{ membershipStatus: string }>; companyFinancialStatements: Map<string, Row> }) {
  const boundaries = input.industryItems.filter((item) => /^industry_boundary__[a-z0-9_-]+$/i.test(text(item.factKey)) && Boolean(text(item.subjectLabel)));
  const boundaryLabels = new Set(boundaries.map((item) => text(item.subjectLabel)));
  const barrierEvidence = input.industryItems.filter((item) => text(item.factType) === "barrier" && boundaryLabels.has(text(item.subjectLabel)));
  const counterevidence = input.industryItems.filter((item) => text(item.factType) === "counterevidence" && boundaryLabels.has(text(item.subjectLabel)));
  const operatingEvidence = input.operatingItems.filter((item) => boundaryLabels.has(text(item.subjectLabel)) && Boolean(text(item.driverKey)));
  const qualifiedPeers = input.peerCandidates.filter((item) => item.membershipStatus === "eligible");
  const financeReady = ["income", "balance", "cashflow"].every((statementType) => {
    const status = text(input.companyFinancialStatements.get(statementType)?.availabilityStatus);
    return status === "verified_available" || status === "partially_available";
  });
  const durationEvidence = barrierEvidence.map((item) => {
    const match = /^barrier_duration__[a-z0-9_-]+__(\d+)__(days|months|years)$/i.exec(text(item.factKey));
    return match ? { item, duration: `${match[1]} ${match[2]}` } : null;
  }).filter((item): item is { item: Row; duration: string } => Boolean(item));
  const missing = [
    !boundaries.length ? "market_boundary" : null,
    !barrierEvidence.length ? "barrier_evidence" : null,
    !counterevidence.length ? "counterevidence" : null,
    !qualifiedPeers.length ? "peer_universe" : null,
    !operatingEvidence.length ? "company_operating_validation" : null,
    !financeReady ? "company_financial_validation" : null,
  ].filter((item): item is string => Boolean(item));
  return {
    status: missing.length ? "blocked" as const : "eligible" as const,
    missing,
    boundaries,
    barrierEvidence,
    counterevidence,
    operatingEvidence,
    qualifiedPeers,
    durationEvidence,
    rule: "只有明确市场边界、同市场可比候选、公司经营与三表验证、壁垒证据及竞争反证同时具备时，才展示来源支持的优势与侵蚀路径；除非法定原文明确给出期限，否则不输出壁垒持续期。",
  };
}

/** Capital-allocation and governance evidence remains separate from financial
 * statement calculations.  This projection makes each disclosure category
 * explicit and refuses to infer debt maturities, dilution or audit outcomes
 * from an absent fact. */
export async function loadResearchAutoGovernanceCapitalLedger(db: D1Database, securityCode: string) {
  const code = required(securityCode, "securityCode").toUpperCase();
  try {
    const rows = await db.prepare(`select filing_fact_input_id as inputId, statutory_document_id as documentId, document_url as documentUrl,
      fact_type as factType, fact_key as factKey, title, statement, reported_value as reportedValue, report_period as reportPeriod,
      subject_label as subjectLabel, evidence_quote as evidenceQuote, evidence_locator as evidenceLocator,
      extraction_method as extractionMethod, processed_at as processedAt
      from research_auto_filing_fact_inputs where security_code=? and target_module='governance' and validity_status='current'
      order by processed_at desc, title limit 100`).bind(code).all<Row>();
    const items = rows.results;
    const categoryDefinitions = [
      { key: "audit", label: "审计意见与控制", factTypes: ["audit", "control"] },
      { key: "related_party", label: "关联交易", factTypes: ["related_party"] },
      { key: "capital_allocation", label: "股利、回购、融资、资本开支或并购", factTypes: ["capital_allocation"] },
      { key: "debt_maturity", label: "债务期限与再融资", factTypes: ["debt_maturity"] },
      { key: "share_count", label: "股本与股份变动", factTypes: ["share_count"] },
      { key: "dilution", label: "稀释工具或潜在稀释", factTypes: ["dilution"] },
    ];
    const factMissingFields = (item: Row) => [
      !text(item.documentUrl) ? "document_url" : null,
      !text(item.reportPeriod) ? "report_period" : null,
      !(text(item.statement) || text(item.reportedValue)) ? "statement" : null,
      !text(item.evidenceQuote) ? "evidence_quote" : null,
      !text(item.evidenceLocator) ? "evidence_locator" : null,
      !text(item.extractionMethod) ? "extraction_method" : null,
      finiteNumber(item.processedAt) === null ? "processed_at" : null,
    ].filter((value): value is string => Boolean(value));
    const categories = categoryDefinitions.map((definition) => {
      const categoryItems = items.filter((item) => definition.factTypes.includes(text(item.factType)));
      const missing = [...new Set(categoryItems.flatMap(factMissingFields))];
      const status = !categoryItems.length ? "missing" as const : missing.length ? "partial" as const : "available" as const;
      return {
        key: definition.key,
        label: definition.label,
        present: categoryItems.length > 0,
        status,
        missing,
        reason: status === "missing"
          ? "当前证券的已物化法定披露没有这一类别的事实；不从三表、新闻或其他类别推断。"
          : status === "partial"
            ? `当前候选事实缺少：${missing.join("、")}；不能作为完整治理或资本配置结论。`
            : "当前类别的原文、连续摘录、定位、报告期、加工方式和时间均已物化。",
      };
    });
    return { availability: items.length ? "available" as const : "empty" as const, items, categories, rule: "治理与资本配置仅展示带原文定位的披露事实；三表计算、债务期限、股本稀释分别缺失时不由彼此替代。" };
  } catch (error) {
    if (String(error).includes("no such table: research_auto_filing_fact_inputs")) return { availability: "unavailable" as const, items: [] as Row[], categories: [] as Array<{ key: string; label: string; present: boolean }>, rule: "治理与资本配置输入账本尚未初始化。" };
    throw error;
  }
}

/**
 * Presents explicit security-level evidence discovered in the current
 * security's official filings.  It is deliberately a candidate ledger: a
 * cross-listing, ADR ratio or rights relation is not persisted as a merged
 * issuer relationship until an automatic reconciliation job can corroborate
 * both securities with their own official records.
 */
export async function loadResearchAutoSecurityStructureCandidates(db: D1Database, securityCode: string) {
  const code = required(securityCode, "securityCode").toUpperCase();
  try {
    const rows = await db.prepare(`select filing_fact_input_id as inputId, statutory_document_id as documentId, document_url as documentUrl,
      fact_type as factType, fact_key as factKey, title, statement, reported_value as reportedValue, value_type as valueType,
      numeric_value as numericValue, unit, report_period as reportPeriod, subject_label as subjectLabel,
      related_security_code as relatedSecurityCode, security_relationship_kind as securityRelationshipKind,
      related_shares_per_security as relatedSharesPerSecurity, measurement_basis as measurementBasis,
      evidence_quote as evidenceQuote, evidence_locator as evidenceLocator, extraction_method as extractionMethod, processed_at as processedAt
      from research_auto_filing_fact_inputs where security_code=? and target_module='governance' and validity_status='current'
      and fact_type in ('share_count', 'dilution', 'security_rights', 'cross_security_link', 'adr_ratio')
      order by processed_at desc, title limit 100`).bind(code).all<Row>();
    const items = rows.results;
    const links = await db.prepare(`select related_security_code as relatedSecurityCode, relationship_kind as relationshipKind,
      relationship_status as relationshipStatus, rights_link_id as rightsLinkId, observed_at as observedAt
      from research_security_rights_links where security_code=? order by observed_at desc`).bind(code).all<Row>();
    const reconciledLinks = new Map(links.results.map((link) => [`${text(link.relatedSecurityCode)}|${text(link.relationshipKind)}`, link]));
    const crossSecurityCandidates = items.filter((item) => ["cross_security_link", "adr_ratio"].includes(text(item.factType))).map((item) => {
      const missing = [
        !text(item.relatedSecurityCode) ? "related_security_code" : null,
        !text(item.securityRelationshipKind) ? "security_relationship_kind" : null,
        text(item.factType) === "adr_ratio" && finitePositiveNumber(item.relatedSharesPerSecurity) === null ? "related_shares_per_security" : null,
      ].filter((value): value is string => Boolean(value));
      const link = reconciledLinks.get(`${text(item.relatedSecurityCode)}|${text(item.securityRelationshipKind)}`);
      return { ...item, status: missing.length ? "blocked" as const : link?.relationshipStatus === "confirmed" ? "confirmed" as const : "candidate" as const, missing, reconciledRightsLinkId: text(link?.rightsLinkId) || null, reconciledAt: finiteNumber(link?.observedAt) };
    });
    const shareInputs = items.filter((item) => ["share_count", "dilution"].includes(text(item.factType))).map((item) => {
      const missing = [
        finiteNumber(item.numericValue) === null ? "numeric_value" : null,
        !text(item.unit) ? "unit" : null,
        text(item.factType) === "share_count" && !text(item.measurementBasis) ? "measurement_basis" : null,
      ].filter((value): value is string => Boolean(value));
      return { ...item, status: missing.length ? "blocked" as const : "candidate" as const, missing };
    });
    return {
      availability: items.length ? "available" as const : "empty" as const,
      items,
      shareInputs,
      crossSecurityCandidates,
      rule: "只有法定原文明确出现另一证券的规范代码、关系类别以及（ADR 时）每份存托凭证对应基础证券数时，才形成跨证券候选。候选不会按名称、价格或代码模式自动合并公司，也不会解锁每股估值、ADR 换算或跨证券比较；后续自动任务必须同时取得相关证券自身的官方反向证据与当前权利记录。",
    };
  } catch (error) {
    if (/no such table|no such column/i.test(String(error))) return { availability: "unavailable" as const, items: [] as Row[], shareInputs: [] as Row[], crossSecurityCandidates: [] as Row[], rule: "证券结构来源输入账本尚未初始化。" };
    throw error;
  }
}

/**
 * Reconciles a cross-security relation without any approval queue.  It uses a
 * deliberately narrow rule: both already-bootstraped securities must have a
 * current, official-document extraction that names the other security and
 * declares the same relationship.  A one-sided mention, a missing rights
 * profile, or an unavailable related security remains a visible block.
 */
export async function reconcileResearchAutoSecurityStructure(db: D1Database, securityCode: string, now = Date.now()) {
  const code = required(securityCode, "securityCode").toUpperCase();
  try {
    const candidates = await db.prepare(`select filing_fact_input_id as inputId, statutory_document_id as documentId,
      document_url as documentUrl, fact_type as factType, title, statement, report_period as reportPeriod,
      related_security_code as relatedSecurityCode, security_relationship_kind as securityRelationshipKind,
      related_shares_per_security as relatedSharesPerSecurity, evidence_quote as evidenceQuote,
      evidence_locator as evidenceLocator, extraction_method as extractionMethod, processed_at as processedAt
      from research_auto_filing_fact_inputs where security_code=? and target_module='governance' and validity_status='current'
        and fact_type in ('cross_security_link', 'adr_ratio')
        and related_security_code is not null and security_relationship_kind is not null
      order by processed_at desc, filing_fact_input_id`).bind(code).all<Row>();
    const results: Array<Record<string, unknown>> = [];
    for (const candidate of candidates.results) {
      const relatedCode = validRelatedSecurityCode(candidate.relatedSecurityCode);
      const kind = enumOrNull(candidate.securityRelationshipKind, securityRelationshipKinds);
      const adrRatio = finitePositiveNumber(candidate.relatedSharesPerSecurity);
      if (!relatedCode || !kind || (text(candidate.factType) === "adr_ratio" && !adrRatio)) {
        results.push({ candidateInputId: text(candidate.inputId), relatedSecurityCode: relatedCode, status: "blocked", reason: "candidate_fields_incomplete" });
        continue;
      }
      const [sourceSecurity, relatedSecurity, sourceRights, relatedRights, reciprocal, existingLink] = await Promise.all([
        db.prepare(`select company_id as companyId, mapping_status as mappingStatus from research_listed_securities where security_code=?`).bind(code).first<{ companyId: string | null; mappingStatus: string }>(),
        db.prepare(`select company_id as companyId, mapping_status as mappingStatus from research_listed_securities where security_code=?`).bind(relatedCode).first<{ companyId: string | null; mappingStatus: string }>(),
        db.prepare(`select rights_profile_id as rightsProfileId from research_security_rights_profiles where security_code=? order by observed_at desc limit 1`).bind(code).first<{ rightsProfileId: string }>(),
        db.prepare(`select rights_profile_id as rightsProfileId from research_security_rights_profiles where security_code=? order by observed_at desc limit 1`).bind(relatedCode).first<{ rightsProfileId: string }>(),
        db.prepare(`select filing_fact_input_id as inputId, document_url as documentUrl, title, statement,
          related_shares_per_security as relatedSharesPerSecurity, evidence_quote as evidenceQuote, evidence_locator as evidenceLocator
          from research_auto_filing_fact_inputs where security_code=? and target_module='governance' and validity_status='current'
            and related_security_code=? and security_relationship_kind=? and fact_type in ('cross_security_link', 'adr_ratio')
          order by processed_at desc limit 1`).bind(relatedCode, code, kind).first<Row>(),
        db.prepare(`select rights_link_id as rightsLinkId, relationship_status as relationshipStatus
          from research_security_rights_links where security_code=? and related_security_code=? and relationship_kind=?
          order by observed_at desc limit 1`).bind(code, relatedCode, kind).first<{ rightsLinkId: string; relationshipStatus: string }>(),
      ]);
      const blocked = !sourceSecurity ? "source_security_not_bootstrapped"
        : !relatedSecurity ? "related_security_not_bootstrapped"
          : !sourceSecurity.companyId ? "source_operating_company_missing"
            : !sourceRights ? "source_rights_profile_missing"
              : !relatedRights ? "related_rights_profile_missing"
                : !reciprocal ? "reciprocal_official_candidate_missing"
                  : null;
      if (blocked) {
        results.push({ candidateInputId: text(candidate.inputId), relatedSecurityCode: relatedCode, status: "blocked", reason: blocked });
        continue;
      }
      if (existingLink?.relationshipStatus === "confirmed") {
        results.push({ candidateInputId: text(candidate.inputId), relatedSecurityCode: relatedCode, status: "confirmed", relationshipKind: kind, rightsLinkId: existingLink.rightsLinkId, existing: true });
        continue;
      }
      const relationshipType = kind === "same_operating_company_different_security" ? "secondary_listing" as const
        : kind === "adr_underlying_security" ? "depositary_receipt" as const : "other_equity_claim" as const;
      const note = `自动协调规则：两只已入库证券的当前官方法定披露分别明确指向对方，关系为 ${kind}；来源连续摘录定位为 ${text(candidate.evidenceLocator)}。`;
      // First confirm the current security against its own official evidence;
      // then attach the other security to that same issuer under the precise
      // cross-security relationship. Existing provisional rows remain history.
      await upsertCompanySecurityRelationship(db, {
        relationshipId: `auto-reconciled-primary:${code}:${text(candidate.inputId)}`,
        companyId: sourceSecurity!.companyId!, securityCode: code, relationshipType: "primary_listing", relationshipStatus: "confirmed",
        sourceUrl: text(candidate.documentUrl), sourceNote: note,
        metadata: { automatic: true, reconciliationVersion: "research-security-reconciliation.v1", reciprocalInputId: text(reciprocal!.inputId), evidenceQuote: text(candidate.evidenceQuote) }, now,
      });
      await upsertCompanySecurityRelationship(db, {
        relationshipId: `auto-reconciled-related:${code}:${relatedCode}:${text(candidate.inputId)}`,
        companyId: sourceSecurity!.companyId!, securityCode: relatedCode, relationshipType, relationshipStatus: "confirmed",
        sourceUrl: text(candidate.documentUrl), sourceNote: note,
        metadata: { automatic: true, reconciliationVersion: "research-security-reconciliation.v1", sourceSecurityCode: code, reciprocalInputId: text(reciprocal!.inputId), evidenceQuote: text(reciprocal!.evidenceQuote) }, now,
      });
      await insertSecurityRightsLink(db, {
        rightsLinkId: `auto-security-rights-link:${code}:${relatedCode}:${text(candidate.inputId)}`,
        securityCode: code, relatedSecurityCode: relatedCode, relationshipKind: kind as "same_operating_company_different_security" | "adr_underlying_security" | "other_security_right", relationshipStatus: "confirmed",
        relatedSharesPerSecurity: kind === "adr_underlying_security" ? adrRatio : null,
        conversionAvailability: kind === "adr_underlying_security" ? "available" : "not_applicable",
        relationshipNote: note, evidenceKind: "issuer_official_disclosure", sourceUrl: text(candidate.documentUrl),
        sourceTitle: text(candidate.title) || "发行人官方法定披露", sourceNote: note, observedAt: now,
        metadata: { automatic: true, reconciliationVersion: "research-security-reconciliation.v1", reciprocalInputId: text(reciprocal!.inputId), sourceDocumentId: text(candidate.documentId) }, now,
      });
      results.push({ candidateInputId: text(candidate.inputId), relatedSecurityCode: relatedCode, status: "confirmed", relationshipKind: kind, reciprocalInputId: text(reciprocal!.inputId) });
    }
    return { availability: candidates.results.length ? "available" as const : "empty" as const, results, ruleVersion: "research-security-reconciliation.v1" };
  } catch (error) {
    if (/no such table|no such column/i.test(String(error))) return { availability: "unavailable" as const, results: [] as Row[], ruleVersion: "research-security-reconciliation.v1", reason: "storage_not_initialized" };
    throw error;
  }
}

/**
 * Converts only a deliberately machine-readable management-guidance fact into
 * a source-bound forecast record.  The extractor must carry every semantic
 * component in `factKey`; prose, ranges, unlabeled figures and incomplete
 * bases remain visible in the input gate but are never guessed into a forecast.
 */
export async function syncResearchAutoManagementGuidance(db: D1Database, securityCode: string, createdAt = Date.now()) {
  const code = required(securityCode, "securityCode").toUpperCase();
  try {
    const rows = await db.prepare(`select input.filing_fact_input_id as inputId, input.operating_company_id as companyId,
        input.statutory_document_id as documentId, input.document_url as documentUrl, input.title, input.statement,
        input.fact_type as factType, input.fact_key as factKey, input.value_type as valueType, input.report_period as reportPeriod,
        input.period_kind as periodKind, input.numeric_value as numericValue, input.currency, input.amount_scale as amountScale,
        input.evidence_locator as evidenceLocator, input.processed_at as processedAt, document.published_at as publishedAt,
        document.title as documentTitle
      from research_auto_filing_fact_inputs input
      left join research_statutory_disclosure_documents document
        on document.security_code=input.security_code and document.document_id=input.statutory_document_id
      where input.security_code=? and input.target_module='forecast' and input.validity_status='current'
      order by input.processed_at desc, input.filing_fact_input_id`).bind(code).all<Row>();
    const accepted: string[] = [];
    const blocked: Array<{ inputId: string; reason: string }> = [];
    for (const row of rows.results) {
      const parsed = parseAutomaticGuidanceContract(row);
      if (!parsed) {
        blocked.push({ inputId: text(row.inputId), reason: automaticGuidanceBlockReason(row) });
        continue;
      }
      const forecastId = `management-guidance:auto:${text(row.inputId)}`;
      const existing = await db.prepare(`select guidance_forecast_id as forecastId from research_management_guidance_forecasts where guidance_forecast_id=?`)
        .bind(forecastId).first<{ forecastId: string }>();
      if (existing) continue;
      await recordManagementGuidanceForecast(db, {
        guidanceForecastId: forecastId,
        securityCode: code,
        companyId: nullable(row.companyId),
        guidanceDate: text(row.publishedAt).slice(0, 10),
        metric: parsed.metric,
        fiscalYear: parsed.fiscalYear,
        fiscalPeriod: parsed.fiscalPeriod,
        rawValue: Number(row.numericValue),
        rawUnit: parsed.rawUnit,
        currency: text(row.currency),
        accountingBasis: parsed.accountingBasis,
        ownershipBasis: parsed.ownershipBasis,
        shareBasis: parsed.shareBasis,
        guidanceConditions: text(row.statement),
        sourceStatement: `法定披露管理层正式指引；自动规则 ${AUTOMATIC_GUIDANCE_RULE_VERSION} 仅接受完整 factKey 契约：${text(row.factKey)}。`,
        sourceReferences: [{ sourceKind: "filing", url: text(row.documentUrl), title: text(row.documentTitle) || text(row.title), locator: text(row.evidenceLocator) }],
        supersedesGuidanceForecastId: null,
      }, createdAt);
      accepted.push(forecastId);
    }
    return { ruleVersion: AUTOMATIC_GUIDANCE_RULE_VERSION, accepted, blocked };
  } catch (error) {
    if (/no such table|no such column/i.test(String(error))) return { ruleVersion: AUTOMATIC_GUIDANCE_RULE_VERSION, accepted: [] as string[], blocked: [] as Array<{ inputId: string; reason: string }>, availability: "storage_not_initialized" as const };
    throw error;
  }
}

const AUTOMATIC_GUIDANCE_RULE_VERSION = "research-auto-guidance.v1";

function parseAutomaticGuidanceContract(row: Row): {
  metric: "revenue" | "net_profit" | "operating_cash_flow";
  fiscalYear: number;
  fiscalPeriod: string;
  rawUnit: "currency" | "ten_thousand_currency" | "million_currency" | "hundred_million_currency" | "billion_currency";
  accountingBasis: "gaap" | "non_gaap" | "adjusted";
  ownershipBasis: "attributable_to_parent" | "consolidated" | "common_shareholders" | "unspecified";
  shareBasis: "basic" | "diluted" | "unspecified";
} | null {
  if (text(row.factType) !== "management_guidance" || text(row.periodKind) !== "future_guidance" || text(row.valueType) !== "amount") return null;
  if (!Number.isFinite(Number(row.numericValue)) || !text(row.currency) || !text(row.documentUrl) || !text(row.evidenceLocator) || !text(row.publishedAt)) return null;
  const match = /^guidance_(revenue|net_profit|operating_cash_flow)__(\d{4}(?:FY|Q[1-4]))__(gaap|non_gaap|adjusted)__(attributable_to_parent|consolidated|common_shareholders|unspecified)__(basic|diluted|unspecified)$/.exec(text(row.factKey));
  if (!match) return null;
  const rawUnit = text(row.amountScale);
  if (!(["currency", "ten_thousand_currency", "million_currency", "hundred_million_currency", "billion_currency"] as const).includes(rawUnit as never)) return null;
  const [, metric, fiscalPeriod, accountingBasis, ownershipBasis, shareBasis] = match;
  if (metric === "net_profit" && ownershipBasis === "unspecified") return null;
  return { metric: metric as "revenue" | "net_profit" | "operating_cash_flow", fiscalYear: Number(fiscalPeriod.slice(0, 4)), fiscalPeriod,
    rawUnit: rawUnit as "currency" | "ten_thousand_currency" | "million_currency" | "hundred_million_currency" | "billion_currency",
    accountingBasis: accountingBasis as "gaap" | "non_gaap" | "adjusted", ownershipBasis: ownershipBasis as "attributable_to_parent" | "consolidated" | "common_shareholders" | "unspecified",
    shareBasis: shareBasis as "basic" | "diluted" | "unspecified" };
}

function automaticGuidanceBlockReason(row: Row): string {
  if (text(row.factType) !== "management_guidance") return "not_management_guidance";
  if (text(row.periodKind) !== "future_guidance") return "not_future_guidance";
  if (text(row.valueType) !== "amount" || !Number.isFinite(Number(row.numericValue))) return "numeric_amount_not_extracted";
  if (!text(row.currency) || !text(row.amountScale)) return "currency_or_amount_scale_missing";
  if (!/^guidance_/.test(text(row.factKey))) return "machine_readable_guidance_fact_key_missing";
  return "guidance_semantic_contract_incomplete";
}

/**
 * Persists only scenarios that the issuer itself labels as downside/base/
 * upside and whose individual outputs carry the same strict measurement
 * contract as an automatic management-guidance record. This does not invent
 * a downside case from a point estimate, assign probabilities, or run a DCF.
 */
export async function syncResearchAutoForecastScenarios(db: D1Database, securityCode: string, createdAt = Date.now()) {
  const code = required(securityCode, "securityCode").toUpperCase();
  try {
    const rows = await db.prepare(`select input.filing_fact_input_id as inputId, input.statutory_document_id as documentId,
        input.document_url as documentUrl, input.title, input.statement, input.fact_type as factType, input.fact_key as factKey,
        input.value_type as valueType, input.period_kind as periodKind, input.numeric_value as numericValue, input.currency,
        input.amount_scale as amountScale, input.evidence_locator as evidenceLocator, document.published_at as publishedAt,
        document.title as documentTitle
      from research_auto_filing_fact_inputs input
      left join research_statutory_disclosure_documents document
        on document.security_code=input.security_code and document.document_id=input.statutory_document_id
      where input.security_code=? and input.target_module='forecast' and input.validity_status='current'
      order by input.processed_at desc, input.filing_fact_input_id`).bind(code).all<Row>();
    const parsed = rows.results.flatMap((row) => {
      const item = parseAutomaticScenarioContract(row);
      return item ? [{ ...item, row }] : [];
    });
    const groups = new Map<string, typeof parsed>();
    for (const item of parsed) {
      const key = `${item.scenarioName}\u0000${item.fiscalPeriod}`;
      const group = groups.get(key) ?? [];
      group.push(item); groups.set(key, group);
    }
    const saved: Array<{ scenarioId: string; scenarioName: string; version: number; fiscalPeriod: string }> = [];
    const blocked: Array<{ scenarioName: string; fiscalPeriod: string; reason: string }> = [];
    for (const [key, group] of groups) {
      const [scenarioName, fiscalPeriod] = key.split("\u0000");
      const currencies = new Set(group.map((item) => text(item.row.currency)));
      const units = new Set(group.map((item) => text(item.row.amountScale)));
      if (currencies.size !== 1 || units.size !== 1) {
        blocked.push({ scenarioName, fiscalPeriod, reason: "scenario_output_currency_or_unit_conflict" });
        continue;
      }
      const inputIds = group.map((item) => text(item.row.inputId)).sort();
      const sourceSignature = await sha256Hex(`${AUTOMATIC_FORECAST_SCENARIO_RULE_VERSION}|${code}|${scenarioName}|${fiscalPeriod}|${inputIds.join("|")}`);
      const existing = await db.prepare(`select scenario_id as scenarioId from research_forecast_scenarios
        where security_code=? and scenario_name=? and evidence_refs_json like ? limit 1`)
        .bind(code, scenarioName, `%\"sourceSignature\":\"${sourceSignature}\"%`).first<{ scenarioId: string }>();
      if (existing) continue;
      const evidenceRefs: unknown[] = group.map((item) => ({
        sourceKind: "filing", title: text(item.row.documentTitle) || text(item.row.title), url: text(item.row.documentUrl),
        locator: text(item.row.evidenceLocator), publishedAt: text(item.row.publishedAt), documentId: text(item.row.documentId), inputId: text(item.row.inputId),
      }));
      evidenceRefs.push({ sourceSignature, processing: `工程按 ${AUTOMATIC_FORECAST_SCENARIO_RULE_VERSION} 将发行人原文明确标记的 ${scenarioName} 情景输出保存为不可变版本；不设置概率、不补充缺失变量、不生成估值。` });
      const outputs = group.map((item) => ({ metric: item.metric, fiscalPeriod: item.fiscalPeriod, value: Number(item.row.numericValue), unit: text(item.row.amountScale), currency: text(item.row.currency), accountingBasis: item.accountingBasis, ownershipBasis: item.ownershipBasis, shareBasis: item.shareBasis, sourceInputId: text(item.row.inputId) }));
      const result = await saveForecastScenario(db, code, { scenarioName: scenarioName as "downside" | "base" | "upside", assumptions: [], outputs, evidenceRefs, status: "draft" });
      saved.push({ ...result, scenarioName, fiscalPeriod });
    }
    return { ruleVersion: AUTOMATIC_FORECAST_SCENARIO_RULE_VERSION, saved, blocked };
  } catch (error) {
    if (/no such table|no such column/i.test(String(error))) return { ruleVersion: AUTOMATIC_FORECAST_SCENARIO_RULE_VERSION, saved: [] as Array<{ scenarioId: string; scenarioName: string; version: number; fiscalPeriod: string }>, blocked: [] as Array<{ scenarioName: string; fiscalPeriod: string; reason: string }>, availability: "storage_not_initialized" as const };
    throw error;
  }
}

const AUTOMATIC_FORECAST_SCENARIO_RULE_VERSION = "research-auto-forecast-scenario.v1";

function parseAutomaticScenarioContract(row: Row): {
  scenarioName: "downside" | "base" | "upside";
  metric: "revenue" | "net_profit" | "operating_cash_flow";
  fiscalPeriod: string;
  accountingBasis: "gaap" | "non_gaap" | "adjusted";
  ownershipBasis: "attributable_to_parent" | "consolidated" | "common_shareholders" | "unspecified";
  shareBasis: "basic" | "diluted" | "unspecified";
} | null {
  if (text(row.factType) !== "management_guidance" || text(row.periodKind) !== "future_guidance" || text(row.valueType) !== "amount") return null;
  if (!Number.isFinite(Number(row.numericValue)) || !text(row.currency) || !text(row.amountScale) || !text(row.documentUrl) || !text(row.evidenceLocator) || !text(row.publishedAt)) return null;
  const match = /^scenario_(downside|base|upside)__(revenue|net_profit|operating_cash_flow)__(\d{4}(?:FY|Q[1-4]))__(gaap|non_gaap|adjusted)__(attributable_to_parent|consolidated|common_shareholders|unspecified)__(basic|diluted|unspecified)$/.exec(text(row.factKey));
  if (!match) return null;
  const [, scenarioName, metric, fiscalPeriod, accountingBasis, ownershipBasis, shareBasis] = match;
  if (metric === "net_profit" && ownershipBasis === "unspecified") return null;
  if (!( ["currency", "ten_thousand_currency", "million_currency", "hundred_million_currency", "billion_currency"] as const).includes(text(row.amountScale) as never)) return null;
  return { scenarioName: scenarioName as "downside" | "base" | "upside", metric: metric as "revenue" | "net_profit" | "operating_cash_flow", fiscalPeriod,
    accountingBasis: accountingBasis as "gaap" | "non_gaap" | "adjusted", ownershipBasis: ownershipBasis as "attributable_to_parent" | "consolidated" | "common_shareholders" | "unspecified", shareBasis: shareBasis as "basic" | "diluted" | "unspecified" };
}

/** Normalizes only company-published guidance that already has a statutory
 * source.  It deliberately does not turn report snippets into consensus, nor
 * derive a target price from a guidance statement. */
export async function loadResearchAutoForecastInputGate(db: D1Database, securityCode: string) {
  const code = required(securityCode, "securityCode").toUpperCase();
  try {
    const rows = await db.prepare(`select input.filing_fact_input_id as inputId, input.statutory_document_id as documentId, input.document_url as documentUrl,
      fact_type as factType, fact_key as factKey, title, statement, reported_value as reportedValue, value_type as valueType,
      report_period as reportPeriod, subject_label as subjectLabel, period_kind as periodKind, numeric_value as numericValue,
      currency, amount_scale as amountScale, unit, evidence_quote as evidenceQuote, evidence_locator as evidenceLocator,
      extraction_method as extractionMethod, prompt_version as promptVersion, processed_at as processedAt,
      exists(select 1 from research_management_guidance_forecasts guidance
        where guidance.guidance_forecast_id='management-guidance:auto:' || input.filing_fact_input_id) as guidanceRecorded
      , exists(select 1 from research_forecast_scenarios scenario
        where scenario.security_code=input.security_code and scenario.evidence_refs_json like '%\"inputId\":\"' || input.filing_fact_input_id || '\"%') as scenarioRecorded
      from research_auto_filing_fact_inputs input where security_code=? and target_module='forecast' and validity_status='current'
      order by processed_at desc, title limit 100`).bind(code).all<Row>();
    const items = rows.results.map((item) => {
      const scenarioFact = /^scenario_(downside|base|upside)__/.test(text(item.factKey));
      const guidanceFact = /^guidance_/.test(text(item.factKey));
      const missing = [
        !text(item.reportPeriod) ? "forecast_period" : null,
        !text(item.periodKind) || text(item.periodKind) !== "future_guidance" ? "guidance_period_kind" : null,
        text(item.valueType) === "amount" && (!text(item.currency) || !text(item.amountScale)) ? "currency_or_scale" : null,
        !text(item.subjectLabel) ? "forecast_subject" : null,
        text(item.valueType) === "amount" && !guidanceFact && !scenarioFact ? "machine_readable_guidance_contract" : null,
      ].filter((value): value is string => Boolean(value));
      return { ...item, inclusionStatus: Number(item.scenarioRecorded) ? "recorded_as_source_scenario" as const : Number(item.guidanceRecorded) ? "recorded_as_company_guidance" as const : missing.length ? "blocked" as const : scenarioFact ? "eligible_as_source_scenario" as const : "eligible_as_company_guidance" as const, missing };
    });
    return {
      availability: items.length ? "available" as const : "empty" as const,
      items,
      rule: "公司正式指引只有在主体、预测期间、数值单位/币种（金额项）和机器可读 factKey 契约齐全时，才自动写入来源绑定管理层指引账本；发行人原文明确命名的上行/基准/下行情景会另存为来源情景版本。两者都不是独立第三方预测，也不能直接生成目标价或一致预期。",
    };
  } catch (error) {
    if (String(error).includes("no such table: research_auto_filing_fact_inputs")) return { availability: "unavailable" as const, items: [] as Row[], rule: "预测输入账本尚未初始化。" };
    throw error;
  }
}

async function filingContent(db: D1Database, sourceUrl: string): Promise<string> {
  const ref = await db.prepare(`select content.content_key as contentKey from knowledge_docs doc
      join knowledge_doc_content_refs content on content.doc_id=doc.doc_id where doc.url=? order by doc.updated_at desc limit 1`).bind(sourceUrl).first<{ contentKey: string }>();
  if (!ref?.contentKey) return "";
  const chunks = await db.prepare("select payload_base64 as payloadBase64 from knowledge_local_content_cache_chunks where content_key=? order by chunk_index")
    .bind(ref.contentKey).all<{ payloadBase64: string }>();
  if (!chunks.results.length) return "";
  const raw = atob(chunks.results.map((row) => row.payloadBase64).join(""));
  return new TextDecoder().decode(Uint8Array.from(raw, (value) => value.charCodeAt(0))).slice(0, 1_800_000);
}

function parse(raw: string): Extracted[] {
  let value: unknown;
  try { value = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, "")); } catch { throw new Error("filing insight model response was not JSON"); }
  const items: unknown[] = value && typeof value === "object" && Array.isArray((value as Row).items) ? (value as Row).items as unknown[] : [];
  const candidates = items.flatMap((rawItem) => {
    if (!rawItem || typeof rawItem !== "object") return [];
    const item = rawItem as Row; const tabId = text(item.tabId) as TabId;
    if (!tabs.has(tabId)) return [];
    const factKey = text(item.factKey).replace(/[^a-z0-9_-]/gi, "_").slice(0, 80);
    const title = text(item.title); const statement = text(item.statement); const evidenceQuote = text(item.evidenceQuote); const evidenceLocator = text(item.evidenceLocator);
    const suppliedFactType = text(item.factType);
    const factType = config.factTypes[tabId].includes(suppliedFactType) ? suppliedFactType : config.factTypes[tabId][0];
    const suppliedValueType = text(item.valueType);
    const valueType = valueTypes.has(suppliedValueType) ? suppliedValueType : nullable(item.reportedValue) ? "qualitative" : "unavailable";
    if (!factKey || !title || !statement || !evidenceQuote || !evidenceLocator || statement.length > 600 || evidenceQuote.length > 900) return [];
    return [{ tabId, factType, factKey, title, statement, reportedValue: nullable(item.reportedValue), valueType, unit: nullable(item.unit), reportPeriod: nullable(item.reportPeriod), evidenceQuote, evidenceLocator, ...structure(item) }];
  });
  // The remote model is instructed to cover different fact types.  Enforce
  // that intent before filling any remaining configured capacity with another
  // item of the same type, so a long list of segments cannot silently crowd
  // out contracts, capital allocation, counterevidence or risk triggers.
  const selected: Extracted[] = [];
  const usedByTab = new Map<TabId, number>();
  const seenFactTypes = new Set<string>();
  const canSelect = (item: Extracted) => (usedByTab.get(item.tabId) ?? 0) < (config.maxItemsPerTab?.[item.tabId] ?? 3);
  const select = (item: Extracted) => { selected.push(item); usedByTab.set(item.tabId, (usedByTab.get(item.tabId) ?? 0) + 1); };
  for (const item of candidates) {
    const typeKey = `${item.tabId}:${item.factType}`;
    if (!seenFactTypes.has(typeKey) && canSelect(item)) { select(item); seenFactTypes.add(typeKey); }
  }
  for (const item of candidates) {
    if (!selected.includes(item) && canSelect(item)) select(item);
  }
  return selected;
}

function filingRow(row: Row): Filing { const registry = text(row.registry) as Registry; if (!(registry === "cninfo" || registry === "hkex" || registry === "sec")) throw new Error("stored statutory registry is invalid"); return { registry, documentId: text(row.documentId), title: text(row.title), publishedAt: text(row.publishedAt), documentUrl: text(row.documentUrl), documentType: nullable(row.documentType), sourceLocator: text(row.sourceLocator) }; }
function render(template: string, values: Record<string, string>) { return Object.entries(values).reduce((result, [key, value]) => result.replaceAll(`{{${key}}}`, value), template); }
function required(value: unknown, label: string) { const result = text(value); if (!result) throw new Error(`${label} is required`); return result; }
async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join("");
}
function jsonArray(value: unknown): Row[] { try { const parsed = typeof value === "string" ? JSON.parse(value || "[]") : value; return Array.isArray(parsed) ? parsed.filter((item): item is Row => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : []; } catch { return []; } }
function jsonStringArray(value: unknown): string[] { try { const parsed = typeof value === "string" ? JSON.parse(value || "[]") : value; return Array.isArray(parsed) ? parsed.map((item) => text(item)).filter(Boolean) : []; } catch { return []; } }
function riskSnapshotKey(item: Row): string { return `${text(item.documentId)}|${text(item.factKey)}|${text(item.factType)}|${text(item.statement)}`; }
function text(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}
function number(value: unknown, fallback: number) { const result = Number(value); return Number.isFinite(result) ? result : fallback; }
function targetModule(tabId: TabId): TargetModule {
  if (tabId === "business") return "operating";
  if (tabId === "financial") return "governance";
  return tabId;
}
function classifyDocumentKind(source: Filing): DocumentKind {
  const label = `${source.title} ${source.documentType || ""}`.toLowerCase();
  if (/(?:年度报告|annual report|\b10-k\b|\b20-f\b)/i.test(label) && !/(?:摘要|summary)/i.test(label)) return "annual";
  if (/(?:季度报告|季度报|半年度报告|interim|\b10-q\b|\b6-k\b)/i.test(label) && !/(?:摘要|summary|提示性公告|预约披露)/i.test(label)) return "interim";
  if (/(?:风险|诉讼|监管|回购|分红|融资|发行|收购|重组|公告|press release|8-k)/i.test(label)) return "event";
  return "other";
}
function defaultFactType(tabId: TabId) { return config.factTypes[tabId][0]; }
function validValueType(value: unknown) { const supplied = text(value); return valueTypes.has(supplied) ? supplied : "unavailable"; }
function structure(item: Row): ExtractedStructure {
  const relatedSecurityCode = validRelatedSecurityCode(item.relatedSecurityCode);
  const securityRelationshipKind = enumOrNull(item.securityRelationshipKind, securityRelationshipKinds);
  const relatedSharesPerSecurity = finitePositiveNumber(item.relatedSharesPerSecurity);
  return {
    subjectLabel: nullable(item.subjectLabel), segmentLabel: nullable(item.segmentLabel), geographyLabel: nullable(item.geographyLabel), customerOrChannel: nullable(item.customerOrChannel),
    driverKey: enumOrNull(item.driverKey, driverKeys), exposureKey: enumOrNull(item.exposureKey, exposureKeys), causalDirection: enumOrNull(item.causalDirection, causalDirections),
    periodKind: enumOrNull(item.periodKind, periodKinds), numericValue: finiteNumber(item.numericValue), currency: nullable(item.currency), amountScale: nullable(item.amountScale),
    relatedSecurityCode, securityRelationshipKind, relatedSharesPerSecurity, measurementBasis: enumOrNull(item.measurementBasis, measurementBases),
  };
}
function validRelatedSecurityCode(value: unknown) { const code = normalizeSecurityCode(text(value)); return code && isSupportedCompanyCode(code) ? code : null; }
function financialEntityProfileFactKey(value: unknown): string | null {
  const match = /^financial_entity_profile__(non_financial|bank|insurer|broker|financial_other)$/.exec(text(value));
  return match && financialEntityTypes.has(match[1]) ? match[1] : null;
}
function financialSpecialtyFactKey(value: unknown): { entityType: "bank" | "insurer" | "broker"; metricKey: string } | null {
  const match = /^financial_specialty__(bank|insurer|broker)__([a-z0-9_]+)$/.exec(text(value));
  return match && financialSpecialtyEntityTypes.has(match[1]) && match[2] ? { entityType: match[1] as "bank" | "insurer" | "broker", metricKey: match[2] } : null;
}
function dateOnly(value: string): boolean { return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)); }
function validResearchPeriod(value: string): boolean { return dateOnly(value) || /^\d{4}(FY|Q[1-4])$/.test(value); }
function researchMarketForCode(value: string): "a_share" | "h_share" | "us_share" | null {
  const code = normalizeSecurityCode(value);
  if (/^\d{6}\.(SH|SZ|BJ)$/.test(code)) return "a_share";
  if (/^\d{5}\.HK$/.test(code)) return "h_share";
  if (/^[A-Z0-9.-]+\.US$/.test(code)) return "us_share";
  return null;
}
function enumOrNull(value: unknown, allowed: Set<string>) { const supplied = text(value); return allowed.has(supplied) ? supplied : null; }
function finiteNumber(value: unknown) { const result = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN; return Number.isFinite(result) ? result : null; }
function finitePositiveNumber(value: unknown) { const result = finiteNumber(value); return result !== null && result > 0 ? result : null; }
// `reportedValue` is presentation metadata, not a JSON blob.  Rejecting a
// model-emitted object is safer than rendering "[object Object]" as a fact.
function nullable(value: unknown) { const result = text(value); return result || null; }
