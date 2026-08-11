import assert from "node:assert/strict";
import test from "node:test";
import {
  RESEARCH_ANALYSIS_PRESENTATION_CATEGORIES,
  RESEARCH_INDUSTRY_TEMPLATE_REGISTRY,
  applyManualRoutingConfirmation,
  evaluateLocalTemplateCandidates,
  matchLocalIndustryTemplate,
  normalizeEngineeringBaseline,
  normalizeRoutingFacts,
  resolveEastmoneyIndustryProfile,
} from "./research-scope-industry-routing.mjs";
import eastmoneyMappings from "../../config/research-eastmoney-em2016-template-mappings.json" with { type: "json" };
import eastmoneyTop300 from "../../config/research-eastmoney-em2016-top300.json" with { type: "json" };
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
      { factId: "fact:industry", field: "industry", statement: "信息技术-通信设备-通信传输设备", sourceReferences: [reference("source:industry")] },
    ],
    primaryBusiness: "高速光模块和光通信产品", products: ["400G", "800G", "1.6T 光模块"], downstream: ["AI数据中心", "云计算"], industry: "信息技术-通信设备-通信传输设备", industryTaxonomy: "eastmoney-em2016.v1", industryLevels: ["信息技术", "通信设备", "通信传输设备"],
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
  assert.equal(result.industryTemplateId, "technology-equipment.v1");
  assert.equal(result.mappingReason.code, "eastmoney_em2016_exact");
  assert.equal(result.evidence.length, 1);
  assert.equal(result.analysisTemplate.primaryFormula, "收入 = 客户资本开支 × 设备份额 × 交付率");
  assert.ok(result.analysisTemplate.operatingMetrics.includes("运营商/云厂商资本开支"));
});

test("registry contains business-economics profiles behind exact Eastmoney EM2016 industry routes", () => {
  assert.equal(RESEARCH_INDUSTRY_TEMPLATE_REGISTRY.length, 24);
  assert.deepEqual(new Set(RESEARCH_INDUSTRY_TEMPLATE_REGISTRY.map((template) => template.industryKey)).size, 24);
  assert.ok(RESEARCH_INDUSTRY_TEMPLATE_REGISTRY.some((template) => template.templateId === "consumer-brand.v1"));
  assert.ok(RESEARCH_INDUSTRY_TEMPLATE_REGISTRY.some((template) => template.templateId === "bank.v1"));
  assert.ok(RESEARCH_INDUSTRY_TEMPLATE_REGISTRY.some((template) => template.templateId === "preprofit-biotech.v1"));
  for (const template of RESEARCH_INDUSTRY_TEMPLATE_REGISTRY) {
    assert.ok(template.primaryFormula);
    assert.ok(template.operatingMetrics.length > 0);
    assert.ok(template.valuationMethods.length > 0);
    assert.ok(template.stressFactors.length > 0);
  }
});

test("presentation collapses leaf profiles into eight user-facing research categories", () => {
  assert.equal(RESEARCH_ANALYSIS_PRESENTATION_CATEGORIES.length, 8);
  const candidates = evaluateLocalTemplateCandidates(baseline());
  assert.equal(candidates.length, 24);
  assert.deepEqual(new Set(candidates.map((candidate) => candidate.presentationCategoryId)).size, 8);
  assert.ok(candidates.every((candidate) => candidate.presentationCategoryLabel && candidate.operatingFeatureLabel));
  const result = matchLocalIndustryTemplate(baseline());
  assert.equal(result.analysisTemplate.presentationCategoryLabel, "制造与资本品");
  assert.equal(result.analysisTemplate.operatingFeatureLabel, "订单、认证与交付");
  assert.equal(result.candidateTemplates.find((candidate) => candidate.templateId === "technology-equipment.v1")?.presentationCategoryId, "manufacturing-capital");
});

test("missing Eastmoney EM2016 remains unconfirmed even when other facts are complete", () => {
  const result = matchLocalIndustryTemplate(baseline({ companyScope: { facts: [
    { field: "primary_business", statement: "工业软件", sourceReferences: [reference("source:a")] },
    { field: "product_boundary", statement: "制造执行系统", sourceReferences: [reference("source:b")] },
    { field: "downstream", statement: "工厂客户", sourceReferences: [reference("source:c")] },
    { field: "industry", statement: "工业软件行业", sourceReferences: [reference("source:d")] },
  ] } }));
  assert.equal(result.routingState, "unconfirmed");
  assert.equal(result.mappingReason.code, "eastmoney_em2016_unavailable");
  assert.equal(result.industryTemplateId, null);
});

test("consumer-brand profile covers baijiu without matching technology equipment", () => {
  const result = matchLocalIndustryTemplate(baseline({ company: { name: "贵州茅台" }, security: { securityCode: "600519.SH" }, companyScope: { facts: [
    { field: "primary_business", statement: "公司主营白酒生产与销售", sourceReferences: [reference("source:baijiu-business")] },
    { field: "product_boundary", statement: "产品为贵州茅台酒等白酒", sourceReferences: [reference("source:baijiu-product")] },
    { field: "downstream", statement: "通过经销商、商超和零售终端服务消费者", sourceReferences: [reference("source:baijiu-downstream")] },
    { field: "industry", statement: "食品饮料-饮料-白酒", sourceReferences: [reference("source:baijiu-industry")] },
  ], industry: "食品饮料-饮料-白酒", industryTaxonomy: "eastmoney-em2016.v1", industryLevels: ["食品饮料", "饮料", "白酒"] } }));
  assert.equal(result.routingState, "confirmed");
  assert.equal(result.industryTemplateId, "consumer-brand.v1");
  assert.equal(result.matchedTemplates.length, 1);
  assert.ok(result.analysisTemplate.operatingMetrics.includes("终端动销"));
  assert.ok(result.analysisTemplate.stressFactors.includes("渠道压货"));
});

test("an unprofiled Eastmoney EM2016 leaf remains unconfirmed for a detailed template", () => {
  const result = matchLocalIndustryTemplate(baseline({ companyScope: { facts: [
    { field: "industry", statement: "信息技术-通信设备-未来新增设备", sourceReferences: [reference("source:industry")] },
  ], industry: "信息技术-通信设备-未来新增设备", industryTaxonomy: "eastmoney-em2016.v1" } }));
  assert.equal(result.routingState, "unconfirmed");
  assert.equal(result.industryTemplateId, null);
  assert.equal(result.mappingReason.code, "eastmoney_em2016_profile_unmapped");
});

test("an Eastmoney EM2016 taxonomy outside controlled rules remains unconfirmed", () => {
  const result = matchLocalIndustryTemplate(baseline({ companyScope: { facts: [
    { field: "industry", statement: "未来行业-未来设备-未来零件", sourceReferences: [reference("source:industry")] },
  ], industry: "未来行业-未来设备-未来零件", industryTaxonomy: "eastmoney-em2016.v1" } }));
  assert.equal(result.routingState, "unconfirmed");
  assert.equal(result.mappingReason.code, "eastmoney_em2016_unmapped");
});

test("unverified Eastmoney industry does not select a template", () => {
  const result = matchLocalIndustryTemplate(baseline({ companyScope: { facts: [
    { field: "primary_business", statement: "公司主营高速光模块" },
    { field: "product_boundary", statement: "产品覆盖800G光模块" },
    { field: "downstream", statement: "下游为AI数据中心" },
    { field: "industry", statement: "信息技术-通信设备-通信传输设备" },
  ], industry: "信息技术-通信设备-通信传输设备", industryTaxonomy: "eastmoney-em2016.v1" } }));
  assert.equal(result.routingState, "unconfirmed");
  assert.equal(result.mappingReason.code, "eastmoney_em2016_unavailable");
});

test("all Top300 Eastmoney EM2016 leaves map to registered templates", () => {
  assert.equal(eastmoneyMappings.mappings.length, eastmoneyTop300.industries.length);
  assert.equal(eastmoneyTop300.coverage.available, eastmoneyTop300.coverage.total);
  for (const mapping of eastmoneyMappings.mappings) {
    assert.ok(RESEARCH_INDUSTRY_TEMPLATE_REGISTRY.some((template) => template.templateId === mapping.templateId), mapping.em2016);
    assert.ok(resolveEastmoneyIndustryProfile(mapping.em2016), `missing detailed industry profile: ${mapping.em2016}`);
  }
});

test("Eastmoney EM2016 routing injects its detailed industry profile into the prompt template", () => {
  const result = matchLocalIndustryTemplate(baseline());
  assert.equal(result.analysisTemplate.industryProfileId, "telecom-equipment.v1");
  assert.equal(result.analysisTemplate.industryProfileLabel, "通信设备");
  assert.ok(result.analysisTemplate.operatingMetrics.includes("运营商/云厂商资本开支"));
});

test("manual confirmation is registry-bound and produces a confirmed projection", () => {
  const automatic = matchLocalIndustryTemplate(baseline({ companyScope: { facts: [] } }));
  const confirmed = applyManualRoutingConfirmation(automatic, { selectedTemplateId: "technology-equipment.v1", scopeNote: "人工确认主营高速光模块，服务 AI 数据中心。", confirmationId: "routing-confirmation:1" });
  assert.equal(confirmed.routingState, "confirmed");
  assert.equal(confirmed.routingBasis, "manual_confirmation");
  assert.equal(confirmed.analysisTemplate.templateId, "technology-equipment.v1");
  assert.throws(() => applyManualRoutingConfirmation(automatic, { selectedTemplateId: "not-registered" }), /not registered/);
});

test("legacy optical template id resolves to the broader technology-equipment profile", () => {
  const automatic = matchLocalIndustryTemplate(baseline({ companyScope: { facts: [] } }));
  const confirmed = applyManualRoutingConfirmation(automatic, { selectedTemplateId: "optical-transceiver-ai-interconnect.v1" });
  assert.equal(confirmed.industryTemplateId, "technology-equipment.v1");
});

test("raw routing facts reject model template selection", () => {
  assert.throws(() => normalizeRoutingFacts({ industryTemplateId: "model-picked" }), /must not contain/);
});
