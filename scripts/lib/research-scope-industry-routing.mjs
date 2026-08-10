import registry from "../../config/research-analysis-template-registry.json" with { type: "json" };

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
  const missingEvidenceFields = ROUTING_FIELDS.filter((field) => evidenceByField[field].length === 0);
  const candidates = evaluateLocalTemplateCandidates(normalized, { templates });
  const qualified = candidates.filter((candidate) => {
    const template = templates.find((item) => text(item.templateId) === candidate.templateId);
    const requiredFields = Array.isArray(template?.requiredFields) && template.requiredFields.length ? template.requiredFields : ROUTING_FIELDS;
    return candidate.matchedFields.length >= Number(template?.minimumMatchedFields || requiredFields.length) && requiredFields.every((field) => candidate.matchedFields.includes(field));
  });
  const routingReason = missingEvidenceFields.length
    ? { code: "insufficient_evidence", message: `S1 缺少可审计证据：${missingEvidenceFields.join("、")}`, fields: missingEvidenceFields }
    : qualified.length === 0
      ? { code: "zero_match", message: "S1 的已审计主营、产品边界、下游和行业事实未唯一命中受控模板", fields: [] }
      : qualified.length > 1
        ? { code: "ambiguous_match", message: `受控模板匹配不唯一：${qualified.map((item) => item.templateId).join("、")}`, fields: [] }
        : null;
  const selected = qualified.length === 1 && !routingReason ? qualified[0] : null;
  const selectedTemplate = selected ? resolveAnalysisTemplate(selected.templateId, { templates }) : null;
  const sourceIds = uniqueStrings([...normalized.sourceIds, ...ROUTING_FIELDS.flatMap((field) => evidenceByField[field].flatMap((item) => item.sourceIds))]);
  const evidenceIds = uniqueStrings(ROUTING_FIELDS.flatMap((field) => evidenceByField[field].map((item) => item.factId)));
  return {
    schemaVersion: "local-routing-match.v1",
    state: selected ? "confirmed" : "unconfirmed",
    routingState: selected ? "confirmed" : "unconfirmed",
    industryTemplateId: selectedTemplate?.templateId || null,
    industryKey: selectedTemplate?.industryKey || null,
    industryLabel: selectedTemplate?.label || null,
    analysisTemplate: selectedTemplate ? analysisTemplateProjection(selectedTemplate) : null,
    companyScope: normalized.companyScope,
    candidateTemplates: candidates,
    matchedTemplates: qualified,
    mappingReason: routingReason || { code: "unique_match", message: `唯一命中受控模板 ${selected.templateId}`, fields: selected.matchedFields },
    evidence: ROUTING_FIELDS.flatMap((field) => evidenceByField[field]).map((item) => ({ factId: item.factId, field: item.field, statement: item.statement, sourceIds: item.sourceIds, sourceReferences: item.sourceReferences })),
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
    return { templateId: text(template.templateId), industryKey: text(template.industryKey), label: text(template.label), frameworkCategory: text(template.frameworkCategory), matchedFields, score: matchedFields.length, reason: matchedFields.length ? `命中字段：${matchedFields.join("、")}` : "没有命中受控事实谓词" };
  }) : [];
}

export function confirmedRoutingProjection(artifact) {
  const source = object(artifact?.output || artifact);
  if (text(source.routingState) !== "confirmed" || !text(source.industryTemplateId) || !text(source.industryKey)) {
    throw new Error("S3+ requires a confirmed local routing projection");
  }
  const template = resolveAnalysisTemplate(source.industryTemplateId);
  if (!template) throw new Error(`confirmed routing template is not registered: ${text(source.industryTemplateId)}`);
  return {
    routingState: "confirmed",
    industryTemplateId: template.templateId,
    industryKey: template.industryKey,
    industryLabel: template.label,
    analysisTemplate: analysisTemplateProjection(template),
    companyScope: normalizeCompanyScope(source.companyScope),
    sourceIds: uniqueStrings(source.sourceIds),
    evidenceIds: uniqueStrings(source.evidenceIds),
    upstreamArtifactIds: uniqueStrings([artifact?.artifactId, ...(source.usedUpstreamArtifactIds || [])]),
  };
}

export function applyManualRoutingConfirmation(matchResult, confirmation) {
  const source = object(confirmation);
  const templateId = text(source.selectedTemplateId || source.industryTemplateId);
  const template = resolveAnalysisTemplate(templateId);
  if (!template) throw new Error(`manual routing template is not registered: ${templateId || "(empty)"}`);
  const baseline = object(matchResult);
  const scope = { ...normalizeCompanyScope(baseline.companyScope), ...normalizeCompanyScope(source.companyScope) };
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
    analysisTemplate: analysisTemplateProjection(template),
    companyScope: scope,
    mappingReason: { code: "manual_confirmation", message: scopeNote ? `人工确认模板 ${template.templateId}；范围说明已记录` : `人工确认模板 ${template.templateId}`, fields: ROUTING_FIELDS, auditId: text(source.confirmationId) || null },
    unknowns: (baseline.unknowns || []).filter((item) => item?.code !== "insufficient_evidence" && item?.code !== "zero_match" && item?.code !== "ambiguous_match"),
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
function analysisTemplateProjection(template) {
  return {
    templateId: text(template.templateId),
    profileKey: text(template.industryKey),
    label: text(template.label),
    frameworkCategory: text(template.frameworkCategory),
    businessModel: text(template.businessModel),
    primaryFormula: text(template.primaryFormula),
    operatingMetrics: stringArray(template.operatingMetrics),
    valuationMethods: stringArray(template.valuationMethods),
    stressFactors: stringArray(template.stressFactors),
  };
}
function containsForbiddenTemplateSelection(value) { if (!value || typeof value !== "object") return false; if (Array.isArray(value)) return value.some(containsForbiddenTemplateSelection); return Object.entries(value).some(([key, item]) => key === "industryTemplateId" || key === "templateId" && object(value).routingState === "confirmed" || containsForbiddenTemplateSelection(item)); }
function text(value) { return typeof value === "string" ? value.trim() : ""; }
function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function stringArray(value) { return Array.isArray(value) ? value.map(text).filter(Boolean) : text(value) ? [text(value)] : []; }
function uniqueStrings(value) { return [...new Set((Array.isArray(value) ? value : []).map(text).filter((item) => item && !/\s/.test(item)))].sort(); }
function normalizeText(value) { return String(value || "").trim().toLowerCase().replace(/[\s\-_/]+/g, ""); }
function stableToken(value) { let hash = 0; for (const char of value) hash = (hash * 31 + char.codePointAt(0)) >>> 0; return hash.toString(16); }
