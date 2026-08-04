import bindingConfig from "../../../../config/research-operating-source-fact-bindings.v1.json";
import { assertAsOf } from "./research-dossier";
import type { ResearchOperatingSourceFactKind } from "./research-operating-source-facts";

export type ResearchOperatingSourceFactBindingTargetKind = "segment_variable" | "contract_parameter" | "growth_constraint";
export type ResearchOperatingSourceFactBindingReviewStatus = "reviewed" | "needs_revision" | "rejected";
export type ResearchOperatingSourceFactBindingStatus = "pending" | ResearchOperatingSourceFactBindingReviewStatus;

export type ResearchOperatingSourceFactBinding = {
  operatingSourceFactBindingId: string;
  operatingCompanyId: string;
  operatingSourceFactId: string;
  operatingModelId: string;
  targetKind: ResearchOperatingSourceFactBindingTargetKind;
  targetId: string;
  targetField: string;
  factKind: ResearchOperatingSourceFactKind;
  formula: string;
  applicablePeriod: string;
  applicabilityDescription: string;
  uncoveredScope: string;
  reviewStatus: ResearchOperatingSourceFactBindingStatus;
  reviewNote: string | null;
  reviewedBy: string | null;
  reviewedAt: number | null;
  createdBy: string;
  createdAt: number;
};

export type ResearchOperatingSourceFactBindingReview = {
  operatingSourceFactBindingReviewId: string;
  operatingSourceFactBindingId: string;
  reviewStatus: ResearchOperatingSourceFactBindingReviewStatus;
  reviewNote: string;
  reviewedBy: string;
  reviewedAt: number;
};

type TargetField = { field: string; factKinds: ResearchOperatingSourceFactKind[] };
type Target = { targetKind: ResearchOperatingSourceFactBindingTargetKind; targetFields: TargetField[] };
const config = bindingConfig as { version: string; targets: Target[] };

export function researchOperatingSourceFactBindingConfigVersion(): string { return config.version; }
export function researchOperatingSourceFactBindingTargets(): Target[] { return config.targets; }
export function assertResearchOperatingSourceFactBinding(input: Omit<ResearchOperatingSourceFactBinding, "reviewStatus" | "reviewNote" | "reviewedBy" | "reviewedAt">): void {
  for (const [label, value] of Object.entries({ operatingSourceFactBindingId: input.operatingSourceFactBindingId, operatingCompanyId: input.operatingCompanyId, operatingSourceFactId: input.operatingSourceFactId, operatingModelId: input.operatingModelId, targetId: input.targetId, targetField: input.targetField, formula: input.formula, applicablePeriod: input.applicablePeriod, applicabilityDescription: input.applicabilityDescription, uncoveredScope: input.uncoveredScope, createdBy: input.createdBy })) required(value, label);
  assertAsOf(input.createdAt);
  const field = configuredField(input.targetKind, input.targetField);
  if (!field) throw new Error("operating source fact binding target field is not configured");
  if (!field.factKinds.includes(input.factKind)) throw new Error("operating source fact kind is incompatible with selected model field");
}
export function assertResearchOperatingSourceFactBindingReview(input: ResearchOperatingSourceFactBindingReview): void {
  for (const [label, value] of Object.entries({ operatingSourceFactBindingReviewId: input.operatingSourceFactBindingReviewId, operatingSourceFactBindingId: input.operatingSourceFactBindingId, reviewNote: input.reviewNote, reviewedBy: input.reviewedBy })) required(value, label);
  if (!(["reviewed", "needs_revision", "rejected"] as const).includes(input.reviewStatus)) throw new Error("operating source fact binding review status is invalid");
  assertAsOf(input.reviewedAt);
}
export function isReviewedOperatingModelInput(input: ResearchOperatingSourceFactBinding): boolean { return input.reviewStatus === "reviewed"; }
function configuredField(kind: ResearchOperatingSourceFactBindingTargetKind, field: string): TargetField | null { return config.targets.find((item) => item.targetKind === kind)?.targetFields.find((item) => item.field === field) ?? null; }
function required(value: unknown, label: string) { if (!String(value ?? "").trim()) throw new Error(`${label} is required`); }
