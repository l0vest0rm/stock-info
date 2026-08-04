import assert from "node:assert/strict";
import test from "node:test";
import {
  assertGovernanceCapitalFactVersion,
  governanceCapitalFactDefinitions,
  governanceCapitalSourceLocator,
  latestGovernanceCapitalFacts,
} from "./research-governance-capital-facts.ts";

const base = { governanceCapitalFactVersionId: "fact:1", factKey: "share_repurchase", factStatus: "verified", valueKind: "number", valueNumber: 100, valueRangeLower: null, valueRangeUpper: null, valueText: null, unit: "CNY million", asOf: "2026-08-04", sourceAuthority: "issuer_disclosure" };

test("governance/capital definitions cover the required public-fact dimensions without a score", () => {
  const keys = governanceCapitalFactDefinitions().map((item) => item.factKey);
  for (const key of ["control_rights", "audit_internal_control", "regulatory_penalty_or_litigation", "related_party_transaction", "executive_incentive", "r_and_d_spend", "capital_expenditure", "acquisition_or_disposal", "share_repurchase", "cash_dividend", "financing_or_dilution", "capital_allocation_outcome"]) assert.ok(keys.includes(key));
  assert.ok(!keys.includes("governance_score"));
});

test("verified facts need configured values while conflicts remain visible rather than synthesized", () => {
  assert.doesNotThrow(() => assertGovernanceCapitalFactVersion(base));
  assert.throws(() => assertGovernanceCapitalFactVersion({ ...base, valueNumber: null }), /valueNumber/);
  assert.doesNotThrow(() => assertGovernanceCapitalFactVersion({ ...base, valueNumber: null, valueRangeLower: 4000, valueRangeUpper: 8000 }));
  assert.throws(() => assertGovernanceCapitalFactVersion({ ...base, valueNumber: null, valueRangeLower: 8000, valueRangeUpper: 4000 }), /lower bound/);
  assert.throws(() => assertGovernanceCapitalFactVersion({ ...base, valueRangeLower: 4000, valueRangeUpper: 8000 }), /one scalar or one complete range/);
  assert.doesNotThrow(() => assertGovernanceCapitalFactVersion({ ...base, factStatus: "conflicting", valueNumber: null, unit: null }));
  assert.throws(() => assertGovernanceCapitalFactVersion({ ...base, factKey: "not_a_fact" }), /not configured/);
});

test("latest fact selection is explicit and source locator preserves immutable information chain", () => {
  const current = latestGovernanceCapitalFacts([{ ...base, asOf: "2026-01-01", createdAt: 1 }, { ...base, governanceCapitalFactVersionId: "fact:2", asOf: "2026-08-01", createdAt: 2 }]);
  assert.equal(current.length, 1); assert.equal(current[0].governanceCapitalFactVersionId, "fact:2");
  assert.match(governanceCapitalSourceLocator({ informationId: "i", resultId: "r", runId: "run", versionId: "v", docId: "doc", contentHash: "sha256:x" }), /content_hash=sha256:x/);
});
