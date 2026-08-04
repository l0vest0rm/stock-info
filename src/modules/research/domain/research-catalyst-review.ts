import type { ResearchSourceReference } from "./research-dossier";

export type ResearchCatalystReviewStatus = "observed" | "partially_confirmed" | "confirmed" | "missed" | "not_comparable";
export type ResearchCatalystAssumptionStatus = "confirmed" | "weakened" | "invalidated" | "not_tested";

export type ResearchCatalystReview = {
  catalystReviewId: string;
  catalystId: string;
  companyId: string | null;
  securityCode: string;
  asOf: number;
  reviewStatus: ResearchCatalystReviewStatus;
  outcomeSummary: string;
  expectedVsActual: string;
  impactedAssumptionStatus: ResearchCatalystAssumptionStatus;
  nextAction: string;
  sourceReferences: ResearchSourceReference[];
  reviewedAt: number;
  createdAt: number;
};

const REVIEW_STATUSES: ResearchCatalystReviewStatus[] = ["observed", "partially_confirmed", "confirmed", "missed", "not_comparable"];
const ASSUMPTION_STATUSES: ResearchCatalystAssumptionStatus[] = ["confirmed", "weakened", "invalidated", "not_tested"];

/**
 * Event outcomes are observed facts, not a new investment conclusion.  This
 * keeps a later review auditable without allowing a reviewer to hide the
 * original expectation, or to attach an unsupported personal decision.
 */
export function assertResearchCatalystReview(input: ResearchCatalystReview): void {
  required(input.catalystReviewId, "catalyst review id");
  required(input.catalystId, "catalyst id");
  required(input.securityCode, "catalyst review security code");
  finiteTimestamp(input.asOf, "catalyst review asOf");
  finiteTimestamp(input.reviewedAt, "catalyst review reviewedAt");
  finiteTimestamp(input.createdAt, "catalyst review createdAt");
  required(input.outcomeSummary, "catalyst review outcome summary");
  required(input.expectedVsActual, "catalyst review expected versus actual");
  required(input.nextAction, "catalyst review next action");
  if (!REVIEW_STATUSES.includes(input.reviewStatus)) throw new Error("unsupported catalyst review status");
  if (!ASSUMPTION_STATUSES.includes(input.impactedAssumptionStatus)) throw new Error("unsupported catalyst review assumption status");
  if (!Array.isArray(input.sourceReferences) || input.sourceReferences.length === 0) throw new Error("catalyst review requires observed outcome source references");
  for (const reference of input.sourceReferences) {
    if (!reference.sourceKind) throw new Error("catalyst review outcome references require a source kind");
    required(reference.url ?? "", "catalyst review source URL");
    required(reference.title ?? "", "catalyst review source title");
  }
}

function required(value: string, label: string) { if (!String(value).trim()) throw new Error(`${label} is required`); }
function finiteTimestamp(value: number, label: string) { if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive timestamp`); }
