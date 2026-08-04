import type { ForecastActualCalibration, FormalActual } from "./forecast-actual-calibration";
import type { FormalActualCandidate, FormalActualCandidateReview } from "./formal-actual-candidate";

/**
 * A read-only integrity view over the formal-actual ledger.  Calibration
 * observations are immutable: when a later filing supersedes an actual, we
 * must not rewrite a historical error statistic.  This projection therefore
 * reports both what was recorded at the time and whether that observation is
 * still usable as the current calibration evidence.
 */
export const FORMAL_ACTUAL_HEALTH_RULE_VERSION = "formal-actual-health.v1";

export type FormalActualCalibrationCurrentState =
  | "recorded_comparable_current"
  | "recorded_comparable_superseded_actual"
  | "recorded_comparable_restatement_actual"
  | "recorded_not_comparable"
  | "missing_actual";

export type FormalActualCandidateWorkflowState =
  | "pending_human_review"
  | "blocked_by_statutory_verification"
  | "needs_evidence"
  | "rejected"
  | "accepted"
  | "accepted_actual_missing";

export type FormalActualCandidateStatutoryCurrentness =
  | "current_statutory_document"
  | "newer_statutory_document_available"
  | "same_day_statutory_document_ambiguity"
  | "statutory_document_metadata_incomplete";

export type FormalActualLineageIssueReason =
  | "superseded_actual_without_restatement_successor"
  | "restatement_missing_predecessor"
  | "restatement_cross_security"
  | "restatement_metric_or_period_mismatch"
  | "restatement_revision_not_incremental"
  | "restatement_branching_successors"
  | "restatement_cycle";

export type FormalActualHealth = {
  ruleVersion: typeof FORMAL_ACTUAL_HEALTH_RULE_VERSION;
  /** `available` means at least one current, comparable calibration remains. */
  calibrationAvailability: "available" | "partial" | "unavailable";
  actualCount: number;
  currentActualCount: number;
  restatedActualCount: number;
  supersededActualCount: number;
  calibrationCount: number;
  currentComparableCalibrationCount: number;
  historicalCalibrationAffectedByRestatementCount: number;
  candidateWorkflow: {
    pendingHumanReviewCount: number;
    blockedByStatutoryVerificationCount: number;
    needsEvidenceCount: number;
    rejectedCount: number;
    acceptedCount: number;
    acceptedActualMissingCount: number;
    newerStatutoryDocumentAvailableCount: number;
    sameDayStatutoryDocumentAmbiguityCount: number;
  };
  calibrationStates: Array<{
    calibrationId: string;
    actualId: string;
    recordedComparabilityStatus: ForecastActualCalibration["comparabilityStatus"];
    recordedComparabilityReason: ForecastActualCalibration["comparabilityReason"];
    currentState: FormalActualCalibrationCurrentState;
  }>;
  candidateStates: Array<{
    candidateId: string;
    state: FormalActualCandidateWorkflowState;
    latestReviewId: string | null;
    actualId: string | null;
    reason: string | null;
    statutoryCurrentness: FormalActualCandidateStatutoryCurrentness;
  }>;
  lineageIssues: Array<{ actualId: string; relatedActualId: string | null; reason: FormalActualLineageIssueReason }>;
};

export function buildFormalActualHealth(input: {
  actuals: FormalActual[];
  calibrations: Array<ForecastActualCalibration & { calibrationId: string }>;
  candidates: FormalActualCandidate[];
  candidateReviews: FormalActualCandidateReview[];
}): FormalActualHealth {
  const actualById = new Map(input.actuals.map((actual) => [actual.actualId, actual]));
  const latestReviews = latestReviewByCandidate(input.candidateReviews);
  const candidateCurrentnessById = statutoryCurrentnessByCandidateId(input.candidates);
  const calibrationStates = input.calibrations.map((calibration) => calibrationState(calibration, actualById));
  const candidateStates = input.candidates.map((candidate) => candidateState(candidate, latestReviews.get(candidate.candidateId), actualById, candidateCurrentnessById));
  const currentComparableCalibrationCount = calibrationStates.filter((item) => item.currentState === "recorded_comparable_current").length;
  const historicalCalibrationAffectedByRestatementCount = calibrationStates.filter((item) => item.currentState === "recorded_comparable_superseded_actual" || item.currentState === "recorded_comparable_restatement_actual").length;
  const stateCounts = new Map<FormalActualCandidateWorkflowState, number>(candidateStates.map((item) => [item.state, 0]));
  for (const state of candidateStates) stateCounts.set(state.state, (stateCounts.get(state.state) ?? 0) + 1);

  return {
    ruleVersion: FORMAL_ACTUAL_HEALTH_RULE_VERSION,
    calibrationAvailability: currentComparableCalibrationCount > 0 ? "available" : input.calibrations.length ? "partial" : "unavailable",
    actualCount: input.actuals.length,
    // A restated actual supersedes an older value but is itself the current
    // formal fact.  It stays unsuitable for current calibration until a new
    // comparable forecast exists; that stricter rule is enforced separately
    // by `currentComparableCalibrationCount`.
    currentActualCount: input.actuals.filter((actual) => actual.actualStatus !== "superseded").length,
    restatedActualCount: input.actuals.filter((actual) => actual.actualStatus === "restated").length,
    supersededActualCount: input.actuals.filter((actual) => actual.actualStatus === "superseded").length,
    calibrationCount: input.calibrations.length,
    currentComparableCalibrationCount,
    historicalCalibrationAffectedByRestatementCount,
    candidateWorkflow: {
      pendingHumanReviewCount: stateCounts.get("pending_human_review") ?? 0,
      blockedByStatutoryVerificationCount: stateCounts.get("blocked_by_statutory_verification") ?? 0,
      needsEvidenceCount: stateCounts.get("needs_evidence") ?? 0,
      rejectedCount: stateCounts.get("rejected") ?? 0,
      acceptedCount: stateCounts.get("accepted") ?? 0,
      acceptedActualMissingCount: stateCounts.get("accepted_actual_missing") ?? 0,
      newerStatutoryDocumentAvailableCount: candidateStates.filter((item) => item.statutoryCurrentness === "newer_statutory_document_available").length,
      sameDayStatutoryDocumentAmbiguityCount: candidateStates.filter((item) => item.statutoryCurrentness === "same_day_statutory_document_ambiguity").length,
    },
    calibrationStates,
    candidateStates,
    lineageIssues: formalActualLineageIssues(input.actuals),
  };
}

function calibrationState(
  calibration: ForecastActualCalibration & { calibrationId: string },
  actualById: Map<string, FormalActual>,
): FormalActualHealth["calibrationStates"][number] {
  const actual = actualById.get(calibration.actualId);
  let currentState: FormalActualCalibrationCurrentState;
  if (!actual) currentState = "missing_actual";
  else if (calibration.comparabilityStatus !== "comparable") currentState = "recorded_not_comparable";
  else if (actual.actualStatus === "superseded") currentState = "recorded_comparable_superseded_actual";
  else if (actual.actualStatus === "restated") currentState = "recorded_comparable_restatement_actual";
  else currentState = "recorded_comparable_current";
  return {
    calibrationId: calibration.calibrationId,
    actualId: calibration.actualId,
    recordedComparabilityStatus: calibration.comparabilityStatus,
    recordedComparabilityReason: calibration.comparabilityReason,
    currentState,
  };
}

function latestReviewByCandidate(reviews: FormalActualCandidateReview[]): Map<string, FormalActualCandidateReview> {
  const result = new Map<string, FormalActualCandidateReview>();
  for (const review of reviews) {
    const previous = result.get(review.candidateId);
    if (!previous || review.reviewedAt > previous.reviewedAt || (review.reviewedAt === previous.reviewedAt && review.reviewId > previous.reviewId)) {
      result.set(review.candidateId, review);
    }
  }
  return result;
}

function candidateState(
  candidate: FormalActualCandidate,
  review: FormalActualCandidateReview | undefined,
  actualById: Map<string, FormalActual>,
  statutoryCurrentness: Map<string, FormalActualCandidateStatutoryCurrentness>,
): FormalActualHealth["candidateStates"][number] {
  const candidateCurrentness = statutoryCurrentness.get(candidate.candidateId) ?? "statutory_document_metadata_incomplete";
  if (candidate.eligibility === "blocked") {
    return { candidateId: candidate.candidateId, state: "blocked_by_statutory_verification", latestReviewId: review?.reviewId ?? null, actualId: review?.actualId ?? null, reason: candidate.blockingReason, statutoryCurrentness: candidateCurrentness };
  }
  if (!review) return { candidateId: candidate.candidateId, state: "pending_human_review", latestReviewId: null, actualId: null, reason: null, statutoryCurrentness: candidateCurrentness };
  if (review.decision === "needs_evidence") return { candidateId: candidate.candidateId, state: "needs_evidence", latestReviewId: review.reviewId, actualId: null, reason: review.reason, statutoryCurrentness: candidateCurrentness };
  if (review.decision === "rejected") return { candidateId: candidate.candidateId, state: "rejected", latestReviewId: review.reviewId, actualId: null, reason: review.reason, statutoryCurrentness: candidateCurrentness };
  if (!review.actualId || !actualById.has(review.actualId)) {
    return { candidateId: candidate.candidateId, state: "accepted_actual_missing", latestReviewId: review.reviewId, actualId: review.actualId, reason: review.reason, statutoryCurrentness: candidateCurrentness };
  }
  return { candidateId: candidate.candidateId, state: "accepted", latestReviewId: review.reviewId, actualId: review.actualId, reason: review.reason, statutoryCurrentness: candidateCurrentness };
}

/** Pre-group immutable candidate history so the read model remains linear in its size. */
function statutoryCurrentnessByCandidateId(candidates: FormalActualCandidate[]): Map<string, FormalActualCandidateStatutoryCurrentness> {
  const result = new Map<string, FormalActualCandidateStatutoryCurrentness>();
  const groups = new Map<string, FormalActualCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.securityCode}\u0000${candidate.metric}\u0000${candidate.fiscalPeriod}`;
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const documentDates = new Map<string, string>();
    for (const candidate of group) {
      if (!candidate.statutoryDocumentId || !candidate.statutoryPublishedAt) continue;
      const prior = documentDates.get(candidate.statutoryDocumentId);
      if (!prior || candidate.statutoryPublishedAt > prior) documentDates.set(candidate.statutoryDocumentId, candidate.statutoryPublishedAt);
    }
    const orderedDates = [...new Set(documentDates.values())].sort((left, right) => right.localeCompare(left));
    const maxDate = orderedDates[0] ?? null;
    const secondMaxDate = orderedDates[1] ?? null;
    const documentCountByDate = new Map<string, number>();
    for (const publishedAt of documentDates.values()) documentCountByDate.set(publishedAt, (documentCountByDate.get(publishedAt) ?? 0) + 1);
    for (const candidate of group) {
      if (!candidate.statutoryDocumentId || !candidate.statutoryPublishedAt) {
        result.set(candidate.candidateId, "statutory_document_metadata_incomplete");
        continue;
      }
      const ownDocumentDate = documentDates.get(candidate.statutoryDocumentId) ?? null;
      const maximumOtherDocumentDate = ownDocumentDate === maxDate && (documentCountByDate.get(maxDate ?? "") ?? 0) === 1 ? secondMaxDate : maxDate;
      if (maximumOtherDocumentDate && maximumOtherDocumentDate > candidate.statutoryPublishedAt) {
        result.set(candidate.candidateId, "newer_statutory_document_available");
      } else if ((documentCountByDate.get(candidate.statutoryPublishedAt) ?? 0) > (ownDocumentDate === candidate.statutoryPublishedAt ? 1 : 0)) {
        result.set(candidate.candidateId, "same_day_statutory_document_ambiguity");
      } else result.set(candidate.candidateId, "current_statutory_document");
    }
  }
  return result;
}

function formalActualLineageIssues(actuals: FormalActual[]): FormalActualHealth["lineageIssues"] {
  const actualById = new Map(actuals.map((actual) => [actual.actualId, actual]));
  const successors = new Map<string, FormalActual[]>();
  const issues: FormalActualHealth["lineageIssues"] = [];
  for (const actual of actuals) {
    if (!actual.supersedesActualId) continue;
    const list = successors.get(actual.supersedesActualId) ?? [];
    list.push(actual);
    successors.set(actual.supersedesActualId, list);
    const predecessor = actualById.get(actual.supersedesActualId);
    if (!predecessor) {
      issues.push({ actualId: actual.actualId, relatedActualId: actual.supersedesActualId, reason: "restatement_missing_predecessor" });
      continue;
    }
    if (predecessor.securityCode !== actual.securityCode) issues.push({ actualId: actual.actualId, relatedActualId: predecessor.actualId, reason: "restatement_cross_security" });
    if (predecessor.metric !== actual.metric || predecessor.fiscalPeriod !== actual.fiscalPeriod) issues.push({ actualId: actual.actualId, relatedActualId: predecessor.actualId, reason: "restatement_metric_or_period_mismatch" });
    if (actual.revisionNumber !== predecessor.revisionNumber + 1) issues.push({ actualId: actual.actualId, relatedActualId: predecessor.actualId, reason: "restatement_revision_not_incremental" });
  }
  for (const actual of actuals) {
    const directSuccessors = successors.get(actual.actualId) ?? [];
    if (actual.actualStatus === "superseded" && directSuccessors.length === 0) issues.push({ actualId: actual.actualId, relatedActualId: null, reason: "superseded_actual_without_restatement_successor" });
    if (directSuccessors.length > 1) issues.push({ actualId: actual.actualId, relatedActualId: null, reason: "restatement_branching_successors" });
    if (hasCycle(actual, actualById)) issues.push({ actualId: actual.actualId, relatedActualId: actual.supersedesActualId, reason: "restatement_cycle" });
  }
  return dedupeIssues(issues);
}

function hasCycle(start: FormalActual, actualById: Map<string, FormalActual>): boolean {
  const visited = new Set<string>();
  let cursor: FormalActual | undefined = start;
  while (cursor?.supersedesActualId) {
    if (visited.has(cursor.actualId)) return true;
    visited.add(cursor.actualId);
    cursor = actualById.get(cursor.supersedesActualId);
  }
  return false;
}

function dedupeIssues(issues: FormalActualHealth["lineageIssues"]): FormalActualHealth["lineageIssues"] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.actualId}:${issue.relatedActualId ?? ""}:${issue.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
