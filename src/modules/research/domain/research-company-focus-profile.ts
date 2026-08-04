import focusConfig from "../../../../config/research-company-focus-profile.v1.json";

export type ResearchFocusMembershipStatus = "active" | "removed";
export type ResearchFocusProfileStatus = "draft" | "reviewed" | "superseded";
export type ResearchFocusRole = keyof typeof focusConfig.roles;
export type ResearchFocusTargetKind = (typeof focusConfig.roles)[ResearchFocusRole][number];

export type ResearchCompanyFocusMembership = { membershipId: string; ownerKey: string; companyId: string; status: ResearchFocusMembershipStatus; supersedesMembershipId: string | null; createdAt: number };
export type ResearchCompanyFocusProfileItem = { focusItemId: string; role: ResearchFocusRole; targetKind: ResearchFocusTargetKind; targetId: string; securityCode: string | null; sortOrder: number; createdAt: number; target: Record<string, unknown> | null; unavailableReason: string | null };
export type ResearchCompanyFocusProfile = { focusProfileId: string; companyId: string; version: number; supersedesFocusProfileId: string | null; asOf: number; status: ResearchFocusProfileStatus; title: string; reviewBy: number | null; epistemicType: "system_judgment"; createdAt: number; items: ResearchCompanyFocusProfileItem[] };

export function researchCompanyFocusProfileConfigVersion(): string { return required(focusConfig.version, "company focus profile config version"); }
export function assertResearchFocusRoleTarget(role: string, targetKind: string): asserts role is ResearchFocusRole {
  const kinds = (focusConfig.roles as Record<string, readonly string[]>)[role];
  if (!kinds) throw new Error("focus profile role is not configured");
  if (!kinds.includes(targetKind)) throw new Error(`focus target kind is not allowed for role ${role}`);
}
export function assertFocusProfileInput(input: { companyId: string; asOf: number; status: string; title: string; reviewBy?: number | null; items: Array<{ role: string; targetKind: string; targetId: string; securityCode?: string | null; sortOrder?: number }> }): void {
  required(input.companyId, "companyId"); required(input.title, "focus profile title");
  if (!Number.isFinite(input.asOf) || input.asOf <= 0) throw new Error("focus profile asOf must be a positive timestamp");
  if (!["draft", "reviewed"].includes(input.status)) throw new Error("new focus profile status must be draft or reviewed");
  if (input.reviewBy !== undefined && input.reviewBy !== null && (!Number.isFinite(input.reviewBy) || input.reviewBy <= 0)) throw new Error("focus profile reviewBy must be a positive timestamp");
  if (!input.items.length) throw new Error("focus profile requires at least one existing research reference");
  const seen = new Set<string>();
  for (const item of input.items) { required(item.targetId, "focus targetId"); assertResearchFocusRoleTarget(item.role, item.targetKind); const key = `${item.role}:${item.targetKind}:${item.targetId}`; if (seen.has(key)) throw new Error("focus profile has a duplicate target"); seen.add(key); }
}
function required(value: unknown, label: string): string { const result = String(value ?? "").trim(); if (!result) throw new Error(`${label} is required`); return result; }
