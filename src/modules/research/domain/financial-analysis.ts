import riskRulesJson from "../../../../config/research-financial-analysis-risk-rules.json";
import type { ResearchFinancialFrequency, ResearchFinancialMetric, ResearchFinancialObservation, ResearchFinancialQuality, ResearchFinancialSeries, ResearchFinancialSeriesPoint } from "./research-financial-quality";

export const FINANCIAL_ANALYSIS_PROTOCOL_VERSION = "financial-analysis-input.v1";
export const FINANCIAL_ANALYSIS_PROMPT_VERSION = "financial-analysis.webqa.v1";
export const FINANCIAL_ANALYSIS_CODE_VERSION = "financial-analysis-code.v1";
export const FINANCIAL_ANALYSIS_ORIGIN_TASK_TYPE = "research_financial_analysis";
export const FINANCIAL_ANALYSIS_TARGET_TYPE = "research_financial_analysis";

type RiskSeverity = "high" | "medium";
type RiskOperator = "lt" | "gt" | "delta_lt" | "delta_gt";
type RiskRule = { id: string; observationKind: string; metric?: string; frequency: ResearchFinancialFrequency; operator: RiskOperator; threshold: number; severity: RiskSeverity; title: string };

export type FinancialAnalysisRiskFlag = {
  ruleId: string;
  severity: RiskSeverity;
  title: string;
  observationId: string;
  period: string;
  value: number;
  unit: string;
  threshold: number;
  operator: RiskOperator;
  comparisonObservationId?: string;
};

export type FinancialAnalysisSnapshot = {
  schemaVersion: typeof FINANCIAL_ANALYSIS_PROTOCOL_VERSION;
  codeVersion: typeof FINANCIAL_ANALYSIS_CODE_VERSION;
  securityCode: string;
  asOf: string;
  entityType: "non_financial" | "financial" | "unknown";
  dataQuality: {
    status: "available" | "partial" | "blocked";
    sourcePolicy: string;
    statutoryVerification: { status: string; verifiedMetrics: string[]; reason: string };
    statements: unknown[];
    gaps: unknown[];
  };
  periodCoverage: { annual: string[]; quarterly: string[]; ttmEndDate: string | null };
  reportedFacts: Array<{ metric: string; frequency: string; basisId: string; unit: string; points: Array<{ period: string; status: string; value: number | null; formula: string; reasonCodes: string[]; factIds: string[] }> }>;
  derivedObservations: Array<{ id: string; kind: string; metric: string; frequency: string; period: string; comparisonPeriod: string | null; status: string; value: number | null; unit: string; formula: string; reasonCodes: string[]; factIds: string[] }>;
  deterministicFlags: FinancialAnalysisRiskFlag[];
  lineage: { factIds: string[]; sourceIds: string[]; inputFingerprint: string };
};

const coreMetrics = new Set<ResearchFinancialMetric>([
  "revenue", "gross_profit", "cost_of_revenue", "operating_profit", "net_profit", "operating_cash_flow", "capital_expenditure",
  "cash", "total_debt", "total_equity", "total_assets", "current_assets", "current_liabilities", "trade_receivables", "contract_assets",
  "inventory", "trade_payables", "short_term_debt", "long_term_debt", "lease_liabilities", "interest_expense", "dividends_paid",
  "share_repurchases", "share_issuance", "acquisition_spend", "diluted_weighted_average_shares", "diluted_shares",
]);
const coreObservationKinds = new Set([
  "yoy", "qoq", "cagr", "gross_margin", "operating_margin", "net_margin", "free_cash_flow", "free_cash_flow_margin", "cash_conversion",
  "net_debt", "working_capital", "working_capital_to_revenue", "receivables_to_revenue", "inventory_to_revenue", "payables_to_revenue",
  "days_sales_outstanding", "days_inventory_outstanding", "days_payables_outstanding", "cash_conversion_cycle", "current_ratio", "quick_ratio",
  "debt_to_equity", "interest_coverage", "nopat", "invested_capital", "return_on_equity", "return_on_invested_capital", "incremental_roic",
  "net_dilution_rate", "net_profit_per_share", "free_cash_flow_per_share", "capital_expenditure_to_revenue", "net_equity_distribution",
]);
const riskRules = riskRulesJson.rules as RiskRule[];

export function buildFinancialAnalysisSnapshot(input: {
  securityCode: string;
  entityType: "non_financial" | "financial" | "unknown";
  sourcePolicy: string;
  availability: "available" | "partial" | "source_error";
  statutoryGate: { status: string; verifiedMetrics: string[]; reason: string };
  statements: unknown[];
  quality: ResearchFinancialQuality;
}): FinancialAnalysisSnapshot {
  const allSeries = input.quality.series.filter((series) => coreMetrics.has(series.metric));
  const annual = periods(allSeries, "annual", 5);
  const quarterly = periods(allSeries, "quarterly", 8);
  const ttmEndDate = latestPeriodEndDate(allSeries, "ttm");
  const reportedFacts = allSeries
    .filter((series) => series.frequency === "annual" || series.frequency === "quarterly")
    .map((series) => ({
      metric: series.metric,
      frequency: series.frequency,
      basisId: series.basis.id,
      unit: series.unit,
      points: selectSeriesPoints(series, series.frequency === "annual" ? 5 : 8).map(projectPoint),
    }));
  const observations = input.quality.observations
    .filter((item) => coreObservationKinds.has(item.kind))
    .filter((item) => item.frequency === "annual" || item.frequency === "quarterly" || item.frequency === "ttm")
    .filter((item) => withinLatestPeriods(item, annual, quarterly, ttmEndDate))
    .map(projectObservation);
  const flags = buildFinancialAnalysisRiskFlags(input.quality.observations);
  const factIds = [...new Set([...reportedFacts.flatMap((item) => item.points.flatMap((point) => point.factIds)), ...observations.flatMap((item) => item.factIds)])].sort();
  const sourceIds = [...new Set(input.quality.series.flatMap((series) => series.points.flatMap((point) => point.inputs.map((reference) => reference.provenance.sourceId))))].sort();
  const basis = {
    schemaVersion: FINANCIAL_ANALYSIS_PROTOCOL_VERSION,
    codeVersion: FINANCIAL_ANALYSIS_CODE_VERSION,
    securityCode: input.securityCode,
    asOf: latestPeriodEndDate(allSeries, "quarterly") ?? latestPeriodEndDate(allSeries, "annual") ?? "unknown",
    entityType: input.entityType,
    dataQuality: {
      status: input.availability === "source_error" || !reportedFacts.length ? "blocked" : input.availability,
      sourcePolicy: input.sourcePolicy,
      statutoryVerification: { status: input.statutoryGate.status, verifiedMetrics: input.statutoryGate.verifiedMetrics, reason: input.statutoryGate.reason },
      statements: input.statements,
      gaps: input.quality.gaps.slice(0, 120),
    },
    periodCoverage: { annual, quarterly, ttmEndDate },
    reportedFacts,
    derivedObservations: observations,
    deterministicFlags: flags,
    lineage: { factIds, sourceIds, inputFingerprint: "" },
  } satisfies Omit<FinancialAnalysisSnapshot, "lineage"> & { lineage: Omit<FinancialAnalysisSnapshot["lineage"], "inputFingerprint"> & { inputFingerprint: string } };
  basis.lineage.inputFingerprint = stableFingerprint({ ...basis, lineage: { ...basis.lineage, inputFingerprint: undefined } });
  return basis;
}

export function buildFinancialAnalysisRiskFlags(observations: ResearchFinancialObservation[]): FinancialAnalysisRiskFlag[] {
  const flags: FinancialAnalysisRiskFlag[] = [];
  for (const rule of riskRules) {
    const candidates = observations.filter((item) => item.kind === rule.observationKind && item.frequency === rule.frequency
      && (!rule.metric || item.metric === rule.metric) && item.status === "available" && typeof item.value === "number");
    const latest = candidates.sort(compareObservation).at(-1);
    if (!latest || latest.value === null) continue;
    const prior = rule.operator.startsWith("delta_") ? candidates.filter((item) => compareObservation(item, latest) < 0).sort(compareObservation).at(-1) : undefined;
    const measured = prior?.value !== null && prior?.value !== undefined ? latest.value - prior.value : latest.value;
    const triggered = rule.operator === "lt" ? measured < rule.threshold
      : rule.operator === "gt" ? measured > rule.threshold
        : rule.operator === "delta_lt" ? Boolean(prior) && measured < rule.threshold
          : Boolean(prior) && measured > rule.threshold;
    if (!triggered) continue;
    flags.push({ ruleId: rule.id, severity: rule.severity, title: rule.title, observationId: latest.id, period: periodLabel(latest.period), value: measured, unit: latest.unit, threshold: rule.threshold, operator: rule.operator, ...(prior ? { comparisonObservationId: prior.id } : {}) });
  }
  return flags.sort((left, right) => (left.severity === right.severity ? left.ruleId.localeCompare(right.ruleId) : left.severity === "high" ? -1 : 1));
}

export function financialAnalysisPrompt(snapshot: FinancialAnalysisSnapshot): string {
  return `你是严谨的上市公司财务研究员。只使用 <input_data> 内的事实、确定性指标、风险触发与附注证据；不得使用模型记忆、搜索结果或常识补齐数字，也不得重新计算任何数值。\n\n数据数值以 reportedFacts 与 derivedObservations 为唯一主来源。deterministicFlags 是工程规则触发，不等于造假或最终结论；你必须解释可能原因、反证和下期验证项。status 为 missing、incomparable、not_applicable 的指标必须如实说明，不得当作零或安全。dataQuality 为 partial/blocked 时，先说明受影响的核验范围。不得输出目标价、交易建议或总分。\n\n只输出中文 Markdown，并且只包含以下八个 H1：\n# 1. 数据覆盖、口径与可信度\n# 2. 收入增长、同比环比与盈利能力\n# 3. 利润质量、现金流与营运资本\n# 4. 资本效率、再投资与 ROIC\n# 5. 资产负债表、债务与流动性压力\n# 6. 每股价值、稀释与资本配置\n# 7. 财务风险隐患、反证与下期监控\n# 8. 条件化财务综合结论\n\n每项判断均写“依据：observationId/factId”；不得把缺失项隐去。\n\n<input_data>\n${JSON.stringify(snapshot)}\n</input_data>`;
}

function selectSeriesPoints(series: ResearchFinancialSeries, limit: number): ResearchFinancialSeriesPoint[] { return [...series.points].sort((left, right) => comparePeriod(left.period, right.period)).slice(-limit); }
function projectPoint(point: ResearchFinancialSeriesPoint) { return { period: periodLabel(point.period), status: point.status, value: point.value, formula: point.formula, reasonCodes: point.reasonCodes, factIds: point.inputs.map((reference) => reference.factId) }; }
function projectObservation(item: ResearchFinancialObservation) { return { id: item.id, kind: item.kind, metric: item.metric, frequency: item.frequency, period: periodLabel(item.period), comparisonPeriod: item.comparisonPeriod ? periodLabel(item.comparisonPeriod) : null, status: item.status, value: item.value, unit: item.unit, formula: item.formula, reasonCodes: item.reasonCodes, factIds: item.inputs.map((reference) => reference.factId) }; }
function periods(series: ResearchFinancialSeries[], frequency: ResearchFinancialFrequency, limit: number): string[] { return [...new Set(series.filter((item) => item.frequency === frequency).flatMap((item) => item.points.map((point) => periodLabel(point.period))))].sort().slice(-limit); }
function withinLatestPeriods(item: ResearchFinancialObservation, annual: string[], quarterly: string[], ttmEndDate: string | null) { return item.frequency === "annual" ? annual.includes(periodLabel(item.period)) : item.frequency === "quarterly" ? quarterly.includes(periodLabel(item.period)) : item.frequency === "ttm" ? item.period.endDate === ttmEndDate : false; }
function comparePeriod(left: { fiscalYear: number; fiscalQuarter?: number; endDate: string }, right: { fiscalYear: number; fiscalQuarter?: number; endDate: string }) { return left.endDate.localeCompare(right.endDate) || left.fiscalYear - right.fiscalYear || (left.fiscalQuarter ?? 0) - (right.fiscalQuarter ?? 0); }
function compareObservation(left: ResearchFinancialObservation, right: ResearchFinancialObservation) { return comparePeriod(left.period, right.period) || left.id.localeCompare(right.id); }
function periodLabel(period: { kind: string; fiscalYear: number; fiscalQuarter?: number; endDate: string }) { return period.kind === "quarter" ? `${period.fiscalYear}Q${period.fiscalQuarter}` : period.kind === "annual" ? `FY${period.fiscalYear}` : period.endDate; }
function latestPeriodEndDate(series: ResearchFinancialSeries[], frequency: ResearchFinancialFrequency): string | null { return series.filter((item) => item.frequency === frequency).flatMap((item) => item.points.map((point) => point.period.endDate)).sort().at(-1) ?? null; }
function stableFingerprint(value: unknown): string { const text = stableStringify(value); let hash = 2166136261; for (let index = 0; index < text.length; index += 1) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 16777619); } return `fnv1a:${(hash >>> 0).toString(16)}`; }
function stableStringify(value: unknown): string { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`; const record = value as Record<string, unknown>; return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`; }
