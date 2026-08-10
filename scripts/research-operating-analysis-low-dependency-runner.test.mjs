import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLowDependencyStageStartPayload,
  buildLowDependencySourceCandidates,
  buildLowDependencyLineage,
  buildLowDependencyScopeProjection,
  buildLowDependencyStageInput,
  extractLowDependencyManifestLineage,
  LOW_DEPENDENCY_TARGET_STAGE_KEYS,
  lowDependencyInvalidationClosure,
  lowDependencyArtifactByKey,
  lowDependencyTargetWaves,
  parseLowDependencyStageOutput,
  stageArtifact,
  buildFailedStagePersistencePayload,
  sanitizeValidationFailureOutput,
} from "./research-operating-analysis-low-dependency-runner.mjs";
import {
  RESEARCH_OPERATING_ANALYSIS_COMPANY_FACTS_PROMPT,
  RESEARCH_OPERATING_ANALYSIS_COMPANY_OPERATING_DRIVERS_PROMPT,
  RESEARCH_OPERATING_ANALYSIS_COMPETITION_PEERS_PROMPT,
  RESEARCH_OPERATING_ANALYSIS_FINANCIAL_QUALITY_PROMPT,
  RESEARCH_OPERATING_ANALYSIS_INDUSTRY_STRUCTURE_PROMPT,
  RESEARCH_OPERATING_ANALYSIS_MARKET_VALUATION_FACTS_PROMPT,
  RESEARCH_OPERATING_ANALYSIS_SUPPLY_DEMAND_CYCLE_PROMPT,
  RESEARCH_OPERATING_ANALYSIS_SCENARIO_VALUATION_PROMPT,
} from "./generated/prompt-text.mjs";

test("deterministic stage starts omit the optional model prompt", () => {
  const deterministic = buildLowDependencyStageStartPayload({ input: { key: "engineering_baseline" }, prompt: null, lineage: {}, reuse: false, runnerInstanceId: "runner", attempt: 1 });
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
  const normalized = stageArtifact({ stageKey: "engineering_baseline", artifactId: "llm-artifact:s0", status: "complete" });
  assert.equal(normalized.stageKey, "engineering_baseline");
  assert.equal(normalized.stepKey, "engineering_baseline");
});

test("runner dependency lookup reads normalized output from its Map artifact store", () => {
  const baseline = { artifactId: "llm-artifact:s0", output: { schemaVersion: "engineering-baseline.v1", companyScope: {} } };
  assert.deepEqual(lowDependencyArtifactByKey(new Map([["engineering_baseline", baseline]]), "engineering_baseline").output, baseline.output);
  assert.deepEqual(lowDependencyArtifactByKey({ engineering_baseline: baseline }, "engineering_baseline").output, baseline.output);
});

test("S1-S5 input uses only the confirmed local routing projection, never Markdown", () => {
  const context = { contextVersion: "research-context.v1", company: { name: "测试公司" }, security: { securityCode: "000001.SZ" }, financialSnapshot: { schemaVersion: "financial.v1" }, inputFingerprint: "fp" };
  const routingArtifact = { artifactId: "llm-artifact:routing", stepKey: "local_routing_match", status: "complete", output: { routingState: "confirmed", industryTemplateId: "template:1", industryKey: "industry:1", companyScope: { products: ["产品"], downstream: ["客户"] }, sourceIds: ["source:routing"], evidenceIds: ["evidence:routing"] }, sourceIds: ["source:routing"] };
  const companyMarkdownArtifact = { artifactId: "llm-artifact:s1", stepKey: "company_facts", status: "complete", output: "# 公司事实\n\n正文", sourceIds: ["source:s1"], claimIds: ["claim:s1"], evidenceIds: ["evidence:s1"], unknownIds: [] };
  for (const stageKey of ["industry_structure", "supply_demand_cycle", "competition_peers", "company_operating_drivers"]) {
    const input = buildLowDependencyStageInput({ context, financialContext: { descriptor: { schemaVersion: "financial.v1" } }, stageKey, artifactsByKey: { local_routing_match: routingArtifact, company_facts: companyMarkdownArtifact }, scopeEnvelopeAvailable: true });
    assert.deepEqual(input.companyScope.products, ["产品"]);
    assert.equal(input.scopeProjection.status, "available");
    assert.deepEqual(input.scopeProjection.upstreamArtifactIds, ["llm-artifact:routing"]);
    assert.equal("output" in input, false);
    const lineage = buildLowDependencyLineage({ stageKey, artifactsByKey: { local_routing_match: routingArtifact, company_facts: companyMarkdownArtifact }, scopeEnvelopeAvailable: true });
    assert.deepEqual(lineage.upstreamArtifactIds, ["llm-artifact:routing"]);
    assert.deepEqual(lineage.sourceIds, ["source:routing"]);
    assert.deepEqual(lineage.claimIds, []);
  }
});

test("unconfirmed local routing remains an explicit blocker for S1+ input", () => {
  const context = { contextVersion: "research-context.v1", inputFingerprint: "fp" };
  const routingArtifact = { artifactId: "llm-artifact:routing", stepKey: "local_routing_match", status: "blocked", output: { routingState: "unconfirmed", companyScope: {}, mappingReason: { code: "insufficient_evidence", message: "范围未确认" } }, sourceIds: [] };
  const projection = buildLowDependencyScopeProjection({ context, routingArtifact, scopeEnvelopeAvailable: false });
  assert.equal(projection.status, "unknown");
  assert.deepEqual(projection.upstreamArtifactIds, []);
  assert.deepEqual(projection.companyScope.products, []);
  assert.throws(() => buildLowDependencyStageInput({ context, financialContext: { descriptor: { schemaVersion: "financial.v1" } }, stageKey: "industry_structure", artifactsByKey: { local_routing_match: routingArtifact }, scopeEnvelopeAvailable: false }), /confirmed local routing/);
});

test("financial quality input carries the deterministic snapshot gate", () => {
  const contextArtifact = { artifactId: "llm-artifact:baseline", stepKey: "engineering_baseline", status: "complete", output: { contextVersion: "research-context.v1", financialSnapshot: { asOf: "2026-08-09", schemaVersion: "financial.v1", source: "structured_financial" } }, sourceIds: [] };
  const routingArtifact = { artifactId: "llm-artifact:routing", stepKey: "local_routing_match", status: "complete", output: { routingState: "confirmed", industryTemplateId: "template:1", industryKey: "industry:1", companyScope: {}, sourceIds: [], evidenceIds: [] } };
  const financialContext = {
    descriptor: contextArtifact.output.financialSnapshot,
    financialAnalysis: {
      incomeStatement: [{ period: "2026-03-31", currency: "CNY", unit: "reported", source: "structured_financial" }],
      balanceSheet: [{ period: "2026-03-31", currency: "CNY", unit: "reported", source: "structured_financial" }],
      cashFlowStatement: [{ period: "2026-03-31", currency: "CNY", unit: "reported", source: "structured_financial" }],
    },
  };
  const input = buildLowDependencyStageInput({ context: contextArtifact.output, financialContext, stageKey: "financial_quality", artifactsByKey: { local_routing_match: routingArtifact } });
  assert.equal(input.financialQualityGate.status, "available");
});

test("target runner preserves S1-S7 wave shape and keeps Markdown/JSON parsers separate", () => {
  const waves = lowDependencyTargetWaves(true);
  assert.deepEqual(waves[2].map((stage) => stage.key), ["company_facts", "industry_structure", "supply_demand_cycle", "competition_peers", "company_operating_drivers", "financial_quality", "market_valuation_facts"]);
  assert.equal(parseLowDependencyStageOutput("company_facts", "# 公司事实\n\n正文"), "# 公司事实\n\n正文");
  assert.equal(parseLowDependencyStageOutput("scenario_valuation", '{"status":"blocked"}').status, "blocked");
  assert.equal(parseLowDependencyStageOutput("company_facts", "{\"status\":\"complete\"}"), "{\"status\":\"complete\"}");
});

test("targeted rerun invalidates only selected stages and dependency descendants", () => {
  assert.deepEqual(lowDependencyInvalidationClosure(["company_facts"], true), [
    "company_facts", "operating_thesis", "scenario_valuation", "deterministic_valuation", "investment_conclusion", "report_assembly",
  ]);
  assert.deepEqual(lowDependencyInvalidationClosure(["financial_quality"], true), [
    "financial_quality", "scenario_valuation", "deterministic_valuation", "investment_conclusion", "report_assembly",
  ]);
  assert.deepEqual(lowDependencyInvalidationClosure(["company_facts"], false), [
    "company_facts", "operating_thesis", "scenario_valuation", "deterministic_valuation", "investment_conclusion", "report_assembly",
  ]);
  assert.throws(() => lowDependencyInvalidationClosure(["company_baseline"], true), /unsupported low-dependency/);
});

test("the real target runner export covers S0 routing plus S1-S12 without legacy keys", () => {
  assert.deepEqual(LOW_DEPENDENCY_TARGET_STAGE_KEYS, [
    "engineering_baseline", "local_routing_match", "company_facts", "industry_structure", "supply_demand_cycle", "competition_peers", "company_operating_drivers", "financial_quality", "market_valuation_facts",
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
    assert.match(prompt, /Markdown/);
    assert.doesNotMatch(prompt, /输出唯一 JSON 对象/);
  }
  assert.match(RESEARCH_OPERATING_ANALYSIS_FINANCIAL_QUALITY_PROMPT, /不得读取 S1–S5/);
  assert.match(RESEARCH_OPERATING_ANALYSIS_MARKET_VALUATION_FACTS_PROMPT, /Xueqiu/);
});

test("S9 prompt names canonical assumption fields and outer scenario ownership", () => {
  for (const field of ["assumptionId", "variable", "value", "period", "unit"]) assert.match(RESEARCH_OPERATING_ANALYSIS_SCENARIO_VALUATION_PROMPT, new RegExp(`\\b${field}\\b`));
  assert.match(RESEARCH_OPERATING_ANALYSIS_SCENARIO_VALUATION_PROMPT, /scenario.*外层情景对象/);
  assert.match(RESEARCH_OPERATING_ANALYSIS_SCENARIO_VALUATION_PROMPT, /value: null/);
  assert.match(RESEARCH_OPERATING_ANALYSIS_SCENARIO_VALUATION_PROMPT, /不得发明数字、单位或字段别名/);
});

test("failed structured output keeps a redacted parsed payload and error metadata", () => {
  const parsedOutput = { status: "complete", assumptions: [{ variable: "revenueGrowth" }], apiKey: "sk-secret-value", note: "Bearer secret-token" };
  const failure = buildFailedStagePersistencePayload({ stage: { key: "scenario_valuation", label: "S9", outputKind: "json" }, reason: "scenario_valuation base.assumptions[0] missing required fields: value", parsedOutput });
  assert.equal(failure.status, "failed");
  assert.match(failure.errorMessage, /missing required fields/);
  assert.equal(failure.output.status, "failed");
  assert.equal(failure.metadata.validationFailure.parsedOutput.apiKey, "[REDACTED_SECRET]");
  assert.match(failure.metadata.validationFailure.parsedOutput.note, /REDACTED_SECRET/);
  assert.equal(sanitizeValidationFailureOutput({ value: "safe" }).value, "safe");
});
