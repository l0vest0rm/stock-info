import type { ForecastAccountingBasis, ForecastMetric, ForecastOwnershipBasis, ForecastShareBasis } from "./forecast-consolidation";

/**
 * A source-forecast revision is only established by the immutable explicit
 * supersedes link.  Similar institutions, dates, or values are deliberately
 * not inferred into a revision chain.
 */
export const FORECAST_REVISION_READ_MODEL_VERSION = "forecast-revision.v1";

export type ForecastRevisionInput = {
  forecastId: string;
  supersedesForecastId: string | null;
  institution: string | null;
  forecastDate: string;
  metric: ForecastMetric;
  fiscalYear: number;
  fiscalPeriod: string;
  currency: string | null;
  normalizedValue: number | null;
  normalizedUnit: string | null;
  normalizationStatus: string;
  accountingBasis: ForecastAccountingBasis;
  ownershipBasis: ForecastOwnershipBasis;
  shareBasis: ForecastShareBasis;
  createdAt: number;
  isCurrent: boolean;
};

export type ForecastRevisionDirection = "upward" | "downward" | "unchanged" | "not_comparable" | "needs_review" | "unavailable";
export type ForecastRevisionReason = "same_comparable_basis" | "comparison_basis_changed" | "normalization_needs_review" | "superseded_forecast_not_available";

export type ForecastRevisionEvent = {
  forecastId: string;
  supersedesForecastId: string;
  institution: string | null;
  forecastDate: string;
  metric: ForecastMetric;
  fiscalYear: number;
  fiscalPeriod: string;
  currentValue: number | null;
  previousValue: number | null;
  normalizedUnit: string | null;
  currency: string | null;
  direction: ForecastRevisionDirection;
  reasonCode: ForecastRevisionReason;
  absoluteChange: number | null;
  percentageChange: number | null;
  isCurrent: boolean;
};

export type ForecastRevisionChain = {
  chainId: string;
  rootForecastId: string;
  leafForecastId: string;
  forecastIds: string[];
  isCurrentLeaf: boolean;
  branchStatus: "linear" | "branched" | "broken" | "cyclic";
};

export type ForecastRevisionReadModel = {
  label: "来源预测修订链";
  ruleVersion: string;
  directions: ForecastRevisionEvent[];
  chains: ForecastRevisionChain[];
  linkedForecastCount: number;
  unlinkedForecastCount: number;
};

export function buildForecastRevisionReadModel(inputs: ForecastRevisionInput[]): ForecastRevisionReadModel {
  const byId = new Map(inputs.map((item) => [item.forecastId, item]));
  const childIds = new Map<string, string[]>();
  for (const item of inputs) {
    if (!item.supersedesForecastId || !byId.has(item.supersedesForecastId)) continue;
    const children = childIds.get(item.supersedesForecastId) || [];
    children.push(item.forecastId);
    childIds.set(item.supersedesForecastId, children);
  }

  const directions = inputs.filter((item) => Boolean(item.supersedesForecastId)).map((item) => directionFor(item, byId));
  const chains = inputs.filter((item) => !childIds.has(item.forecastId)).map((leaf) => chainFor(leaf, byId, childIds))
    .sort((left, right) => left.rootForecastId.localeCompare(right.rootForecastId) || left.leafForecastId.localeCompare(right.leafForecastId));

  return {
    label: "来源预测修订链",
    ruleVersion: FORECAST_REVISION_READ_MODEL_VERSION,
    directions: directions.sort((left, right) => right.forecastDate.localeCompare(left.forecastDate) || right.forecastId.localeCompare(left.forecastId)),
    chains,
    linkedForecastCount: directions.length,
    unlinkedForecastCount: inputs.filter((item) => !item.supersedesForecastId).length,
  };
}

function directionFor(current: ForecastRevisionInput, byId: Map<string, ForecastRevisionInput>): ForecastRevisionEvent {
  const predecessor = current.supersedesForecastId ? byId.get(current.supersedesForecastId) : null;
  const event = {
    forecastId: current.forecastId,
    supersedesForecastId: current.supersedesForecastId!,
    institution: current.institution,
    forecastDate: current.forecastDate,
    metric: current.metric,
    fiscalYear: current.fiscalYear,
    fiscalPeriod: current.fiscalPeriod,
    currentValue: current.normalizedValue,
    previousValue: predecessor?.normalizedValue ?? null,
    normalizedUnit: current.normalizedUnit,
    currency: current.currency,
    isCurrent: current.isCurrent,
  };
  if (!predecessor) return { ...event, direction: "unavailable", reasonCode: "superseded_forecast_not_available", absoluteChange: null, percentageChange: null };
  if (current.normalizationStatus !== "comparable" || predecessor.normalizationStatus !== "comparable"
    || current.normalizedValue === null || predecessor.normalizedValue === null || !current.normalizedUnit || !predecessor.normalizedUnit) {
    return { ...event, direction: "needs_review", reasonCode: "normalization_needs_review", absoluteChange: null, percentageChange: null };
  }
  if (comparisonKey(current) !== comparisonKey(predecessor)) {
    return { ...event, direction: "not_comparable", reasonCode: "comparison_basis_changed", absoluteChange: null, percentageChange: null };
  }
  const absoluteChange = round(current.normalizedValue - predecessor.normalizedValue);
  return {
    ...event,
    direction: absoluteChange > 0 ? "upward" : absoluteChange < 0 ? "downward" : "unchanged",
    reasonCode: "same_comparable_basis",
    absoluteChange,
    percentageChange: predecessor.normalizedValue === 0 ? null : round(absoluteChange / Math.abs(predecessor.normalizedValue)),
  };
}

function chainFor(leaf: ForecastRevisionInput, byId: Map<string, ForecastRevisionInput>, childIds: Map<string, string[]>): ForecastRevisionChain {
  const ids: string[] = [];
  const seen = new Set<string>();
  let item: ForecastRevisionInput | undefined = leaf;
  let branchStatus: ForecastRevisionChain["branchStatus"] = "linear";
  while (item) {
    if (seen.has(item.forecastId)) { branchStatus = "cyclic"; break; }
    seen.add(item.forecastId);
    ids.unshift(item.forecastId);
    if (!item.supersedesForecastId) break;
    const parent = byId.get(item.supersedesForecastId);
    if (!parent) { branchStatus = "broken"; break; }
    if ((childIds.get(parent.forecastId) || []).length > 1 && branchStatus === "linear") branchStatus = "branched";
    item = parent;
  }
  const rootForecastId = ids[0] || leaf.forecastId;
  return { chainId: `forecast-revision-chain:${rootForecastId}:${leaf.forecastId}`, rootForecastId, leafForecastId: leaf.forecastId,
    forecastIds: ids, isCurrentLeaf: leaf.isCurrent, branchStatus };
}

function comparisonKey(item: ForecastRevisionInput): string {
  return [item.metric, item.fiscalYear, item.fiscalPeriod, normalize(item.currency), item.normalizedUnit,
    item.accountingBasis, item.ownershipBasis, item.shareBasis].join("|");
}

function normalize(value: string | null): string { return String(value || "").trim().toUpperCase() || "none"; }
function round(value: number): number { return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000; }
