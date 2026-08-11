import registry from "../../config/research-analysis-template-registry.json" with { type: "json" };
import eastmoneyMappings from "../../config/research-eastmoney-em2016-template-mappings.json" with { type: "json" };
import eastmoneyRules from "../../config/research-eastmoney-em2016-template-rules.json" with { type: "json" };
import eastmoneyIndustryProfiles from "../../config/research-eastmoney-em2016-industry-profiles.json" with { type: "json" };

export const RESEARCH_ANALYSIS_TEMPLATE_REGISTRY_VERSION = registry.registryVersion;
export const RESEARCH_ANALYSIS_TEMPLATE_REGISTRY = Object.freeze(registry.templates.map((template) => Object.freeze({
  ...template,
  requiredFields: Object.freeze([...template.requiredFields]),
  terms: Object.freeze(Object.fromEntries(Object.entries(template.terms).map(([field, terms]) => [field, Object.freeze([...terms])]))),
  operatingMetrics: Object.freeze([...template.operatingMetrics]),
  valuationMethods: Object.freeze([...template.valuationMethods]),
  stressFactors: Object.freeze([...template.stressFactors]),
  evidencePolicy: Object.freeze({ ...template.evidencePolicy }),
})));
export const RESEARCH_ANALYSIS_TEMPLATE_ALIASES = Object.freeze({ ...(registry.templateAliases || {}) });
const presentationByTemplateId = Object.freeze({ ...(registry.templatePresentation || {}) });
export const RESEARCH_ANALYSIS_PRESENTATION_CATEGORIES = Object.freeze((registry.presentationCategories || []).map((category) => Object.freeze({
  id: text(category?.id),
  label: text(category?.label),
})).filter((category) => category.id && category.label));
const presentationCategoryById = new Map(RESEARCH_ANALYSIS_PRESENTATION_CATEGORIES.map((category) => [category.id, category]));
const eastmoneyTemplateByIndustry = new Map((eastmoneyMappings.mappings || []).map((mapping) => [text(mapping?.em2016), text(mapping?.templateId)]).filter(([industry, templateId]) => industry && templateId));
const eastmoneyIndustryProfileEntries = (eastmoneyIndustryProfiles.profiles || []).flatMap((profile) => stringArray(profile?.industries).map((industry) => [industry, Object.freeze({
  profileId: text(profile?.profileId), label: text(profile?.label), businessModel: text(profile?.businessModel), primaryFormula: text(profile?.primaryFormula), operatingMetrics: stringArray(profile?.operatingMetrics), valuationMethods: stringArray(profile?.valuationMethods), stressFactors: stringArray(profile?.stressFactors),
})])).filter(([industry, profile]) => industry && profile.profileId && profile.label);
if (new Set(eastmoneyIndustryProfileEntries.map(([industry]) => industry)).size !== eastmoneyIndustryProfileEntries.length) throw new Error("Eastmoney EM2016 industry profile configuration contains duplicate industries");
const eastmoneyIndustryProfileByIndustry = new Map(eastmoneyIndustryProfileEntries);
// Compatibility exports for callers that still use the pre-v3 symbol names.
export const RESEARCH_INDUSTRY_TEMPLATE_REGISTRY_VERSION = RESEARCH_ANALYSIS_TEMPLATE_REGISTRY_VERSION;
export const RESEARCH_INDUSTRY_TEMPLATE_REGISTRY = RESEARCH_ANALYSIS_TEMPLATE_REGISTRY;

const ROUTING_FIELDS = Object.freeze(["primary_business", "product_boundary", "downstream", "industry"]);
const FIELD_ALIASES = Object.freeze({
  primary_business: "primary_business",
  primaryBusiness: "primary_business",
  companyScope: "primary_business",
  product_boundary: "product_boundary",
  productBoundary: "product_boundary",
  products: "product_boundary",
  downstream: "downstream",
  customerOrApplication: "downstream",
  industry: "industry",
  industryName: "industry",
});

export function normalizeEngineeringBaseline(value, { inputFingerprint = null } = {}) {
  const source = object(value);
  const company = object(source.company);
  const security = object(source.security);
  const materials = Array.isArray(source.materials) ? source.materials.map(normalizeMaterial).filter(Boolean) : [];
  const companyScope = normalizeCompanyScope(source.companyScope || source.scope || {});
  const candidates = Array.isArray(source.candidateTemplates) ? source.candidateTemplates.map(normalizeCandidate).filter(Boolean) : [];
  return {
    schemaVersion: "engineering-baseline.v1",
    status: text(source.status) || "complete",
    company: { name: text(company.name) || null, entityType: text(company.entityType) || null },
    security: { securityCode: text(security.securityCode) || null, listingVenue: text(security.listingVenue) || null, tradingCurrency: text(security.tradingCurrency) || null },
    companyScope,
    materials,
    sourceIds: uniqueStrings(source.sourceIds || materials.map((item) => item.sourceId)),
    candidateTemplates: candidates,
    unknowns: normalizeUnknowns(source.unknowns),
    analysisGaps: normalizeUnknowns(source.analysisGaps),
    inputFingerprint: text(source.inputFingerprint) || inputFingerprint || null,
  };
}

/**
 * Evaluate only locally controlled rules. The S1 facts remain the only basis;
 * this function never fetches, searches, or asks a model to choose a template.
 */
export function matchLocalIndustryTemplate(baseline, { templates = RESEARCH_ANALYSIS_TEMPLATE_REGISTRY, upstreamArtifactIds = [] } = {}) {
  const normalized = normalizeEngineeringBaseline(baseline);
  const fields = fieldsFromBaseline(normalized);
  const evidenceByField = Object.fromEntries(ROUTING_FIELDS.map((field) => [field, fields[field].filter((item) => hasEvidence(item))]));
  const candidates = evaluateLocalTemplateCandidates(normalized, { templates });
  const industry = text(normalized.companyScope.industry);
  const eastmoneyTaxonomy = text(normalized.companyScope.industryTaxonomy);
  const exactTemplateId = eastmoneyTaxonomy === "eastmoney-em2016.v1" ? text(eastmoneyTemplateByIndustry.get(industry)) : "";
  const matchingRule = !exactTemplateId && eastmoneyTaxonomy === "eastmoney-em2016.v1" ? findEastmoneyTemplateRule(normalized.companyScope.industryLevels.length ? normalized.companyScope.industryLevels : industry.split("-")) : null;
  const templateId = exactTemplateId || text(matchingRule?.templateId);
  const industryProfile = eastmoneyTaxonomy === "eastmoney-em2016.v1" ? resolveEastmoneyIndustryProfile(industry) : null;
  const industryEvidence = evidenceByField.industry.filter((item) => item.statement === industry);
  const mappedTemplate = templateId ? resolveAnalysisTemplate(templateId, { templates }) : null;
  if (templateId && !mappedTemplate) throw new Error(`Eastmoney EM2016 mapping targets an unregistered template: ${templateId}`);
  const selectedTemplate = mappedTemplate && industryProfile && industryEvidence.length ? mappedTemplate : null;
  const routingReason = selectedTemplate
    ? null
    : eastmoneyTaxonomy !== "eastmoney-em2016.v1" || !industry || !industryEvidence.length
      ? { code: "eastmoney_em2016_unavailable", message: "未取得带可审计来源的东方财富 EM2016 行业，需人工选择并确认模板。", fields: ["industry"] }
      : !mappedTemplate
        ? { code: "eastmoney_em2016_unmapped", message: `东方财富 EM2016 行业“${industry}”不在受控模板规则覆盖内，需人工选择并确认。`, fields: ["industry"] }
        : { code: "eastmoney_em2016_profile_unmapped", message: `东方财富 EM2016 行业“${industry}”已有通用框架，但尚未配置细分行业研究模板；需人工选择并确认，同时补充该行业模板。`, fields: ["industry"] };
  const selected = selectedTemplate ? { templateId: selectedTemplate.templateId, matchedFields: ["industry"], score: 1, reason: `东方财富 EM2016 细分行业模板：${industryProfile.label}` } : null;
  const sourceIds = uniqueStrings([...normalized.sourceIds, ...industryEvidence.flatMap((item) => item.sourceIds)]);
  const evidenceIds = uniqueStrings(industryEvidence.map((item) => item.factId));
  return {
    schemaVersion: "local-routing-match.v3",
    state: selected ? "confirmed" : "unconfirmed",
    routingState: selected ? "confirmed" : "unconfirmed",
    industryTemplateId: selectedTemplate?.templateId || null,
    industryKey: selectedTemplate?.industryKey || null,
    industryLabel: selectedTemplate?.label || null,
    analysisTemplate: selectedTemplate ? analysisTemplateProjection(selectedTemplate, industryProfile) : null,
    companyScope: normalized.companyScope,
    candidateTemplates: candidates,
    matchedTemplates: selected ? [selected] : [],
    mappingReason: routingReason || { code: exactTemplateId ? "eastmoney_em2016_exact" : "eastmoney_em2016_rule", message: exactTemplateId ? `东方财富 EM2016 行业“${industry}”采用细分模板“${industryProfile.label}”` : `东方财富 EM2016 行业“${industry}”按受控规则并采用细分模板“${industryProfile.label}”`, fields: selected.matchedFields },
    evidence: industryEvidence.map((item) => ({ factId: item.factId, field: item.field, statement: item.statement, sourceIds: item.sourceIds, sourceReferences: item.sourceReferences })),
    sourceIds,
    evidenceIds,
    unknowns: [...normalized.unknowns, ...(routingReason ? [{ unknownId: `routing:${routingReason.code}`, code: routingReason.code, message: routingReason.message, blocking: true }] : [])],
    usedUpstreamArtifactIds: uniqueStrings(upstreamArtifactIds),
    inputFingerprint: normalized.inputFingerprint,
  };
}

/** S0.1 exposes explainable candidates without declaring a route. */
export function evaluateLocalTemplateCandidates(baseline, { templates = RESEARCH_ANALYSIS_TEMPLATE_REGISTRY } = {}) {
  const normalized = normalizeEngineeringBaseline(baseline);
  const fields = fieldsFromBaseline(normalized);
  return Array.isArray(templates) ? templates.filter(validTemplate).map((template) => {
    const matchedFields = ROUTING_FIELDS.filter((field) => fieldMatchesTemplate(field, fields[field], template));
    const presentation = templatePresentation(template);
    return { templateId: text(template.templateId), industryKey: text(template.industryKey), label: text(template.label), frameworkCategory: text(template.frameworkCategory), presentationCategoryId: presentation.categoryId, presentationCategoryLabel: presentation.categoryLabel, operatingFeatureLabel: presentation.featureLabel, matchedFields, score: matchedFields.length, reason: matchedFields.length ? `命中字段：${matchedFields.join("、")}` : "没有命中受控事实谓词" };
  }) : [];
}

export function confirmedRoutingProjection(artifact) {
  const source = object(artifact?.output || artifact);
  if (text(source.routingState) !== "confirmed" || !text(source.industryTemplateId) || !text(source.industryKey)) {
    throw new Error("S3+ requires a confirmed local routing projection");
  }
  const template = resolveAnalysisTemplate(source.industryTemplateId);
  if (!template) throw new Error(`confirmed routing template is not registered: ${text(source.industryTemplateId)}`);
  const companyScope = normalizeCompanyScope(source.companyScope);
  const industryProfile = companyScope.industryTaxonomy === "eastmoney-em2016.v1" ? resolveEastmoneyIndustryProfile(companyScope.industry) : null;
  return {
    routingState: "confirmed",
    industryTemplateId: template.templateId,
    industryKey: template.industryKey,
    industryLabel: template.label,
    analysisTemplate: analysisTemplateProjection(template, industryProfile),
    companyScope,
    sourceIds: uniqueStrings(source.sourceIds),
    evidenceIds: uniqueStrings(source.evidenceIds),
    upstreamArtifactIds: uniqueStrings([artifact?.artifactId, ...(source.usedUpstreamArtifactIds || [])]),
  };
}

export function resolveEastmoneyIndustryProfile(industry) {
  return eastmoneyIndustryProfileByIndustry.get(text(industry)) || null;
}

export function applyManualRoutingConfirmation(matchResult, confirmation) {
  const source = object(confirmation);
  const templateId = text(source.selectedTemplateId || source.industryTemplateId);
  const template = resolveAnalysisTemplate(templateId);
  if (!template) throw new Error(`manual routing template is not registered: ${templateId || "(empty)"}`);
  const baseline = object(matchResult);
  const scope = { ...normalizeCompanyScope(baseline.companyScope), ...normalizeCompanyScope(source.companyScope) };
  const industryProfile = scope.industryTaxonomy === "eastmoney-em2016.v1" ? resolveEastmoneyIndustryProfile(scope.industry) : null;
  const scopeNote = text(source.scopeNote);
  if (scopeNote) scope.scopeNote = scopeNote;
  return {
    ...baseline,
    state: "confirmed",
    routingState: "confirmed",
    routingBasis: "manual_confirmation",
    industryTemplateId: template.templateId,
    industryKey: template.industryKey,
    industryLabel: template.label,
    analysisTemplate: analysisTemplateProjection(template, industryProfile),
    companyScope: scope,
    mappingReason: { code: "manual_confirmation", message: scopeNote ? `人工确认模板 ${template.templateId}；范围说明已记录` : `人工确认模板 ${template.templateId}`, fields: ROUTING_FIELDS, auditId: text(source.confirmationId) || null },
    unknowns: (baseline.unknowns || []).filter((item) => !["insufficient_evidence", "zero_match", "ambiguous_match", "eastmoney_em2016_unavailable", "eastmoney_em2016_unmapped"].includes(item?.code)),
  };
}

export function normalizeRoutingFacts(value) {
  const source = object(value);
  if (containsForbiddenTemplateSelection(source)) throw new Error("routing facts must not contain model-selected industryTemplateId");
  const facts = Array.isArray(source.facts) ? source.facts.map(normalizeFact).filter(Boolean) : [];
  return { facts, unknowns: normalizeUnknowns(source.unknowns), sourceIds: uniqueStrings(source.sourceIds), usedUpstreamArtifactIds: uniqueStrings(source.usedUpstreamArtifactIds) };
}

function fieldsFromBaseline(baseline) {
  const scope = object(baseline.companyScope);
  const facts = Array.isArray(scope.facts) ? scope.facts.map(normalizeFact).filter(Boolean) : [];
  const values = {
    primary_business: facts.filter((fact) => fact.field === "primary_business"),
    product_boundary: facts.filter((fact) => fact.field === "product_boundary"),
    downstream: facts.filter((fact) => fact.field === "downstream"),
    industry: facts.filter((fact) => fact.field === "industry"),
  };
  // S1 stores normalized fields as compact arrays; preserving them here keeps
  // the matcher deterministic while still requiring per-field source evidence.
  for (const field of ROUTING_FIELDS) {
    const direct = Array.isArray(scope[field]) ? scope[field] : [];
    values[field].push(...direct.map((item, index) => normalizeFact({ field, factId: `${field}:${index + 1}`, statement: item.statement || item.value || item, sourceReferences: item.sourceReferences || item.sources || [] })).filter(Boolean));
  }
  return values;
}

function fieldMatchesTemplate(field, facts, template) {
  const terms = Array.isArray(template?.terms?.[field]) ? template.terms[field].map(normalizeText).filter(Boolean) : [];
  return facts.some((fact) => terms.some((term) => normalizeText(`${fact.statement} ${fact.quote || ""}`).includes(term)));
}

function normalizeFact(value) {
  const source = object(value);
  const field = FIELD_ALIASES[text(source.field)] || text(source.field);
  if (!ROUTING_FIELDS.includes(field)) return null;
  const statement = text(source.statement || source.value || source.text);
  if (!statement) return null;
  const references = Array.isArray(source.sourceReferences) ? source.sourceReferences : Array.isArray(source.sources) ? source.sources : source.source ? [source.source] : source.evidence ? [source.evidence] : [];
  const sourceReferences = references.map(normalizeSourceReference).filter(Boolean);
  return { factId: text(source.factId) || `${field}:${stableToken(statement)}`, field, statement, quote: text(source.quote), sourceReferences, sourceIds: uniqueStrings([...(source.sourceIds || []), ...sourceReferences.map((item) => item.sourceId)]), evidence: sourceReferences.length > 0 };
}

function normalizeCompanyScope(value) {
  const source = object(value);
  return {
    primaryBusiness: text(source.primaryBusiness || source.primary_business) || null,
    products: stringArray(source.products || source.productBoundary || source.product_boundary),
    downstream: stringArray(source.downstream || source.customers || source.customerScope),
    industry: text(source.industry || source.industryName) || null,
    industryTaxonomy: text(source.industryTaxonomy) || null,
    industryLevels: stringArray(source.industryLevels),
    regions: stringArray(source.regions),
    segments: stringArray(source.segments),
    basisSourceIds: uniqueStrings(source.basisSourceIds || source.sourceIds),
    facts: Array.isArray(source.facts) ? source.facts.map(normalizeFact).filter(Boolean) : [],
  };
}

function normalizeCandidate(value) {
  const source = object(value); const templateId = text(source.templateId);
  if (!templateId) return null;
  return { templateId, reason: text(source.reason) || null, matchedFields: Array.isArray(source.matchedFields) ? source.matchedFields.filter((field) => ROUTING_FIELDS.includes(field)) : [], sourceIds: uniqueStrings(source.sourceIds) };
}

function normalizeMaterial(value) {
  const source = object(value); const sourceId = text(source.sourceId); if (!sourceId) return null;
  return { sourceId, role: text(source.role) || "company_material", title: text(source.title) || null, url: text(source.url) || null, publishedAt: text(source.publishedAt) || null, contentFingerprint: text(source.contentFingerprint) || null };
}

function normalizeSourceReference(value) {
  const source = object(value); const sourceId = text(source.sourceId); const url = text(source.url || source.sourceUrl); const quote = text(source.quote || source.evidenceQuote);
  if (!sourceId || !url || !(/^(?:https?:\/\/|\/api\/)/i.test(url)) || !quote) return null;
  return { sourceId, url, title: text(source.title || source.sourceTitle) || null, publishedAt: text(source.publishedAt || source.sourcePublishedAt) || null, quote, locator: text(source.locator) || null };
}

function normalizeUnknowns(value) { return Array.isArray(value) ? value.map((item, index) => { const source = object(item); const message = text(source.message || source.reason || item); return message ? { unknownId: text(source.unknownId) || `unknown:${index + 1}`, code: text(source.code) || "unknown", message, blocking: source.blocking === true } : null; }).filter(Boolean) : []; }
function hasEvidence(fact) { return Boolean(fact?.evidence && fact.sourceReferences?.length); }
function validTemplate(template) { return Boolean(template && text(template.templateId) && text(template.industryKey) && Array.isArray(template.requiredFields) && object(template.terms)); }
function resolveAnalysisTemplate(templateId, { templates = RESEARCH_ANALYSIS_TEMPLATE_REGISTRY } = {}) {
  const requested = text(templateId);
  const canonical = text(RESEARCH_ANALYSIS_TEMPLATE_ALIASES[requested]) || requested;
  return templates.find((item) => text(item.templateId) === canonical) || null;
}
function analysisTemplateProjection(template, industryProfile = null) {
  const presentation = templatePresentation(template);
  return {
    templateId: text(template.templateId),
    profileKey: text(template.industryKey),
    label: text(template.label),
    frameworkCategory: text(template.frameworkCategory),
    presentationCategoryId: presentation.categoryId,
    presentationCategoryLabel: presentation.categoryLabel,
    operatingFeatureLabel: presentation.featureLabel,
    industryProfileId: text(industryProfile?.profileId) || null,
    industryProfileLabel: text(industryProfile?.label) || null,
    businessModel: text(industryProfile?.businessModel) || text(template.businessModel),
    primaryFormula: text(industryProfile?.primaryFormula) || text(template.primaryFormula),
    operatingMetrics: stringArray(industryProfile?.operatingMetrics).length ? stringArray(industryProfile?.operatingMetrics) : stringArray(template.operatingMetrics),
    valuationMethods: stringArray(industryProfile?.valuationMethods).length ? stringArray(industryProfile?.valuationMethods) : stringArray(template.valuationMethods),
    stressFactors: stringArray(industryProfile?.stressFactors).length ? stringArray(industryProfile?.stressFactors) : stringArray(template.stressFactors),
  };
}
function templatePresentation(template) {
  const matchingRegisteredTemplate = RESEARCH_ANALYSIS_TEMPLATE_REGISTRY.find((item) => text(item.label) === text(template?.label) && text(item.frameworkCategory) === text(template?.frameworkCategory));
  const configured = object(presentationByTemplateId[text(template?.templateId)] || presentationByTemplateId[text(matchingRegisteredTemplate?.templateId)]);
  const categoryId = text(configured.categoryId);
  const category = presentationCategoryById.get(categoryId);
  if (!category) throw new Error(`research analysis template presentation category is missing: ${text(template?.templateId)}`);
  const featureLabel = text(configured.featureLabel);
  if (!featureLabel) throw new Error(`research analysis template operating feature is missing: ${text(template?.templateId)}`);
  return { categoryId, categoryLabel: category.label, featureLabel };
}
function findEastmoneyTemplateRule(levels) {
  const normalizedLevels = stringArray(levels);
  return (eastmoneyRules.rules || []).find((rule) => ["level1", "level2", "level3"].every((key, index) => !text(rule?.[key]) || text(rule[key]) === normalizedLevels[index])) || null;
}
function containsForbiddenTemplateSelection(value) { if (!value || typeof value !== "object") return false; if (Array.isArray(value)) return value.some(containsForbiddenTemplateSelection); return Object.entries(value).some(([key, item]) => key === "industryTemplateId" || key === "templateId" && object(value).routingState === "confirmed" || containsForbiddenTemplateSelection(item)); }
function text(value) { return typeof value === "string" ? value.trim() : ""; }
function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function stringArray(value) { return Array.isArray(value) ? value.map(text).filter(Boolean) : text(value) ? [text(value)] : []; }
function uniqueStrings(value) { return [...new Set((Array.isArray(value) ? value : []).map(text).filter((item) => item && !/\s/.test(item)))].sort(); }
function normalizeText(value) { return String(value || "").trim().toLowerCase().replace(/[\s\-_/]+/g, ""); }
function stableToken(value) { let hash = 0; for (const char of value) hash = (hash * 31 + char.codePointAt(0)) >>> 0; return hash.toString(16); }
