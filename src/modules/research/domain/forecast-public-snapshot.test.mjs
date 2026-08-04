import assert from "node:assert/strict";
import test from "node:test";
import { projectPublicResearchSnapshot } from "../application/project-public-research-snapshot";

test("public research snapshot freezes source assertion, origin, carrier relation and model lineage", () => {
  const snapshot = projectPublicResearchSnapshot({
    asOf: 1,
    forecastWorkspace: {
      sourceForecasts: [{
        forecastId: "forecast:1", reviewId: "review:1", informationId: "information:1", versionId: "version:1", docId: "doc:1",
        sourceIdentityAssertionId: "assertion:1", originSourceIdentityId: "identity:origin", carrierSourceIdentityId: "identity:carrier",
        carrierRelation: "republication", modelLineageId: "lineage:1", independenceGroupId: "group:1", secret: "must-not-copy",
      }],
      consolidation: { consolidationId: "consolidation:1", members: [{ forecastId: "forecast:1", sourceIdentityAssertionId: "assertion:1", modelLineageId: "lineage:1" }] },
      consolidationStatus: { availability: "available" },
    },
  });
  const forecast = snapshot.forecastAndFormalActual.records[0].sourceForecasts[0];
  assert.equal(forecast.sourceIdentityAssertionId, "assertion:1");
  assert.equal(forecast.originSourceIdentityId, "identity:origin");
  assert.equal(forecast.carrierSourceIdentityId, "identity:carrier");
  assert.equal(forecast.carrierRelation, "republication");
  assert.equal(forecast.modelLineageId, "lineage:1");
  assert.equal(forecast.secret, undefined);
  assert.equal(snapshot.forecastAndFormalActual.records[0].consolidation.members[0].sourceIdentityAssertionId, "assertion:1");
});

test("public snapshot replays formal-actual comparability and health without copying private inputs", () => {
  const snapshot = projectPublicResearchSnapshot({
    asOf: 1,
    forecastWorkspace: {
      calibrations: [{
        calibrationId: "calibration:1", forecastId: "forecast:1", actualId: "actual:2", metric: "revenue", fiscalPeriod: "2026FY",
        currency: "CNY", normalizedUnit: "currency", accountingBasis: "CAS", ownershipBasis: "consolidated", shareBasis: "unspecified",
        forecastNormalizedValue: 9, actualNormalizedValue: 10, absoluteError: 1, percentageError: 1 / 9,
        comparabilityStatus: "not_comparable", comparabilityReason: "restated_actual", calibratedAt: 2, privateNote: "must-not-copy",
      }],
      formalActualHealth: {
        ruleVersion: "formal-actual-health.v1", calibrationAvailability: "partial", actualCount: 2, currentActualCount: 1,
        restatedActualCount: 1, supersededActualCount: 1, calibrationCount: 1, currentComparableCalibrationCount: 0,
        historicalCalibrationAffectedByRestatementCount: 1, candidateWorkflow: { pendingHumanReviewCount: 0 },
        calibrationStates: [{ calibrationId: "calibration:1", currentState: "recorded_not_comparable" }], lineageIssues: [], localDraft: "must-not-copy",
      },
    },
  });
  const section = snapshot.forecastAndFormalActual.records[0];
  assert.deepEqual(section.calibrations[0], {
    calibrationId: "calibration:1", forecastId: "forecast:1", actualId: "actual:2", metric: "revenue", fiscalPeriod: "2026FY",
    currency: "CNY", normalizedUnit: "currency", accountingBasis: "CAS", ownershipBasis: "consolidated", shareBasis: "unspecified",
    forecastNormalizedValue: 9, actualNormalizedValue: 10, absoluteError: 1, percentageError: 1 / 9,
    comparabilityStatus: "not_comparable", comparabilityReason: "restated_actual", calibratedAt: 2,
  });
  assert.equal(section.formalActualHealth.calibrationAvailability, "partial");
  assert.equal(section.formalActualHealth.currentComparableCalibrationCount, 0);
  assert.equal(section.formalActualHealth.localDraft, undefined);
});
