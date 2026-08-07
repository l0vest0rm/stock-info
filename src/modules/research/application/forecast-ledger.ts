import { securityMarket } from "../../../shared/codes";
import type { SecurityRecord } from "../../../types";
import {
  FORECAST_METRICS,
  FORECAST_RAW_UNITS,
  FORECAST_CARRIER_RELATIONS,
  FORECAST_CONSOLIDATION_RULE_VERSION,
  assertForecastSupersedesSameModelLineage,
  buildForecastConsolidation,
  normalizeSourceForecast,
  type ForecastAccountingBasis,
  type ForecastCarrierRelation,
  type ForecastMetric,
  type ForecastOwnershipBasis,
  type ForecastRawUnit,
  type ForecastShareBasis,
  type SourceForecastInput,
} from "../domain/forecast-consolidation";
import { buildForecastCoverageReadModel } from "../domain/forecast-coverage";
import { buildForecastRevisionReadModel } from "../domain/forecast-revision";
import { buildFormalActualHealth } from "../domain/formal-actual-health";
import { isPresentableResearchSource } from "../domain/research-source-provenance";
import { loadForecastActualCalibrationRecords, loadFormalActuals } from "./forecast-actual-calibration";
import { loadCandidateReviews, loadFormalActualCandidates } from "./formal-actual-candidates";

export type ForecastReviewWrite = {
  informationId: string;
  reviewStatus: "included" | "excluded" | "needs_review";
  reviewReason?: string;
  /** Deprecated v3 field retained for request compatibility; v4 resolves it from the assertion. */
  sourceIdentityId?: string;
  /** Required for an included sample; binds the review to one immutable document version. */
  sourceIdentityAssertionId?: string;
  institution?: string;
  analysts?: string[];
  forecastDate?: string;
  metric?: ForecastMetric;
  fiscalYear?: number;
  rawValue?: number;
  rawUnit?: ForecastRawUnit;
  currency?: string | null;
  accountingBasis?: ForecastAccountingBasis;
  ownershipBasis?: ForecastOwnershipBasis;
  shareBasis?: ForecastShareBasis;
  /** Explicit immutable predecessor; never infer a chain from institution names. */
  supersedesForecastId?: string | null;
};

export const FORECAST_SOURCE_IDENTITY_TYPES = [
  "research_provider",
  "republisher",
  "joint_authorship",
  "database_aggregation",
] as const;
export type ForecastSourceIdentityType = typeof FORECAST_SOURCE_IDENTITY_TYPES[number];

export type ForecastSourceIndependenceGroupWrite = {
  canonicalName: string;
};

export type ForecastSourceIdentityWrite = {
  displayName: string;
  identityType: ForecastSourceIdentityType;
  independenceGroupId: string;
  evidenceUrl: string;
  evidenceTitle: string;
  evidenceDocId?: string | null;
};

export type ForecastModelLineageWrite = {
  originSourceIdentityId: string;
  lineageName: string;
  evidenceUrl: string;
  evidenceTitle: string;
  evidenceDocId?: string | null;
};

export type ForecastSourceIdentityAssertionWrite = {
  docId: string;
  versionId: string;
  contentHash: string;
  carrierSourceIdentityId: string;
  originSourceIdentityId?: string | null;
  modelLineageId?: string | null;
  carrierRelation: ForecastCarrierRelation;
  evidenceUrl: string;
  evidenceTitle: string;
  evidenceDocId?: string | null;
};

export type ForecastScenarioWrite = {
  scenarioName: "downside" | "base" | "upside";
  assumptions: unknown[];
  outputs: unknown[];
  evidenceRefs?: unknown[];
  status?: "draft" | "reviewed";
};

/**
 * A source collector may attach this contract to `knowledge_docs.metadata_json`
 * under `researchForecastEvidence`.  It deliberately references an immutable
 * information-record id rather than trying to match a sentence, date, analyst
 * name, or provider label after the fact.  The collector is therefore the
 * only place allowed to attest that a stored document is the original carrier.
 */
type AutomaticForecastMeasurement = {
  informationId: string;
  forecastDate: string;
  fiscalYear: number;
  rawValue: number;
  rawUnit: ForecastRawUnit;
  currency?: string | null;
  accountingBasis: ForecastAccountingBasis;
  ownershipBasis: ForecastOwnershipBasis;
  shareBasis: ForecastShareBasis;
  analysts?: string[];
  /** An explicit immutable predecessor, if the original source declares it. */
  supersedesForecastId?: string | null;
};

type AutomaticForecastEvidenceContract = {
  schemaVersion: "research-source-forecast.v1";
  carrierRelation: "original";
  origin: {
    displayName: string;
    identityType: ForecastSourceIdentityType;
    independenceGroupName: string;
    evidenceUrl: string;
    evidenceTitle: string;
  };
  modelLineage: {
    lineageName: string;
    evidenceUrl: string;
    evidenceTitle: string;
  };
  /**
   * Optional legacy collector contract. New values are stored with the
   * immutable information record instead, while provenance stays here.
   */
  measurements?: AutomaticForecastMeasurement[];
};

const AUTOMATIC_FORECAST_ACTOR = "system:forecast-auto-evidence.v1";

type ForecastCandidateRow = {
  informationId: string;
  resultId: string;
  processingRunId: string;
  processingModel: string;
  processingPromptVersion: string;
  processingSchemaVersion: string;
  processingOntologyVersion: string;
  processingInputHash: string;
  processingCompletedAt: number | null;
  entity: string;
  informationType: string;
  category: string;
  period: string | null;
  statement: string;
  measurementJson: string | null;
  resultOutcome: string;
  versionId: string;
  contentHash: string;
  docId: string;
  title: string;
  sourceName: string | null;
  sourceType: string;
  reportType: string | null;
  publishedAt: string | null;
  sourceUrl: string | null;
  contentUrl: string | null;
  reviewId: string | null;
  reviewStatus: string | null;
  reviewReason: string | null;
  currentForecastId: string | null;
  reviewedAt: number | null;
  reviewedBy: string | null;
  discoveryMethod: string | null;
  metadataJson: string | null;
};

type SourceForecastRow = {
  forecastId: string;
  reviewId: string;
  informationId: string;
  versionId: string;
  docId: string;
  securityCode: string;
  companyId: string | null;
  institution: string | null;
  sourceIdentityId: string | null;
  sourceIdentityAssertionId: string | null;
  originSourceIdentityId: string | null;
  carrierSourceIdentityId: string | null;
  carrierRelation: ForecastCarrierRelation | null;
  modelLineageId: string | null;
  sourceIdentityType: ForecastSourceIdentityType | null;
  independenceGroupId: string | null;
  independenceGroupName: string | null;
  sourceIdentityEvidenceUrl: string | null;
  sourceIdentityEvidenceTitle: string | null;
  analystsJson: string;
  forecastDate: string;
  metric: ForecastMetric;
  fiscalYear: number;
  fiscalPeriod: string;
  rawValue: number;
  rawUnit: ForecastRawUnit;
  currency: string | null;
  accountingBasis: ForecastAccountingBasis;
  ownershipBasis: ForecastOwnershipBasis;
  shareBasis: ForecastShareBasis;
  normalizedValue: number | null;
  normalizedUnit: string | null;
  normalizationStatus: string;
  normalizationNotes: string | null;
  sourceStatement: string;
  supersedesForecastId: string | null;
  createdAt: number;
  title: string;
  sourceName: string | null;
  sourceUrl: string | null;
  isCurrent?: number;
  discoveryMethod: string | null;
  metadataJson: string | null;
};

export const FORECAST_ACCOUNTING_BASES = ["gaap", "non_gaap", "adjusted", "unspecified"] as const;
export const FORECAST_OWNERSHIP_BASES = ["attributable_to_parent", "consolidated", "common_shareholders", "unspecified"] as const;
export const FORECAST_SHARE_BASES = ["basic", "diluted", "unspecified"] as const;

export async function loadForecastWorkspace(db: D1Database, code: string, security: SecurityRecord | null) {
  const [subject, candidateRows, sourceRows, revisionRows, consolidation, sourceIdentityRegistry, drafts, scenarios, formalActualCalibrations, formalActuals, formalActualCandidates, formalActualCandidateReviews] = await Promise.all([
    resolveResearchSubject(db, code, security),
    listForecastCandidates(db, code),
    listCurrentSourceForecasts(db, code),
    listForecastRevisionHistory(db, code),
    loadLatestConsolidation(db, code),
    loadForecastSourceIdentityRegistry(db),
    db.prepare(`select draft_id as draftId, consolidation_id as consolidationId, model, prompt_version as promptVersion,
        content_markdown as contentMarkdown, source_forecast_ids_json as sourceForecastIdsJson, created_at as createdAt
      from research_forecast_synthesis_drafts where security_code=? order by created_at desc limit 10`).bind(code).all<Record<string, unknown>>(),
    db.prepare(`select scenario_id as scenarioId, scenario_name as scenarioName, version, assumptions_json as assumptionsJson,
        outputs_json as outputsJson, evidence_refs_json as evidenceRefsJson, status, created_at as createdAt, updated_at as updatedAt
      from research_forecast_scenarios where security_code=? order by scenario_name, version desc`).bind(code).all<Record<string, unknown>>(),
    loadForecastActualCalibrationRecords(db, code),
    loadFormalActuals(db, code),
    loadFormalActualCandidates(db, code),
    loadCandidateReviews(db, code),
  ]);
  const presentableForecastIds = new Set(sourceRows.map((row) => row.forecastId));
  const consolidationRequiresIdentityRefreeze = Boolean(consolidation?.requiresIdentityRefreeze);
  const presentableConsolidation = consolidation && !consolidationRequiresIdentityRefreeze
    && consolidation.members.every((member) => presentableForecastIds.has(String(member.forecastId)))
    ? consolidation : null;
  const eligibleSynthesisForecastIds = new Set((presentableConsolidation?.members ?? [])
    .filter((member) => member.membershipStatus === "included" && member.reasonCode === "included")
    .map((member) => String(member.forecastId)));
  // A prior local draft can only remain visible if every cited sample is still
  // an eligible v4 member.  This avoids presenting a draft sourced from a
  // republication or an unre-frozen v3 sample as current research.
  const presentableSynthesisDrafts = drafts.results.map((row) => ({ ...row, sourceForecastIds: parseJsonArray(row.sourceForecastIdsJson) }))
    .filter((draft) => draft.sourceForecastIds.length > 0 && draft.sourceForecastIds.every((id) => eligibleSynthesisForecastIds.has(String(id))));
  const formalActualHealth = buildFormalActualHealth({
    actuals: formalActuals,
    calibrations: formalActualCalibrations,
    candidates: formalActualCandidates,
    candidateReviews: formalActualCandidateReviews,
  });
  const sourceCandidates = candidateRows.map(mapCandidate);
  const sourceForecasts = sourceRows.map(mapSourceForecast);
  const consolidationStatus = consolidationRequiresIdentityRefreeze
    ? { availability: "unavailable" as const, reason: "source_identity_re_review_required", priorRuleVersion: consolidation?.ruleVersion ?? null }
    : { availability: presentableConsolidation ? "available" as const : "empty" as const, reason: null, priorRuleVersion: null };
  const forecastCoverage = buildForecastCoverageReadModel({ sourceCandidates, sourceForecasts, consolidation: presentableConsolidation, consolidationStatus });
  return {
    subject,
    sourceCandidates,
    sourceForecasts,
    forecastRevisions: {
      ...buildForecastRevisionReadModel(revisionRows.map(toRevisionInput)),
      catalog: revisionRows.map(mapSourceForecast),
    },
    consolidation: presentableConsolidation,
    consolidationStatus,
    // Stable, read-only v4 state for the company API and coverage model. It
    // separates candidate discovery/review from independently eligible and
    // actually included samples; it is never a market consensus.
    forecastCoverage,
    sourceIdentityRegistry,
    synthesisDrafts: presentableSynthesisDrafts,
    scenarios: scenarios.results.map((row) => ({
      ...row,
      assumptions: parseJsonArray(row.assumptionsJson),
      outputs: parseJsonArray(row.outputsJson),
      evidenceRefs: parseJsonArray(row.evidenceRefsJson),
    })),
    // The retired client-value calibration table is intentionally absent from
    // this read model. All visible calibration records are tied to a stored
    // filing-backed formal actual and retain their comparability block.
    calibrations: formalActualCalibrations,
    // Keep the source-bound statutory actual beside its calibration reference
    // so the page can link each error measurement back to the formal filing.
    // This remains read-only and does not let a page supply an actual value.
    formalActuals,
    // This is a read-only health projection. It never rewrites a historical
    // calibration when an amended filing supersedes the underlying actual.
    // Consumers must use `currentComparableCalibrationCount`, not merely a
    // historical `comparable` record, when deciding whether calibration is
    // presently usable.
    formalActualHealth,
    layerStatus: {
      sourceCandidates: candidateRows.length ? "available" : "unavailable",
      standardizedSamples: sourceRows.length ? "available" : "unavailable",
      synthesisDraft: presentableSynthesisDrafts.length ? "available" : "unavailable",
      selfBuiltScenarios: scenarios.results.length ? "available" : "unavailable",
      // An immutable historical calibration is not current evidence after its
      // linked formal actual was superseded or restated. The visible layer
      // state must therefore use the same currentness projection as the
      // detailed health ledger rather than merely finding an old comparable
      // record.
      actualCalibration: formalActualHealth.calibrationAvailability,
    },
  };
}

/**
 * Registry rows are immutable source-evidence facts. A forecast stores only
 * the identity id; the group is resolved here and also frozen into a consolidation
 * member whenever that forecast is aggregated.
 */
export async function loadForecastSourceIdentityRegistry(db: D1Database) {
  const [groups, identities, modelLineages, assertions] = await Promise.all([
    db.prepare(`select independence_group_id as independenceGroupId, canonical_name as canonicalName,
      status, created_by as createdBy, created_at as createdAt
    from research_forecast_source_independence_groups order by canonical_name, independence_group_id`).all<Record<string, unknown>>(),
    db.prepare(`select source_identity_id as sourceIdentityId, display_name as displayName,
      identity_type as identityType, independence_group_id as independenceGroupId, evidence_url as evidenceUrl,
      evidence_title as evidenceTitle, evidence_doc_id as evidenceDocId, identity_status as identityStatus,
      created_by as createdBy, created_at as createdAt
    from research_forecast_source_identities order by display_name, source_identity_id`).all<Record<string, unknown>>(),
    db.prepare(`select model_lineage_id as modelLineageId, origin_source_identity_id as originSourceIdentityId,
      lineage_name as lineageName, evidence_url as evidenceUrl, evidence_title as evidenceTitle, evidence_doc_id as evidenceDocId,
      lineage_status as lineageStatus, created_at as createdAt
      from research_forecast_model_lineages order by lineage_name, model_lineage_id`).all<Record<string, unknown>>(),
    db.prepare(`select source_identity_assertion_id as sourceIdentityAssertionId, doc_id as docId, version_id as versionId,
      content_hash as contentHash, carrier_source_identity_id as carrierSourceIdentityId, origin_source_identity_id as originSourceIdentityId,
      model_lineage_id as modelLineageId, carrier_relation as carrierRelation, evidence_url as evidenceUrl,
      evidence_title as evidenceTitle, evidence_doc_id as evidenceDocId, assertion_status as assertionStatus, created_at as createdAt
      from research_forecast_source_identity_assertions order by created_at desc, source_identity_assertion_id desc limit 200`).all<Record<string, unknown>>(),
  ]);
  return { groups: groups.results, identities: identities.results, modelLineages: modelLineages.results, assertions: assertions.results };
}

export async function createForecastSourceIndependenceGroup(db: D1Database, input: ForecastSourceIndependenceGroupWrite) {
  const canonicalName = requiredText(input.canonicalName, "canonicalName");
  const known = await db.prepare(`select independence_group_id as independenceGroupId from research_forecast_source_independence_groups
    where lower(canonical_name)=lower(?)`).bind(canonicalName).first<{ independenceGroupId: string }>();
  if (known) throw new Error("an independence group with this canonicalName already exists");
  const independenceGroupId = `forecast-source-group:${crypto.randomUUID()}`;
  const createdAt = Date.now();
  await db.prepare(`insert into research_forecast_source_independence_groups (
    independence_group_id, canonical_name, status, created_by, created_at
  ) values (?, ?, 'confirmed', 'local-user', ?)`)
    .bind(independenceGroupId, canonicalName, createdAt).run();
  return { independenceGroupId, canonicalName, status: "confirmed" as const, createdAt };
}

export async function createForecastSourceIdentity(db: D1Database, input: ForecastSourceIdentityWrite) {
  const displayName = requiredText(input.displayName, "displayName");
  const identityType = requireEnum(input.identityType, FORECAST_SOURCE_IDENTITY_TYPES, "identityType");
  const independenceGroupId = requiredText(input.independenceGroupId, "independenceGroupId");
  const evidenceUrl = requireHttpsUrl(input.evidenceUrl, "evidenceUrl");
  const evidenceTitle = requiredText(input.evidenceTitle, "evidenceTitle");
  const evidenceDocId = normalizeOptionalId(input.evidenceDocId);
  const group = await db.prepare(`select independence_group_id as independenceGroupId, status
    from research_forecast_source_independence_groups where independence_group_id=?`).bind(independenceGroupId)
    .first<{ independenceGroupId: string; status: string }>();
  if (!group || group.status !== "confirmed") throw new Error("source identity requires a confirmed independence group");
  if (evidenceDocId) {
    const evidenceDoc = await db.prepare(`select doc_id as docId from knowledge_docs where doc_id=?`).bind(evidenceDocId).first<{ docId: string }>();
    if (!evidenceDoc) throw new Error("evidenceDocId must identify an existing knowledge document");
  }
  const sourceIdentityId = `forecast-source-identity:${crypto.randomUUID()}`;
  const createdAt = Date.now();
  await db.prepare(`insert into research_forecast_source_identities (
    source_identity_id, display_name, identity_type, independence_group_id, evidence_url, evidence_title,
    evidence_doc_id, identity_status, created_by, created_at
  ) values (?, ?, ?, ?, ?, ?, ?, 'confirmed', 'local-user', ?)`)
    .bind(sourceIdentityId, displayName, identityType, independenceGroupId, evidenceUrl, evidenceTitle, evidenceDocId, createdAt).run();
  return { sourceIdentityId, displayName, identityType, independenceGroupId, evidenceUrl, evidenceTitle, evidenceDocId,
    identityStatus: "confirmed" as const, createdAt };
}

/** A model lineage is an explicit origin-model identity, never a guessed analyst name. */
export async function createForecastModelLineage(db: D1Database, input: ForecastModelLineageWrite) {
  const originSourceIdentityId = requiredText(input.originSourceIdentityId, "originSourceIdentityId");
  const lineageName = requiredText(input.lineageName, "lineageName");
  const evidenceUrl = requireHttpsUrl(input.evidenceUrl, "evidenceUrl");
  const evidenceTitle = requiredText(input.evidenceTitle, "evidenceTitle");
  const evidenceDocId = normalizeOptionalId(input.evidenceDocId);
  await getConfirmedForecastSourceIdentity(db, originSourceIdentityId);
  if (evidenceDocId) await assertEvidenceDoc(db, evidenceDocId);
  const known = await db.prepare(`select model_lineage_id as modelLineageId from research_forecast_model_lineages
    where origin_source_identity_id=? and lower(lineage_name)=lower(?)`).bind(originSourceIdentityId, lineageName)
    .first<{ modelLineageId: string }>();
  if (known) throw new Error("a model lineage with this originSourceIdentityId and lineageName already exists");
  const modelLineageId = `forecast-model-lineage:${crypto.randomUUID()}`;
  const createdAt = Date.now();
  await db.prepare(`insert into research_forecast_model_lineages (
    model_lineage_id, origin_source_identity_id, lineage_name, evidence_url, evidence_title, evidence_doc_id,
    lineage_status, created_by, created_at
  ) values (?, ?, ?, ?, ?, ?, 'confirmed', 'local-user', ?)`)
    .bind(modelLineageId, originSourceIdentityId, lineageName, evidenceUrl, evidenceTitle, evidenceDocId, createdAt).run();
  return { modelLineageId, originSourceIdentityId, lineageName, evidenceUrl, evidenceTitle, evidenceDocId,
    lineageStatus: "confirmed" as const, createdAt };
}

/**
 * Records how one imported document version relates to a source model.  It is
 * deliberately one-to-one with doc/version, preventing a later relabel from
 * changing the provenance of an accepted forecast.
 */
export async function createForecastSourceIdentityAssertion(db: D1Database, input: ForecastSourceIdentityAssertionWrite) {
  const docId = requiredText(input.docId, "docId");
  const versionId = requiredText(input.versionId, "versionId");
  const contentHash = requiredText(input.contentHash, "contentHash");
  const carrierSourceIdentityId = requiredText(input.carrierSourceIdentityId, "carrierSourceIdentityId");
  const carrierRelation = requireEnum(input.carrierRelation, FORECAST_CARRIER_RELATIONS, "carrierRelation");
  const originSourceIdentityId = normalizeOptionalId(input.originSourceIdentityId);
  const modelLineageId = normalizeOptionalId(input.modelLineageId);
  const evidenceUrl = requireHttpsUrl(input.evidenceUrl, "evidenceUrl");
  const evidenceTitle = requiredText(input.evidenceTitle, "evidenceTitle");
  const evidenceDocId = normalizeOptionalId(input.evidenceDocId);
  await getConfirmedForecastSourceIdentity(db, carrierSourceIdentityId);
  if (evidenceDocId) await assertEvidenceDoc(db, evidenceDocId);
  const version = await db.prepare(`select version_id as versionId from knowledge_document_versions
    where doc_id=? and version_id=? and content_hash=?`).bind(docId, versionId, contentHash).first<{ versionId: string }>();
  if (!version) throw new Error("source identity assertion must match an existing exact document version and content hash");
  if (carrierRelation === "unknown") {
    if (originSourceIdentityId || modelLineageId) throw new Error("unknown carrier relation cannot claim originSourceIdentityId or modelLineageId");
  } else {
    if (!originSourceIdentityId || !modelLineageId) throw new Error("non-unknown carrier relation requires originSourceIdentityId and modelLineageId");
    await getConfirmedForecastSourceIdentity(db, originSourceIdentityId);
    const lineage = await getConfirmedForecastModelLineage(db, modelLineageId);
    if (lineage.originSourceIdentityId !== originSourceIdentityId) throw new Error("modelLineageId must belong to originSourceIdentityId");
    if (carrierRelation === "original" && carrierSourceIdentityId !== originSourceIdentityId) {
      throw new Error("original carrier relation requires carrierSourceIdentityId to equal originSourceIdentityId");
    }
  }
  const known = await db.prepare(`select source_identity_assertion_id as sourceIdentityAssertionId
    from research_forecast_source_identity_assertions where doc_id=? and version_id=?`).bind(docId, versionId)
    .first<{ sourceIdentityAssertionId: string }>();
  if (known) throw new Error("an immutable source identity assertion already exists for this document version");
  const sourceIdentityAssertionId = `forecast-source-assertion:${crypto.randomUUID()}`;
  const createdAt = Date.now();
  await db.prepare(`insert into research_forecast_source_identity_assertions (
    source_identity_assertion_id, doc_id, version_id, content_hash, carrier_source_identity_id, origin_source_identity_id,
    model_lineage_id, carrier_relation, evidence_url, evidence_title, evidence_doc_id, assertion_status, created_by, created_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', 'local-user', ?)`)
    .bind(sourceIdentityAssertionId, docId, versionId, contentHash, carrierSourceIdentityId, originSourceIdentityId,
      modelLineageId, carrierRelation, evidenceUrl, evidenceTitle, evidenceDocId, createdAt).run();
  return { sourceIdentityAssertionId, docId, versionId, contentHash, carrierSourceIdentityId, originSourceIdentityId,
    modelLineageId, carrierRelation, evidenceUrl, evidenceTitle, evidenceDocId, assertionStatus: "confirmed" as const, createdAt };
}

export async function saveForecastReview(db: D1Database, code: string, input: ForecastReviewWrite) {
  const candidate = await getForecastCandidate(db, code, input.informationId);
  if (!candidate) throw new Error("forecast information record not found for this security");
  if (!isOneOf(input.reviewStatus, ["included", "excluded", "needs_review"] as const)) throw new Error("invalid review status");
  if (input.reviewStatus !== "included" && !String(input.reviewReason || "").trim()) throw new Error("review reason is required");
  const now = Date.now();
  const identity = await db.prepare(`select company_id as companyId from research_listed_securities
    where security_code=? and mapping_status in ('confirmed','provisional')`).bind(code).first<{ companyId: string | null }>();
  const companyId = identity?.companyId ?? null;
  const knownReview = await db.prepare(`select review_id as reviewId, current_forecast_id as currentForecastId
    from research_forecast_source_reviews where security_code=? and information_id=?`).bind(code, input.informationId)
    .first<{ reviewId: string; currentForecastId: string | null }>();
  const reviewId = knownReview?.reviewId ?? `forecast-review:${crypto.randomUUID()}`;

  if (input.reviewStatus !== "included") {
    await upsertReview(db, { reviewId, code, companyId, informationId: input.informationId, currentForecastId: null,
      reviewStatus: input.reviewStatus, reviewReason: String(input.reviewReason || "").trim(), now });
    const snapshot = await persistForecastConsolidation(db, code, companyId);
    return { reviewId, forecastId: null, consolidationId: snapshot.consolidationId };
  }

  const metric = requireEnum(input.metric, FORECAST_METRICS, "metric");
  if (metric !== candidate.category) throw new Error(`metric must match information category: ${candidate.category}`);
  const rawUnit = requireEnum(input.rawUnit, FORECAST_RAW_UNITS, "rawUnit");
  const accountingBasis = requireEnum(input.accountingBasis ?? "unspecified", FORECAST_ACCOUNTING_BASES, "accountingBasis");
  const ownershipBasis = requireEnum(input.ownershipBasis ?? "unspecified", FORECAST_OWNERSHIP_BASES, "ownershipBasis");
  const shareBasis = requireEnum(input.shareBasis ?? "unspecified", FORECAST_SHARE_BASES, "shareBasis");
  const fiscalYear = Number(input.fiscalYear);
  const rawValue = Number(input.rawValue);
  const sourceIdentityAssertionId = requiredText(input.sourceIdentityAssertionId, "sourceIdentityAssertionId");
  const sourceAssertion = await getConfirmedForecastSourceIdentityAssertion(db, sourceIdentityAssertionId, candidate);
  const forecastDate = normalizeDate(input.forecastDate || candidate.publishedAt || "");
  if (!forecastDate) throw new Error("forecastDate must be YYYY-MM-DD");
  if (!Number.isInteger(fiscalYear) || fiscalYear < 1900 || fiscalYear > 2200) throw new Error("fiscalYear is invalid");
  if (!Number.isFinite(rawValue)) throw new Error("rawValue must be a finite number");
  const forecastId = `source-forecast:${crypto.randomUUID()}`;
  const explicitPredecessorId = normalizeOptionalId(input.supersedesForecastId);
  if (explicitPredecessorId && explicitPredecessorId === forecastId) throw new Error("source forecast cannot supersede itself");
  const predecessorId = explicitPredecessorId ?? knownReview?.currentForecastId ?? null;
  if (predecessorId) {
    const predecessor = await db.prepare(`select forecast_id as forecastId, model_lineage_id as modelLineageId
      from research_source_forecasts where forecast_id=? and security_code=?`).bind(predecessorId, code)
      .first<{ forecastId: string; modelLineageId: string | null }>();
    if (!predecessor) throw new Error("supersedesForecastId must identify a source forecast for this security");
    assertForecastSupersedesSameModelLineage(predecessor.modelLineageId, sourceAssertion.modelLineageId);
  }
  const normalized = normalizeSourceForecast({
    forecastId, institution: sourceAssertion.originDisplayName, sourceIdentityId: sourceAssertion.originSourceIdentityId,
    sourceIdentityAssertionId, originSourceIdentityId: sourceAssertion.originSourceIdentityId,
    carrierSourceIdentityId: sourceAssertion.carrierSourceIdentityId, carrierRelation: sourceAssertion.carrierRelation,
    modelLineageId: sourceAssertion.modelLineageId, independenceGroupId: sourceAssertion.independenceGroupId,
    forecastDate, metric, fiscalYear, rawValue, rawUnit,
    currency: normalizeCurrency(input.currency), accountingBasis, ownershipBasis, shareBasis, createdAt: now,
  });
  if (normalized.normalizationStatus !== "comparable") {
    throw new Error(`source forecast is not comparable: ${normalized.normalizationNotes || "needs review"}`);
  }
  await db.batch([
    reviewUpsertStatement(db, { reviewId, code, companyId, informationId: input.informationId,
      currentForecastId: knownReview?.currentForecastId ?? null, reviewStatus: "included", reviewReason: null, now }),
    db.prepare(`insert into research_source_forecasts (
      forecast_id, review_id, information_id, version_id, doc_id, security_code, company_id,
      institution, source_identity_id, source_identity_assertion_id, origin_source_identity_id, carrier_source_identity_id,
      carrier_relation, model_lineage_id, independence_group_id, analysts_json, forecast_date, metric, fiscal_year, fiscal_period, raw_value, raw_unit,
      currency, accounting_basis, ownership_basis, share_basis, normalized_value, normalized_unit,
      normalization_status, normalization_notes, source_statement, supersedes_forecast_id, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(forecastId, reviewId, input.informationId, candidate.versionId, candidate.docId, code, companyId,
        sourceAssertion.originDisplayName, sourceAssertion.originSourceIdentityId, sourceIdentityAssertionId,
        sourceAssertion.originSourceIdentityId, sourceAssertion.carrierSourceIdentityId, sourceAssertion.carrierRelation,
        sourceAssertion.modelLineageId, sourceAssertion.independenceGroupId, JSON.stringify(cleanAnalysts(input.analysts)), forecastDate, metric, fiscalYear, `${fiscalYear}FY`, rawValue,
        rawUnit, normalized.currency, accountingBasis, ownershipBasis, shareBasis, normalized.normalizedValue,
        normalized.normalizedUnit, normalized.normalizationStatus, normalized.normalizationNotes, candidate.statement,
        predecessorId, now),
    db.prepare(`update research_forecast_source_reviews set current_forecast_id=?, review_status='included', review_reason=null,
      company_id=?, reviewed_at=?, updated_at=? where review_id=?`).bind(forecastId, companyId, now, now, reviewId),
  ]);
  const snapshot = await persistForecastConsolidation(db, code, companyId);
  return { reviewId, forecastId, normalizationStatus: normalized.normalizationStatus,
    normalizationNotes: normalized.normalizationNotes, consolidationId: snapshot.consolidationId };
}

/**
 * Materializes third-party forecasts without a person in the runtime path.
 *
 * The job accepts an entry only when the saved source document itself carries
 * a strict original-carrier provenance contract and an exact measurement
 * contract for this immutable information record.  It never derives an
 * original provider, an independence group, a revision predecessor, a unit,
 * or an accounting basis from a publication label, URL, date, or prose.
 * Incomplete candidates become an automatically recorded exclusion so the
 * read model can state exactly which new machine-readable input is needed.
 */
export async function syncAutomaticThirdPartyForecastEvidence(db: D1Database, code: string) {
  const candidates = await listForecastCandidates(db, code);
  const identity = await db.prepare(`select company_id as companyId from research_listed_securities
    where security_code=? and mapping_status in ('confirmed','provisional')`).bind(code).first<{ companyId: string | null }>();
  const companyId = identity?.companyId ?? null;
  const now = Date.now();
  const results: Array<{ informationId: string; status: "included" | "blocked" | "preserved"; reason: string; forecastId?: string | null }> = [];

  for (const candidate of candidates) {
    // Do not replace a historical local decision or an earlier automatic
    // result.  A changed document creates a new immutable version/candidate,
    // which is the only supported path for recomputation.
    if (candidate.reviewId && (candidate.reviewedBy !== AUTOMATIC_FORECAST_ACTOR || candidate.reviewStatus === "included")) {
      results.push({ informationId: candidate.informationId, status: "preserved", reason: candidate.reviewReason || "existing_forecast_ledger_decision", forecastId: candidate.currentForecastId });
      continue;
    }

    const contract = parseAutomaticForecastEvidenceContract(candidate.metadataJson);
    if (!contract.ok) {
      await recordAutomaticForecastBlock(db, { code, companyId, candidate, reason: contract.reason, now });
      results.push({ informationId: candidate.informationId, status: "blocked", reason: contract.reason });
      continue;
    }
    const contractMeasurement = contract.value.measurements?.find((item) => item.informationId === candidate.informationId);
    const storedMeasurement = contractMeasurement
      ? null
      : parseStoredForecastMeasurement(candidate.measurementJson, candidate.period, candidate.publishedAt);
    const measurement = contractMeasurement ?? (storedMeasurement?.ok ? storedMeasurement.value : null);
    if (!measurement) {
      const reason = storedMeasurement && !storedMeasurement.ok
        ? storedMeasurement.reason
        : "forecast_measurement_contract_missing_for_information_record";
      await recordAutomaticForecastBlock(db, { code, companyId, candidate, reason, now });
      results.push({ informationId: candidate.informationId, status: "blocked", reason });
      continue;
    }
    if (measurement.fiscalYear < 1900 || measurement.fiscalYear > 2200 || !Number.isFinite(measurement.rawValue)
      || !FORECAST_METRICS.includes(candidate.category as ForecastMetric)
      || !forecastPeriodMatchesFiscalYear(candidate.period, measurement.fiscalYear)) {
      const reason = "forecast_measurement_contract_incomplete";
      await recordAutomaticForecastBlock(db, { code, companyId, candidate, reason, now });
      results.push({ informationId: candidate.informationId, status: "blocked", reason });
      continue;
    }
    if (measurement.accountingBasis === "unspecified"
      || ((candidate.category === "net_profit" || candidate.category === "net_profit_growth") && measurement.ownershipBasis === "unspecified")
      || (candidate.category === "eps" && measurement.shareBasis === "unspecified")) {
      const reason = "forecast_measurement_semantic_basis_incomplete";
      await recordAutomaticForecastBlock(db, { code, companyId, candidate, reason, now });
      results.push({ informationId: candidate.informationId, status: "blocked", reason });
      continue;
    }

    try {
      const sourceAssertion = await ensureAutomaticOriginalSourceAssertion(db, candidate, contract.value, now);
      const forecast = await writeAutomaticSourceForecast(db, {
        code, companyId, candidate, sourceIdentityAssertionId: sourceAssertion.sourceIdentityAssertionId,
        measurement, now,
      });
      results.push({ informationId: candidate.informationId, status: "included", reason: "source_bound_original_evidence_complete", forecastId: forecast.forecastId });
    } catch (error) {
      const reason = automaticForecastErrorReason(error);
      await recordAutomaticForecastBlock(db, { code, companyId, candidate, reason, now });
      results.push({ informationId: candidate.informationId, status: "blocked", reason });
    }
  }

  const consolidation = await persistForecastConsolidation(db, code, companyId);
  return {
    code,
    actor: AUTOMATIC_FORECAST_ACTOR,
    processedAt: now,
    included: results.filter((item) => item.status === "included").length,
    blocked: results.filter((item) => item.status === "blocked").length,
    preserved: results.filter((item) => item.status === "preserved").length,
    results,
    consolidationId: consolidation.consolidationId,
  };
}

/**
 * A self-built scenario is intentionally versioned and never merges into a
 * source forecast or its opportunistic sample consolidation.
 */
export async function saveForecastScenario(db: D1Database, code: string, input: ForecastScenarioWrite) {
  if (!isOneOf(input.scenarioName, ["downside", "base", "upside"] as const)) throw new Error("invalid scenarioName");
  if (!Array.isArray(input.assumptions) || !Array.isArray(input.outputs)) throw new Error("scenario assumptions and outputs must be arrays");
  if (!isOneOf(input.status ?? "draft", ["draft", "reviewed"] as const)) throw new Error("invalid scenario status");
  const identity = await db.prepare(`select company_id as companyId from research_listed_securities
    where security_code=? and mapping_status in ('confirmed','provisional')`).bind(code).first<{ companyId: string | null }>();
  const prior = await db.prepare(`select max(version) as version from research_forecast_scenarios
    where security_code=? and scenario_name=?`).bind(code, input.scenarioName).first<{ version: number | null }>();
  const now = Date.now();
  const scenarioId = `forecast-scenario:${crypto.randomUUID()}`;
  const version = Number(prior?.version ?? 0) + 1;
  await db.prepare(`insert into research_forecast_scenarios (
    scenario_id, security_code, company_id, scenario_name, version, assumptions_json, outputs_json,
    evidence_refs_json, status, created_at, updated_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(scenarioId, code, identity?.companyId ?? null, input.scenarioName, version,
      JSON.stringify(cleanStructuredList(input.assumptions)), JSON.stringify(cleanStructuredList(input.outputs)),
      JSON.stringify(cleanStructuredList(input.evidenceRefs ?? [])), input.status ?? "draft", now, now).run();
  return { scenarioId, version };
}

export async function persistForecastConsolidation(db: D1Database, code: string, companyId: string | null) {
  const sourceRows = await listCurrentSourceForecasts(db, code);
  const projection = buildForecastConsolidation(sourceRows.map(toDomainInput));
  const now = Date.now();
  const consolidationId = `forecast-consolidation:${crypto.randomUUID()}`;
  const statements: D1PreparedStatement[] = [
    db.prepare(`insert into research_forecast_consolidations (
      consolidation_id, security_code, company_id, as_of, label, source_universe, market_consensus, rule_version, created_at
    ) values (?, ?, ?, ?, ?, ?, 0, ?, ?)`)
      .bind(consolidationId, code, companyId, now, projection.label, projection.sourceUniverse, projection.ruleVersion, now),
  ];
  for (const group of projection.groups) {
    statements.push(db.prepare(`insert into research_forecast_consolidation_groups (
      group_id, consolidation_id, comparison_key, metric, fiscal_year, currency, normalized_unit,
      accounting_basis, ownership_basis, share_basis, sample_count, median_value, mean_value, min_value,
      max_value, standard_deviation, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(`forecast-group:${crypto.randomUUID()}`, consolidationId, group.comparisonKey, group.metric, group.fiscalYear,
        group.currency, group.normalizedUnit, group.accountingBasis, group.ownershipBasis, group.shareBasis,
        group.sampleCount, group.medianValue, group.meanValue, group.minValue, group.maxValue, group.standardDeviation, now));
  }
  for (const member of projection.members) {
    const forecast = sourceRows.find((item) => item.forecastId === member.forecastId);
    statements.push(db.prepare(`insert into research_forecast_consolidation_members (
      consolidation_id, forecast_id, comparison_key, membership_status, reason_code, source_identity_id, independence_group_id,
      source_identity_assertion_id, origin_source_identity_id, carrier_source_identity_id, carrier_relation, model_lineage_id, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(consolidationId, member.forecastId, member.comparisonKey, member.membershipStatus, member.reasonCode,
        forecast?.sourceIdentityId ?? null, forecast?.independenceGroupId ?? null, forecast?.sourceIdentityAssertionId ?? null,
        forecast?.originSourceIdentityId ?? null, forecast?.carrierSourceIdentityId ?? null, forecast?.carrierRelation ?? null,
        forecast?.modelLineageId ?? null, now));
  }
  await db.batch(statements);
  return { consolidationId, projection };
}

async function resolveResearchSubject(db: D1Database, code: string, security: SecurityRecord | null) {
  const row = await db.prepare(`select s.security_code as securityCode, s.company_id as companyId, s.venue,
      s.trading_currency as tradingCurrency, s.share_class as shareClass, s.depositary_ratio as depositaryRatio,
      s.mapping_status as mappingStatus, s.mapping_basis as mappingBasis, c.canonical_name as companyName,
      c.reporting_currency as reportingCurrency, c.fiscal_year_end as fiscalYearEnd, c.identity_status as identityStatus
    from research_listed_securities s left join research_operating_companies c on c.company_id=s.company_id
    where s.security_code=?`).bind(code).first<Record<string, unknown>>();
  const mapped = row?.companyId && row.mappingStatus !== "unresolved";
  return {
    operatingCompany: mapped ? {
      companyId: row.companyId, canonicalName: row.companyName, reportingCurrency: row.reportingCurrency,
      fiscalYearEnd: row.fiscalYearEnd, identityStatus: row.identityStatus,
    } : null,
    listedSecurity: {
      code,
      name: security?.name ?? code,
      venue: row?.venue ?? securityMarket(code),
      tradingCurrency: row?.tradingCurrency ?? security?.currency ?? null,
      expectedTradingCurrency: expectedTradingCurrency(code),
      shareClass: row?.shareClass ?? null,
      depositaryRatio: row?.depositaryRatio ?? null,
      mappingStatus: row?.mappingStatus ?? "unresolved",
      mappingBasis: row?.mappingBasis ?? null,
    },
    analysisScopeStatus: mapped ? row.mappingStatus : "unresolved",
    blockingGaps: mapped ? [] : ["经营公司与上市证券尚未建立经确认的映射；公司级共享研究和跨市场比较保持不可用。"],
  };
}

function expectedTradingCurrency(code: string): "CNY" | "HKD" | "USD" {
  const market = securityMarket(code);
  return market === "hk" ? "HKD" : market === "us" ? "USD" : "CNY";
}

async function listForecastCandidates(db: D1Database, code: string): Promise<ForecastCandidateRow[]> {
  const rows = await db.prepare(`${forecastCandidateSelect()}
    and d.target_code_normalized=? and record.information_type='forecast'
    order by d.published_at desc, record.sort_order, record.information_id`).bind(code).all<ForecastCandidateRow>();
  return rows.results.filter(isPresentableForecastRow);
}

async function getForecastCandidate(db: D1Database, code: string, informationId: string): Promise<ForecastCandidateRow | null> {
  const candidate = await db.prepare(`${forecastCandidateSelect()}
    and d.target_code_normalized=? and record.information_id=? and record.information_type='forecast'`)
    .bind(code, informationId).first<ForecastCandidateRow>();
  return candidate && isPresentableForecastRow(candidate) ? candidate : null;
}

async function getConfirmedForecastSourceIdentity(db: D1Database, sourceIdentityId: string) {
  const identity = await db.prepare(`select identity.source_identity_id as sourceIdentityId, identity.display_name as displayName,
      identity.independence_group_id as independenceGroupId
    from research_forecast_source_identities identity
    join research_forecast_source_independence_groups source_group
      on source_group.independence_group_id=identity.independence_group_id
    where identity.source_identity_id=? and identity.identity_status='confirmed' and source_group.status='confirmed'`)
    .bind(sourceIdentityId).first<{ sourceIdentityId: string; displayName: string; independenceGroupId: string }>();
  if (!identity) throw new Error("sourceIdentityId must identify a confirmed source identity in a confirmed independence group");
  return identity;
}

async function getConfirmedForecastModelLineage(db: D1Database, modelLineageId: string) {
  const lineage = await db.prepare(`select model_lineage_id as modelLineageId, origin_source_identity_id as originSourceIdentityId
    from research_forecast_model_lineages where model_lineage_id=? and lineage_status='confirmed'`).bind(modelLineageId)
    .first<{ modelLineageId: string; originSourceIdentityId: string }>();
  if (!lineage) throw new Error("modelLineageId must identify a confirmed forecast model lineage");
  return lineage;
}

async function getConfirmedForecastSourceIdentityAssertion(
  db: D1Database,
  sourceIdentityAssertionId: string,
  candidate: Pick<ForecastCandidateRow, "docId" | "versionId" | "contentHash">,
) {
  const assertion = await db.prepare(`select assertion.source_identity_assertion_id as sourceIdentityAssertionId,
      assertion.doc_id as docId, assertion.version_id as versionId, assertion.content_hash as contentHash,
      assertion.carrier_source_identity_id as carrierSourceIdentityId, assertion.origin_source_identity_id as originSourceIdentityId,
      assertion.model_lineage_id as modelLineageId, assertion.carrier_relation as carrierRelation,
      origin.display_name as originDisplayName, carrier.display_name as carrierDisplayName,
      source_group.independence_group_id as independenceGroupId
    from research_forecast_source_identity_assertions assertion
    join research_forecast_source_identities carrier on carrier.source_identity_id=assertion.carrier_source_identity_id
    left join research_forecast_source_identities origin on origin.source_identity_id=assertion.origin_source_identity_id
    left join research_forecast_source_independence_groups source_group on source_group.independence_group_id=origin.independence_group_id
    left join research_forecast_model_lineages lineage on lineage.model_lineage_id=assertion.model_lineage_id
    where assertion.source_identity_assertion_id=? and assertion.assertion_status='confirmed'
      and carrier.identity_status='confirmed'
      and (assertion.origin_source_identity_id is null or (origin.identity_status='confirmed' and source_group.status='confirmed'
        and lineage.lineage_status='confirmed' and lineage.origin_source_identity_id=assertion.origin_source_identity_id))`)
    .bind(sourceIdentityAssertionId).first<{
      sourceIdentityAssertionId: string; docId: string; versionId: string; contentHash: string;
      carrierSourceIdentityId: string; originSourceIdentityId: string | null; modelLineageId: string | null;
      carrierRelation: ForecastCarrierRelation; originDisplayName: string | null; carrierDisplayName: string; independenceGroupId: string | null;
    }>();
  if (!assertion) throw new Error("sourceIdentityAssertionId must identify a confirmed source identity assertion");
  if (assertion.docId !== candidate.docId || assertion.versionId !== candidate.versionId || assertion.contentHash !== candidate.contentHash) {
    throw new Error("sourceIdentityAssertionId must bind this exact candidate document version and content hash");
  }
  if (assertion.carrierRelation === "unknown") {
    return { ...assertion, originDisplayName: assertion.carrierDisplayName, originSourceIdentityId: null, modelLineageId: null, independenceGroupId: null };
  }
  if (!assertion.originSourceIdentityId || !assertion.modelLineageId || !assertion.independenceGroupId || !assertion.originDisplayName) {
    throw new Error("sourceIdentityAssertionId has incomplete origin or model lineage");
  }
  return { ...assertion, originDisplayName: assertion.originDisplayName };
}

async function assertEvidenceDoc(db: D1Database, evidenceDocId: string) {
  const evidenceDoc = await db.prepare(`select doc_id as docId from knowledge_docs where doc_id=?`).bind(evidenceDocId).first<{ docId: string }>();
  if (!evidenceDoc) throw new Error("evidenceDocId must identify an existing knowledge document");
}

function forecastCandidateSelect(): string {
  return `select record.information_id as informationId, result.result_id as resultId,
      run.run_id as processingRunId, run.model as processingModel,
      run.prompt_version as processingPromptVersion, run.schema_version as processingSchemaVersion,
      run.ontology_version as processingOntologyVersion, run.input_hash as processingInputHash, run.completed_at as processingCompletedAt,
      record.entity, record.information_type as informationType,
      record.category, record.period, record.statement, record.forecast_measurement_json as measurementJson, result.outcome as resultOutcome,
      version.version_id as versionId, version.content_hash as contentHash, d.doc_id as docId, d.title,
      d.source_name as sourceName, d.source_type as sourceType, d.report_type as reportType, d.discovery_method as discoveryMethod, d.metadata_json as metadataJson,
      d.published_at as publishedAt, coalesce(version.source_url, d.url) as sourceUrl, content.content_url as contentUrl,
      review.review_id as reviewId, review.review_status as reviewStatus, review.review_reason as reviewReason,
      review.current_forecast_id as currentForecastId, review.reviewed_at as reviewedAt, review.reviewed_by as reviewedBy
    from knowledge_information_records record
    join knowledge_document_results result on result.result_id=record.result_id
    join knowledge_processing_runs run on run.run_id=result.run_id
    join knowledge_document_versions version on version.version_id=result.version_id
    join knowledge_docs d on d.doc_id=version.doc_id
    left join knowledge_doc_content_refs content on content.doc_id=d.doc_id
    left join research_forecast_source_reviews review on review.information_id=record.information_id
      and review.security_code=d.target_code_normalized
    where version.version_id=(select v2.version_id from knowledge_document_versions v2 where v2.doc_id=d.doc_id
      order by v2.created_at desc, v2.version_id desc limit 1)
      and result.result_id=(select r2.result_id from knowledge_document_results r2 where r2.version_id=version.version_id
      order by r2.created_at desc, r2.result_id desc limit 1)`;
}

async function listCurrentSourceForecasts(db: D1Database, code: string): Promise<SourceForecastRow[]> {
  const rows = await db.prepare(`select f.forecast_id as forecastId, f.review_id as reviewId,
      f.information_id as informationId, f.version_id as versionId, f.doc_id as docId,
      f.security_code as securityCode, f.company_id as companyId, f.institution, f.source_identity_id as sourceIdentityId,
      f.source_identity_assertion_id as sourceIdentityAssertionId, f.origin_source_identity_id as originSourceIdentityId,
      f.carrier_source_identity_id as carrierSourceIdentityId, f.carrier_relation as carrierRelation, f.model_lineage_id as modelLineageId,
      source_identity.identity_type as sourceIdentityType, f.independence_group_id as independenceGroupId,
      source_group.canonical_name as independenceGroupName, source_identity.evidence_url as sourceIdentityEvidenceUrl,
      source_identity.evidence_title as sourceIdentityEvidenceTitle, f.analysts_json as analystsJson,
      f.forecast_date as forecastDate, f.metric, f.fiscal_year as fiscalYear, f.fiscal_period as fiscalPeriod,
      f.raw_value as rawValue, f.raw_unit as rawUnit, f.currency, f.accounting_basis as accountingBasis,
      f.ownership_basis as ownershipBasis, f.share_basis as shareBasis, f.normalized_value as normalizedValue,
      f.normalized_unit as normalizedUnit, f.normalization_status as normalizationStatus,
      f.normalization_notes as normalizationNotes, f.source_statement as sourceStatement,
      f.supersedes_forecast_id as supersedesForecastId, f.created_at as createdAt,
      d.title, d.source_name as sourceName, coalesce(v.source_url, d.url, content.content_url) as sourceUrl,
      d.discovery_method as discoveryMethod, d.metadata_json as metadataJson
    from research_forecast_source_reviews review
    join research_source_forecasts f on f.forecast_id=review.current_forecast_id
    join knowledge_document_versions v on v.version_id=f.version_id
    join knowledge_docs d on d.doc_id=f.doc_id
    left join knowledge_doc_content_refs content on content.doc_id=d.doc_id
    left join research_forecast_source_identities source_identity on source_identity.source_identity_id=f.origin_source_identity_id
    left join research_forecast_source_independence_groups source_group on source_group.independence_group_id=f.independence_group_id
    where review.security_code=? and review.review_status='included'
    order by f.forecast_date desc, f.created_at desc`).bind(code).all<SourceForecastRow>();
  return rows.results.filter(isPresentableForecastRow);
}

/**
 * Keeps every immutable source-forecast version available to the derived
 * revision read model.  The regular samples list intentionally stays limited
 * to current review heads, so historical values cannot accidentally enter a
 * fresh included-sample consolidation.
 */
async function listForecastRevisionHistory(db: D1Database, code: string): Promise<SourceForecastRow[]> {
  const rows = await db.prepare(`select f.forecast_id as forecastId, f.review_id as reviewId,
      f.information_id as informationId, f.version_id as versionId, f.doc_id as docId,
      f.security_code as securityCode, f.company_id as companyId, f.institution, f.source_identity_id as sourceIdentityId,
      f.source_identity_assertion_id as sourceIdentityAssertionId, f.origin_source_identity_id as originSourceIdentityId,
      f.carrier_source_identity_id as carrierSourceIdentityId, f.carrier_relation as carrierRelation, f.model_lineage_id as modelLineageId,
      source_identity.identity_type as sourceIdentityType, f.independence_group_id as independenceGroupId,
      source_group.canonical_name as independenceGroupName, source_identity.evidence_url as sourceIdentityEvidenceUrl,
      source_identity.evidence_title as sourceIdentityEvidenceTitle, f.analysts_json as analystsJson,
      f.forecast_date as forecastDate, f.metric, f.fiscal_year as fiscalYear, f.fiscal_period as fiscalPeriod,
      f.raw_value as rawValue, f.raw_unit as rawUnit, f.currency, f.accounting_basis as accountingBasis,
      f.ownership_basis as ownershipBasis, f.share_basis as shareBasis, f.normalized_value as normalizedValue,
      f.normalized_unit as normalizedUnit, f.normalization_status as normalizationStatus,
      f.normalization_notes as normalizationNotes, f.source_statement as sourceStatement,
      f.supersedes_forecast_id as supersedesForecastId, f.created_at as createdAt,
      d.title, d.source_name as sourceName, coalesce(v.source_url, d.url, content.content_url) as sourceUrl,
      case when review.current_forecast_id=f.forecast_id and review.review_status='included' then 1 else 0 end as isCurrent,
      d.discovery_method as discoveryMethod, d.metadata_json as metadataJson
    from research_source_forecasts f
    join knowledge_document_versions v on v.version_id=f.version_id
    join knowledge_docs d on d.doc_id=f.doc_id
    left join knowledge_doc_content_refs content on content.doc_id=d.doc_id
    left join research_forecast_source_identities source_identity on source_identity.source_identity_id=f.origin_source_identity_id
    left join research_forecast_source_independence_groups source_group on source_group.independence_group_id=f.independence_group_id
    left join research_forecast_source_reviews review on review.review_id=f.review_id
    where f.security_code=?
    order by f.forecast_date asc, f.created_at asc, f.forecast_id asc`).bind(code).all<SourceForecastRow>();
  return rows.results.filter(isPresentableForecastRow);
}

async function loadLatestConsolidation(db: D1Database, code: string) {
  const header = await db.prepare(`select consolidation_id as consolidationId, as_of as asOf, label,
      source_universe as sourceUniverse, market_consensus as marketConsensus, rule_version as ruleVersion, created_at as createdAt
    from research_forecast_consolidations where security_code=? order by as_of desc, created_at desc limit 1`)
    .bind(code).first<Record<string, unknown>>();
  if (!header) return null;
  const id = String(header.consolidationId);
  // v2 deduplicated free-text institution labels.  It has no reviewed source
  // identity/group proof and must be re-frozen rather than silently shown as
  // a valid aggregation after the v3 rule took effect.
  const requiresIdentityRefreeze = header.ruleVersion !== FORECAST_CONSOLIDATION_RULE_VERSION;
  if (requiresIdentityRefreeze) return {
    consolidationId: id,
    asOf: Number(header.asOf),
    label: String(header.label),
    sourceUniverse: String(header.sourceUniverse),
    marketConsensus: Boolean(header.marketConsensus),
    ruleVersion: String(header.ruleVersion),
    createdAt: Number(header.createdAt),
    groups: [],
    members: [],
    requiresIdentityRefreeze: true,
  };
  const [groups, members] = await Promise.all([
    db.prepare(`select comparison_key as comparisonKey, metric, fiscal_year as fiscalYear, currency,
      normalized_unit as normalizedUnit, accounting_basis as accountingBasis, ownership_basis as ownershipBasis,
      share_basis as shareBasis, sample_count as sampleCount, median_value as medianValue, mean_value as meanValue,
      min_value as minValue, max_value as maxValue, standard_deviation as standardDeviation
      from research_forecast_consolidation_groups where consolidation_id=? order by fiscal_year, metric, comparison_key`).bind(id).all<Record<string, unknown>>(),
    db.prepare(`select forecast_id as forecastId, comparison_key as comparisonKey, membership_status as membershipStatus,
      reason_code as reasonCode, source_identity_id as sourceIdentityId, independence_group_id as independenceGroupId,
      source_identity_assertion_id as sourceIdentityAssertionId, origin_source_identity_id as originSourceIdentityId,
      carrier_source_identity_id as carrierSourceIdentityId, carrier_relation as carrierRelation, model_lineage_id as modelLineageId
      from research_forecast_consolidation_members where consolidation_id=? order by forecast_id`).bind(id).all<Record<string, unknown>>(),
  ]);
  return {
    consolidationId: id,
    asOf: Number(header.asOf),
    label: String(header.label),
    sourceUniverse: String(header.sourceUniverse),
    marketConsensus: Boolean(header.marketConsensus),
    ruleVersion: String(header.ruleVersion),
    createdAt: Number(header.createdAt),
    requiresIdentityRefreeze: false,
    groups: groups.results,
    members: members.results,
  };
}

async function upsertReview(db: D1Database, input: {
  reviewId: string; code: string; companyId: string | null; informationId: string; currentForecastId: string | null;
  reviewStatus: ForecastReviewWrite["reviewStatus"]; reviewReason: string | null; now: number;
}) {
  await reviewUpsertStatement(db, input).run();
}

function reviewUpsertStatement(db: D1Database, input: {
  reviewId: string; code: string; companyId: string | null; informationId: string; currentForecastId: string | null;
  reviewStatus: ForecastReviewWrite["reviewStatus"]; reviewReason: string | null; now: number;
}): D1PreparedStatement {
  return db.prepare(`insert into research_forecast_source_reviews (
      review_id, security_code, company_id, information_id, current_forecast_id, review_status, review_reason,
      reviewed_by, reviewed_at, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, 'local-user', ?, ?, ?)
    on conflict(security_code, information_id) do update set company_id=excluded.company_id,
      current_forecast_id=excluded.current_forecast_id, review_status=excluded.review_status,
      review_reason=excluded.review_reason, reviewed_by=excluded.reviewed_by,
      reviewed_at=excluded.reviewed_at, updated_at=excluded.updated_at`)
    .bind(input.reviewId, input.code, input.companyId, input.informationId, input.currentForecastId,
      input.reviewStatus, input.reviewReason, input.now, input.now, input.now);
}

async function recordAutomaticForecastBlock(db: D1Database, input: {
  code: string; companyId: string | null; candidate: ForecastCandidateRow; reason: string; now: number;
}) {
  const reviewId = input.candidate.reviewId ?? `forecast-auto-gate:${crypto.randomUUID()}`;
  await automaticReviewUpsertStatement(db, {
    reviewId, code: input.code, companyId: input.companyId, informationId: input.candidate.informationId,
    currentForecastId: null, reviewStatus: "excluded", reviewReason: input.reason, now: input.now,
  }).run();
}

async function ensureAutomaticOriginalSourceAssertion(
  db: D1Database,
  candidate: ForecastCandidateRow,
  contract: AutomaticForecastEvidenceContract,
  now: number,
) {
  const origin = contract.origin;
  const group = await db.prepare(`select independence_group_id as independenceGroupId
    from research_forecast_source_independence_groups
    where lower(canonical_name)=lower(?) and status='confirmed'`).bind(origin.independenceGroupName)
    .first<{ independenceGroupId: string }>();
  const independenceGroupId = group?.independenceGroupId ?? `forecast-source-group:${crypto.randomUUID()}`;
  if (!group) {
    await db.prepare(`insert into research_forecast_source_independence_groups (
      independence_group_id, canonical_name, status, created_by, created_at
    ) values (?, ?, 'confirmed', ?, ?)`)
      .bind(independenceGroupId, origin.independenceGroupName, AUTOMATIC_FORECAST_ACTOR, now).run();
  }
  const knownIdentity = await db.prepare(`select source_identity_id as sourceIdentityId
    from research_forecast_source_identities
    where lower(display_name)=lower(?) and identity_type=? and independence_group_id=? and identity_status='confirmed'`)
    .bind(origin.displayName, origin.identityType, independenceGroupId).first<{ sourceIdentityId: string }>();
  const sourceIdentityId = knownIdentity?.sourceIdentityId ?? `forecast-source-identity:${crypto.randomUUID()}`;
  if (!knownIdentity) {
    await db.prepare(`insert into research_forecast_source_identities (
      source_identity_id, display_name, identity_type, independence_group_id, evidence_url, evidence_title,
      evidence_doc_id, identity_status, created_by, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?)`)
      .bind(sourceIdentityId, origin.displayName, origin.identityType, independenceGroupId, origin.evidenceUrl,
        origin.evidenceTitle, candidate.docId, AUTOMATIC_FORECAST_ACTOR, now).run();
  }
  const knownLineage = await db.prepare(`select model_lineage_id as modelLineageId
    from research_forecast_model_lineages
    where origin_source_identity_id=? and lower(lineage_name)=lower(?) and lineage_status='confirmed'`)
    .bind(sourceIdentityId, contract.modelLineage.lineageName).first<{ modelLineageId: string }>();
  const modelLineageId = knownLineage?.modelLineageId ?? `forecast-model-lineage:${crypto.randomUUID()}`;
  if (!knownLineage) {
    await db.prepare(`insert into research_forecast_model_lineages (
      model_lineage_id, origin_source_identity_id, lineage_name, evidence_url, evidence_title, evidence_doc_id,
      lineage_status, created_by, created_at
    ) values (?, ?, ?, ?, ?, ?, 'confirmed', ?, ?)`)
      .bind(modelLineageId, sourceIdentityId, contract.modelLineage.lineageName, contract.modelLineage.evidenceUrl,
        contract.modelLineage.evidenceTitle, candidate.docId, AUTOMATIC_FORECAST_ACTOR, now).run();
  }
  const existing = await db.prepare(`select source_identity_assertion_id as sourceIdentityAssertionId,
      carrier_source_identity_id as carrierSourceIdentityId, origin_source_identity_id as originSourceIdentityId,
      model_lineage_id as modelLineageId, carrier_relation as carrierRelation, assertion_status as assertionStatus
    from research_forecast_source_identity_assertions where doc_id=? and version_id=?`)
    .bind(candidate.docId, candidate.versionId).first<{
      sourceIdentityAssertionId: string; carrierSourceIdentityId: string; originSourceIdentityId: string | null;
      modelLineageId: string | null; carrierRelation: ForecastCarrierRelation; assertionStatus: string;
    }>();
  if (existing) {
    if (existing.assertionStatus !== "confirmed" || existing.carrierRelation !== "original"
      || existing.carrierSourceIdentityId !== sourceIdentityId || existing.originSourceIdentityId !== sourceIdentityId
      || existing.modelLineageId !== modelLineageId) {
      throw new Error("source_identity_assertion_conflicts_with_existing_document_version");
    }
    return { sourceIdentityAssertionId: existing.sourceIdentityAssertionId, sourceIdentityId, modelLineageId, independenceGroupId };
  }
  const sourceIdentityAssertionId = `forecast-source-assertion:${crypto.randomUUID()}`;
  await db.prepare(`insert into research_forecast_source_identity_assertions (
    source_identity_assertion_id, doc_id, version_id, content_hash, carrier_source_identity_id, origin_source_identity_id,
    model_lineage_id, carrier_relation, evidence_url, evidence_title, evidence_doc_id, assertion_status, created_by, created_at
  ) values (?, ?, ?, ?, ?, ?, ?, 'original', ?, ?, ?, 'confirmed', ?, ?)`)
    .bind(sourceIdentityAssertionId, candidate.docId, candidate.versionId, candidate.contentHash, sourceIdentityId,
      sourceIdentityId, modelLineageId, origin.evidenceUrl, origin.evidenceTitle, candidate.docId,
      AUTOMATIC_FORECAST_ACTOR, now).run();
  return { sourceIdentityAssertionId, sourceIdentityId, modelLineageId, independenceGroupId };
}

async function writeAutomaticSourceForecast(db: D1Database, input: {
  code: string; companyId: string | null; candidate: ForecastCandidateRow; sourceIdentityAssertionId: string;
  measurement: AutomaticForecastMeasurement; now: number;
}) {
  const assertion = await getConfirmedForecastSourceIdentityAssertion(db, input.sourceIdentityAssertionId, input.candidate);
  const forecastDate = normalizeDate(input.measurement.forecastDate);
  if (!forecastDate) throw new Error("forecast_date_missing_or_invalid");
  const metric = requireEnum(input.candidate.category, FORECAST_METRICS, "metric");
  const rawUnit = requireEnum(input.measurement.rawUnit, FORECAST_RAW_UNITS, "rawUnit");
  const normalized = normalizeSourceForecast({
    forecastId: "automatic-source-forecast", institution: assertion.originDisplayName,
    sourceIdentityId: assertion.originSourceIdentityId, sourceIdentityAssertionId: input.sourceIdentityAssertionId,
    originSourceIdentityId: assertion.originSourceIdentityId, carrierSourceIdentityId: assertion.carrierSourceIdentityId,
    carrierRelation: assertion.carrierRelation, modelLineageId: assertion.modelLineageId,
    independenceGroupId: assertion.independenceGroupId, forecastDate, metric, fiscalYear: input.measurement.fiscalYear,
    rawValue: input.measurement.rawValue, rawUnit, currency: normalizeCurrency(input.measurement.currency),
    accountingBasis: input.measurement.accountingBasis, ownershipBasis: input.measurement.ownershipBasis,
    shareBasis: input.measurement.shareBasis, createdAt: input.now,
  });
  if (normalized.normalizationStatus !== "comparable") throw new Error(normalized.normalizationNotes || "forecast_measurement_not_comparable");
  const predecessorId = normalizeOptionalId(input.measurement.supersedesForecastId);
  if (predecessorId) {
    const predecessor = await db.prepare(`select model_lineage_id as modelLineageId from research_source_forecasts
      where forecast_id=? and security_code=?`).bind(predecessorId, input.code).first<{ modelLineageId: string | null }>();
    if (!predecessor) throw new Error("supersedes_forecast_not_found_for_security");
    assertForecastSupersedesSameModelLineage(predecessor.modelLineageId, assertion.modelLineageId);
  }
  const forecastId = `source-forecast:${crypto.randomUUID()}`;
  const reviewId = input.candidate.reviewId ?? `forecast-auto-review:${crypto.randomUUID()}`;
  await db.batch([
    automaticReviewUpsertStatement(db, {
      reviewId, code: input.code, companyId: input.companyId, informationId: input.candidate.informationId,
      currentForecastId: input.candidate.currentForecastId, reviewStatus: "included", reviewReason: null, now: input.now,
    }),
    db.prepare(`insert into research_source_forecasts (
      forecast_id, review_id, information_id, version_id, doc_id, security_code, company_id,
      institution, source_identity_id, source_identity_assertion_id, origin_source_identity_id, carrier_source_identity_id,
      carrier_relation, model_lineage_id, independence_group_id, analysts_json, forecast_date, metric, fiscal_year, fiscal_period, raw_value, raw_unit,
      currency, accounting_basis, ownership_basis, share_basis, normalized_value, normalized_unit,
      normalization_status, normalization_notes, source_statement, supersedes_forecast_id, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(forecastId, reviewId, input.candidate.informationId, input.candidate.versionId, input.candidate.docId,
        input.code, input.companyId, assertion.originDisplayName, assertion.originSourceIdentityId,
        input.sourceIdentityAssertionId, assertion.originSourceIdentityId, assertion.carrierSourceIdentityId,
        assertion.carrierRelation, assertion.modelLineageId, assertion.independenceGroupId,
        JSON.stringify(cleanAnalysts(input.measurement.analysts)), forecastDate, metric, input.measurement.fiscalYear,
        `${input.measurement.fiscalYear}FY`, input.measurement.rawValue, rawUnit, normalized.currency,
        input.measurement.accountingBasis, input.measurement.ownershipBasis, input.measurement.shareBasis,
        normalized.normalizedValue, normalized.normalizedUnit, normalized.normalizationStatus,
        normalized.normalizationNotes, input.candidate.statement, predecessorId, input.now),
    db.prepare(`update research_forecast_source_reviews set current_forecast_id=?, review_status='included', review_reason=null,
      company_id=?, reviewed_by=?, reviewed_at=?, updated_at=? where review_id=?`)
      .bind(forecastId, input.companyId, AUTOMATIC_FORECAST_ACTOR, input.now, input.now, reviewId),
  ]);
  return { forecastId };
}

function automaticReviewUpsertStatement(db: D1Database, input: {
  reviewId: string; code: string; companyId: string | null; informationId: string; currentForecastId: string | null;
  reviewStatus: ForecastReviewWrite["reviewStatus"]; reviewReason: string | null; now: number;
}) {
  return db.prepare(`insert into research_forecast_source_reviews (
    review_id, security_code, company_id, information_id, current_forecast_id, review_status, review_reason,
    reviewed_by, reviewed_at, created_at, updated_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  on conflict(security_code, information_id) do update set company_id=excluded.company_id,
    current_forecast_id=excluded.current_forecast_id, review_status=excluded.review_status,
    review_reason=excluded.review_reason, reviewed_by=excluded.reviewed_by,
    reviewed_at=excluded.reviewed_at, updated_at=excluded.updated_at`)
    .bind(input.reviewId, input.code, input.companyId, input.informationId, input.currentForecastId,
      input.reviewStatus, input.reviewReason, AUTOMATIC_FORECAST_ACTOR, input.now, input.now, input.now);
}

function parseAutomaticForecastEvidenceContract(value: unknown):
  | { ok: true; value: AutomaticForecastEvidenceContract }
  | { ok: false; reason: string } {
  let metadata: Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(value || "{}"));
    if (!isPlainRecord(parsed)) return { ok: false, reason: "forecast_provenance_contract_missing" };
    metadata = parsed;
  } catch {
    return { ok: false, reason: "forecast_provenance_contract_missing" };
  }
  const source = metadata.researchForecastEvidence;
  if (!isPlainRecord(source) || source.schemaVersion !== "research-source-forecast.v1") {
    return { ok: false, reason: "forecast_provenance_contract_missing" };
  }
  if (source.carrierRelation !== "original") return { ok: false, reason: "source_carrier_not_explicitly_original" };
  const origin = source.origin;
  const modelLineage = source.modelLineage;
  if (!isPlainRecord(origin) || !isPlainRecord(modelLineage)) return { ok: false, reason: "source_identity_assertion_unresolved" };
  if (!nonemptyText(origin.displayName) || !nonemptyText(origin.independenceGroupName)
    || !isOneOf(origin.identityType, FORECAST_SOURCE_IDENTITY_TYPES)
    || !isHttpsUrl(origin.evidenceUrl) || !nonemptyText(origin.evidenceTitle)) {
    return { ok: false, reason: "source_identity_assertion_unresolved" };
  }
  if (!nonemptyText(modelLineage.lineageName) || !isHttpsUrl(modelLineage.evidenceUrl) || !nonemptyText(modelLineage.evidenceTitle)) {
    return { ok: false, reason: "source_model_lineage_unresolved" };
  }
  if (source.measurements !== undefined && (!Array.isArray(source.measurements) || source.measurements.length > 100)) {
    return { ok: false, reason: "forecast_measurement_contract_incomplete" };
  }
  const measurements: AutomaticForecastMeasurement[] = [];
  for (const item of source.measurements ?? []) {
    if (!isPlainRecord(item) || !nonemptyText(item.informationId) || !nonemptyText(item.forecastDate)
      || !Number.isInteger(item.fiscalYear) || !Number.isFinite(item.rawValue)
      || !isOneOf(item.rawUnit, FORECAST_RAW_UNITS) || !isOneOf(item.accountingBasis, FORECAST_ACCOUNTING_BASES)
      || !isOneOf(item.ownershipBasis, FORECAST_OWNERSHIP_BASES) || !isOneOf(item.shareBasis, FORECAST_SHARE_BASES)
      || (item.currency !== undefined && item.currency !== null && !nonemptyText(item.currency))
      || (item.analysts !== undefined && (!Array.isArray(item.analysts) || item.analysts.some((name) => !nonemptyText(name))))
      || (item.supersedesForecastId !== undefined && item.supersedesForecastId !== null && !nonemptyText(item.supersedesForecastId))) {
      return { ok: false, reason: "forecast_measurement_contract_incomplete" };
    }
    measurements.push({
      informationId: String(item.informationId).trim(), forecastDate: String(item.forecastDate).trim(),
      fiscalYear: Number(item.fiscalYear), rawValue: Number(item.rawValue), rawUnit: item.rawUnit as ForecastRawUnit,
      currency: item.currency === undefined || item.currency === null ? null : String(item.currency).trim(),
      accountingBasis: item.accountingBasis as ForecastAccountingBasis,
      ownershipBasis: item.ownershipBasis as ForecastOwnershipBasis, shareBasis: item.shareBasis as ForecastShareBasis,
      analysts: Array.isArray(item.analysts) ? item.analysts.map((name) => String(name).trim()) : undefined,
      supersedesForecastId: item.supersedesForecastId === undefined || item.supersedesForecastId === null
        ? null : String(item.supersedesForecastId).trim(),
    });
  }
  return {
    ok: true,
    value: {
      schemaVersion: "research-source-forecast.v1", carrierRelation: "original",
      origin: {
        displayName: String(origin.displayName).trim(), identityType: origin.identityType as ForecastSourceIdentityType,
        independenceGroupName: String(origin.independenceGroupName).trim(), evidenceUrl: String(origin.evidenceUrl).trim(),
        evidenceTitle: String(origin.evidenceTitle).trim(),
      },
      modelLineage: {
        lineageName: String(modelLineage.lineageName).trim(), evidenceUrl: String(modelLineage.evidenceUrl).trim(),
        evidenceTitle: String(modelLineage.evidenceTitle).trim(),
      },
      measurements: measurements.length > 0 ? measurements : undefined,
    },
  };
}

/**
 * Forecast numbers are extracted by the information processor, not inferred
 * from prose at ledger-sync time.  The direct document date is the only
 * eligible forecast date for this path; metadata remains the separate,
 * mandatory source-identity and original-carrier contract.
 */
function parseStoredForecastMeasurement(
  value: string | null,
  period: string | null,
  publishedAt: string | null,
): { ok: true; value: AutomaticForecastMeasurement } | { ok: false; reason: string } {
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(value || "{}"));
    if (!isPlainRecord(parsed) || Object.keys(parsed).length === 0) {
      return { ok: false, reason: "forecast_measurement_contract_missing_for_information_record" };
    }
    raw = parsed;
  } catch {
    return { ok: false, reason: "forecast_measurement_contract_incomplete" };
  }
  if (!Number.isInteger(raw.fiscalYear) || !Number.isFinite(raw.rawValue)
    || !isOneOf(raw.rawUnit, FORECAST_RAW_UNITS) || !isOneOf(raw.accountingBasis, FORECAST_ACCOUNTING_BASES)
    || !isOneOf(raw.ownershipBasis, FORECAST_OWNERSHIP_BASES) || !isOneOf(raw.shareBasis, FORECAST_SHARE_BASES)
    || (raw.currency !== undefined && raw.currency !== null && !nonemptyText(raw.currency))) {
    return { ok: false, reason: "forecast_measurement_contract_incomplete" };
  }
  const fiscalYear = Number(raw.fiscalYear);
  if (fiscalYear < 1900 || fiscalYear > 2200 || !forecastPeriodMatchesFiscalYear(period, fiscalYear)) {
    return { ok: false, reason: "forecast_measurement_contract_incomplete" };
  }
  const forecastDate = normalizeDate(publishedAt ?? "");
  if (!forecastDate) return { ok: false, reason: "forecast_date_missing_or_invalid" };
  return {
    ok: true,
    value: {
      informationId: "stored-information-record",
      forecastDate,
      fiscalYear,
      rawValue: Number(raw.rawValue),
      rawUnit: raw.rawUnit as ForecastRawUnit,
      currency: raw.currency === undefined || raw.currency === null ? null : String(raw.currency).trim(),
      accountingBasis: raw.accountingBasis as ForecastAccountingBasis,
      ownershipBasis: raw.ownershipBasis as ForecastOwnershipBasis,
      shareBasis: raw.shareBasis as ForecastShareBasis,
    },
  };
}

function forecastPeriodMatchesFiscalYear(period: string | null, fiscalYear: number): boolean {
  return period === `${fiscalYear}FY` || period === `${fiscalYear}Q1`
    || period === `${fiscalYear}Q2` || period === `${fiscalYear}Q3` || period === `${fiscalYear}Q4`;
}

function automaticForecastErrorReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/^(source_identity_assertion_conflicts_with_existing_document_version|forecast_date_missing_or_invalid|supersedes_forecast_not_found_for_security)$/.test(message)) return message;
  if (/source identity assertion|sourceIdentityAssertionId|model lineage/i.test(message)) return "source_identity_assertion_unresolved";
  if (/currency|required|unit|basis|comparable|normalization/i.test(message)) return "forecast_measurement_contract_incomplete";
  return "automatic_forecast_ledger_write_rejected";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonemptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isHttpsUrl(value: unknown): boolean {
  if (!nonemptyText(value)) return false;
  try { const url = new URL(value); return url.protocol === "https:" && Boolean(url.hostname); }
  catch { return false; }
}

function mapCandidate(row: ForecastCandidateRow) {
  const { discoveryMethod: _discoveryMethod, metadataJson: _metadataJson, ...candidate } = row;
  return { ...candidate, sourceUrl: row.sourceUrl || row.contentUrl || null };
}

function mapSourceForecast(row: SourceForecastRow) {
  const { discoveryMethod: _discoveryMethod, metadataJson: _metadataJson, ...forecast } = row;
  return { ...forecast, analysts: parseJsonArray(row.analystsJson) };
}

function isPresentableForecastRow(row: Pick<SourceForecastRow, "docId" | "sourceUrl" | "discoveryMethod" | "metadataJson">): boolean {
  return isPresentableResearchSource({
    docId: row.docId,
    sourceUrl: row.sourceUrl,
    discoveryMethod: row.discoveryMethod,
    metadataJson: row.metadataJson,
  });
}

function toDomainInput(row: SourceForecastRow): SourceForecastInput {
  return {
    forecastId: row.forecastId, institution: row.institution, sourceIdentityId: row.sourceIdentityId,
    sourceIdentityAssertionId: row.sourceIdentityAssertionId, originSourceIdentityId: row.originSourceIdentityId,
    carrierSourceIdentityId: row.carrierSourceIdentityId, carrierRelation: row.carrierRelation,
    modelLineageId: row.modelLineageId,
    independenceGroupId: row.independenceGroupId, forecastDate: row.forecastDate,
    metric: row.metric, fiscalYear: Number(row.fiscalYear), rawValue: Number(row.rawValue), rawUnit: row.rawUnit,
    currency: row.currency, accountingBasis: row.accountingBasis, ownershipBasis: row.ownershipBasis,
    shareBasis: row.shareBasis, createdAt: Number(row.createdAt),
  };
}

function toRevisionInput(row: SourceForecastRow) {
  return {
    forecastId: row.forecastId, supersedesForecastId: row.supersedesForecastId, institution: row.institution,
    forecastDate: row.forecastDate, metric: row.metric, fiscalYear: Number(row.fiscalYear), fiscalPeriod: row.fiscalPeriod,
    currency: row.currency, normalizedValue: row.normalizedValue, normalizedUnit: row.normalizedUnit,
    normalizationStatus: row.normalizationStatus, accountingBasis: row.accountingBasis,
    ownershipBasis: row.ownershipBasis, shareBasis: row.shareBasis, createdAt: Number(row.createdAt),
    isCurrent: Boolean(row.isCurrent),
  };
}

function parseJsonArray(value: unknown): unknown[] {
  try { const parsed = JSON.parse(String(value || "[]")); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

function cleanAnalysts(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))].slice(0, 20) : [];
}

function cleanStructuredList(value: unknown[]): unknown[] {
  return value.slice(0, 100).filter((item) => item !== null && item !== undefined);
}

function normalizeDate(value: string): string | null {
  const match = String(value || "").trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? null;
}

function normalizeCurrency(value: unknown): string | null {
  const normalized = String(value || "").trim().toUpperCase();
  return normalized || null;
}

function normalizeOptionalId(value: unknown): string | null {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function requiredText(value: unknown, field: string): string {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function requireHttpsUrl(value: unknown, field: string): string {
  const normalized = requiredText(value, field);
  try {
    const url = new URL(normalized);
    if (url.protocol !== "https:" || !url.hostname) throw new Error("unsupported protocol");
    return url.toString();
  } catch {
    throw new Error(`${field} must be an absolute HTTPS URL`);
  }
}

function requireEnum<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new Error(`invalid ${field}`);
  return value as T;
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}
