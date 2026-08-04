import assert from "node:assert/strict";
import test from "node:test";
import { buildResearchRiskProfile } from "./research-risk-profile.ts";

test("risk profile puts conflicting evidence ahead of price and valuation", () => {
  const result = buildResearchRiskProfile({ peTtm: 80, pb: 8, pePercentile: 95, pbPercentile: 91, drawdown90d: -8,
    evidence: [{ evidenceId: "e1", title: "反证", url: "https://example.test/e1", publishedAt: 1, grade: "conflicting", eventStatus: "conflicting" }],
    impacts: [], sources: [], documentCount: 1 });
  assert.equal(result.state, "优先复核");
  assert.equal(result.findings[0].id, "conflicting-evidence");
  assert.equal(result.findings[0].severity, "critical");
});

test("risk profile preserves unavailable inputs as gaps instead of inventing a risk score", () => {
  const result = buildResearchRiskProfile({ peTtm: null, pb: null, pePercentile: null, pbPercentile: null, drawdown90d: null,
    evidence: [], impacts: [], sources: [], documentCount: 0 });
  assert.equal(result.state, "资料待补");
  assert.ok(result.gaps.some((item) => item.id === "portfolio-exposure"));
  assert.ok(result.findings.some((item) => item.id === "missing-company-evidence"));
});
