import {
  assertAsOf,
  assertSourceReferences,
  availableSection,
  epistemicTypeForCatalystStatus,
  epistemicTypeFromSourceType,
  unavailableResearchDossier,
  unavailableSection,
  type ResearchAnalysisSnapshot,
  type ResearchBusinessModel,
  type ResearchBusinessSegment,
  type ResearchCatalyst,
  type ResearchCompetitiveMarket,
  type ResearchCompetitor,
  type ResearchDossier,
  type ResearchDossierSection,
  type ResearchListedSecurityIdentity,
  type ResearchMarketSpaceModel,
  type ResearchOperatingCompanyIdentity,
  type ResearchRiskEntry,
  type ResearchSourceReference,
  type ResearchThesis,
  type ResearchThesisEvidence,
  type ResearchTypedValue,
  type ResearchUserNote,
  type ResearchValuationCase,
} from "../domain/research-dossier";
import { loadResearchCatalystReviews } from "./research-catalyst-review";

export type ResearchDossierQuery = {
  securityCode: string;
  asOf?: number;
  ownerKey?: string;
};

export type ResearchDossierWriteResult = {
  state: "saved" | "unavailable";
  recordId: string;
  reason: "storage_not_initialized" | null;
};

type Row = Record<string, unknown>;

export async function loadResearchDossier(db: D1Database, query: ResearchDossierQuery): Promise<ResearchDossier> {
  const securityCode = query.securityCode.trim().toUpperCase();
  if (!securityCode) throw new Error("research dossier securityCode is required");
  const asOf = query.asOf ?? Date.now();
  assertAsOf(asOf);

  let identity: { operatingCompany: ResearchOperatingCompanyIdentity | null; listedSecurity: ResearchListedSecurityIdentity } | null;
  try {
    identity = await loadIdentity(db, securityCode);
  } catch (error) {
    if (isMissingTableError(error)) return unavailableResearchDossier(securityCode, asOf, "storage_not_initialized");
    throw error;
  }
  if (!identity) return unavailableResearchDossier(securityCode, asOf, "identity_not_found");

  const companyId = identity.listedSecurity.companyId;
  const companyUnavailable = <T>() => unavailableSection<T>("identity_not_found");
  const [businessModels, marketSpaceModels, competitiveMarkets, theses, valuationCases, risks, catalysts, snapshots] = await Promise.all([
    companyId ? loadSection(() => loadBusinessModels(db, companyId, asOf)) : Promise.resolve(companyUnavailable<ResearchBusinessModel>()),
    companyId ? loadSection(() => loadMarketSpaceModels(db, companyId, asOf)) : Promise.resolve(companyUnavailable<ResearchMarketSpaceModel>()),
    companyId ? loadSection(() => loadCompetitiveMarkets(db, companyId, asOf)) : Promise.resolve(companyUnavailable<ResearchCompetitiveMarket>()),
    companyId ? loadSection(() => loadTheses(db, companyId, asOf)) : Promise.resolve(companyUnavailable<ResearchThesis>()),
    loadSection(() => loadValuationCases(db, securityCode, companyId, asOf)),
    loadSection(() => loadRisks(db, securityCode, companyId, asOf)),
    loadSection(() => loadCatalysts(db, securityCode, companyId, asOf)),
    loadSection(() => loadSnapshots(db, securityCode, companyId, asOf)),
  ]);
  const ownerKey = query.ownerKey?.trim() ?? "";
  const userNotes = ownerKey
    ? await loadSection(() => loadUserNotes(db, securityCode, companyId, ownerKey, asOf))
    : unavailableSection<ResearchUserNote>("owner_required");

  return {
    securityCode,
    companyId,
    asOf,
    availability: "available",
    unavailableReason: null,
    operatingCompany: identity.operatingCompany,
    listedSecurity: identity.listedSecurity,
    businessModels,
    marketSpaceModels,
    competitiveMarkets,
    theses,
    valuationCases,
    risks,
    catalysts,
    snapshots,
    userNotes,
  };
}

export async function insertResearchBusinessModel(db: D1Database, input: ResearchBusinessModel): Promise<ResearchDossierWriteResult> {
  assertAsOf(input.asOf);
  assertSourceReferences(input.epistemicType, input.sourceReferences);
  const statements = [db.prepare(`insert into research_business_models (
    business_model_id, company_id, as_of, status, primary_earning_driver, revenue_recognition,
    summary, source_type, source_refs_json, created_at, updated_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    input.businessModelId, input.companyId, input.asOf, input.status, input.primaryEarningDriver,
    input.revenueRecognition, input.summary, sourceTypeForEpistemic(input.epistemicType),
    JSON.stringify(input.sourceReferences), input.createdAt, input.updatedAt,
  )];
  for (const segment of input.segments) {
    statements.push(db.prepare(`insert into research_business_segments (
      segment_id, business_model_id, name, revenue_driver, customer_scope, geographic_scope,
      pricing_model, cost_driver, working_capital_driver, capital_intensity_driver, source_refs_json, sort_order
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      segment.segmentId, input.businessModelId, segment.name, segment.revenueDriver, segment.customerScope,
      segment.geographicScope, segment.pricingModel, segment.costDriver, segment.workingCapitalDriver,
      segment.capitalIntensityDriver, JSON.stringify(segment.sourceReferences), segment.sortOrder,
    ));
  }
  return runInsert(db, "research_business_models", input.businessModelId, statements);
}

export async function insertResearchMarketSpaceModel(db: D1Database, input: ResearchMarketSpaceModel): Promise<ResearchDossierWriteResult> {
  assertAsOf(input.asOf);
  assertSourceReferences(input.epistemicType, input.sourceReferences);
  return runInsert(db, "research_market_space_models", input.marketSpaceId, [db.prepare(`insert into research_market_space_models (
    market_space_id, company_id, as_of, status, market_definition, tam_json, sam_json, som_json,
    profit_pool_json, top_down_json, bottom_up_json, transmission_json, source_type, source_refs_json,
    created_at, updated_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    input.marketSpaceId, input.companyId, input.asOf, input.status, input.marketDefinition,
    JSON.stringify(input.tam), JSON.stringify(input.sam), JSON.stringify(input.som), JSON.stringify(input.profitPool),
    JSON.stringify(input.topDown), JSON.stringify(input.bottomUp), JSON.stringify(input.transmission),
    sourceTypeForEpistemic(input.epistemicType), JSON.stringify(input.sourceReferences), input.createdAt, input.updatedAt,
  )]);
}

export async function insertResearchCompetitiveMarket(db: D1Database, input: ResearchCompetitiveMarket): Promise<ResearchDossierWriteResult> {
  assertAsOf(input.asOf);
  assertSourceReferences(input.epistemicType, input.sourceReferences);
  const statements = [db.prepare(`insert into research_competitive_markets (
    competitive_market_id, company_id, as_of, status, definition, product_scope, customer_scope,
    geography_scope, period_scope, structure_json, advantage_json, erosion_paths_json, source_type,
    source_refs_json, created_at, updated_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    input.competitiveMarketId, input.companyId, input.asOf, input.status, input.definition,
    input.productScope, input.customerScope, input.geographyScope, input.periodScope, JSON.stringify(input.structure),
    JSON.stringify(input.advantages), JSON.stringify(input.erosionPaths), sourceTypeForEpistemic(input.epistemicType),
    JSON.stringify(input.sourceReferences), input.createdAt, input.updatedAt,
  )];
  for (const competitor of input.competitors) {
    statements.push(db.prepare(`insert into research_competitors (
      competitor_id, competitive_market_id, name, security_code, competitor_type, comparability_note,
      metrics_json, source_refs_json
    ) values (?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      competitor.competitorId, input.competitiveMarketId, competitor.name, competitor.securityCode,
      competitor.competitorType, competitor.comparabilityNote, JSON.stringify(competitor.metrics),
      JSON.stringify(competitor.sourceReferences),
    ));
  }
  return runInsert(db, "research_competitive_markets", input.competitiveMarketId, statements);
}

export async function insertResearchThesis(db: D1Database, input: ResearchThesis): Promise<ResearchDossierWriteResult> {
  assertAsOf(input.asOf);
  for (const evidence of input.evidence) assertSourceReferences(evidence.epistemicType, evidence.sourceReferences);
  const statements = [db.prepare(`insert into research_theses (
    thesis_id, company_id, as_of, title, statement, status, assessment_type, invalidation_condition,
    review_by, created_at, updated_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    input.thesisId, input.companyId, input.asOf, input.title, input.statement, input.status,
    input.epistemicType === "user_decision" ? "user_decision" : "system_assessment",
    input.invalidationCondition, input.reviewBy, input.createdAt, input.updatedAt,
  )];
  for (const evidence of input.evidence) {
    statements.push(db.prepare(`insert into research_thesis_evidence (
      thesis_evidence_id, thesis_id, stance, knowledge_information_id, source_url, source_title,
      evidence_type, statement, applicable_period, observed_at, source_refs_json, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      evidence.thesisEvidenceId, input.thesisId, evidence.stance, evidence.knowledgeInformationId,
      evidence.sourceUrl, evidence.sourceTitle, evidenceTypeForEpistemic(evidence.epistemicType),
      evidence.statement, evidence.applicablePeriod, evidence.observedAt,
      JSON.stringify(evidence.sourceReferences), evidence.createdAt,
    ));
  }
  return runInsert(db, "research_theses", input.thesisId, statements);
}

export async function insertResearchValuationCase(db: D1Database, input: ResearchValuationCase): Promise<ResearchDossierWriteResult> {
  assertAsOf(input.asOf);
  assertTypedValues(input.assumptions, "valuation assumptions");
  assertTypedValues([input.result], "valuation result");
  assertTypedValues(input.sensitivity, "valuation sensitivity");
  return runInsert(db, "research_valuation_cases", input.valuationCaseId, [db.prepare(`insert into research_valuation_cases (
    valuation_case_id, security_code, company_id, as_of, status, valuation_type, method_rationale,
    assumptions_json, outputs_json, sensitivity_json, source_refs_json, created_at, updated_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    input.valuationCaseId, input.securityCode, input.companyId, input.asOf, input.status, input.valuationType,
    input.methodRationale, JSON.stringify(input.assumptions), JSON.stringify(input.result),
    JSON.stringify(input.sensitivity), JSON.stringify(input.sourceReferences), input.createdAt, input.updatedAt,
  )]);
}

export async function insertResearchRiskEntry(db: D1Database, input: ResearchRiskEntry): Promise<ResearchDossierWriteResult> {
  assertAsOf(input.asOf);
  if (input.scope !== "operating_company" && input.scope !== "listed_security") {
    throw new Error("public research risk scope cannot be user_portfolio");
  }
  return runInsert(db, "research_risk_entries", input.riskId, [db.prepare(`insert into research_risk_entries (
    risk_id, company_id, security_code, as_of, category, scope, title, exposure, transmission, loss_range,
    likelihood, impact, speed, reversibility, gross_risk, verified_mitigation, residual_risk,
    trigger_condition, review_frequency, status, source_refs_json, created_at, updated_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    input.riskId, input.companyId, input.securityCode, input.asOf, input.category, input.scope, input.title,
    input.exposure, input.transmission, input.lossRange, input.likelihood, input.impact, input.speed,
    input.reversibility, input.grossRisk, input.verifiedMitigation, input.residualRisk, input.triggerCondition,
    input.reviewFrequency, input.status, JSON.stringify(input.sourceReferences), input.createdAt, input.updatedAt,
  )]);
}

export async function insertResearchCatalyst(db: D1Database, input: ResearchCatalyst): Promise<ResearchDossierWriteResult> {
  assertSourceReferences(input.epistemicType, input.sourceReferences);
  if (input.epistemicType !== epistemicTypeForCatalystStatus(input.status)) {
    throw new Error("catalyst epistemic type does not match its status");
  }
  return runInsert(db, "research_catalysts", input.catalystId, [db.prepare(`insert into research_catalysts (
    catalyst_id, company_id, security_code, event_at, event_type, title, status, impacted_assumption,
    expected_effect, outcome_note, source_refs_json, created_at, updated_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    input.catalystId, input.companyId, input.securityCode, input.eventAt, input.eventType, input.title,
    input.status, input.impactedAssumption, input.expectedEffect, input.outcomeNote,
    JSON.stringify(input.sourceReferences), input.createdAt, input.updatedAt,
  )]);
}

export async function insertResearchAnalysisSnapshot(db: D1Database, input: ResearchAnalysisSnapshot): Promise<ResearchDossierWriteResult> {
  assertAsOf(input.asOf);
  // This legacy snapshot series is still returned by the public company
  // dossier for backwards-compatible history.  It therefore cannot be used
  // as an untyped side channel for a local user's position, decision, or LLM
  // draft.  The typed public snapshot projection has the same invariant.
  assertPublicSnapshotPayload(input.summary, "snapshot summary");
  assertPublicSnapshotPayload(input.moduleStatus, "snapshot module status");
  return runInsert(db, "research_analysis_snapshots", input.analysisSnapshotId, [db.prepare(`insert into research_analysis_snapshots (
    analysis_snapshot_id, company_id, security_code, as_of, completion_level, state, summary_json,
    module_status_json, created_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    input.analysisSnapshotId, input.companyId, input.securityCode, input.asOf, input.completionLevel,
    input.state, JSON.stringify(input.summary), JSON.stringify(input.moduleStatus), input.createdAt,
  )]);
}

export async function insertResearchUserNote(db: D1Database, input: ResearchUserNote): Promise<ResearchDossierWriteResult> {
  if (!input.ownerKey.trim()) throw new Error("research user note ownerKey is required");
  return runInsert(db, "research_user_notes", input.noteId, [db.prepare(`insert into research_user_notes (
    note_id, owner_key, company_id, security_code, note_type, content, references_json, created_at, updated_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    input.noteId, input.ownerKey, input.companyId, input.securityCode, input.noteType, input.content,
    JSON.stringify(input.sourceReferences), input.createdAt, input.updatedAt,
  )]);
}

async function loadIdentity(
  db: D1Database,
  securityCode: string,
): Promise<{ operatingCompany: ResearchOperatingCompanyIdentity | null; listedSecurity: ResearchListedSecurityIdentity } | null> {
  const row = await db.prepare(`select s.security_code, s.company_id, s.venue, s.trading_currency,
      s.share_class, s.depositary_ratio, s.mapping_status, s.mapping_basis,
      c.canonical_name, c.reporting_currency, c.fiscal_year_end, c.identity_status
    from research_listed_securities s
    left join research_operating_companies c on c.company_id = s.company_id
    where s.security_code = ?`).bind(securityCode).first<Row>();
  if (!row) return null;
  const companyId = nullableString(row.company_id);
  return {
    listedSecurity: {
      securityCode: requiredString(row.security_code, "security_code"),
      companyId,
      venue: requiredString(row.venue, "venue"),
      tradingCurrency: nullableString(row.trading_currency),
      shareClass: nullableString(row.share_class),
      depositaryRatio: nullableNumber(row.depositary_ratio),
      mappingStatus: row.mapping_status as ResearchListedSecurityIdentity["mappingStatus"],
      mappingBasis: nullableString(row.mapping_basis),
    },
    operatingCompany: companyId && row.canonical_name ? {
      companyId,
      canonicalName: requiredString(row.canonical_name, "canonical_name"),
      reportingCurrency: nullableString(row.reporting_currency),
      fiscalYearEnd: nullableString(row.fiscal_year_end),
      identityStatus: row.identity_status as ResearchOperatingCompanyIdentity["identityStatus"],
    } : null,
  };
}

async function loadBusinessModels(db: D1Database, companyId: string, asOf: number): Promise<ResearchBusinessModel[]> {
  const rows = await db.prepare(`select * from research_business_models
    where company_id = ? and as_of <= ? and status <> 'superseded'
    order by as_of desc, created_at desc, business_model_id`).bind(companyId, asOf).all<Row>();
  const items = rows.results.map(mapBusinessModel);
  if (!items.length) return [];
  const segments = await db.prepare(`select * from research_business_segments where business_model_id in (${placeholders(items.length)})
    order by business_model_id, sort_order, segment_id`).bind(...items.map((item) => item.businessModelId)).all<Row>();
  const byModel = groupRows(segments.results, "business_model_id", mapBusinessSegment);
  return items.map((item) => ({ ...item, segments: byModel.get(item.businessModelId) ?? [] }));
}

async function loadMarketSpaceModels(db: D1Database, companyId: string, asOf: number): Promise<ResearchMarketSpaceModel[]> {
  const rows = await db.prepare(`select * from research_market_space_models
    where company_id = ? and as_of <= ? and status <> 'superseded'
    order by as_of desc, created_at desc, market_space_id`).bind(companyId, asOf).all<Row>();
  return rows.results.map(mapMarketSpaceModel);
}

async function loadCompetitiveMarkets(db: D1Database, companyId: string, asOf: number): Promise<ResearchCompetitiveMarket[]> {
  const rows = await db.prepare(`select * from research_competitive_markets
    where company_id = ? and as_of <= ? and status <> 'superseded'
    order by as_of desc, created_at desc, competitive_market_id`).bind(companyId, asOf).all<Row>();
  const items = rows.results.map(mapCompetitiveMarket);
  if (!items.length) return [];
  const competitors = await db.prepare(`select * from research_competitors where competitive_market_id in (${placeholders(items.length)})
    order by competitive_market_id, name, competitor_id`).bind(...items.map((item) => item.competitiveMarketId)).all<Row>();
  const byMarket = groupRows(competitors.results, "competitive_market_id", mapCompetitor);
  return items.map((item) => ({ ...item, competitors: byMarket.get(item.competitiveMarketId) ?? [] }));
}

async function loadTheses(db: D1Database, companyId: string, asOf: number): Promise<ResearchThesis[]> {
  const rows = await db.prepare(`select * from research_theses
    where company_id = ? and as_of <= ? and status <> 'superseded'
    order by as_of desc, created_at desc, thesis_id`).bind(companyId, asOf).all<Row>();
  const items = rows.results.map(mapThesis);
  if (!items.length) return [];
  const evidence = await db.prepare(`select * from research_thesis_evidence where thesis_id in (${placeholders(items.length)})
    and created_at <= ? order by thesis_id, observed_at desc, created_at desc, thesis_evidence_id`)
    .bind(...items.map((item) => item.thesisId), asOf).all<Row>();
  const byThesis = groupRows(evidence.results, "thesis_id", mapThesisEvidence);
  return items.map((item) => ({ ...item, evidence: byThesis.get(item.thesisId) ?? [] }));
}

async function loadValuationCases(db: D1Database, securityCode: string, companyId: string | null, asOf: number): Promise<ResearchValuationCase[]> {
  const rows = await db.prepare(`select * from research_valuation_cases
    where security_code = ? and as_of <= ? and status <> 'superseded'
      and (? is null or company_id is null or company_id = ?)
    order by as_of desc, created_at desc, valuation_case_id`).bind(securityCode, asOf, companyId, companyId).all<Row>();
  return rows.results.map(mapValuationCase);
}

async function loadRisks(db: D1Database, securityCode: string, companyId: string | null, asOf: number): Promise<ResearchRiskEntry[]> {
  const rows = await db.prepare(`select * from research_risk_entries
    where as_of <= ? and scope in ('operating_company', 'listed_security') and ((security_code = ?) or (? is not null and company_id = ?))
    order by case status when 'upgraded' then 0 when 'active' then 1 when 'new' then 2 else 3 end,
      as_of desc, updated_at desc, risk_id`).bind(asOf, securityCode, companyId, companyId).all<Row>();
  return rows.results.map(mapRisk);
}

async function loadCatalysts(db: D1Database, securityCode: string, companyId: string | null, asOf: number): Promise<ResearchCatalyst[]> {
  const rows = await db.prepare(`select * from research_catalysts
    where created_at <= ? and ((security_code = ?) or (? is not null and company_id = ?))
    order by case when event_at is null then 1 else 0 end, event_at, created_at desc, catalyst_id`)
    .bind(asOf, securityCode, companyId, companyId).all<Row>();
  const catalysts = rows.results.map(mapCatalyst);
  let reviewsByCatalyst = new Map<string, import("../domain/research-catalyst-review").ResearchCatalystReview[]>();
  try { reviewsByCatalyst = await loadResearchCatalystReviews(db, { catalystIds: catalysts.map((item) => item.catalystId), asOf }); }
  catch (error) { if (!isMissingTableError(error)) throw error; }
  return catalysts.map((item) => ({ ...item, reviews: reviewsByCatalyst.get(item.catalystId) ?? [] }));
}

async function loadSnapshots(db: D1Database, securityCode: string, companyId: string | null, asOf: number): Promise<ResearchAnalysisSnapshot[]> {
  const rows = await db.prepare(`select * from research_analysis_snapshots
    where security_code = ? and as_of <= ? and (? is null or company_id is null or company_id = ?)
    order by as_of desc, created_at desc, analysis_snapshot_id`).bind(securityCode, asOf, companyId, companyId).all<Row>();
  // Some historical rows pre-date the public/private boundary.  Do not turn
  // the ordinary company read endpoint into a way to replay their private
  // fields.  They remain in storage for audit/migration purposes, while the
  // public history only exposes rows that satisfy today's contract.
  return rows.results.filter((row) => isPublicSnapshotRow(row)).map(mapSnapshot);
}

async function loadUserNotes(db: D1Database, securityCode: string, companyId: string | null, ownerKey: string, asOf: number): Promise<ResearchUserNote[]> {
  const rows = await db.prepare(`select * from research_user_notes
    where owner_key = ? and security_code = ? and created_at <= ?
      and (? is null or company_id is null or company_id = ?)
    order by updated_at desc, note_id`).bind(ownerKey, securityCode, asOf, companyId, companyId).all<Row>();
  return rows.results.map(mapUserNote);
}

async function loadSection<T>(loader: () => Promise<T[]>): Promise<ResearchDossierSection<T>> {
  try {
    return availableSection(await loader());
  } catch (error) {
    if (isMissingTableError(error)) return unavailableSection("storage_not_initialized");
    throw error;
  }
}

async function runInsert(
  db: D1Database,
  table: string,
  recordId: string,
  statements: D1PreparedStatement[],
): Promise<ResearchDossierWriteResult> {
  try {
    await db.batch(statements);
    return { state: "saved", recordId, reason: null };
  } catch (error) {
    if (isMissingTableError(error, table)) return { state: "unavailable", recordId, reason: "storage_not_initialized" };
    throw error;
  }
}

function mapBusinessModel(row: Row): ResearchBusinessModel {
  const epistemicType = epistemicTypeFromSourceType(requiredString(row.source_type, "source_type"));
  const sourceReferences = parseSourceReferences(row.source_refs_json);
  assertSourceReferences(epistemicType, sourceReferences);
  return {
    businessModelId: requiredString(row.business_model_id, "business_model_id"), companyId: requiredString(row.company_id, "company_id"),
    asOf: requiredNumber(row.as_of, "as_of"), status: row.status as ResearchBusinessModel["status"],
    primaryEarningDriver: nullableString(row.primary_earning_driver), revenueRecognition: nullableString(row.revenue_recognition),
    summary: requiredString(row.summary, "summary"), epistemicType, sourceReferences, segments: [],
    createdAt: requiredNumber(row.created_at, "created_at"), updatedAt: requiredNumber(row.updated_at, "updated_at"),
  };
}

function mapBusinessSegment(row: Row): ResearchBusinessSegment {
  return {
    segmentId: requiredString(row.segment_id, "segment_id"), name: requiredString(row.name, "name"),
    revenueDriver: nullableString(row.revenue_driver), customerScope: nullableString(row.customer_scope),
    geographicScope: nullableString(row.geographic_scope), pricingModel: nullableString(row.pricing_model),
    costDriver: nullableString(row.cost_driver), workingCapitalDriver: nullableString(row.working_capital_driver),
    capitalIntensityDriver: nullableString(row.capital_intensity_driver), sourceReferences: parseSourceReferences(row.source_refs_json),
    sortOrder: requiredNumber(row.sort_order, "sort_order"),
  };
}

function mapMarketSpaceModel(row: Row): ResearchMarketSpaceModel {
  const epistemicType = epistemicTypeFromSourceType(requiredString(row.source_type, "source_type"));
  const sourceReferences = parseSourceReferences(row.source_refs_json);
  assertSourceReferences(epistemicType, sourceReferences);
  return {
    marketSpaceId: requiredString(row.market_space_id, "market_space_id"), companyId: requiredString(row.company_id, "company_id"),
    asOf: requiredNumber(row.as_of, "as_of"), status: row.status as ResearchMarketSpaceModel["status"],
    marketDefinition: requiredString(row.market_definition, "market_definition"), tam: parseObject(row.tam_json, "tam_json"),
    sam: parseObject(row.sam_json, "sam_json"), som: parseObject(row.som_json, "som_json"),
    profitPool: parseObject(row.profit_pool_json, "profit_pool_json"), topDown: parseObject(row.top_down_json, "top_down_json"),
    bottomUp: parseObject(row.bottom_up_json, "bottom_up_json"), transmission: parseObject(row.transmission_json, "transmission_json"),
    epistemicType, sourceReferences, createdAt: requiredNumber(row.created_at, "created_at"), updatedAt: requiredNumber(row.updated_at, "updated_at"),
  };
}

function mapCompetitiveMarket(row: Row): ResearchCompetitiveMarket {
  const epistemicType = epistemicTypeFromSourceType(requiredString(row.source_type, "source_type"));
  const sourceReferences = parseSourceReferences(row.source_refs_json);
  assertSourceReferences(epistemicType, sourceReferences);
  return {
    competitiveMarketId: requiredString(row.competitive_market_id, "competitive_market_id"), companyId: requiredString(row.company_id, "company_id"),
    asOf: requiredNumber(row.as_of, "as_of"), status: row.status as ResearchCompetitiveMarket["status"],
    definition: requiredString(row.definition, "definition"), productScope: nullableString(row.product_scope),
    customerScope: nullableString(row.customer_scope), geographyScope: nullableString(row.geography_scope), periodScope: nullableString(row.period_scope),
    structure: parseObject(row.structure_json, "structure_json"), advantages: parseArray(row.advantage_json, "advantage_json"),
    erosionPaths: parseArray(row.erosion_paths_json, "erosion_paths_json"), epistemicType, sourceReferences, competitors: [],
    createdAt: requiredNumber(row.created_at, "created_at"), updatedAt: requiredNumber(row.updated_at, "updated_at"),
  };
}

function mapCompetitor(row: Row): ResearchCompetitor {
  return {
    competitorId: requiredString(row.competitor_id, "competitor_id"), name: requiredString(row.name, "name"),
    securityCode: nullableString(row.security_code), competitorType: row.competitor_type as ResearchCompetitor["competitorType"],
    comparabilityNote: requiredString(row.comparability_note, "comparability_note"), metrics: parseObject(row.metrics_json, "metrics_json"),
    sourceReferences: parseSourceReferences(row.source_refs_json),
  };
}

function mapThesis(row: Row): ResearchThesis {
  return {
    thesisId: requiredString(row.thesis_id, "thesis_id"), companyId: requiredString(row.company_id, "company_id"),
    asOf: requiredNumber(row.as_of, "as_of"), title: requiredString(row.title, "title"), statement: requiredString(row.statement, "statement"),
    status: row.status as ResearchThesis["status"], epistemicType: row.assessment_type === "user_decision" ? "user_decision" : "system_judgment",
    invalidationCondition: requiredString(row.invalidation_condition, "invalidation_condition"), reviewBy: nullableNumber(row.review_by), evidence: [],
    createdAt: requiredNumber(row.created_at, "created_at"), updatedAt: requiredNumber(row.updated_at, "updated_at"),
  };
}

function mapThesisEvidence(row: Row): ResearchThesisEvidence {
  const epistemicType = epistemicTypeFromSourceType(requiredString(row.evidence_type, "evidence_type"));
  const sourceReferences = parseSourceReferences(row.source_refs_json);
  assertSourceReferences(epistemicType, sourceReferences);
  return {
    thesisEvidenceId: requiredString(row.thesis_evidence_id, "thesis_evidence_id"), thesisId: requiredString(row.thesis_id, "thesis_id"),
    stance: row.stance as ResearchThesisEvidence["stance"], knowledgeInformationId: nullableString(row.knowledge_information_id),
    sourceUrl: nullableString(row.source_url), sourceTitle: nullableString(row.source_title), epistemicType,
    statement: requiredString(row.statement, "statement"), applicablePeriod: nullableString(row.applicable_period),
    observedAt: nullableNumber(row.observed_at), sourceReferences, createdAt: requiredNumber(row.created_at, "created_at"),
  };
}

function mapValuationCase(row: Row): ResearchValuationCase {
  const assumptions = parseTypedValues(row.assumptions_json, "assumptions_json");
  const result = parseTypedValue(row.outputs_json, "outputs_json");
  const sensitivity = parseTypedValues(row.sensitivity_json, "sensitivity_json");
  return {
    valuationCaseId: requiredString(row.valuation_case_id, "valuation_case_id"), securityCode: requiredString(row.security_code, "security_code"),
    companyId: nullableString(row.company_id), asOf: requiredNumber(row.as_of, "as_of"), status: row.status as ResearchValuationCase["status"],
    valuationType: row.valuation_type as ResearchValuationCase["valuationType"], methodRationale: requiredString(row.method_rationale, "method_rationale"),
    assumptions, result, sensitivity, sourceReferences: parseSourceReferences(row.source_refs_json),
    createdAt: requiredNumber(row.created_at, "created_at"), updatedAt: requiredNumber(row.updated_at, "updated_at"),
  };
}

function mapRisk(row: Row): ResearchRiskEntry {
  return {
    riskId: requiredString(row.risk_id, "risk_id"), companyId: nullableString(row.company_id), securityCode: nullableString(row.security_code),
    asOf: requiredNumber(row.as_of, "as_of"), category: requiredString(row.category, "category"), scope: row.scope as ResearchRiskEntry["scope"],
    title: requiredString(row.title, "title"), exposure: requiredString(row.exposure, "exposure"), transmission: requiredString(row.transmission, "transmission"),
    lossRange: nullableString(row.loss_range), likelihood: nullableString(row.likelihood), impact: nullableString(row.impact), speed: nullableString(row.speed),
    reversibility: nullableString(row.reversibility), grossRisk: nullableString(row.gross_risk), verifiedMitigation: nullableString(row.verified_mitigation),
    residualRisk: nullableString(row.residual_risk), triggerCondition: requiredString(row.trigger_condition, "trigger_condition"),
    reviewFrequency: nullableString(row.review_frequency), status: row.status as ResearchRiskEntry["status"], epistemicType: "system_judgment",
    sourceReferences: parseSourceReferences(row.source_refs_json), createdAt: requiredNumber(row.created_at, "created_at"),
    updatedAt: requiredNumber(row.updated_at, "updated_at"),
  };
}

function mapCatalyst(row: Row): ResearchCatalyst {
  const status = row.status as ResearchCatalyst["status"];
  const epistemicType = epistemicTypeForCatalystStatus(status);
  const sourceReferences = parseSourceReferences(row.source_refs_json);
  assertSourceReferences(epistemicType, sourceReferences);
  return {
    catalystId: requiredString(row.catalyst_id, "catalyst_id"), companyId: nullableString(row.company_id), securityCode: nullableString(row.security_code),
    eventAt: nullableNumber(row.event_at), eventType: requiredString(row.event_type, "event_type"), title: requiredString(row.title, "title"),
    status, impactedAssumption: requiredString(row.impacted_assumption, "impacted_assumption"), expectedEffect: nullableString(row.expected_effect),
    outcomeNote: nullableString(row.outcome_note), reviews: [], epistemicType, sourceReferences, createdAt: requiredNumber(row.created_at, "created_at"),
    updatedAt: requiredNumber(row.updated_at, "updated_at"),
  };
}

function mapSnapshot(row: Row): ResearchAnalysisSnapshot {
  return {
    analysisSnapshotId: requiredString(row.analysis_snapshot_id, "analysis_snapshot_id"), companyId: nullableString(row.company_id),
    securityCode: requiredString(row.security_code, "security_code"), asOf: requiredNumber(row.as_of, "as_of"),
    completionLevel: row.completion_level as ResearchAnalysisSnapshot["completionLevel"], state: requiredString(row.state, "state"),
    summary: parseObject(row.summary_json, "summary_json"), moduleStatus: parseObject(row.module_status_json, "module_status_json"),
    epistemicType: "system_judgment", createdAt: requiredNumber(row.created_at, "created_at"),
  };
}

function mapUserNote(row: Row): ResearchUserNote {
  return {
    noteId: requiredString(row.note_id, "note_id"), ownerKey: requiredString(row.owner_key, "owner_key"), companyId: nullableString(row.company_id),
    securityCode: requiredString(row.security_code, "security_code"), noteType: row.note_type as ResearchUserNote["noteType"],
    content: requiredString(row.content, "content"), epistemicType: "user_decision", sourceReferences: parseSourceReferences(row.references_json),
    createdAt: requiredNumber(row.created_at, "created_at"), updatedAt: requiredNumber(row.updated_at, "updated_at"),
  };
}

function sourceTypeForEpistemic(value: ResearchBusinessModel["epistemicType"]): string {
  const mapping: Partial<Record<typeof value, string>> = {
    observed_fact: "fact", management_guidance: "management_guidance", source_viewpoint: "third_party_view",
    analysis_assumption: "analyst_assumption", system_judgment: "system_assessment",
  };
  const result = mapping[value];
  if (!result) throw new Error(`epistemic type is not supported by this dossier table: ${value}`);
  return result;
}

function evidenceTypeForEpistemic(value: ResearchThesisEvidence["epistemicType"]): string {
  const mapping: Partial<Record<typeof value, string>> = {
    observed_fact: "fact", management_guidance: "management_guidance", source_viewpoint: "source_viewpoint",
    third_party_forecast: "third_party_forecast", analysis_assumption: "analyst_assumption", system_judgment: "system_assessment",
  };
  const result = mapping[value];
  if (!result) throw new Error(`epistemic type is not supported by thesis evidence: ${value}`);
  return result;
}

function assertTypedValues(values: ResearchTypedValue[], label: string): void {
  for (const value of values) {
    if (!value || typeof value !== "object" || !value.epistemicType || !("value" in value)) {
      throw new Error(`${label} must retain epistemicType and value`);
    }
    assertSourceReferences(value.epistemicType, value.sourceReferences ?? []);
  }
}

function parseTypedValues(value: unknown, label: string): ResearchTypedValue[] {
  const parsed = parseArray(value, label);
  const result = parsed.map((item) => parseTypedValueObject(item, label));
  assertTypedValues(result, label);
  return result;
}

function parseTypedValue(value: unknown, label: string): ResearchTypedValue {
  const result = parseTypedValueObject(parseJson(value, label), label);
  assertTypedValues([result], label);
  return result;
}

function parseTypedValueObject(value: unknown, label: string): ResearchTypedValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const raw = value as Row;
  const epistemicType = requiredString(raw.epistemicType, `${label}.epistemicType`) as ResearchTypedValue["epistemicType"];
  epistemicTypeFromSourceType(epistemicType === "observed_fact" ? "fact" :
    epistemicType === "management_guidance" ? "management_guidance" :
      epistemicType === "source_viewpoint" ? "source_viewpoint" :
        epistemicType === "third_party_forecast" ? "third_party_forecast" :
          epistemicType === "analysis_assumption" ? "analyst_assumption" :
            epistemicType === "system_judgment" ? "system_assessment" : "user_decision");
  if (!("value" in raw)) throw new Error(`${label} must retain a value`);
  return {
    epistemicType,
    value: raw.value,
    ...(typeof raw.label === "string" ? { label: raw.label } : {}),
    ...(Array.isArray(raw.sourceReferences) ? { sourceReferences: parseSourceReferences(raw.sourceReferences) } : {}),
  };
}

function parseSourceReferences(value: unknown): ResearchSourceReference[] {
  const parsed = Array.isArray(value) ? value : parseArray(value, "source references");
  return parsed.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("source reference must be an object");
    return item as ResearchSourceReference;
  });
}

function parseObject(value: unknown, label: string): Record<string, unknown> {
  const parsed = parseJson(value, label);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object`);
  return parsed as Record<string, unknown>;
}

function isPublicSnapshotRow(row: Row): boolean {
  try {
    assertPublicSnapshotPayload(parseObject(row.summary_json, "summary_json"), "snapshot summary");
    assertPublicSnapshotPayload(parseObject(row.module_status_json, "module_status_json"), "snapshot module status");
    return true;
  } catch {
    return false;
  }
}

function assertPublicSnapshotPayload(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPublicSnapshotPayload(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (["ownerKey", "position", "tradePlan", "order", "userDecision", "membership", "userNote", "userNotes", "localLlmDraft", "synthesisDraft"].includes(key)) {
      throw new Error(`${path}.${key} is private or a local draft and cannot enter a public research snapshot`);
    }
    if (key === "epistemicType" && nested === "user_decision") {
      throw new Error(`${path}.epistemicType cannot be user_decision in a public research snapshot`);
    }
    assertPublicSnapshotPayload(nested, `${path}.${key}`);
  }
}

function parseArray(value: unknown, label: string): unknown[] {
  const parsed = parseJson(value, label);
  if (!Array.isArray(parsed)) throw new Error(`${label} must be a JSON array`);
  return parsed;
}

function parseJson(value: unknown, label: string): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { throw new Error(`${label} contains invalid JSON`); }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requiredNumber(value: unknown, label: string): number {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(`${label} must be numeric`);
  return result;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function placeholders(count: number): string { return Array.from({ length: count }, () => "?").join(", "); }

function groupRows<T>(rows: Row[], key: string, mapper: (row: Row) => T): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const row of rows) {
    const id = requiredString(row[key], key);
    result.set(id, [...(result.get(id) ?? []), mapper(row)]);
  }
  return result;
}

function isMissingTableError(error: unknown, expectedTable?: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (!/(?:no such table|does not exist|not found).*research_/i.test(message)) return false;
  return !expectedTable || message.toLowerCase().includes(expectedTable.toLowerCase());
}
