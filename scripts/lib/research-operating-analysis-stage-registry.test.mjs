import assert from "node:assert/strict";
import test from "node:test";
import {
  RESEARCH_OPERATING_ANALYSIS_LEGACY_PROMPT_VERSION,
  RESEARCH_OPERATING_ANALYSIS_LEGACY_PROTOCOL_VERSION,
  RESEARCH_OPERATING_ANALYSIS_TARGET_PROTOCOL_VERSION,
  RESEARCH_OPERATING_ANALYSIS_TARGET_PROMPT_VERSION,
  RESEARCH_OPERATING_ANALYSIS_TARGET_STAGES,
  RESEARCH_OPERATING_ANALYSIS_TARGET_TASK_TYPE,
  getResearchOperatingAnalysisStage,
  isResearchOperatingAnalysisLegacyStage,
  isResearchOperatingAnalysisTargetStage,
  researchOperatingAnalysisDependencies,
  researchOperatingAnalysisTaskIdentity,
  researchOperatingAnalysisWaves,
  terminalResearchOperatingAnalysisStatuses,
} from "./research-operating-analysis-stage-registry.mjs";

test("low-dependency registry covers S0 routing plus S1-S12 and keeps legacy keys disjoint", () => {
  assert.deepEqual(RESEARCH_OPERATING_ANALYSIS_TARGET_STAGES.map((stage) => stage.key), [
    "engineering_baseline",
    "local_routing_match",
    "company_facts",
    "industry_structure",
    "supply_demand_cycle",
    "competition_peers",
    "company_operating_drivers",
    "financial_quality",
    "market_valuation_facts",
    "operating_thesis",
    "scenario_valuation",
    "deterministic_valuation",
    "investment_conclusion",
    "report_assembly",
  ]);
  assert.equal(isResearchOperatingAnalysisTargetStage("engineering_baseline"), true);
  assert.equal(isResearchOperatingAnalysisTargetStage("local_routing_match"), true);
  assert.equal(isResearchOperatingAnalysisLegacyStage("company_baseline"), true);
  assert.equal(isResearchOperatingAnalysisTargetStage("company_baseline"), false);
  assert.equal(isResearchOperatingAnalysisLegacyStage("research_context"), false);
  assert.equal(RESEARCH_OPERATING_ANALYSIS_TARGET_STAGES.length, 14);
});

test("scope-envelope waves run S1-S7 together and fallback keeps S2-S5 on S0", () => {
  const reliable = researchOperatingAnalysisWaves({ scopeEnvelopeAvailable: true });
  const fallback = researchOperatingAnalysisWaves({ scopeEnvelopeAvailable: false });
  assert.deepEqual(reliable.map((wave) => wave.map((stage) => stage.key)), [
    ["engineering_baseline"],
    ["local_routing_match"],
    ["company_facts", "industry_structure", "supply_demand_cycle", "competition_peers", "company_operating_drivers", "financial_quality", "market_valuation_facts"],
    ["operating_thesis"],
    ["scenario_valuation"],
    ["deterministic_valuation"],
    ["investment_conclusion"],
    ["report_assembly"],
  ]);
  assert.deepEqual(fallback[2].map((stage) => stage.key), ["company_facts", "industry_structure", "supply_demand_cycle", "competition_peers", "company_operating_drivers", "financial_quality", "market_valuation_facts"]);
  assert.deepEqual(fallback[3].map((stage) => stage.key), ["operating_thesis"]);
  assert.deepEqual(researchOperatingAnalysisDependencies("industry_structure", { scopeEnvelopeAvailable: true }), ["local_routing_match"]);
  assert.deepEqual(researchOperatingAnalysisDependencies("industry_structure", { scopeEnvelopeAvailable: false }), ["local_routing_match"]);
  assert.deepEqual(researchOperatingAnalysisDependencies("financial_quality", { scopeEnvelopeAvailable: false }), ["local_routing_match"]);
});

test("new task identity cannot silently reuse the legacy prompt contract", () => {
  const identity = researchOperatingAnalysisTaskIdentity("300308.SZ");
  assert.equal(identity.taskType, RESEARCH_OPERATING_ANALYSIS_TARGET_TASK_TYPE);
  assert.equal(identity.protocolVersion, RESEARCH_OPERATING_ANALYSIS_TARGET_PROTOCOL_VERSION);
  assert.equal(identity.promptVersion, RESEARCH_OPERATING_ANALYSIS_TARGET_PROMPT_VERSION);
  assert.notEqual(identity.promptVersion, RESEARCH_OPERATING_ANALYSIS_LEGACY_PROMPT_VERSION);
  assert.notEqual(identity.protocolVersion, RESEARCH_OPERATING_ANALYSIS_LEGACY_PROTOCOL_VERSION);
  assert.throws(() => researchOperatingAnalysisTaskIdentity("300308.SZ", { promptVersion: RESEARCH_OPERATING_ANALYSIS_LEGACY_PROMPT_VERSION }), /cannot use the legacy prompt version/);
});

test("every target stage declares a schema and owner", () => {
  for (const stage of RESEARCH_OPERATING_ANALYSIS_TARGET_STAGES) {
    assert.ok(stage.schemaVersion);
    assert.ok(stage.owner);
    assert.ok(stage.outputKind === "json" || stage.outputKind === "markdown");
    assert.ok(stage.reportHeadings.length > 0);
    assert.deepEqual(getResearchOperatingAnalysisStage(stage.key).key, stage.key);
  }
});

test("S1-S7 expose direct report Markdown artifacts", () => {
  const firstSeven = RESEARCH_OPERATING_ANALYSIS_TARGET_STAGES.slice(2, 9);
  assert.equal(firstSeven.every((stage) => stage.outputKind === "markdown"), true);
  assert.deepEqual(firstSeven.map((stage) => stage.schemaVersion), [
    "company-facts.v3", "industry-structure.v3", "supply-demand-cycle.v3", "competition-peers.v3", "company-operating-drivers.v3", "financial-quality.v3", "market-valuation-facts.v3",
  ]);
});

test("S8 and S11 are direct Markdown while S9/S10 keep JSON contracts", () => {
  assert.equal(getResearchOperatingAnalysisStage("operating_thesis").outputKind, "markdown");
  assert.equal(getResearchOperatingAnalysisStage("scenario_valuation").outputKind, "json");
  assert.equal(getResearchOperatingAnalysisStage("deterministic_valuation").outputKind, "json");
  assert.equal(getResearchOperatingAnalysisStage("investment_conclusion").outputKind, "markdown");
});

test("target terminal statuses and manifest-facing output kinds are explicit", () => {
  assert.deepEqual(terminalResearchOperatingAnalysisStatuses(), ["complete", "partial", "blocked", "not_applicable", "failed"]);
  assert.equal(RESEARCH_OPERATING_ANALYSIS_TARGET_STAGES.some((stage) => stage.outputKind === "json" && stage.execution === "deterministic"), true);
  assert.throws(() => getResearchOperatingAnalysisStage("valuation_inputs"), /unsupported low-dependency/);
});
