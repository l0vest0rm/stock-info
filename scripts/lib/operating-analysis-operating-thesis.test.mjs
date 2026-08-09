import assert from "node:assert/strict";
import test from "node:test";
import { buildOperatingThesisInput, deriveOperatingThesisRequeueTargets, validateOperatingThesisOutput } from "./operating-analysis-operating-thesis.mjs";

function artifact(stepKey, output) {
  return { artifactId: `llm-artifact:${stepKey}`, stepKey, status: "complete", stageVersion: `${stepKey}.v1`, output, sourceIds: [`source:${stepKey}`], claimIds: [`claim:${stepKey}`], evidenceIds: [`evidence:${stepKey}`], unknownIds: [] };
}

const artifacts = {
  company_facts: artifact("company_facts", { companyScope: { products: ["产品"] }, unknowns: [], analysisGaps: [], sourceIds: ["source:company_facts"], claimIds: ["claim:company_facts"], evidenceIds: ["evidence:company_facts"], usedUpstreamArtifactIds: ["llm-artifact:research_context"] }),
  industry_structure: artifact("industry_structure", { industryBoundary: {}, valueChain: [], profitPool: [], unknowns: [], analysisGaps: [], sourceIds: ["source:industry_structure"], claimIds: ["claim:industry_structure"], evidenceIds: ["evidence:industry_structure"], usedUpstreamArtifactIds: ["llm-artifact:research_context"] }),
  supply_demand_cycle: artifact("supply_demand_cycle", { demand: [], supply: [], cyclePosition: {}, pressureInputs: [], unknowns: [], analysisGaps: [], sourceIds: ["source:supply_demand_cycle"], claimIds: ["claim:supply_demand_cycle"], evidenceIds: ["evidence:supply_demand_cycle"], usedUpstreamArtifactIds: ["llm-artifact:research_context"] }),
  competition_peers: artifact("competition_peers", { peerSet: [], competitivePosition: [], unknowns: [], analysisGaps: [], sourceIds: ["source:competition_peers"], claimIds: ["claim:competition_peers"], evidenceIds: ["evidence:competition_peers"], usedUpstreamArtifactIds: ["llm-artifact:research_context"] }),
  company_operating_drivers: artifact("company_operating_drivers", { drivers: [], orders: [], capacity: [], unknowns: [], analysisGaps: [], sourceIds: ["source:company_operating_drivers"], claimIds: ["claim:company_operating_drivers"], evidenceIds: ["evidence:company_operating_drivers"], usedUpstreamArtifactIds: ["llm-artifact:research_context"] }),
};

test("S8 input contains only compact S0 trend and explicit S1-S5 projections", () => {
  const input = buildOperatingThesisInput({ context: { contextVersion: "research-context.v1", asOf: "2026-08-09", financialSnapshot: { deterministicMetrics: [{ period: "2026Q1", revenue: 100 }] }, analysisGaps: [] }, artifactsByKey: artifacts });
  assert.equal(input.status, "ready");
  assert.deepEqual(input.financialTrend, [{ period: "2026Q1", revenue: 100 }]);
  assert.equal("markdown" in input.domains.company_facts.fields, false);
  assert.deepEqual(input.manifest.sourceIds.slice(0, 2), ["source:company_facts", "source:company_operating_drivers"]);
});

test("S8 causal chain requires named evidence and does not permit duplicate judgments", () => {
  const base = { status: "complete", causalChain: [{ judgmentId: "judgment:revenue", variablePath: "demand.volume.price.revenue.margin", from: "需求", to: "利润率", mechanism: "量价传导", claimIds: ["claim:company_facts"], sourceIds: ["source:company_facts"], supportingEvidenceIds: ["evidence:company_facts"], counterEvidenceIds: [], alternativeExplanations: ["价格变化可能来自组合"], invalidationConditions: ["订单连续下降"] }], sourceIds: ["source:company_facts"], claimIds: ["claim:company_facts"], evidenceIds: ["evidence:company_facts"], unknownIds: [], analysisGaps: [] };
  assert.equal(validateOperatingThesisOutput(base).causalChain[0].judgmentId, "judgment:revenue");
  assert.throws(() => validateOperatingThesisOutput({ ...base, causalChain: [...base.causalChain, ...base.causalChain] }), /duplicate judgmentId/);
  assert.deepEqual(deriveOperatingThesisRequeueTargets([{ code: "peer_comparability_gap" }, { code: "orders_missing" }]), ["competition_peers", "company_operating_drivers"]);
});
