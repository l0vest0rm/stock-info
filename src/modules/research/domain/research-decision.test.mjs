import assert from "node:assert/strict";
import test from "node:test";
import { buildResearchDecision } from "./research-decision.ts";

const rows = Array.from({ length: 100 }, (_, index) => ({ close: 100 + index, peTtm: 10 + index / 10, pb: 1 + index / 100 }));

test("research decision never promotes incomplete evidence to an action", () => {
  const result = buildResearchDecision({ klineRows: rows, evidenceCount: 0, confirmedEvidenceCount: 0, conflictingEvidenceCount: 0, activeCandidateCount: 0, pressureImpactCount: 0, supportImpactCount: 0 });
  assert.equal(result.state, "资料待补");
  assert.equal(result.gates[0].state, "unavailable");
});

test("research decision prioritizes conflicting evidence over valuation", () => {
  const result = buildResearchDecision({ klineRows: rows, evidenceCount: 2, confirmedEvidenceCount: 1, conflictingEvidenceCount: 1, activeCandidateCount: 0, pressureImpactCount: 1, supportImpactCount: 0 });
  assert.equal(result.state, "证伪复核");
  assert.equal(result.gates[0].state, "blocked");
});
