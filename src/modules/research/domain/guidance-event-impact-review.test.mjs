import assert from "node:assert/strict";
import test from "node:test";
import { assertGuidanceEventImpactReviewWrite, impactTargets } from "./guidance-event-impact-review";

const base = { impactReviewId: "impact:1", securityCode: "300308.SZ", sourceKind: "management_guidance", sourceId: "guidance:1", reviewer: "local-user", rationale: "该指引涉及命题中的收入驱动，应人工复核。", thesisIds: ["thesis:1"], riskIds: ["risk:1"], createdAt: 100 };

test("guidance/event impact mapping is explicit and only queues a review", () => {
  const withVersions = { ...base, modelTargets: [{ targetKind: "scenario", targetId: "scenario:1" }, { targetKind: "dcf", targetId: "dcf:1" }] };
  assert.doesNotThrow(() => assertGuidanceEventImpactReviewWrite(withVersions));
  assert.deepEqual(impactTargets(withVersions), [
    { impactReviewTargetId: "", targetKind: "thesis", targetId: "thesis:1", reviewState: "requires_review", action: null },
    { impactReviewTargetId: "", targetKind: "risk", targetId: "risk:1", reviewState: "requires_review", action: null },
    { impactReviewTargetId: "", targetKind: "scenario", targetId: "scenario:1", reviewState: "requires_review", action: null },
    { impactReviewTargetId: "", targetKind: "dcf", targetId: "dcf:1", reviewState: "requires_review", action: null },
  ]);
});

test("guidance/event impact mapping rejects an empty or duplicate target set", () => {
  assert.throws(() => assertGuidanceEventImpactReviewWrite({ ...base, thesisIds: [], riskIds: [] }), /at least one/);
  assert.throws(() => assertGuidanceEventImpactReviewWrite({ ...base, thesisIds: ["thesis:1", "thesis:1"] }), /unique/);
  assert.throws(() => assertGuidanceEventImpactReviewWrite({ ...base, sourceKind: "source_viewpoint" }), /unsupported/);
  assert.throws(() => assertGuidanceEventImpactReviewWrite({ ...base, thesisIds: [], riskIds: [], modelTargets: [{ targetKind: "target_price", targetId: "x" }] }), /unsupported model target/);
  assert.throws(() => assertGuidanceEventImpactReviewWrite({ ...base, modelTargets: [{ targetKind: "dcf", targetId: "dcf:1" }, { targetKind: "dcf", targetId: "dcf:1" }] }), /unique/);
});
