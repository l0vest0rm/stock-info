import assert from "node:assert/strict";
import test from "node:test";
import { assessResearchDepths } from "./research-depth";

const readyModules = ["identity", "financials", "operating", "forecasts", "valuation", "risk_review"].map((moduleId) => ({ moduleId, status: "ready" }));
const available = { availability: "available", items: [{}] };

test("depth levels retain every prerequisite instead of averaging missing deep evidence", () => {
  const result = assessResearchDepths({
    modules: readyModules, sourceDocumentCount: 2, industryExposures: available, peerSets: available, governance: available,
    operatingModelDetails: { segments: 1, contracts: 1, unitEconomics: 0 },
    marketDetails: { assessments: 1, shareBridgeSteps: 1, profitPools: 1 }, stressScenarios: available, calibrations: available,
  });
  assert.equal(result.levels.find((item) => item.depth === "basic").status, "ready");
  assert.equal(result.levels.find((item) => item.depth === "standard").status, "ready");
  const deep = result.levels.find((item) => item.depth === "deep");
  assert.equal(deep.status, "blocked");
  assert.equal(deep.requirements.find((item) => item.id === "segments").status, "blocked");
});

test("an unavailable source makes the affected depth unavailable and preserves the blocked conclusion", () => {
  const result = assessResearchDepths({
    modules: readyModules.map((item) => item.moduleId === "financials" ? { ...item, status: "unavailable" } : item),
    sourceDocumentCount: 1, industryExposures: available, peerSets: available, governance: available,
    operatingModelDetails: { segments: 1, contracts: 1, unitEconomics: 1 }, marketDetails: { assessments: 1, shareBridgeSteps: 1, profitPools: 1 }, stressScenarios: available, calibrations: available,
  });
  const basic = result.levels.find((item) => item.depth === "basic");
  assert.equal(basic.status, "unavailable");
  assert.match(basic.requirements.find((item) => item.id === "financial_trend").blockedConclusion, /完整基本面事实/);
});

test("historical or incomparable calibration rows cannot unlock deep research", () => {
  const result = assessResearchDepths({
    modules: readyModules, sourceDocumentCount: 2, industryExposures: available, peerSets: available, governance: available,
    operatingModelDetails: { segments: 1, contracts: 1, unitEconomics: 1 },
    marketDetails: { assessments: 1, shareBridgeSteps: 1, profitPools: 1 }, stressScenarios: available,
    // The route must pass this as empty unless formalActualHealth says the
    // calibration is currently comparable; a stored history row alone is not
    // evidence of realised forecast accuracy.
    calibrations: { availability: "empty", items: [{ calibrationId: "historical:not-comparable" }] },
  });
  const deep = result.levels.find((item) => item.depth === "deep");
  assert.equal(deep.status, "blocked");
  assert.equal(deep.requirements.find((item) => item.id === "calibration").status, "blocked");
});
