import assert from "node:assert/strict";
import test from "node:test";
import { researchDataRequirementSignals } from "../api/research.routes.ts";
import { buildResearchDataRequirementCoverage } from "./research-data-requirements.ts";

const OBSERVED_AT = Date.UTC(2026, 7, 4);

test("accepted operating source facts make issuer-disclosure health partial without upgrading an operating model", () => {
  const signals = researchDataRequirementSignals({
    identity: {}, financials: {}, statutoryVerifications: {},
    operatingModels: { availability: "empty", items: [] },
    operatingDriverPlans: { availability: "empty", items: [] },
    marketSpaceAssessments: { availability: "empty", items: [] },
    operatingSourceFacts: { availability: "available", items: [{ operatingSourceFactId: "fact:1", recordedAt: OBSERVED_AT }] },
    operatingSourceFactBindings: { availability: "empty", items: [], reviewedInputs: [] },
    typedTrackExposures: { availability: "empty", items: [] }, typedPeerComparisonSets: { availability: "empty", items: [] },
    forecastWorkspace: {}, valuationModels: { availability: "empty", items: [] }, reverseValuationModels: { availability: "empty", items: [] },
    governance: { availability: "empty", items: [] }, governanceCapitalFacts: {}, dossier: {}, modelReviewItems: [], kline: { rows: [], source: "none" },
  });
  assert.deepEqual(signals.operating.model, { state: "partial", observedAt: OBSERVED_AT });

  const coverage = buildResearchDataRequirementCoverage({ asOf: OBSERVED_AT, signals });
  assert.equal(coverage.sourceHealth.find((item) => item.sourceId === "issuer_operating_disclosure")?.status, "partial");
  assert.equal(coverage.requirements.find((item) => item.requirementId === "business_model_and_drivers")?.status, "partial");
});
