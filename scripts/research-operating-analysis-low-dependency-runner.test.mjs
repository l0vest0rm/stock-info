import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLowDependencyStageStartPayload,
  buildLowDependencySourceCandidates,
  buildLowDependencyLineage,
  buildLowDependencyStageInput,
  extractLowDependencyManifestLineage,
  LOW_DEPENDENCY_TARGET_STAGE_KEYS,
  lowDependencyInvalidationClosure,
  lowDependencyTargetWaves,
  parseLowDependencyStageOutput,
  stageArtifact,
} from "./research-operating-analysis-low-dependency-runner.mjs";
import {
  RESEARCH_OPERATING_ANALYSIS_COMPANY_FACTS_PROMPT,
  RESEARCH_OPERATING_ANALYSIS_COMPANY_OPERATING_DRIVERS_PROMPT,
  RESEARCH_OPERATING_ANALYSIS_COMPETITION_PEERS_PROMPT,
  RESEARCH_OPERATING_ANALYSIS_FINANCIAL_QUALITY_PROMPT,
  RESEARCH_OPERATING_ANALYSIS_INDUSTRY_STRUCTURE_PROMPT,
  RESEARCH_OPERATING_ANALYSIS_MARKET_VALUATION_FACTS_PROMPT,
  RESEARCH_OPERATING_ANALYSIS_SUPPLY_DEMAND_CYCLE_PROMPT,
} from "./generated/prompt-text.mjs";

test("deterministic stage starts omit the optional model prompt", () => {
  const deterministic = buildLowDependencyStageStartPayload({ input: { key: "research_context" }, prompt: null, lineage: {}, reuse: false, runnerInstanceId: "runner", attempt: 1 });
  assert.equal(Object.hasOwn(deterministic, "prompt"), false);
  const model = buildLowDependencyStageStartPayload({ input: { key: "company_facts" }, prompt: { instructions: "i", userPrompt: "u" }, lineage: {}, runnerInstanceId: "runner", attempt: 1 });
  assert.deepEqual(model.prompt, { instructions: "i", userPrompt: "u" });
});

test("low-dependency context registers real market and statement payload provenance", () => {
  const source = (statementType) => ({
    source: "eastmoney",
    dataAsOf: "2026-03-31",
    latestReportDate: "2026-03-31",
    rows: [{ reportDate: "2026-03-31", fiscalPeriod: "一季报", source: "eastmoney", payload: { CURRENCY: "CNY", statementType } }],
    sourceHealth: { status: "healthy" },
    sourcePolicy: { primaryProvider: "eastmoney", statutoryVerifier: "cninfo" },
    delivery: { originProviders: ["eastmoney"], updatedAt: Date.parse("2026-08-09T00:00:00Z"), freshness: "fresh" },
  });
  const candidates = buildLowDependencySourceCandidates({
    code: "300308.SZ",
    overview: { name: "测试公司", source: "xueqiu", marketDate: "2026-08-09", updatedAt: Date.parse("2026-08-09T00:00:00Z") },
    income: source("income"), balance: source("balance"), cashflow: source("cashflow"),
  });
  assert.equal(candidates.length, 4);
  assert.deepEqual(candidates.map((item) => item.role).sort(), ["market_data", "structured_financial", "structured_financial", "structured_financial"]);
  assert(candidates.every((item) => item.url && item.title && item.publishedAt && item.retrievedAt && item.contentFingerprint && item.availabilityStatus));
  assert(candidates.some((item) => item.url === "/api/finance/income?code=300308.SZ&format=read-model"));
});

test("stage artifacts expose the protocol step key to projection helpers", () => {
  const normalized = stageArtifact({ stageKey: "research_context", artifactId: "llm-artifact:s0", status: "complete" });
  assert.equal(normalized.stageKey, "research_context");
  assert.equal(normalized.stepKey, "research_context");
});

test("low-dependency runner input uses S0 and fallback companyScope projections", () => {
  const contextArtifact = { artifactId: "llm-artifact:s0", stepKey: "research_context", status: "complete", output: { contextVersion: "research-context.v1", scopeEnvelope: null }, sourceIds: ["source:s0"] };
  const companyArtifact = { artifactId: "llm-artifact:s1", stepKey: "company_facts", status: "complete", output: { companyScope: { products: ["产品"], customers: ["客户"], regions: ["中国"], uses: ["用途"], segments: [], uncertainBoundaries: [] }, analysisGaps: [] }, sourceIds: ["source:s1"], claimIds: ["claim:s1"], evidenceIds: ["evidence:s1"], unknownIds: [] };
  const input = buildLowDependencyStageInput({ context: contextArtifact.output, financialContext: { descriptor: { schemaVersion: "financial.v1" } }, stageKey: "industry_structure", artifactsByKey: { research_context: contextArtifact, company_facts: companyArtifact }, scopeEnvelopeAvailable: false });
  assert.deepEqual(input.companyScope.products, ["产品"]);
  assert.equal("output" in input, false);
  const lineage = buildLowDependencyLineage({ stageKey: "industry_structure", artifactsByKey: { company_facts: companyArtifact }, scopeEnvelopeAvailable: false });
  assert.deepEqual(lineage.upstreamArtifactIds, ["llm-artifact:s1"]);
  assert.deepEqual(lineage.claimIds, ["claim:s1"]);
});

test("financial quality input carries the deterministic snapshot gate", () => {
  const contextArtifact = { artifactId: "llm-artifact:s0", stepKey: "research_context", status: "complete", output: { contextVersion: "research-context.v1", scopeEnvelope: null, financialSnapshot: { asOf: "2026-08-09", schemaVersion: "financial.v1", source: "structured_financial" } }, sourceIds: [] };
  const financialContext = {
    descriptor: contextArtifact.output.financialSnapshot,
    financialAnalysis: {
      incomeStatement: [{ period: "2026-03-31", currency: "CNY", unit: "reported", source: "structured_financial" }],
      balanceSheet: [{ period: "2026-03-31", currency: "CNY", unit: "reported", source: "structured_financial" }],
      cashFlowStatement: [{ period: "2026-03-31", currency: "CNY", unit: "reported", source: "structured_financial" }],
    },
  };
  const input = buildLowDependencyStageInput({ context: contextArtifact.output, financialContext, stageKey: "financial_quality", artifactsByKey: { research_context: contextArtifact } });
  assert.equal(input.financialQualityGate.status, "available");
});

test("target runner preserves S1-S7 wave shape and parses declared output kinds", () => {
  const waves = lowDependencyTargetWaves(true);
  assert.deepEqual(waves[1].map((stage) => stage.key), ["company_facts", "industry_structure", "supply_demand_cycle", "competition_peers", "company_operating_drivers", "financial_quality", "market_valuation_facts"]);
  assert.equal(parseLowDependencyStageOutput("company_facts", '{"status":"complete"}').status, "complete");
  assert.equal(parseLowDependencyStageOutput("financial_quality", '{"status":"blocked"}').status, "blocked");
});

test("targeted rerun invalidates only selected stages and dependency descendants", () => {
  assert.deepEqual(lowDependencyInvalidationClosure(["company_facts"], true), [
    "company_facts", "operating_thesis", "scenario_valuation", "deterministic_valuation", "investment_conclusion", "report_assembly",
  ]);
  assert.deepEqual(lowDependencyInvalidationClosure(["financial_quality"], true), [
    "financial_quality", "scenario_valuation", "deterministic_valuation", "investment_conclusion", "report_assembly",
  ]);
  assert.deepEqual(lowDependencyInvalidationClosure(["company_facts"], false), [
    "company_facts", "industry_structure", "supply_demand_cycle", "competition_peers", "company_operating_drivers", "operating_thesis", "scenario_valuation", "deterministic_valuation", "investment_conclusion", "report_assembly",
  ]);
  assert.throws(() => lowDependencyInvalidationClosure(["company_baseline"], true), /unsupported low-dependency/);
});

test("the real target runner export covers exactly S0-S12 without legacy keys", () => {
  assert.deepEqual(LOW_DEPENDENCY_TARGET_STAGE_KEYS, [
    "research_context", "company_facts", "industry_structure", "supply_demand_cycle", "competition_peers", "company_operating_drivers", "financial_quality", "market_valuation_facts",
    "operating_thesis", "scenario_valuation", "deterministic_valuation", "investment_conclusion", "report_assembly",
  ]);
  assert(!LOW_DEPENDENCY_TARGET_STAGE_KEYS.includes("company_baseline"));
  assert(!LOW_DEPENDENCY_TARGET_STAGE_KEYS.includes("valuation_inputs"));
});

test("stage output manifest IDs become terminal artifact lineage without positional references", () => {
  const lineage = extractLowDependencyManifestLineage({ sourceIds: ["source:b", "source:a", "2"], claimIds: ["claim:a"], evidenceIds: ["evidence:a"], unknowns: [{ unknownId: "unknown:a" }], usedUpstreamArtifactIds: ["llm-artifact:s0"] }, { unknownIds: ["unknown:prior"] });
  assert.deepEqual(lineage.sourceIds, ["source:a", "source:b"]);
  assert.deepEqual(lineage.upstreamArtifactIds, ["llm-artifact:s0"]);
  assert.deepEqual(lineage.unknownIds, ["unknown:prior", "unknown:a"]);
});

test("P3-P4 prompts declare manifest IDs, unknowns and their forbidden ownership", () => {
  for (const prompt of [RESEARCH_OPERATING_ANALYSIS_COMPANY_FACTS_PROMPT, RESEARCH_OPERATING_ANALYSIS_INDUSTRY_STRUCTURE_PROMPT, RESEARCH_OPERATING_ANALYSIS_SUPPLY_DEMAND_CYCLE_PROMPT, RESEARCH_OPERATING_ANALYSIS_COMPETITION_PEERS_PROMPT, RESEARCH_OPERATING_ANALYSIS_COMPANY_OPERATING_DRIVERS_PROMPT, RESEARCH_OPERATING_ANALYSIS_FINANCIAL_QUALITY_PROMPT, RESEARCH_OPERATING_ANALYSIS_MARKET_VALUATION_FACTS_PROMPT]) {
    assert.match(prompt, /unknown/);
    assert.match(prompt, /sourceIds/);
    assert.match(prompt, /evidenceIds/);
    assert.match(prompt, /usedUpstreamArtifactIds/);
    assert.match(prompt, /"markdown"/);
  }
  assert.match(RESEARCH_OPERATING_ANALYSIS_FINANCIAL_QUALITY_PROMPT, /不得读取 S1–S5/);
  assert.match(RESEARCH_OPERATING_ANALYSIS_MARKET_VALUATION_FACTS_PROMPT, /Xueqiu/);
});
