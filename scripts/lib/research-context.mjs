import { createHash } from "node:crypto";
import sourceRegistryConfig from "../../config/research-source-registry.json" with { type: "json" };

export const RESEARCH_CONTEXT_VERSION = "research-context.v1";
export const RESEARCH_SOURCE_REGISTRY_VERSION = sourceRegistryConfig.version;

/**
 * Build the deterministic S0 envelope. This module only normalizes inputs and
 * computes IDs; it never calls a provider, searches, or creates a judgement.
 */
export function buildResearchContext(input = {}) {
  const asOf = requiredIso(input.asOf, "asOf");
  const company = normalizeCompany(input.company);
  const security = normalizeSecurity(input.security);
  const reportingBoundary = normalizeReportingBoundary(input.reportingBoundary);
  const financialSnapshot = normalizeSnapshot(input.financialSnapshot || input.financialDataSnapshot, "financialSnapshot");
  const marketSnapshot = normalizeSnapshot(input.marketSnapshot, "marketSnapshot");
  const registry = registerResearchSources(input.sources || input.sourceRegistry?.sources || []);
  const scopeResult = normalizeScopeEnvelope(input.scopeEnvelope);
  const companyProfile = normalizeCompanyProfile(input.companyProfile, registry.value.sources);
  const analysisGaps = [...company.gaps, ...security.gaps, ...financialSnapshot.gaps, ...marketSnapshot.gaps, ...registry.analysisGaps, ...scopeResult.analysisGaps, ...companyProfile.analysisGaps];
  const researchTaskId = text(input.researchTaskId) || `research-analysis:${security.value.securityCode || "unknown"}:${asOf}`;
  const context = {
    contextVersion: RESEARCH_CONTEXT_VERSION,
    researchTaskId,
    asOf,
    company: company.value,
    security: security.value,
    reportingBoundary,
    financialSnapshot: financialSnapshot.value,
    marketSnapshot: marketSnapshot.value,
    scopeEnvelope: scopeResult.value,
    companyProfile: companyProfile.value,
    sourceRegistryId: registry.sourceRegistryId,
    knownSourceIds: registry.knownSourceIds,
    sourceRegistry: registry.value,
    analysisGaps,
    quality: {
      status: analysisGaps.some((gap) => gap.blocking === true) ? "blocked" : analysisGaps.length ? "partial" : "available",
      gapCount: analysisGaps.length,
    },
  };
  return { ...context, inputFingerprint: stableHash(context) };
}

function normalizeCompanyProfile(raw, sources) {
  const taxonomy = text(raw?.taxonomy);
  const industry = text(raw?.industry);
  const sourceUrl = text(raw?.sourceUrl);
  const sourceId = Array.isArray(sources) ? text(sources.find((item) => item?.url === sourceUrl)?.sourceId) : "";
  if (!taxonomy || !industry || !sourceId) return { value: null, analysisGaps: [] };
  return { value: { taxonomy, industry, industryLevels: strings(raw?.industryLevels), mainBusiness: text(raw?.mainBusiness) || null, products: strings(raw?.products), sourceId }, analysisGaps: [] };
}

/** Register source versions without turning them into facts or judgments. */
export function registerResearchSources(sources) {
  const normalized = [];
  const analysisGaps = [];
  for (const [index, source] of (Array.isArray(sources) ? sources : []).entries()) {
    const result = normalizeSource(source, index);
    if (result.value) normalized.push(result.value);
    if (result.gap) analysisGaps.push(result.gap);
  }
  const deduped = [...new Map(normalized.map((source) => [source.sourceId, source])).values()].sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  if (!deduped.length && !analysisGaps.length) analysisGaps.push(gap("source_registry_empty", "sourceRegistry", "没有可注册的来源版本；事实域不能把缺少来源当作已验证事实", true));
  const knownSourceIds = deduped.map((source) => source.sourceId);
  const sourceRegistryId = `source-registry:${stableHash({ version: RESEARCH_SOURCE_REGISTRY_VERSION, sourceIds: knownSourceIds })}`;
  return {
    sourceRegistryId,
    knownSourceIds,
    analysisGaps,
    value: { registryVersion: RESEARCH_SOURCE_REGISTRY_VERSION, sourceIds: knownSourceIds, sources: deduped },
  };
}

export function normalizeScopeEnvelope(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { value: null, analysisGaps: [gap("scope_envelope_unreliable", "scopeEnvelope", "未提供可验证的产品、客户、地区和用途边界；S2-S5 只能走 companyScope 最小依赖", false)] };
  const value = {
    products: strings(raw.products ?? raw.product),
    customers: strings(raw.customers ?? raw.customer),
    regions: strings(raw.regions ?? raw.region),
    uses: strings(raw.uses ?? raw.useCases ?? raw.use),
    segments: strings(raw.segments ?? raw.businessSegments ?? raw.importantSegments),
    uncertainBoundaries: strings(raw.uncertainBoundaries ?? raw.uncertainties ?? raw.uncertainBoundary),
    basisSourceIds: strings(raw.basisSourceIds ?? raw.sourceIds),
  };
  const reliable = value.products.length > 0 && value.customers.length > 0 && value.regions.length > 0 && value.uses.length > 0
    && value.basisSourceIds.length > 0
    && Array.isArray(raw.segments ?? raw.businessSegments ?? raw.importantSegments)
    && Array.isArray(raw.uncertainBoundaries ?? raw.uncertainties ?? raw.uncertainBoundary);
  return reliable
    ? { value, analysisGaps: [] }
    : { value: null, analysisGaps: [gap("scope_envelope_unreliable", "scopeEnvelope", "范围信封缺少可验证的产品、客户、地区、用途、分部或不确定边界；不得按 ticker/name 推断行业", false)] };
}

export function stableHash(value) {
  return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

function normalizeCompany(raw) {
  const value = {
    companyId: text(raw?.companyId || raw?.id) || null,
    name: text(raw?.name) || null,
    reportingCurrency: text(raw?.reportingCurrency || raw?.currency) || null,
  };
  return { value, gaps: value.name ? [] : [gap("company_identity_missing", "company", "缺少已验证经营公司主体", true)] };
}

function normalizeSecurity(raw) {
  const value = {
    securityId: text(raw?.securityId || raw?.id) || null,
    securityCode: text(raw?.securityCode || raw?.code) || null,
    listingVenue: text(raw?.listingVenue || raw?.venue) || null,
    tradingCurrency: text(raw?.tradingCurrency || raw?.currency) || null,
    shareClass: text(raw?.shareClass) || null,
  };
  return { value, gaps: value.securityCode && value.listingVenue && value.tradingCurrency ? [] : [gap("security_identity_incomplete", "security", "证券代码、上市地和交易币种未完整确认", true)] };
}

function normalizeReportingBoundary(raw) {
  return {
    latestFiledPeriod: text(raw?.latestFiledPeriod) || null,
    latestAnnualPeriod: text(raw?.latestAnnualPeriod) || null,
    laterProvisionalUpdates: Array.isArray(raw?.laterProvisionalUpdates) ? raw.laterProvisionalUpdates.map((item) => ({ period: text(item?.period) || null, sourceId: text(item?.sourceId) || null, kind: text(item?.kind) || null })).filter((item) => item.period || item.sourceId || item.kind) : [],
  };
}

function normalizeSnapshot(raw, name) {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? {
    asOf: text(raw.asOf) || null,
    schemaVersion: text(raw.schemaVersion) || null,
    source: text(raw.source) || null,
    periods: strings(raw.periods),
    incomeStatement: compactRows(raw.incomeStatement),
    balanceSheet: compactRows(raw.balanceSheet),
    cashFlowStatement: compactRows(raw.cashFlowStatement),
    deterministicMetrics: Array.isArray(raw.deterministicMetrics) ? raw.deterministicMetrics : [],
    securityId: text(raw.securityId) || null,
    securityCode: text(raw.securityCode) || null,
    listingVenue: text(raw.listingVenue) || null,
    shareClass: text(raw.shareClass) || null,
    tradingCurrency: text(raw.tradingCurrency) || null,
    sharesOutstanding: finite(raw.sharesOutstanding),
    rights: raw.rights && typeof raw.rights === "object" && !Array.isArray(raw.rights) ? raw.rights : null,
    historicalValuation: Array.isArray(raw.historicalValuation) ? raw.historicalValuation.filter((item) => item && typeof item === "object" && !Array.isArray(item)) : [],
    price: finite(raw.price),
    marketCapitalization: finite(raw.marketCapitalization),
    currency: text(raw.currency) || null,
    reportedMultiples: raw.reportedMultiples && typeof raw.reportedMultiples === "object" && !Array.isArray(raw.reportedMultiples) ? raw.reportedMultiples : {},
    qualityIssues: strings(raw.qualityIssues),
  } : {
    asOf: null, schemaVersion: null, source: null, periods: [], incomeStatement: [], balanceSheet: [], cashFlowStatement: [], deterministicMetrics: [], price: null, marketCapitalization: null, currency: null, reportedMultiples: {}, qualityIssues: [],
    securityId: null, securityCode: null, listingVenue: null, shareClass: null, tradingCurrency: null, sharesOutstanding: null, rights: null, historicalValuation: [],
  };
  const missing = ["asOf", "schemaVersion", "source"].filter((field) => !value[field]);
  return { value, gaps: missing.length ? [gap(`${name}_incomplete`, name, `${name} 缺少 ${missing.join(", ")}；不得由模型补齐`, false)] : [] };
}

function normalizeSource(raw, index) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const value = {
    url: text(source.url || source.sourceUrl),
    title: text(source.title || source.sourceTitle),
    publishedAt: text(source.publishedAt || source.sourcePublishedAt),
    subject: text(source.subject),
    role: text(source.role || source.sourceRole),
    retrievedAt: text(source.retrievedAt || source.availableAt || source.capturedAt),
    contentFingerprint: text(source.contentFingerprint) || (text(source.content) ? stableHash(text(source.content)) : ""),
    availabilityStatus: text(source.availabilityStatus || source.status) || "available",
    limitations: strings(source.limitations),
  };
  const missing = sourceRegistryConfig.requiredFields.filter((field) => !value[field]);
  if (!sourceRegistryConfig.roles.includes(value.role)) missing.push(`role:${value.role || "missing"}`);
  if (!sourceRegistryConfig.availabilityStatuses.includes(value.availabilityStatus)) missing.push(`availabilityStatus:${value.availabilityStatus}`);
  if (missing.length) return { value: null, gap: gap("source_version_incomplete", `sources[${index}]`, `来源版本缺少或不合法字段：${missing.join(", ")}`, false) };
  const sourceId = `source:${stableHash({ ...value, registryVersion: RESEARCH_SOURCE_REGISTRY_VERSION })}`;
  return { value: { sourceId, sourceVersion: RESEARCH_SOURCE_REGISTRY_VERSION, ...value, quote: text(source.quote || source.sourceQuote) || null } };
}

function compactRows(rows) {
  return Array.isArray(rows) ? rows.map((row) => row && typeof row === "object" && !Array.isArray(row) ? row : null).filter(Boolean) : [];
}

function strings(value) {
  if (Array.isArray(value)) return value.map((item) => text(item)).filter(Boolean).sort();
  const result = text(value);
  return result ? [result] : [];
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function requiredIso(value, name) {
  const raw = text(value);
  const date = new Date(raw);
  if (!raw || Number.isNaN(date.getTime())) throw new Error(`research context ${name} must be an ISO timestamp`);
  return date.toISOString();
}

function gap(code, field, message, blocking) {
  const value = { code, field, message, blocking: blocking === true };
  return { gapId: `analysis-gap:${stableShortHash(value)}`, ...value };
}

function text(value) { return typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : ""; }

function stableSerialize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
}

function stableShortHash(value) {
  const input = stableSerialize(value);
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
