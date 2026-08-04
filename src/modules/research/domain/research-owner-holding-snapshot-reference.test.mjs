import assert from "node:assert/strict";
import test from "node:test";

import {
  createOwnerHoldingPublicSnapshotReference,
  loadOwnerHoldingPublicSnapshotReferences,
} from "../application/research-owner-holding-snapshot-reference.ts";
import { researchRoutes } from "../api/research.routes.ts";

function referenceDb({ holding = true, snapshot = true } = {}) {
  const references = [];
  const publicSnapshot = {
    analysisSnapshotId: "public:00700:1", asOf: 100, completionLevel: "basic", state: "资料待补", createdAt: 90,
  };
  return {
    references,
    prepare(sql) {
      return { bind(...values) {
        if (sql.includes("from situation_holding_profiles") && sql.includes("select updated_at")) {
          return { first: async () => holding && values[0] === "alice" && values[1] === "00700.HK" ? { updatedAt: 80 } : null };
        }
        if (sql.includes("from research_analysis_snapshots") && sql.includes("analysis_snapshot_id=?")) {
          return { first: async () => snapshot && values[0] === publicSnapshot.analysisSnapshotId && values[1] === "00700.HK" ? publicSnapshot : null };
        }
        if (sql.includes("from research_owner_holding_snapshot_references") && sql.includes("public_snapshot_id=?")) {
          return { first: async () => references.find((reference) => reference.ownerKey === values[0] && reference.holdingSecurityCode === values[1] && reference.publicSnapshotId === values[2]) ?? null };
        }
        if (sql.includes("insert into research_owner_holding_snapshot_references")) {
          return { run: async () => { references.push({ referenceId: values[0], ownerKey: values[1], holdingSecurityCode: values[2], publicSnapshotId: values[3], referenceCreatedAt: values[4] }); } };
        }
        if (sql.includes("from research_owner_holding_snapshot_references r")) {
          return { all: async () => ({ results: references.map((reference) => ({ ...reference, ...publicSnapshot })) }) };
        }
        throw new Error(`unexpected statement: ${sql}`);
      } };
    },
  };
}

test("an owner holding reference is append-only, same-security, and redacts the owner plus holding payload", async () => {
  const db = referenceDb();
  const saved = await createOwnerHoldingPublicSnapshotReference(db, {
    referenceId: "owner-ref:1", ownerKey: "alice", holdingSecurityCode: "00700.HK", publicSnapshotId: "public:00700:1", createdAt: 110,
  });
  assert.deepEqual(saved, {
    referenceId: "owner-ref:1", holdingSecurityCode: "00700.HK",
    publicSnapshot: { analysisSnapshotId: "public:00700:1", asOf: 100, completionLevel: "basic", state: "资料待补", createdAt: 90 },
    createdAt: 110,
  });
  const view = await loadOwnerHoldingPublicSnapshotReferences(db, { ownerKey: "alice", holdingSecurityCode: "00700.HK" });
  assert.equal(view.holdingConfigured, true);
  assert.equal(view.items.length, 1);
  assert.equal(JSON.stringify(view).includes("alice"), false);
  assert.equal(JSON.stringify(view).includes("profile"), false);
  await assert.rejects(
    () => createOwnerHoldingPublicSnapshotReference(db, {
      referenceId: "owner-ref:duplicate", ownerKey: "alice", holdingSecurityCode: "00700.HK", publicSnapshotId: "public:00700:1", createdAt: 111,
    }),
    /already references/,
  );
});

test("a reference cannot manufacture a holding or bind a legacy/cross-security snapshot", async () => {
  await assert.rejects(
    () => createOwnerHoldingPublicSnapshotReference(referenceDb({ holding: false }), {
      referenceId: "owner-ref:no-holding", ownerKey: "alice", holdingSecurityCode: "00700.HK", publicSnapshotId: "public:00700:1", createdAt: 110,
    }),
    /holding profile is required/,
  );
  const db = referenceDb({ snapshot: false });
  await assert.rejects(
    () => createOwnerHoldingPublicSnapshotReference(db, {
      referenceId: "owner-ref:wrong-snapshot", ownerKey: "alice", holdingSecurityCode: "00700.HK", publicSnapshotId: "legacy-or-other-security", createdAt: 110,
    }),
    /frozen public research snapshot for the same listed security/,
  );
  assert.deepEqual(db.references, []);
});

test("owner holding snapshot reference API is absent from production", async () => {
  const path = "http://example.test/research/company/00700.HK/owner-holding-snapshot-references?owner=alice";
  const read = await researchRoutes.request(path, {}, { LLM_RUNTIME: "production" });
  assert.equal(read.status, 404);
  const write = await researchRoutes.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ publicSnapshotId: "public:00700:1", ownerKey: "alice" }) }, { LLM_RUNTIME: "production" });
  assert.equal(write.status, 404);
});
