import type { ForecastAccountingBasis, ForecastMetric, ForecastOwnershipBasis, ForecastShareBasis } from "./forecast-consolidation";

/**
 * Management guidance is a source-bound statement, not a third-party
 * forecast and not a system estimate.  A revision exists only when the newer
 * disclosure names the immutable earlier guidance record it supersedes.
 */
export const MANAGEMENT_GUIDANCE_REVISION_READ_MODEL_VERSION = "management-guidance-revision.v1";

export type ManagementGuidanceRevisionInput = {
  forecastId: string;
  supersedesGuidanceForecastId: string | null;
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
};

export type ManagementGuidanceRevisionDirection = "upward" | "downward" | "unchanged" | "not_comparable" | "needs_review" | "unavailable";
export type ManagementGuidanceRevisionReason = "same_comparable_basis" | "comparison_basis_changed" | "normalization_needs_review" | "superseded_guidance_not_available";

export type ManagementGuidanceRevisionEvent = {
  forecastId: string;
  supersedesGuidanceForecastId: string;
  forecastDate: string;
  metric: ForecastMetric;
  fiscalYear: number;
  fiscalPeriod: string;
  currentValue: number | null;
  previousValue: number | null;
  normalizedUnit: string | null;
  currency: string | null;
  direction: ManagementGuidanceRevisionDirection;
  reasonCode: ManagementGuidanceRevisionReason;
  absoluteChange: number | null;
  percentageChange: number | null;
};

export type ManagementGuidanceRevisionChain = {
  chainId: string;
  rootForecastId: string;
  leafForecastId: string;
  forecastIds: string[];
  branchStatus: "linear" | "branched" | "broken" | "cyclic";
};

export type ManagementGuidanceRevisionReadModel = {
  label: "管理层指引修订链";
  ruleVersion: typeof MANAGEMENT_GUIDANCE_REVISION_READ_MODEL_VERSION;
  directions: ManagementGuidanceRevisionEvent[];
  chains: ManagementGuidanceRevisionChain[];
  linkedGuidanceCount: number;
  unlinkedGuidanceCount: number;
};

export function buildManagementGuidanceRevisionReadModel(inputs: ManagementGuidanceRevisionInput[]): ManagementGuidanceRevisionReadModel {
  const byId = new Map(inputs.map((item) => [item.forecastId, item]));
  const childIds = new Map<string, string[]>();
  for (const item of inputs) {
    if (!item.supersedesGuidanceForecastId || !byId.has(item.supersedesGuidanceForecastId)) continue;
    const children = childIds.get(item.supersedesGuidanceForecastId) || [];
    children.push(item.forecastId);
    childIds.set(item.supersedesGuidanceForecastId, children);
  }
  const directions = inputs.filter((item) => Boolean(item.supersedesGuidanceForecastId))
    .map((item) => directionFor(item, byId))
    .sort((left, right) => right.forecastDate.localeCompare(left.forecastDate) || right.forecastId.localeCompare(left.forecastId));
  const chains = inputs.filter((item) => !childIds.has(item.forecastId))
    .map((leaf) => chainFor(leaf, byId, childIds))
    .sort((left, right) => left.rootForecastId.localeCompare(right.rootForecastId) || left.leafForecastId.localeCompare(right.leafForecastId));
  return {
    label: "管理层指引修订链",
    ruleVersion: MANAGEMENT_GUIDANCE_REVISION_READ_MODEL_VERSION,
    directions,
    chains,
    linkedGuidanceCount: directions.length,
    unlinkedGuidanceCount: inputs.filter((item) => !item.supersedesGuidanceForecastId).length,
  };
}

function directionFor(current: ManagementGuidanceRevisionInput, byId: Map<string, ManagementGuidanceRevisionInput>): ManagementGuidanceRevisionEvent {
  const predecessor = current.supersedesGuidanceForecastId ? byId.get(current.supersedesGuidanceForecastId) : null;
  const event = {
    forecastId: current.forecastId,
    supersedesGuidanceForecastId: current.supersedesGuidanceForecastId!,
    forecastDate: current.forecastDate,
    metric: current.metric,
    fiscalYear: current.fiscalYear,
    fiscalPeriod: current.fiscalPeriod,
    currentValue: current.normalizedValue,
    previousValue: predecessor?.normalizedValue ?? null,
    normalizedUnit: current.normalizedUnit,
    currency: current.currency,
  };
  if (!predecessor) return { ...event, direction: "unavailable", reasonCode: "superseded_guidance_not_available", absoluteChange: null, percentageChange: null };
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

function chainFor(leaf: ManagementGuidanceRevisionInput, byId: Map<string, ManagementGuidanceRevisionInput>, childIds: Map<string, string[]>): ManagementGuidanceRevisionChain {
  const ids: string[] = [];
  const seen = new Set<string>();
  let item: ManagementGuidanceRevisionInput | undefined = leaf;
  let branchStatus: ManagementGuidanceRevisionChain["branchStatus"] = "linear";
  while (item) {
    if (seen.has(item.forecastId)) { branchStatus = "cyclic"; break; }
    seen.add(item.forecastId);
    ids.unshift(item.forecastId);
    if (!item.supersedesGuidanceForecastId) break;
    const parent = byId.get(item.supersedesGuidanceForecastId);
    if (!parent) { branchStatus = "broken"; break; }
    if ((childIds.get(parent.forecastId) || []).length > 1 && branchStatus === "linear") branchStatus = "branched";
    item = parent;
  }
  const rootForecastId = ids[0] || leaf.forecastId;
  return {
    chainId: `management-guidance-revision-chain:${rootForecastId}:${leaf.forecastId}`,
    rootForecastId,
    leafForecastId: leaf.forecastId,
    forecastIds: ids,
    branchStatus,
  };
}

function comparisonKey(item: ManagementGuidanceRevisionInput): string {
  return [item.metric, item.fiscalYear, item.fiscalPeriod, normalize(item.currency), item.normalizedUnit,
    item.accountingBasis, item.ownershipBasis, item.shareBasis].join("|");
}

function normalize(value: string | null): string { return String(value || "").trim().toUpperCase() || "none"; }
function round(value: number): number { return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000; }
