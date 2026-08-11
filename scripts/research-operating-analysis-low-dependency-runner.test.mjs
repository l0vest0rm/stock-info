import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLowDependencyStageStartPayload,
  buildEngineeringBaseline,
  buildLowDependencySourceCandidates,
  buildLowDependencyLineage,
  buildLowDependencyScopeProjection,
  buildLowDependencyStageInput,
  buildLowDependencyWorkPackageInput,
  buildFinalReportModelPrompt,
  buildFinalReportPrompt,
  extractLowDependencyManifestLineage,
  LOW_DEPENDENCY_TARGET_STAGE_KEYS,
  lowDependencyInvalidationClosure,
  lowDependencyArtifactByKey,
  lowDependencyTargetWaves,
  parseLowDependencyStageOutput,
  stageArtifact,
  buildFailedStagePersistencePayload,
  sanitizeValidationFailureOutput,
  validateFinalReportMarkdown,
  projectFinalReportEvidence,
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
import { matchLocalIndustryTemplate } from "./lib/research-scope-industry-routing.mjs";

test("deterministic stage starts omit the optional model prompt", () => {
  const deterministic = buildLowDependencyStageStartPayload({ input: { key: "engineering_baseline" }, prompt: null, lineage: {}, reuse: false, runnerInstanceId: "runner", attempt: 1 });
  assert.equal(Object.hasOwn(deterministic, "prompt"), false);
  const model = buildLowDependencyStageStartPayload({ input: { key: "company_facts" }, prompt: { instructions: "i", userPrompt: "u" }, lineage: {}, runnerInstanceId: "runner", attempt: 1 });
  assert.deepEqual(model.prompt, { instructions: "i", userPrompt: "u" });
});

test("final report evidence projects only stable WebQA provenance", () => {
  const evidence = projectFinalReportEvidence({
    provider: "chatgpt-web",
    taskId: "llm-task:raw",
    rawArtifactId: "llm-artifact:raw",
    answer: { formatVersion: "webqa.answer.v1", content: { markdown: "# report" }, citations: [{ id: "c1", text: "", title: "", url: "https://example.test/source" }], sources: [{ url: "https://example.test/source" }], rawSnapshot: { status: "completed" } },
    run: { runId: "llm-run:raw", terminalMetadata: { transport: "webqa", provider: "chatgpt-web", gatewayTaskId: "gateway-1", providerUrl: "https://chatgpt.com/c/conversation", providerConversationId: "conversation-1" } },
  });
  assert.deepEqual(evidence, {
    schemaVersion: "research-operating-analysis-webqa-evidence.v1",
    transport: "webqa",
    provider: "chatgpt-web",
    providerUrl: "https://chatgpt.com/c/conversation",
    providerConversationId: "conversation-1",
    gatewayTaskId: "gateway-1",
    rawTaskId: "llm-task:raw",
    rawRunId: "llm-run:raw",
    rawArtifactId: "llm-artifact:raw",
    citationCount: 1,
    sourceCount: 1,
    structuredAnswerAvailable: true,
    citations: [{ text: "", title: "", url: "https://example.test/source" }],
    sources: [{ text: "", title: "", url: "https://example.test/source" }],
  });
  const unavailable = projectFinalReportEvidence({ text: "plain Markdown", run: { runId: "llm-run:plain", terminalMetadata: { providerUrl: "http://not-safe" } } });
  assert.equal(unavailable.providerUrl, null);
  assert.equal(unavailable.structuredAnswerAvailable, null);
  assert.equal(Object.hasOwn(unavailable, "raw"), false);
});

test("final report evidence bounds structured links and rejects unsafe URLs", () => {
  const evidence = projectFinalReportEvidence({
    provider: "chatgpt-web",
    answer: {
      formatVersion: "webqa.answer.v1",
      content: { markdown: "# report" },
      citations: [
        { text: "safe", title: "Safe", url: "https://example.test/safe" },
        { text: "unsafe", title: "Unsafe", url: "http://example.test/nope" },
      ],
      sources: [{ text: "source", title: "Source", url: "https://example.test/source" }],
      rawSnapshot: { status: "completed" },
    },
    run: { runId: "llm-run:raw", terminalMetadata: { providerUrl: "https://chatgpt.com/c/conversation" } },
  });
  assert.equal(evidence.citationCount, 2);
  assert.deepEqual(evidence.citations, [{ text: "safe", title: "Safe", url: "https://example.test/safe" }]);
  assert.deepEqual(evidence.sources, [{ text: "source", title: "Source", url: "https://example.test/source" }]);
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
    overview: { name: "测试公司", source: "xueqiu", marketDate: "2026-08-09", updatedAt: Date.parse("2026-08-09T00:00:00Z"), companyProfile: { taxonomy: "eastmoney-em2016.v1", availability: "available", industry: "信息技术-通信设备-通信传输设备", mainBusiness: "高端光通信收发模块服务云计算数据中心", products: ["光模块"], sourceUrl: "https://datacenter.eastmoney.com/f10?code=300308.SZ", updatedAt: Date.parse("2026-08-09T00:00:00Z") } },
    income: source("income"), balance: source("balance"), cashflow: source("cashflow"),
  });
  assert.equal(candidates.length, 5);
  assert.deepEqual(candidates.map((item) => item.role).sort(), ["market_data", "other", "structured_financial", "structured_financial", "structured_financial"]);
  assert(candidates.every((item) => item.url && item.title && item.publishedAt && item.retrievedAt && item.contentFingerprint && item.availabilityStatus));
  assert(candidates.some((item) => item.url === "/api/finance/income?code=300308.SZ&format=read-model"));
});

test("Eastmoney EM2016 profile deterministically selects the mapped template", () => {
  const profileSource = {
    sourceId: "source:eastmoney-profile", role: "other", title: "东财 F10", url: "https://datacenter.eastmoney.com/f10?code=300308.SZ", publishedAt: "2026-08-11T00:00:00.000Z", contentFingerprint: "profile", quote: "信息技术-通信设备-通信传输设备；高端光通信收发模块服务云计算数据中心",
  };
  const baseline = buildEngineeringBaseline({
    context: { company: { name: "中际旭创" }, security: { securityCode: "300308.SZ" }, companyProfile: { taxonomy: "eastmoney-em2016.v1", industry: "信息技术-通信设备-通信传输设备", industryLevels: ["信息技术", "通信设备", "通信传输设备"], mainBusiness: "高端光通信收发模块服务云计算数据中心", products: ["光模块"], sourceId: profileSource.sourceId }, knownSourceIds: [profileSource.sourceId] },
    sources: [profileSource],
  });
  const routing = matchLocalIndustryTemplate(baseline);
  assert.equal(routing.routingState, "confirmed");
  assert.equal(routing.industryTemplateId, "technology-equipment.v1");
  assert.equal(routing.mappingReason.code, "eastmoney_em2016_exact");
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
  const routingArtifact = { artifactId: "llm-artifact:routing", stepKey: "local_routing_match", status: "complete", output: { routingState: "confirmed", industryTemplateId: "technology-equipment.v1", industryKey: "technology_equipment", companyScope: { products: ["产品"], downstream: ["客户"] }, sourceIds: ["source:routing"], evidenceIds: ["evidence:routing"] }, sourceIds: ["source:routing"] };
  const companyMarkdownArtifact = { artifactId: "llm-artifact:s1", stepKey: "company_facts", status: "complete", output: "# 公司事实\n\n正文", sourceIds: ["source:s1"], claimIds: ["claim:s1"], evidenceIds: ["evidence:s1"], unknownIds: [] };
  for (const stageKey of ["industry_structure", "supply_demand_cycle", "competition_peers", "company_operating_drivers"]) {
    const input = buildLowDependencyStageInput({ context, financialContext: { descriptor: { schemaVersion: "financial.v1" } }, stageKey, artifactsByKey: { local_routing_match: routingArtifact, company_facts: companyMarkdownArtifact }, scopeEnvelopeAvailable: true });
    assert.deepEqual(input.companyScope.products, ["产品"]);
    assert.equal(input.routing.analysisTemplate.templateId, "technology-equipment.v1");
    assert.ok(input.routing.analysisTemplate.operatingMetrics.includes("book-to-bill"));
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
  const routingArtifact = { artifactId: "llm-artifact:routing", stepKey: "local_routing_match", status: "complete", output: { routingState: "confirmed", industryTemplateId: "technology-equipment.v1", industryKey: "technology_equipment", companyScope: {}, sourceIds: [], evidenceIds: [] } };
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

test("final-report prompt sends only live market facts as plain text", () => {
  const routingArtifact = { artifactId: "llm-artifact:routing", status: "complete", output: { routingState: "confirmed", industryTemplateId: "consumer-brand.v1", industryKey: "consumer_brand", companyScope: { products: ["白酒"] } } };
  const input = buildLowDependencyWorkPackageInput({
    packageKey: "final_report",
    baseInput: {
      context: {
        company: { name: "贵州茅台" },
        security: { securityCode: "600519.SH", tradingCurrency: "CNY" },
        marketSnapshot: { asOf: "2026-08-11T10:00:00+08:00", source: "xueqiu", price: 1420.5, marketCapitalization: 17850, reportedMultiples: { peTtm: 21.8, pb: 8.6 } },
        inputFingerprint: "fp",
      },
      financialContext: {
        descriptor: { periods: ["2026-03-31"] },
        financialAnalysis: { incomeStatement: [{ values: { NETPROFIT: 1 } }], balanceSheet: [{ values: { ASSET: 2 } }], cashFlowStatement: [{ values: { NETCASH: 3 } }] },
      },
      sources: [{ title: "不应发送的本地财报来源" }],
    },
    artifactsByKey: new Map([["local_routing_match", routingArtifact]]),
    scopeEnvelopeAvailable: false,
  });
  assert.equal(input.analysisTemplate.templateId, "consumer-brand.v1");
  assert.ok(input.analysisTemplate.operatingMetrics.includes("终端动销"));
  assert.ok(input.analysisTemplate.valuationMethods.includes("PE"));
  assert.ok(input.analysisTemplate.stressFactors.includes("渠道压货"));
  assert.deepEqual(input.marketSnapshot, { asOf: "2026-08-11T10:00:00+08:00", source: "xueqiu", price: 1420.5, tradingCurrency: "CNY", marketCapitalizationYi: 17850, reportedMultiples: { peTtm: 21.8, pb: 8.6 } });
  assert.equal(Object.hasOwn(input, "financialSnapshot"), false);
  assert.equal(Object.hasOwn(input, "financialObservations"), false);
  assert.equal(Object.hasOwn(input, "localSources"), false);
  const prompt = buildFinalReportPrompt("任务\n\n{{INPUT_CONTEXT}}", input);
  assert.match(prompt, /最新价格：1420\.5 CNY/);
  assert.match(prompt, /PE（TTM）：21\.8/);
  assert.doesNotMatch(prompt, /NETPROFIT|不应发送的本地财报来源|<input_data>|\{\s*"/);
  assert.deepEqual(buildFinalReportModelPrompt({ model: "gpt-5.6-luna", input, template: "任务\n\n{{INPUT_CONTEXT}}" }), {
    model: "gpt-5.6-luna",
    instructions: "你是严谨的投资研究员。只使用本阶段允许的证据；不以模型记忆填补缺口；严格按输出格式返回。",
    userPrompt: prompt,
  });
});

test("target runner preserves S1-S7 wave shape and keeps Markdown/JSON parsers separate", () => {
  const waves = lowDependencyTargetWaves(true);
  assert.deepEqual(waves[2].map((stage) => stage.key), ["company_facts", "industry_structure", "supply_demand_cycle", "competition_peers", "company_operating_drivers", "financial_quality", "market_valuation_facts"]);
  assert.equal(parseLowDependencyStageOutput("company_facts", "# 公司事实\n\n正文"), "# 公司事实\n\n正文");
  assert.equal(parseLowDependencyStageOutput("scenario_valuation", '{"status":"blocked"}').status, "blocked");
  assert.equal(parseLowDependencyStageOutput("company_facts", "{\"status\":\"complete\"}"), "{\"status\":\"complete\"}");
});

test("foundation package projects no undeclared upstream artifacts", () => {
  const baseInput = {
    context: { contextVersion: "research-context.v1", inputFingerprint: "fp", company: { name: "测试公司" }, security: { securityCode: "300308.SZ" }, financialSnapshot: { schemaVersion: "financial.v1" } },
    financialContext: { descriptor: { schemaVersion: "financial.v1" }, financialAnalysis: { incomeStatement: [], balanceSheet: [], cashFlowStatement: [] } },
  };
  const artifacts = new Map([
    ["engineering_baseline", { artifactId: "llm-artifact:s0", status: "complete", output: { schemaVersion: "engineering-baseline.v1" } }],
    ["local_routing_match", { artifactId: "llm-artifact:routing", status: "complete", output: { routingState: "confirmed", industryTemplateId: "technology-equipment.v1", industryKey: "technology_equipment", companyScope: {} } }],
    ["company_facts", { artifactId: "llm-artifact:s1", stepKey: "company_facts", status: "complete", output: "# facts" }],
    ["financial_quality", { artifactId: "llm-artifact:s6", stepKey: "financial_quality", status: "complete", output: "# quality" }],
    ["stale_unrelated", { artifactId: "llm-artifact:stale", status: "complete", output: "should not leak" }],
  ]);
  const foundation = buildLowDependencyWorkPackageInput({ packageKey: "foundation", baseInput, artifactsByKey: artifacts });
  assert.deepEqual(Object.keys(foundation.upstreamArtifacts), []);
  assert.deepEqual(Object.keys(foundation.stageInputs).sort(), ["engineering_baseline", "local_routing_match"]);
  assert.equal(foundation.inputFingerprint, "fp");
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

test("final report validator accepts natural Chinese sections without numbered headings", () => {
  const themes = ["研究范围与事实边界", "公司概况与商业模式", "行业与产业链", "竞争地位", "增长与经营驱动", "利润质量与现金转换", "资本效率与治理", "资产负债表与压力测试", "估值与市场隐含要求", "风险与反面证据", "后续跟踪仪表盘", "最终结论"];
  const markdown = themes.map((theme) => `## ${theme}\n结论：报告期间和数据口径、主营业务、产品客户、行业产业链供需、同行竞争地位与竞争优势共同解释增长、销量价格和经营驱动。利润质量、现金流、营运资本、资本效率、资本配置、公司治理、管理层、资产负债表、压力测试、偿债、负债和资产均已核对。估值覆盖悲观基准乐观情景、PE和市场隐含要求；风险、反面证据、失效触发与后续跟踪指标的频率和阈值形成仪表盘，最终结论给出投资逻辑、下一步和观察重点。`).join("\n\n");
  assert.equal(validateFinalReportMarkdown(markdown), markdown);
});

test("final report validator rejects source-link-only output", () => {
  const links = Array.from({ length: 12 }, (_, index) => `[来源${index + 1}](https://example.com/${index + 1})`).join("");
  assert.throws(() => validateFinalReportMarkdown(`# 1${links}`), /source links without human-readable analysis/);
});
