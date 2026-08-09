import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInvestmentConclusionInput,
  projectInvestmentConclusionForReport,
  validateInvestmentConclusionOutput,
} from "./operating-analysis-investment-conclusion.mjs";

function artifact(stepKey, output) {
  return {
    artifactId: `llm-artifact:${stepKey}`,
    stepKey,
    status: "complete",
    stageVersion: `${stepKey}.v1`,
    output,
    sourceIds: [`source:${stepKey}`],
    claimIds: [`claim:${stepKey}`],
    evidenceIds: [`evidence:${stepKey}`],
    unknownIds: [],
  };
}

const thesis = artifact("operating_thesis", { schemaVersion: "operating-thesis.v1", status: "complete", causalChain: [], judgmentIds: ["judgment:revenue"], claimIds: ["claim:operating_thesis"], evidenceIds: ["evidence:operating_thesis"], sourceIds: ["source:operating_thesis"], unknownIds: [], analysisGaps: [] });
const financial = artifact("financial_quality", { status: "complete", observations: [], claimIds: ["claim:financial"], evidenceIds: ["evidence:financial"], sourceIds: ["source:financial"], unknowns: [], analysisGaps: [] });
const market = artifact("market_valuation_facts", { status: "complete", marketFacts: [], claimIds: ["claim:market"], evidenceIds: ["evidence:market"], sourceIds: ["source:market"], unknowns: [], analysisGaps: [] });

const deterministic = {
  status: "complete",
  formulaVersion: "deterministic-valuation-formula.v1",
  results: [{ kind: "dcf", scenario: "base", valuePerShare: 12 }],
  sensitivity: [],
  blockedValuationItems: [],
  calculationTrace: [{ calculationId: "calculation:base:dcf", formulaVersion: "deterministic-valuation-formula.v1" }],
};

test("S11 input is limited to S9/S10 outputs and provenance IDs", () => {
  const input = buildInvestmentConclusionInput({
    context: { contextVersion: "research-context.v1", asOf: "2026-08-09", company: { name: "测试公司" }, security: { securityCode: "000001.SZ" } },
    scenarioOutput: { status: "complete", scenarios: ["downside", "base", "upside"].map((scenario) => ({ scenario, assumptions: [] })), valuationCalculationRequest: { dcfScenarios: [] }, reverseValuationSolveTargets: [], sensitivityRequests: [], blockedValuationItems: [], riskRegister: [], invalidationPaths: [], monitoringIndicators: [], sourceIds: ["source:scenario"], claimIds: ["claim:scenario"], evidenceIds: ["evidence:scenario"], unknownIds: [] },
    deterministicValuation: deterministic,
    thesisArtifact: thesis,
    financialArtifact: financial,
    marketArtifact: market,
  });
  assert.equal(input.deterministicValuation.calculationIds[0], "calculation:base:dcf");
  assert.equal(input.provenance.sourceIds.includes("source:operating_thesis"), true);
  assert.equal(input.provenance.calculationIds[0], "calculation:base:dcf");
});

test("S11 owns only chapters 9-12 and requires source-backed calculation IDs", () => {
  const output = { schemaVersion: "investment-conclusion.v1", status: "complete", markdownByChapter: { "9": "估值解释", "10": "风险", "11": "跟踪", "12": "结论" }, calculationIds: ["calculation:base:dcf"], judgmentIds: [], assumptionIds: [], riskIds: [], claimIds: [], evidenceIds: [], sourceIds: [], unknownIds: [] };
  assert.equal(validateInvestmentConclusionOutput(output, { calculationIds: ["calculation:base:dcf"], deterministicStatus: "complete" }).status, "complete");
  assert.throws(() => validateInvestmentConclusionOutput({ ...output, markdownByChapter: { ...output.markdownByChapter, "8": "不允许" } }, { calculationIds: ["calculation:base:dcf"], deterministicStatus: "complete" }), /cannot own chapter 8/);
  assert.throws(() => validateInvestmentConclusionOutput({ ...output, markdown: "# 2. 公司概况\n不可重写" }, { calculationIds: ["calculation:base:dcf"], deterministicStatus: "complete" }), /cannot rewrite chapters/);
  assert.throws(() => validateInvestmentConclusionOutput({ ...output, calculationIds: ["calculation:unknown"] }, { calculationIds: ["calculation:base:dcf"], deterministicStatus: "complete" }), /unknown calculation/);
  assert.throws(() => validateInvestmentConclusionOutput({ ...output, calculationIds: [] }, { calculationIds: ["calculation:base:dcf"], deterministicStatus: "complete", requiredCalculationIds: ["calculation:base:dcf"] }), /missing calculation/);
});

test("S11 cannot turn blocked deterministic valuation into a complete conclusion", () => {
  assert.throws(() => validateInvestmentConclusionOutput({ status: "complete", markdownByChapter: { "12": "结论" }, calculationIds: ["calculation:base:dcf"] }, { calculationIds: ["calculation:base:dcf"], deterministicStatus: "blocked" }), /deterministic valuation is blocked/);
  const projected = projectInvestmentConclusionForReport({ status: "blocked", markdownByChapter: {}, calculationIds: [], judgmentIds: [], assumptionIds: [], riskIds: [], claimIds: [], evidenceIds: [], sourceIds: [], unknownIds: [] });
  assert.deepEqual(Object.keys(projected.markdownByChapter), ["9", "10", "11", "12"]);
});
