import { Hono, type Context } from "hono";
import { getSecurity } from "../../security/application/search-securities";
import { loadKline } from "../../market/application/load-kline";
import { D1SituationRepository } from "../../situation/application/situation-repository";
import { isSupportedCompanyCode, normalizeSecurityCode, securityMarket } from "../../../shared/codes";
import { fail, ok } from "../../../shared/http";
import type { AppEnv, FinancialStatement, KlineBar, SecurityRecord } from "../../../types";
import { buildResearchDecision } from "../domain/research-decision";
import { canWriteResearchLocally, researchCapabilities } from "../domain/research-capabilities";
import { buildResearchCoverage } from "../domain/research-coverage";
import { buildResearchDataRequirementCoverage } from "../domain/research-data-requirements";
import { assessResearchDepths } from "../domain/research-depth";
import { buildResearchRiskProfile } from "../domain/research-risk-profile";
import { buildResearchReviewQueue } from "../domain/research-review-queue";
import { buildManagementGuidanceRevisionReadModel } from "../domain/management-guidance-revision";
import {
  loadForecastWorkspace,
  syncAutomaticThirdPartyForecastEvidence,
} from "../application/forecast-ledger";
import { createForecastSynthesisDraft } from "../application/forecast-synthesis";
import {
  insertResearchAnalysisSnapshot,
  insertResearchBusinessModel,
  insertResearchCatalyst,
  insertResearchCompetitiveMarket,
  insertResearchMarketSpaceModel,
  insertResearchRiskEntry,
  insertResearchThesis,
  insertResearchUserNote,
  insertResearchValuationCase,
  loadResearchDossier,
} from "../application/research-dossier";
import {
  loadResearchIdentityFinancials,
  upsertCompanySecurityRelationship,
  upsertListedSecurity,
  upsertOperatingCompany,
  upsertProviderIdentifier,
  putFinancialAvailabilityObservation,
  insertSecurityRightsLink,
  insertSecurityRightsProfile,
  type CompanySecurityRelationshipWrite,
  type OperatingCompanyWrite,
  type ProviderIdentifierWrite,
  type SecurityRightsLinkWrite,
  type SecurityRightsProfileWrite,
} from "../application/research-identity";
import { loadResearchFinancialFactSet, loadResearchFinancialQuality } from "../application/research-financials";
import { bootstrapResearchCompany } from "../application/bootstrap-research-company";
import { loadResearchFinancialProfile } from "../application/research-financial-profile";
import { insertResearchGovernance, loadResearchGovernance } from "../application/research-governance";
import { loadFinancialStatutoryVerifications } from "../application/financial-statutory-verification";
import {
  loadResearchCompanyIndustryExposures,
  loadResearchPeerUniverses,
} from "../application/research-industry-profile";
import {
  insertResearchCompanyTrackExposure,
  insertResearchIndustryTrackProfile,
  insertResearchPeerComparisonSet,
  loadResearchCompanyTrackExposures,
  loadResearchPeerComparisonSets,
} from "../application/research-industry-comparability";
import {
  insertResearchRiskPressureScenario,
  insertResearchRiskRelationship,
  insertResearchRiskThesisLink,
  loadPublicRiskReviewSnapshotHistory,
  loadResearchRiskPressureScenario,
  loadResearchRiskReview,
  savePublicRiskReviewSnapshot,
  validateRiskThesisLinkOwnership,
} from "../application/research-risk-review";
import { loadPublicResearchSnapshotHistory, savePublicResearchSnapshot } from "../application/research-public-snapshot";
import {
  createOwnerHoldingPublicSnapshotReference,
  loadOwnerHoldingPublicSnapshotReferences,
} from "../application/research-owner-holding-snapshot-reference";
import { projectPublicResearchSnapshot } from "../application/project-public-research-snapshot";
import { createDcfValuationModelVersion, loadDcfValuationModelVersions } from "../application/valuation-model-version";
import { createReverseDcfValuationModelVersion, loadReverseDcfValuationModelVersions } from "../application/reverse-valuation-model-version";
import { buildDcfValuationInputFromOperatingScenario, buildDcfValuationInputFromOperatingScenarioWithFormalActualAnchors, type OperatingScenarioDcfModelTarget, type SelfBuiltOperatingScenario } from "../application/operating-scenario-valuation";
import { loadResearchStatutoryDisclosureDocuments, refreshResearchStatutoryDisclosureIndex } from "../application/statutory-disclosure-index";
import type { StatutoryDisclosureIndexOptions } from "../../../adapters/statutory-disclosures";
import { produceSecStatutoryVerifications } from "../application/sec-statutory-verification";
import { produceAhStatutoryVerifications } from "../application/a-h-statutory-verification";
import type { StatutoryDisclosureDocument } from "../../../adapters/statutory-disclosures";
import type { BuildDcfValuationModelInput } from "../domain/valuation-model-version";
import type { BuildReverseDcfValuationModelInput } from "../domain/reverse-valuation-model-version";
import { classifyResearchSecurity } from "../domain/research-identity";
import { buildResearchRiskThesisPropagation, calculateResearchRiskStress } from "../domain/research-risk-review";
import {
  loadForecastActualCalibrationRecords,
  loadFormalActuals,
  loadFormalActualById,
  loadManagementGuidanceForecasts,
} from "../application/forecast-actual-calibration";
import {
  loadCandidateReviews,
  loadFormalActualCandidates,
  loadModelReviewActions,
  loadModelReviewItems,
  materializeFormalActualCandidates,
  syncAutomaticFormalActuals,
} from "../application/formal-actual-candidates";
import {
  insertResearchMarketSpaceAssessment,
  insertResearchOperatingDriverPlan,
  insertResearchOperatingModel,
  loadResearchMarketSpaceAssessments,
  loadResearchOperatingDriverPlans,
  loadResearchOperatingModels,
} from "../application/research-operating-market";
import {
  loadResearchInformationEvidenceCandidates,
  refreshResearchInformationEvidenceCandidates,
  reviewResearchInformationEvidenceCandidate,
} from "../application/research-information-evidence";
import { produceResearchStatutoryOperatingEvidenceCandidates } from "../application/research-statutory-operating-candidates";
import { importIndexedStatutoryDisclosureToKnowledge } from "../application/import-statutory-disclosure-to-knowledge";
import { extractResearchAutoFilingInsights, loadResearchAutoBusinessDriverTree, loadResearchAutoFilingDocumentVersions, loadResearchAutoFilingFactInputs, loadResearchAutoFilingInsights, loadResearchAutoFilingModuleRebuilds, loadResearchAutoForecastInputGate, loadResearchAutoGovernanceCapitalLedger, loadResearchAutoIndustryCompetitionInputs, loadResearchAutoMarketSpaceInputs, loadResearchAutoRiskLedger, loadResearchAutoRiskQuantitativeInputGate, loadResearchAutoRiskSnapshotHistory, loadResearchAutoSecurityStructureCandidates, rebuildResearchAutoFilingReadModels } from "../application/research-auto-filing-insights";
import { loadResearchIndustrySourceSeries, syncResearchIndustrySourceSeries } from "../application/research-industry-source-series";
import { enqueueResearchInvestmentAnalysis, loadResearchInvestmentAnalysis } from "../application/research-investment-analysis";
import { enqueueResearchFinancialAnalysis, loadResearchFinancialAnalysis, resumeResearchFinancialAnalysis } from "../application/research-financial-analysis";
import { loadResearchOperatingSourceFacts, recordResearchOperatingSourceFact } from "../application/research-operating-source-facts";
import {
  loadResearchOperatingSourceFactBindings,
  recordResearchOperatingSourceFactBinding,
  reviewResearchOperatingSourceFactBinding,
} from "../application/research-operating-source-fact-bindings";
import { researchOperatingSourceFactBindingTargets } from "../domain/research-operating-source-fact-bindings";
import {
  insertResearchIndustryKpiDriverBinding,
  loadResearchIndustryKpiDriverBindings,
} from "../application/research-industry-kpi-transmission";
import { projectIndustryKpiDriverTransmission, researchIndustryKpiTransmissionRules } from "../domain/research-industry-kpi-transmission";
import { insertResearchCatalystReview } from "../application/research-catalyst-review";
import { createGuidanceEventImpactReview, loadGuidanceEventImpactReviews, resolveGuidanceEventImpactReviewTarget } from "../application/guidance-event-impact-reviews";
import { insertResearchMarketStructureFact, loadResearchMarketStructure, requirePerShareMarketStructure, type MarketStructureFactWrite } from "../application/research-market-structure";
import { loadResearchFxBridgesForSecurity } from "../application/research-fx-bridge";
import {
  loadResearchGovernanceCapitalFactCandidates,
  loadResearchGovernanceCapitalFactLedger,
  refreshResearchGovernanceCapitalFactCandidates,
  reviewResearchGovernanceCapitalFactCandidate,
} from "../application/research-governance-capital-facts";
import { createResearchRelativeValuationLedger, loadResearchRelativeValuationLedgers } from "../application/relative-valuation-ledger";
import type { BuildRelativeValuationLedgerInput } from "../domain/relative-valuation-ledger";
import { loadResearchFinancialSpecialtyLedger } from "../application/research-financial-specialty-metrics";
import { appendResearchCompanyFocusMembership, createResearchCompanyFocusProfile, loadResearchCompanyFocusProfile } from "../application/research-company-focus-profile";
import { loadStatutoryDisclosureRevisionCandidates, refreshStatutoryDisclosureRevisionCandidates, reviewStatutoryDisclosureRevisionCandidate } from "../application/statutory-disclosure-revision-candidates";
import {
  appendUsFinancialPeriodEquivalence,
  loadAcceptedUsFinancialPeriodEquivalences,
  loadUsFinancialPeriodEquivalences,
} from "../application/us-financial-period-equivalence";
import type { UsFinancialPeriodEquivalenceWrite } from "../domain/us-financial-period-equivalence";

export const researchRoutes = new Hono<AppEnv>();

researchRoutes.get("/research/company/:code/forecasts", async (c) => {
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  const security = (await getSecurity(c.env.DB, code)) ?? fallbackResearchSecurity(code);
  try { classifyResearchSecurity({ code, name: security.name, instrumentType: security.type }); }
  catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
  const [workspace, managementGuidance, formalActuals, formalActualCalibrations, formalActualCandidates, formalActualCandidateReviews, modelReviewItems, modelReviewActions] = await Promise.all([
    loadForecastWorkspace(c.env.DB, code, security),
    loadManagementGuidanceForecasts(c.env.DB, code),
    loadFormalActuals(c.env.DB, code),
    loadForecastActualCalibrationRecords(c.env.DB, code),
    loadFormalActualCandidates(c.env.DB, code),
    loadCandidateReviews(c.env.DB, code),
    loadModelReviewItems(c.env.DB, code),
    loadModelReviewActions(c.env.DB, code),
  ]);
  return ok(c, {
    generatedAt: Date.now(),
    code,
    ...workspace,
    managementGuidance,
    // This is an auditable read model over explicit immutable links only. It
    // neither changes the guidance ledger nor turns management statements
    // into third-party forecasts or a consensus estimate.
    managementGuidanceRevisions: buildManagementGuidanceRevisionReadModel(managementGuidance),
    formalActuals,
    formalActualCalibrations,
    formalActualCandidates,
    formalActualCandidateReviews,
    modelReviewItems,
    modelReviewActions,
    capabilities: researchCapabilities(c.env),
    limitations: [
      "来源候选来自信息预处理账本；只有原始载体、来源身份、独立性和口径证据均完整的自动账本样本才进入汇总。",
      "每个纳入样本必须绑定有 HTTPS 证据的已确认来源身份及独立来源组；转载、联合署名和同源数据库按来源组去重。",
      "当前来源集合属于机会性收集，汇总固定称为已纳入样本的预测汇总，不是市场一致预期。",
      "自建情景和实际校准是独立账本，不会回写来源预测。",
      "正式实际只由法定字段核验为 match 且口径可由规则唯一确定的候选自动生成；无法确定时保留阻断原因，重述和既有模型不会被自动改写。",
    ],
  });
});

researchRoutes.post("/research/company/:code/forecast-reviews", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "manual forecast reviews are only available in local research runtime");
  return fail(c, 410, "manual forecast review is retired; run the local automatic third-party forecast sync with source-bound evidence");
});

// Third-party forecasts follow the same no-human runtime rule as statutory
// actuals: a local refresh either accepts a fully source-bound original
// carrier/measurement contract or stores the exact automatic block reason.
// Production can only read the resulting immutable ledger.
researchRoutes.post("/research/company/:code/third-party-forecasts/sync-auto", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "automatic third-party forecast sync is only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  try { return ok(c, await syncAutomaticThirdPartyForecastEvidence(c.env.DB, code)); }
  catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.post("/research/forecast-source-independence-groups", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "manual forecast source identity writes are only available in local research runtime");
  return fail(c, 410, "manual forecast source identity writes are retired; identity evidence must arrive in the automatic document provenance contract");
});

researchRoutes.post("/research/forecast-source-identities", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "manual forecast source identity writes are only available in local research runtime");
  return fail(c, 410, "manual forecast source identity writes are retired; identity evidence must arrive in the automatic document provenance contract");
});

researchRoutes.post("/research/forecast-model-lineages", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "manual forecast lineage writes are only available in local research runtime");
  return fail(c, 410, "manual forecast lineage writes are retired; model lineage must arrive in the automatic document provenance contract");
});

researchRoutes.post("/research/forecast-source-identity-assertions", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "manual forecast identity assertions are only available in local research runtime");
  return fail(c, 410, "manual forecast identity assertions are retired; the automatic sync binds exact document versions only");
});

researchRoutes.post("/research/company/:code/forecast-synthesis-drafts", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "forecast synthesis is only available in local LLM runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  const security = (await getSecurity(c.env.DB, code)) ?? fallbackResearchSecurity(code);
  try {
    return ok(c, await createForecastSynthesisDraft(c.env, code, security));
  } catch (error) {
    return fail(c, 400, error instanceof Error ? error.message : String(error));
  }
});

researchRoutes.post("/research/company/:code/forecast-scenarios", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "manual forecast scenarios are only available in local research runtime");
  return fail(c, 410, "manual forecast scenarios are retired; only issuer-explicit source scenarios are written by the automatic filing pipeline");
});

researchRoutes.post("/research/company/:code/forecast-calibrations", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "research writes are only available in local research runtime");
  return fail(c, 410, "legacy client-value calibration is retired; accept a statutory actual candidate then use formal-actual-calibrations");
});

researchRoutes.post("/research/company/:code/management-guidance-forecasts", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "manual management guidance writes are only available in local research runtime");
  return fail(c, 410, "manual management guidance writes are retired; only source-bound issuer guidance is written by the automatic filing pipeline");
});

researchRoutes.post("/research/company/:code/formal-actuals", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "formal actual writes are only available in local research runtime");
  return fail(c, 410, "formal actual values are server-generated only by the automatic statutory-evidence sync");
});

researchRoutes.post("/research/company/:code/formal-actual-candidates/refresh", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "formal actual candidate writes are only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  try {
    const result = await materializeFormalActualCandidates(c.env.DB, [code]);
    return ok(c, { ...result, candidates: result.created });
  }
  catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

// The production research pipeline does not wait for a person to accept a
// statutory match.  This local-only job accepts only the subset whose metric
// and semantic bases are deterministically defined by the source contract,
// then calibrates already-saved matching forecasts.  All other candidates
// remain visible with a machine-readable block reason.
researchRoutes.post("/research/company/:code/formal-actuals/sync-auto", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "automatic formal-actual sync is only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  try { return ok(c, await syncAutomaticFormalActuals(c.env.DB, code)); }
  catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

/**
 * Local operator batch for already-recorded statutory field comparisons.  The
 * request deliberately names its securities: there is no hidden provider
 * refresh or unbounded cross-database write, and the materializer can only
 * append immutable review candidates.
 */
researchRoutes.post("/research/formal-actual-candidates/materialize", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "formal actual candidate writes are only available in local research runtime");
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  const rawCodes = Array.isArray(body?.securityCodes) ? body.securityCodes : null;
  if (!rawCodes?.length || rawCodes.length > 50 || rawCodes.some((value) => typeof value !== "string")) {
    return fail(c, 400, "securityCodes must contain 1 to 50 security codes");
  }
  const codes = [...new Set(rawCodes.map((value) => normalizeSecurityCode(value as string)))].sort();
  if (codes.some((code) => !isSupportedCompanyCode(code))) return fail(c, 400, "securityCodes contains an unsupported company code");
  try {
    return ok(c, await materializeFormalActualCandidates(c.env.DB, codes));
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.get("/research/company/:code/formal-actual-candidates", async (c) => {
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  try { return ok(c, { candidates: await loadFormalActualCandidates(c.env.DB, code), reviews: await loadCandidateReviews(c.env.DB, code) }); }
  catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.post("/research/company/:code/formal-actual-candidate-reviews", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "manual formal actual acceptance is only available in local research runtime");
  return fail(c, 410, "manual formal-actual acceptance is retired; run the local automatic statutory-evidence sync");
});

researchRoutes.post("/research/company/:code/formal-actual-calibrations", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "manual formal actual calibration is only available in local research runtime");
  return fail(c, 410, "manual forecast-actual calibration is retired; automatic statutory actual sync calibrates all matching saved forecasts");
});

researchRoutes.get("/research/company/:code/model-review-items", async (c) => {
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  try {
    const [items, actions] = await Promise.all([loadModelReviewItems(c.env.DB, code), loadModelReviewActions(c.env.DB, code)]);
    return ok(c, { items, actions });
  }
  catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.post("/research/company/:code/model-review-items/:id/resolve", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "manual model review resolution is only available in local research runtime");
  return fail(c, 410, "manual model-review resolution is retired; source updates automatically rebuild supported read models or keep unsupported conclusions blocked");
});

researchRoutes.get("/research/company/:code", async (c) => {
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  const now = Date.now();
  const from = `${new Date(now - 3 * 366 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)}`;
  const repository = new D1SituationRepository(c.env.DB);
  const security = (await getSecurity(c.env.DB, code)) ?? fallbackResearchSecurity(code);
  try { classifyResearchSecurity({ code, name: security.name, instrumentType: security.type }); }
  catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
  const ownerKey = canWriteResearchLocally(c.env) ? (c.req.query("owner")?.trim() || "local-user") : undefined;
  const [kline, events, impacts, signals, candidates, snapshot, sources, documentStats, identity, financials, dossier, governance, valuationModels, reverseValuationModels, relativeValuationLedgers, statutoryDocuments, managementGuidance, formalActuals, formalActualCalibrations, guidanceEventImpactReviews, forecastWorkspace, autoFilingInsights, autoFilingFactInputs, autoFilingDocumentVersions, autoFilingModuleRebuilds, autoBusinessDriverTree, autoMarketSpaceInputs, autoGovernanceCapitalLedger, autoRiskLedger, autoRiskQuantitativeInputGate, autoRiskSnapshotHistory, autoSecurityStructureCandidates, autoIndustryCompetitionInputs, industrySourceSeries, autoForecastInputGate, fxBridges] = await Promise.all([
    loadKline(c.env, code, "day", "forward", from, new Date(now).toISOString().slice(0, 10)),
    repository.listEvents({ asOf: now, targetCode: code, limit: 100 }),
    repository.listImpacts({ asOf: now, targetType: "company", targetIds: [code] }),
    repository.listSignals({ asOf: now, subjectType: "company", subjectId: code, limit: 20 }),
    repository.listCandidates("local", now, { targetIds: [code] }),
    repository.latestSnapshot("company", code, now),
    repository.listSources(),
    knowledgeDocumentStats(c.env.DB, code),
    loadResearchIdentityFinancials(c.env.DB, security),
    (async () => {
      const entityProfile = await loadResearchFinancialProfile(c.env.DB, code);
      const [financials, specialtyMetrics] = await Promise.all([
        loadResearchFinancialQuality(c.env, code, { entityType: entityProfile.qualityEntityType }),
        loadResearchFinancialSpecialtyLedger(c.env.DB, code),
      ]);
      return { ...financials, entityProfile, specialtyMetrics };
    })(),
    loadResearchDossier(c.env.DB, { securityCode: code, asOf: now, ownerKey }),
    loadResearchGovernance(c.env.DB, (await c.env.DB.prepare("select company_id as companyId from research_listed_securities where security_code=?").bind(code).first<{ companyId: string | null }>())?.companyId ?? null, now),
    loadDcfValuationModelVersions(c.env.DB, code, now),
    loadReverseDcfValuationModelVersions(c.env.DB, code, now),
    loadResearchRelativeValuationLedgers(c.env.DB, { securityCode: code, asOf: now }),
    loadResearchStatutoryDisclosureDocuments(c.env.DB, code),
    loadManagementGuidanceForecasts(c.env.DB, code),
    loadFormalActuals(c.env.DB, code),
    loadForecastActualCalibrationRecords(c.env.DB, code),
    loadOptionalResearchExtension(() => loadGuidanceEventImpactReviews(c.env.DB, code)),
    loadForecastWorkspace(c.env.DB, code, security),
    loadResearchAutoFilingInsights(c.env.DB, code),
    loadResearchAutoFilingFactInputs(c.env.DB, code),
    loadResearchAutoFilingDocumentVersions(c.env.DB, code),
    loadResearchAutoFilingModuleRebuilds(c.env.DB, code),
    loadResearchAutoBusinessDriverTree(c.env.DB, code),
    loadResearchAutoMarketSpaceInputs(c.env.DB, code),
    loadResearchAutoGovernanceCapitalLedger(c.env.DB, code),
    loadResearchAutoRiskLedger(c.env.DB, code),
    loadResearchAutoRiskQuantitativeInputGate(c.env.DB, code),
    loadResearchAutoRiskSnapshotHistory(c.env.DB, code),
    loadResearchAutoSecurityStructureCandidates(c.env.DB, code),
    loadResearchAutoIndustryCompetitionInputs(c.env.DB, code),
    loadResearchIndustrySourceSeries(c.env.DB, code),
    loadResearchAutoForecastInputGate(c.env.DB, code),
    loadResearchFxBridgesForSecurity(c.env.DB, { securityCode: code, securityCurrency: security.currency, asOf: now }),
  ]);
  const rows = (kline.rows as KlineBar[]).filter((item) => "close" in item);
  const evidence = events.flatMap((event) => event.evidence.map((item) => ({
    evidenceId: item.evidenceId, title: item.title, url: item.url, publishedAt: item.publishedAt,
    sourceId: item.sourceId, grade: item.evidenceGrade, eventStatus: event.status, eventId: event.eventId,
  })));
  const decision = buildResearchDecision({
    klineRows: rows.map((item) => ({ close: item.close, peTtm: item.peTtm, pb: item.pb })),
    evidenceCount: evidence.length,
    confirmedEvidenceCount: evidence.filter((item) => item.grade === "official_confirmed" || item.grade === "multi_source_confirmed").length,
    conflictingEvidenceCount: evidence.filter((item) => item.grade === "conflicting").length,
    activeCandidateCount: candidates.length,
    pressureImpactCount: impacts.filter((item) => item.direction === "pressure").length,
    supportImpactCount: impacts.filter((item) => item.direction === "support").length,
  });
  const eventById = new Map(events.map((event) => [event.eventId, event]));
  const riskProfile = buildResearchRiskProfile({
    peTtm: decision.metrics.peTtm,
    pb: decision.metrics.pb,
    pePercentile: decision.metrics.pePercentile,
    pbPercentile: decision.metrics.pbPercentile,
    drawdown90d: decision.metrics.drawdown90d,
    evidence,
    impacts: impacts.map((impact) => {
      const event = impact.eventId ? eventById.get(impact.eventId) : null;
      return { ...impact, title: event?.title ?? null, references: (event?.evidence ?? []).map((item) => ({ evidenceId: item.evidenceId, title: item.title, url: item.url, publishedAt: item.publishedAt, grade: item.evidenceGrade })) };
    }),
    sources,
    documentCount: documentStats.total,
  });
  const companyId = (identity.operatingCompany as { companyId?: string } | null)?.companyId ?? null;
  const [statutoryVerifications, usFinancialPeriodEquivalences, industryExposures, peerUniverses, typedTrackExposures, typedPeerComparisonSets, riskReview, operatingModels, operatingDriverPlans, marketSpaceAssessments, operatingSourceFacts, operatingSourceFactBindings, modelReviewItems, marketStructure, governanceCapitalFacts, formalActualCandidates, formalActualCandidateReviews, focusProfile] = await Promise.all([
    loadOptionalResearchExtension(() => loadFinancialStatutoryVerifications(c.env.DB, code, { limit: 100 })),
    loadUsFinancialPeriodEquivalences(c.env.DB, code),
    loadResearchCompanyIndustryExposures(c.env.DB, { companyId, asOf: now }),
    loadResearchPeerUniverses(c.env.DB, { companyId, asOf: now }),
    loadResearchCompanyTrackExposures(c.env.DB, { companyId, asOf: now }),
    loadResearchPeerComparisonSets(c.env.DB, { companyId, asOf: now }),
    loadResearchRiskReview(c.env.DB, { securityCode: code, asOf: now }),
    loadResearchOperatingModels(c.env.DB, { companyId, asOf: now }),
    loadResearchOperatingDriverPlans(c.env.DB, { companyId, asOf: now }),
    loadResearchMarketSpaceAssessments(c.env.DB, { companyId, asOf: now }),
    loadResearchOperatingSourceFacts(c.env.DB, { operatingCompanyId: companyId }),
    loadResearchOperatingSourceFactBindings(c.env.DB, { operatingCompanyId: companyId }),
    loadModelReviewItems(c.env.DB, code),
    loadResearchMarketStructure(c.env.DB, { code, market: identity.listedSecurity.market, instrumentKind: identity.listedSecurity.instrumentKind }),
    loadResearchGovernanceCapitalFactLedger(c.env.DB, code),
    loadFormalActualCandidates(c.env.DB, code),
    loadCandidateReviews(c.env.DB, code),
    loadResearchCompanyFocusProfile(c.env.DB, { companyId, securityCode: code, asOf: now, ownerKey }),
  ]);
  const riskReviewQueue = dossier.risks.availability === "available" && dossier.theses.availability === "available"
    ? { availability: "available" as const, reason: null, items: buildResearchRiskThesisPropagation({ risks: dossier.risks.items, theses: dossier.theses.items, links: riskReview.thesisLinks }) }
    : { availability: "unavailable" as const, reason: "public_risk_or_thesis_records_unavailable", items: [] };
  const coverage = buildResearchCoverage({
    identity,
    financials,
    marketStructure,
    operating: { models: operatingModels, driverPlans: operatingDriverPlans, marketSpaceAssessments },
    industry: { exposures: typedTrackExposures, peerSets: typedPeerComparisonSets, competitiveMarkets: dossier.competitiveMarkets },
    forecast: forecastWorkspace.forecastCoverage,
    valuation: valuationModels,
    reverseValuation: reverseValuationModels,
    risk: dossier.risks,
    theses: dossier.theses,
    modelReviewItems,
    // `r2` is a delivery/cache location.  The stock snapshot is eligible for
    // that cache path only after `loadKline` has verified its immutable source
    // marker is Xueqiu, so coverage must evaluate the origin rather than
    // falsely treating a safe Xueqiu cache hit as an unknown provider.
    market: {
      rows: rows.length,
      source: rows.length && rows.every((row) => (row as { source?: string }).source === "xueqiu") ? "xueqiu" : kline.source,
      latestDate: rows.at(-1)?.date ?? null,
    },
  });
  const dataRequirementCoverage = buildResearchDataRequirementCoverage({
    asOf: now,
    signals: researchDataRequirementSignals({
      identity, financials, statutoryVerifications, operatingModels, operatingDriverPlans, marketSpaceAssessments,
      operatingSourceFacts, operatingSourceFactBindings, typedTrackExposures, typedPeerComparisonSets, forecastWorkspace, valuationModels, reverseValuationModels, autoFilingInsights, autoFilingFactInputs,
      governance, governanceCapitalFacts, dossier, modelReviewItems, kline: { rows, source: kline.source },
    }),
  });
  const researchReviewQueue = buildResearchReviewQueue({
    now,
    sourceHealth: dataRequirementCoverage.sourceHealth,
    requirements: dataRequirementCoverage.requirements,
    theses: dossier.theses.items,
    risks: dossier.risks.items,
    focusProfile: focusProfile.profile,
    formalActualCandidates,
    formalActualCandidateReviews,
    modelReviewItems,
    managementGuidance,
    formalActuals,
    catalystReviews: dossier.catalysts.items.flatMap((item) => item.reviews),
    impactReviews: guidanceEventImpactReviews.items,
  });
  const operatingModelDetails = operatingModels.items.reduce((result, model) => ({
    segments: result.segments + model.segments.length,
    contracts: result.contracts + model.segments.reduce((total, segment) => total + segment.contracts.length, 0),
    unitEconomics: result.unitEconomics + model.segments.reduce((total, segment) => total + segment.unitEconomics.length, 0),
  }), { segments: 0, contracts: 0, unitEconomics: 0 });
  const marketDetails = marketSpaceAssessments.items.reduce((result, assessment) => ({
    assessments: result.assessments + 1,
    shareBridgeSteps: result.shareBridgeSteps + assessment.shareBridges.reduce((total, bridge) => total + bridge.steps.length, 0),
    profitPools: result.profitPools + assessment.profitPools.length,
  }), { assessments: 0, shareBridgeSteps: 0, profitPools: 0 });
  const researchDepth = assessResearchDepths({
    modules: coverage.modules,
    sourceDocumentCount: documentStats.total,
    industryExposures: typedTrackExposures,
    peerSets: typedPeerComparisonSets,
    governance,
    operatingModelDetails,
    marketDetails,
    stressScenarios: { availability: riskReview.availability, items: riskReview.pressureScenarios },
    // A historical calibration row is not current calibration evidence when
    // its actual was restated/superseded or its comparison was invalid.  The
    // depth gate must consume the same health projection as the forecast
    // reader; otherwise an old blocked row could unlock deep research.
    calibrations: {
      availability: forecastWorkspace.formalActualHealth.calibrationAvailability === "available" ? "available" : "empty",
      items: forecastWorkspace.formalActualHealth.calibrationAvailability === "available" ? formalActualCalibrations : [],
    },
  });
  return ok(c, {
    generatedAt: now,
    code,
    name: security.name,
    capabilities: researchCapabilities(c.env),
    identity,
    marketStructure,
    financials,
    statutoryVerifications,
    usFinancialPeriodEquivalences,
    statutoryDocuments,
    industry: { exposures: industryExposures, peerUniverses, typedTrackExposures, typedPeerComparisonSets },
    operating: { models: operatingModels, driverPlans: operatingDriverPlans, marketSpaceAssessments, sourceFacts: operatingSourceFacts, sourceFactBindings: operatingSourceFactBindings },
    dossier,
    governance,
    governanceCapitalFacts,
    focusProfile,
    valuationModels,
    reverseValuationModels,
    relativeValuationLedgers,
    managementGuidance,
    formalActuals,
    forecastWorkspace,
    guidanceEventImpactReviews,
    researchReviewQueue,
    riskReview: { ...riskReview, reviewQueue: riskReviewQueue },
    coverage,
    dataRequirementCoverage,
    autoFilingInsights,
    autoFilingFactInputs,
    autoFilingDocumentVersions,
    autoFilingModuleRebuilds,
    autoBusinessDriverTree,
    autoMarketSpaceInputs,
    autoGovernanceCapitalLedger,
    autoRiskLedger,
    autoRiskQuantitativeInputGate,
    autoRiskSnapshotHistory,
    autoSecurityStructureCandidates,
    autoIndustryCompetitionInputs,
    industrySourceSeries,
    autoForecastInputGate,
    fxBridges,
    researchDepth,
    decision,
    riskProfile,
    evidence: evidence.slice(0, 20),
    situation: { snapshot, signals, impacts, candidates },
    documents: documentStats,
    dataHealth: {
      kline: {
        source: kline.source,
        originSource: rows.length && rows.every((row) => (row as { source?: string }).source === "xueqiu") ? "xueqiu" : null,
        rows: rows.length,
        latestDate: rows.at(-1)?.date ?? null,
        updatedAt: rows.at(-1)?.updatedAt ?? null,
      },
      situationSources: sources.map((item) => ({ sourceId: item.sourceId, name: item.name, state: item.state, lastSuccessAt: item.lastSuccessAt, lastError: item.lastError })),
      limitations: [
        "研究状态不构成买卖建议，也不会自动下单。",
        "个股实时资金流、完整财务质量因子和个人组合约束尚未统一接入时，相关门槛会保持待补。",
      ],
    },
  });
});

/** Local collector entry point.  It deliberately creates evidence-bearing
 * inputs only; document extraction and LLM synthesis remain separately
 * governed local jobs and are never triggered by a public page read. */
researchRoutes.post("/research/company/:code/bootstrap", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "research bootstrap is only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  try {
    const security = (await getSecurity(c.env.DB, code)) ?? fallbackResearchSecurity(code);
    return ok(c, await bootstrapResearchCompany(c.env, security));
  } catch (error) {
    return fail(c, 502, error instanceof Error ? error.message : String(error));
  }
});

researchRoutes.get("/research/company/:code/focus-profile", async (c) => {
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  const security = (await getSecurity(c.env.DB, code)) ?? fallbackResearchSecurity(code);
  const identity = await loadResearchIdentityFinancials(c.env.DB, security);
  const companyId = (identity.operatingCompany as { companyId?: string } | null)?.companyId ?? null;
  const ownerKey = canWriteResearchLocally(c.env) ? (c.req.query("owner")?.trim() || "local-user") : undefined;
  try { return ok(c, await loadResearchCompanyFocusProfile(c.env.DB, { companyId, securityCode: code, asOf: finiteTimestamp(c.req.query("asOf")) ?? Date.now(), ownerKey })); }
  catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.post("/research/company/:code/focus-membership", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "focus membership writes are only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code")); if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null; if (!body) return fail(c, 400, "invalid focus membership body");
  try {
    const security = (await getSecurity(c.env.DB, code)) ?? fallbackResearchSecurity(code); const identity = await loadResearchIdentityFinancials(c.env.DB, security);
    const companyId = (identity.operatingCompany as { companyId?: string } | null)?.companyId; if (!companyId) return fail(c, 409, "operating-company mapping is required before selecting a focus company");
    return ok(c, await appendResearchCompanyFocusMembership(c.env.DB, { membershipId: stringOrNull(body.membershipId) ?? undefined, ownerKey: requiredText(body.ownerKey ?? "local-user", "ownerKey"), companyId, status: enumValue(body.status, ["active", "removed"] as const, "status"), createdAt: finiteTimestamp(body.createdAt) ?? Date.now() }));
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.post("/research/company/:code/focus-profiles", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "focus profile writes are only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code")); if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null; if (!body || !Array.isArray(body.items)) return fail(c, 400, "focus profile requires items");
  try {
    const security = (await getSecurity(c.env.DB, code)) ?? fallbackResearchSecurity(code); const identity = await loadResearchIdentityFinancials(c.env.DB, security);
    const companyId = (identity.operatingCompany as { companyId?: string } | null)?.companyId; if (!companyId) return fail(c, 409, "operating-company mapping is required before creating a focus profile");
    return ok(c, await createResearchCompanyFocusProfile(c.env.DB, { focusProfileId: stringOrNull(body.focusProfileId) ?? undefined, companyId, asOf: finiteTimestamp(body.asOf) ?? undefined, status: enumValue(body.status ?? "draft", ["draft", "reviewed"] as const, "status"), title: requiredText(body.title, "title"), reviewBy: finiteTimestamp(body.reviewBy), items: body.items as never, createdAt: finiteTimestamp(body.createdAt) ?? Date.now() }));
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.post("/research/company/:code/statutory-disclosures/refresh", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "statutory disclosure refresh is only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  let options: StatutoryDisclosureIndexOptions;
  try { options = statutoryDisclosureIndexRefreshOptions({ page: c.req.query("page"), pageSize: c.req.query("pageSize") }); }
  catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
  try {
    const index = await refreshResearchStatutoryDisclosureIndex(c.env.DB, code, options);
    return ok(c, { ...index, requestedWindow: { page: options.page, pageSize: options.pageSize, scope: "official_index_only" } });
  }
  catch (error) { return fail(c, 502, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.get("/research/company/:code/statutory-disclosures", async (c) => {
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  try { return ok(c, await loadResearchStatutoryDisclosureDocuments(c.env.DB, code)); }
  catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

// Read-only in every runtime: production serves only facts that were already
// source-bound and persisted by a local research task.
researchRoutes.get("/research/company/:code/auto-filing-insights", async (c) => {
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  try { return ok(c, await loadResearchAutoFilingInsights(c.env.DB, code)); }
  catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

// This is the sole bridge from the issuer/exchange disclosure index into the
// knowledge ledger.  It takes a native indexed ID, never a client URL, and
// stops before information processing so local model use remains explicit.
researchRoutes.post("/research/company/:code/statutory-disclosures/:documentId/import-local", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "statutory disclosure import is only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  try {
    return ok(c, await importIndexedStatutoryDisclosureToKnowledge(c.env, code, c.req.param("documentId")));
  } catch (error) {
    return fail(c, 400, error instanceof Error ? error.message : String(error));
  }
});

// The expensive remote-model step is intentionally an explicit local job.
// A page GET must never trigger model calls or mutate the research ledger.
researchRoutes.post("/research/company/:code/statutory-disclosures/:documentId/auto-insights", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "filing insight extraction is only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  try {
    const extraction = await extractResearchAutoFilingInsights(c.env, code, c.req.param("documentId"));
    const rebuild = await rebuildResearchAutoFilingReadModels(c.env.DB, code);
    return ok(c, { ...extraction, rebuild });
  }
  catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

// Local scheduler entry point for events accumulated while files were imported
// or a previous local job stopped mid-run.  GET pages must remain read-only.
researchRoutes.post("/research/company/:code/rebuild-auto-filing-inputs", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "automatic filing rebuild is only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  try { return ok(c, await rebuildResearchAutoFilingReadModels(c.env.DB, code)); }
  catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

// Imported official/association documents are processed only by this explicit
// local job. A normal research GET must not call the remote model or write an
// industry series observation.
researchRoutes.post("/research/company/:code/sync-industry-source-series", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "industry source extraction is only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  try { return ok(c, await syncResearchIndustrySourceSeries(c.env, code)); }
  catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

// The investment-analysis page prepares its bounded engineering input in
// stock-info, then submits one latest-only ChatGPT WebQA task to taskd.
async function getResearchInvestmentAnalysis(c: Context<AppEnv, "/research/company/:code/investment-analysis">) {
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  try { return ok(c, await loadResearchInvestmentAnalysis(c.env, code)); }
  catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
}

researchRoutes.get("/research/company/:code/investment-analysis", getResearchInvestmentAnalysis);

// Deep financial analysis is a single-security, source-bound report.  The
// existing company-finance page remains the primary surface for its detailed
// financial evidence; no Worker request may invoke a remote model directly.
researchRoutes.get("/research/company/:code/financial-analysis", async (c) => {
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  try { return ok(c, await loadResearchFinancialAnalysis(c.env, code)); }
  catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.post("/research/company/:code/financial-analysis/refresh", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "financial analysis refresh is only available in local LLM runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  const body: Record<string, unknown> = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try {
    return ok(c, await enqueueResearchFinancialAnalysis(c.env, code, {
      force: body.force !== false,
      reasoningEffort: typeof body.reasoningEffort === "string" ? body.reasoningEffort : null,
    }));
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.post("/research/company/:code/financial-analysis/resume", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "financial analysis resume is only available in local LLM runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  try { return ok(c, await resumeResearchFinancialAnalysis(c.env, code)); }
  catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

async function refreshResearchInvestmentAnalysis(c: Context<AppEnv, "/research/company/:code/investment-analysis/refresh">) {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "investment analysis refresh is only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try { return ok(c, await enqueueResearchInvestmentAnalysis(c.env, code, { reasoningEffort: typeof body.reasoningEffort === "string" ? body.reasoningEffort : null })); }
  catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
}

researchRoutes.post("/research/company/:code/investment-analysis/refresh", refreshResearchInvestmentAnalysis);

researchRoutes.get("/research/company/:code/statutory-disclosure-revision-candidates", async (c) => {
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  try { return ok(c, await loadStatutoryDisclosureRevisionCandidates(c.env.DB, code)); }
  catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.post("/research/company/:code/statutory-disclosure-revision-candidates/refresh", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "statutory revision candidate refresh is only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  try { return ok(c, await refreshStatutoryDisclosureRevisionCandidates(c.env.DB, code)); }
  catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.post("/research/company/:code/statutory-disclosure-revision-candidates/:candidateId/reviews", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "statutory revision candidate reviews are only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return fail(c, 400, "invalid statutory revision review body");
  try {
    return ok(c, await reviewStatutoryDisclosureRevisionCandidate(c.env.DB, code, {
      reviewId: stringOrNull(body.reviewId) ?? `statutory-revision-review:${crypto.randomUUID()}`,
      candidateId: c.req.param("candidateId"), decision: requiredText(body.decision, "decision") as "confirmed_financial_restatement" | "not_financial_correction" | "needs_evidence",
      originalDocumentId: stringOrNull(body.originalDocumentId), affectedScope: stringOrNull(body.affectedScope),
      reviewer: stringOrNull(body.reviewer) ?? "local-user", reason: requiredText(body.reason, "reason"), reviewedAt: finiteTimestamp(body.reviewedAt) ?? undefined,
    }));
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

/**
 * A reviewed correction is not folded into the ordinary A/H filing selector.
 * The local operator must explicitly select this immutable official document;
 * its extracted fields are then appended as `restated` statutory evidence.
 * Eastmoney remains the primary source, so a stale primary record stays a
 * conflict and cannot materialize a formal actual.
 */
researchRoutes.post("/research/company/:code/statutory-disclosure-revision-candidates/:candidateId/financial-statutory-verifications/refresh", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "statutory restatement verification is only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  try {
    const candidateSet = await loadStatutoryDisclosureRevisionCandidates(c.env.DB, code);
    const candidate = candidateSet.items.find((item) => item.candidateId === c.req.param("candidateId"));
    const review = candidate?.latestReview;
    if (!candidate || !review || review.decision !== "confirmed_financial_restatement"
      || !review.originalDocumentId || !review.affectedScope) {
      return fail(c, 409, "a confirmed financial-restatement review with originalDocumentId and affectedScope is required before verification");
    }
    if (!candidate.reportPeriod) return fail(c, 409, "confirmed restatement candidate has no determinable report period; retain it for manual evidence review");
    const security = (await getSecurity(c.env.DB, code)) ?? fallbackResearchSecurity(code);
    const classified = classifyResearchSecurity({ code, name: security.name, instrumentType: security.type });
    if (classified.market !== "a_share" && classified.market !== "h_share") {
      return fail(c, 400, "statutory restatement document verification currently supports A/H securities only");
    }
    const existingResearchSecurity = await c.env.DB.prepare(`select 1 as present from research_listed_securities where security_code=?`)
      .bind(code).first<{ present: number }>();
    if (!existingResearchSecurity) await upsertListedSecurity(c.env.DB, { security });
    const factSet = await loadResearchFinancialFactSet(c.env, code);
    if (!factSet.facts.length) return fail(c, 409, "selected primary financial source returned no normalized facts; restatement verification was not run");
    const statutoryFacts = factSet.facts.filter((fact) => [
      "revenue", "gross_profit", "operating_profit", "net_profit",
      "operating_cash_flow", "capital_expenditure", "cash", "total_debt",
      "total_equity", "diluted_weighted_average_shares", "diluted_shares",
    ].includes(fact.metric) && revisionReportPeriodMatchesFact(candidate.reportPeriod!, fact));
    if (!statutoryFacts.length) return fail(c, 409, `no current Eastmoney primary facts match confirmed restatement period ${candidate.reportPeriod}; no verification was appended`);
    const stored = await loadResearchStatutoryDisclosureDocuments(c.env.DB, code);
    const documents = stored.items.map(asStatutoryDisclosureDocument).filter((item): item is StatutoryDisclosureDocument => item !== null);
    if (!documents.some((item) => item.documentId === candidate.documentId && item.registry === candidate.registry)) {
      return fail(c, 409, "confirmed restatement document is no longer present in the immutable official index");
    }
    const observedAt = Date.now();
    const produced = await produceAhStatutoryVerifications(c.env, {
      securityCode: code, normalizedFacts: statutoryFacts, documents, observedAt, createdAt: observedAt,
      selectedDocumentId: candidate.documentId,
      confirmedRestatement: {
        revisionReviewId: review.reviewId,
        originalDocumentId: review.originalDocumentId,
        affectedScope: review.affectedScope,
      },
    });
    const matched = produced.filter((item) => item.verification.outcome === "match");
    return ok(c, {
      code, candidateId: candidate.candidateId, documentId: candidate.documentId, reportPeriod: candidate.reportPeriod,
      primaryProvider: "eastmoney", statutoryProvider: candidate.registry, statutoryRevision: "restated", createdCount: produced.length,
      outcomes: {
        match: matched.length,
        conflict: produced.filter((item) => item.verification.outcome === "conflict").length,
        unverified: produced.filter((item) => item.verification.outcome === "unverified").length,
      },
      limitations: [
        "该操作仅追加已人工确认的法定重述文件与当前 Eastmoney 主事实的字段核验；不会切换主源。",
        "主源仍为 reported 而法定文件为 restated 时保持 conflict/blocked；不会自动创建正式实际、校准、情景或估值版本。",
      ],
    });
  } catch (error) { return fail(c, 502, error instanceof Error ? error.message : String(error)); }
});

/**
 * This is intentionally a local research job, not a production data path.
 * Yahoo remains the only primary US statement source; SEC is used only to
 * append a field-level verification of the exact normalized Yahoo facts.
 */
researchRoutes.post("/research/company/:code/financial-statutory-verifications/refresh", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "financial statutory verification refresh is only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  const security = (await getSecurity(c.env.DB, code)) ?? fallbackResearchSecurity(code);
  const classified = classifyResearchSecurity({ code, name: security.name, instrumentType: security.type });
  try {
    // The availability ledger has foreign keys to the research security.  A
    // refresh may create an unresolved row for a new code, but it must never
    // overwrite an already source-bound ADR/share-class/ratio identity with
    // the generic security-search type (usually `stock`).
    const existingResearchSecurity = await c.env.DB.prepare(`select 1 as present from research_listed_securities where security_code=?`)
      .bind(code).first<{ present: number }>();
    if (!existingResearchSecurity) await upsertListedSecurity(c.env.DB, { security });
    const factSet = await loadResearchFinancialFactSet(c.env, code);
    if (!factSet.facts.length) return fail(c, 409, "selected primary financial source returned no normalized facts; statutory verification was not run");
    const observedAt = Date.now();
    // The immutable verification ledger deliberately has a narrow, audited
    // field contract.  Financial-quality-only derived inputs never get shoved
    // into it as if SEC had verified their formula.
    const statutoryFacts = factSet.facts.filter((fact) => [
      "revenue", "gross_profit", "operating_profit", "net_profit",
      "operating_cash_flow", "capital_expenditure", "cash", "total_debt",
      "total_equity", "diluted_weighted_average_shares", "diluted_shares",
    ].includes(fact.metric));
    if (!statutoryFacts.length) return fail(c, 409, "selected primary statements contain no fields covered by the statutory verification contract");
    if (classified.market === "us_share") {
      if (factSet.sourceErrors.length) return fail(c, 502, `Yahoo primary financial source failed: ${factSet.sourceErrors.map((item) => `${item.statementType}: ${item.error}`).join("; ")}`);
      if (!factSet.primaryAvailable) return fail(c, 409, "Yahoo primary financial statements are incomplete; SEC verification was not run");
      const periodEquivalences = await loadAcceptedUsFinancialPeriodEquivalences(c.env.DB, code);
      const produced = await produceSecStatutoryVerifications(c.env, { securityCode: code, normalizedFacts: statutoryFacts, periodEquivalences, observedAt, createdAt: observedAt });
      await recordUsFinancialAvailability(c.env.DB, code, factSet.loaded, produced, observedAt);
      const matched = produced.filter((item) => item.verification.outcome === "match");
      return ok(c, {
        code,
        primaryProvider: "yahoo",
        statutoryProvider: "sec",
        createdCount: produced.length,
        outcomes: {
          match: matched.length,
          conflict: produced.filter((item) => item.verification.outcome === "conflict").length,
          unverified: produced.filter((item) => item.verification.outcome === "unverified").length,
        },
        matchedMetrics: [...new Set(matched.map((item) => item.verification.normalizedFact.metric))],
        limitations: ["该操作只追加 Yahoo 主财报与 SEC 法定字段的核验记录；不会将 SEC 作为 Yahoo 的 fallback，也不会在生产环境运行。"],
      });
    }
    const disclosureWindow = await refreshAhStatutoryDisclosureWindow(c.env.DB, code, classified.market);
    const stored = await loadResearchStatutoryDisclosureDocuments(c.env.DB, code);
    const documents = stored.items.map(asStatutoryDisclosureDocument).filter((item): item is StatutoryDisclosureDocument => item !== null);
    const produced = await produceAhStatutoryVerifications(c.env, { securityCode: code, normalizedFacts: statutoryFacts, documents, observedAt, createdAt: observedAt });
    const provider = classified.market === "a_share" ? "cninfo" : "hkex";
    await recordAhFinancialAvailability(c.env.DB, code, factSet.loaded, produced, observedAt, provider);
    const matched = produced.filter((item) => item.verification.outcome === "match");
    return ok(c, {
      code,
      primaryProvider: "eastmoney",
      statutoryProvider: provider,
      createdCount: produced.length,
      outcomes: {
        match: matched.length,
        conflict: produced.filter((item) => item.verification.outcome === "conflict").length,
        unverified: produced.filter((item) => item.verification.outcome === "unverified").length,
      },
      matchedMetrics: [...new Set(matched.map((item) => item.verification.normalizedFact.metric))],
      primarySourceErrors: factSet.sourceErrors.map((item) => ({ statementType: item.statementType, error: item.error })),
      disclosureIndex: disclosureWindow,
      limitations: ["该操作只追加 Eastmoney 主财报与 CNINFO/HKEX 法定字段的核验记录；法定披露不会作为 Eastmoney 的 fallback，未找到或未解析字段会显式保留为未核验。"],
    });
  } catch (error) {
    return fail(c, 502, error instanceof Error ? error.message : String(error));
  }
});

/**
 * A human-reviewed exception for a Yahoo display date that is not the SEC
 * issuer's actual fiscal end.  The record is immutable and local-only; it
 * never edits Yahoo rows or enables a nearest-date match.
 */
researchRoutes.post("/research/company/:code/us-financial-period-equivalences", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "US financial period equivalence writes are only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code) || !code.endsWith(".US")) return fail(c, 400, "US financial period equivalence requires a supported US security code");
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return fail(c, 400, "invalid US financial period equivalence body");
  try {
    const security = (await getSecurity(c.env.DB, code)) ?? fallbackResearchSecurity(code);
    const existingResearchSecurity = await c.env.DB.prepare(`select 1 as present from research_listed_securities where security_code=?`)
      .bind(code).first<{ present: number }>();
    if (!existingResearchSecurity) await upsertListedSecurity(c.env.DB, { security });
    const statementType = enumValue(body.primaryStatementType, ["income", "balance", "cashflow"] as const, "primaryStatementType");
    const metric = requiredText(body.metric, "metric");
    const primaryPeriodEndDate = requiredText(body.primaryPeriodEndDate, "primaryPeriodEndDate");
    const primaryPeriodStartDate = requiredText(body.primaryPeriodStartDate, "primaryPeriodStartDate");
    const factSet = await loadResearchFinancialFactSet(c.env, code);
    if (factSet.sourceErrors.length) return fail(c, 502, `Yahoo primary financial source failed: ${factSet.sourceErrors.map((item) => `${item.statementType}: ${item.error}`).join("; ")}`);
    const matchingFacts = factSet.facts.filter((fact) => fact.provenance.sourceType === "yahoo"
      && fact.provenance.sourceId.split(":")[2] === statementType
      && fact.metric === metric
      && fact.period.startDate === primaryPeriodStartDate
      && fact.period.endDate === primaryPeriodEndDate
      && Boolean(fact.canonicalComparisonKey));
    if (matchingFacts.length !== 1) return fail(c, 409, "current Yahoo primary fact must resolve to exactly one metric and period before an equivalence can be reviewed");
    const input: UsFinancialPeriodEquivalenceWrite = {
      periodEquivalenceId: stringOrNull(body.periodEquivalenceId) ?? `us-period-equivalence:${crypto.randomUUID()}`,
      secCik: requiredText(body.secCik, "secCik"), secAccession: requiredText(body.secAccession, "secAccession"),
      secNamespace: enumValue(body.secNamespace, ["us-gaap", "ifrs-full"] as const, "secNamespace"), secConcept: requiredText(body.secConcept, "secConcept"),
      secUnit: requiredText(body.secUnit, "secUnit"), secPeriodStartDate: stringOrNull(body.secPeriodStartDate), secPeriodEndDate: requiredText(body.secPeriodEndDate, "secPeriodEndDate"),
      secForm: enumValue(body.secForm, ["10-K", "10-Q", "20-F", "6-K"] as const, "secForm"), evidenceUrl: requiredText(body.evidenceUrl, "evidenceUrl"), evidenceTitle: requiredText(body.evidenceTitle, "evidenceTitle"),
      reviewDecision: enumValue(body.reviewDecision, ["accepted", "rejected"] as const, "reviewDecision"), reviewReason: requiredText(body.reviewReason, "reviewReason"),
      reviewedBy: stringOrNull(body.reviewedBy) ?? "local-user", reviewedAt: finiteTimestamp(body.reviewedAt) ?? Date.now(),
    };
    return ok(c, await appendUsFinancialPeriodEquivalence(c.env.DB, code, matchingFacts[0], input));
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.post("/research/company/:code/valuation-models/dcf", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "valuation model writes are only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return fail(c, 400, "invalid valuation model body");
  const security = (await getSecurity(c.env.DB, code)) ?? fallbackResearchSecurity(code);
  const identity = await loadResearchIdentityFinancials(c.env.DB, security);
  const companyId = (identity.operatingCompany as { companyId?: string } | null)?.companyId ?? null;
  const now = Date.now();
  try {
    await requirePerShareMarketStructure(c.env.DB, { code, market: identity.listedSecurity.market, instrumentKind: identity.listedSecurity.instrumentKind });
    const result = await createDcfValuationModelVersion(c.env.DB, {
      ...body,
      modelVersionId: stringOrNull(body.modelVersionId) ?? `dcf:${crypto.randomUUID()}`,
      companyId,
      securityCode: code,
      asOf: finiteTimestamp(body.asOf) ?? now,
      createdAt: finiteTimestamp(body.createdAt) ?? now,
    } as BuildDcfValuationModelInput);
    return ok(c, result);
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.post("/research/company/:code/valuation-models/operating-scenario", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "valuation model writes are only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  const body = await c.req.json().catch(() => null) as { scenario?: SelfBuiltOperatingScenario; target?: Partial<OperatingScenarioDcfModelTarget>; formalActualAnchorIds?: unknown } | null;
  if (!body?.scenario || !body.target) return fail(c, 400, "scenario and target are required");
  const security = (await getSecurity(c.env.DB, code)) ?? fallbackResearchSecurity(code);
  const identity = await loadResearchIdentityFinancials(c.env.DB, security);
  const now = Date.now();
  try {
    await requirePerShareMarketStructure(c.env.DB, { code, market: identity.listedSecurity.market, instrumentKind: identity.listedSecurity.instrumentKind });
    const target = {
      modelVersionId: body.target.modelVersionId ?? `dcf:scenario:${crypto.randomUUID()}`,
      companyId: (identity.operatingCompany as { companyId?: string } | null)?.companyId ?? null,
      securityCode: code,
      asOf: body.target.asOf ?? now,
      createdAt: body.target.createdAt ?? now,
      status: body.target.status ?? "draft",
      securityCurrency: body.target.securityCurrency ?? security.currency ?? body.scenario.valuationCurrency,
      fxRateToSecurity: body.target.fxRateToSecurity ?? null,
      fxAsOf: body.target.fxAsOf ?? null,
      fxSourceReferences: body.target.fxSourceReferences ?? [],
      underlyingSharesPerSecurity: body.target.underlyingSharesPerSecurity ?? identity.listedSecurity.depositaryRatio ?? 1,
      sourceReferences: body.target.sourceReferences ?? [],
    } satisfies OperatingScenarioDcfModelTarget;
    const actualIds = body.formalActualAnchorIds === undefined ? [] : formalActualAnchorIds(body.formalActualAnchorIds);
    const anchors = await Promise.all(actualIds.map(async (actualId) => ({ inputKey: "opening_revenue" as const, actual: await loadFormalActualById(c.env.DB, actualId, code) })));
    const model = anchors.length
      ? buildDcfValuationInputFromOperatingScenarioWithFormalActualAnchors(body.scenario, target, anchors)
      : buildDcfValuationInputFromOperatingScenario(body.scenario, target);
    return ok(c, await createDcfValuationModelVersion(c.env.DB, model));
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.post("/research/company/:code/valuation-models/reverse-dcf", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "valuation model writes are only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return fail(c, 400, "invalid reverse valuation model body");
  const security = (await getSecurity(c.env.DB, code)) ?? fallbackResearchSecurity(code);
  const identity = await loadResearchIdentityFinancials(c.env.DB, security);
  const now = Date.now();
  try {
    await requirePerShareMarketStructure(c.env.DB, { code, market: identity.listedSecurity.market, instrumentKind: identity.listedSecurity.instrumentKind });
    const model = await createReverseDcfValuationModelVersion(c.env.DB, {
      ...body,
      modelVersionId: stringOrNull(body.modelVersionId) ?? `reverse-dcf:${crypto.randomUUID()}`,
      companyId: (identity.operatingCompany as { companyId?: string } | null)?.companyId ?? null,
      securityCode: code,
      asOf: finiteTimestamp(body.asOf) ?? now,
      createdAt: finiteTimestamp(body.createdAt) ?? now,
      status: body.status ?? "draft",
      securityCurrency: body.securityCurrency ?? security.currency ?? "",
    } as BuildReverseDcfValuationModelInput);
    return ok(c, model);
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.get("/research/company/:code/relative-valuations", async (c) => {
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  try { return ok(c, await loadResearchRelativeValuationLedgers(c.env.DB, { securityCode: code, asOf: Date.now() })); }
  catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.post("/research/company/:code/relative-valuations", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "relative valuation writes are only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return fail(c, 400, "invalid relative valuation body");
  const security = (await getSecurity(c.env.DB, code)) ?? fallbackResearchSecurity(code);
  const identity = await loadResearchIdentityFinancials(c.env.DB, security);
  const companyId = (identity.operatingCompany as { companyId?: string } | null)?.companyId ?? null;
  if (!companyId || identity.listedSecurity.mappingStatus !== "confirmed") {
    return fail(c, 409, "relative valuation requires a confirmed operating-company and listed-security mapping");
  }
  const now = Date.now();
  try {
    return ok(c, await createResearchRelativeValuationLedger(c.env.DB, {
      ...body,
      ledgerId: stringOrNull(body.ledgerId) ?? `relative-valuation:${crypto.randomUUID()}`,
      companyId,
      securityCode: code,
      asOf: finiteTimestamp(body.asOf) ?? now,
      createdAt: finiteTimestamp(body.createdAt) ?? now,
    } as BuildRelativeValuationLedgerInput));
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.post("/research/company/:code/identity", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "research writes are only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  const security = (await getSecurity(c.env.DB, code)) ?? fallbackResearchSecurity(code);
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return fail(c, 400, "invalid identity body");
  try {
    // Rights profiles and links are append-only evidence.  Validate their
    // complete payload and known immutable-version conflicts before updating
    // the identity/relationship rows, so a replayed official sample cannot
    // leave a half-applied ADR or A/H mapping behind.
    await preflightIdentityEvidenceWrite(c.env.DB, code, body);
    const currentInstrumentType = stringOrNull(body.securityInstrumentType);
    const identitySecurity = currentInstrumentType ? { ...security, type: enumValue(currentInstrumentType, ["stock", "adr", "depositary_receipt"] as const, "securityInstrumentType") } : security;
    await upsertListedSecurity(c.env.DB, { security: identitySecurity, shareClass: stringOrNull(body.shareClass), depositaryRatio: numberOrNull(body.depositaryRatio), metadata: objectOrEmpty(body.metadata) });
    if (body.operatingCompany && typeof body.operatingCompany === "object") {
      const company = body.operatingCompany as Record<string, unknown>;
      const companyId = requiredText(company.companyId, "operatingCompany.companyId");
      await upsertOperatingCompany(c.env.DB, {
        companyId, canonicalName: requiredText(company.canonicalName, "operatingCompany.canonicalName"),
        reportingCurrency: stringOrNull(company.reportingCurrency), fiscalYearEnd: stringOrNull(company.fiscalYearEnd),
        identityStatus: enumValue(company.identityStatus, ["confirmed", "provisional", "needs_review"] as const, "operatingCompany.identityStatus"),
        metadata: objectOrEmpty(company.metadata),
      } satisfies OperatingCompanyWrite);
      const relationship = body.relationship && typeof body.relationship === "object" ? body.relationship as Record<string, unknown> : {};
      await upsertCompanySecurityRelationship(c.env.DB, {
        relationshipId: stringOrNull(relationship.relationshipId) ?? `company-security:${crypto.randomUUID()}`,
        companyId, securityCode: code,
        relationshipType: enumValue(relationship.relationshipType ?? "primary_listing", ["primary_listing", "secondary_listing", "depositary_receipt", "other_equity_claim"] as const, "relationship.relationshipType"),
        relationshipStatus: enumValue(relationship.relationshipStatus ?? company.identityStatus, ["confirmed", "provisional", "needs_review", "conflicting"] as const, "relationship.relationshipStatus"),
        sourceUrl: stringOrNull(relationship.sourceUrl), sourceNote: requiredText(relationship.sourceNote ?? relationship.sourceUrl, "relationship.sourceNote"),
        effectiveFrom: stringOrNull(relationship.effectiveFrom), effectiveTo: stringOrNull(relationship.effectiveTo), metadata: objectOrEmpty(relationship.metadata),
      } satisfies CompanySecurityRelationshipWrite);
    }
    if (Array.isArray(body.providerIdentifiers)) for (const raw of body.providerIdentifiers) {
      if (!raw || typeof raw !== "object") throw new Error("providerIdentifiers entries must be objects");
      const value = raw as Record<string, unknown>;
      await upsertProviderIdentifier(c.env.DB, {
        identifierId: stringOrNull(value.identifierId) ?? `provider-identifier:${crypto.randomUUID()}`,
        ownerType: enumValue(value.ownerType, ["operating_company", "listed_security"] as const, "providerIdentifier.ownerType"),
        companyId: stringOrNull(value.companyId), securityCode: stringOrNull(value.securityCode), provider: requiredText(value.provider, "providerIdentifier.provider"),
        identifierKind: requiredText(value.identifierKind, "providerIdentifier.identifierKind"), identifierValue: requiredText(value.identifierValue, "providerIdentifier.identifierValue"),
        identifierStatus: enumValue(value.identifierStatus, ["confirmed", "provisional", "needs_review", "conflicting", "inactive"] as const, "providerIdentifier.identifierStatus"),
        sourceUrl: stringOrNull(value.sourceUrl), sourceNote: stringOrNull(value.sourceNote), observedAt: finiteTimestamp(value.observedAt) ?? Date.now(), metadata: objectOrEmpty(value.metadata),
      } satisfies ProviderIdentifierWrite);
    }
    if (body.rightsProfile && typeof body.rightsProfile === "object") {
      await insertSecurityRightsProfile(c.env.DB, securityRightsProfileWrite(code, body.rightsProfile as Record<string, unknown>));
    }
    if (body.linkedSecurity && typeof body.linkedSecurity === "object") {
      if (!body.operatingCompany || typeof body.operatingCompany !== "object") {
        throw new Error("linkedSecurity requires an explicit operatingCompany mapping; company names are never used to infer a link");
      }
      const company = body.operatingCompany as Record<string, unknown>;
      const companyId = requiredText(company.companyId, "operatingCompany.companyId");
      const linked = body.linkedSecurity as Record<string, unknown>;
      const linkedCode = normalizeSecurityCode(requiredText(linked.code, "linkedSecurity.code"));
      if (!isSupportedCompanyCode(linkedCode) || linkedCode === code) throw new Error("linkedSecurity.code must be a distinct supported company security code");
      const linkedSecurity: SecurityRecord = {
        code: linkedCode,
        name: requiredText(linked.name, "linkedSecurity.name"),
        market: requiredText(linked.market, "linkedSecurity.market"),
        type: enumValue(linked.instrumentType ?? "stock", ["stock", "adr", "depositary_receipt"] as const, "linkedSecurity.instrumentType"),
        currency: stringOrNull(linked.currency), updatedAt: Date.now(), source: "research_identity_manual",
      };
      await upsertListedSecurity(c.env.DB, {
        security: linkedSecurity, shareClass: stringOrNull(linked.shareClass), depositaryRatio: numberOrNull(linked.depositaryRatio),
        metadata: objectOrEmpty(linked.metadata),
      });
      const linkedRelationship = linked.relationship && typeof linked.relationship === "object" ? linked.relationship as Record<string, unknown> : null;
      if (!linkedRelationship) throw new Error("linkedSecurity.relationship is required");
      await upsertCompanySecurityRelationship(c.env.DB, {
        relationshipId: stringOrNull(linkedRelationship.relationshipId) ?? `company-security:${crypto.randomUUID()}`,
        companyId, securityCode: linkedCode,
        relationshipType: enumValue(linkedRelationship.relationshipType, ["primary_listing", "secondary_listing", "depositary_receipt", "other_equity_claim"] as const, "linkedSecurity.relationship.relationshipType"),
        relationshipStatus: enumValue(linkedRelationship.relationshipStatus ?? company.identityStatus, ["confirmed", "provisional", "needs_review", "conflicting"] as const, "linkedSecurity.relationship.relationshipStatus"),
        sourceUrl: stringOrNull(linkedRelationship.sourceUrl), sourceNote: requiredText(linkedRelationship.sourceNote ?? linkedRelationship.sourceUrl, "linkedSecurity.relationship.sourceNote"),
        effectiveFrom: stringOrNull(linkedRelationship.effectiveFrom), effectiveTo: stringOrNull(linkedRelationship.effectiveTo), metadata: objectOrEmpty(linkedRelationship.metadata),
      } satisfies CompanySecurityRelationshipWrite);
      if (linked.rightsProfile && typeof linked.rightsProfile === "object") {
        await insertSecurityRightsProfile(c.env.DB, securityRightsProfileWrite(linkedCode, linked.rightsProfile as Record<string, unknown>));
      }
      if (!linked.rightsLink || typeof linked.rightsLink !== "object") throw new Error("linkedSecurity.rightsLink is required");
      await insertSecurityRightsLink(c.env.DB, securityRightsLinkWrite(code, linkedCode, linked.rightsLink as Record<string, unknown>));
    }
    return ok(c, await loadResearchIdentityFinancials(c.env.DB, identitySecurity));
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.get("/research/company/:code/market-structure", async (c) => {
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  const security = (await getSecurity(c.env.DB, code)) ?? fallbackResearchSecurity(code);
  try {
    const identity = await loadResearchIdentityFinancials(c.env.DB, security);
    return ok(c, await loadResearchMarketStructure(c.env.DB, { code, market: identity.listedSecurity.market, instrumentKind: identity.listedSecurity.instrumentKind }));
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.get("/research/company/:code/financial-profile", async (c) => {
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  try { return ok(c, await loadResearchFinancialProfile(c.env.DB, code)); }
  catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.post("/research/company/:code/financial-profile", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "financial profile manual writes are only available in local research runtime");
  return fail(c, 410, "financial profile manual writes are retired; only automatic source-bound filing inputs may update research profiles");
});

researchRoutes.get("/research/company/:code/financial-specialty-metrics", async (c) => {
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  try { return ok(c, await loadResearchFinancialSpecialtyLedger(c.env.DB, code)); }
  catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.post("/research/company/:code/financial-specialty-metrics", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "financial specialty metric manual writes are only available in local research runtime");
  return fail(c, 410, "financial specialty metric manual writes are retired; only automatic source-bound filing inputs may update research metrics");
});

researchRoutes.post("/research/company/:code/market-structure/facts", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "market structure writes are only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return fail(c, 400, "invalid market structure fact body");
  try {
    const security = (await getSecurity(c.env.DB, code)) ?? fallbackResearchSecurity(code);
    const identity = await loadResearchIdentityFinancials(c.env.DB, security);
    if (!identity.listedSecurity.persisted) throw new Error("market structure facts require a persisted listed-security identity first");
    const result = await insertResearchMarketStructureFact(c.env.DB, {
      marketStructureFactId: stringOrNull(body.marketStructureFactId) ?? `market-structure:${crypto.randomUUID()}`,
      securityCode: code,
      factKey: requiredText(body.factKey, "factKey"),
      factStatus: enumValue(body.factStatus, ["verified", "unavailable", "not_applicable", "conflicting"] as const, "factStatus"),
      valueKind: enumValue(body.valueKind, ["number", "text"] as const, "valueKind"),
      valueNumber: numberOrNull(body.valueNumber), valueText: stringOrNull(body.valueText), unit: stringOrNull(body.unit), measurementBasis: stringOrNull(body.measurementBasis) as MarketStructureFactWrite["measurementBasis"],
      asOf: requiredText(body.asOf, "asOf"),
      frequency: enumValue(body.frequency, ["event", "annual", "quarterly", "periodic", "rule_change"] as const, "frequency"),
      epistemicType: enumValue(body.epistemicType, ["observed_fact", "source_viewpoint"] as const, "epistemicType"),
      sourceAuthority: enumValue(body.sourceAuthority, ["issuer_disclosure", "exchange_rule", "regulator_filing", "regulator_rule", "depositary_agreement", "tax_authority_rule", "broker_rule"] as const, "sourceAuthority"),
      sourceUrl: requiredText(body.sourceUrl, "sourceUrl"), sourceTitle: requiredText(body.sourceTitle, "sourceTitle"), sourceNote: requiredText(body.sourceNote, "sourceNote"),
      effectiveFrom: stringOrNull(body.effectiveFrom), effectiveTo: stringOrNull(body.effectiveTo), createdAt: finiteTimestamp(body.createdAt) ?? Date.now(),
    } satisfies MarketStructureFactWrite);
    return ok(c, result);
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.post("/research/company/:code/risk-pressure-scenarios", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "risk scenario writes are only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return fail(c, 400, "invalid risk pressure scenario body");
  try {
    assertPublicResearchBody(body);
    const security = (await getSecurity(c.env.DB, code)) ?? fallbackResearchSecurity(code);
    const identity = await loadResearchIdentityFinancials(c.env.DB, security);
    const companyId = (identity.operatingCompany as { companyId?: string } | null)?.companyId ?? null;
    if (body.companyId !== undefined && body.companyId !== companyId) return fail(c, 400, "companyId must match the mapped operating company");
    const now = Date.now();
    return ok(c, await insertResearchRiskPressureScenario(c.env.DB, {
      ...body, scenarioId: stringOrNull(body.scenarioId) ?? `risk-pressure:${crypto.randomUUID()}`,
      companyId, securityCode: code, asOf: finiteTimestamp(body.asOf) ?? now,
      createdAt: finiteTimestamp(body.createdAt) ?? now, updatedAt: finiteTimestamp(body.updatedAt) ?? now,
    } as Parameters<typeof insertResearchRiskPressureScenario>[1]));
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.get("/research/company/:code/risk-pressure-scenarios/:scenarioId/stress", async (c) => {
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  const monetaryUnit = requiredText(c.req.query("monetaryUnit"), "monetaryUnit");
  try {
    const scenario = await loadResearchRiskPressureScenario(c.env.DB, { securityCode: code, scenarioId: c.req.param("scenarioId") });
    if (!scenario) return fail(c, 404, "risk pressure scenario not found");
    return ok(c, calculateResearchRiskStress({ scenario, monetaryUnit }));
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.post("/research/company/:code/risk-relationships", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "risk relationship writes are only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return fail(c, 400, "invalid risk relationship body");
  try {
    assertPublicResearchBody(body);
    const security = (await getSecurity(c.env.DB, code)) ?? fallbackResearchSecurity(code);
    const identity = await loadResearchIdentityFinancials(c.env.DB, security);
    const companyId = (identity.operatingCompany as { companyId?: string } | null)?.companyId ?? null;
    if (body.companyId !== undefined && body.companyId !== companyId) return fail(c, 400, "companyId must match the mapped operating company");
    const now = Date.now();
    return ok(c, await insertResearchRiskRelationship(c.env.DB, {
      ...body, relationshipId: stringOrNull(body.relationshipId) ?? `risk-relationship:${crypto.randomUUID()}`,
      companyId, securityCode: code, asOf: finiteTimestamp(body.asOf) ?? now,
      createdAt: finiteTimestamp(body.createdAt) ?? now, updatedAt: finiteTimestamp(body.updatedAt) ?? now,
    } as Parameters<typeof insertResearchRiskRelationship>[1]));
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.post("/research/company/:code/risk-thesis-links", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "risk thesis link writes are only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return fail(c, 400, "invalid risk thesis link body");
  try {
    assertPublicResearchBody(body);
    const security = (await getSecurity(c.env.DB, code)) ?? fallbackResearchSecurity(code);
    const identity = await loadResearchIdentityFinancials(c.env.DB, security);
    const companyId = (identity.operatingCompany as { companyId?: string } | null)?.companyId ?? null;
    if (!companyId) return fail(c, 409, "operating-company mapping is required before linking a risk to a thesis");
    const riskId = requiredText(body.riskId, "riskId"); const thesisId = requiredText(body.thesisId, "thesisId");
    if (!await validateRiskThesisLinkOwnership(c.env.DB, { securityCode: code, companyId, riskId, thesisId })) return fail(c, 400, "risk and thesis must belong to this public research subject");
    const now = Date.now();
    return ok(c, await insertResearchRiskThesisLink(c.env.DB, {
      ...body, riskId, thesisId, riskThesisLinkId: stringOrNull(body.riskThesisLinkId) ?? `risk-thesis-link:${crypto.randomUUID()}`,
      createdAt: finiteTimestamp(body.createdAt) ?? now,
    } as Parameters<typeof insertResearchRiskThesisLink>[1]));
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.get("/research/company/:code/risk-review-queue", async (c) => {
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  const now = Date.now();
  try {
    const [dossier, review] = await Promise.all([
      loadResearchDossier(c.env.DB, { securityCode: code, asOf: now }),
      loadResearchRiskReview(c.env.DB, { securityCode: code, asOf: now }),
    ]);
    if (dossier.risks.availability !== "available" || dossier.theses.availability !== "available") {
      return ok(c, { availability: "unavailable", reason: "public_risk_or_thesis_records_unavailable", items: [] });
    }
    return ok(c, { availability: "available", reason: null, items: buildResearchRiskThesisPropagation({
      risks: dossier.risks.items, theses: dossier.theses.items, links: review.thesisLinks,
    }) });
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.get("/research/company/:code/public-risk-snapshots", async (c) => {
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  const requestedAsOf = finiteTimestamp(c.req.query("asOf"));
  const requestedLimit = Number(c.req.query("limit"));
  try {
    return ok(c, await loadPublicRiskReviewSnapshotHistory(c.env.DB, {
      securityCode: code,
      asOf: requestedAsOf ?? Date.now(),
      limit: Number.isFinite(requestedLimit) ? requestedLimit : undefined,
    }));
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.post("/research/company/:code/public-risk-snapshots", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "public risk snapshot writes are only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return fail(c, 400, "invalid public risk snapshot body");
  try {
    assertPublicResearchBody(body);
    const security = (await getSecurity(c.env.DB, code)) ?? fallbackResearchSecurity(code);
    const identity = await loadResearchIdentityFinancials(c.env.DB, security);
    const companyId = (identity.operatingCompany as { companyId?: string } | null)?.companyId ?? null;
    if (!companyId) return fail(c, 409, "operating-company mapping is required before freezing a public risk snapshot");
    const now = Date.now(); const asOf = finiteTimestamp(body.asOf) ?? now;
    const [dossier, review, focusView, impactReviews] = await Promise.all([
      loadResearchDossier(c.env.DB, { securityCode: code, asOf }),
      loadResearchRiskReview(c.env.DB, { securityCode: code, asOf }),
      loadResearchCompanyFocusProfile(c.env.DB, { companyId, securityCode: code, asOf }),
      loadGuidanceEventImpactReviews(c.env.DB, code),
    ]);
    if (dossier.availability !== "available") return fail(c, 409, "public dossier is unavailable for this research subject");
    return ok(c, await savePublicRiskReviewSnapshot(c.env.DB, {
      analysisSnapshotId: stringOrNull(body.analysisSnapshotId) ?? `public-risk-snapshot:${crypto.randomUUID()}`,
      companyId, securityCode: code, asOf,
      completionLevel: enumValue(body.completionLevel ?? "basic", ["basic", "standard", "deep"] as const, "completionLevel"),
      state: requiredText(body.state ?? "资料待补", "state"), createdAt: now,
      risks: dossier.risks.items, theses: dossier.theses.items,
      pressureScenarios: review.pressureScenarios, relationships: review.relationships,
      impactReviews,
      focusProfile: focusView.profile,
    }));
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

// This is a separate timeline from public-risk-snapshots.  A risk review is a
// useful narrow checkpoint; a research snapshot is the replayable public state
// of facts, forecasts, assumptions, valuation versions and conclusions.
researchRoutes.get("/research/company/:code/public-research-snapshots", async (c) => {
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  const requestedAsOf = finiteTimestamp(c.req.query("asOf"));
  const requestedLimit = Number(c.req.query("limit"));
  try {
    return ok(c, await loadPublicResearchSnapshotHistory(c.env.DB, {
      securityCode: code, asOf: requestedAsOf ?? Date.now(), limit: Number.isFinite(requestedLimit) ? requestedLimit : undefined,
    }));
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

// Owner holding references are a private local-only convenience.  Public
// research snapshots remain readable independently, but production has no
// authenticated owner model and must never expose or mutate owner data.
researchRoutes.get("/research/company/:code/owner-holding-snapshot-references", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "owner holding snapshot references are only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  const ownerKey = c.req.query("owner")?.trim() || "local-user";
  try {
    return ok(c, await loadOwnerHoldingPublicSnapshotReferences(c.env.DB, { ownerKey, holdingSecurityCode: code }));
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.post("/research/company/:code/owner-holding-snapshot-references", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "owner holding snapshot references are only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return fail(c, 400, "invalid owner holding snapshot reference body");
  try {
    const now = Date.now();
    const ownerKey = stringOrNull(body.ownerKey) ?? "local-user";
    const publicSnapshotId = requiredText(body.publicSnapshotId, "publicSnapshotId");
    return ok(c, await createOwnerHoldingPublicSnapshotReference(c.env.DB, {
      referenceId: stringOrNull(body.referenceId) ?? `owner-holding-snapshot-reference:${crypto.randomUUID()}`,
      ownerKey,
      holdingSecurityCode: code,
      publicSnapshotId,
      createdAt: finiteTimestamp(body.createdAt) ?? now,
    }));
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.post("/research/company/:code/public-research-snapshots", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "public research snapshot writes are only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return fail(c, 400, "invalid public research snapshot body");
  try {
    assertPublicResearchBody(body);
    const security = (await getSecurity(c.env.DB, code)) ?? fallbackResearchSecurity(code);
    const now = Date.now(); const asOf = finiteTimestamp(body.asOf) ?? now;
    const identity = await loadResearchIdentityFinancials(c.env.DB, security);
    const companyId = (identity.operatingCompany as { companyId?: string } | null)?.companyId ?? null;
    if (!companyId) return fail(c, 409, "operating-company mapping is required before freezing a public research snapshot");
    const [dossier, marketStructure, statutoryVerifications, statutoryDocuments, operatingModels, operatingDriverPlans, marketSpaceAssessments, forecastWorkspace, managementGuidance, formalActuals, valuationModels, reverseValuationModels, relativeValuationLedgers, impactReviews, focusProfile, modelReviewItems, financials, operatingSourceFacts, operatingSourceFactBindings, governanceCapitalFacts] = await Promise.all([
      loadResearchDossier(c.env.DB, { securityCode: code, asOf }),
      loadResearchMarketStructure(c.env.DB, { code, market: identity.listedSecurity.market, instrumentKind: identity.listedSecurity.instrumentKind }),
      loadOptionalResearchExtension(() => loadFinancialStatutoryVerifications(c.env.DB, code, { limit: 100 })),
      loadResearchStatutoryDisclosureDocuments(c.env.DB, code),
      loadResearchOperatingModels(c.env.DB, { companyId, asOf }),
      loadResearchOperatingDriverPlans(c.env.DB, { companyId, asOf }),
      loadResearchMarketSpaceAssessments(c.env.DB, { companyId, asOf }),
      loadForecastWorkspace(c.env.DB, code, security),
      loadManagementGuidanceForecasts(c.env.DB, code),
      loadFormalActuals(c.env.DB, code),
      loadDcfValuationModelVersions(c.env.DB, code, asOf),
      loadReverseDcfValuationModelVersions(c.env.DB, code, asOf),
      loadResearchRelativeValuationLedgers(c.env.DB, { securityCode: code, asOf }),
      loadGuidanceEventImpactReviews(c.env.DB, code),
      loadResearchCompanyFocusProfile(c.env.DB, { companyId, securityCode: code, asOf }),
      loadModelReviewItems(c.env.DB, code),
      (async () => {
        const profile = await loadResearchFinancialProfile(c.env.DB, code);
        return loadResearchFinancialQuality(c.env, code, { entityType: profile.qualityEntityType });
      })(),
      loadResearchOperatingSourceFacts(c.env.DB, { operatingCompanyId: companyId }),
      loadResearchOperatingSourceFactBindings(c.env.DB, { operatingCompanyId: companyId }),
      loadResearchGovernanceCapitalFactLedger(c.env.DB, code),
    ]);
    if (dossier.availability !== "available") return fail(c, 409, "public dossier is unavailable for this research subject");
    const coverage = buildResearchCoverage({
      identity, financials, marketStructure,
      operating: { models: operatingModels, driverPlans: operatingDriverPlans, marketSpaceAssessments },
      industry: { competitiveMarkets: dossier.competitiveMarkets },
      forecast: forecastWorkspace.forecastCoverage, valuation: valuationModels, reverseValuation: reverseValuationModels,
      risk: dossier.risks, theses: dossier.theses, modelReviewItems, market: {},
    });
    const valuationGate = coverage.modules.find((item) => item.moduleId === "valuation") ?? { status: "blocked", conclusionImpact: "估值门禁读取失败，精确价值保持不可得。", nextEvidence: "重新读取估值前置门禁。" };
    const snapshot = projectPublicResearchSnapshot({
      asOf, identity, marketStructure, statutoryVerifications, statutoryDocuments, operatingModels, operatingDriverPlans, marketSpaceAssessments,
      forecastWorkspace, valuationModels, reverseValuationModels, relativeValuationLedgers, dossier, impactReviews,
      focusProfile, managementGuidance, formalActuals, valuationGate, financialQuality: financials.quality,
      operatingSourceFacts, operatingSourceFactBindings, governanceCapitalFacts,
    });
    return ok(c, await savePublicResearchSnapshot(c.env.DB, {
      analysisSnapshotId: stringOrNull(body.analysisSnapshotId) ?? `public-research-snapshot:${crypto.randomUUID()}`,
      companyId, securityCode: code, asOf,
      completionLevel: enumValue(body.completionLevel ?? "basic", ["basic", "standard", "deep"] as const, "completionLevel"),
      state: requiredText(body.state ?? "资料待补", "state"), createdAt: now, snapshot,
    }));
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.post("/research/company/:code/dossier/:section", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "research writes are only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  const security = (await getSecurity(c.env.DB, code)) ?? fallbackResearchSecurity(code);
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return fail(c, 400, "invalid dossier body");
  const identity = await loadResearchIdentityFinancials(c.env.DB, security);
  const now = Date.now();
  const companyId = (identity.operatingCompany as { companyId?: string } | null)?.companyId ?? null;
  try {
    const section = c.req.param("section");
    const shared = { ...body, securityCode: code, companyId: body.companyId ?? companyId, asOf: finiteTimestamp(body.asOf) ?? now, createdAt: finiteTimestamp(body.createdAt) ?? now, updatedAt: finiteTimestamp(body.updatedAt) ?? now };
    const result = section === "business-model" ? await insertResearchBusinessModel(c.env.DB, { ...shared, businessModelId: stringOrNull(body.businessModelId) ?? `business-model:${crypto.randomUUID()}`, segments: Array.isArray(body.segments) ? body.segments : [] } as never)
      : section === "market-space" ? await insertResearchMarketSpaceModel(c.env.DB, { ...shared, marketSpaceId: stringOrNull(body.marketSpaceId) ?? `market-space:${crypto.randomUUID()}` } as never)
        : section === "competitive-market" ? await insertResearchCompetitiveMarket(c.env.DB, { ...shared, competitiveMarketId: stringOrNull(body.competitiveMarketId) ?? `competitive-market:${crypto.randomUUID()}`, competitors: Array.isArray(body.competitors) ? body.competitors : [] } as never)
          : section === "thesis" ? await insertResearchThesis(c.env.DB, { ...shared, thesisId: stringOrNull(body.thesisId) ?? `thesis:${crypto.randomUUID()}`, evidence: Array.isArray(body.evidence) ? body.evidence : [] } as never)
            : section === "valuation" ? await insertResearchValuationCase(c.env.DB, { ...shared, valuationCaseId: stringOrNull(body.valuationCaseId) ?? `valuation:${crypto.randomUUID()}` } as never)
              : section === "risk" ? await insertResearchRiskEntry(c.env.DB, { ...shared, riskId: stringOrNull(body.riskId) ?? `risk:${crypto.randomUUID()}` } as never)
                : section === "catalyst" ? await insertResearchCatalyst(c.env.DB, { ...shared, catalystId: stringOrNull(body.catalystId) ?? `catalyst:${crypto.randomUUID()}` } as never)
                  : section === "snapshot" ? await insertResearchAnalysisSnapshot(c.env.DB, { ...shared, analysisSnapshotId: stringOrNull(body.analysisSnapshotId) ?? `snapshot:${crypto.randomUUID()}` } as never)
                    : section === "user-note" ? await insertResearchUserNote(c.env.DB, { ...shared, noteId: stringOrNull(body.noteId) ?? `user-note:${crypto.randomUUID()}`, ownerKey: requiredText(body.ownerKey ?? "local-user", "ownerKey") } as never)
                      : section === "governance" ? await insertResearchGovernance(c.env.DB, { ...shared, companyId: requiredText(shared.companyId, "companyId"), governanceRecordId: stringOrNull(body.governanceRecordId) ?? `governance:${crypto.randomUUID()}` } as never)
                      : null;
    if (!result) return fail(c, 404, "unsupported dossier section");
    return ok(c, result);
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.post("/research/company/:code/catalysts/:catalystId/reviews", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "catalyst review writes are only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return fail(c, 400, "invalid catalyst review body");
  try {
    assertPublicResearchBody(body);
    const security = (await getSecurity(c.env.DB, code)) ?? fallbackResearchSecurity(code);
    const identity = await loadResearchIdentityFinancials(c.env.DB, security);
    const companyId = (identity.operatingCompany as { companyId?: string } | null)?.companyId ?? null;
    const now = Date.now();
    return ok(c, await insertResearchCatalystReview(c.env.DB, {
      catalystReviewId: stringOrNull(body.catalystReviewId) ?? `catalyst-review:${crypto.randomUUID()}`,
      catalystId: c.req.param("catalystId"), companyId, securityCode: code,
      asOf: finiteTimestamp(body.asOf) ?? now,
      reviewStatus: enumValue(body.reviewStatus, ["observed", "partially_confirmed", "confirmed", "missed", "not_comparable"] as const, "reviewStatus"),
      outcomeSummary: requiredText(body.outcomeSummary, "outcomeSummary"), expectedVsActual: requiredText(body.expectedVsActual, "expectedVsActual"),
      impactedAssumptionStatus: enumValue(body.impactedAssumptionStatus, ["confirmed", "weakened", "invalidated", "not_tested"] as const, "impactedAssumptionStatus"),
      nextAction: requiredText(body.nextAction, "nextAction"), sourceReferences: Array.isArray(body.sourceReferences) ? body.sourceReferences as never : [],
      reviewedAt: finiteTimestamp(body.reviewedAt) ?? now, createdAt: finiteTimestamp(body.createdAt) ?? now,
    }));
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

// A guidance, event outcome, or accepted formal actual cannot change a public
// thesis, risk, scenario, or frozen valuation directly. This endpoint records
// only explicit source-to-target review mappings.
researchRoutes.get("/research/company/:code/guidance-event-impact-reviews", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "guidance/event impact reviews are only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  try { return ok(c, { items: await loadGuidanceEventImpactReviews(c.env.DB, code) }); }
  catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.post("/research/company/:code/guidance-event-impact-reviews", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "guidance/event impact review writes are only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return fail(c, 400, "invalid guidance/event impact review body");
  try {
    assertPublicResearchBody(body);
    const now = Date.now();
    return ok(c, await createGuidanceEventImpactReview(c.env.DB, {
      impactReviewId: stringOrNull(body.impactReviewId) ?? `guidance-event-impact:${crypto.randomUUID()}`,
      securityCode: code,
      sourceKind: enumValue(body.sourceKind, ["management_guidance", "catalyst_actual", "formal_actual"] as const, "sourceKind"),
      sourceId: requiredText(body.sourceId, "sourceId"), reviewer: stringOrNull(body.reviewer) ?? "local-user",
      rationale: requiredText(body.rationale, "rationale"),
      thesisIds: textArray(body.thesisIds, "thesisIds"), riskIds: textArray(body.riskIds, "riskIds"),
      modelTargets: impactModelTargets(body.modelTargets),
      createdAt: finiteTimestamp(body.createdAt) ?? now,
    }));
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

// Closing an explicit thesis/risk impact target appends an audit action only.
// It never updates the mapped thesis/risk or a historical snapshot.  Frozen
// model targets remain governed by their separate model-review action ledger.
researchRoutes.post("/research/company/:code/guidance-event-impact-review-targets/:targetId/resolve", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "impact review target writes are only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return fail(c, 400, "invalid impact review target resolution body");
  try {
    assertPublicResearchBody(body);
    const now = Date.now();
    return ok(c, await resolveGuidanceEventImpactReviewTarget(c.env.DB, code, c.req.param("targetId"), {
      actionId: stringOrNull(body.actionId) ?? `guidance-event-impact-action:${crypto.randomUUID()}`,
      decision: enumValue(body.decision, ["no_change", "follow_up_recorded", "not_applicable"] as const, "decision"),
      rationale: requiredText(body.rationale, "rationale"),
      actedBy: stringOrNull(body.actedBy) ?? "local-user",
      followUpTargetId: stringOrNull(body.followUpTargetId),
      actedAt: finiteTimestamp(body.actedAt) ?? now,
    }));
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

// Information processing contributes evidence candidates only.  These routes
// intentionally do not call operating/market/valuation writers and are not
// exposed from production.
researchRoutes.get("/research/company/:code/information-evidence-candidates", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "research information evidence candidates are only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  try { return ok(c, { code, items: await loadResearchInformationEvidenceCandidates(c.env.DB, code) }); }
  catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.post("/research/company/:code/information-evidence-candidates/refresh", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "research information evidence candidate refresh is only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  try { return ok(c, { code, ...(await refreshResearchInformationEvidenceCandidates(c.env.DB, code)) }); }
  catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

// Public statutory disclosures may seed review candidates only after their
// exact source document has already completed the standard information
// processing workflow.  This intentionally does not fetch, parse, accept, or
// fieldize a document, and never mutates a model/scenario/valuation.
researchRoutes.post("/research/company/:code/statutory-operating-candidates/produce", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "statutory operating candidate production is only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  try { return ok(c, await produceResearchStatutoryOperatingEvidenceCandidates(c.env.DB, code)); }
  catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.post("/research/company/:code/information-evidence-candidates/:candidateId/reviews", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "research information evidence candidate reviews are only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return fail(c, 400, "invalid evidence candidate review body");
  try {
    const result = await reviewResearchInformationEvidenceCandidate(c.env.DB, {
      candidateReviewId: stringOrNull(body.candidateReviewId) ?? `research-information-evidence-review:${crypto.randomUUID()}`,
      candidateId: c.req.param("candidateId"), decision: enumValue(body.decision, ["accepted", "rejected", "needs_evidence"] as const, "decision"),
      reviewNote: requiredText(body.reviewNote, "reviewNote"), reviewedBy: stringOrNull(body.reviewedBy) ?? "local-user",
      reviewedAt: finiteTimestamp(body.reviewedAt) ?? Date.now(), evidenceReferenceId: stringOrNull(body.evidenceReferenceId) ?? undefined, expectedSecurityCode: code,
    });
    return ok(c, result);
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

// A fieldized operating source fact can only be created from a previously
// accepted reusable evidence reference.  It is an immutable source-layer
// record; no typed operating model, driver plan, scenario, or valuation is
// created or updated here.
researchRoutes.get("/research/company/:code/operating-source-facts", async (c) => {
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  try {
    const security = (await getSecurity(c.env.DB, code)) ?? fallbackResearchSecurity(code);
    const identity = await loadResearchIdentityFinancials(c.env.DB, security);
    const companyId = (identity.operatingCompany as { companyId?: string } | null)?.companyId ?? null;
    return ok(c, { code, ...(await loadResearchOperatingSourceFacts(c.env.DB, { operatingCompanyId: companyId })) });
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.post("/research/company/:code/operating-source-facts", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "operating source fact writes are only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!isSupportedCompanyCode(code) || !body) return fail(c, 400, "invalid operating source fact body");
  try {
    const security = (await getSecurity(c.env.DB, code)) ?? fallbackResearchSecurity(code);
    const identity = await loadResearchIdentityFinancials(c.env.DB, security);
    const operatingCompanyId = (identity.operatingCompany as { companyId?: string } | null)?.companyId;
    if (!operatingCompanyId) return fail(c, 409, "operating-company mapping is required before recording an operating source fact");
    const now = Date.now();
    return ok(c, await recordResearchOperatingSourceFact(c.env.DB, {
      ...body,
      operatingSourceFactId: stringOrNull(body.operatingSourceFactId) ?? `operating-source-fact:${crypto.randomUUID()}`,
      operatingCompanyId,
      expectedSecurityCode: code,
      recordedBy: stringOrNull(body.recordedBy) ?? "local-user",
      recordedAt: finiteTimestamp(body.recordedAt) ?? now,
      createdAt: finiteTimestamp(body.createdAt) ?? now,
    } as Parameters<typeof recordResearchOperatingSourceFact>[1]));
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

// A binding is an auditable, manual interpretation from one accepted source
// fact to one already-versioned operating-model field. It never applies the
// formula or mutates the selected model/plan/scenario/valuation.
researchRoutes.get("/research/company/:code/operating-source-fact-bindings", async (c) => {
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  try {
    const security = (await getSecurity(c.env.DB, code)) ?? fallbackResearchSecurity(code);
    const identity = await loadResearchIdentityFinancials(c.env.DB, security);
    const companyId = (identity.operatingCompany as { companyId?: string } | null)?.companyId ?? null;
    const [bindings, sourceFacts, operatingModels] = await Promise.all([
      loadResearchOperatingSourceFactBindings(c.env.DB, { operatingCompanyId: companyId }),
      loadResearchOperatingSourceFacts(c.env.DB, { operatingCompanyId: companyId }),
      loadResearchOperatingModels(c.env.DB, { companyId, asOf: Date.now() }),
    ]);
    return ok(c, { code, bindings, sourceFacts, operatingModels, targetSchema: researchOperatingSourceFactBindingTargets() });
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.post("/research/company/:code/operating-source-fact-bindings", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "operating source fact binding writes are only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!isSupportedCompanyCode(code) || !body) return fail(c, 400, "invalid operating source fact binding body");
  try {
    const security = (await getSecurity(c.env.DB, code)) ?? fallbackResearchSecurity(code);
    const identity = await loadResearchIdentityFinancials(c.env.DB, security);
    const operatingCompanyId = (identity.operatingCompany as { companyId?: string } | null)?.companyId;
    if (!operatingCompanyId) return fail(c, 409, "operating-company mapping is required before binding a source fact");
    const now = Date.now();
    return ok(c, await recordResearchOperatingSourceFactBinding(c.env.DB, {
      ...body,
      operatingSourceFactBindingId: stringOrNull(body.operatingSourceFactBindingId) ?? `operating-source-fact-binding:${crypto.randomUUID()}`,
      operatingCompanyId,
      createdBy: stringOrNull(body.createdBy) ?? "local-user",
      createdAt: finiteTimestamp(body.createdAt) ?? now,
    } as Parameters<typeof recordResearchOperatingSourceFactBinding>[1]));
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.post("/research/company/:code/operating-source-fact-bindings/:bindingId/reviews", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "operating source fact binding reviews are only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!isSupportedCompanyCode(code) || !body) return fail(c, 400, "invalid operating source fact binding review body");
  try {
    const security = (await getSecurity(c.env.DB, code)) ?? fallbackResearchSecurity(code);
    const identity = await loadResearchIdentityFinancials(c.env.DB, security);
    const operatingCompanyId = (identity.operatingCompany as { companyId?: string } | null)?.companyId;
    if (!operatingCompanyId) return fail(c, 409, "operating-company mapping is required before reviewing a source fact binding");
    const now = Date.now();
    return ok(c, await reviewResearchOperatingSourceFactBinding(c.env.DB, {
      operatingSourceFactBindingReviewId: stringOrNull(body.operatingSourceFactBindingReviewId) ?? `operating-source-fact-binding-review:${crypto.randomUUID()}`,
      operatingSourceFactBindingId: c.req.param("bindingId"),
      reviewStatus: enumValue(body.reviewStatus, ["reviewed", "needs_revision", "rejected"] as const, "reviewStatus"),
      reviewNote: requiredText(body.reviewNote, "reviewNote"),
      reviewedBy: stringOrNull(body.reviewedBy) ?? "local-user",
      reviewedAt: finiteTimestamp(body.reviewedAt) ?? now,
    }, operatingCompanyId));
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

// Governance/capital candidates preserve the information-processing source
// chain. They are local-review material; production exposes only accepted,
// immutable fact versions through the company research read model.
researchRoutes.get("/research/company/:code/governance-capital-facts", async (c) => {
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  try { return ok(c, await loadResearchGovernanceCapitalFactLedger(c.env.DB, code)); }
  catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.get("/research/company/:code/governance-capital-fact-candidates", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "governance/capital fact candidates are only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  try { return ok(c, { code, items: await loadResearchGovernanceCapitalFactCandidates(c.env.DB, code) }); }
  catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.post("/research/company/:code/governance-capital-fact-candidates/refresh", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "governance/capital candidate refresh is only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  try { return ok(c, { code, ...(await refreshResearchGovernanceCapitalFactCandidates(c.env.DB, code)) }); }
  catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.post("/research/company/:code/governance-capital-fact-candidates/:candidateId/reviews", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "governance/capital fact candidate reviews are only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return fail(c, 400, "invalid governance/capital candidate review body");
  try {
    const decision = enumValue(body.decision, ["accepted", "rejected", "needs_evidence"] as const, "decision");
    return ok(c, await reviewResearchGovernanceCapitalFactCandidate(c.env.DB, {
      candidateReviewId: stringOrNull(body.candidateReviewId) ?? `research-governance-capital-review:${crypto.randomUUID()}`,
      candidateId: c.req.param("candidateId"), decision,
      reviewNote: requiredText(body.reviewNote, "reviewNote"), reviewedBy: stringOrNull(body.reviewedBy) ?? "local-user", reviewedAt: finiteTimestamp(body.reviewedAt) ?? Date.now(),
      governanceCapitalFactVersionId: stringOrNull(body.governanceCapitalFactVersionId) ?? undefined,
      ...(decision === "accepted" ? {
        factStatus: enumValue(body.factStatus, ["verified", "unavailable", "conflicting"] as const, "factStatus"), valueNumber: numberOrNull(body.valueNumber), valueRangeLower: numberOrNull(body.valueRangeLower), valueRangeUpper: numberOrNull(body.valueRangeUpper), valueText: stringOrNull(body.valueText), unit: stringOrNull(body.unit),
        asOf: requiredText(body.asOf, "asOf"),
        sourceAuthority: enumValue(body.sourceAuthority, ["issuer_disclosure", "exchange_filing", "regulator_or_court", "audit_report"] as const, "sourceAuthority"),
      } : {}), expectedSecurityCode: code,
    }));
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

// Industry KPI transmission is intentionally a separate append-only ledger.
// It accepts only a previously accepted information-evidence reference and
// never updates a typed driver plan or valuation model as a side effect.
researchRoutes.get("/research/company/:code/industry-kpi-driver-bindings", async (c) => {
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  try { return ok(c, { code, items: await loadResearchIndustryKpiDriverBindings(c.env.DB, code, stringOrNull(c.req.query("operatingDriverPlanId")) ?? undefined) }); }
  catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

/**
 * Read-only form context.  Every selectable ID comes from a stored ledger
 * record, and accepted evidence candidates are disclosed only to the local
 * research runtime that is allowed to create a new binding.
 */
researchRoutes.get("/research/company/:code/industry-kpi-driver-binding-context", async (c) => {
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  try {
    const security = (await getSecurity(c.env.DB, code)) ?? fallbackResearchSecurity(code);
    const identity = await loadResearchIdentityFinancials(c.env.DB, security);
    const companyId = (identity.operatingCompany as { companyId?: string } | null)?.companyId ?? null;
    const [exposures, driverPlans, bindings] = await Promise.all([
      loadResearchCompanyTrackExposures(c.env.DB, { companyId, asOf: Date.now() }),
      loadResearchOperatingDriverPlans(c.env.DB, { companyId, asOf: Date.now() }),
      loadResearchIndustryKpiDriverBindings(c.env.DB, code),
    ]);
    const profileIds = [...new Set(exposures.items.map((item) => item.trackProfileId))];
    const kpis = profileIds.length ? (await c.env.DB.prepare(`select kpi_id as kpiId, track_profile_id as trackProfileId, name, definition, unit, frequency, timing_role as timingRole, financial_mapping as financialMapping
      from research_industry_track_kpis where track_profile_id in (${profileIds.map(() => "?").join(",")}) order by track_profile_id, sort_order, kpi_id`).bind(...profileIds).all<Record<string, unknown>>()).results : [];
    const eligibleEvidence = canWriteResearchLocally(c.env)
      ? (await loadResearchInformationEvidenceCandidates(c.env.DB, code)).filter((item) => item.latestReview?.decision === "accepted" && item.reusableEvidenceReference)
      : [];
    const capabilities = researchCapabilities(c.env);
    return ok(c, {
      // Keep this scalar until the existing panel is migrated; new consumers
      // must read the versioned shared capability projection below.
      code, canWriteLocally: capabilities.canWriteLocally, capabilities, rules: researchIndustryKpiTransmissionRules(), bindings,
      exposures: exposures.items.map((item) => ({ companyTrackExposureId: item.companyTrackExposureId, trackProfileId: item.trackProfileId, businessSegment: item.businessSegment, productScope: item.productScope, geographicScope: item.geographicScope, customerScope: item.customerScope, status: item.status })),
      kpis, driverPlans: driverPlans.items,
      eligibleEvidence: eligibleEvidence.map((item) => ({ candidateId: item.candidateId, targetModule: item.targetModule, targetField: item.targetField, statement: item.statement, period: item.period, sourceName: item.sourceName, title: item.title, sourceUrl: item.sourceUrl, contentUrl: item.contentUrl, reusableEvidenceReference: item.reusableEvidenceReference, informationId: item.informationId, versionId: item.versionId, docId: item.docId, contentHash: item.contentHash })),
      limitations: ["下拉项仅来自已保存的行业暴露、KPI、驱动计划、分部段和已接受证据。界面不会按名称或关键词猜测映射。", "行业 KPI 绑定只覆盖配置中的直接传导规则；未绑定字段保留该版本驱动计划中的明确保存值。"],
    });
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.post("/research/company/:code/industry-kpi-driver-bindings", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "industry KPI driver bindings are only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return fail(c, 400, "invalid industry KPI driver binding body");
  try {
    const now = Date.now();
    return ok(c, await insertResearchIndustryKpiDriverBinding(c.env.DB, {
      ...body,
      industryKpiDriverBindingId: stringOrNull(body.industryKpiDriverBindingId) ?? `industry-kpi-driver-binding:${crypto.randomUUID()}`,
      securityCode: code,
      mappedBy: stringOrNull(body.mappedBy) ?? "local-user",
      mappedAt: finiteTimestamp(body.mappedAt) ?? now,
      createdAt: finiteTimestamp(body.createdAt) ?? now,
    } as Parameters<typeof insertResearchIndustryKpiDriverBinding>[1]));
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.post("/research/company/:code/operating-driver-plans/:operatingDriverPlanId/industry-kpi-projection", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "industry KPI projections are only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  if (!isSupportedCompanyCode(code)) return fail(c, 400, "unsupported company code");
  const body = await c.req.json().catch(() => null) as { valuation?: unknown } | null;
  if (!body || !body.valuation || typeof body.valuation !== "object") return fail(c, 400, "valuation bridge is required");
  try {
    const security = (await getSecurity(c.env.DB, code)) ?? fallbackResearchSecurity(code);
    const identity = await loadResearchIdentityFinancials(c.env.DB, security);
    const companyId = (identity.operatingCompany as { companyId?: string } | null)?.companyId ?? null;
    if (!companyId) return fail(c, 409, "operating-company mapping is required before projecting an industry KPI driver plan");
    const plan = (await loadResearchOperatingDriverPlans(c.env.DB, { companyId, asOf: Date.now() })).items.find((item) => item.operatingDriverPlanId === c.req.param("operatingDriverPlanId"));
    if (!plan) return fail(c, 404, "operating driver plan not found for requested company");
    const bindings = await loadResearchIndustryKpiDriverBindings(c.env.DB, code, plan.operatingDriverPlanId);
    return ok(c, projectIndustryKpiDriverTransmission(plan, bindings, body.valuation as Parameters<typeof projectIndustryKpiDriverTransmission>[2]));
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.post("/research/industry/tracks", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "industry research writes are only available in local research runtime");
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return fail(c, 400, "invalid industry track body");
  try { return ok(c, await insertResearchIndustryTrackProfile(c.env.DB, body as Parameters<typeof insertResearchIndustryTrackProfile>[1])); }
  catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.post("/research/company/:code/industry-exposures", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "industry research writes are only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return fail(c, 400, "invalid company track exposure body");
  const security = (await getSecurity(c.env.DB, code)) ?? fallbackResearchSecurity(code);
  const identity = await loadResearchIdentityFinancials(c.env.DB, security);
  const companyId = (identity.operatingCompany as { companyId?: string } | null)?.companyId ?? null;
  if (!companyId) return fail(c, 409, "a confirmed or provisional operating-company mapping is required before recording a company industry exposure");
  if (body.companyId !== companyId) return fail(c, 400, "companyId must match the mapped operating company");
  try { return ok(c, await insertResearchCompanyTrackExposure(c.env.DB, body as Parameters<typeof insertResearchCompanyTrackExposure>[1])); }
  catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.post("/research/company/:code/peer-comparison-sets", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "industry research writes are only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code"));
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return fail(c, 400, "invalid peer comparison set body");
  const security = (await getSecurity(c.env.DB, code)) ?? fallbackResearchSecurity(code);
  const identity = await loadResearchIdentityFinancials(c.env.DB, security);
  const companyId = (identity.operatingCompany as { companyId?: string } | null)?.companyId ?? null;
  if (!companyId) return fail(c, 409, "a confirmed or provisional operating-company mapping is required before recording peers");
  if (body.companyId !== companyId) return fail(c, 400, "companyId must match the mapped operating company");
  try { return ok(c, await insertResearchPeerComparisonSet(c.env.DB, body as Parameters<typeof insertResearchPeerComparisonSet>[1])); }
  catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.post("/research/company/:code/operating-models", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "operating model writes are only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code")); const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!isSupportedCompanyCode(code) || !body) return fail(c, 400, "invalid operating model body");
  try {
    const security = (await getSecurity(c.env.DB, code)) ?? fallbackResearchSecurity(code); const identity = await loadResearchIdentityFinancials(c.env.DB, security); const companyId = (identity.operatingCompany as { companyId?: string } | null)?.companyId;
    if (!companyId) return fail(c, 409, "operating-company mapping is required before recording an operating model"); const now = Date.now();
    return ok(c, await insertResearchOperatingModel(c.env.DB, { ...body, operatingModelId: stringOrNull(body.operatingModelId) ?? `operating-model:${crypto.randomUUID()}`, companyId, asOf: finiteTimestamp(body.asOf) ?? now, createdAt: finiteTimestamp(body.createdAt) ?? now, updatedAt: finiteTimestamp(body.updatedAt) ?? now } as Parameters<typeof insertResearchOperatingModel>[1]));
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.post("/research/company/:code/operating-driver-plans", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "operating driver plan writes are only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code")); const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!isSupportedCompanyCode(code) || !body) return fail(c, 400, "invalid operating driver plan body");
  try { const now = Date.now(); return ok(c, await insertResearchOperatingDriverPlan(c.env.DB, { ...body, operatingDriverPlanId: stringOrNull(body.operatingDriverPlanId) ?? `operating-driver-plan:${crypto.randomUUID()}`, asOf: finiteTimestamp(body.asOf) ?? now, createdAt: finiteTimestamp(body.createdAt) ?? now, updatedAt: finiteTimestamp(body.updatedAt) ?? now } as Parameters<typeof insertResearchOperatingDriverPlan>[1])); }
  catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

researchRoutes.post("/research/company/:code/market-space-assessments", async (c) => {
  if (!canWriteResearchLocally(c.env)) return fail(c, 404, "market-space writes are only available in local research runtime");
  const code = normalizeSecurityCode(c.req.param("code")); const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!isSupportedCompanyCode(code) || !body) return fail(c, 400, "invalid market space body");
  try {
    const security = (await getSecurity(c.env.DB, code)) ?? fallbackResearchSecurity(code); const identity = await loadResearchIdentityFinancials(c.env.DB, security); const companyId = (identity.operatingCompany as { companyId?: string } | null)?.companyId;
    if (!companyId) return fail(c, 409, "operating-company mapping is required before recording market space"); const now = Date.now();
    return ok(c, await insertResearchMarketSpaceAssessment(c.env.DB, { ...body, marketSpaceAssessmentId: stringOrNull(body.marketSpaceAssessmentId) ?? `market-space-assessment:${crypto.randomUUID()}`, companyId, asOf: finiteTimestamp(body.asOf) ?? now, createdAt: finiteTimestamp(body.createdAt) ?? now, updatedAt: finiteTimestamp(body.updatedAt) ?? now } as Parameters<typeof insertResearchMarketSpaceAssessment>[1]));
  } catch (error) { return fail(c, 400, error instanceof Error ? error.message : String(error)); }
});

async function knowledgeDocumentStats(db: D1Database, code: string) {
  const row = await db.prepare(`select count(*) as total, sum(case when source_type='research_report' then 1 else 0 end) as reports, max(sort_time) as latestSortTime
    from knowledge_docs where target_code_normalized=?`).bind(code).first<{ total: number; reports: number; latestSortTime: string | null }>();
  return { total: Number(row?.total ?? 0), reports: Number(row?.reports ?? 0), latestSortTime: row?.latestSortTime ?? null };
}

async function loadOptionalResearchExtension<T>(loader: () => Promise<T>): Promise<{
  availability: "available" | "unavailable";
  reason: "storage_not_initialized" | null;
  items: T extends Array<infer Item> ? Item[] : T;
}> {
  try {
    const items = await loader();
    return { availability: "available", reason: null, items: items as T extends Array<infer Item> ? Item[] : T };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/(?:no such table|does not exist|not found).*research_/i.test(message)) {
      return { availability: "unavailable", reason: "storage_not_initialized", items: [] as T extends Array<infer Item> ? Item[] : T };
    }
    throw error;
  }
}

/** Maps existing bounded read models to the config-owned fact dictionary.
 * This adds no writer and never treats an empty local ledger as provider-wide
 * source failure.  The dictionary decides which facts and policies exist. */
export function researchDataRequirementSignals(input: {
  identity: unknown;
  financials: unknown;
  statutoryVerifications: unknown;
  operatingModels: unknown;
  operatingDriverPlans: unknown;
  marketSpaceAssessments: unknown;
  operatingSourceFacts: unknown;
  operatingSourceFactBindings: unknown;
  typedTrackExposures: unknown;
  typedPeerComparisonSets: unknown;
  forecastWorkspace: unknown;
  valuationModels: unknown;
  reverseValuationModels: unknown;
  governance: unknown;
  governanceCapitalFacts: unknown;
  dossier: unknown;
  modelReviewItems: unknown;
  autoFilingInsights: unknown;
  autoFilingFactInputs: unknown;
  kline: { rows: KlineBar[]; source: string };
}): Record<string, unknown> {
  const identity = objectRecord(input.identity);
  const listedSecurity = objectRecord(identity.listedSecurity);
  const relationships = records(identity.relationships);
  const rightsProfiles = records(identity.rightsProfiles);
  const mappingStatus = stringValue(listedSecurity.mappingStatus);
  const rightsStatuses = rightsProfiles.map((item) => stringValue(item.rightsStatus));
  const financials = objectRecord(input.financials);
  const statements = records(financials.statements);
  const primaryError = statements.map((item) => stringValue(item.error)).filter(Boolean).join("；") || null;
  const primaryState = primaryError ? "source_error"
    : statements.length === 3 && statements.every((item) => Number(item.rows) > 0) ? "available"
      : statements.some((item) => Number(item.rows) > 0) ? "partial" : "missing";
  const verifications = records(objectRecord(input.statutoryVerifications).items);
  const statutoryGate = objectRecord(financials.statutoryGate);
  const statutoryState = stringValue(statutoryGate.status) === "verified" ? "verified"
    : verifications.length ? "partial" : "missing";
  const operatingModelState = sectionBundleState([input.operatingModels, input.operatingDriverPlans]);
  const operatingSourceFacts = sectionItems(input.operatingSourceFacts);
  const reviewedOperatingInputs = records(objectRecord(input.operatingSourceFactBindings).reviewedInputs);
  // An accepted immutable source fact proves that an issuer disclosure is
  // observable. It remains partial evidence: it does not create a model,
  // driver plan, scenario, valuation input, or research conclusion.
  const operatingEvidenceState = operatingModelState.state === "available" ? "available"
    : operatingModelState.state === "partial" || operatingSourceFacts.length || reviewedOperatingInputs.length ? "partial"
      : "missing";
  const forecastWorkspace = objectRecord(input.forecastWorkspace);
  const forecastCoverage = objectRecord(forecastWorkspace.forecastCoverage);
  const forecastCoverageStatus = stringValue(forecastCoverage.status);
  const valuationItems = [...sectionItems(input.valuationModels), ...sectionItems(input.reverseValuationModels)];
  const openModelReviewCount = records(input.modelReviewItems).filter((item) => stringValue(item.state) === "open").length;
  const dossier = objectRecord(input.dossier);
  const autoFilingInsightItems = sectionItems(input.autoFilingInsights);
  const autoFilingFactInputItems = sectionItems(input.autoFilingFactInputs);
  const autoInsightTabs = new Set(autoFilingFactInputItems.map((item) => targetTabForInputModule(stringValue(item.targetModule))));
  const autoInsightObservedAt = latestTimestamp(autoFilingFactInputItems.length ? autoFilingFactInputItems : autoFilingInsightItems);
  const thesisItems = sectionItems(dossier.theses);
  const conflictThesisEvidence = thesisItems.reduce((total, thesis) => total + records(thesis.evidence).filter((evidence) => stringValue(evidence.stance) === "conflict").length, 0);
  const industrySections = [input.typedTrackExposures, input.typedPeerComparisonSets, input.marketSpaceAssessments];
  return {
    identity: {
      mapping: {
        state: mappingStatus === "confirmed" ? "confirmed" : mappingStatus === "provisional" ? "partial" : "missing",
        observedAt: latestTimestamp([listedSecurity, ...relationships]),
        conflictCount: [mappingStatus, ...relationships.map((item) => stringValue(item.relationshipStatus))].filter((value) => value === "conflicting").length,
      },
      rights: {
        state: rightsStatuses.includes("confirmed") ? "confirmed" : rightsProfiles.length ? "partial" : "missing",
        observedAt: latestTimestamp(rightsProfiles),
        conflictCount: rightsStatuses.filter((value) => value === "conflicting").length,
      },
    },
    financial: {
      primary: { state: primaryState, observedAt: latestTimestamp(records(objectRecord(financials.quality).series)), error: primaryError },
      statutory: {
        state: statutoryState, observedAt: latestTimestamp(verifications),
        conflictCount: verifications.filter((item) => stringValue(item.outcome) === "conflict").length,
      },
    },
    operating: {
      model: {
        // Filing insights are source-bound extraction candidates.  They make
        // operating coverage partial, never a complete operating model.
        state: operatingEvidenceState === "missing" && autoInsightTabs.has("business") ? "partial" : operatingEvidenceState,
        observedAt: latestTimestamp([...operatingSourceFacts, ...reviewedOperatingInputs]) ?? operatingModelState.observedAt ?? autoInsightObservedAt,
      },
    },
    industry: {
      evidence: (() => {
        const base = sectionBundleState(industrySections);
        return {
          state: base.state === "missing" && (autoInsightTabs.has("industry") || autoInsightTabs.has("market")) ? "partial" : base.state,
          observedAt: base.observedAt ?? autoInsightObservedAt,
          conflictCount: 0,
        };
      })(),
    },
    forecast: {
      samples: {
        // Candidate discovery does not make an opportunity sample available.
        // The public source-health projection follows the same v4 reviewed
        // original/independent-source contract as the company coverage card.
        state: forecastCoverageStatus === "ready" ? "available" : forecastCoverageStatus === "partial" ? "partial" : "missing",
        observedAt: timestampValue(forecastCoverage.asOf),
      },
    },
    valuation: {
      models: {
        state: valuationItems.length ? openModelReviewCount ? "partial" : "available" : "missing",
        observedAt: latestTimestamp(valuationItems), conflictCount: 0,
      },
    },
    governance: (() => {
      const ledger = objectRecord(input.governanceCapitalFacts);
      const facts = records(ledger.latestFacts);
      const legacy = sectionBundleState([input.governance]);
      return { records: {
        // Filing extraction gives source-bound capital/governance facts but
        // does not replace the five-dimension governance ledger.
        state: facts.length ? "available" : legacy.state === "missing" && autoInsightTabs.has("financial") ? "partial" : legacy.state,
        observedAt: latestTimestamp(facts) ?? autoInsightObservedAt,
        conflictCount: facts.filter((item) => stringValue(item.factStatus) === "conflicting").length,
      } };
    })(),
    risk: {
      review: (() => {
        const base = sectionBundleState([dossier.risks, dossier.theses]);
        return {
          state: base.state === "missing" && autoInsightTabs.has("risk") ? "partial" : base.state,
          observedAt: base.observedAt ?? autoInsightObservedAt,
          conflictCount: conflictThesisEvidence,
        };
      })(),
    },
    market: {
      kline: { state: input.kline.rows.length ? "available" : "missing", observedAt: latestKlineTimestamp(input.kline.rows), error: null },
    },
  };
}
function targetTabForInputModule(module: string): string {
  if (module === "operating") return "business";
  if (module === "governance") return "financial";
  return module;
}

function objectRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function records(value: unknown): Array<Record<string, unknown>> { return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : []; }
function sectionItems(value: unknown): Array<Record<string, unknown>> { return records(objectRecord(value).items); }
function stringValue(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function sectionBundleState(sections: unknown[]): { state: "available" | "partial" | "missing"; observedAt: number | null } {
  const states = sections.map((section) => ({ availability: stringValue(objectRecord(section).availability), items: sectionItems(section) }));
  const populated = states.filter((section) => section.availability === "available" && section.items.length > 0);
  return {
    state: populated.length === states.length && states.length > 0 ? "available" : populated.length ? "partial" : "missing",
    observedAt: latestTimestamp(populated.flatMap((section) => section.items)),
  };
}
function latestTimestamp(items: Array<Record<string, unknown>>): number | null {
  const timestamps = items.flatMap((item) => [item.observedAt, item.recordedAt, item.updatedAt, item.createdAt, item.processedAt, item.asOf, objectRecord(item.period).endDate, item.forecastDate])
    .map(timestampValue).filter((value): value is number => value !== null);
  return timestamps.length ? Math.max(...timestamps) : null;
}
function latestKlineTimestamp(rows: KlineBar[]): number | null {
  const timestamps = rows.map((row) => timestampValue(row.updatedAt ?? row.date)).filter((value): value is number => value !== null);
  return timestamps.length ? Math.max(...timestamps) : null;
}
function timestampValue(value: unknown): number | null {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) return number;
  if (typeof value === "string" && value.trim()) { const parsed = Date.parse(value); return Number.isFinite(parsed) && parsed > 0 ? parsed : null; }
  return null;
}

function stringOrNull(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function requiredFiniteNumber(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a finite number`);
  return parsed;
}

function finiteTimestamp(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * An explicit historical page is a bounded, local-only index operation.  It
 * does not inspect a correction, create a candidate, or change any financial
 * fact; those actions remain behind their separate review endpoints.
 */
export function statutoryDisclosureIndexRefreshOptions(input: { page?: unknown; pageSize?: unknown }): StatutoryDisclosureIndexOptions {
  return {
    page: boundedRequestInteger(input.page, "page", 1, 100, 1),
    // Keep a user-triggered lookup small for both CNINFO and HKEX.  HKEX can
    // accept a larger row range, but it is not needed to establish an exact
    // original-document relationship and would turn this into broad scraping.
    pageSize: boundedRequestInteger(input.pageSize, "pageSize", 1, 30, 30),
  };
}

function boundedRequestInteger(value: unknown, label: string, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error(`${label} must be an integer from ${min} to ${max}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(`${label} must be an integer from ${min} to ${max}`);
  return parsed;
}

/** Only ledger identifiers cross the HTTP boundary; the Worker loads actual values and filing references itself. */
function formalActualAnchorIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("formalActualAnchorIds must be an array");
  if (value.length > 1) throw new Error("only one opening revenue formal actual anchor is supported");
  return value.map((item) => requiredText(item, "formalActualAnchorIds item"));
}

function securityRightsProfileWrite(securityCode: string, value: Record<string, unknown>): SecurityRightsProfileWrite {
  return {
    rightsProfileId: stringOrNull(value.rightsProfileId) ?? `security-rights:${crypto.randomUUID()}`,
    securityCode,
    rightsStatus: enumValue(value.rightsStatus, ["confirmed", "provisional", "needs_review", "conflicting"] as const, "rightsProfile.rightsStatus"),
    holderStructure: enumValue(value.holderStructure, ["direct_registered_holder", "beneficial_holder", "depositary_receipt_holder", "other"] as const, "rightsProfile.holderStructure"),
    legalIssuerName: stringOrNull(value.legalIssuerName), votingRightsNote: stringOrNull(value.votingRightsNote),
    economicRightsNote: stringOrNull(value.economicRightsNote), transferabilityNote: stringOrNull(value.transferabilityNote),
    structuralRiskNote: stringOrNull(value.structuralRiskNote), depositaryName: stringOrNull(value.depositaryName),
    depositaryFeeNote: stringOrNull(value.depositaryFeeNote), effectiveFrom: stringOrNull(value.effectiveFrom), effectiveTo: stringOrNull(value.effectiveTo),
    evidenceKind: enumValue(value.evidenceKind, ["securities_regulator_filing", "official_exchange_disclosure", "depositary_agreement", "issuer_official_disclosure"] as const, "rightsProfile.evidenceKind"),
    sourceUrl: requiredText(value.sourceUrl, "rightsProfile.sourceUrl"), sourceTitle: requiredText(value.sourceTitle, "rightsProfile.sourceTitle"),
    sourceNote: requiredText(value.sourceNote, "rightsProfile.sourceNote"), observedAt: finiteTimestamp(value.observedAt) ?? Date.now(), metadata: objectOrEmpty(value.metadata),
  };
}

function securityRightsLinkWrite(securityCode: string, relatedSecurityCode: string, value: Record<string, unknown>): SecurityRightsLinkWrite {
  return {
    rightsLinkId: stringOrNull(value.rightsLinkId) ?? `security-rights-link:${crypto.randomUUID()}`,
    securityCode, relatedSecurityCode,
    relationshipKind: enumValue(value.relationshipKind, ["same_operating_company_different_security", "adr_underlying_security", "other_security_right"] as const, "rightsLink.relationshipKind"),
    relationshipStatus: enumValue(value.relationshipStatus, ["confirmed", "provisional", "needs_review", "conflicting"] as const, "rightsLink.relationshipStatus"),
    relatedSharesPerSecurity: numberOrNull(value.relatedSharesPerSecurity),
    conversionAvailability: enumValue(value.conversionAvailability, ["available", "restricted", "not_available", "unknown", "not_applicable"] as const, "rightsLink.conversionAvailability"),
    relationshipNote: requiredText(value.relationshipNote, "rightsLink.relationshipNote"), effectiveFrom: stringOrNull(value.effectiveFrom), effectiveTo: stringOrNull(value.effectiveTo),
    evidenceKind: enumValue(value.evidenceKind, ["securities_regulator_filing", "official_exchange_disclosure", "depositary_agreement", "issuer_official_disclosure"] as const, "rightsLink.evidenceKind"),
    sourceUrl: requiredText(value.sourceUrl, "rightsLink.sourceUrl"), sourceTitle: requiredText(value.sourceTitle, "rightsLink.sourceTitle"),
    sourceNote: requiredText(value.sourceNote, "rightsLink.sourceNote"), observedAt: finiteTimestamp(value.observedAt) ?? Date.now(), metadata: objectOrEmpty(value.metadata),
  };
}

/**
 * The identity endpoint makes a small graph of mutable mappings and
 * append-only rights evidence.  D1 does not expose a general transaction
 * around the existing application writers, so parse and conflict-check every
 * immutable evidence record first.  This is deliberately a preflight rather
 * than an upsert: rewriting rights evidence would destroy its audit history.
 */
async function preflightIdentityEvidenceWrite(db: D1Database, securityCode: string, body: Record<string, unknown>): Promise<void> {
  const profiles: SecurityRightsProfileWrite[] = [];
  const links: SecurityRightsLinkWrite[] = [];
  if (stringOrNull(body.securityInstrumentType)) {
    enumValue(body.securityInstrumentType, ["stock", "adr", "depositary_receipt"] as const, "securityInstrumentType");
  }
  if (body.operatingCompany && typeof body.operatingCompany === "object") {
    const company = body.operatingCompany as Record<string, unknown>;
    requiredText(company.companyId, "operatingCompany.companyId");
    requiredText(company.canonicalName, "operatingCompany.canonicalName");
    enumValue(company.identityStatus, ["confirmed", "provisional", "needs_review"] as const, "operatingCompany.identityStatus");
    const relationship = body.relationship && typeof body.relationship === "object" ? body.relationship as Record<string, unknown> : {};
    enumValue(relationship.relationshipType ?? "primary_listing", ["primary_listing", "secondary_listing", "depositary_receipt", "other_equity_claim"] as const, "relationship.relationshipType");
    enumValue(relationship.relationshipStatus ?? company.identityStatus, ["confirmed", "provisional", "needs_review", "conflicting"] as const, "relationship.relationshipStatus");
    requiredText(relationship.sourceNote ?? relationship.sourceUrl, "relationship.sourceNote");
  }
  if (Array.isArray(body.providerIdentifiers)) {
    for (const raw of body.providerIdentifiers) {
      if (!raw || typeof raw !== "object") throw new Error("providerIdentifiers entries must be objects");
      const value = raw as Record<string, unknown>;
      const ownerType = enumValue(value.ownerType, ["operating_company", "listed_security"] as const, "providerIdentifier.ownerType");
      const companyId = stringOrNull(value.companyId);
      const linkedSecurityCode = stringOrNull(value.securityCode);
      if (ownerType === "operating_company" && (!companyId || linkedSecurityCode)) throw new Error("operating_company provider identifiers require only companyId");
      if (ownerType === "listed_security" && (!linkedSecurityCode || companyId)) throw new Error("listed_security provider identifiers require only securityCode");
      requiredText(value.provider, "providerIdentifier.provider");
      requiredText(value.identifierKind, "providerIdentifier.identifierKind");
      requiredText(value.identifierValue, "providerIdentifier.identifierValue");
      enumValue(value.identifierStatus, ["confirmed", "provisional", "needs_review", "conflicting", "inactive"] as const, "providerIdentifier.identifierStatus");
    }
  }
  if (body.rightsProfile && typeof body.rightsProfile === "object") {
    profiles.push(securityRightsProfileWrite(securityCode, body.rightsProfile as Record<string, unknown>));
  }
  if (body.linkedSecurity && typeof body.linkedSecurity === "object") {
    if (!body.operatingCompany || typeof body.operatingCompany !== "object") {
      throw new Error("linkedSecurity requires an explicit operatingCompany mapping; company names are never used to infer a link");
    }
    const linked = body.linkedSecurity as Record<string, unknown>;
    const linkedCode = normalizeSecurityCode(requiredText(linked.code, "linkedSecurity.code"));
    if (!isSupportedCompanyCode(linkedCode) || linkedCode === securityCode) {
      throw new Error("linkedSecurity.code must be a distinct supported company security code");
    }
    // Parse these before any write too: malformed linked-company evidence
    // must not leave the primary company mapping persisted on its own.
    requiredText(linked.name, "linkedSecurity.name");
    requiredText(linked.market, "linkedSecurity.market");
    enumValue(linked.instrumentType ?? "stock", ["stock", "adr", "depositary_receipt"] as const, "linkedSecurity.instrumentType");
    const relationship = linked.relationship && typeof linked.relationship === "object" ? linked.relationship as Record<string, unknown> : null;
    if (!relationship) throw new Error("linkedSecurity.relationship is required");
    enumValue(relationship.relationshipType, ["primary_listing", "secondary_listing", "depositary_receipt", "other_equity_claim"] as const, "linkedSecurity.relationship.relationshipType");
    enumValue(relationship.relationshipStatus ?? (body.operatingCompany as Record<string, unknown>).identityStatus, ["confirmed", "provisional", "needs_review", "conflicting"] as const, "linkedSecurity.relationship.relationshipStatus");
    requiredText(relationship.sourceNote ?? relationship.sourceUrl, "linkedSecurity.relationship.sourceNote");
    if (linked.rightsProfile && typeof linked.rightsProfile === "object") {
      profiles.push(securityRightsProfileWrite(linkedCode, linked.rightsProfile as Record<string, unknown>));
    }
    if (!linked.rightsLink || typeof linked.rightsLink !== "object") throw new Error("linkedSecurity.rightsLink is required");
    links.push(securityRightsLinkWrite(securityCode, linkedCode, linked.rightsLink as Record<string, unknown>));
  }

  const profileIds = new Set<string>();
  for (const profile of profiles) {
    if (profileIds.has(profile.rightsProfileId)) throw new Error("rightsProfileId must be unique within one identity write");
    profileIds.add(profile.rightsProfileId);
    const existing = await db.prepare(`select rights_profile_id as rightsProfileId from research_security_rights_profiles where rights_profile_id=?`)
      .bind(profile.rightsProfileId).first<{ rightsProfileId: string }>();
    if (existing) throw new Error(`rightsProfileId ${profile.rightsProfileId} already exists; append a new observed version instead of replaying it`);
  }
  const linkIds = new Set<string>();
  for (const link of links) {
    if (linkIds.has(link.rightsLinkId)) throw new Error("rightsLinkId must be unique within one identity write");
    linkIds.add(link.rightsLinkId);
    const existingId = await db.prepare(`select rights_link_id as rightsLinkId from research_security_rights_links where rights_link_id=?`)
      .bind(link.rightsLinkId).first<{ rightsLinkId: string }>();
    if (existingId) throw new Error(`rightsLinkId ${link.rightsLinkId} already exists; append a new observed version instead of replaying it`);
    const existingVersion = await db.prepare(`select rights_link_id as rightsLinkId from research_security_rights_links
      where security_code=? and related_security_code=? and relationship_kind=? and observed_at=?`)
      .bind(link.securityCode, link.relatedSecurityCode, link.relationshipKind, link.observedAt).first<{ rightsLinkId: string }>();
    if (existingVersion) throw new Error(`security rights link version already exists as ${existingVersion.rightsLinkId}; append a new observed version instead of replaying it`);
  }
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requiredText(value: unknown, label: string): string {
  const text = stringOrNull(value);
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function textArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, index) => requiredText(item, `${label}[${index}]`));
}

function impactModelTargets(value: unknown): Array<{ targetKind: "scenario" | "dcf" | "reverse_dcf"; targetId: string }> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("modelTargets must be an array");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`modelTargets[${index}] must be an object`);
    const record = item as Record<string, unknown>;
    return {
      targetKind: enumValue(record.targetKind, ["scenario", "dcf", "reverse_dcf"] as const, `modelTargets[${index}].targetKind`),
      targetId: requiredText(record.targetId, `modelTargets[${index}].targetId`),
    };
  });
}

function assertPublicResearchBody(value: unknown, path = "body"): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) assertPublicResearchBody(item, `${path}[${index}]`);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (["ownerKey", "userDecision", "position", "tradePlan", "order"].includes(key)) {
      throw new Error(`${path}.${key} is private and cannot enter public research`);
    }
    if (key === "epistemicType" && nested === "user_decision") {
      throw new Error(`${path}.epistemicType cannot be user_decision in public research`);
    }
    assertPublicResearchBody(nested, `${path}.${key}`);
  }
}

function enumValue<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new Error(`invalid ${label}`);
  return value as T;
}

function fallbackResearchSecurity(code: string): SecurityRecord {
  const market = securityMarket(code);
  return {
    code, market, type: "stock", name: code,
    currency: market === "hk" ? "HKD" : market === "us" ? "USD" : "CNY",
    exchangeName: null, source: "research-fallback", updatedAt: Date.now(),
  };
}

async function refreshAhStatutoryDisclosureWindow(
  db: D1Database,
  code: string,
  market: "a_share" | "h_share",
): Promise<{ attemptedPages: number; indexedDocuments: number; failures: string[] }> {
  // CNINFO returns at most 30 notices per page.  Twelve pages cover the latest
  // annual/interim reporting window for ordinary issuers while keeping a local
  // research action bounded.  Existing indexed documents are retained, so a
  // later run can extend the window without overwriting evidence.
  const pages = market === "a_share" ? Array.from({ length: 12 }, (_, index) => index + 1) : [1];
  let indexedDocuments = 0;
  const failures: string[] = [];
  for (const page of pages) {
    try {
      const index = await refreshResearchStatutoryDisclosureIndex(db, code, market === "a_share"
        ? { page, pageSize: 30 }
        : { pageSize: 1000 });
      indexedDocuments += index.documents.length;
      if (index.availability === "unavailable" && index.failure) failures.push(`page ${page}: ${index.failure.code}: ${index.failure.message}`);
    } catch (error) {
      failures.push(`page ${page}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { attemptedPages: pages.length, indexedDocuments, failures };
}

function asStatutoryDisclosureDocument(value: Record<string, unknown>): StatutoryDisclosureDocument | null {
  const registry = value.registry === "cninfo" || value.registry === "hkex" ? value.registry : null;
  const securityCode = stringOrNull(value.securityCode);
  const documentId = stringOrNull(value.documentId);
  const title = stringOrNull(value.title);
  const publishedAt = stringOrNull(value.publishedAt);
  const documentUrl = stringOrNull(value.documentUrl);
  const sourceLocator = stringOrNull(value.sourceLocator);
  if (!registry || !securityCode || !documentId || !title || !publishedAt || !documentUrl || !sourceLocator) return null;
  return { registry, securityCode, documentId, title, publishedAt, documentUrl, documentType: stringOrNull(value.documentType), sourceLocator };
}

/** Maps the title-derived correction period only to the exact normalized fact
 * period it can safely describe.  Ambiguous H1/Q2 handling is explicit; a
 * free-form affected-scope note never broadens the verification set. */
function revisionReportPeriodMatchesFact(reportPeriod: string, fact: { period: { kind: "annual" | "quarter"; fiscalYear: number; fiscalQuarter?: number } }): boolean {
  const match = /^(\d{4})(FY|H1|Q[1-4])$/.exec(reportPeriod);
  if (!match || Number(match[1]) !== fact.period.fiscalYear) return false;
  const token = match[2];
  if (token === "FY") return fact.period.kind === "annual";
  if (fact.period.kind !== "quarter") return false;
  return fact.period.fiscalQuarter === (token === "H1" ? 2 : Number(token.slice(1)));
}

async function recordAhFinancialAvailability(
  db: D1Database,
  code: string,
  loaded: Array<{ statementType: "income" | "balance" | "cashflow"; result: { rows: Array<{ reportDate: string }> } | null }>,
  produced: Array<{ verification: { normalizedFact: { metric: string }; outcome: string } }>,
  observedAt: number,
  provider: "cninfo" | "hkex",
): Promise<void> {
  const matches = new Set(produced.filter((item) => item.verification.outcome === "match").map((item) => item.verification.normalizedFact.metric));
  const requirements: Record<"income" | "balance" | "cashflow", string[]> = {
    income: ["revenue", "net_profit"], balance: ["total_equity", "diluted_shares"], cashflow: ["operating_cash_flow"],
  };
  const reportingCurrency = provider === "cninfo" ? "CNY" : "HKD";
  const accountingBasis = provider === "cninfo" ? "CAS" : "IFRS";
  for (const statementType of ["income", "balance", "cashflow"] as const) {
    const matched = requirements[statementType].every((metric) => matches.has(metric));
    const latestPeriod = loaded.find((item) => item.statementType === statementType)?.result?.rows[0]?.reportDate ?? null;
    const status = matched ? "verified_available" as const : "partially_available" as const;
    const missingMetrics = requirements[statementType].filter((metric) => !matches.has(metric));
    const details = { requiredMetrics: requirements[statementType], matchedMetrics: requirements[statementType].filter((metric) => matches.has(metric)), missingMetrics };
    await Promise.all([
      putFinancialAvailabilityObservation(db, {
        observationId: `eastmoney-primary:${code}:${statementType}:${observedAt}`, securityCode: code, statementType,
        provider: "eastmoney", sourceRole: "primary_structured", status, asOf: observedAt, latestPeriod,
        reportingCurrency, accountingBasis, blockingReason: matched ? null : `${provider.toUpperCase()} verification is still missing: ${missingMetrics.join(", ")}`,
        details,
      }),
      putFinancialAvailabilityObservation(db, {
        observationId: `${provider}-verification:${code}:${statementType}:${observedAt}`, securityCode: code, statementType,
        provider, sourceRole: "statutory_verification", status, asOf: observedAt, latestPeriod,
        reportingCurrency, accountingBasis, blockingReason: matched ? null : `${provider.toUpperCase()} field verification is still missing: ${missingMetrics.join(", ")}`,
        details,
      }),
    ]);
  }
}

async function recordUsFinancialAvailability(
  db: D1Database,
  code: string,
  loaded: Array<{ statementType: "income" | "balance" | "cashflow"; result: { rows: FinancialStatement[] } | null }>,
  produced: Array<{ verification: { normalizedFact: { metric: string }; outcome: string } }>,
  observedAt: number,
): Promise<void> {
  const matches = new Set(produced.filter((item) => item.verification.outcome === "match").map((item) => item.verification.normalizedFact.metric));
  const requirements: Record<"income" | "balance" | "cashflow", string[]> = {
    income: ["revenue", "net_profit"],
    balance: ["total_equity", "diluted_shares"],
    cashflow: ["operating_cash_flow"],
  };
  for (const statementType of ["income", "balance", "cashflow"] as const) {
    const statementRows = loaded.find((item) => item.statementType === statementType)?.result?.rows ?? [];
    const reportingCurrency = yahooReportingCurrency(statementRows);
    const matched = requirements[statementType].every((metric) => matches.has(metric));
    const latestPeriod = statementRows[0]?.reportDate ?? null;
    // A U.S.-listed ADS can trade in USD while its issuer reports in another
    // currency.  The availability ledger must retain the source reporting
    // currency, and must never promote a row with missing/conflicted Yahoo
    // currency metadata to "verified" merely because SEC field names matched.
    const status = matched && reportingCurrency.currency ? "verified_available" as const : "partially_available" as const;
    const missingMetrics = requirements[statementType].filter((metric) => !matches.has(metric));
    const details = {
      requiredMetrics: requirements[statementType],
      matchedMetrics: requirements[statementType].filter((metric) => matches.has(metric)),
      missingMetrics,
      yahooReportingCurrency: reportingCurrency,
    };
    const blockingReason = [
      missingMetrics.length ? `SEC verification is still missing: ${missingMetrics.join(", ")}` : null,
      reportingCurrency.reason,
    ].filter(Boolean).join("; ") || null;
    await Promise.all([
      putFinancialAvailabilityObservation(db, {
        observationId: `yahoo-primary:${code}:${statementType}:${observedAt}`, securityCode: code, statementType,
        provider: "yahoo", sourceRole: "primary_structured", status, asOf: observedAt, latestPeriod,
        reportingCurrency: reportingCurrency.currency, accountingBasis: "US_GAAP", blockingReason,
        details,
      }),
      putFinancialAvailabilityObservation(db, {
        observationId: `sec-verification:${code}:${statementType}:${observedAt}`, securityCode: code, statementType,
        provider: "sec", sourceRole: "statutory_verification", status, asOf: observedAt, latestPeriod,
        reportingCurrency: reportingCurrency.currency, accountingBasis: "US_GAAP",
        blockingReason: blockingReason ? `SEC field verification is incomplete or not promotable: ${blockingReason}` : null,
        details,
      }),
    ]);
  }
}

function yahooReportingCurrency(rows: FinancialStatement[]): { currency: string | null; status: "confirmed" | "missing" | "conflicting"; reason: string | null } {
  if (!rows.length) return { currency: null, status: "missing", reason: "Yahoo primary statement returned no rows" };
  const currencies = new Set<string>();
  let explicitlyConflicted = false;
  for (const row of rows) {
    const payload = row.payload && typeof row.payload === "object" ? row.payload as Record<string, unknown> : {};
    if (payload.YAHOO_CURRENCY_CONFLICT === true) explicitlyConflicted = true;
    const currency = stringOrNull(payload.REPORTING_CURRENCY)?.toUpperCase();
    if (currency) currencies.add(currency);
  }
  if (explicitlyConflicted || currencies.size > 1) {
    return { currency: null, status: "conflicting", reason: "Yahoo source reporting currency is conflicting; no trading-currency fallback was applied" };
  }
  const [currency] = [...currencies];
  return currency
    ? { currency, status: "confirmed", reason: null }
    : { currency: null, status: "missing", reason: "Yahoo source reporting currency is missing; no trading-currency fallback was applied" };
}
