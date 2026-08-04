import specialtyMetricConfig from "../../../../config/research-financial-specialty-metrics.json";
import type { ResolvedResearchFinancialProfile } from "./research-financial-profile";

export type ResearchFinancialSpecialtyEntityType = "bank" | "insurer" | "broker";
export type ResearchFinancialSpecialtyValueKind = "ratio" | "amount";

type ConfigMetric = {
  entityType: ResearchFinancialSpecialtyEntityType;
  label: string;
  valueKind: ResearchFinancialSpecialtyValueKind;
  normalizedUnit: "%" | "reported_currency";
  requiresCurrency: boolean;
  requiresAmountScale: boolean;
  definitionRequirement: string;
  missingInput: string;
};
type Config = {
  version: string;
  entityTypes: Record<ResearchFinancialSpecialtyEntityType, { label: string; description: string }>;
  metrics: Record<string, ConfigMetric>;
};
const config = specialtyMetricConfig as Config;

export type ResearchFinancialSpecialtyMetricDefinition = ConfigMetric & { metricKey: string };
export type ResearchFinancialSpecialtyFactVersion = {
  financialSpecialtyFactId: string;
  financialProfileId: string;
  companyId: string;
  securityCode: string;
  evidenceReferenceId: string;
  candidateId: string;
  candidateReviewId: string;
  entityType: ResearchFinancialSpecialtyEntityType;
  metricKey: string;
  reportedLabel: string;
  reportedValue: string;
  valueNumber: number;
  unit: string;
  currency: string | null;
  amountScale: string | null;
  asOf: string;
  periodLabel: string;
  definitionNote: string;
  comparabilityNote: string;
  statement: string;
  sourceUrl: string | null;
  contentUrl: string | null;
  sourceTitle: string | null;
  sourceName: string | null;
  publishedAt: string | null;
  sourceLocator: string;
  metricConfigVersion: string;
  recordedBy: string;
  recordedAt: number;
  createdAt: number;
};

export type ResearchFinancialSpecialtyMetricState = "reported" | "missing" | "conflicting";
export type ResolvedResearchFinancialSpecialtyMetric = ResearchFinancialSpecialtyMetricDefinition & {
  state: ResearchFinancialSpecialtyMetricState;
  reason: string;
  fact: ResearchFinancialSpecialtyFactVersion | null;
  effectiveFacts: ResearchFinancialSpecialtyFactVersion[];
};
export type ResolvedResearchFinancialSpecialtyLedger = {
  availability: "available" | "empty" | "unavailable";
  status: "blocked_entity_profile" | "not_applicable" | "needs_sources" | "partial" | "conflicting" | "storage_unavailable";
  entityType: ResearchFinancialSpecialtyEntityType | null;
  entityLabel: string | null;
  reason: string;
  profile: Pick<ResolvedResearchFinancialProfile, "status" | "entityType" | "asOf" | "reason">;
  configVersion: string;
  metrics: ResolvedResearchFinancialSpecialtyMetric[];
  facts: ResearchFinancialSpecialtyFactVersion[];
};

export function researchFinancialSpecialtyMetricConfigVersion(): string { return required(config.version, "financial specialty metric config version"); }
export function researchFinancialSpecialtyEntityDefinition(entityType: ResearchFinancialSpecialtyEntityType) { return config.entityTypes[entityType] ?? null; }
export function researchFinancialSpecialtyMetricDefinitions(entityType?: ResearchFinancialSpecialtyEntityType): ResearchFinancialSpecialtyMetricDefinition[] {
  return Object.entries(config.metrics)
    .filter(([, definition]) => !entityType || definition.entityType === entityType)
    .map(([metricKey, definition]) => ({ metricKey, ...definition }));
}
export function researchFinancialSpecialtyMetricDefinition(metricKey: string): ResearchFinancialSpecialtyMetricDefinition | null {
  const definition = config.metrics[metricKey];
  return definition ? { metricKey, ...definition } : null;
}

/** A specialty fact is a normalized transcription from one accepted immutable
 * information-preprocessing reference.  It is deliberately not an estimate,
 * score, cross-company comparison, scenario input, or valuation conclusion. */
export function assertResearchFinancialSpecialtyFactVersion(input: ResearchFinancialSpecialtyFactVersion): void {
  const definition = researchFinancialSpecialtyMetricDefinition(input.metricKey);
  if (!definition) throw new Error("financial specialty metricKey is not configured");
  if (definition.entityType !== input.entityType) throw new Error("financial specialty metric is incompatible with entity type");
  for (const [label, value] of Object.entries({
    financialSpecialtyFactId: input.financialSpecialtyFactId, financialProfileId: input.financialProfileId, companyId: input.companyId,
    securityCode: input.securityCode, evidenceReferenceId: input.evidenceReferenceId, candidateId: input.candidateId,
    candidateReviewId: input.candidateReviewId, reportedLabel: input.reportedLabel, reportedValue: input.reportedValue,
    unit: input.unit, asOf: input.asOf, periodLabel: input.periodLabel, definitionNote: input.definitionNote,
    comparabilityNote: input.comparabilityNote, statement: input.statement, sourceLocator: input.sourceLocator,
    metricConfigVersion: input.metricConfigVersion, recordedBy: input.recordedBy,
  })) required(value, label);
  if (!Number.isFinite(input.valueNumber)) throw new Error("financial specialty valueNumber must be finite");
  if (input.unit !== definition.normalizedUnit) throw new Error(`financial specialty unit must be ${definition.normalizedUnit}`);
  if (definition.requiresCurrency !== Boolean(input.currency?.trim())) throw new Error(definition.requiresCurrency ? "financial specialty metric requires currency" : "financial specialty ratio cannot carry currency");
  if (definition.requiresAmountScale !== Boolean(input.amountScale?.trim())) throw new Error(definition.requiresAmountScale ? "financial specialty amount requires amountScale" : "financial specialty ratio cannot carry amountScale");
  requiredDate(input.asOf, "asOf");
  if (!Number.isInteger(input.recordedAt) || input.recordedAt <= 0 || !Number.isInteger(input.createdAt) || input.createdAt <= 0) throw new Error("financial specialty timestamps are invalid");
}

/** Resolve only the latest reported date for each configured metric.  Two
 * different normalized values or definitions on that effective date stay
 * visibly conflicting; creation time is never used to pick a winner. */
export function resolveResearchFinancialSpecialtyLedger(profile: ResolvedResearchFinancialProfile, facts: ResearchFinancialSpecialtyFactVersion[], availability: "available" | "empty" | "unavailable" = facts.length ? "available" : "empty"): ResolvedResearchFinancialSpecialtyLedger {
  const profileView = { status: profile.status, entityType: profile.entityType, asOf: profile.asOf, reason: profile.reason };
  if (availability === "unavailable") return { availability, status: "storage_unavailable", entityType: null, entityLabel: null, reason: "金融专属指标账本尚未初始化；不会以空值、通用工业指标或名称推断替代。", profile: profileView, configVersion: researchFinancialSpecialtyMetricConfigVersion(), metrics: [], facts: [] };
  if (profile.status !== "confirmed" || !profile.entityType) return { availability, status: "blocked_entity_profile", entityType: null, entityLabel: null, reason: "需先补充来源绑定且无冲突的经营实体类型，才能确定银行、保险或券商的专属指标字典。", profile: profileView, configVersion: researchFinancialSpecialtyMetricConfigVersion(), metrics: [], facts };
  if (!isSpecialtyEntity(profile.entityType)) return { availability, status: "not_applicable", entityType: null, entityLabel: null, reason: profile.entityType === "non_financial" ? "已确认非金融实体，银行/保险/券商专属指标不适用。" : "已确认其他金融实体，但当前版本没有可安全套用的专属指标字典；需要先定义并审核该实体的监管/披露口径。", profile: profileView, configVersion: researchFinancialSpecialtyMetricConfigVersion(), metrics: [], facts };
  const entityType = profile.entityType;
  const definitions = researchFinancialSpecialtyMetricDefinitions(entityType);
  const metrics = definitions.map((definition) => resolveMetric(definition, facts.filter((fact) => fact.entityType === entityType && fact.metricKey === definition.metricKey)));
  const anyConflict = metrics.some((metric) => metric.state === "conflicting");
  const anyReported = metrics.some((metric) => metric.state === "reported");
  const status = anyConflict ? "conflicting" : anyReported ? "partial" : "needs_sources";
  const reason = anyConflict ? "同一最新截至日存在不同数值或定义的来源事实；系统不会选择其一、汇总或计算。" : anyReported ? "仅展示已绑定来源的专属指标。未记录项仍需要对应直接披露；该字典不是完整研究结论、行业评分或估值。" : "尚无可复用的已接受证据所支撑的专属指标。请先通过信息预处理、证据审核和人工口径录入补齐。";
  return { availability, status, entityType, entityLabel: researchFinancialSpecialtyEntityDefinition(entityType)?.label ?? entityType, reason, profile: profileView, configVersion: researchFinancialSpecialtyMetricConfigVersion(), metrics, facts };
}

function resolveMetric(definition: ResearchFinancialSpecialtyMetricDefinition, facts: ResearchFinancialSpecialtyFactVersion[]): ResolvedResearchFinancialSpecialtyMetric {
  if (!facts.length) return { ...definition, state: "missing", reason: definition.missingInput, fact: null, effectiveFacts: [] };
  const latestAsOf = facts.reduce((latest, fact) => fact.asOf > latest ? fact.asOf : latest, facts[0].asOf);
  const effectiveFacts = facts.filter((fact) => fact.asOf === latestAsOf);
  const signatures = new Set(effectiveFacts.map(comparisonSignature));
  if (signatures.size !== 1) return { ...definition, state: "conflicting", reason: `截至 ${latestAsOf} 的来源事实具有不同的标准化数值、单位、币种、缩放或定义；需要人工保留冲突并澄清。`, fact: null, effectiveFacts };
  return { ...definition, state: "reported", reason: `截至 ${latestAsOf} 的来源绑定披露值；不能自动外推、平均或作为估值结论。`, fact: effectiveFacts[0], effectiveFacts };
}
function comparisonSignature(fact: ResearchFinancialSpecialtyFactVersion): string { return JSON.stringify([fact.valueNumber, fact.unit, fact.currency, fact.amountScale, normalize(fact.definitionNote)]); }
function normalize(value: string): string { return value.trim().replace(/\s+/g, " "); }
function isSpecialtyEntity(value: string): value is ResearchFinancialSpecialtyEntityType { return value === "bank" || value === "insurer" || value === "broker"; }
function required(value: unknown, label: string): string { const result = String(value ?? "").trim(); if (!result) throw new Error(`${label} is required`); return result; }
function requiredDate(value: string, label: string): void { if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))) throw new Error(`${label} must be YYYY-MM-DD`); }
