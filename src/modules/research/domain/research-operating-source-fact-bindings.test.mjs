import assert from "node:assert/strict";
import test from "node:test";
import {
  assertResearchOperatingSourceFactBinding,
  assertResearchOperatingSourceFactBindingReview,
  isReviewedOperatingModelInput,
  researchOperatingSourceFactBindingConfigVersion,
} from "./research-operating-source-fact-bindings.ts";
import { recordResearchOperatingSourceFactBinding } from "../application/research-operating-source-fact-bindings.ts";

function binding(patch = {}) {
  return {
    operatingSourceFactBindingId: "source-binding:1", operatingCompanyId: "company:1", operatingSourceFactId: "source-fact:1", operatingModelId: "model:1",
    targetKind: "segment_variable", targetId: "segment:1", targetField: "volume", factKind: "segment_volume",
    formula: "2026 volume input = disclosed 2026Q1 shipment volume; no annualisation.", applicablePeriod: "2026Q1", applicabilityDescription: "Only the named optical-module segment.", uncoveredScope: "Does not cover subsequent quarters, price, margin, cash conversion, or valuation.", createdBy: "reviewer", createdAt: 100,
    ...patch,
  };
}

test("source fact bindings only permit configured non-financial operating targets", () => {
  assert.equal(researchOperatingSourceFactBindingConfigVersion(), "research-operating-source-fact-bindings.v1");
  assert.doesNotThrow(() => assertResearchOperatingSourceFactBinding(binding()));
  assert.throws(() => assertResearchOperatingSourceFactBinding(binding({ targetField: "revenue" })), /not configured/);
  assert.throws(() => assertResearchOperatingSourceFactBinding(binding({ factKind: "contract_commitment" })), /incompatible/);
  assert.throws(() => assertResearchOperatingSourceFactBinding(binding({ uncoveredScope: "" })), /uncoveredScope/);
});

test("only a reviewed latest binding can be released as a modelling input", () => {
  const item = { ...binding(), reviewStatus: "reviewed", reviewNote: "source period and formula checked", reviewedBy: "reviewer", reviewedAt: 101 };
  assert.equal(isReviewedOperatingModelInput(item), true);
  assert.equal(isReviewedOperatingModelInput({ ...item, reviewStatus: "needs_revision" }), false);
  assert.doesNotThrow(() => assertResearchOperatingSourceFactBindingReview({ operatingSourceFactBindingReviewId: "binding-review:1", operatingSourceFactBindingId: "source-binding:1", reviewStatus: "reviewed", reviewNote: "formula is bounded", reviewedBy: "reviewer", reviewedAt: 101 }));
  assert.throws(() => assertResearchOperatingSourceFactBindingReview({ operatingSourceFactBindingReviewId: "binding-review:1", operatingSourceFactBindingId: "source-binding:1", reviewStatus: "pending", reviewNote: "x", reviewedBy: "reviewer", reviewedAt: 101 }), /status is invalid/);
});

test("binding persistence checks the exact source/model ownership and never updates a model", async () => {
  const inserts = [];
  const db = { prepare(sql) { return { bind(...values) {
    if (sql.includes("from research_operating_source_facts")) return { first: async () => ({ operating_company_id: "company:1", fact_kind: "segment_volume" }) };
    if (sql.includes("from research_operating_models_typed")) return { first: async () => ({ company_id: "company:1" }) };
    if (sql.includes("select model.company_id")) return { first: async () => ({ company_id: "company:1" }) };
    if (sql.includes("select 1 as found")) return { first: async () => ({ found: 1 }) };
    if (sql.includes("insert into research_operating_source_fact_bindings")) return { run: async () => { inserts.push({ sql, values }); } };
    throw new Error(`unexpected query: ${sql}`);
  } }; } };
  const result = await recordResearchOperatingSourceFactBinding(db, binding());
  assert.deepEqual(result, { state: "saved", operatingSourceFactBindingId: "source-binding:1", reason: null });
  assert.equal(inserts.length, 1);
  assert.match(inserts[0].sql, /research_operating_source_fact_bindings/);
  assert.doesNotMatch(inserts[0].sql, /update|research_operating_driver_plans|valuation/i);
});
