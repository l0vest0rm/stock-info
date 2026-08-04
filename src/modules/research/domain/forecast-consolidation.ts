/**
 * v4 identifies a sample by an immutable assertion over one exact document
 * version.  The assertion distinguishes original research from a carrier of
 * a copy and preserves the originating model lineage.  A publisher label is
 * never enough to turn a republication into an independent sample.
 */
export const FORECAST_CONSOLIDATION_RULE_VERSION = "forecast-consolidation.v4";

export const FORECAST_METRICS = [
  "revenue",
  "revenue_growth",
  "net_profit",
  "net_profit_growth",
  "gross_margin",
  "eps",
  "operating_cash_flow",
] as const;

export type ForecastMetric = typeof FORECAST_METRICS[number];
export type ForecastAccountingBasis = "gaap" | "non_gaap" | "adjusted" | "unspecified";
export type ForecastOwnershipBasis = "attributable_to_parent" | "consolidated" | "common_shareholders" | "unspecified";
export type ForecastShareBasis = "basic" | "diluted" | "unspecified";
export const FORECAST_CARRIER_RELATIONS = ["original", "republication", "shared", "unknown"] as const;
export type ForecastCarrierRelation = typeof FORECAST_CARRIER_RELATIONS[number];

export const FORECAST_RAW_UNITS = [
  "currency",
  "ten_thousand_currency",
  "million_currency",
  "hundred_million_currency",
  "billion_currency",
  "percent",
  "currency_per_share",
] as const;
export type ForecastRawUnit = typeof FORECAST_RAW_UNITS[number];

export type SourceForecastInput = {
  forecastId: string;
  institution: string | null;
  /** Immutable reviewed identity selected when the source forecast was accepted. */
  sourceIdentityId?: string | null;
  /** Immutable assertion over this exact document version; required by v4. */
  sourceIdentityAssertionId?: string | null;
  /** Reviewed original provider frozen from the assertion. */
  originSourceIdentityId?: string | null;
  /** Reviewed document carrier frozen from the assertion. */
  carrierSourceIdentityId?: string | null;
  /** Whether the carrier is the original publication or a copy/shared channel. */
  carrierRelation?: ForecastCarrierRelation | null;
  /** Explicit originating research-model lineage; never inferred from labels. */
  modelLineageId?: string | null;
  /** Confirmed independent-origin group resolved from sourceIdentityId. */
  independenceGroupId?: string | null;
  forecastDate: string;
  metric: ForecastMetric;
  fiscalYear: number;
  rawValue: number;
  rawUnit: ForecastRawUnit;
  currency: string | null;
  accountingBasis: ForecastAccountingBasis;
  ownershipBasis: ForecastOwnershipBasis;
  shareBasis: ForecastShareBasis;
  createdAt: number;
};

export type NormalizedSourceForecast = SourceForecastInput & {
  normalizedValue: number | null;
  normalizedUnit: "hundred_million_currency" | "percent" | "currency_per_share" | null;
  normalizationStatus: "comparable" | "needs_review";
  normalizationNotes: string | null;
};

export type ForecastConsolidationMember = {
  forecastId: string;
  comparisonKey: string | null;
  membershipStatus: "included" | "excluded";
  reasonCode: "included" | "source_identity_assertion_unresolved" | "source_republication" | "source_shared_authorship" | "source_carrier_unknown" | "normalization_needs_review" | "superseded_by_latest_independence_group_model_forecast";
};

export type ForecastConsolidationGroup = {
  comparisonKey: string;
  metric: ForecastMetric;
  fiscalYear: number;
  currency: string | null;
  normalizedUnit: NonNullable<NormalizedSourceForecast["normalizedUnit"]>;
  accountingBasis: ForecastAccountingBasis;
  ownershipBasis: ForecastOwnershipBasis;
  shareBasis: ForecastShareBasis;
  sampleCount: number;
  medianValue: number;
  meanValue: number;
  minValue: number;
  maxValue: number;
  standardDeviation: number;
};

export type ForecastConsolidation = {
  label: "已纳入样本的预测汇总";
  sourceUniverse: "opportunistic_research_documents";
  marketConsensus: false;
  ruleVersion: string;
  groups: ForecastConsolidationGroup[];
  members: ForecastConsolidationMember[];
};

const amountScaleToHundredMillion: Partial<Record<ForecastRawUnit, number>> = {
  currency: 0.00000001,
  ten_thousand_currency: 0.0001,
  million_currency: 0.01,
  hundred_million_currency: 1,
  billion_currency: 10,
};

export function normalizeSourceForecast(input: SourceForecastInput): NormalizedSourceForecast {
  if (!Number.isFinite(input.rawValue)) return unresolved(input, "raw_value_not_finite");
  if (!Number.isInteger(input.fiscalYear) || input.fiscalYear < 1900 || input.fiscalYear > 2200) {
    return unresolved(input, "invalid_fiscal_year");
  }
  if (input.accountingBasis === "unspecified") return unresolved(input, "accounting_basis_required");
  if ((input.metric === "net_profit" || input.metric === "net_profit_growth")
    && input.ownershipBasis === "unspecified") {
    return unresolved(input, "ownership_basis_required_for_profit");
  }
  if (input.metric === "eps" && input.shareBasis === "unspecified") {
    return unresolved(input, "share_basis_required_for_eps");
  }
  const amountMetric = input.metric === "revenue" || input.metric === "net_profit" || input.metric === "operating_cash_flow";
  const percentageMetric = input.metric === "revenue_growth" || input.metric === "net_profit_growth" || input.metric === "gross_margin";
  if (amountMetric) {
    const factor = amountScaleToHundredMillion[input.rawUnit];
    if (!input.currency) return unresolved(input, "currency_required_for_amount");
    if (factor === undefined) return unresolved(input, "amount_unit_mismatch");
    return comparable(input, round(input.rawValue * factor), "hundred_million_currency");
  }
  if (percentageMetric) {
    if (input.rawUnit !== "percent") return unresolved(input, "percent_unit_required");
    return comparable(input, input.rawValue, "percent");
  }
  if (input.metric === "eps") {
    if (!input.currency) return unresolved(input, "currency_required_for_eps");
    if (input.rawUnit !== "currency_per_share") return unresolved(input, "per_share_unit_required");
    return comparable(input, input.rawValue, "currency_per_share");
  }
  return unresolved(input, "unsupported_metric");
}

export function buildForecastConsolidation(inputs: SourceForecastInput[]): ForecastConsolidation {
  const normalized = inputs.map(normalizeSourceForecast);
  const members = new Map<string, ForecastConsolidationMember>();
  const comparableByKey = new Map<string, NormalizedSourceForecast[]>();

  for (const item of normalized) {
    if (item.normalizationStatus !== "comparable" || item.normalizedValue === null || !item.normalizedUnit) {
      members.set(item.forecastId, excluded(item.forecastId, null, "normalization_needs_review"));
      continue;
    }
    if (!hasResolvedOriginalAssertion(item)) {
      members.set(item.forecastId, excluded(item.forecastId, comparisonKey(item), assertionExclusionReason(item)));
      continue;
    }
    const key = comparisonKey(item);
    const group = comparableByKey.get(key) ?? [];
    group.push(item);
    comparableByKey.set(key, group);
  }

  const groups: ForecastConsolidationGroup[] = [];
  for (const [key, candidates] of comparableByKey) {
    const latestByIndependenceGroupModel = new Map<string, NormalizedSourceForecast>();
    for (const candidate of candidates) {
      const groupModelKey = independenceGroupModelKey(candidate)!;
      const known = latestByIndependenceGroupModel.get(groupModelKey);
      if (!known || compareForecastVersion(candidate, known) > 0) latestByIndependenceGroupModel.set(groupModelKey, candidate);
    }
    for (const candidate of candidates) {
      const selected = latestByIndependenceGroupModel.get(independenceGroupModelKey(candidate)!);
      members.set(candidate.forecastId, selected?.forecastId === candidate.forecastId
        ? { forecastId: candidate.forecastId, comparisonKey: key, membershipStatus: "included", reasonCode: "included" }
        : excluded(candidate.forecastId, key, "superseded_by_latest_independence_group_model_forecast"));
    }
    const selected = [...latestByIndependenceGroupModel.values()];
    if (selected.length === 0) continue;
    const values = selected.map((item) => item.normalizedValue!).sort((a, b) => a - b);
    const template = selected[0];
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
    groups.push({
      comparisonKey: key,
      metric: template.metric,
      fiscalYear: template.fiscalYear,
      currency: normalizeCurrency(template.currency),
      normalizedUnit: template.normalizedUnit!,
      accountingBasis: template.accountingBasis,
      ownershipBasis: template.ownershipBasis,
      shareBasis: template.shareBasis,
      sampleCount: values.length,
      medianValue: round(median(values)),
      meanValue: round(mean),
      minValue: round(values[0]),
      maxValue: round(values.at(-1)!),
      standardDeviation: round(Math.sqrt(variance)),
    });
  }

  return {
    label: "已纳入样本的预测汇总",
    sourceUniverse: "opportunistic_research_documents",
    marketConsensus: false,
    ruleVersion: FORECAST_CONSOLIDATION_RULE_VERSION,
    groups: groups.sort(compareGroups),
    members: [...members.values()].sort((a, b) => a.forecastId.localeCompare(b.forecastId)),
  };
}

/** A revision is meaningful only within the same explicitly reviewed model lineage. */
export function assertForecastSupersedesSameModelLineage(
  predecessorModelLineageId: string | null | undefined,
  successorModelLineageId: string | null | undefined,
): void {
  const predecessor = normalizeIdentityId(predecessorModelLineageId);
  const successor = normalizeIdentityId(successorModelLineageId);
  if (!predecessor || !successor || predecessor !== successor) {
    throw new Error("supersedesForecastId must remain within the same explicit model lineage");
  }
}

function hasResolvedOriginalAssertion(item: NormalizedSourceForecast): boolean {
  return item.carrierRelation === "original"
    && Boolean(normalizeIdentityId(item.sourceIdentityAssertionId))
    && Boolean(normalizeIdentityId(item.originSourceIdentityId))
    && Boolean(normalizeIdentityId(item.carrierSourceIdentityId))
    && Boolean(normalizeIdentityId(item.modelLineageId))
    && Boolean(normalizeIdentityId(item.independenceGroupId));
}

function independenceGroupModelKey(item: NormalizedSourceForecast): string | null {
  const groupId = normalizeIdentityId(item.independenceGroupId);
  const modelLineageId = normalizeIdentityId(item.modelLineageId);
  return groupId && modelLineageId ? `${groupId}|${modelLineageId}` : null;
}

function assertionExclusionReason(item: NormalizedSourceForecast): Exclude<ForecastConsolidationMember["reasonCode"], "included" | "normalization_needs_review" | "superseded_by_latest_independence_group_model_forecast"> {
  if (!normalizeIdentityId(item.sourceIdentityAssertionId)) return "source_identity_assertion_unresolved";
  if (item.carrierRelation === "republication") return "source_republication";
  if (item.carrierRelation === "shared") return "source_shared_authorship";
  if (item.carrierRelation === "unknown") return "source_carrier_unknown";
  return "source_identity_assertion_unresolved";
}

function comparisonKey(item: NormalizedSourceForecast): string {
  return [
    item.metric,
    item.fiscalYear,
    normalizeCurrency(item.currency) || "none",
    item.normalizedUnit || "unresolved",
    item.accountingBasis,
    item.ownershipBasis,
    item.shareBasis,
  ].join("|");
}

function normalizeIdentityId(value: unknown): string | null {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function normalizeCurrency(value: string | null): string | null {
  const normalized = String(value || "").trim().toUpperCase();
  return normalized || null;
}

function compareForecastVersion(left: SourceForecastInput, right: SourceForecastInput): number {
  const byDate = left.forecastDate.localeCompare(right.forecastDate);
  if (byDate !== 0) return byDate;
  const byCreated = left.createdAt - right.createdAt;
  return byCreated !== 0 ? byCreated : left.forecastId.localeCompare(right.forecastId);
}

function compareGroups(left: ForecastConsolidationGroup, right: ForecastConsolidationGroup): number {
  return left.fiscalYear - right.fiscalYear || left.metric.localeCompare(right.metric) || left.comparisonKey.localeCompare(right.comparisonKey);
}

function median(values: number[]): number {
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function unresolved(input: SourceForecastInput, notes: string): NormalizedSourceForecast {
  return { ...input, normalizedValue: null, normalizedUnit: null, normalizationStatus: "needs_review", normalizationNotes: notes };
}

function comparable(
  input: SourceForecastInput,
  normalizedValue: number,
  normalizedUnit: NonNullable<NormalizedSourceForecast["normalizedUnit"]>,
): NormalizedSourceForecast {
  return { ...input, normalizedValue, normalizedUnit, normalizationStatus: "comparable", normalizationNotes: null };
}

function excluded(
  forecastId: string,
  key: string | null,
  reasonCode: Exclude<ForecastConsolidationMember["reasonCode"], "included">,
): ForecastConsolidationMember {
  return { forecastId, comparisonKey: key, membershipStatus: "excluded", reasonCode };
}
