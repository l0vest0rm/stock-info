import type { ResearchSourceReference } from "./research-dossier";

export const GUIDANCE_EVENT_IMPACT_REVIEW_RULE_VERSION = "guidance-event-impact-review.v2";

/** `formal_actual` is only available after the statutory candidate was accepted. */
export type GuidanceEventImpactSourceKind = "management_guidance" | "catalyst_actual" | "formal_actual";
export type GuidanceEventImpactTargetKind = "thesis" | "risk" | "scenario" | "dcf" | "reverse_dcf";
export type GuidanceEventImpactTargetReviewState = "requires_review" | "no_change" | "follow_up_recorded" | "not_applicable";
export type GuidanceEventImpactTargetDisposition = Exclude<GuidanceEventImpactTargetReviewState, "requires_review">;

export type GuidanceEventImpactTarget = {
  impactReviewTargetId: string;
  targetKind: GuidanceEventImpactTargetKind;
  targetId: string;
  reviewState: GuidanceEventImpactTargetReviewState;
  /** Present only after an immutable, local human-action record was appended. */
  action: GuidanceEventImpactReviewTargetAction | null;
};

/**
 * A final human disposition for one explicitly mapped public thesis/risk.
 * It never updates the thesis/risk row: a changed judgement must be appended
 * as a separate record and its exact ID is retained here when applicable.
 */
export type GuidanceEventImpactReviewTargetAction = {
  actionId: string;
  impactReviewTargetId: string;
  previousState: "requires_review";
  decision: GuidanceEventImpactTargetDisposition;
  rationale: string;
  actedBy: string;
  followUpTargetId: string | null;
  actedAt: number;
};

export type GuidanceEventImpactReviewTargetActionWrite = {
  actionId: string;
  decision: GuidanceEventImpactTargetDisposition;
  rationale: string;
  actedBy: string;
  /** Required only when the disposition records a separately appended version. */
  followUpTargetId?: string | null;
  actedAt: number;
};

/** A source fact/guidance has been mapped to existing public records for review.
 * It is intentionally not a conclusion about whether the target remains valid. */
export type GuidanceEventImpactReview = {
  ruleVersion: typeof GUIDANCE_EVENT_IMPACT_REVIEW_RULE_VERSION;
  impactReviewId: string;
  securityCode: string;
  companyId: string | null;
  sourceKind: GuidanceEventImpactSourceKind;
  sourceId: string;
  sourceObservedAt: string | null;
  reviewer: string;
  rationale: string;
  sourceBinding: {
    epistemicType: "management_guidance" | "observed_fact";
    statement: string;
    sourceReferences: ResearchSourceReference[];
  };
  targets: GuidanceEventImpactTarget[];
  createdAt: number;
};

export type GuidanceEventImpactReviewWrite = {
  impactReviewId: string;
  securityCode: string;
  sourceKind: GuidanceEventImpactSourceKind;
  sourceId: string;
  reviewer: string;
  rationale: string;
  thesisIds: string[];
  riskIds: string[];
  /** Exact frozen versions selected for review; absence means none, never all. */
  modelTargets?: Array<{ targetKind: "scenario" | "dcf" | "reverse_dcf"; targetId: string }>;
  createdAt: number;
};

export function assertGuidanceEventImpactReviewWrite(input: GuidanceEventImpactReviewWrite): void {
  required(input.impactReviewId, "impact review id");
  required(input.securityCode, "impact review security code");
  required(input.sourceId, "impact review source id");
  required(input.reviewer, "impact review reviewer");
  required(input.rationale, "impact review rationale");
  if (!( ["management_guidance", "catalyst_actual", "formal_actual"] as const).includes(input.sourceKind)) throw new Error("unsupported impact review source kind");
  if (!Number.isInteger(input.createdAt) || input.createdAt <= 0) throw new Error("impact review createdAt must be a positive integer");
  const targetKeys = [
    ...normalizedIds(input.thesisIds, "thesis").map((id) => `thesis:${id}`),
    ...normalizedIds(input.riskIds, "risk").map((id) => `risk:${id}`),
    ...normalizedModelTargets(input.modelTargets).map((item) => `${item.targetKind}:${item.targetId}`),
  ];
  if (!targetKeys.length) throw new Error("impact review requires at least one thesis, risk, scenario, or valuation target");
  if (new Set(targetKeys).size !== targetKeys.length) throw new Error("impact review targets must be unique");
}

export function impactTargets(input: Pick<GuidanceEventImpactReviewWrite, "thesisIds" | "riskIds" | "modelTargets">): GuidanceEventImpactTarget[] {
  return [
    ...normalizedIds(input.thesisIds, "thesis").map((targetId) => ({ impactReviewTargetId: "", targetKind: "thesis" as const, targetId, reviewState: "requires_review" as const, action: null })),
    ...normalizedIds(input.riskIds, "risk").map((targetId) => ({ impactReviewTargetId: "", targetKind: "risk" as const, targetId, reviewState: "requires_review" as const, action: null })),
    ...normalizedModelTargets(input.modelTargets).map(({ targetKind, targetId }) => ({ impactReviewTargetId: "", targetKind, targetId, reviewState: "requires_review" as const, action: null })),
  ];
}

export function assertGuidanceEventImpactReviewTargetActionWrite(input: GuidanceEventImpactReviewTargetActionWrite): void {
  required(input.actionId, "impact review action id");
  required(input.rationale, "impact review action rationale");
  required(input.actedBy, "impact review action actor");
  if (!( ["no_change", "follow_up_recorded", "not_applicable"] as const).includes(input.decision)) throw new Error("unsupported impact review disposition");
  if (!Number.isInteger(input.actedAt) || input.actedAt <= 0) throw new Error("impact review action actedAt must be a positive integer");
  const followUpTargetId = String(input.followUpTargetId ?? "").trim();
  if (input.decision === "follow_up_recorded" && !followUpTargetId) throw new Error("follow_up_recorded disposition requires a follow-up target id");
  if (input.decision !== "follow_up_recorded" && followUpTargetId) throw new Error("only follow_up_recorded disposition may reference a follow-up target");
}

function normalizedIds(value: string[], kind: GuidanceEventImpactTargetKind): string[] {
  if (!Array.isArray(value)) throw new Error(`${kind} ids must be an array`);
  return value.map((item) => required(item, `${kind} id`));
}
function normalizedModelTargets(value: GuidanceEventImpactReviewWrite["modelTargets"]): Array<{ targetKind: "scenario" | "dcf" | "reverse_dcf"; targetId: string }> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("model targets must be an array");
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new Error("model target is invalid");
    const targetKind = String(item.targetKind ?? "").trim();
    if (!( ["scenario", "dcf", "reverse_dcf"] as const).includes(targetKind as "scenario" | "dcf" | "reverse_dcf")) throw new Error("unsupported model target kind");
    return { targetKind: targetKind as "scenario" | "dcf" | "reverse_dcf", targetId: required(item.targetId, "model target id") };
  });
}
function required(value: string, label: string) { const text = String(value ?? "").trim(); if (!text) throw new Error(`${label} is required`); return text; }
