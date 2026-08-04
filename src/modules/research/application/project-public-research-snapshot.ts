import type { PublicResearchSnapshotInput } from "../domain/research-public-snapshot";

/**
 * Converts live typed read models to a deliberately small frozen projection.
 * This is an allow-list, not a JSON copy: source records and version/status
 * metadata are retained while quotes, user content and local-LLM drafts stay
 * out of the public history.
 */
export function projectPublicResearchSnapshot(input: Record<string, unknown>): PublicResearchSnapshotInput {
  const identity = record(input.identity);
  const marketStructure = record(input.marketStructure);
  const forecastWorkspace = record(input.forecastWorkspace);
  const dossier = record(input.dossier);
  const focusProfile = record(input.focusProfile).profile;
  const valuationGate = record(input.valuationGate);
  return {
    asOf: timestamp(input.asOf),
    subjectAndMarketStructure: {
      records: [{
        listedSecurity: pick(identity.listedSecurity, ["code", "name", "market", "instrumentKind", "eligibility", "venue", "tradingCurrency", "expectedTradingCurrency", "shareClass", "depositaryRatio", "mappingStatus", "mappingBasis", "updatedAt"]),
        operatingCompany: pick(identity.operatingCompany, ["companyId", "canonicalName", "reportingCurrency", "fiscalYearEnd", "identityStatus", "updatedAt"]),
        relationships: list(identity.relationships).map((item) => pick(item, ["relationshipId", "companyId", "relationshipType", "relationshipStatus", "sourceUrl", "sourceNote", "effectiveFrom", "effectiveTo", "updatedAt"])),
        rightsProfiles: list(identity.rightsProfiles).map((item) => pick(item, ["rightsProfileId", "securityCode", "rightsStatus", "holderStructure", "legalIssuerName", "votingRightsNote", "economicRightsNote", "transferabilityNote", "structuralRiskNote", "depositaryName", "effectiveFrom", "effectiveTo", "evidenceKind", "sourceUrl", "sourceTitle", "observedAt"])),
        rightsLinks: list(identity.rightsLinks).map((item) => pick(item, ["rightsLinkId", "securityCode", "relatedSecurityCode", "relationshipKind", "relationshipStatus", "relatedSharesPerSecurity", "conversionAvailability", "effectiveFrom", "effectiveTo", "evidenceKind", "sourceUrl", "sourceTitle", "observedAt"])),
        marketStructure: {
          ruleVersion: marketStructure.ruleVersion ?? null, profileId: marketStructure.profileId ?? null,
          perShareValuation: pick(marketStructure.perShareValuation, ["status", "reason", "missingFactKeys"]),
          crossSecurityComparison: pick(marketStructure.crossSecurityComparison, ["status", "reason", "missingFactKeys"]),
          latestFacts: list(marketStructure.latestFacts).map((item) => pick(item, ["marketStructureFactId", "factKey", "factStatus", "valueKind", "valueNumber", "valueText", "unit", "measurementBasis", "asOf", "frequency", "epistemicType", "sourceAuthority", "sourceUrl", "sourceTitle", "effectiveFrom", "effectiveTo", "createdAt"])),
        },
      }],
    },
    formalFinancialCoverage: {
      records: [{
        financialCoverage: pick(identity.financials, ["status", "gaps", "policy", "statements"]),
        // A snapshot must preserve the facts and deterministic observations
        // that were available then, not merely today's source-health label.
        // This is an allow-list projection: source/value/period/basis/input
        // provenance stays replayable while transient provider payloads do not.
        financialQuality: projectFinancialQuality(input.financialQuality),
        statutoryVerifications: summarizeSection(input.statutoryVerifications, ["verificationId", "statementType", "fiscalPeriod", "status", "primaryProvider", "verificationProvider", "primarySourceUrl", "statutorySourceUrl", "statutoryDocumentId", "blockingReason", "verifiedAt"]),
        statutoryDocuments: summarizeSection(input.statutoryDocuments, ["documentId", "provider", "reportType", "reportPeriod", "publishedAt", "sourceUrl", "status"]),
      }],
    },
    operatingModelAndDriverPlan: {
      records: [{
        operatingModels: summarizeSection(input.operatingModels, ["operatingModelId", "companyId", "asOf", "version", "status", "modelType", "primaryEarningDriver", "revenueRecognition", "summary", "epistemicType", "sourceReferences"]),
        driverPlans: summarizeSection(input.operatingDriverPlans, ["operatingDriverPlanId", "operatingModelId", "asOf", "version", "status", "scenarioName", "valuationCurrency", "amountScale", "sourceReferences"]),
        marketSpaceAssessments: summarizeSection(input.marketSpaceAssessments, ["marketSpaceAssessmentId", "companyId", "asOf", "version", "status", "marketDefinition", "summary", "epistemicType", "sourceReferences"]),
        acceptedSourceFacts: summarizeSection(input.operatingSourceFacts, ["operatingSourceFactId", "evidenceReferenceId", "candidateId", "candidateReviewId", "factKind", "subjectLabel", "segmentLabel", "customerOrChannel", "periodLabel", "periodKind", "reportedValue", "numericValue", "unit", "currency", "amountScale", "scopeDescription", "comparabilityNote", "statement", "informationType", "mappingConfigVersion", "sourceUrl", "sourceTitle", "sourcePublishedAt", "recordedAt", "createdAt"]),
        sourceFactBindings: summarizeSection(input.operatingSourceFactBindings, ["operatingSourceFactBindingId", "operatingSourceFactId", "operatingModelId", "targetKind", "targetId", "targetField", "factKind", "formula", "applicablePeriod", "applicabilityDescription", "uncoveredScope", "reviewStatus", "reviewNote", "reviewedBy", "reviewedAt", "createdAt"]),
      }],
    },
    forecastAndFormalActual: {
      records: [{
        // The identity/group ids freeze the independently-reviewed origin of
        // every sample; a display label alone is never a replayable proof.
        sourceForecasts: list(forecastWorkspace.sourceForecasts).map((item) => pick(item, ["forecastId", "reviewId", "informationId", "versionId", "docId", "institution", "sourceIdentityId", "sourceIdentityAssertionId", "originSourceIdentityId", "carrierSourceIdentityId", "carrierRelation", "modelLineageId", "sourceIdentityType", "independenceGroupId", "independenceGroupName", "sourceIdentityEvidenceUrl", "sourceIdentityEvidenceTitle", "forecastDate", "metric", "fiscalYear", "fiscalPeriod", "currency", "accountingBasis", "ownershipBasis", "shareBasis", "normalizedValue", "normalizedUnit", "normalizationStatus", "supersedesForecastId", "createdAt"])),
        consolidation: pick(forecastWorkspace.consolidation, ["consolidationId", "asOf", "label", "sourceUniverse", "marketConsensus", "ruleVersion", "groups", "members"]),
        consolidationStatus: pick(forecastWorkspace.consolidationStatus, ["availability", "reason", "priorRuleVersion"]),
        selfBuiltScenarios: list(forecastWorkspace.scenarios).map((item) => pick(item, ["scenarioId", "scenarioName", "version", "status", "createdAt", "updatedAt"])),
        managementGuidance: list(input.managementGuidance).map((item) => pick(item, ["forecastId", "guidanceDate", "metric", "fiscalYear", "fiscalPeriod", "currency", "accountingBasis", "ownershipBasis", "shareBasis", "normalizedValue", "normalizedUnit", "normalizationStatus", "supersedesGuidanceForecastId", "sourceReferences", "createdAt"])),
        formalActuals: list(input.formalActuals).map((item) => pick(item, ["actualId", "metric", "fiscalYear", "fiscalPeriod", "currency", "accountingBasis", "ownershipBasis", "shareBasis", "normalizedValue", "normalizedUnit", "actualStatus", "revisionNumber", "supersedesActualId", "sourceReferences", "createdAt"])),
        // Preserve the recorded comparison and its current health state so a
        // historical public snapshot can explain why a calibration did or did
        // not support a conclusion at that time.  This remains an allow-list:
        // source documents, private inputs and local-LLM drafts are excluded.
        calibrations: list(forecastWorkspace.calibrations).map((item) => pick(item, ["calibrationId", "forecastKind", "forecastId", "actualId", "metric", "fiscalPeriod", "currency", "normalizedUnit", "accountingBasis", "ownershipBasis", "shareBasis", "forecastNormalizedValue", "actualNormalizedValue", "absoluteError", "percentageError", "comparabilityStatus", "comparabilityReason", "calibratedAt"])),
        formalActualHealth: pick(forecastWorkspace.formalActualHealth, ["ruleVersion", "calibrationAvailability", "actualCount", "currentActualCount", "restatedActualCount", "supersededActualCount", "calibrationCount", "currentComparableCalibrationCount", "historicalCalibrationAffectedByRestatementCount", "candidateWorkflow", "calibrationStates", "lineageIssues"]),
      }],
    },
    valuationVersions: {
      records: [{
        // Public replay keeps version identity, inputs and gate state. Exact
        // price/value outputs stay in the gated live valuation read model, so
        // a historic API cannot become an alternate route around that gate.
        // A historic public snapshot is never a route around the live
        // per-security valuation gate. It may retain the next evidence item,
        // but its own valuation output state is always blocked.
        gate: {
          status: "blocked",
          conclusionImpact: "公开历史快照不提供每证券估值输出。",
          nextEvidence: valuationGate.nextEvidence ?? null,
        },
        dcf: summarizeSection(input.valuationModels, ["modelVersionId", "asOf", "status", "valuationCurrency", "amountScale", "securityCurrency", "fxAsOf", "underlyingSharesPerSecurity", "sourceReferences", "createdAt"]),
        reverseDcf: summarizeSection(input.reverseValuationModels, ["modelVersionId", "asOf", "status", "valuationCurrency", "amountScale", "securityCurrency", "priceAsOf", "underlyingSharesPerSecurity", "sourceReferences", "createdAt"]),
        relativeValuation: summarizeSection(input.relativeValuationLedgers, ["ledgerId", "asOf", "status", "role", "archetype", "method", "peerUniverseId", "valuationCurrency", "securityCurrency", "comparabilityGates", "createdAt"]),
        marketStructureGates: { perShare: pick(marketStructure.perShareValuation, ["status", "reason", "missingFactKeys"]), comparison: pick(marketStructure.crossSecurityComparison, ["status", "reason", "missingFactKeys"]) },
      }],
    },
    researchConclusions: {
      records: [{
        theses: sectionItems(dossier.theses, ["thesisId", "asOf", "title", "statement", "status", "invalidationCondition", "reviewBy", "evidence", "createdAt", "updatedAt"]),
        risks: sectionItems(dossier.risks, ["riskId", "asOf", "scope", "category", "title", "exposure", "transmission", "status", "triggerCondition", "sourceReferences", "createdAt", "updatedAt"]),
        impactReviews: list(input.impactReviews).map((item) => pick(item, ["impactReviewId", "sourceKind", "sourceId", "sourceObservedAt", "rationale", "sourceBinding", "targets", "createdAt"])),
        focusProfile: focusProfile ? pick(focusProfile, ["focusProfileId", "companyId", "version", "asOf", "status", "title", "reviewBy", "items"]) : null,
        governanceCapitalFacts: summarizeSection(input.governanceCapitalFacts, ["governanceCapitalFactVersionId", "candidateReviewId", "supersedesFactVersionId", "factKey", "factStatus", "valueKind", "valueNumber", "valueRangeLower", "valueRangeUpper", "valueText", "unit", "asOf", "period", "sourceAuthority", "versionId", "contentHash", "docId", "sourceUrl", "sourceTitle", "publishedAt", "sourceLocator", "createdAt"]),
      }],
    },
  };
}

function summarizeSection(value: unknown, keys: string[]) { const source = record(value); return { availability: source.availability ?? "unavailable", reason: source.reason ?? null, items: list(source.items).map((item) => pick(item, keys)) }; }
function projectFinancialQuality(value: unknown) {
  const quality = record(value);
  const coreMetrics = new Set(["revenue", "gross_profit", "operating_profit", "net_profit", "operating_cash_flow", "capital_expenditure", "cash", "total_debt", "total_equity", "diluted_shares"]);
  const series = list(quality.series).filter((item) => coreMetrics.has(String(item.metric))).map((item) => {
    const frequency = String(item.frequency);
    const limit = frequency === "annual" ? 5 : frequency === "quarterly" ? 12 : frequency === "ttm" ? 4 : 0;
    return {
      ...pick(item, ["metric", "frequency", "basis", "unit"]),
      points: list(item.points).sort(byPeriodDescending).slice(0, limit).map(projectFinancialPoint),
    };
  }).filter((item) => item.points.length);
  const observations = list(quality.observations)
    .filter((item) => coreMetrics.has(String(item.metric)))
    .sort(byPeriodDescending).slice(0, 120)
    .map((item) => pick(item, ["id", "kind", "metric", "frequency", "basis", "period", "comparisonPeriod", "status", "value", "unit", "formula", "reasonCodes", "inputs"]));
  const gaps = list(quality.gaps).reduce((counts: Record<string, number>, item) => {
    const reasons = Array.isArray(item.reasonCodes) ? item.reasonCodes.map(String).sort().join(",") : "";
    const key = `${item.status ?? "unknown"}:${reasons || "unspecified"}`;
    counts[key] = (counts[key] ?? 0) + 1; return counts;
  }, {});
  return {
    ruleVersion: quality.ruleVersion ?? null,
    scope: "core metrics: latest 5 annual, 12 quarterly, 4 TTM points; latest 120 core observations; gaps are grouped by status/reason",
    series, observations, gapSummary: gaps,
  };
}
function projectFinancialPoint(point: Record<string, unknown>) { return pick(point, ["period", "status", "value", "formula", "reasonCodes", "inputs"]); }
function byPeriodDescending(left: Record<string, unknown>, right: Record<string, unknown>) {
  return String(record(right.period).endDate ?? "").localeCompare(String(record(left.period).endDate ?? ""));
}
function sectionItems(value: unknown, keys: string[]) { return summarizeSection(value, keys); }
function pick(value: unknown, keys: string[]): Record<string, unknown> | null { const source = record(value); if (!Object.keys(source).length) return null; return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]])); }
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function list(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.map(record) : []; }
function timestamp(value: unknown): number { const result = Number(value); if (!Number.isInteger(result) || result <= 0) throw new Error("public research snapshot asOf must be a positive integer"); return result; }
