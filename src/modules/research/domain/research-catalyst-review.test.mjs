import assert from "node:assert/strict";
import test from "node:test";
import { assertResearchCatalystReview } from "./research-catalyst-review";

const base = {
  catalystReviewId: "review:1", catalystId: "catalyst:1", companyId: "company:1", securityCode: "300308.SZ",
  asOf: 100, reviewStatus: "confirmed", outcomeSummary: "正式披露的收入达到该事件条件。",
  expectedVsActual: "结果与原预期一致。", impactedAssumptionStatus: "confirmed", nextAction: "在下一快照复核后续现金流传导。",
  sourceReferences: [{ sourceKind: "filing", url: "https://www.cninfo.com.cn/", title: "正式公告" }], reviewedAt: 101, createdAt: 102,
};

test("catalyst review preserves an evidence-bound observed outcome", () => {
  assert.doesNotThrow(() => assertResearchCatalystReview(base));
});

test("catalyst review rejects an unclassified or source-free outcome", () => {
  assert.throws(() => assertResearchCatalystReview({ ...base, sourceReferences: [] }), /requires observed outcome/);
  assert.throws(() => assertResearchCatalystReview({ ...base, sourceReferences: [{ ...base.sourceReferences[0], sourceKind: "" }] }), /require a source kind/);
});
