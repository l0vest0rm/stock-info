import assert from "node:assert/strict";
import test from "node:test";
import { createGuidanceEventImpactReview, loadGuidanceEventImpactReviews, resolveGuidanceEventImpactReviewTarget } from "../application/guidance-event-impact-reviews";

test("source-bound guidance impact appends target reviews and model-review items without updating targets", async () => {
  const batches = []; const modelWrites = [];
  const db = {
    prepare(sql) { return { sql, bind(...values) {
      const statement = { sql, values,
        async first() {
          if (sql.includes("research_management_guidance_forecasts")) return { guidance_forecast_id: "guidance:1", company_id: "company:1", guidance_date: "2026-08-01", source_statement: "公司公告中的收入指引", source_refs_json: JSON.stringify([{ sourceKind: "filing", url: "https://example.test/guidance", title: "公司公告" }]) };
          if (sql.includes("from research_theses") || sql.includes("from research_risk_entries") || sql.includes("research_valuation_model_versions") || sql.includes("research_reverse_valuation_model_versions") || sql.includes("research_forecast_scenarios")) return { ok: 1 };
          throw new Error(`unexpected first: ${sql}`);
        },
        async run() { if (sql.includes("insert or ignore into research_model_review_items")) modelWrites.push(values); return { meta: { changes: 1 } }; },
      };
      return statement;
    } }; },
    async batch(statements) { batches.push(statements); return []; },
  };
  const saved = await createGuidanceEventImpactReview(db, {
    impactReviewId: "impact:1", securityCode: "300308.SZ", sourceKind: "management_guidance", sourceId: "guidance:1",
    reviewer: "local-user", rationale: "收入指引涉及既有增长命题与需求风险。", thesisIds: ["thesis:1"], riskIds: ["risk:1"], modelTargets: [{ targetKind: "dcf", targetId: "dcf:1" }, { targetKind: "reverse_dcf", targetId: "reverse:1" }, { targetKind: "scenario", targetId: "scenario:1" }], createdAt: 100,
  });
  assert.equal(saved.modelReviewItemsCreated, 3);
  assert.equal(batches[0].length, 6);
  assert.ok(batches[0].every((item) => /insert into research_guidance_event_impact_review/i.test(item.sql)));
  assert.equal(modelWrites.length, 3);
  assert.ok(modelWrites.every((values) => values.includes("management_guidance_reviewed")));
  assert.ok(modelWrites.every((values) => JSON.stringify(values).includes("impact:1")));
  assert.equal([...batches, ...modelWrites.map(() => ({ sql: "" }))].some((item) => /update research_(theses|risk_entries|valuation|forecast)/i.test(item.sql || "")), false);
});

test("accepted formal actual can request review of exactly selected frozen versions without an automatic model-wide write", async () => {
  const batches = []; const modelWrites = [];
  const db = {
    prepare(sql) { return { sql, bind(...values) { return { sql, values,
      async first() {
        if (sql.includes("from research_formal_actuals")) return { actual_id: "actual:1", company_id: "company:1", filed_at: "2026-08-01", source_statement: "法定收入事实", source_refs_json: JSON.stringify([{ sourceKind: "filing", url: "https://example.test/filing", title: "法定披露" }]) };
        if (sql.includes("research_valuation_model_versions")) return { ok: 1 };
        throw new Error(`unexpected first: ${sql}`);
      },
      async run() { if (sql.includes("insert or ignore into research_model_review_items")) modelWrites.push(values); return { meta: { changes: 1 } }; },
    }; } }; },
    async batch(statements) { batches.push(statements); return []; },
  };
  const saved = await createGuidanceEventImpactReview(db, {
    impactReviewId: "impact:formal:1", securityCode: "300308.SZ", sourceKind: "formal_actual", sourceId: "actual:1",
    reviewer: "local-user", rationale: "该法定收入实际需要核验既有 DCF 起始假设。", thesisIds: [], riskIds: [], modelTargets: [{ targetKind: "dcf", targetId: "dcf:1" }], createdAt: 100,
  });
  assert.equal(saved.modelReviewItemsCreated, 1);
  assert.equal(batches[0].length, 2);
  assert.equal(modelWrites.length, 1);
  assert.ok(modelWrites[0].includes("formal_actual_accepted"));
  assert.ok(JSON.stringify(modelWrites[0]).includes("impact:formal:1"));
  assert.equal([...batches, ...modelWrites.map(() => ({ sql: "" }))].some((item) => /update research_(theses|risk_entries|valuation|forecast)/i.test(item.sql || "")), false);
});

test("cross-subject targets are rejected before any impact review is written", async () => {
  let batched = false;
  const db = { prepare(sql) { return { bind() { return { async first() {
    if (sql.includes("research_management_guidance_forecasts")) return { company_id: "company:1", guidance_date: "2026-08-01", source_statement: "公告", source_refs_json: JSON.stringify([{ sourceKind: "filing", url: "https://example.test/guidance" }]) };
    if (sql.includes("from research_theses")) return null;
    throw new Error(`unexpected: ${sql}`);
  } }; } }; }, async batch() { batched = true; } };
  await assert.rejects(() => createGuidanceEventImpactReview(db, { impactReviewId: "impact:bad", securityCode: "300308.SZ", sourceKind: "management_guidance", sourceId: "guidance:1", reviewer: "local-user", rationale: "需要核对。", thesisIds: ["thesis:other"], riskIds: [], createdAt: 100 }), /does not belong/);
  assert.equal(batched, false);
});

test("thesis/risk impact disposition appends an action without rewriting the mapped research record", async () => {
  const batches = [];
  const db = {
    prepare(sql) { return { bind(...values) { return { sql, values,
      async first() {
        if (sql.includes("from research_guidance_event_impact_review_targets")) return {
          impact_review_target_id: "impact:1:thesis:1:1", impact_review_id: "impact:1", target_kind: "thesis", target_id: "thesis:1",
          review_state: "requires_review", security_code: "300308.SZ", company_id: "company:1",
        };
        if (sql.includes("from research_theses")) return { ok: 1 };
        throw new Error(`unexpected first: ${sql}`);
      },
    }; } }; },
    async batch(statements) { batches.push(statements); },
  };
  const action = await resolveGuidanceEventImpactReviewTarget(db, "300308.SZ", "impact:1:thesis:1:1", {
    actionId: "impact-action:1", decision: "follow_up_recorded", rationale: "新披露改变原增长命题的可验证范围。",
    actedBy: "local-user", followUpTargetId: "thesis:2", actedAt: 100,
  });
  assert.equal(action.decision, "follow_up_recorded");
  assert.equal(action.followUpTargetId, "thesis:2");
  assert.equal(batches[0].length, 2);
  assert.match(batches[0][0].sql, /update research_guidance_event_impact_review_targets/i);
  assert.match(batches[0][1].sql, /insert into research_guidance_event_impact_review_target_actions/i);
  assert.equal(batches[0].some((statement) => /update research_(theses|risk_entries)/i.test(statement.sql)), false);
});

test("stored impact review reads each target's immutable disposition for queue and snapshot consumers", async () => {
  const db = {
    prepare(sql) { return { bind() { return { async all() {
      if (sql.includes("from research_guidance_event_impact_reviews where")) return { results: [{
        impact_review_id: "impact:1", security_code: "300308.SZ", company_id: "company:1", source_kind: "formal_actual", source_id: "actual:1",
        source_observed_at: "2026-04-20", reviewer: "local-user", rationale: "需要复核。",
        source_binding_json: JSON.stringify({ epistemicType: "observed_fact", statement: "法定实际", sourceReferences: [{ sourceKind: "filing", url: "https://example.test/filing", title: "法定披露" }] }), created_at: 100,
      }] };
      if (sql.includes("from research_guidance_event_impact_review_targets")) return { results: [{
        impact_review_target_id: "impact:1:thesis:1:1", impact_review_id: "impact:1", target_kind: "thesis", target_id: "thesis:1", review_state: "follow_up_recorded", created_at: 100,
      }] };
      if (sql.includes("from research_guidance_event_impact_review_target_actions")) return { results: [{
        action_id: "impact-action:1", impact_review_target_id: "impact:1:thesis:1:1", previous_state: "requires_review", decision: "follow_up_recorded",
        rationale: "新版本已另行追加。", acted_by: "local-user", follow_up_target_id: "thesis:2", acted_at: 101,
      }] };
      throw new Error(`unexpected all: ${sql}`);
    } }; } }; },
  };
  const review = (await loadGuidanceEventImpactReviews(db, "300308.SZ"))[0];
  assert.equal(review.targets[0].reviewState, "follow_up_recorded");
  assert.equal(review.targets[0].action?.followUpTargetId, "thesis:2");
});
