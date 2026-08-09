import sourceRegistryConfigJson from "../../../../config/research-source-registry.json";

export const RESEARCH_CONTEXT_VERSION = "research-context.v1";
export const RESEARCH_SOURCE_REGISTRY_VERSION = sourceRegistryConfigJson.version;

type SourceRegistryConfig = {
  version: string;
  roles: string[];
  availabilityStatuses: string[];
  requiredFields: string[];
};
const sourceRegistryConfig = sourceRegistryConfigJson as SourceRegistryConfig;

export type ResearchAnalysisGap = { gapId: string; code: string; field: string; message: string; blocking: boolean };
export type ResearchScopeEnvelope = {
  products: string[];
  customers: string[];
  regions: string[];
  uses: string[];
  segments: string[];
  uncertainBoundaries: string[];
  basisSourceIds: string[];
};
export type ResearchSourceVersion = {
  sourceId: string;
  sourceVersion: string;
  url: string;
  title: string;
  publishedAt: string;
  subject: string;
  role: string;
  retrievedAt: string;
  contentFingerprint: string;
  availabilityStatus: string;
  limitations: string[];
};
export type ResearchSourceRegistry = { registryVersion: string; sourceIds: string[]; sources: ResearchSourceVersion[] };
export type ResearchSnapshot = {
  asOf: string | null;
  schemaVersion: string | null;
  source: string | null;
  periods: string[];
  incomeStatement: Record<string, unknown>[];
  balanceSheet: Record<string, unknown>[];
  cashFlowStatement: Record<string, unknown>[];
  deterministicMetrics: unknown[];
  securityId: string | null;
  securityCode: string | null;
  listingVenue: string | null;
  shareClass: string | null;
  tradingCurrency: string | null;
  sharesOutstanding: number | null;
  rights: Record<string, unknown> | null;
  historicalValuation: Record<string, unknown>[];
  price: number | null;
  marketCapitalization: number | null;
  currency: string | null;
  reportedMultiples: Record<string, unknown>;
  qualityIssues: string[];
};
export type ResearchContext = {
  contextVersion: typeof RESEARCH_CONTEXT_VERSION;
  researchTaskId: string;
  asOf: string;
  company: { companyId: string | null; name: string | null; reportingCurrency: string | null };
  security: { securityId: string | null; securityCode: string | null; listingVenue: string | null; tradingCurrency: string | null; shareClass: string | null };
  reportingBoundary: { latestFiledPeriod: string | null; latestAnnualPeriod: string | null; laterProvisionalUpdates: Array<{ period: string | null; sourceId: string | null; kind: string | null }> };
  financialSnapshot: ResearchSnapshot;
  marketSnapshot: ResearchSnapshot;
  scopeEnvelope: ResearchScopeEnvelope | null;
  sourceRegistryId: string;
  knownSourceIds: string[];
  sourceRegistry: ResearchSourceRegistry;
  analysisGaps: ResearchAnalysisGap[];
  quality: { status: "available" | "partial" | "blocked"; gapCount: number };
  inputFingerprint: string;
};

export async function buildResearchContext(input: Record<string, unknown> = {}): Promise<ResearchContext> {
  const asOf = requiredIso(input.asOf, "asOf");
  const company = normalizeCompany(input.company);
  const security = normalizeSecurity(input.security);
  const reportingBoundary = normalizeReportingBoundary(input.reportingBoundary);
  const financialSnapshot = normalizeSnapshot(input.financialSnapshot || input.financialDataSnapshot, "financialSnapshot");
  const marketSnapshot = normalizeSnapshot(input.marketSnapshot, "marketSnapshot");
  const registry = await registerResearchSources(input.sources || (input.sourceRegistry as Record<string, unknown> | undefined)?.sources || []);
  const scopeResult = normalizeScopeEnvelope(input.scopeEnvelope);
  const analysisGaps = [...company.gaps, ...security.gaps, ...financialSnapshot.gaps, ...marketSnapshot.gaps, ...registry.analysisGaps, ...scopeResult.analysisGaps];
  const researchTaskId = text(input.researchTaskId) || `research-analysis:${security.value.securityCode || "unknown"}:${asOf}`;
  const contextWithoutFingerprint = {
    contextVersion: RESEARCH_CONTEXT_VERSION,
    researchTaskId,
    asOf,
    company: company.value,
    security: security.value,
    reportingBoundary,
    financialSnapshot: financialSnapshot.value,
    marketSnapshot: marketSnapshot.value,
    scopeEnvelope: scopeResult.value,
    sourceRegistryId: registry.sourceRegistryId,
    knownSourceIds: registry.knownSourceIds,
    sourceRegistry: registry.value,
    analysisGaps,
    quality: { status: analysisGaps.some((gap) => gap.blocking) ? "blocked" : analysisGaps.length ? "partial" : "available", gapCount: analysisGaps.length },
  } as const;
  return { ...contextWithoutFingerprint, inputFingerprint: await stableHash(contextWithoutFingerprint) } as ResearchContext;
}

export async function registerResearchSources(sources: unknown): Promise<{ sourceRegistryId: string; knownSourceIds: string[]; analysisGaps: ResearchAnalysisGap[]; value: ResearchSourceRegistry }> {
  const normalized: ResearchSourceVersion[] = [];
  const analysisGaps: ResearchAnalysisGap[] = [];
  for (const [index, source] of (Array.isArray(sources) ? sources : []).entries()) {
    const result = await normalizeSource(source, index);
    if (result.value) normalized.push(result.value);
    if (result.gap) analysisGaps.push(result.gap);
  }
  const deduped = [...new Map(normalized.map((source) => [source.sourceId, source])).values()].sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  if (!deduped.length && !analysisGaps.length) analysisGaps.push(gap("source_registry_empty", "sourceRegistry", "没有可注册的来源版本；事实域不能把缺少来源当作已验证事实", true));
  const knownSourceIds = deduped.map((source) => source.sourceId);
  const sourceRegistryId = `source-registry:${await stableHash({ version: RESEARCH_SOURCE_REGISTRY_VERSION, sourceIds: knownSourceIds })}`;
  return { sourceRegistryId, knownSourceIds, analysisGaps, value: { registryVersion: RESEARCH_SOURCE_REGISTRY_VERSION, sourceIds: knownSourceIds, sources: deduped } };
}

export function normalizeScopeEnvelope(raw: unknown): { value: ResearchScopeEnvelope | null; analysisGaps: ResearchAnalysisGap[] } {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  if (!source) return { value: null, analysisGaps: [gap("scope_envelope_unreliable", "scopeEnvelope", "未提供可验证的产品、客户、地区和用途边界；S2-S5 只能走 companyScope 最小依赖", false)] };
  const value: ResearchScopeEnvelope = {
    products: strings(source.products ?? source.product),
    customers: strings(source.customers ?? source.customer),
    regions: strings(source.regions ?? source.region),
    uses: strings(source.uses ?? source.useCases ?? source.use),
    segments: strings(source.segments ?? source.businessSegments ?? source.importantSegments),
    uncertainBoundaries: strings(source.uncertainBoundaries ?? source.uncertainties ?? source.uncertainBoundary),
    basisSourceIds: strings(source.basisSourceIds ?? source.sourceIds),
  };
  const reliable = value.products.length > 0 && value.customers.length > 0 && value.regions.length > 0 && value.uses.length > 0
    && value.basisSourceIds.length > 0
    && Array.isArray(source.segments ?? source.businessSegments ?? source.importantSegments)
    && Array.isArray(source.uncertainBoundaries ?? source.uncertainties ?? source.uncertainBoundary);
  return reliable ? { value, analysisGaps: [] } : { value: null, analysisGaps: [gap("scope_envelope_unreliable", "scopeEnvelope", "范围信封缺少可验证的产品、客户、地区、用途、分部或不确定边界；不得按 ticker/name 推断行业", false)] };
}

export async function stableHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableSerialize(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function normalizeCompany(raw: unknown) {
  const source = record(raw);
  const value = { companyId: text(source.companyId || source.id) || null, name: text(source.name) || null, reportingCurrency: text(source.reportingCurrency || source.currency) || null };
  return { value, gaps: value.name ? [] : [gap("company_identity_missing", "company", "缺少已验证经营公司主体", true)] };
}

function normalizeSecurity(raw: unknown) {
  const source = record(raw);
  const value = { securityId: text(source.securityId || source.id) || null, securityCode: text(source.securityCode || source.code) || null, listingVenue: text(source.listingVenue || source.venue) || null, tradingCurrency: text(source.tradingCurrency || source.currency) || null, shareClass: text(source.shareClass) || null };
  return { value, gaps: value.securityCode && value.listingVenue && value.tradingCurrency ? [] : [gap("security_identity_incomplete", "security", "证券代码、上市地和交易币种未完整确认", true)] };
}

function normalizeReportingBoundary(raw: unknown) {
  const source = record(raw);
  return {
    latestFiledPeriod: text(source.latestFiledPeriod) || null,
    latestAnnualPeriod: text(source.latestAnnualPeriod) || null,
    laterProvisionalUpdates: Array.isArray(source.laterProvisionalUpdates) ? source.laterProvisionalUpdates.map((item) => { const value = record(item); return { period: text(value.period) || null, sourceId: text(value.sourceId) || null, kind: text(value.kind) || null }; }).filter((item) => item.period || item.sourceId || item.kind) : [],
  };
}

function normalizeSnapshot(raw: unknown, name: string): { value: ResearchSnapshot; gaps: ResearchAnalysisGap[] } {
  const source = record(raw);
  const value: ResearchSnapshot = {
    asOf: text(source.asOf) || null,
    schemaVersion: text(source.schemaVersion) || null,
    source: text(source.source) || null,
    periods: strings(source.periods),
    incomeStatement: compactRows(source.incomeStatement),
    balanceSheet: compactRows(source.balanceSheet),
    cashFlowStatement: compactRows(source.cashFlowStatement),
    deterministicMetrics: Array.isArray(source.deterministicMetrics) ? source.deterministicMetrics : [],
    securityId: text(source.securityId) || null,
    securityCode: text(source.securityCode) || null,
    listingVenue: text(source.listingVenue) || null,
    shareClass: text(source.shareClass) || null,
    tradingCurrency: text(source.tradingCurrency) || null,
    sharesOutstanding: finite(source.sharesOutstanding),
    rights: source.rights && typeof source.rights === "object" && !Array.isArray(source.rights) ? record(source.rights) : null,
    historicalValuation: compactRows(source.historicalValuation),
    price: finite(source.price),
    marketCapitalization: finite(source.marketCapitalization),
    currency: text(source.currency) || null,
    reportedMultiples: record(source.reportedMultiples),
    qualityIssues: strings(source.qualityIssues),
  };
  const missing = ["asOf", "schemaVersion", "source"].filter((field) => !value[field as keyof ResearchSnapshot]);
  return { value, gaps: missing.length ? [gap(`${name}_incomplete`, name, `${name} 缺少 ${missing.join(", ")}；不得由模型补齐`, false)] : [] };
}

async function normalizeSource(raw: unknown, index: number): Promise<{ value: ResearchSourceVersion | null; gap?: ResearchAnalysisGap }> {
  const source = record(raw);
  const value = {
    url: text(source.url || source.sourceUrl), title: text(source.title || source.sourceTitle), publishedAt: text(source.publishedAt || source.sourcePublishedAt), subject: text(source.subject), role: text(source.role || source.sourceRole), retrievedAt: text(source.retrievedAt || source.availableAt || source.capturedAt), contentFingerprint: text(source.contentFingerprint) || (text(source.content) ? await stableHash(text(source.content)) : ""), availabilityStatus: text(source.availabilityStatus || source.status) || "available", limitations: strings(source.limitations),
  };
  const missing = sourceRegistryConfig.requiredFields.filter((field) => !value[field as keyof typeof value]);
  if (!sourceRegistryConfig.roles.includes(value.role)) missing.push(`role:${value.role || "missing"}`);
  if (!sourceRegistryConfig.availabilityStatuses.includes(value.availabilityStatus)) missing.push(`availabilityStatus:${value.availabilityStatus}`);
  if (missing.length) return { value: null, gap: gap("source_version_incomplete", `sources[${index}]`, `来源版本缺少或不合法字段：${missing.join(", ")}`, false) };
  const sourceId = `source:${await stableHash({ ...value, registryVersion: RESEARCH_SOURCE_REGISTRY_VERSION })}`;
  return { value: { sourceId, sourceVersion: RESEARCH_SOURCE_REGISTRY_VERSION, ...value } };
}

function compactRows(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.map((item) => record(item)).filter((item) => Object.keys(item).length > 0) : []; }
function strings(value: unknown): string[] { if (Array.isArray(value)) return value.map((item) => text(item)).filter(Boolean).sort(); const result = text(value); return result ? [result] : []; }
function finite(value: unknown): number | null { const number = Number(value); return Number.isFinite(number) ? number : null; }
function requiredIso(value: unknown, name: string): string { const raw = text(value); const date = new Date(raw); if (!raw || Number.isNaN(date.getTime())) throw new Error(`research context ${name} must be an ISO timestamp`); return date.toISOString(); }
function gap(code: string, field: string, message: string, blocking: boolean): ResearchAnalysisGap { const value = { code, field, message, blocking }; return { gapId: `analysis-gap:${hashForGap(value)}`, ...value }; }
function hashForGap(value: unknown): string { const input = stableSerialize(value); let hash = 2166136261; for (let index = 0; index < input.length; index += 1) { hash ^= input.charCodeAt(index); hash = Math.imul(hash, 16777619); } return (hash >>> 0).toString(16).padStart(8, "0"); }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : ""; }
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function stableSerialize(value: unknown): string { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map((item) => stableSerialize(item)).join(",")}]`; return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize((value as Record<string, unknown>)[key])}`).join(",")}}`; }
