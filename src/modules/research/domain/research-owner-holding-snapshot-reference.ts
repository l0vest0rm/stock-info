import { isSupportedCompanyCode, normalizeSecurityCode } from "../../../shared/codes";
import { validOwnerKey } from "../../situation/domain/model";

export type OwnerHoldingPublicSnapshotReference = {
  referenceId: string;
  holdingSecurityCode: string;
  publicSnapshot: {
    analysisSnapshotId: string;
    asOf: number;
    completionLevel: "basic" | "standard" | "deep";
    state: string;
    createdAt: number;
  };
  createdAt: number;
};

export type CreateOwnerHoldingPublicSnapshotReferenceInput = {
  referenceId: string;
  ownerKey: string;
  holdingSecurityCode: string;
  publicSnapshotId: string;
  createdAt: number;
};

export function assertCreateOwnerHoldingPublicSnapshotReferenceInput(input: CreateOwnerHoldingPublicSnapshotReferenceInput): void {
  if (!validOwnerKey(input.ownerKey)) throw new Error("ownerKey is invalid");
  if (!isSupportedCompanyCode(normalizeSecurityCode(input.holdingSecurityCode))) throw new Error("holdingSecurityCode is unsupported");
  if (!validId(input.referenceId, "referenceId") || !validId(input.publicSnapshotId, "publicSnapshotId")) throw new Error("referenceId and publicSnapshotId are required");
  if (!Number.isInteger(input.createdAt) || input.createdAt <= 0) throw new Error("createdAt must be a positive integer");
}

function validId(value: string, label: string): boolean {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) return false;
  if (/\s/.test(normalized)) throw new Error(`${label} cannot contain whitespace`);
  return true;
}
