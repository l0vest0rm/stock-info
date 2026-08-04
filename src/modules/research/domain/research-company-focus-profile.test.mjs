import assert from "node:assert/strict";
import test from "node:test";
import { assertFocusProfileInput, assertResearchFocusRoleTarget, researchCompanyFocusProfileConfigVersion } from "./research-company-focus-profile.ts";

test("company focus profile permits only configured typed ledger references", () => {
  assert.equal(researchCompanyFocusProfileConfigVersion(), "research-company-focus-profile.v1");
  assert.doesNotThrow(() => assertFocusProfileInput({ companyId: "company:shared", asOf: 100, status: "draft", title: "跨市场经营重点", items: [{ role: "key_driver", targetKind: "operating_source_fact", targetId: "fact:1" }] }));
  assert.throws(() => assertResearchFocusRoleTarget("thesis", "research_risk"), /not allowed/);
  assert.throws(() => assertResearchFocusRoleTarget("unknown", "research_thesis"), /not configured/);
  assert.throws(() => assertFocusProfileInput({ companyId: "company:shared", asOf: 100, status: "draft", title: "x", items: [{ role: "key_driver", targetKind: "url", targetId: "https://example.com" }] }), /not allowed/);
});

test("focus profile rejects mutable status and duplicate targets", () => {
  const item = { role: "thesis", targetKind: "research_thesis", targetId: "thesis:1" };
  assert.throws(() => assertFocusProfileInput({ companyId: "company:shared", asOf: 100, status: "superseded", title: "x", items: [item] }), /new focus profile status/);
  assert.throws(() => assertFocusProfileInput({ companyId: "company:shared", asOf: 100, status: "reviewed", title: "x", items: [item, item] }), /duplicate/);
});
