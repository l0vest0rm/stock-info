import { FORECAST_CONSOLIDATION_RULE_VERSION } from "./forecast-consolidation";

export type ForecastCoverageStatus = "ready" | "partial" | "blocked" | "unavailable";

export type ForecastCoverageReadModel = {
  ruleVersion: "forecast-coverage.v1";
  /** This is deliberately never a market consensus. */
  sourceUniverse: "opportunistic_research_documents";
  marketConsensus: false;
  status: ForecastCoverageStatus;
  asOf: number | null;
  counts: {
    /** Source-bound forecast assertions discovered from information processing. */
    candidates: number;
    /** Candidates that a local reviewer has explicitly decided on. */
    reviewed: number;
    /** Candidates that still require a local review decision. */
    pending: number;
    /** Candidates manually rejected before source-forecast standardisation. */
    reviewExcluded: number;
    /** Reviewed current samples with a confirmed original carrier, lineage and independent group. */
    originalEligible: number;
    /** Current v4 consolidation members admitted to the opportunistic sample. */
    included: number;
    /** Current v4 consolidation members excluded with a retained reason code. */
    excluded: number;
  };
  consolidation: {
    availability: "available" | "empty" | "unavailable";
    consolidationId: string | null;
    label: "已纳入样本的预测汇总" | null;
    ruleVersion: string | null;
    reason: string | null;
  };
};

type Candidate = { informationId?: unknown; reviewStatus?: unknown; reviewedAt?: unknown };
type SourceForecast = {
  forecastId?: unknown;
  sourceIdentityAssertionId?: unknown;
  originSourceIdentityId?: unknown;
  carrierSourceIdentityId?: unknown;
  carrierRelation?: unknown;
  modelLineageId?: unknown;
  independenceGroupId?: unknown;
  normalizationStatus?: unknown;
  createdAt?: unknown;
};
type ConsolidationMember = { forecastId?: unknown; membershipStatus?: unknown; reasonCode?: unknown };
type Workspace = {
  sourceCandidates?: unknown;
  sourceForecasts?: unknown;
  consolidation?: {
    consolidationId?: unknown;
    asOf?: unknown;
    label?: unknown;
    ruleVersion?: unknown;
    marketConsensus?: unknown;
    members?: unknown;
  } | null;
  consolidationStatus?: { availability?: unknown; reason?: unknown; priorRuleVersion?: unknown } | null;
};

const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;
const countDistinct = <T>(items: T[], key: (item: T, index: number) => string) => new Set(items.map(key)).size;
const records = <T>(value: unknown): T[] => Array.isArray(value) ? value as T[] : [];
const timestamp = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;

/**
 * Read-only v4 forecast coverage.  Candidate discovery, review, eligible
 * original research, aggregation membership and later self-built scenarios
 * are intentionally separate states.  This function does not create a
 * forecast, infer an identity, or promote an opportunistic sample to a market
 * consensus.
 */
export function buildForecastCoverageReadModel(workspace: Workspace): ForecastCoverageReadModel {
  const candidates = records<Candidate>(workspace.sourceCandidates);
  const sourceForecasts = records<SourceForecast>(workspace.sourceForecasts);
  const consolidation = workspace.consolidation ?? null;
  const members = records<ConsolidationMember>(consolidation?.members);
  const reviewStatus = (candidate: Candidate) => text(candidate.reviewStatus);
  const pendingCandidates = candidates.filter((candidate) => {
    const status = reviewStatus(candidate);
    return status === null || status === "needs_review";
  });
  const reviewedCandidates = candidates.filter((candidate) => {
    const status = reviewStatus(candidate);
    return status === "included" || status === "excluded";
  });
  const reviewExcludedCandidates = candidates.filter((candidate) => reviewStatus(candidate) === "excluded");
  const originalEligible = sourceForecasts.filter(isOriginalEligible);
  const originalEligibleIds = new Set(originalEligible.map((forecast) => text(forecast.forecastId)).filter((id): id is string => Boolean(id)));
  const included = members.filter((member) => member.membershipStatus === "included" && member.reasonCode === "included"
    && originalEligibleIds.has(text(member.forecastId) ?? ""));
  const excluded = members.filter((member) => member.membershipStatus === "excluded");
  const availableConsolidation = workspace.consolidationStatus?.availability === "available"
    && consolidation?.ruleVersion === FORECAST_CONSOLIDATION_RULE_VERSION
    && consolidation?.marketConsensus === false
    && consolidation?.label === "已纳入样本的预测汇总";
  const status: ForecastCoverageStatus = availableConsolidation && included.length > 0
    ? "ready"
    : originalEligible.length > 0
      ? "partial"
      : reviewedCandidates.length > 0 || candidates.length > 0
        ? "blocked"
        : "unavailable";
  const latestReview = Math.max(0, ...candidates.map((candidate) => timestamp(candidate.reviewedAt) ?? 0));
  const latestForecast = Math.max(0, ...sourceForecasts.map((forecast) => timestamp(forecast.createdAt) ?? 0));
  const consolidationAsOf = timestamp(consolidation?.asOf);
  return {
    ruleVersion: "forecast-coverage.v1",
    sourceUniverse: "opportunistic_research_documents",
    marketConsensus: false,
    status,
    asOf: consolidationAsOf ?? (Math.max(latestReview, latestForecast) || null),
    counts: {
      candidates: countDistinct(candidates, (candidate, index) => text(candidate.informationId) ?? `candidate:${index}`),
      reviewed: countDistinct(reviewedCandidates, (candidate, index) => text(candidate.informationId) ?? `reviewed:${index}`),
      pending: countDistinct(pendingCandidates, (candidate, index) => text(candidate.informationId) ?? `pending:${index}`),
      reviewExcluded: countDistinct(reviewExcludedCandidates, (candidate, index) => text(candidate.informationId) ?? `excluded:${index}`),
      originalEligible: countDistinct(originalEligible, (forecast, index) => text(forecast.forecastId) ?? `eligible:${index}`),
      included: countDistinct(included, (member, index) => text(member.forecastId) ?? `included:${index}`),
      excluded: countDistinct(excluded, (member, index) => text(member.forecastId) ?? `member-excluded:${index}`),
    },
    consolidation: {
      availability: availableConsolidation ? "available"
        : workspace.consolidationStatus?.availability === "unavailable" ? "unavailable" : "empty",
      consolidationId: availableConsolidation ? text(consolidation?.consolidationId) : null,
      label: availableConsolidation ? "已纳入样本的预测汇总" : null,
      ruleVersion: availableConsolidation ? FORECAST_CONSOLIDATION_RULE_VERSION : text(workspace.consolidationStatus?.priorRuleVersion),
      reason: availableConsolidation ? null : text(workspace.consolidationStatus?.reason),
    },
  };
}

export function isOriginalEligible(forecast: SourceForecast): boolean {
  return forecast.carrierRelation === "original"
    && Boolean(text(forecast.sourceIdentityAssertionId))
    && Boolean(text(forecast.originSourceIdentityId))
    && Boolean(text(forecast.carrierSourceIdentityId))
    && Boolean(text(forecast.modelLineageId))
    && Boolean(text(forecast.independenceGroupId))
    && forecast.normalizationStatus === "comparable";
}
