export type ResearchFinancialFrequency = "annual" | "quarterly" | "ttm";
export type ResearchFinancialStatus = "available" | "missing" | "incomparable" | "not_applicable";

export type ResearchFinancialMetric =
  | "revenue"
  | "gross_profit"
  | "operating_profit"
  | "net_profit"
  | "operating_cash_flow"
  | "capital_expenditure"
  | "cost_of_revenue"
  | "cash"
  | "total_debt"
  | "total_equity"
  | "total_assets"
  | "current_assets"
  | "current_liabilities"
  | "trade_receivables"
  | "contract_assets"
  | "inventory"
  | "trade_payables"
  | "short_term_debt"
  | "long_term_debt"
  | "lease_liabilities"
  | "interest_expense"
  | "pre_tax_profit"
  | "income_tax_expense"
  | "dividends_paid"
  | "share_repurchases"
  | "share_issuance"
  | "acquisition_spend"
  | "debt_repayment"
  | "diluted_weighted_average_shares"
  | "diluted_shares";

export type ResearchFinancialPeriod = {
  kind: "annual" | "quarter";
  startDate: string;
  endDate: string;
  fiscalYear: number;
  fiscalQuarter?: 1 | 2 | 3 | 4;
};

export type ResearchFinancialBasis = {
  /** Stable upstream identifier for the normalized accounting basis. */
  id: string;
  currency: string;
  accountingStandard: string;
  scope: string;
  revision: string;
};

export type ResearchFinancialProvenance = {
  sourceId: string;
  sourceType: string;
  documentId?: string;
  url?: string;
  publishedAt?: string;
  locator?: string;
};

export type StandardizedResearchFinancialFact = {
  id: string;
  /**
   * Stable statutory-comparison identity. New source normalizers must set it;
   * historical observations may lack it and remain visibly legacy-only.
   */
  canonicalComparisonKey?: string;
  metric: ResearchFinancialMetric;
  period: ResearchFinancialPeriod;
  /** Money values are normalized to base currency units; share values are actual shares. */
  value: number | null;
  basis: ResearchFinancialBasis;
  provenance: ResearchFinancialProvenance;
  /** Deterministic calculation used to turn reported inputs into this fact. */
  derivationFormula?: string;
  /** A failed bridge remains visible as a data-quality state, never as zero. */
  derivationStatus?: Exclude<ResearchFinancialStatus, "available" | "not_applicable">;
  derivationReasonCodes?: string[];
  /**
   * A derived fact may expose the exact reported inputs it was bridged from.
   * Source facts keep the default single self-reference.  This prevents a
   * cumulative-to-quarter conversion from obscuring the original disclosures.
   */
  inputReferences?: ResearchFinancialInputReference[];
};

export type ResearchFinancialInputReference = {
  factId: string;
  provenance: ResearchFinancialProvenance;
};

export type ResearchFinancialSeriesPoint = {
  period: ResearchFinancialPeriod;
  status: ResearchFinancialStatus;
  value: number | null;
  formula: string;
  reasonCodes: string[];
  inputs: ResearchFinancialInputReference[];
};

export type ResearchFinancialSeries = {
  metric: ResearchFinancialMetric;
  frequency: ResearchFinancialFrequency;
  basis: ResearchFinancialBasis;
  unit: string;
  points: ResearchFinancialSeriesPoint[];
};

export type ResearchFinancialObservationKind =
  | "yoy"
  | "qoq"
  | "cagr"
  | "gross_margin"
  | "operating_margin"
  | "net_margin"
  | "free_cash_flow"
  | "free_cash_flow_margin"
  | "cash_conversion"
  | "net_debt"
  | "net_profit_per_share"
  | "free_cash_flow_per_share"
  | "book_value_per_share"
  | "working_capital"
  | "working_capital_to_revenue"
  | "receivables_to_revenue"
  | "inventory_to_revenue"
  | "payables_to_revenue"
  | "days_sales_outstanding"
  | "days_inventory_outstanding"
  | "days_payables_outstanding"
  | "cash_conversion_cycle"
  | "current_ratio"
  | "quick_ratio"
  | "debt_to_equity"
  | "interest_coverage"
  | "effective_tax_rate"
  | "nopat"
  | "invested_capital"
  | "return_on_equity"
  | "return_on_assets"
  | "return_on_invested_capital"
  | "incremental_roic"
  | "net_dilution_rate"
  | "shareholder_distributions"
  | "net_equity_distribution"
  | "capital_expenditure_to_revenue";

export type ResearchFinancialDerivedMetric =
  | "free_cash_flow"
  | "net_debt"
  | "working_capital"
  | "nopat"
  | "invested_capital"
  | "shareholder_distributions"
  | "net_equity_distribution";

export type ResearchFinancialObservation = {
  id: string;
  kind: ResearchFinancialObservationKind;
  metric: ResearchFinancialMetric | ResearchFinancialDerivedMetric;
  frequency: ResearchFinancialFrequency;
  basis: ResearchFinancialBasis;
  period: ResearchFinancialPeriod;
  comparisonPeriod?: ResearchFinancialPeriod;
  status: ResearchFinancialStatus;
  value: number | null;
  unit: string;
  formula: string;
  reasonCodes: string[];
  inputs: ResearchFinancialInputReference[];
};

export type ResearchFinancialGap = {
  observationId: string;
  status: Exclude<ResearchFinancialStatus, "available">;
  reasonCodes: string[];
};

export type ResearchFinancialQualityInput = {
  facts: StandardizedResearchFinancialFact[];
  /** Unknown is deliberate: a security code/name cannot classify a bank. */
  entityType?: "non_financial" | "financial" | "unknown";
};

export type ResearchFinancialQuality = {
  ruleVersion: string;
  series: ResearchFinancialSeries[];
  trends: ResearchFinancialObservation[];
  observations: ResearchFinancialObservation[];
  gaps: ResearchFinancialGap[];
};

export const RESEARCH_FINANCIAL_QUALITY_RULE_VERSION = "research-financial-quality.v2";

type Aggregation = "sum" | "average" | "ending";

const metricAggregation: Record<ResearchFinancialMetric, Aggregation> = {
  revenue: "sum",
  gross_profit: "sum",
  operating_profit: "sum",
  net_profit: "sum",
  operating_cash_flow: "sum",
  capital_expenditure: "sum",
  cost_of_revenue: "sum",
  cash: "ending",
  total_debt: "ending",
  total_equity: "ending",
  total_assets: "ending",
  current_assets: "ending",
  current_liabilities: "ending",
  trade_receivables: "ending",
  contract_assets: "ending",
  inventory: "ending",
  trade_payables: "ending",
  short_term_debt: "ending",
  long_term_debt: "ending",
  lease_liabilities: "ending",
  interest_expense: "sum",
  pre_tax_profit: "sum",
  income_tax_expense: "sum",
  dividends_paid: "sum",
  share_repurchases: "sum",
  share_issuance: "sum",
  acquisition_spend: "sum",
  debt_repayment: "sum",
  diluted_weighted_average_shares: "average",
  diluted_shares: "ending",
};

const shareMetrics = new Set<ResearchFinancialMetric>([
  "diluted_weighted_average_shares",
  "diluted_shares",
]);

export function buildResearchFinancialQuality(
  input: ResearchFinancialQualityInput,
): ResearchFinancialQuality {
  validateFacts(input.facts);
  const normalizedSeries = buildNormalizedSeries(input.facts);
  const ttmSeries = buildTtmSeries(normalizedSeries);
  const series = [...normalizedSeries, ...ttmSeries].sort(compareSeries);
  const trends = series.flatMap(buildTrendObservations);
  const observations = buildQualityObservations(
    series,
    input.facts,
    // Callers without a company identity are retained for pure mechanical
    // calculation/tests. The company read model always supplies the resolved
    // profile and therefore never takes this compatibility default.
    input.entityType ?? "non_financial",
  );
  const gaps = [...trends, ...observations]
    .filter((item): item is ResearchFinancialObservation & {
      status: Exclude<ResearchFinancialStatus, "available">;
    } => item.status !== "available")
    .map((item) => ({
      observationId: item.id,
      status: item.status,
      reasonCodes: item.reasonCodes,
    }));
  return {
    ruleVersion: RESEARCH_FINANCIAL_QUALITY_RULE_VERSION,
    series,
    trends,
    observations,
    gaps,
  };
}

function validateFacts(facts: StandardizedResearchFinancialFact[]): void {
  const ids = new Set<string>();
  for (const fact of facts) {
    if (!fact.id.trim() || ids.has(fact.id)) {
      throw new Error(`financial fact id must be non-empty and unique: ${fact.id}`);
    }
    ids.add(fact.id);
    if (fact.value !== null && !Number.isFinite(fact.value)) {
      throw new Error(`financial fact value must be finite or null: ${fact.id}`);
    }
    if (!fact.basis.id.trim() || !fact.basis.currency.trim() || !fact.basis.accountingStandard.trim()
      || !fact.basis.scope.trim() || !fact.basis.revision.trim()) {
      throw new Error(`financial fact basis is incomplete: ${fact.id}`);
    }
    if (!fact.provenance.sourceId.trim() || !fact.provenance.sourceType.trim()) {
      throw new Error(`financial fact provenance is incomplete: ${fact.id}`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fact.period.startDate)
      || !/^\d{4}-\d{2}-\d{2}$/.test(fact.period.endDate)
      || fact.period.startDate > fact.period.endDate) {
      throw new Error(`financial fact period is invalid: ${fact.id}`);
    }
    if (fact.period.kind === "quarter" && ![1, 2, 3, 4].includes(fact.period.fiscalQuarter ?? 0)) {
      throw new Error(`quarterly financial fact requires fiscalQuarter: ${fact.id}`);
    }
    if (fact.period.kind === "annual" && fact.period.fiscalQuarter !== undefined) {
      throw new Error(`annual financial fact cannot have fiscalQuarter: ${fact.id}`);
    }
  }
}

function buildNormalizedSeries(facts: StandardizedResearchFinancialFact[]): ResearchFinancialSeries[] {
  const groups = new Map<string, StandardizedResearchFinancialFact[]>();
  for (const fact of facts) {
    const frequency = fact.period.kind === "annual" ? "annual" : "quarterly";
    const key = `${basisKey(fact.basis)}|${fact.metric}|${frequency}`;
    const values = groups.get(key) ?? [];
    values.push(fact);
    groups.set(key, values);
  }
  const result: ResearchFinancialSeries[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    const frequency = first.period.kind === "annual" ? "annual" : "quarterly";
    const byPeriod = new Map<string, StandardizedResearchFinancialFact[]>();
    for (const fact of group) {
      const values = byPeriod.get(periodKey(fact.period)) ?? [];
      values.push(fact);
      byPeriod.set(periodKey(fact.period), values);
    }
    const points = [...byPeriod.values()].map(sourcePoint).sort((a, b) => comparePeriod(a.period, b.period));
    result.push({
      metric: first.metric,
      frequency,
      basis: first.basis,
      unit: metricUnit(first.metric, first.basis),
      points,
    });
  }
  return result;
}

function sourcePoint(facts: StandardizedResearchFinancialFact[]): ResearchFinancialSeriesPoint {
  const available = facts.filter((fact): fact is StandardizedResearchFinancialFact & { value: number } => fact.value !== null);
  const distinct = [...new Set(available.map((fact) => fact.value))];
  const inputs = factReferences(facts);
  const failedBridge = facts.find((fact) => fact.derivationStatus);
  if (failedBridge?.derivationStatus) {
    return {
      period: facts[0].period,
      status: failedBridge.derivationStatus,
      value: null,
      formula: failedBridge.derivationFormula ?? "source fact",
      reasonCodes: failedBridge.derivationReasonCodes ?? ["derived_fact_unavailable"],
      inputs,
    };
  }
  if (distinct.length > 1) {
    return {
      period: facts[0].period,
      status: "incomparable",
      value: null,
      formula: facts[0].derivationFormula ?? "source fact",
      reasonCodes: ["conflicting_source_values"],
      inputs,
    };
  }
  if (distinct.length === 0) {
    return {
      period: facts[0].period,
      status: "missing",
      value: null,
      formula: facts[0].derivationFormula ?? "source fact",
      reasonCodes: ["source_value_missing"],
      inputs,
    };
  }
  return {
    period: facts[0].period,
    status: "available",
    value: distinct[0],
    formula: facts[0].derivationFormula ?? "source fact",
    reasonCodes: [],
    inputs,
  };
}

function buildTtmSeries(series: ResearchFinancialSeries[]): ResearchFinancialSeries[] {
  const result: ResearchFinancialSeries[] = [];
  for (const item of series.filter((candidate) => candidate.frequency === "quarterly")) {
    const aggregation = metricAggregation[item.metric];
    if (aggregation === "ending") continue;
    const byQuarter = new Map(item.points.map((point) => [quarterIndex(point.period), point]));
    const points = item.points.map((ending) => {
      const endIndex = quarterIndex(ending.period);
      const window = [endIndex - 3, endIndex - 2, endIndex - 1, endIndex]
        .map((index) => byQuarter.get(index));
      const present = window.filter((point): point is ResearchFinancialSeriesPoint => Boolean(point));
      if (present.length !== 4) {
        return unavailableSeriesPoint(
          ttmPeriod(ending.period, present[0]?.period.startDate),
          "missing",
          "four consecutive quarterly facts",
          ["insufficient_quarter_history"],
          present.flatMap((point) => point.inputs),
        );
      }
      const unusable = present.find((point) => point.status !== "available");
      if (unusable) {
        return unavailableSeriesPoint(
          ttmPeriod(ending.period, present[0]?.period.startDate),
          unusable.status === "incomparable" ? "incomparable" : "missing",
          aggregation === "sum" ? "sum(last four quarters)" : "average(last four quarters)",
          unusable.reasonCodes,
          present.flatMap((point) => point.inputs),
        );
      }
      const values = present.map((point) => point.value!);
      return {
        period: ttmPeriod(ending.period, present[0].period.startDate),
        status: "available" as const,
        value: aggregation === "sum"
          ? values.reduce((sum, value) => sum + value, 0)
          : values.reduce((sum, value) => sum + value, 0) / values.length,
        formula: aggregation === "sum" ? "sum(last four quarters)" : "average(last four quarters)",
        reasonCodes: [],
        inputs: dedupeReferences(present.flatMap((point) => point.inputs)),
      };
    });
    result.push({ ...item, frequency: "ttm", points });
  }
  return result;
}

function buildTrendObservations(series: ResearchFinancialSeries): ResearchFinancialObservation[] {
  const result: ResearchFinancialObservation[] = [];
  const byIndex = new Map(series.points.map((point) => [periodIndex(point.period), point]));
  for (const point of series.points) {
    if (series.frequency === "annual") {
      const previous = byIndex.get(periodIndex(point.period) - 1);
      if (previous) result.push(changeObservation(series, "yoy", previous, point, 1));
      continue;
    }
    if (series.frequency === "quarterly") {
      const previousQuarter = byIndex.get(periodIndex(point.period) - 1);
      const previousYear = byIndex.get(periodIndex(point.period) - 4);
      if (previousQuarter) result.push(changeObservation(series, "qoq", previousQuarter, point, 1));
      if (previousYear) result.push(changeObservation(series, "yoy", previousYear, point, 1));
      continue;
    }
    const previousYear = byIndex.get(periodIndex(point.period) - 4);
    if (previousYear) result.push(changeObservation(series, "yoy", previousYear, point, 1));
  }
  if (series.frequency === "annual") {
    const available = series.points.filter((point) => point.status === "available");
    const first = available[0];
    const last = available.at(-1);
    const years = first && last ? last.period.fiscalYear - first.period.fiscalYear : 0;
    if (first && last && years > 1) {
      result.push(changeObservation(series, "cagr", first, last, years));
    }
  }
  return result;
}

function changeObservation(
  series: ResearchFinancialSeries,
  kind: "yoy" | "qoq" | "cagr",
  from: ResearchFinancialSeriesPoint,
  to: ResearchFinancialSeriesPoint,
  intervals: number,
): ResearchFinancialObservation {
  const base = observationBase(series, kind, to.period);
  const inputs = dedupeReferences([...from.inputs, ...to.inputs]);
  if (from.status !== "available" || to.status !== "available") {
    const status = from.status === "incomparable" || to.status === "incomparable"
      ? "incomparable" : "missing";
    return {
      ...base,
      comparisonPeriod: from.period,
      status,
      value: null,
      unit: "percent",
      formula: kind === "cagr" ? "(current / prior)^(1 / years) - 1" : "current / prior - 1",
      reasonCodes: dedupeStrings([...from.reasonCodes, ...to.reasonCodes]),
      inputs,
    };
  }
  if (from.value === 0 || (kind === "cagr" && (from.value! < 0 || to.value! < 0))) {
    return {
      ...base,
      comparisonPeriod: from.period,
      status: "not_applicable",
      value: null,
      unit: "percent",
      formula: kind === "cagr" ? "(current / prior)^(1 / years) - 1" : "current / prior - 1",
      reasonCodes: [kind === "cagr" ? "cagr_requires_positive_values" : "zero_comparison_denominator"],
      inputs,
    };
  }
  const value = kind === "cagr"
    ? (Math.pow(to.value! / from.value!, 1 / intervals) - 1) * 100
    : (to.value! / from.value! - 1) * 100;
  return {
    ...base,
    comparisonPeriod: from.period,
    status: "available",
    value,
    unit: "percent",
    formula: kind === "cagr" ? "(current / prior)^(1 / years) - 1" : "current / prior - 1",
    reasonCodes: [],
    inputs,
  };
}

function buildQualityObservations(
  series: ResearchFinancialSeries[],
  facts: StandardizedResearchFinancialFact[],
  entityType: "non_financial" | "financial" | "unknown",
): ResearchFinancialObservation[] {
  const result: ResearchFinancialObservation[] = [];
  const basisGroups = uniqueBases(series);
  for (const basis of basisGroups) {
    for (const frequency of ["annual", "quarterly", "ttm"] as const) {
      const group = series.filter((item) => basisKey(item.basis) === basisKey(basis) && item.frequency === frequency);
      const periods = uniquePeriods(group.flatMap((item) => item.points.map((point) => point.period)));
      for (const period of periods) {
        result.push(ratioObservation(group, facts, basis, frequency, period, "gross_margin", "gross_profit", "revenue"));
        result.push(ratioObservation(group, facts, basis, frequency, period, "operating_margin", "operating_profit", "revenue"));
        result.push(ratioObservation(group, facts, basis, frequency, period, "net_margin", "net_profit", "revenue"));
        result.push(freeCashFlowObservation(group, facts, basis, frequency, period, entityType));
        result.push(freeCashFlowMarginObservation(group, facts, basis, frequency, period, entityType));
        result.push(ratioObservation(group, facts, basis, frequency, period, "capital_expenditure_to_revenue", "capital_expenditure", "revenue"));
        result.push(cashConversionObservation(group, facts, basis, frequency, period, entityType));
        result.push(perShareObservation(group, facts, basis, frequency, period, "net_profit_per_share", "net_profit", "diluted_weighted_average_shares"));
        result.push(perShareObservation(group, facts, basis, frequency, period, "free_cash_flow_per_share", "free_cash_flow", "diluted_weighted_average_shares", entityType));
        result.push(effectiveTaxRateObservation(group, facts, basis, frequency, period));
        result.push(nopatObservation(group, facts, basis, frequency, period, entityType));
        result.push(shareholderDistributionsObservation(group, facts, basis, frequency, period));
        result.push(netEquityDistributionObservation(group, facts, basis, frequency, period));
      }
    }
    for (const frequency of ["annual", "quarterly"] as const) {
      const group = series.filter((item) => basisKey(item.basis) === basisKey(basis) && item.frequency === frequency);
      const periods = uniquePeriods(group.flatMap((item) => item.points.map((point) => point.period)));
      for (const period of periods) {
        result.push(netDebtObservation(group, facts, basis, frequency, period));
        result.push(perShareObservation(group, facts, basis, frequency, period, "book_value_per_share", "total_equity", "diluted_shares"));
        result.push(workingCapitalObservation(group, facts, basis, frequency, period, entityType));
        result.push(workingCapitalToRevenueObservation(group, facts, basis, frequency, period, entityType));
        result.push(ratioObservation(group, facts, basis, frequency, period, "receivables_to_revenue", "trade_receivables", "revenue"));
        result.push(ratioObservation(group, facts, basis, frequency, period, "inventory_to_revenue", "inventory", "revenue"));
        result.push(ratioObservation(group, facts, basis, frequency, period, "payables_to_revenue", "trade_payables", "revenue"));
        result.push(currentRatioObservation(group, facts, basis, frequency, period, entityType));
        result.push(quickRatioObservation(group, facts, basis, frequency, period, entityType));
        result.push(ratioObservation(group, facts, basis, frequency, period, "debt_to_equity", "total_debt", "total_equity"));
        result.push(interestCoverageObservation(group, facts, basis, frequency, period, entityType));
        result.push(dsoObservation(group, facts, basis, frequency, period, entityType));
        result.push(dioObservation(group, facts, basis, frequency, period, entityType));
        result.push(dpoObservation(group, facts, basis, frequency, period, entityType));
        result.push(cashConversionCycleObservation(result, basis, frequency, period, entityType));
        result.push(investedCapitalObservation(group, facts, basis, frequency, period, entityType));
        result.push(netDilutionRateObservation(group, facts, basis, frequency, period));
      }
    }
    result.push(...returnOnCapitalObservations(series, facts, basis, entityType));
  }
  return entityType === "unknown" ? blockUnclassifiedFinancialEntityMetrics(result) : result;
}

// Most of these mechanics assume an industrial/non-financial balance sheet.
// A missing profile is not evidence that the assumption holds, so preserve the
// direct reported series but prevent those derived values from being displayed
// as financial quality conclusions. Free cash flow is intentionally excluded:
// when both current-security cash-flow inputs share a period and basis, its
// disclosed arithmetic remains auditable even while broader entity-specific
// conclusions stay blocked. Confirmed financial entities still mark FCF as
// not applicable in freeCashFlowObservation.
const unclassifiedEntityMetricKinds = new Set<ResearchFinancialObservationKind>([
  "free_cash_flow_margin", "cash_conversion", "free_cash_flow_per_share",
  "nopat", "working_capital", "working_capital_to_revenue", "current_ratio", "quick_ratio",
  "interest_coverage", "days_sales_outstanding", "days_inventory_outstanding", "days_payables_outstanding",
  "cash_conversion_cycle", "invested_capital", "return_on_assets", "return_on_invested_capital", "incremental_roic",
]);
function blockUnclassifiedFinancialEntityMetrics(observations: ResearchFinancialObservation[]): ResearchFinancialObservation[] {
  return observations.map((item) => unclassifiedEntityMetricKinds.has(item.kind)
    ? { ...item, status: "missing" as const, value: null, reasonCodes: ["entity_financial_profile_unconfirmed"], inputs: [] }
    : item);
}

function ratioObservation(
  series: ResearchFinancialSeries[],
  facts: StandardizedResearchFinancialFact[],
  basis: ResearchFinancialBasis,
  frequency: ResearchFinancialFrequency,
  period: ResearchFinancialPeriod,
  kind: "gross_margin" | "operating_margin" | "net_margin" | "capital_expenditure_to_revenue"
    | "receivables_to_revenue" | "inventory_to_revenue" | "payables_to_revenue" | "debt_to_equity"
    | "current_ratio" | "interest_coverage",
  numeratorMetric: ResearchFinancialMetric,
  denominatorMetric: ResearchFinancialMetric,
): ResearchFinancialObservation {
  const numerator = findPoint(series, numeratorMetric, period);
  const denominator = findPoint(series, denominatorMetric, period);
  return divideObservation({
    facts, basis, frequency, period, kind, metric: numeratorMetric,
    numerator, denominator, numeratorMetric, denominatorMetric,
    unit: "percent", multiplier: 100,
    formula: `${numeratorMetric} / ${denominatorMetric}`,
  });
}

function freeCashFlowMarginObservation(
  series: ResearchFinancialSeries[], facts: StandardizedResearchFinancialFact[], basis: ResearchFinancialBasis,
  frequency: ResearchFinancialFrequency, period: ResearchFinancialPeriod, entityType: "non_financial" | "financial" | "unknown",
): ResearchFinancialObservation {
  const base = observationBaseFor("free_cash_flow_margin", "free_cash_flow", basis, frequency, period);
  if (entityType === "financial") return notApplicable(base, "free_cash_flow / revenue", "financial_company_fcf_not_applicable");
  const fcf = observationAsPoint(freeCashFlowObservation(series, facts, basis, frequency, period, entityType));
  const revenue = findPoint(series, "revenue", period);
  return divideAvailablePoints(base, "free_cash_flow / revenue", "percent", 100, [fcf, revenue], ["free_cash_flow", "revenue"]);
}

function workingCapitalObservation(
  series: ResearchFinancialSeries[], facts: StandardizedResearchFinancialFact[], basis: ResearchFinancialBasis,
  frequency: "annual" | "quarterly", period: ResearchFinancialPeriod, entityType: "non_financial" | "financial" | "unknown",
): ResearchFinancialObservation {
  const base = observationBaseFor("working_capital", "working_capital", basis, frequency, period);
  if (entityType === "financial") return notApplicable(base, "trade_receivables + contract_assets + inventory - trade_payables", "financial_company_working_capital_not_applicable");
  const receivables = findPoint(series, "trade_receivables", period);
  const contractAssets = findPoint(series, "contract_assets", period);
  const inventory = findPoint(series, "inventory", period);
  const payables = findPoint(series, "trade_payables", period);
  const unavailable = unavailableForInputs(base, facts, ["trade_receivables", "contract_assets", "inventory", "trade_payables"], period, basis, [receivables, contractAssets, inventory, payables]);
  if (unavailable) return { ...unavailable, formula: "trade_receivables + contract_assets + inventory - trade_payables", unit: basis.currency };
  return {
    ...base, status: "available", value: receivables!.value! + contractAssets!.value! + inventory!.value! - payables!.value!,
    unit: basis.currency, formula: "trade_receivables + contract_assets + inventory - trade_payables", reasonCodes: [],
    inputs: dedupeReferences([receivables!, contractAssets!, inventory!, payables!].flatMap((point) => point.inputs)),
  };
}

function workingCapitalToRevenueObservation(
  series: ResearchFinancialSeries[], facts: StandardizedResearchFinancialFact[], basis: ResearchFinancialBasis,
  frequency: "annual" | "quarterly", period: ResearchFinancialPeriod, entityType: "non_financial" | "financial" | "unknown",
): ResearchFinancialObservation {
  const base = observationBaseFor("working_capital_to_revenue", "working_capital", basis, frequency, period);
  if (entityType === "financial") return notApplicable(base, "working_capital / revenue", "financial_company_working_capital_not_applicable");
  const workingCapital = observationAsPoint(workingCapitalObservation(series, facts, basis, frequency, period, entityType));
  const revenue = findPoint(series, "revenue", period);
  return divideAvailablePoints(base, "working_capital / revenue", "percent", 100, [workingCapital, revenue], ["working_capital", "revenue"]);
}

function currentRatioObservation(
  series: ResearchFinancialSeries[], facts: StandardizedResearchFinancialFact[], basis: ResearchFinancialBasis,
  frequency: "annual" | "quarterly", period: ResearchFinancialPeriod, entityType: "non_financial" | "financial" | "unknown",
): ResearchFinancialObservation {
  const base = observationBaseFor("current_ratio", "current_assets", basis, frequency, period);
  if (entityType === "financial") return notApplicable(base, "current_assets / current_liabilities", "financial_company_current_ratio_not_applicable");
  return divideObservation({ facts, basis, frequency, period, kind: "current_ratio", metric: "current_assets",
    numerator: findPoint(series, "current_assets", period), denominator: findPoint(series, "current_liabilities", period),
    numeratorMetric: "current_assets", denominatorMetric: "current_liabilities", unit: "times", multiplier: 1,
    formula: "current_assets / current_liabilities" });
}

function quickRatioObservation(
  series: ResearchFinancialSeries[], facts: StandardizedResearchFinancialFact[], basis: ResearchFinancialBasis,
  frequency: "annual" | "quarterly", period: ResearchFinancialPeriod, entityType: "non_financial" | "financial" | "unknown",
): ResearchFinancialObservation {
  const base = observationBaseFor("quick_ratio", "current_assets", basis, frequency, period);
  if (entityType === "financial") return notApplicable(base, "(cash + trade_receivables + contract_assets) / current_liabilities", "financial_company_quick_ratio_not_applicable");
  const cash = findPoint(series, "cash", period);
  const receivables = findPoint(series, "trade_receivables", period);
  const contractAssets = findPoint(series, "contract_assets", period);
  const liabilities = findPoint(series, "current_liabilities", period);
  const quickAssets = combinePoints(base, "quick_assets", "cash + trade_receivables + contract_assets", basis.currency, [cash, receivables, contractAssets], ["cash", "trade_receivables", "contract_assets"]);
  return divideAvailablePoints(base, "(cash + trade_receivables + contract_assets) / current_liabilities", "times", 1, [quickAssets, liabilities], ["quick_assets", "current_liabilities"]);
}

function interestCoverageObservation(
  series: ResearchFinancialSeries[], facts: StandardizedResearchFinancialFact[], basis: ResearchFinancialBasis,
  frequency: "annual" | "quarterly", period: ResearchFinancialPeriod, entityType: "non_financial" | "financial" | "unknown",
): ResearchFinancialObservation {
  const base = observationBaseFor("interest_coverage", "operating_profit", basis, frequency, period);
  if (entityType === "financial") return notApplicable(base, "operating_profit / interest_expense", "financial_company_interest_coverage_not_applicable");
  const operatingProfit = findPoint(series, "operating_profit", period);
  const interest = findPoint(series, "interest_expense", period);
  const result = divideObservation({ facts, basis, frequency, period, kind: "interest_coverage", metric: "operating_profit",
    numerator: operatingProfit, denominator: interest, numeratorMetric: "operating_profit", denominatorMetric: "interest_expense",
    unit: "times", multiplier: 1, formula: "operating_profit / interest_expense" });
  if (result.status !== "available") return result;
  if (operatingProfit!.value! <= 0 || interest!.value! <= 0) return {
    ...result, status: "not_applicable", value: null, reasonCodes: [operatingProfit!.value! <= 0 ? "non_positive_operating_profit" : "non_positive_interest_expense"],
  };
  return result;
}

function effectiveTaxRateObservation(
  series: ResearchFinancialSeries[], facts: StandardizedResearchFinancialFact[], basis: ResearchFinancialBasis,
  frequency: ResearchFinancialFrequency, period: ResearchFinancialPeriod,
): ResearchFinancialObservation {
  const base = observationBaseFor("effective_tax_rate", "income_tax_expense", basis, frequency, period);
  const tax = findPoint(series, "income_tax_expense", period);
  const pretax = findPoint(series, "pre_tax_profit", period);
  const unavailable = unavailableForInputs(base, facts, ["income_tax_expense", "pre_tax_profit"], period, basis, [tax, pretax]);
  if (unavailable) return { ...unavailable, formula: "income_tax_expense / pre_tax_profit", unit: "percent" };
  if (pretax!.value! <= 0 || tax!.value! < 0 || tax!.value! > pretax!.value!) {
    return {
      ...base, status: "not_applicable", value: null, unit: "percent", formula: "income_tax_expense / pre_tax_profit",
      reasonCodes: [pretax!.value! <= 0 ? "non_positive_pre_tax_profit" : "tax_rate_outside_0_100_percent"],
      inputs: dedupeReferences([...tax!.inputs, ...pretax!.inputs]),
    };
  }
  return {
    ...base, status: "available", value: tax!.value! / pretax!.value! * 100, unit: "percent",
    formula: "income_tax_expense / pre_tax_profit", reasonCodes: [], inputs: dedupeReferences([...tax!.inputs, ...pretax!.inputs]),
  };
}

function nopatObservation(
  series: ResearchFinancialSeries[], facts: StandardizedResearchFinancialFact[], basis: ResearchFinancialBasis,
  frequency: ResearchFinancialFrequency, period: ResearchFinancialPeriod, entityType: "non_financial" | "financial" | "unknown",
): ResearchFinancialObservation {
  const base = observationBaseFor("nopat", "nopat", basis, frequency, period);
  if (entityType === "financial") return notApplicable(base, "operating_profit × (1 - effective_tax_rate)", "financial_company_nopat_not_applicable");
  const operatingProfit = findPoint(series, "operating_profit", period);
  const taxRate = observationAsPoint(effectiveTaxRateObservation(series, facts, basis, frequency, period));
  const unavailable = unavailableFromPoints(base, [operatingProfit, taxRate], ["operating_profit", "effective_tax_rate"]);
  if (unavailable) return { ...unavailable, formula: "operating_profit × (1 - effective_tax_rate)", unit: basis.currency };
  return {
    ...base, status: "available", value: operatingProfit!.value! * (1 - taxRate.value! / 100), unit: basis.currency,
    formula: "operating_profit × (1 - effective_tax_rate)", reasonCodes: [], inputs: dedupeReferences([...operatingProfit!.inputs, ...taxRate.inputs]),
  };
}

function shareholderDistributionsObservation(
  series: ResearchFinancialSeries[], facts: StandardizedResearchFinancialFact[], basis: ResearchFinancialBasis,
  frequency: ResearchFinancialFrequency, period: ResearchFinancialPeriod,
): ResearchFinancialObservation {
  const base = observationBaseFor("shareholder_distributions", "shareholder_distributions", basis, frequency, period);
  const dividends = findPoint(series, "dividends_paid", period);
  const repurchases = findPoint(series, "share_repurchases", period);
  const unavailable = unavailableForInputs(base, facts, ["dividends_paid", "share_repurchases"], period, basis, [dividends, repurchases]);
  if (unavailable) return { ...unavailable, formula: "dividends_paid + share_repurchases", unit: basis.currency };
  return {
    ...base, status: "available", value: dividends!.value! + repurchases!.value!, unit: basis.currency,
    formula: "dividends_paid + share_repurchases (positive cash outflows)", reasonCodes: [], inputs: dedupeReferences([...dividends!.inputs, ...repurchases!.inputs]),
  };
}

function netEquityDistributionObservation(
  series: ResearchFinancialSeries[], facts: StandardizedResearchFinancialFact[], basis: ResearchFinancialBasis,
  frequency: ResearchFinancialFrequency, period: ResearchFinancialPeriod,
): ResearchFinancialObservation {
  const base = observationBaseFor("net_equity_distribution", "net_equity_distribution", basis, frequency, period);
  const distributions = observationAsPoint(shareholderDistributionsObservation(series, facts, basis, frequency, period));
  const issuance = findPoint(series, "share_issuance", period);
  return subtractAvailablePoints(base, "shareholder_distributions - share_issuance", basis.currency, distributions, issuance, "shareholder_distributions", "share_issuance");
}

function dsoObservation(
  series: ResearchFinancialSeries[], facts: StandardizedResearchFinancialFact[], basis: ResearchFinancialBasis,
  frequency: "annual" | "quarterly", period: ResearchFinancialPeriod, entityType: "non_financial" | "financial" | "unknown",
): ResearchFinancialObservation {
  const base = observationBaseFor("days_sales_outstanding", "trade_receivables", basis, frequency, period);
  if (entityType === "financial") return notApplicable(base, "average(trade_receivables + contract_assets) / revenue × days", "financial_company_cash_conversion_cycle_not_applicable");
  return turnoverDaysObservation({ base, series, facts, basis, frequency, period, balanceMetrics: ["trade_receivables", "contract_assets"], denominatorMetric: "revenue", kind: "days_sales_outstanding", label: "trade_receivables + contract_assets" });
}

function dioObservation(
  series: ResearchFinancialSeries[], facts: StandardizedResearchFinancialFact[], basis: ResearchFinancialBasis,
  frequency: "annual" | "quarterly", period: ResearchFinancialPeriod, entityType: "non_financial" | "financial" | "unknown",
): ResearchFinancialObservation {
  const base = observationBaseFor("days_inventory_outstanding", "inventory", basis, frequency, period);
  if (entityType === "financial") return notApplicable(base, "average(inventory) / cost_of_revenue × days", "financial_company_cash_conversion_cycle_not_applicable");
  return turnoverDaysObservation({ base, series, facts, basis, frequency, period, balanceMetrics: ["inventory"], denominatorMetric: "cost_of_revenue", kind: "days_inventory_outstanding", label: "inventory" });
}

function dpoObservation(
  series: ResearchFinancialSeries[], facts: StandardizedResearchFinancialFact[], basis: ResearchFinancialBasis,
  frequency: "annual" | "quarterly", period: ResearchFinancialPeriod, entityType: "non_financial" | "financial" | "unknown",
): ResearchFinancialObservation {
  const base = observationBaseFor("days_payables_outstanding", "trade_payables", basis, frequency, period);
  if (entityType === "financial") return notApplicable(base, "average(trade_payables) / cost_of_revenue × days", "financial_company_cash_conversion_cycle_not_applicable");
  return turnoverDaysObservation({ base, series, facts, basis, frequency, period, balanceMetrics: ["trade_payables"], denominatorMetric: "cost_of_revenue", kind: "days_payables_outstanding", label: "trade_payables" });
}

function turnoverDaysObservation(options: {
  base: Pick<ResearchFinancialObservation, "id" | "kind" | "metric" | "basis" | "frequency" | "period">;
  series: ResearchFinancialSeries[]; facts: StandardizedResearchFinancialFact[]; basis: ResearchFinancialBasis;
  frequency: "annual" | "quarterly"; period: ResearchFinancialPeriod; balanceMetrics: ResearchFinancialMetric[];
  denominatorMetric: ResearchFinancialMetric; kind: "days_sales_outstanding" | "days_inventory_outstanding" | "days_payables_outstanding"; label: string;
}): ResearchFinancialObservation {
  const { base, series, facts, basis, frequency, period, balanceMetrics, denominatorMetric, label } = options;
  const current = combinePoints(base, label, label, basis.currency, balanceMetrics.map((metric) => findPoint(series, metric, period)), balanceMetrics);
  const priorPeriod = priorComparablePeriod(period, frequency);
  const prior = priorPeriod
    ? combinePoints(base, label, label, basis.currency, balanceMetrics.map((metric) => findPoint(series, metric, priorPeriod)), balanceMetrics)
    : unavailablePoint(period, "missing", ["prior_period_required_for_average_balance"]);
  const denominator = findPoint(series, denominatorMetric, period);
  const unavailable = unavailableFromPoints(base, [current, prior, denominator], [label, `prior_${label}`, denominatorMetric]);
  const formula = `average(${label}) / ${denominatorMetric} × period_days`;
  if (unavailable) return { ...unavailable, formula, unit: "days" };
  const usableDenominator = denominator!;
  if (usableDenominator.value! <= 0) return {
    ...base, status: "not_applicable", value: null, unit: "days", formula, reasonCodes: [`non_positive_${denominatorMetric}`],
    inputs: dedupeReferences([...current.inputs, ...prior.inputs, ...usableDenominator.inputs]),
  };
  return {
    ...base, status: "available", value: (current.value! + prior.value!) / 2 / usableDenominator.value! * periodDays(period), unit: "days", formula,
    reasonCodes: [], inputs: dedupeReferences([...current.inputs, ...prior.inputs, ...usableDenominator.inputs]),
  };
}

function cashConversionCycleObservation(
  observations: ResearchFinancialObservation[], basis: ResearchFinancialBasis, frequency: "annual" | "quarterly",
  period: ResearchFinancialPeriod, entityType: "non_financial" | "financial" | "unknown",
): ResearchFinancialObservation {
  const base = observationBaseFor("cash_conversion_cycle", "working_capital", basis, frequency, period);
  if (entityType === "financial") return notApplicable(base, "DSO + DIO - DPO", "financial_company_cash_conversion_cycle_not_applicable");
  const find = (kind: "days_sales_outstanding" | "days_inventory_outstanding" | "days_payables_outstanding") => observations.find((item) =>
    item.kind === kind && item.frequency === frequency && item.period.endDate === period.endDate && basisKey(item.basis) === basisKey(basis));
  const dso = find("days_sales_outstanding");
  const dio = find("days_inventory_outstanding");
  const dpo = find("days_payables_outstanding");
  const points = [dso, dio, dpo].map((item) => item ? observationAsPoint(item) : undefined);
  const unavailable = unavailableFromPoints(base, points, ["days_sales_outstanding", "days_inventory_outstanding", "days_payables_outstanding"]);
  if (unavailable) return { ...unavailable, formula: "DSO + DIO - DPO", unit: "days" };
  return {
    ...base, status: "available", value: points[0]!.value! + points[1]!.value! - points[2]!.value!, unit: "days", formula: "DSO + DIO - DPO",
    reasonCodes: [], inputs: dedupeReferences(points.flatMap((point) => point!.inputs)),
  };
}

function investedCapitalObservation(
  series: ResearchFinancialSeries[], facts: StandardizedResearchFinancialFact[], basis: ResearchFinancialBasis,
  frequency: "annual" | "quarterly", period: ResearchFinancialPeriod, entityType: "non_financial" | "financial" | "unknown",
): ResearchFinancialObservation {
  const base = observationBaseFor("invested_capital", "invested_capital", basis, frequency, period);
  if (entityType === "financial") return notApplicable(base, "total_equity + total_debt - cash", "financial_company_invested_capital_not_applicable");
  const equity = findPoint(series, "total_equity", period);
  const debt = findPoint(series, "total_debt", period);
  const cash = findPoint(series, "cash", period);
  const unavailable = unavailableForInputs(base, facts, ["total_equity", "total_debt", "cash"], period, basis, [equity, debt, cash]);
  if (unavailable) return { ...unavailable, formula: "total_equity + total_debt - cash", unit: basis.currency };
  const value = equity!.value! + debt!.value! - cash!.value!;
  if (value <= 0) return {
    ...base, status: "not_applicable", value: null, unit: basis.currency, formula: "total_equity + total_debt - cash",
    reasonCodes: ["non_positive_invested_capital"], inputs: dedupeReferences([...equity!.inputs, ...debt!.inputs, ...cash!.inputs]),
  };
  return {
    ...base, status: "available", value, unit: basis.currency, formula: "total_equity + total_debt - cash", reasonCodes: [],
    inputs: dedupeReferences([...equity!.inputs, ...debt!.inputs, ...cash!.inputs]),
  };
}

function netDilutionRateObservation(
  series: ResearchFinancialSeries[], facts: StandardizedResearchFinancialFact[], basis: ResearchFinancialBasis,
  frequency: "annual" | "quarterly", period: ResearchFinancialPeriod,
): ResearchFinancialObservation {
  const base = observationBaseFor("net_dilution_rate", "diluted_shares", basis, frequency, period);
  const current = findPoint(series, "diluted_shares", period);
  const previousPeriod = priorComparablePeriod(period, frequency);
  const previous = previousPeriod ? findPoint(series, "diluted_shares", previousPeriod) : undefined;
  const unavailable = unavailableForInputs(base, facts, ["diluted_shares", "diluted_shares"], period, basis, [current, previous]);
  if (unavailable) return { ...unavailable, formula: "current diluted_shares / prior diluted_shares - 1", unit: "percent" };
  if (previous!.value! <= 0) return {
    ...base, status: "not_applicable", value: null, unit: "percent", formula: "current diluted_shares / prior diluted_shares - 1",
    reasonCodes: ["non_positive_prior_diluted_shares"], inputs: dedupeReferences([...current!.inputs, ...previous!.inputs]),
  };
  return {
    ...base, status: "available", value: (current!.value! / previous!.value! - 1) * 100, unit: "percent",
    formula: "current diluted_shares / prior diluted_shares - 1", reasonCodes: [], inputs: dedupeReferences([...current!.inputs, ...previous!.inputs]),
  };
}

function returnOnCapitalObservations(
  series: ResearchFinancialSeries[], facts: StandardizedResearchFinancialFact[], basis: ResearchFinancialBasis,
  entityType: "non_financial" | "financial" | "unknown",
): ResearchFinancialObservation[] {
  const result: ResearchFinancialObservation[] = [];
  for (const frequency of ["annual", "ttm"] as const) {
    const flows = series.filter((item) => basisKey(item.basis) === basisKey(basis) && item.frequency === frequency);
    const balanceFrequency = frequency === "annual" ? "annual" : "quarterly";
    const balances = series.filter((item) => basisKey(item.basis) === basisKey(basis) && item.frequency === balanceFrequency);
    const netProfit = flows.find((item) => item.metric === "net_profit");
    if (!netProfit) continue;
    for (const point of netProfit.points) {
      result.push(returnOnEquityObservation(flows, balances, facts, basis, frequency, point.period));
      result.push(returnOnAssetsObservation(flows, balances, facts, basis, frequency, point.period, entityType));
      result.push(returnOnInvestedCapitalObservation(flows, balances, facts, basis, frequency, point.period, entityType));
      result.push(incrementalRoicObservation(flows, balances, facts, basis, frequency, point.period, entityType));
    }
  }
  return result;
}

function returnOnEquityObservation(
  flows: ResearchFinancialSeries[], balances: ResearchFinancialSeries[], facts: StandardizedResearchFinancialFact[], basis: ResearchFinancialBasis,
  frequency: "annual" | "ttm", period: ResearchFinancialPeriod,
): ResearchFinancialObservation {
  return returnOnAverageBalanceObservation({ kind: "return_on_equity", metric: "net_profit", numeratorMetric: "net_profit", balanceMetric: "total_equity", formula: "net_profit / average(total_equity)", flows, balances, facts, basis, frequency, period });
}

function returnOnAssetsObservation(
  flows: ResearchFinancialSeries[], balances: ResearchFinancialSeries[], facts: StandardizedResearchFinancialFact[], basis: ResearchFinancialBasis,
  frequency: "annual" | "ttm", period: ResearchFinancialPeriod, entityType: "non_financial" | "financial" | "unknown",
): ResearchFinancialObservation {
  const base = observationBaseFor("return_on_assets", "net_profit", basis, frequency, period);
  if (entityType === "financial") return notApplicable(base, "net_profit / average(total_assets)", "financial_company_return_on_assets_not_applicable");
  return returnOnAverageBalanceObservation({ kind: "return_on_assets", metric: "net_profit", numeratorMetric: "net_profit", balanceMetric: "total_assets", formula: "net_profit / average(total_assets)", flows, balances, facts, basis, frequency, period });
}

function returnOnInvestedCapitalObservation(
  flows: ResearchFinancialSeries[], balances: ResearchFinancialSeries[], facts: StandardizedResearchFinancialFact[], basis: ResearchFinancialBasis,
  frequency: "annual" | "ttm", period: ResearchFinancialPeriod, entityType: "non_financial" | "financial" | "unknown",
): ResearchFinancialObservation {
  const base = observationBaseFor("return_on_invested_capital", "nopat", basis, frequency, period);
  if (entityType === "financial") return notApplicable(base, "NOPAT / average(invested_capital)", "financial_company_return_on_invested_capital_not_applicable");
  const nopat = observationAsPoint(nopatObservation(flows, facts, basis, frequency, period, entityType));
  const current = observationAsPoint(investedCapitalObservation(balances, facts, basis, frequency === "annual" ? "annual" : "quarterly", period, entityType));
  const priorPeriod = priorAnnualBalancePeriod(period, frequency);
  const previous = priorPeriod ? observationAsPoint(investedCapitalObservation(balances, facts, basis, frequency === "annual" ? "annual" : "quarterly", priorPeriod, entityType)) : unavailablePoint(period, "missing", ["prior_period_required_for_average_invested_capital"]);
  return returnOnAveragePoints(base, "NOPAT / average(invested_capital)", nopat, current, previous);
}

function incrementalRoicObservation(
  flows: ResearchFinancialSeries[], balances: ResearchFinancialSeries[], facts: StandardizedResearchFinancialFact[], basis: ResearchFinancialBasis,
  frequency: "annual" | "ttm", period: ResearchFinancialPeriod, entityType: "non_financial" | "financial" | "unknown",
): ResearchFinancialObservation {
  const base = observationBaseFor("incremental_roic", "nopat", basis, frequency, period);
  if (entityType === "financial") return notApplicable(base, "ΔNOPAT / Δinvested_capital", "financial_company_incremental_roic_not_applicable");
  const currentNopat = observationAsPoint(nopatObservation(flows, facts, basis, frequency, period, entityType));
  const priorFlowPeriod = priorComparablePeriod(period, frequency === "annual" ? "annual" : "quarterly", frequency === "ttm" ? 4 : 1);
  const previousNopat = priorFlowPeriod ? observationAsPoint(nopatObservation(flows, facts, basis, frequency, priorFlowPeriod, entityType)) : unavailablePoint(period, "missing", ["prior_period_required_for_incremental_roic"]);
  const balanceFrequency = frequency === "annual" ? "annual" : "quarterly";
  const currentCapital = observationAsPoint(investedCapitalObservation(balances, facts, basis, balanceFrequency, period, entityType));
  const previousCapital = priorFlowPeriod ? observationAsPoint(investedCapitalObservation(balances, facts, basis, balanceFrequency, priorFlowPeriod, entityType)) : unavailablePoint(period, "missing", ["prior_period_required_for_incremental_roic"]);
  const unavailable = unavailableFromPoints(base, [currentNopat, previousNopat, currentCapital, previousCapital], ["nopat", "prior_nopat", "invested_capital", "prior_invested_capital"]);
  if (unavailable) return { ...unavailable, formula: "ΔNOPAT / Δinvested_capital", unit: "percent" };
  const capitalChange = currentCapital.value! - previousCapital.value!;
  if (capitalChange <= 0) return {
    ...base, status: "not_applicable", value: null, unit: "percent", formula: "ΔNOPAT / Δinvested_capital", reasonCodes: ["non_positive_incremental_invested_capital"],
    inputs: dedupeReferences([currentNopat, previousNopat, currentCapital, previousCapital].flatMap((point) => point.inputs)),
  };
  return {
    ...base, status: "available", value: (currentNopat.value! - previousNopat.value!) / capitalChange * 100, unit: "percent", formula: "ΔNOPAT / Δinvested_capital", reasonCodes: [],
    inputs: dedupeReferences([currentNopat, previousNopat, currentCapital, previousCapital].flatMap((point) => point.inputs)),
  };
}

function returnOnAverageBalanceObservation(options: {
  kind: "return_on_equity" | "return_on_assets"; metric: ResearchFinancialObservation["metric"]; numeratorMetric: ResearchFinancialMetric; balanceMetric: ResearchFinancialMetric;
  formula: string; flows: ResearchFinancialSeries[]; balances: ResearchFinancialSeries[]; facts: StandardizedResearchFinancialFact[]; basis: ResearchFinancialBasis; frequency: "annual" | "ttm"; period: ResearchFinancialPeriod;
}): ResearchFinancialObservation {
  const { kind, metric, numeratorMetric, balanceMetric, formula, flows, balances, facts, basis, frequency, period } = options;
  const base = observationBaseFor(kind, metric, basis, frequency, period);
  const numerator = findPoint(flows, numeratorMetric, period);
  const current = findPoint(balances, balanceMetric, period);
  const priorPeriod = priorAnnualBalancePeriod(period, frequency);
  const prior = priorPeriod ? findPoint(balances, balanceMetric, priorPeriod) : undefined;
  const unavailable = unavailableForInputs(base, facts, [numeratorMetric, balanceMetric, balanceMetric], period, basis, [numerator, current, prior]);
  if (unavailable) return { ...unavailable, formula, unit: "percent" };
  return divideAverageBalance(base, formula, numerator!, current!, prior!);
}

function returnOnAveragePoints(
  base: Pick<ResearchFinancialObservation, "id" | "kind" | "metric" | "basis" | "frequency" | "period">,
  formula: string, numerator: ResearchFinancialSeriesPoint, current: ResearchFinancialSeriesPoint, prior: ResearchFinancialSeriesPoint,
): ResearchFinancialObservation {
  const unavailable = unavailableFromPoints(base, [numerator, current, prior], ["numerator", "current_balance", "prior_balance"]);
  if (unavailable) return { ...unavailable, formula, unit: "percent" };
  return divideAverageBalance(base, formula, numerator, current, prior);
}

function divideAverageBalance(
  base: Pick<ResearchFinancialObservation, "id" | "kind" | "metric" | "basis" | "frequency" | "period">,
  formula: string, numerator: ResearchFinancialSeriesPoint, current: ResearchFinancialSeriesPoint, prior: ResearchFinancialSeriesPoint,
): ResearchFinancialObservation {
  const average = (current.value! + prior.value!) / 2;
  if (average <= 0) return {
    ...base, status: "not_applicable", value: null, unit: "percent", formula, reasonCodes: ["non_positive_average_balance"],
    inputs: dedupeReferences([...numerator.inputs, ...current.inputs, ...prior.inputs]),
  };
  return {
    ...base, status: "available", value: numerator.value! / average * 100, unit: "percent", formula, reasonCodes: [],
    inputs: dedupeReferences([...numerator.inputs, ...current.inputs, ...prior.inputs]),
  };
}

function freeCashFlowObservation(
  series: ResearchFinancialSeries[],
  facts: StandardizedResearchFinancialFact[],
  basis: ResearchFinancialBasis,
  frequency: ResearchFinancialFrequency,
  period: ResearchFinancialPeriod,
  entityType: "non_financial" | "financial" | "unknown",
): ResearchFinancialObservation {
  const base = observationBaseFor("free_cash_flow", "free_cash_flow", basis, frequency, period);
  if (entityType === "financial") {
    return notApplicable(base, "operating_cash_flow - capital_expenditure", "financial_company_fcf_not_applicable");
  }
  const cashFlow = findPoint(series, "operating_cash_flow", period);
  const capex = findPoint(series, "capital_expenditure", period);
  const unavailable = unavailableForInputs(base, facts, ["operating_cash_flow", "capital_expenditure"], period, basis, [cashFlow, capex]);
  if (unavailable) return { ...unavailable, formula: "operating_cash_flow - capital_expenditure", unit: basis.currency };
  return {
    ...base,
    status: "available",
    value: cashFlow!.value! - capex!.value!,
    unit: basis.currency,
    formula: "operating_cash_flow - capital_expenditure (capital expenditure is a positive outflow)",
    reasonCodes: [],
    inputs: dedupeReferences([...cashFlow!.inputs, ...capex!.inputs]),
  };
}

function cashConversionObservation(
  series: ResearchFinancialSeries[],
  facts: StandardizedResearchFinancialFact[],
  basis: ResearchFinancialBasis,
  frequency: ResearchFinancialFrequency,
  period: ResearchFinancialPeriod,
  entityType: "non_financial" | "financial" | "unknown",
): ResearchFinancialObservation {
  const base = observationBaseFor("cash_conversion", "operating_cash_flow", basis, frequency, period);
  if (entityType === "financial") {
    return notApplicable(base, "operating_cash_flow / net_profit", "financial_company_cash_conversion_not_applicable");
  }
  const cashFlow = findPoint(series, "operating_cash_flow", period);
  const profit = findPoint(series, "net_profit", period);
  const unavailable = unavailableForInputs(base, facts, ["operating_cash_flow", "net_profit"], period, basis, [cashFlow, profit]);
  if (unavailable) return { ...unavailable, formula: "operating_cash_flow / net_profit", unit: "percent" };
  if (profit!.value! <= 0) {
    return {
      ...base,
      status: "not_applicable",
      value: null,
      unit: "percent",
      formula: "operating_cash_flow / net_profit",
      reasonCodes: ["non_positive_profit_denominator"],
      inputs: dedupeReferences([...cashFlow!.inputs, ...profit!.inputs]),
    };
  }
  return {
    ...base,
    status: "available",
    value: cashFlow!.value! / profit!.value! * 100,
    unit: "percent",
    formula: "operating_cash_flow / net_profit",
    reasonCodes: [],
    inputs: dedupeReferences([...cashFlow!.inputs, ...profit!.inputs]),
  };
}

function netDebtObservation(
  series: ResearchFinancialSeries[],
  facts: StandardizedResearchFinancialFact[],
  basis: ResearchFinancialBasis,
  frequency: "annual" | "quarterly",
  period: ResearchFinancialPeriod,
): ResearchFinancialObservation {
  const base = observationBaseFor("net_debt", "net_debt", basis, frequency, period);
  const debt = findPoint(series, "total_debt", period);
  const cash = findPoint(series, "cash", period);
  const unavailable = unavailableForInputs(base, facts, ["total_debt", "cash"], period, basis, [debt, cash]);
  if (unavailable) return { ...unavailable, formula: "total_debt - cash", unit: basis.currency };
  return {
    ...base,
    status: "available",
    value: debt!.value! - cash!.value!,
    unit: basis.currency,
    formula: "total_debt - cash",
    reasonCodes: [],
    inputs: dedupeReferences([...debt!.inputs, ...cash!.inputs]),
  };
}

function perShareObservation(
  series: ResearchFinancialSeries[],
  facts: StandardizedResearchFinancialFact[],
  basis: ResearchFinancialBasis,
  frequency: ResearchFinancialFrequency,
  period: ResearchFinancialPeriod,
  kind: "net_profit_per_share" | "free_cash_flow_per_share" | "book_value_per_share",
  numeratorMetric: ResearchFinancialMetric | "free_cash_flow",
  shareMetric: "diluted_weighted_average_shares" | "diluted_shares",
  entityType: "non_financial" | "financial" | "unknown" = "non_financial",
): ResearchFinancialObservation {
  const base = observationBaseFor(kind, numeratorMetric, basis, frequency, period);
  if (numeratorMetric === "free_cash_flow" && entityType === "financial") {
    return notApplicable(base, "free_cash_flow / diluted_weighted_average_shares", "financial_company_fcf_not_applicable");
  }
  const numerator = numeratorMetric === "free_cash_flow"
    ? freeCashFlowObservation(series, facts, basis, frequency, period, entityType)
    : findPoint(series, numeratorMetric, period);
  const shares = findPoint(series, shareMetric, period);
  const numeratorPoint = numeratorMetric === "free_cash_flow"
    ? observationAsPoint(numerator as ResearchFinancialObservation)
    : numerator as ResearchFinancialSeriesPoint | undefined;
  const unavailable = unavailableForInputs(base, facts, [numeratorMetric, shareMetric], period, basis, [numeratorPoint, shares]);
  if (unavailable) return { ...unavailable, formula: `${numeratorMetric} / ${shareMetric}`, unit: `${basis.currency}/share` };
  if (shares!.value! <= 0) {
    return {
      ...base,
      status: "not_applicable",
      value: null,
      unit: `${basis.currency}/share`,
      formula: `${numeratorMetric} / ${shareMetric}`,
      reasonCodes: ["non_positive_share_denominator"],
      inputs: dedupeReferences([...numeratorPoint!.inputs, ...shares!.inputs]),
    };
  }
  return {
    ...base,
    status: "available",
    value: numeratorPoint!.value! / shares!.value!,
    unit: `${basis.currency}/share`,
    formula: `${numeratorMetric} / ${shareMetric}`,
    reasonCodes: [],
    inputs: dedupeReferences([...numeratorPoint!.inputs, ...shares!.inputs]),
  };
}

type DivideObservationOptions = {
  facts: StandardizedResearchFinancialFact[];
  basis: ResearchFinancialBasis;
  frequency: ResearchFinancialFrequency;
  period: ResearchFinancialPeriod;
  kind: "gross_margin" | "operating_margin" | "net_margin" | "capital_expenditure_to_revenue"
    | "receivables_to_revenue" | "inventory_to_revenue" | "payables_to_revenue" | "debt_to_equity"
    | "current_ratio" | "interest_coverage";
  metric: ResearchFinancialMetric;
  numerator?: ResearchFinancialSeriesPoint;
  denominator?: ResearchFinancialSeriesPoint;
  numeratorMetric: ResearchFinancialMetric;
  denominatorMetric: ResearchFinancialMetric;
  unit: string;
  multiplier: number;
  formula: string;
};

function divideObservation(options: DivideObservationOptions): ResearchFinancialObservation {
  const base = observationBaseFor(options.kind, options.metric, options.basis, options.frequency, options.period);
  const unavailable = unavailableForInputs(
    base,
    options.facts,
    [options.numeratorMetric, options.denominatorMetric],
    options.period,
    options.basis,
    [options.numerator, options.denominator],
  );
  if (unavailable) return { ...unavailable, formula: options.formula, unit: options.unit };
  if (options.denominator!.value === 0) {
    return {
      ...base,
      status: "not_applicable",
      value: null,
      unit: options.unit,
      formula: options.formula,
      reasonCodes: ["zero_denominator"],
      inputs: dedupeReferences([...options.numerator!.inputs, ...options.denominator!.inputs]),
    };
  }
  return {
    ...base,
    status: "available",
    value: options.numerator!.value! / options.denominator!.value! * options.multiplier,
    unit: options.unit,
    formula: options.formula,
    reasonCodes: [],
    inputs: dedupeReferences([...options.numerator!.inputs, ...options.denominator!.inputs]),
  };
}

function unavailableForInputs(
  base: Pick<ResearchFinancialObservation, "id" | "kind" | "metric" | "basis" | "frequency" | "period">,
  facts: StandardizedResearchFinancialFact[],
  metrics: Array<ResearchFinancialMetric | "free_cash_flow">,
  period: ResearchFinancialPeriod,
  basis: ResearchFinancialBasis,
  points: Array<ResearchFinancialSeriesPoint | undefined>,
): ResearchFinancialObservation | null {
  const defined = points.filter((point): point is ResearchFinancialSeriesPoint => Boolean(point));
  const inputs = dedupeReferences(defined.flatMap((point) => point.inputs));
  if (defined.some((point) => point.status === "incomparable")) {
    return {
      ...base,
      status: "incomparable",
      value: null,
      unit: "",
      formula: "",
      reasonCodes: dedupeStrings(defined.flatMap((point) => point.reasonCodes)),
      inputs,
    };
  }
  const unavailableMetric = metrics.find((_, index) => !points[index] || points[index]!.status !== "available");
  if (!unavailableMetric) return null;
  const otherBasisExists = unavailableMetric !== "free_cash_flow" && facts.some((fact) =>
    fact.metric === unavailableMetric
    && periodKey(fact.period) === periodKey(period)
    && basisKey(fact.basis) !== basisKey(basis)
    && fact.value !== null
  );
  return {
    ...base,
    status: otherBasisExists ? "incomparable" : "missing",
    value: null,
    unit: "",
    formula: "",
    reasonCodes: [otherBasisExists ? "required_fact_has_different_basis" : `missing_${unavailableMetric}`],
    inputs,
  };
}

function unavailableFromPoints(
  base: Pick<ResearchFinancialObservation, "id" | "kind" | "metric" | "basis" | "frequency" | "period">,
  points: Array<ResearchFinancialSeriesPoint | undefined>, labels: string[],
): ResearchFinancialObservation | null {
  const defined = points.filter((point): point is ResearchFinancialSeriesPoint => Boolean(point));
  const inputs = dedupeReferences(defined.flatMap((point) => point.inputs));
  if (defined.some((point) => point.status === "incomparable")) {
    return { ...base, status: "incomparable", value: null, unit: "", formula: "", reasonCodes: dedupeStrings(defined.flatMap((point) => point.reasonCodes)), inputs };
  }
  const unavailableIndex = points.findIndex((point) => !point || point.status !== "available");
  if (unavailableIndex < 0) return null;
  const unavailable = points[unavailableIndex];
  return {
    ...base, status: unavailable?.status === "not_applicable" ? "not_applicable" : "missing", value: null, unit: "", formula: "",
    reasonCodes: unavailable?.reasonCodes.length ? unavailable.reasonCodes : [`missing_${labels[unavailableIndex]}`], inputs,
  };
}

function unavailablePoint(period: ResearchFinancialPeriod, status: "missing" | "incomparable", reasonCodes: string[]): ResearchFinancialSeriesPoint {
  return { period, status, value: null, formula: "", reasonCodes, inputs: [] };
}

function combinePoints(
  base: Pick<ResearchFinancialObservation, "period">, _label: string, formula: string, unit: string,
  points: Array<ResearchFinancialSeriesPoint | undefined>, labels: string[],
): ResearchFinancialSeriesPoint {
  const unavailable = unavailableFromPoints({
    id: "derived-input", kind: "working_capital", metric: "working_capital", basis: { id: "derived", currency: unit, accountingStandard: "derived", scope: "derived", revision: "derived" }, frequency: "annual", period: base.period,
  }, points, labels);
  if (unavailable) return { period: base.period, status: unavailable.status, value: null, formula, reasonCodes: unavailable.reasonCodes, inputs: unavailable.inputs };
  return {
    period: base.period, status: "available", value: points.reduce((total, point) => total + point!.value!, 0), formula, reasonCodes: [],
    inputs: dedupeReferences(points.flatMap((point) => point!.inputs)),
  };
}

function divideAvailablePoints(
  base: Pick<ResearchFinancialObservation, "id" | "kind" | "metric" | "basis" | "frequency" | "period">,
  formula: string, unit: string, multiplier: number, points: Array<ResearchFinancialSeriesPoint | undefined>, labels: string[],
): ResearchFinancialObservation {
  const unavailable = unavailableFromPoints(base, points, labels);
  if (unavailable) return { ...unavailable, formula, unit };
  const [numerator, denominator] = points as [ResearchFinancialSeriesPoint, ResearchFinancialSeriesPoint];
  if (denominator.value === 0) return {
    ...base, status: "not_applicable", value: null, unit, formula, reasonCodes: ["zero_denominator"], inputs: dedupeReferences([...numerator.inputs, ...denominator.inputs]),
  };
  return {
    ...base, status: "available", value: numerator.value! / denominator.value! * multiplier, unit, formula, reasonCodes: [],
    inputs: dedupeReferences([...numerator.inputs, ...denominator.inputs]),
  };
}

function subtractAvailablePoints(
  base: Pick<ResearchFinancialObservation, "id" | "kind" | "metric" | "basis" | "frequency" | "period">,
  formula: string, unit: string, left: ResearchFinancialSeriesPoint | undefined, right: ResearchFinancialSeriesPoint | undefined, leftLabel: string, rightLabel: string,
): ResearchFinancialObservation {
  const unavailable = unavailableFromPoints(base, [left, right], [leftLabel, rightLabel]);
  if (unavailable) return { ...unavailable, formula, unit };
  return {
    ...base, status: "available", value: left!.value! - right!.value!, unit, formula, reasonCodes: [], inputs: dedupeReferences([...left!.inputs, ...right!.inputs]),
  };
}

function priorComparablePeriod(
  period: ResearchFinancialPeriod, frequency: "annual" | "quarterly", steps = 1,
): ResearchFinancialPeriod | null {
  if (frequency === "annual") return { ...period, kind: "annual", fiscalYear: period.fiscalYear - steps, startDate: `${period.fiscalYear - steps}-01-01`, endDate: `${period.fiscalYear - steps}${period.endDate.slice(4)}`, fiscalQuarter: undefined };
  const current = quarterIndex(period) - steps;
  const fiscalYear = Math.floor(current / 4);
  const fiscalQuarter = ((current % 4) + 1) as 1 | 2 | 3 | 4;
  const month = fiscalQuarter * 3;
  return { kind: "quarter", fiscalYear, fiscalQuarter, startDate: `${fiscalYear}-${String(month - 2).padStart(2, "0")}-01`, endDate: `${fiscalYear}-${String(month).padStart(2, "0")}-${fiscalQuarter === 1 || fiscalQuarter === 4 ? "31" : "30"}` };
}

function priorAnnualBalancePeriod(period: ResearchFinancialPeriod, frequency: "annual" | "ttm"): ResearchFinancialPeriod | null {
  return priorComparablePeriod(period, frequency === "annual" ? "annual" : "quarterly", frequency === "annual" ? 1 : 4);
}

function periodDays(period: ResearchFinancialPeriod): number {
  const start = Date.parse(`${period.startDate}T00:00:00Z`);
  const end = Date.parse(`${period.endDate}T00:00:00Z`);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.round((end - start) / 86_400_000) + 1 : 0;
}

function observationBase(
  series: ResearchFinancialSeries,
  kind: "yoy" | "qoq" | "cagr",
  period: ResearchFinancialPeriod,
): Pick<ResearchFinancialObservation, "id" | "kind" | "metric" | "basis" | "frequency" | "period"> {
  return observationBaseFor(kind, series.metric, series.basis, series.frequency, period);
}

function observationBaseFor(
  kind: ResearchFinancialObservationKind,
  metric: ResearchFinancialObservation["metric"],
  basis: ResearchFinancialBasis,
  frequency: ResearchFinancialFrequency,
  period: ResearchFinancialPeriod,
): Pick<ResearchFinancialObservation, "id" | "kind" | "metric" | "basis" | "frequency" | "period"> {
  return {
    id: `${kind}:${metric}:${frequency}:${periodKey(period)}:${basisKey(basis)}`,
    kind,
    metric,
    basis,
    frequency,
    period,
  };
}

function notApplicable(
  base: Pick<ResearchFinancialObservation, "id" | "kind" | "metric" | "basis" | "frequency" | "period">,
  formula: string,
  reason: string,
): ResearchFinancialObservation {
  return {
    ...base,
    status: "not_applicable",
    value: null,
    unit: "",
    formula,
    reasonCodes: [reason],
    inputs: [],
  };
}

function observationAsPoint(observation: ResearchFinancialObservation): ResearchFinancialSeriesPoint {
  return {
    period: observation.period,
    status: observation.status,
    value: observation.value,
    formula: observation.formula,
    reasonCodes: observation.reasonCodes,
    inputs: observation.inputs,
  };
}

function findPoint(
  series: ResearchFinancialSeries[],
  metric: ResearchFinancialMetric,
  period: ResearchFinancialPeriod,
): ResearchFinancialSeriesPoint | undefined {
  return series.find((item) => item.metric === metric)?.points.find((point) => periodKey(point.period) === periodKey(period));
}

function uniqueBases(series: ResearchFinancialSeries[]): ResearchFinancialBasis[] {
  const values = new Map<string, ResearchFinancialBasis>();
  for (const item of series) values.set(basisKey(item.basis), item.basis);
  return [...values.values()];
}

function uniquePeriods(periods: ResearchFinancialPeriod[]): ResearchFinancialPeriod[] {
  const values = new Map<string, ResearchFinancialPeriod>();
  for (const period of periods) values.set(periodKey(period), period);
  return [...values.values()].sort(comparePeriod);
}

function metricUnit(metric: ResearchFinancialMetric, basis: ResearchFinancialBasis): string {
  return shareMetrics.has(metric) ? "shares" : basis.currency;
}

function basisKey(basis: ResearchFinancialBasis): string {
  return [basis.id, basis.currency, basis.accountingStandard, basis.scope, basis.revision].join("~");
}

function periodKey(period: ResearchFinancialPeriod): string {
  return period.kind === "annual"
    ? `FY${period.fiscalYear}:${period.endDate}`
    : `FY${period.fiscalYear}Q${period.fiscalQuarter}:${period.endDate}`;
}

function periodIndex(period: ResearchFinancialPeriod): number {
  return period.kind === "annual" ? period.fiscalYear : quarterIndex(period);
}

function quarterIndex(period: ResearchFinancialPeriod): number {
  return period.fiscalYear * 4 + (period.fiscalQuarter ?? 4) - 1;
}

function ttmPeriod(ending: ResearchFinancialPeriod, startDate = ending.startDate): ResearchFinancialPeriod {
  return {
    kind: "quarter",
    startDate,
    endDate: ending.endDate,
    fiscalYear: ending.fiscalYear,
    fiscalQuarter: ending.fiscalQuarter,
  };
}

function unavailableSeriesPoint(
  period: ResearchFinancialPeriod,
  status: "missing" | "incomparable",
  formula: string,
  reasonCodes: string[],
  inputs: ResearchFinancialInputReference[],
): ResearchFinancialSeriesPoint {
  return { period, status, value: null, formula, reasonCodes, inputs: dedupeReferences(inputs) };
}

function factReferences(facts: StandardizedResearchFinancialFact[]): ResearchFinancialInputReference[] {
  return facts.flatMap((fact) => fact.inputReferences?.length
    ? fact.inputReferences
    : [{ factId: fact.id, provenance: fact.provenance }]);
}

function dedupeReferences(inputs: ResearchFinancialInputReference[]): ResearchFinancialInputReference[] {
  return [...new Map(inputs.map((item) => [item.factId, item])).values()];
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function comparePeriod(left: ResearchFinancialPeriod, right: ResearchFinancialPeriod): number {
  return left.endDate.localeCompare(right.endDate) || periodKey(left).localeCompare(periodKey(right));
}

function compareSeries(left: ResearchFinancialSeries, right: ResearchFinancialSeries): number {
  return basisKey(left.basis).localeCompare(basisKey(right.basis))
    || left.metric.localeCompare(right.metric)
    || left.frequency.localeCompare(right.frequency);
}
