import type { ForecastAccountingBasis, ForecastMetric, ForecastOwnershipBasis, ForecastShareBasis } from "./forecast-consolidation";

export const FORMAL_ACTUAL_CANDIDATE_RULE_VERSION = "formal-actual-candidate.v2";
export const FORMAL_FINANCIAL_FACT_DICTIONARY_VERSION = "formal-financial-fact-dictionary.v1";

/**
 * This is deliberately a small, explicit bridge rather than a copy of every
 * financial-statement line item.  An entry may enter the formal-actual ledger
 * only when it has the same semantic type as a source forecast and can be
 * normalized by the forecast contract.  Ratios (for example gross margin)
 * and derived facts remain derived observations; they must not be smuggled
 * into this filing-fact ledger as if they were directly reported values.
 */
export const FORMAL_FINANCIAL_FACT_DICTIONARY = [
  {
    entryId: "formal-financial-fact:revenue",
    sourceMetric: "revenue",
    forecastMetric: "revenue",
    displayName: "营业收入 / Revenue",
    rawUnit: "currency",
    requiredSemanticConfirmations: ["accounting_basis"],
  },
  {
    entryId: "formal-financial-fact:net-profit",
    sourceMetric: "net_profit",
    forecastMetric: "net_profit",
    displayName: "净利润 / Net profit",
    rawUnit: "currency",
    // Consolidated and attributable-to-parent net profit are different facts.
    // The verifier establishes source-basis equality; the reviewer still
    // names which one is comparable with the selected forecast.
    requiredSemanticConfirmations: ["accounting_basis", "ownership_basis"],
  },
  {
    entryId: "formal-financial-fact:operating-cash-flow",
    sourceMetric: "operating_cash_flow",
    forecastMetric: "operating_cash_flow",
    displayName: "经营活动现金流 / Operating cash flow",
    rawUnit: "currency",
    requiredSemanticConfirmations: ["accounting_basis"],
  },
] as const;

export type FormalFinancialFactDictionaryEntry = typeof FORMAL_FINANCIAL_FACT_DICTIONARY[number];

export function formalFinancialFactDictionaryEntry(metric: string): FormalFinancialFactDictionaryEntry | null {
  return FORMAL_FINANCIAL_FACT_DICTIONARY.find((entry) => entry.sourceMetric === metric) ?? null;
}

export type FormalActualCandidateEligibility = "ready_for_review" | "blocked";
export type FormalActualCandidateDecision = "accepted" | "rejected" | "needs_evidence";
export type ModelReviewItemState = "open" | "acknowledged" | "resolved" | "not_applicable";
export type ModelReviewTargetKind = "dcf" | "reverse_dcf" | "scenario";
export type ModelReviewTriggerKind = "formal_actual_accepted" | "actual_restatement" | "calibration_available" | "calibration_blocked" | "management_guidance_reviewed" | "catalyst_actual_reviewed";

export type FormalActualCandidate = {
  candidateId: string;
  securityCode: string;
  verificationId: string;
  /** Null only on an immutable candidate materialized before comparison-key migration. */
  canonicalComparisonKey: string | null;
  metric: string;
  forecastMetric: ForecastMetric | null;
  /** Immutable dictionary mapping used when this candidate was materialized. */
  factDictionaryEntryId: string | null;
  factDictionaryVersion: string | null;
  fiscalYear: number;
  fiscalPeriod: string;
  periodStartDate: string;
  periodEndDate: string;
  reportedValue: number | null;
  reportedUnit: "currency" | null;
  currency: string | null;
  statutoryProvider: string;
  statutoryDocumentId: string | null;
  statutoryDisclosureUrl: string | null;
  statutoryLocator: string | null;
  statutoryPublishedAt: string | null;
  statutoryReportDate: string | null;
  sourceBinding: Record<string, unknown>;
  candidateRuleVersion: string;
  eligibility: FormalActualCandidateEligibility;
  blockingReason: string | null;
  createdAt: number;
};

export type FormalActualCandidateReview = {
  reviewId: string;
  candidateId: string;
  decision: FormalActualCandidateDecision;
  reviewer: string;
  reason: string;
  accountingBasis: ForecastAccountingBasis | null;
  ownershipBasis: ForecastOwnershipBasis | null;
  shareBasis: ForecastShareBasis | null;
  actualId: string | null;
  reviewedAt: number;
  createdAt: number;
};

export type ResearchModelReviewItem = {
  reviewItemId: string;
  securityCode: string;
  triggerKind: ModelReviewTriggerKind;
  triggerId: string;
  targetKind: ModelReviewTargetKind;
  targetVersionId: string;
  state: ModelReviewItemState;
  reason: string;
  evidence: Record<string, unknown>;
  createdAt: number;
  reviewedAt: number | null;
  resolutionNote: string | null;
};

/**
 * The current item state is a convenience read model.  Every local action is
 * also appended to this immutable audit log, so resolving a review cannot
 * erase the fact/calibration that made the review necessary.
 */
export type ResearchModelReviewAction = {
  actionId: string;
  reviewItemId: string;
  previousState: "open";
  nextState: Exclude<ModelReviewItemState, "open">;
  actedBy: string;
  resolutionNote: string;
  followUpTargetKind: ModelReviewTargetKind | null;
  followUpTargetVersionId: string | null;
  actedAt: number;
};
