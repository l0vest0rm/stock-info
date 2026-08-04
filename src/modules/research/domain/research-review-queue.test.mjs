import test from "node:test";
import assert from "node:assert/strict";
import { buildResearchReviewQueue } from "./research-review-queue";

const candidate = (overrides = {}) => ({ candidateId: "candidate:revenue", metric: "revenue", fiscalPeriod: "2026Q1", eligibility: "ready_for_review", blockingReason: null, statutoryPublishedAt: "2026-04-20", statutoryProvider: "cninfo", statutoryDisclosureUrl: "https://example.test/filing", statutoryLocator: "income/revenue", ...overrides });

test("unified review queue retains source-ledger boundaries and never invents targets", () => {
  const queue = buildResearchReviewQueue({
    formalActualCandidates: [candidate(), candidate({ candidateId: "candidate:blocked", eligibility: "blocked", blockingReason: "statutory_conflict" })],
    formalActualCandidateReviews: [{ candidateId: "candidate:revenue", decision: "needs_evidence" }],
    modelReviewItems: [{ reviewItemId: "model-review:1", state: "open", createdAt: 10, targetKind: "dcf", targetVersionId: "dcf:1", triggerKind: "formal_actual_accepted", triggerId: "actual:1", reason: "review" }],
    managementGuidance: [{ forecastId: "guidance:1", forecastDate: "2026-04-01", fiscalPeriod: "2026FY", metric: "revenue" }],
    catalystReviews: [{ catalystReviewId: "event:1", asOf: 20, reviewStatus: "missed", sourceReferences: [{ url: "https://example.test/event", title: "event" }] }],
    impactReviews: [],
  });
  assert.equal(queue.ruleVersion, "research-review-queue.v2");
  assert.equal(queue.openCount, 4);
  assert.equal(queue.items.some((item) => item.queueItemId === "formal-actual:candidate:blocked"), false);
  assert.equal(queue.items.every((item) => item.target === null || item.kind === "model_version"), true);
});

test("final formal decisions and explicit impact mappings remove only their matching queue entries", () => {
  const queue = buildResearchReviewQueue({
    formalActualCandidates: [candidate()],
    formalActualCandidateReviews: [{ candidateId: "candidate:revenue", decision: "accepted" }],
    modelReviewItems: [],
    managementGuidance: [{ forecastId: "guidance:1", forecastDate: "2026-04-01", fiscalPeriod: "2026FY", metric: "revenue" }],
    catalystReviews: [{ catalystReviewId: "event:1", asOf: 20, reviewStatus: "confirmed", sourceReferences: [{ url: "https://example.test/event", title: "event" }] }],
    impactReviews: [{ impactReviewId: "impact:guidance:1", sourceKind: "management_guidance", sourceId: "guidance:1", targets: [{ targetKind: "thesis", targetId: "thesis:1", reviewState: "no_change" }] }],
  });
  assert.deepEqual(queue.items.map((item) => item.queueItemId), ["event-actual:event:1"]);
});

test("an accepted filing actual remains an explicit mapping task until a matching source-target review is appended", () => {
  const actual = { actualId: "actual:1", metric: "revenue", fiscalPeriod: "2026Q1", filedAt: "2026-04-20", actualStatus: "original", sourceReferences: [{ sourceKind: "filing", url: "https://example.test/actual", title: "法定披露" }] };
  const unmapped = buildResearchReviewQueue({ formalActualCandidates: [], formalActualCandidateReviews: [], modelReviewItems: [], managementGuidance: [], formalActuals: [actual], catalystReviews: [], impactReviews: [] });
  assert.equal(unmapped.items.find((item) => item.queueItemId === "formal-actual-impact:actual:1")?.kind, "formal_actual_impact_mapping");
  const mapped = buildResearchReviewQueue({ formalActualCandidates: [], formalActualCandidateReviews: [], modelReviewItems: [], managementGuidance: [], formalActuals: [actual], catalystReviews: [], impactReviews: [{ impactReviewId: "impact:actual:1", sourceKind: "formal_actual", sourceId: "actual:1", targets: [{ targetKind: "risk", targetId: "risk:1", reviewState: "not_applicable" }] }] });
  assert.equal(mapped.items.some((item) => item.queueItemId === "formal-actual-impact:actual:1"), false);
});

test("an explicit impact mapping stays in the unified queue until every thesis/risk target has a final disposition", () => {
  const source = { forecastId: "guidance:1", forecastDate: "2026-04-01", fiscalPeriod: "2026FY", metric: "revenue" };
  const pending = buildResearchReviewQueue({ formalActualCandidates: [], formalActualCandidateReviews: [], modelReviewItems: [], managementGuidance: [source], catalystReviews: [], impactReviews: [{ impactReviewId: "impact:1", sourceKind: "management_guidance", sourceId: "guidance:1", targets: [{ targetKind: "thesis", targetId: "thesis:1", reviewState: "requires_review" }, { targetKind: "risk", targetId: "risk:1", reviewState: "no_change" }] }] });
  const item = pending.items.find((entry) => entry.queueItemId === "guidance:guidance:1");
  assert.deepEqual(item?.impactedTargets, [{ kind: "thesis", id: "thesis:1" }]);
  assert.match(item?.reason || "", /没有最终人工处置/);
  const final = buildResearchReviewQueue({ formalActualCandidates: [], formalActualCandidateReviews: [], modelReviewItems: [], managementGuidance: [source], catalystReviews: [], impactReviews: [{ impactReviewId: "impact:1", sourceKind: "management_guidance", sourceId: "guidance:1", targets: [{ targetKind: "thesis", targetId: "thesis:1", reviewState: "follow_up_recorded" }, { targetKind: "risk", targetId: "risk:1", reviewState: "no_change" }] }] });
  assert.equal(final.items.some((entry) => entry.queueItemId === "guidance:guidance:1"), false);
});

test("source health and due public review records retain their source versions and every affected target without mutating them", () => {
  const NOW = Date.UTC(2026, 7, 4);
  const queue = buildResearchReviewQueue({
    now: NOW,
    sourceHealth: [
      { sourceId: "financial_statutory", label: "法定披露交叉核验", policy: "policy", status: "conflict", observedAt: NOW - 1, ageDays: 0, conflictCount: 2, detail: "存在 2 项已记录冲突。" },
      { sourceId: "financial_primary", label: "主结构化财报源", policy: "policy", status: "stale", observedAt: NOW - 200 * 86_400_000, ageDays: 200, conflictCount: 0, detail: "最近观察已超过时效策略。" },
      { sourceId: "healthy", label: "正常来源", policy: "policy", status: "available", observedAt: NOW, ageDays: 0, conflictCount: 0, detail: "policy" },
    ],
    requirements: [
      { requirementId: "statutory_financial_cross_check", label: "法定核验", primarySources: [{ sourceId: "financial_primary" }], crossSources: [{ sourceId: "financial_statutory" }] },
      { requirementId: "formal_financial_statements", label: "财报", primarySources: [{ sourceId: "financial_primary" }], crossSources: [] },
    ],
    theses: [{ thesisId: "thesis:1", title: "增长", reviewBy: NOW - 1, updatedAt: 80, evidence: [{ sourceUrl: "https://example.test/thesis", sourceTitle: "命题来源" }] }],
    risks: [{ riskId: "risk:1", title: "回款", status: "active", reviewFrequency: "quarterly", updatedAt: NOW - 93 * 86_400_000, sourceReferences: [{ sourceKind: "filing", url: "https://example.test/risk", title: "风险来源" }] }],
    focusProfile: { focusProfileId: "focus:2", title: "长期档案", version: 2, supersedesFocusProfileId: "focus:1", reviewBy: NOW - 1, asOf: 50, items: [{ targetKind: "research_thesis", targetId: "thesis:1" }, { targetKind: "research_risk", targetId: "risk:1" }] },
    formalActualCandidates: [], formalActualCandidateReviews: [], modelReviewItems: [], managementGuidance: [], catalystReviews: [], impactReviews: [],
  });
  const conflict = queue.items.find((item) => item.queueItemId.startsWith("source-health:financial_statutory"));
  assert.equal(conflict?.state, "blocked");
  assert.equal(conflict?.source.version, `health:conflict:${NOW - 1}`);
  assert.deepEqual(conflict?.impactedTargets, [{ kind: "data_requirement", id: "statutory_financial_cross_check" }]);
  const stale = queue.items.find((item) => item.queueItemId.startsWith("source-health:financial_primary"));
  assert.deepEqual(stale?.impactedTargets.map((item) => item.id), ["statutory_financial_cross_check", "formal_financial_statements"]);
  const focus = queue.items.find((item) => item.kind === "focus_profile_review_due");
  assert.equal(focus?.source.version, "v2");
  assert.equal(focus?.source.supersedesVersion, "focus:1");
  assert.deepEqual(focus?.impactedTargets, [{ kind: "focus_profile", id: "focus:2" }, { kind: "research_thesis", id: "thesis:1" }, { kind: "research_risk", id: "risk:1" }]);
  assert.equal(queue.items.some((item) => item.kind === "thesis_review_due"), true);
  assert.equal(queue.items.some((item) => item.kind === "risk_review_due"), true);
  assert.equal(queue.items.some((item) => item.source.id === "healthy"), false);
});
