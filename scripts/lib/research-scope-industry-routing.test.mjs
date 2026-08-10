import assert from "node:assert/strict";
import test from "node:test";
import {
  RESEARCH_INDUSTRY_TEMPLATE_REGISTRY,
  applyManualRoutingConfirmation,
  matchLocalIndustryTemplate,
  normalizeEngineeringBaseline,
  normalizeRoutingFacts,
} from "./research-scope-industry-routing.mjs";
import { getResearchOperatingAnalysisStage } from "./research-operating-analysis-stage-registry.mjs";
import { lowDependencyPromptForStage } from "../research-operating-analysis-low-dependency-runner.mjs";

const reference = (id, quote = "原文明确披露主营、产品、下游和行业边界") => ({ sourceId: id, url: `https://example.test/${id}`, title: "公开原文", publishedAt: "2026-08-01", quote, locator: "正文" });
const baseline = (overrides = {}) => normalizeEngineeringBaseline({
  company: { name: "测试公司" }, security: { securityCode: "300308.SZ" }, sourceIds: ["source:1"],
  companyScope: {
    facts: [
      { factId: "fact:business", field: "primary_business", statement: "公司主营高速光模块和光通信产品", sourceReferences: [reference("source:business")] },
      { factId: "fact:product", field: "product_boundary", statement: "产品覆盖400G、800G和1.6T光模块", sourceReferences: [reference("source:product")] },
      { factId: "fact:downstream", field: "downstream", statement: "下游为AI数据中心、云计算和GPU集群", sourceReferences: [reference("source:downstream")] },
      { factId: "fact:industry", field: "industry", statement: "所属行业为AI光模块与光互连", sourceReferences: [reference("source:industry")] },
    ],
    primaryBusiness: "高速光模块和光通信产品", products: ["400G", "800G", "1.6T 光模块"], downstream: ["AI数据中心", "云计算"], industry: "AI光模块与光互连",
  },
  ...overrides,
});

test("S0.1/S0.2 are deterministic and have no model/Web Search prompt", () => {
  assert.equal(getResearchOperatingAnalysisStage("engineering_baseline").execution, "deterministic");
  assert.equal(getResearchOperatingAnalysisStage("engineering_baseline").webSearch, false);
  assert.equal(getResearchOperatingAnalysisStage("local_routing_match").execution, "deterministic");
  assert.equal(getResearchOperatingAnalysisStage("local_routing_match").webSearch, false);
  assert.equal(lowDependencyPromptForStage("engineering_baseline"), null);
  assert.equal(lowDependencyPromptForStage("local_routing_match"), null);
});

test("local rules produce one confirmed template from sufficient explicit evidence", () => {
  const result = matchLocalIndustryTemplate(baseline());
  assert.equal(result.routingState, "confirmed");
  assert.equal(result.industryTemplateId, RESEARCH_INDUSTRY_TEMPLATE_REGISTRY[0].templateId);
  assert.equal(result.mappingReason.code, "unique_match");
  assert.equal(result.evidence.length, 4);
});

test("zero match remains unconfirmed even when evidence is complete", () => {
  const result = matchLocalIndustryTemplate(baseline({ companyScope: { facts: [
    { field: "primary_business", statement: "工业软件", sourceReferences: [reference("source:a")] },
    { field: "product_boundary", statement: "制造执行系统", sourceReferences: [reference("source:b")] },
    { field: "downstream", statement: "工厂客户", sourceReferences: [reference("source:c")] },
    { field: "industry", statement: "工业软件行业", sourceReferences: [reference("source:d")] },
  ] } }));
  assert.equal(result.routingState, "unconfirmed");
  assert.equal(result.mappingReason.code, "zero_match");
  assert.equal(result.industryTemplateId, null);
});

test("multiple valid matches remain unconfirmed", () => {
  const second = { ...RESEARCH_INDUSTRY_TEMPLATE_REGISTRY[0], templateId: "optical-transceiver-ai-interconnect.alt.v1", industryKey: "optical_transceiver_ai_interconnect_alt" };
  const result = matchLocalIndustryTemplate(baseline(), { templates: [...RESEARCH_INDUSTRY_TEMPLATE_REGISTRY, second] });
  assert.equal(result.routingState, "unconfirmed");
  assert.equal(result.mappingReason.code, "ambiguous_match");
  assert.equal(result.matchedTemplates.length, 2);
});

test("missing evidence blocks matching instead of trusting unverified strings", () => {
  const result = matchLocalIndustryTemplate(baseline({ companyScope: { facts: [
    { field: "primary_business", statement: "公司主营高速光模块" },
    { field: "product_boundary", statement: "产品覆盖800G光模块" },
    { field: "downstream", statement: "下游为AI数据中心" },
    { field: "industry", statement: "所属行业为光互连" },
  ] } }));
  assert.equal(result.routingState, "unconfirmed");
  assert.equal(result.mappingReason.code, "insufficient_evidence");
});

test("manual confirmation is registry-bound and produces a confirmed projection", () => {
  const automatic = matchLocalIndustryTemplate(baseline({ companyScope: { facts: [] } }));
  const confirmed = applyManualRoutingConfirmation(automatic, { selectedTemplateId: RESEARCH_INDUSTRY_TEMPLATE_REGISTRY[0].templateId, scopeNote: "人工确认主营高速光模块，服务 AI 数据中心。", confirmationId: "routing-confirmation:1" });
  assert.equal(confirmed.routingState, "confirmed");
  assert.equal(confirmed.routingBasis, "manual_confirmation");
  assert.throws(() => applyManualRoutingConfirmation(automatic, { selectedTemplateId: "not-registered" }), /not registered/);
});

test("raw routing facts reject model template selection", () => {
  assert.throws(() => normalizeRoutingFacts({ industryTemplateId: "model-picked" }), /must not contain/);
});
