import { RESEARCH_FINANCIAL_ANALYSIS_PROMPT } from "../../../generated/prompt-text";
import riskRulesJson from "../../../../config/research-financial-analysis-risk-rules.json";
import type { ResearchFinancialFrequency, ResearchFinancialMetric, ResearchFinancialObservation, ResearchFinancialQuality, ResearchFinancialSeries, ResearchFinancialSeriesPoint } from "./research-financial-quality";

export const FINANCIAL_ANALYSIS_PROTOCOL_VERSION = "financial-analysis-input.v1";
export const FINANCIAL_ANALYSIS_PROMPT_VERSION = "financial-analysis.webqa.v7";
export const FINANCIAL_ANALYSIS_CODE_VERSION = "financial-analysis-code.v7";
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
  reportedFacts: Array<{ metric: string; frequency: string; basisId: string; unit: string; points: Array<{ period: string; status: string; value: number | null; formula: string; reasonCodes: string[]; factIds: string[]; sources: FinancialAnalysisSourceReference[] }> }>;
  derivedObservations: Array<{ id: string; kind: string; metric: string; frequency: string; period: string; comparisonPeriod: string | null; status: string; value: number | null; unit: string; formula: string; reasonCodes: string[]; factIds: string[]; sources: FinancialAnalysisSourceReference[] }>;
  deterministicFlags: FinancialAnalysisRiskFlag[];
  lineage: { factIds: string[]; sourceIds: string[]; inputFingerprint: string };
};

/** A small, immutable source projection lets the model cite a fact without
 * receiving provider payloads or inventing an alternative source. */
type FinancialAnalysisSourceReference = {
  sourceId: string;
  sourceType: string;
  documentId?: string;
  url?: string;
  publishedAt?: string;
  locator?: string;
};

type PromptReportedFactTable = {
  periods: string[];
  rows: Array<{ metric: string; unit: string; values: Array<number | null> }>;
};

type PromptObservationTable = {
  periods: string[];
  rows: Array<{ kind: string; metric: string; comparisonPeriods?: Array<string | null>; values: Array<number | null>; unit: string }>;
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
  const allObservations = [...input.quality.trends, ...input.quality.observations];
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
  const observations = allObservations
    .filter((item) => coreObservationKinds.has(item.kind))
    .filter((item) => item.frequency === "annual" || item.frequency === "quarterly" || item.frequency === "ttm")
    .filter((item) => withinLatestPeriods(item, annual, quarterly, ttmEndDate))
    .map(projectObservation);
  const flags = buildFinancialAnalysisRiskFlags(allObservations);
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
  return RESEARCH_FINANCIAL_ANALYSIS_PROMPT.replace("{{INPUT_DATA}}", JSON.stringify(projectFinancialAnalysisPromptInput(snapshot)));
}

/** Do not spend a model run on a report that lacks one of the primary
 * statements.  A partial statutory verification remains analysable and is
 * disclosed in the report; an unavailable primary three-statement input is
 * not. */
export function assertFinancialAnalysisSnapshotCanRun(snapshot: FinancialAnalysisSnapshot): void {
  if (snapshot.dataQuality.status !== "blocked") return;
  const unavailable = snapshot.dataQuality.statements
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map((item) => item as Record<string, unknown>)
    .filter((item) => Number(item.rows ?? 0) <= 0 || (item.sourceHealth && typeof item.sourceHealth === "object" && (item.sourceHealth as Record<string, unknown>).status === "failed"))
    .map((item) => String(item.statementType ?? "unknown"));
  throw new Error(`financial analysis is blocked until all primary statements are available${unavailable.length ? `: ${unavailable.join(", ")}` : ""}`);
}

/** The full frozen snapshot is durable audit evidence.  WebQA receives a
 * bounded projection instead: enough history to analyse, never a repeated
 * copy of every provenance chain and every unavailable observation. */
/**
 * A model-facing financial projection shared by financial analysis and the
 * full investment-analysis task. The complete quality read model is for
 * application inspection only and must never be sent to a remote executor.
 */
export function projectFinancialAnalysisPromptInput(snapshot: FinancialAnalysisSnapshot) {
  const flagObservationIds = new Set(snapshot.deterministicFlags.flatMap((flag) => [flag.observationId, flag.comparisonObservationId].filter(Boolean)));
  const latestBySeries = new Map<string, number>();
  for (const observation of [...snapshot.derivedObservations].sort(compareProjectedObservation)) {
    const key = `${observation.kind}:${observation.metric}:${observation.frequency}`;
    latestBySeries.set(key, (latestBySeries.get(key) ?? 0) + 1);
  }
  const promptObservations = snapshot.derivedObservations
    .filter((item) => item.status === "available")
    .sort(compareProjectedObservation)
    .filter((item) => {
      const key = `${item.kind}:${item.metric}:${item.frequency}`;
      const rank = latestBySeries.get(key) ?? 0;
      latestBySeries.set(key, rank - 1);
      return rank <= 2 || flagObservationIds.has(item.id);
    });
  const compactReportedFactTables = buildReportedFactTables(snapshot.reportedFacts);
  const compactObservationTables = buildObservationTables(promptObservations);
  return {
    schemaVersion: snapshot.schemaVersion,
    codeVersion: snapshot.codeVersion,
    securityCode: snapshot.securityCode,
    asOf: snapshot.asOf,
    entityType: snapshot.entityType,
    dataQuality: {
      status: snapshot.dataQuality.status,
      sourcePolicy: snapshot.dataQuality.sourcePolicy,
      statutoryVerification: snapshot.dataQuality.statutoryVerification,
      statements: snapshot.dataQuality.statements.map(compactStatementHealth),
      gapSummary: summarizeGaps(snapshot.dataQuality.gaps),
    },
    periodCoverage: snapshot.periodCoverage,
    reportedFactTables: compactReportedFactTables,
    observationTables: compactObservationTables,
    analysisBrief: buildAnalysisBrief(compactReportedFactTables, compactObservationTables),
    deterministicFlags: snapshot.deterministicFlags.map(compactRiskFlag),
    numericDisplay: { amountUnit: "亿元", shareUnit: "亿股", percentageDecimals: 2 },
    lineage: { inputFingerprint: snapshot.lineage.inputFingerprint, factCount: snapshot.lineage.factIds.length, sourceCount: snapshot.lineage.sourceIds.length, fullSnapshotPersisted: true },
  };
}

const annualPromptMetrics = new Set(["revenue", "gross_profit", "operating_profit", "net_profit", "operating_cash_flow", "capital_expenditure", "diluted_weighted_average_shares"]);
const quarterlyFlowPromptMetrics = new Set(["revenue", "gross_profit", "operating_profit", "net_profit", "operating_cash_flow", "capital_expenditure"]);
const quarterlyBalancePromptMetrics = new Set(["cash", "total_debt", "total_equity", "current_assets", "current_liabilities", "trade_receivables", "inventory", "trade_payables", "diluted_shares"]);

function buildReportedFactTables(reportedFacts: FinancialAnalysisSnapshot["reportedFacts"]) {
  const annual = buildReportedFactTable(reportedFacts, "annual");
  const quarterly = buildReportedFactTable(reportedFacts, "quarterly");
  return {
    ...(annual ? { annual } : {}),
    ...(quarterly ? { quarterly } : {}),
  };
}

function buildReportedFactTable(reportedFacts: FinancialAnalysisSnapshot["reportedFacts"], frequency: "annual" | "quarterly"): PromptReportedFactTable | null {
  const rows = reportedFacts
    .filter((series) => series.frequency === frequency)
    .flatMap((series) => projectPromptFactRow(series))
    .sort((left, right) => left.metric.localeCompare(right.metric));
  if (!rows.length) return null;
  const periods = [...new Set(rows.flatMap((row) => row.periods))].sort();
  const compactRows = rows
    .map((row) => ({ metric: row.metric, unit: row.unit, values: periods.map((period) => row.valuesByPeriod.get(period) ?? null) }))
    .filter((row) => row.values.some((value) => value !== null));
  return compactRows.length ? { periods, rows: compactRows } : null;
}

function projectPromptFactRow(series: FinancialAnalysisSnapshot["reportedFacts"][number]) {
  const metricAllowed = series.frequency === "annual" ? annualPromptMetrics.has(series.metric)
    : quarterlyFlowPromptMetrics.has(series.metric) || quarterlyBalancePromptMetrics.has(series.metric);
  if (!metricAllowed) return [];
  const limit = series.frequency === "quarterly" && quarterlyBalancePromptMetrics.has(series.metric) ? 2 : 8;
  const points = series.points.slice(-limit);
  const valuesByPeriod = new Map(points.map((point) => [point.period, compactPromptValue(point.value, series.unit)]));
  return valuesByPeriod.size ? [{ metric: series.metric, unit: compactPromptUnit(series.unit), periods: points.map((point) => point.period), valuesByPeriod }] : [];
}

function buildObservationTables(observations: FinancialAnalysisSnapshot["derivedObservations"]) {
  const annual = buildObservationTable(observations, "annual");
  const quarterly = buildObservationTable(observations, "quarterly");
  const ttm = buildObservationTable(observations, "ttm");
  return {
    ...(annual ? { annual } : {}),
    ...(quarterly ? { quarterly } : {}),
    ...(ttm ? { ttm } : {}),
  };
}

function buildObservationTable(observations: FinancialAnalysisSnapshot["derivedObservations"], frequency: "annual" | "quarterly" | "ttm"): PromptObservationTable | null {
  const selected = observations.filter((item) => item.frequency === frequency);
  if (!selected.length) return null;
  const periods = [...new Set(selected.map((item) => item.period))].sort();
  const grouped = new Map<string, { kind: string; metric: string; unit: string; valuesByPeriod: Map<string, number | null>; comparisonsByPeriod: Map<string, string | null> }>();
  for (const item of selected) {
    const key = `${item.kind}:${item.metric}:${item.unit}`;
    const existing = grouped.get(key) ?? {
      kind: item.kind,
      metric: item.metric,
      unit: compactPromptUnit(item.unit),
      valuesByPeriod: new Map<string, number | null>(),
      comparisonsByPeriod: new Map<string, string | null>(),
    };
    existing.valuesByPeriod.set(item.period, compactPromptValue(item.value, item.unit));
    existing.comparisonsByPeriod.set(item.period, item.comparisonPeriod);
    grouped.set(key, existing);
  }
  const rows = [...grouped.values()]
    .sort((left, right) => left.metric.localeCompare(right.metric) || left.kind.localeCompare(right.kind))
    .map((row) => {
      const comparisonPeriods = periods.map((period) => row.comparisonsByPeriod.get(period) ?? null);
      return {
        kind: row.kind,
        metric: row.metric,
        ...(comparisonPeriods.some((period) => period !== null) ? { comparisonPeriods } : {}),
        values: periods.map((period) => row.valuesByPeriod.get(period) ?? null),
        unit: row.unit,
      };
    })
    .filter((row) => row.values.some((value) => value !== null));
  return rows.length ? { periods, rows } : null;
}

const metricBriefConfigs = [
  { section: "growth_profitability", metric: "revenue" },
  { section: "growth_profitability", metric: "gross_profit" },
  { section: "growth_profitability", metric: "operating_profit" },
  { section: "growth_profitability", metric: "net_profit" },
  { section: "cash_working_capital", metric: "operating_cash_flow" },
  { section: "cash_working_capital", metric: "inventory" },
  { section: "cash_working_capital", metric: "trade_receivables" },
  { section: "cash_working_capital", metric: "trade_payables" },
  { section: "capital_efficiency", metric: "capital_expenditure" },
  { section: "balance_sheet", metric: "cash" },
  { section: "balance_sheet", metric: "total_debt" },
  { section: "balance_sheet", metric: "total_equity" },
  { section: "per_share", metric: "diluted_weighted_average_shares" },
  { section: "per_share", metric: "diluted_shares" },
] as const;

const observationBriefConfigs = [
  { section: "growth_profitability", kind: "gross_margin", metric: "gross_profit" },
  { section: "growth_profitability", kind: "operating_margin", metric: "operating_profit" },
  { section: "growth_profitability", kind: "net_margin", metric: "net_profit" },
  { section: "cash_working_capital", kind: "free_cash_flow", metric: "free_cash_flow" },
  { section: "cash_working_capital", kind: "cash_conversion", metric: "operating_cash_flow" },
  { section: "cash_working_capital", kind: "receivables_to_revenue", metric: "trade_receivables" },
  { section: "cash_working_capital", kind: "inventory_to_revenue", metric: "inventory" },
  { section: "cash_working_capital", kind: "payables_to_revenue", metric: "trade_payables" },
  { section: "capital_efficiency", kind: "capital_expenditure_to_revenue", metric: "capital_expenditure" },
  { section: "capital_efficiency", kind: "return_on_equity", metric: "total_equity" },
  { section: "capital_efficiency", kind: "return_on_invested_capital", metric: "invested_capital" },
  { section: "balance_sheet", kind: "current_ratio", metric: "current_assets" },
  { section: "balance_sheet", kind: "quick_ratio", metric: "current_assets" },
  { section: "balance_sheet", kind: "debt_to_equity", metric: "total_debt" },
  { section: "per_share", kind: "net_profit_per_share", metric: "net_profit" },
  { section: "per_share", kind: "free_cash_flow_per_share", metric: "free_cash_flow" },
  { section: "per_share", kind: "book_value_per_share", metric: "total_equity" },
  { section: "per_share", kind: "net_dilution_rate", metric: "diluted_shares" },
] as const;

function buildAnalysisBrief(
  reportedFactTables: { annual?: PromptReportedFactTable; quarterly?: PromptReportedFactTable },
  observationTables: { annual?: PromptObservationTable; quarterly?: PromptObservationTable; ttm?: PromptObservationTable },
) {
  const metricBriefs = metricBriefConfigs
    .map(({ section, metric }) => buildMetricBrief(section, metric, reportedFactTables, observationTables))
    .filter(Boolean);
  const observationBriefs = observationBriefConfigs
    .map(({ section, kind, metric }) => buildObservationBrief(section, kind, metric, observationTables))
    .filter(Boolean);
  return {
    writingPolicy: {
      focus: "优先引用本摘要中的最新年度、最新季度、同比/环比和关键观察，再给出解释、反证、限制和验证项。",
      avoid: "不要按表格顺序把所有期间和指标逐项重抄成正文；只保留支撑判断所需的关键数字。",
    },
    metricBriefs,
    observationBriefs,
  };
}

function buildMetricBrief(
  section: string,
  metric: string,
  reportedFactTables: { annual?: PromptReportedFactTable; quarterly?: PromptReportedFactTable },
  observationTables: { annual?: PromptObservationTable; quarterly?: PromptObservationTable; ttm?: PromptObservationTable },
) {
  const annualSeries = reportedFactTables.annual?.rows.find((item) => item.metric === metric) ?? null;
  const quarterlySeries = reportedFactTables.quarterly?.rows.find((item) => item.metric === metric) ?? null;
  if (!annualSeries && !quarterlySeries) return null;
  return {
    section,
    metric,
    ...(annualSeries && reportedFactTables.annual ? { latestAnnual: summarizeMetricSeries(metric, "annual", reportedFactTables.annual.periods, annualSeries, observationTables) } : {}),
    ...(quarterlySeries && reportedFactTables.quarterly ? { latestQuarter: summarizeMetricSeries(metric, "quarterly", reportedFactTables.quarterly.periods, quarterlySeries, observationTables) } : {}),
  };
}

function summarizeMetricSeries(
  metric: string,
  frequency: "annual" | "quarterly",
  periods: string[],
  row: { values: Array<number | null> },
  observationTables: { annual?: PromptObservationTable; quarterly?: PromptObservationTable; ttm?: PromptObservationTable },
) {
  const latestIndex = latestValueIndex(row.values);
  if (latestIndex === -1) return null;
  const latestPeriod = periods[latestIndex];
  const latestValue = row.values[latestIndex];
  const yoyObservation = findObservation(observationTables, "yoy", metric, frequency, latestPeriod);
  const qoqObservation = findObservation(observationTables, "qoq", metric, frequency, latestPeriod);
  const cagrObservation = findObservation(observationTables, "cagr", metric, frequency, latestPeriod);
  const previous = valueByPeriod(periods, row.values, frequency === "quarterly" ? qoqObservation?.comparisonPeriod ?? null : yoyObservation?.comparisonPeriod ?? null);
  const previousYear = frequency === "quarterly" ? valueByPeriod(periods, row.values, yoyObservation?.comparisonPeriod ?? null) : null;
  return {
    period: latestPeriod,
    value: latestValue,
    ...(previous ? { previousPeriod: previous.period, previousValue: previous.value } : {}),
    ...(previousYear ? { previousYearPeriod: previousYear.period, previousYearValue: previousYear.value } : {}),
    ...(yoyObservation ? { yoy: yoyObservation.value } : {}),
    ...(qoqObservation ? { qoq: qoqObservation.value } : {}),
    ...(cagrObservation ? { cagr: cagrObservation.value } : {}),
  };
}

function buildObservationBrief(
  section: string,
  kind: string,
  metric: string,
  observationTables: { annual?: PromptObservationTable; quarterly?: PromptObservationTable; ttm?: PromptObservationTable },
) {
  const latestAnnual = latestObservation(observationTables, kind, metric, "annual");
  const latestQuarter = latestObservation(observationTables, kind, metric, "quarterly");
  const latestTtm = latestObservation(observationTables, kind, metric, "ttm");
  if (!latestAnnual && !latestQuarter && !latestTtm) return null;
  return {
    section,
    kind,
    metric,
    ...(latestAnnual ? { latestAnnual } : {}),
    ...(latestQuarter ? { latestQuarter } : {}),
    ...(latestTtm ? { latestTtm } : {}),
  };
}

function latestObservation(
  observationTables: { annual?: PromptObservationTable; quarterly?: PromptObservationTable; ttm?: PromptObservationTable },
  kind: string,
  metric: string,
  frequency: "annual" | "quarterly" | "ttm",
) {
  const table = observationTables[frequency];
  const row = table?.rows.find((item) => item.kind === kind && item.metric === metric);
  if (!table || !row) return null;
  const latestIndex = latestValueIndex(row.values);
  if (latestIndex === -1) return null;
  return {
    period: table.periods[latestIndex],
    ...(row.comparisonPeriods ? { comparisonPeriod: row.comparisonPeriods[latestIndex] ?? null } : {}),
    value: row.values[latestIndex],
    unit: row.unit,
  };
}

function findObservation(
  observationTables: { annual?: PromptObservationTable; quarterly?: PromptObservationTable; ttm?: PromptObservationTable },
  kind: string,
  metric: string,
  frequency: "annual" | "quarterly",
  period: string,
) {
  const table = observationTables[frequency];
  const row = table?.rows.find((item) => item.kind === kind && item.metric === metric);
  if (!table || !row) return null;
  const index = table.periods.indexOf(period);
  if (index === -1) return null;
  const value = row.values[index];
  return value === null || value === undefined ? null : {
    period,
    comparisonPeriod: row.comparisonPeriods?.[index] ?? null,
    value,
  };
}

function latestValueIndex(values: Array<number | null>) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (values[index] !== null) return index;
  }
  return -1;
}

function valueByPeriod(periods: string[], values: Array<number | null>, period: string | null) {
  if (!period) return null;
  const index = periods.indexOf(period);
  if (index === -1) return null;
  const value = values[index];
  return value === null || value === undefined ? null : { period, value };
}

function compactStatementHealth(value: unknown) {
  const item = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const sourceHealth = item.sourceHealth && typeof item.sourceHealth === "object" && !Array.isArray(item.sourceHealth) ? item.sourceHealth as Record<string, unknown> : {};
  return { statementType: item.statementType ?? null, rows: item.rows ?? 0, originProviders: item.originProviders ?? [], reportingCurrencies: item.reportingCurrencies ?? [], latestReportDate: item.latestReportDate ?? null, sourceHealth: sourceHealth.status ?? "unknown" };
}

function compactRiskFlag(flag: FinancialAnalysisRiskFlag) {
  return { ruleId: flag.ruleId, severity: flag.severity, title: flag.title, period: flag.period, ...compactPromptNumber(flag.value, flag.unit), threshold: compactPromptValue(flag.threshold, flag.unit), unit: compactPromptUnit(flag.unit), operator: flag.operator };
}

function compactPromptNumber(value: number | null, unit: string) {
  return { value: compactPromptValue(value, unit), unit: compactPromptUnit(unit) };
}

function compactPromptValue(value: number | null, unit: string): number | null {
  if (value === null) return null;
  const divisor = unit === "CNY" || unit === "shares" ? 100_000_000 : 1;
  const decimals = unit === "CNY" || unit === "shares" || unit === "percent" ? 2 : 4;
  return Number((value / divisor).toFixed(decimals));
}

function compactPromptUnit(unit: string): string {
  if (unit === "CNY") return "亿元";
  if (unit === "shares") return "亿股";
  return unit;
}

function compareProjectedObservation(left: FinancialAnalysisSnapshot["derivedObservations"][number], right: FinancialAnalysisSnapshot["derivedObservations"][number]) {
  return left.period.localeCompare(right.period) || left.id.localeCompare(right.id);
}

function summarizeGaps(gaps: unknown[]) {
  const counts = new Map<string, number>();
  for (const gap of gaps) {
    const record = gap && typeof gap === "object" && !Array.isArray(gap) ? gap as Record<string, unknown> : {};
    const status = typeof record.status === "string" ? record.status : "unknown";
    const reason = Array.isArray(record.reasonCodes) ? record.reasonCodes.filter((item): item is string => typeof item === "string").sort().join(",") : "unspecified";
    const key = `${status}:${reason || "unspecified"}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, count]) => ({ key, count }));
}

function selectSeriesPoints(series: ResearchFinancialSeries, limit: number): ResearchFinancialSeriesPoint[] { return [...series.points].sort((left, right) => comparePeriod(left.period, right.period)).slice(-limit); }
function projectPoint(point: ResearchFinancialSeriesPoint) { return { period: periodLabel(point.period), status: point.status, value: point.value, formula: point.formula, reasonCodes: point.reasonCodes, factIds: point.inputs.map((reference) => reference.factId), sources: projectSources(point.inputs) }; }
function projectObservation(item: ResearchFinancialObservation) { return { id: item.id, kind: item.kind, metric: item.metric, frequency: item.frequency, period: periodLabel(item.period), comparisonPeriod: item.comparisonPeriod ? periodLabel(item.comparisonPeriod) : null, status: item.status, value: item.value, unit: item.unit, formula: item.formula, reasonCodes: item.reasonCodes, factIds: item.inputs.map((reference) => reference.factId), sources: projectSources(item.inputs) }; }
function projectSources(inputs: Array<{ provenance: FinancialAnalysisSourceReference }>): FinancialAnalysisSourceReference[] {
  const seen = new Set<string>();
  return inputs.flatMap(({ provenance }) => {
    const key = `${provenance.sourceId}:${provenance.locator ?? ""}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ ...provenance }];
  });
}
function periods(series: ResearchFinancialSeries[], frequency: ResearchFinancialFrequency, limit: number): string[] { return [...new Set(series.filter((item) => item.frequency === frequency).flatMap((item) => item.points.map((point) => periodLabel(point.period))))].sort().slice(-limit); }
function withinLatestPeriods(item: ResearchFinancialObservation, annual: string[], quarterly: string[], ttmEndDate: string | null) { return item.frequency === "annual" ? annual.includes(periodLabel(item.period)) : item.frequency === "quarterly" ? quarterly.includes(periodLabel(item.period)) : item.frequency === "ttm" ? item.period.endDate === ttmEndDate : false; }
function comparePeriod(left: { fiscalYear: number; fiscalQuarter?: number; endDate: string }, right: { fiscalYear: number; fiscalQuarter?: number; endDate: string }) { return left.endDate.localeCompare(right.endDate) || left.fiscalYear - right.fiscalYear || (left.fiscalQuarter ?? 0) - (right.fiscalQuarter ?? 0); }
function compareObservation(left: ResearchFinancialObservation, right: ResearchFinancialObservation) { return comparePeriod(left.period, right.period) || left.id.localeCompare(right.id); }
function periodLabel(period: { kind: string; fiscalYear: number; fiscalQuarter?: number; endDate: string }) { return period.kind === "quarter" ? `${period.fiscalYear}Q${period.fiscalQuarter}` : period.kind === "annual" ? `FY${period.fiscalYear}` : period.endDate; }
function latestPeriodEndDate(series: ResearchFinancialSeries[], frequency: ResearchFinancialFrequency): string | null { return series.filter((item) => item.frequency === frequency).flatMap((item) => item.points.map((point) => point.period.endDate)).sort().at(-1) ?? null; }
function stableFingerprint(value: unknown): string { const text = stableStringify(value); let hash = 2166136261; for (let index = 0; index < text.length; index += 1) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 16777619); } return `fnv1a:${(hash >>> 0).toString(16)}`; }
function stableStringify(value: unknown): string { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`; const record = value as Record<string, unknown>; return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`; }
