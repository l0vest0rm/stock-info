import assert from "node:assert/strict";
import test from "node:test";
import { blockedScenarioValuationOutput, buildScenarioValuationInput, validateScenarioValuationOutput } from "./operating-analysis-scenario-valuation.mjs";

function artifact(stepKey, output) { return { artifactId: `llm-artifact:${stepKey}`, stepKey, status: "complete", output, sourceIds: [`source:${stepKey}`], claimIds: [`claim:${stepKey}`], evidenceIds: [`evidence:${stepKey}`], unknownIds: [] }; }
const s8 = artifact("operating_thesis", { causalChain: [{ judgmentId: "judgment:1" }], judgmentIds: ["judgment:1"], claimIds: ["claim:operating_thesis"], evidenceIds: ["evidence:operating_thesis"], sourceIds: ["source:operating_thesis"], unknownIds: [], analysisGaps: [] });
const s6 = artifact("financial_quality", { observations: [{ observationId: "observation:revenue", value: 100 }], claimIds: ["claim:financial"], evidenceIds: ["evidence:financial"], sourceIds: ["source:financial"], unknowns: [], analysisGaps: [] });
const s7 = artifact("market_valuation_facts", { marketFacts: [{ metric: "price", value: 10 }], claimIds: ["claim:market"], evidenceIds: ["evidence:market"], sourceIds: ["source:market"], unknowns: [], analysisGaps: [] });

function dcf(scenario) { return { scenario, openingRevenue: 100, openingNetWorkingCapital: 10, amountScale: "million", currency: "CNY", wacc: 0.1, terminalGrowth: 0.03, netDebt: 5, dilutedShares: 20, years: [{ fiscalYear: 2027, revenueGrowth: 0.1, ebitMargin: 0.2, taxRate: 0.25, depreciationAmortizationMargin: 0.03, capitalExpenditureMargin: 0.04, netWorkingCapitalToRevenue: 0.1 }] }; }
function scenario(name) { return { scenario: name, assumptions: [{ assumptionId: `assumption:${name}`, scenario: name, variable: "revenueGrowth", value: 0.1, period: "2027FY", unit: "ratio", judgmentIds: ["judgment:1"], claimIds: ["claim:operating_thesis"], evidenceIds: ["evidence:operating_thesis"], sourceIds: ["source:operating_thesis"] }], valuationMethodSelection: [{ method: "dcf", status: "selected", sourceIds: ["source:market"] }] }; }

test("S9 input projects only S8/S6/S7 manifests and compact S0", () => {
  const input = buildScenarioValuationInput({ context: { contextVersion: "research-context.v1", asOf: "2026-08-09", financialSnapshot: { deterministicMetrics: [{ period: "2026Q1" }] }, marketSnapshot: { source: "xueqiu", price: 10 }, analysisGaps: [] }, artifactsByKey: { operating_thesis: s8, financial_quality: s6, market_valuation_facts: s7 } });
  assert.equal("markdown" in input.operatingThesis, false);
  assert.deepEqual(input.inputLineage.upstreamArtifactIds, ["llm-artifact:financial_quality", "llm-artifact:market_valuation_facts", "llm-artifact:operating_thesis"]);
});

test("S9 rejects model-calculated valuation values and requires three scenarios", () => {
  const output = { schemaVersion: "scenario-valuation.v1", status: "complete", scenarios: [scenario("downside"), scenario("base"), scenario("upside")], valuationMethodSelection: [], valuationCalculationRequest: { dcfScenarios: [dcf("downside"), dcf("base"), dcf("upside")] }, reverseValuationSolveTargets: [], sensitivityRequests: [], riskRegister: [], invalidationPaths: [], monitoringIndicators: [], blockedValuationItems: [], sourceIds: ["source:operating_thesis"], claimIds: ["claim:operating_thesis"], evidenceIds: ["evidence:operating_thesis"], unknownIds: [], usedUpstreamArtifactIds: [] };
  assert.equal(validateScenarioValuationOutput(output).status, "complete");
  assert.throws(() => validateScenarioValuationOutput({ ...output, scenarios: output.scenarios.map((item) => ({ ...item, enterpriseValue: 1 })) }), /deterministic output/);
  assert.equal(blockedScenarioValuationOutput({}).status, "blocked");
});

test("S9 accepts reverse-DCF inputs but keeps deterministic enterprise value ownership in S10", () => {
  const output = { schemaVersion: "scenario-valuation.v1", status: "partial", scenarios: [], valuationMethodSelection: [], valuationCalculationRequest: { dcfScenarios: [] }, reverseValuationSolveTargets: [{ scenario: "base", currency: "CNY", amountScale: "million", enterpriseValue: 500, wacc: 0.1, terminalGrowth: 0.03 }], sensitivityRequests: [], riskRegister: [], invalidationPaths: [], monitoringIndicators: [], blockedValuationItems: [], sourceIds: [], claimIds: [], evidenceIds: [], unknownIds: [], usedUpstreamArtifactIds: [] };
  assert.equal(validateScenarioValuationOutput(output).reverseValuationSolveTargets[0].enterpriseValue, 500);
  assert.throws(() => validateScenarioValuationOutput({ ...output, enterpriseValue: 500 }), /deterministic output/);
});
