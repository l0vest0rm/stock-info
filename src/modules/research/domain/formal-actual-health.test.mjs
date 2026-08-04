import assert from "node:assert/strict";
import test from "node:test";
import { buildFormalActualHealth } from "./formal-actual-health";

const actual = (overrides = {}) => ({
  actualId: "actual:1", securityCode: "300308.SZ", companyId: "company:1", metric: "revenue", fiscalYear: 2026,
  fiscalPeriod: "2026FY", rawValue: 10, rawUnit: "hundred_million_currency", currency: "CNY", accountingBasis: "gaap",
  ownershipBasis: "consolidated", shareBasis: "unspecified", normalizedValue: 10, normalizedUnit: "hundred_million_currency",
  normalizationStatus: "comparable", normalizationNotes: null, actualStatus: "original", revisionNumber: 1,
  supersedesActualId: null, restatementNote: null, filedAt: "2027-03-01", sourceStatement: "filing",
  sourceReferences: [{ sourceKind: "filing", url: "https://example.test/filing" }], epistemicType: "observed_fact", ...overrides,
});

const calibration = (overrides = {}) => ({
  calibrationId: "calibration:1", ruleVersion: "forecast-actual-calibration.v1", forecastKind: "third_party_forecast",
  forecastId: "forecast:1", actualId: "actual:1", securityCode: "300308.SZ", companyId: "company:1", metric: "revenue",
  fiscalPeriod: "2026FY", currency: "CNY", normalizedUnit: "hundred_million_currency", accountingBasis: "gaap",
  ownershipBasis: "consolidated", shareBasis: "unspecified", forecastNormalizedValue: 9, actualNormalizedValue: 10,
  absoluteError: 1, percentageError: 1 / 9, comparabilityStatus: "comparable", comparabilityReason: null, ...overrides,
});

const candidate = (overrides = {}) => ({
  candidateId: "candidate:1", securityCode: "300308.SZ", verificationId: "verification:1", metric: "revenue", forecastMetric: "revenue",
  factDictionaryEntryId: "formal-financial-fact:revenue", factDictionaryVersion: "formal-financial-fact-dictionary.v1",
  fiscalYear: 2026, fiscalPeriod: "2026FY", periodStartDate: "2026-01-01", periodEndDate: "2026-12-31", reportedValue: 10,
  reportedUnit: "currency", currency: "CNY", statutoryProvider: "cninfo", statutoryDocumentId: "doc:1",
  statutoryDisclosureUrl: "https://example.test/filing", statutoryLocator: "income/revenue", statutoryPublishedAt: "2027-03-01",
  statutoryReportDate: "2026-12-31", sourceBinding: {}, candidateRuleVersion: "formal-actual-candidate.v2",
  eligibility: "ready_for_review", blockingReason: null, createdAt: 100, ...overrides,
});

test("a calibration remains historical but is not current evidence after its actual was superseded", () => {
  const result = buildFormalActualHealth({
    actuals: [
      actual({ actualStatus: "superseded" }),
      actual({ actualId: "actual:2", actualStatus: "restated", revisionNumber: 2, supersedesActualId: "actual:1", restatementNote: "restated filing" }),
    ],
    calibrations: [calibration()], candidates: [], candidateReviews: [],
  });
  assert.equal(result.calibrationAvailability, "partial");
  assert.equal(result.currentActualCount, 1, "the replacement restated actual remains the current formal fact");
  assert.equal(result.currentComparableCalibrationCount, 0);
  assert.equal(result.historicalCalibrationAffectedByRestatementCount, 1);
  assert.equal(result.calibrationStates[0].currentState, "recorded_comparable_superseded_actual");
  assert.deepEqual(result.lineageIssues, []);
});

test("candidate workflow uses the latest review and exposes impossible accepted links", () => {
  const result = buildFormalActualHealth({
    actuals: [actual()], calibrations: [],
    candidates: [candidate(), candidate({ candidateId: "candidate:blocked", eligibility: "blocked", blockingReason: "statutory_conflict" }), candidate({ candidateId: "candidate:missing" })],
    candidateReviews: [
      { reviewId: "review:old", candidateId: "candidate:1", decision: "needs_evidence", reviewer: "local", reason: "old", accountingBasis: null, ownershipBasis: null, shareBasis: null, actualId: null, reviewedAt: 10, createdAt: 10 },
      { reviewId: "review:new", candidateId: "candidate:1", decision: "accepted", reviewer: "local", reason: "confirmed", accountingBasis: "gaap", ownershipBasis: "consolidated", shareBasis: "unspecified", actualId: "actual:1", reviewedAt: 20, createdAt: 20 },
      { reviewId: "review:missing", candidateId: "candidate:missing", decision: "accepted", reviewer: "local", reason: "broken", accountingBasis: "gaap", ownershipBasis: "consolidated", shareBasis: "unspecified", actualId: "actual:missing", reviewedAt: 20, createdAt: 20 },
    ],
  });
  assert.equal(result.candidateWorkflow.acceptedCount, 1);
  assert.equal(result.candidateWorkflow.blockedByStatutoryVerificationCount, 1);
  assert.equal(result.candidateWorkflow.acceptedActualMissingCount, 1);
  assert.equal(result.candidateWorkflow.needsEvidenceCount, 0, "old review must not override a later acceptance");
});

test("lineage health reports malformed restatement links without repairing records", () => {
  const result = buildFormalActualHealth({
    actuals: [actual({ actualId: "actual:old", actualStatus: "superseded" }), actual({ actualId: "actual:broken", actualStatus: "restated", revisionNumber: 4, supersedesActualId: "actual:missing", restatementNote: "unknown predecessor" })],
    calibrations: [], candidates: [], candidateReviews: [],
  });
  assert.deepEqual(result.lineageIssues.map((item) => item.reason).sort(), ["restatement_missing_predecessor", "superseded_actual_without_restatement_successor"]);
});

test("candidate health keeps newer statutory documents visible before acceptance", () => {
  const result = buildFormalActualHealth({
    actuals: [], calibrations: [], candidateReviews: [],
    candidates: [
      candidate({ candidateId: "candidate:original", statutoryDocumentId: "doc:original", statutoryPublishedAt: "2027-03-01" }),
      candidate({ candidateId: "candidate:amended", statutoryDocumentId: "doc:amended", statutoryPublishedAt: "2027-05-01" }),
    ],
  });
  assert.equal(result.candidateWorkflow.newerStatutoryDocumentAvailableCount, 1);
  assert.equal(result.candidateStates.find((item) => item.candidateId === "candidate:original").statutoryCurrentness, "newer_statutory_document_available");
  assert.equal(result.candidateStates.find((item) => item.candidateId === "candidate:amended").statutoryCurrentness, "current_statutory_document");
});
