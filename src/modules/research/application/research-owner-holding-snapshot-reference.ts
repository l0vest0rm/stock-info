import { normalizeSecurityCode } from "../../../shared/codes";
import { PUBLIC_RESEARCH_SNAPSHOT_KIND } from "../domain/research-public-snapshot";
import {
  assertCreateOwnerHoldingPublicSnapshotReferenceInput,
  type CreateOwnerHoldingPublicSnapshotReferenceInput,
  type OwnerHoldingPublicSnapshotReference,
} from "../domain/research-owner-holding-snapshot-reference";

type Row = Record<string, unknown>;

export type OwnerHoldingPublicSnapshotReferenceView = {
  availability: "available" | "unavailable";
  reason: "holding_profile_not_found" | "storage_not_initialized" | null;
  holdingConfigured: boolean;
  holdingUpdatedAt: number | null;
  items: OwnerHoldingPublicSnapshotReference[];
};

/**
 * Creates only a private pointer.  No holding JSON and no personal field is
 * copied into a public snapshot, and a snapshot never receives this reference.
 */
export async function createOwnerHoldingPublicSnapshotReference(
  db: D1Database,
  input: CreateOwnerHoldingPublicSnapshotReferenceInput,
): Promise<OwnerHoldingPublicSnapshotReference> {
  assertCreateOwnerHoldingPublicSnapshotReferenceInput(input);
  const holdingSecurityCode = normalizeSecurityCode(input.holdingSecurityCode);
  const holding = await db.prepare(`select updated_at as updatedAt from situation_holding_profiles where owner_key=? and code=?`)
    .bind(input.ownerKey, holdingSecurityCode).first<Row>();
  if (!holding) throw new Error("owner holding profile is required before adding a public research snapshot reference");
  const snapshot = await db.prepare(`select analysis_snapshot_id as analysisSnapshotId, as_of as asOf, completion_level as completionLevel, state, created_at as createdAt
    from research_analysis_snapshots where analysis_snapshot_id=? and security_code=? and json_extract(summary_json, '$.kind')=?`)
    .bind(input.publicSnapshotId, holdingSecurityCode, PUBLIC_RESEARCH_SNAPSHOT_KIND).first<Row>();
  if (!snapshot) throw new Error("reference requires a frozen public research snapshot for the same listed security");
  const existing = await db.prepare(`select reference_id as referenceId from research_owner_holding_snapshot_references
    where owner_key=? and holding_security_code=? and public_snapshot_id=?`)
    .bind(input.ownerKey, holdingSecurityCode, input.publicSnapshotId).first<Row>();
  if (existing) throw new Error("this holding already references the selected public research snapshot");
  await db.prepare(`insert into research_owner_holding_snapshot_references (
    reference_id, owner_key, holding_security_code, public_snapshot_id, created_at
  ) values (?, ?, ?, ?, ?)`)
    .bind(input.referenceId, input.ownerKey, holdingSecurityCode, input.publicSnapshotId, input.createdAt).run();
  return mapReference({
    referenceId: input.referenceId,
    holdingSecurityCode,
    publicSnapshotId: input.publicSnapshotId,
    referenceCreatedAt: input.createdAt,
    ...snapshot,
  });
}

/** Owner scope is a read boundary.  The caller receives no owner key or holding payload. */
export async function loadOwnerHoldingPublicSnapshotReferences(
  db: D1Database,
  input: { ownerKey: string; holdingSecurityCode: string },
): Promise<OwnerHoldingPublicSnapshotReferenceView> {
  const holdingSecurityCode = normalizeSecurityCode(input.holdingSecurityCode);
  try {
    const holding = await db.prepare(`select updated_at as updatedAt from situation_holding_profiles where owner_key=? and code=?`)
      .bind(input.ownerKey, holdingSecurityCode).first<Row>();
    if (!holding) return { availability: "available", reason: "holding_profile_not_found", holdingConfigured: false, holdingUpdatedAt: null, items: [] };
    const rows = await db.prepare(`select r.reference_id as referenceId, r.holding_security_code as holdingSecurityCode,
      r.public_snapshot_id as publicSnapshotId, r.created_at as referenceCreatedAt,
      s.analysis_snapshot_id as analysisSnapshotId, s.as_of as asOf, s.completion_level as completionLevel, s.state, s.created_at as createdAt
      from research_owner_holding_snapshot_references r
      join research_analysis_snapshots s on s.analysis_snapshot_id=r.public_snapshot_id
      where r.owner_key=? and r.holding_security_code=? and s.security_code=?
        and json_extract(s.summary_json, '$.kind')=?
      order by r.created_at desc, r.reference_id desc`)
      .bind(input.ownerKey, holdingSecurityCode, holdingSecurityCode, PUBLIC_RESEARCH_SNAPSHOT_KIND).all<Row>();
    return {
      availability: "available",
      reason: null,
      holdingConfigured: true,
      holdingUpdatedAt: requiredNumber(holding.updatedAt, "holding updatedAt"),
      items: (rows.results ?? []).map(mapReference),
    };
  } catch (error) {
    if (isMissingTableError(error)) return { availability: "unavailable", reason: "storage_not_initialized", holdingConfigured: false, holdingUpdatedAt: null, items: [] };
    throw error;
  }
}

function mapReference(row: Row): OwnerHoldingPublicSnapshotReference {
  return {
    referenceId: requiredText(row.referenceId, "referenceId"),
    holdingSecurityCode: normalizeSecurityCode(requiredText(row.holdingSecurityCode, "holdingSecurityCode")),
    publicSnapshot: {
      analysisSnapshotId: requiredText(row.analysisSnapshotId ?? row.publicSnapshotId, "analysisSnapshotId"),
      asOf: requiredNumber(row.asOf, "asOf"),
      completionLevel: requiredText(row.completionLevel, "completionLevel") as OwnerHoldingPublicSnapshotReference["publicSnapshot"]["completionLevel"],
      state: requiredText(row.state, "state"),
      createdAt: requiredNumber(row.createdAt, "snapshot createdAt"),
    },
    createdAt: requiredNumber(row.referenceCreatedAt, "referenceCreatedAt"),
  };
}
function requiredText(value: unknown, label: string): string { const result = String(value ?? "").trim(); if (!result) throw new Error(`${label} is required`); return result; }
function requiredNumber(value: unknown, label: string): number { const result = Number(value); if (!Number.isFinite(result)) throw new Error(`${label} must be finite`); return result; }
function isMissingTableError(error: unknown): boolean { return /(?:no such table|does not exist|not found).*?(?:research_owner_holding_snapshot_references|situation_holding_profiles|research_analysis_snapshots)/i.test(error instanceof Error ? error.message : String(error)); }
