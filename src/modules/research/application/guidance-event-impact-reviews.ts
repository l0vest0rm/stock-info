import {
  GUIDANCE_EVENT_IMPACT_REVIEW_RULE_VERSION,
  assertGuidanceEventImpactReviewTargetActionWrite,
  assertGuidanceEventImpactReviewWrite,
  impactTargets,
  type GuidanceEventImpactReview,
  type GuidanceEventImpactReviewTargetAction,
  type GuidanceEventImpactReviewTargetActionWrite,
  type GuidanceEventImpactReviewWrite,
} from "../domain/guidance-event-impact-review";
import type { ResearchSourceReference } from "../domain/research-dossier";
import { enqueueSelectedModelReviews } from "./formal-actual-candidates";

type Row = Record<string, unknown>;
type BoundSource = {
  companyId: string | null;
  observedAt: string | null;
  binding: GuidanceEventImpactReview["sourceBinding"];
};

/**
 * Maps an existing source-bound guidance, event outcome, or accepted formal
 * actual to explicit public thesis/risk/model-version targets. It only adds a
 * review record and selected model-review items;
 * it cannot change any target's status, text, inputs or result.
 */
export async function createGuidanceEventImpactReview(
  db: D1Database,
  input: GuidanceEventImpactReviewWrite,
): Promise<GuidanceEventImpactReview & { modelReviewItemsCreated: number }> {
  assertGuidanceEventImpactReviewWrite(input);
  const source = await loadBoundSource(db, input.securityCode, input.sourceKind, input.sourceId);
  const targets = impactTargets(input).map((target, index) => ({
    ...target,
    impactReviewTargetId: `${input.impactReviewId}:${target.targetKind}:${target.targetId}:${index + 1}`,
  }));
  await assertTargetOwnership(db, input.securityCode, source.companyId, targets);
  const review: GuidanceEventImpactReview = {
    ruleVersion: GUIDANCE_EVENT_IMPACT_REVIEW_RULE_VERSION,
    impactReviewId: input.impactReviewId,
    securityCode: input.securityCode,
    companyId: source.companyId,
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    sourceObservedAt: source.observedAt,
    reviewer: input.reviewer.trim(),
    rationale: input.rationale.trim(),
    sourceBinding: source.binding,
    targets,
    createdAt: input.createdAt,
  };
  await db.batch([
    db.prepare(`insert into research_guidance_event_impact_reviews (
      impact_review_id, security_code, company_id, source_kind, source_id, source_observed_at,
      reviewer, rationale, source_binding_json, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(review.impactReviewId, review.securityCode, review.companyId, review.sourceKind, review.sourceId,
        review.sourceObservedAt, review.reviewer, review.rationale, JSON.stringify(review.sourceBinding), review.createdAt),
    ...review.targets.map((target, index) => db.prepare(`insert into research_guidance_event_impact_review_targets (
      impact_review_target_id, impact_review_id, target_kind, target_id, review_state, created_at
    ) values (?, ?, ?, ?, 'requires_review', ?)`)
      .bind(target.impactReviewTargetId, review.impactReviewId,
        target.targetKind, target.targetId, review.createdAt)),
  ]);
  const modelTargets = review.targets
    .filter((target): target is GuidanceEventImpactReview["targets"][number] & { targetKind: "scenario" | "dcf" | "reverse_dcf" } => ["scenario", "dcf", "reverse_dcf"].includes(target.targetKind))
    .map((target) => ({ targetKind: target.targetKind, targetVersionId: target.targetId }));
  const modelReviewItemsCreated = await enqueueSelectedModelReviews(
    db,
    {
      securityCode: review.securityCode,
      triggerKind: review.sourceKind === "management_guidance" ? "management_guidance_reviewed" : review.sourceKind === "catalyst_actual" ? "catalyst_actual_reviewed" : "formal_actual_accepted",
      triggerId: review.impactReviewId,
      reason: `来源绑定的${sourceLabel(review.sourceKind)}已明确映射至选定复核对象；冻结版本不变，须人工复核。`,
      evidence: { impactReviewId: review.impactReviewId, sourceKind: review.sourceKind, sourceId: review.sourceId, sourceBinding: review.sourceBinding, targets: review.targets },
      targets: modelTargets,
      createdAt: review.createdAt,
    },
  );
  return { ...review, modelReviewItemsCreated };
}

/**
 * Appends the final disposition of an explicitly mapped thesis/risk target.
 * The target's queue state is updated only alongside that audit action; the
 * linked thesis/risk itself is deliberately never updated here.
 */
export async function resolveGuidanceEventImpactReviewTarget(
  db: D1Database,
  securityCode: string,
  impactReviewTargetId: string,
  input: GuidanceEventImpactReviewTargetActionWrite,
): Promise<GuidanceEventImpactReviewTargetAction> {
  assertGuidanceEventImpactReviewTargetActionWrite(input);
  const target = await db.prepare(`select t.impact_review_target_id, t.impact_review_id, t.target_kind, t.target_id, t.review_state,
      r.security_code, r.company_id
    from research_guidance_event_impact_review_targets t
    join research_guidance_event_impact_reviews r on r.impact_review_id=t.impact_review_id
    where t.impact_review_target_id=? and r.security_code=? limit 1`)
    .bind(impactReviewTargetId, securityCode).first<Row>();
  if (!target || text(target.review_state) !== "requires_review") throw new Error("open thesis/risk impact review target not found");
  const kind = targetKind(target.target_kind);
  if (kind !== "thesis" && kind !== "risk") throw new Error("model impact targets must be resolved through their frozen model review item");
  await assertImpactTargetStillOwned(db, securityCode, nullable(target.company_id), kind, text(target.target_id));
  const followUpTargetId = String(input.followUpTargetId ?? "").trim() || null;
  if (followUpTargetId) await assertImpactTargetStillOwned(db, securityCode, nullable(target.company_id), kind, followUpTargetId);
  const action: GuidanceEventImpactReviewTargetAction = {
    actionId: input.actionId.trim(), impactReviewTargetId: text(target.impact_review_target_id), previousState: "requires_review",
    decision: input.decision, rationale: input.rationale.trim(), actedBy: input.actedBy.trim(), followUpTargetId, actedAt: input.actedAt,
  };
  await db.batch([
    db.prepare(`update research_guidance_event_impact_review_targets set review_state=?
      where impact_review_target_id=? and review_state='requires_review'`).bind(action.decision, action.impactReviewTargetId),
    db.prepare(`insert into research_guidance_event_impact_review_target_actions (
      action_id, impact_review_target_id, previous_state, decision, rationale, acted_by, follow_up_target_id, acted_at
    ) values (?, ?, 'requires_review', ?, ?, ?, ?, ?)`)
      .bind(action.actionId, action.impactReviewTargetId, action.decision, action.rationale, action.actedBy,
        action.followUpTargetId, action.actedAt),
  ]);
  return action;
}

export async function loadGuidanceEventImpactReviews(db: D1Database, securityCode: string): Promise<GuidanceEventImpactReview[]> {
  const rows = await db.prepare(`select * from research_guidance_event_impact_reviews where security_code=? order by created_at desc, impact_review_id desc`)
    .bind(securityCode).all<Row>();
  if (!rows.results.length) return [];
  const ids = rows.results.map((row) => text(row.impact_review_id));
  const marks = ids.map(() => "?").join(", ");
  const targetRows = await db.prepare(`select * from research_guidance_event_impact_review_targets where impact_review_id in (${marks}) order by created_at, impact_review_target_id`)
    .bind(...ids).all<Row>();
  const targetIds = targetRows.results.map((row) => text(row.impact_review_target_id));
  const actionRows = targetIds.length
    ? await db.prepare(`select * from research_guidance_event_impact_review_target_actions where impact_review_target_id in (${targetIds.map(() => "?").join(", ")}) order by acted_at desc, action_id desc`)
      .bind(...targetIds).all<Row>()
    : { results: [] as Row[] };
  const actionByTarget = new Map<string, GuidanceEventImpactReviewTargetAction>();
  for (const row of actionRows.results) actionByTarget.set(text(row.impact_review_target_id), mapTargetAction(row));
  const targetsByReview = new Map<string, GuidanceEventImpactReview["targets"]>();
  for (const row of targetRows.results) {
    const id = text(row.impact_review_id);
    const list = targetsByReview.get(id) ?? [];
    const impactReviewTargetId = text(row.impact_review_target_id);
    list.push({ impactReviewTargetId, targetKind: targetKind(row.target_kind), targetId: text(row.target_id),
      reviewState: reviewState(row.review_state), action: actionByTarget.get(impactReviewTargetId) ?? null });
    targetsByReview.set(id, list);
  }
  return rows.results.map((row) => ({
    ruleVersion: GUIDANCE_EVENT_IMPACT_REVIEW_RULE_VERSION,
    impactReviewId: text(row.impact_review_id), securityCode: text(row.security_code), companyId: nullable(row.company_id),
    sourceKind: text(row.source_kind) as GuidanceEventImpactReview["sourceKind"], sourceId: text(row.source_id), sourceObservedAt: nullable(row.source_observed_at),
    reviewer: text(row.reviewer), rationale: text(row.rationale), sourceBinding: sourceBinding(row.source_binding_json),
    targets: targetsByReview.get(text(row.impact_review_id)) ?? [], createdAt: number(row.created_at),
  }));
}

async function loadBoundSource(db: D1Database, securityCode: string, kind: GuidanceEventImpactReviewWrite["sourceKind"], sourceId: string): Promise<BoundSource> {
  if (kind === "management_guidance") {
    const row = await db.prepare(`select guidance_forecast_id, company_id, guidance_date, source_statement, source_refs_json
      from research_management_guidance_forecasts where guidance_forecast_id=? and security_code=?`).bind(sourceId, securityCode).first<Row>();
    if (!row) throw new Error("management guidance source not found for this security");
    const sourceReferences = references(row.source_refs_json, "management guidance");
    return { companyId: nullable(row.company_id), observedAt: text(row.guidance_date), binding: { epistemicType: "management_guidance", statement: text(row.source_statement), sourceReferences } };
  }
  if (kind === "formal_actual") {
    const row = await db.prepare(`select a.actual_id, a.company_id, a.filed_at, a.source_statement, a.source_refs_json
      from research_formal_actuals a
      join research_formal_actual_candidate_reviews r on r.actual_id=a.actual_id and r.decision='accepted'
      where a.actual_id=? and a.security_code=? limit 1`).bind(sourceId, securityCode).first<Row>();
    if (!row) throw new Error("accepted formal actual source not found for this security");
    const sourceReferences = references(row.source_refs_json, "formal actual");
    return { companyId: nullable(row.company_id), observedAt: text(row.filed_at), binding: { epistemicType: "observed_fact", statement: text(row.source_statement), sourceReferences } };
  }
  const row = await db.prepare(`select r.catalyst_review_id, r.company_id, r.as_of, r.outcome_summary, r.source_refs_json
    from research_catalyst_reviews r where r.catalyst_review_id=? and r.security_code=?`).bind(sourceId, securityCode).first<Row>();
  if (!row) throw new Error("catalyst actual review source not found for this security");
  const sourceReferences = references(row.source_refs_json, "catalyst actual review");
  return { companyId: nullable(row.company_id), observedAt: String(number(row.as_of)), binding: { epistemicType: "observed_fact", statement: text(row.outcome_summary), sourceReferences } };
}

async function assertTargetOwnership(db: D1Database, securityCode: string, companyId: string | null, targets: GuidanceEventImpactReview["targets"]): Promise<void> {
  for (const target of targets) {
    if (target.targetKind === "thesis") {
      if (!companyId) throw new Error("an operating-company mapping is required before mapping this source to a thesis");
      const found = await db.prepare(`select 1 as ok from research_theses where thesis_id=? and company_id=? limit 1`).bind(target.targetId, companyId).first<Row>();
      if (!found) throw new Error("thesis target does not belong to this source subject");
    } else if (target.targetKind === "risk") {
      const found = await db.prepare(`select 1 as ok from research_risk_entries where risk_id=? and security_code=? and (company_id=? or company_id is null) limit 1`)
        .bind(target.targetId, securityCode, companyId).first<Row>();
      if (!found) throw new Error("risk target does not belong to this source subject");
    } else {
      const table = target.targetKind === "dcf" ? "research_valuation_model_versions"
        : target.targetKind === "reverse_dcf" ? "research_reverse_valuation_model_versions"
          : "research_forecast_scenarios";
      const idColumn = target.targetKind === "scenario" ? "scenario_id" : "model_version_id";
      const found = await db.prepare(`select 1 as ok from ${table} where ${idColumn}=? and security_code=? and status<>'superseded' limit 1`)
        .bind(target.targetId, securityCode).first<Row>();
      if (!found) throw new Error(`${target.targetKind} target does not belong to this security or is superseded`);
    }
  }
}

async function assertImpactTargetStillOwned(
  db: D1Database,
  securityCode: string,
  companyId: string | null,
  kind: "thesis" | "risk",
  targetId: string,
): Promise<void> {
  if (kind === "thesis") {
    if (!companyId) throw new Error("impact-review thesis target has no operating-company mapping");
    const found = await db.prepare(`select 1 as ok from research_theses where thesis_id=? and company_id=? limit 1`).bind(targetId, companyId).first<Row>();
    if (!found) throw new Error("thesis impact-review target does not belong to this source subject");
    return;
  }
  const found = await db.prepare(`select 1 as ok from research_risk_entries where risk_id=? and security_code=? and (company_id=? or company_id is null) limit 1`)
    .bind(targetId, securityCode, companyId).first<Row>();
  if (!found) throw new Error("risk impact-review target does not belong to this source subject");
}

function references(value: unknown, label: string): ResearchSourceReference[] {
  let parsed: unknown;
  try { parsed = JSON.parse(String(value ?? "[]")); } catch { throw new Error(`${label} source references are invalid`); }
  if (!Array.isArray(parsed) || !parsed.length) throw new Error(`${label} requires source references`);
  for (const reference of parsed) {
    if (!reference || typeof reference !== "object" || !(reference as ResearchSourceReference).sourceKind) throw new Error(`${label} source references are invalid`);
  }
  return parsed as ResearchSourceReference[];
}
function sourceBinding(value: unknown): GuidanceEventImpactReview["sourceBinding"] {
  let parsed: unknown;
  try { parsed = JSON.parse(String(value)); } catch { throw new Error("stored impact review source binding is invalid"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("stored impact review source binding is invalid");
  const item = parsed as Record<string, unknown>;
  const epistemicType = text(item.epistemicType);
  if (epistemicType !== "management_guidance" && epistemicType !== "observed_fact") throw new Error("stored impact review epistemic type is invalid");
  return { epistemicType, statement: text(item.statement), sourceReferences: references(JSON.stringify(item.sourceReferences), "stored impact review") };
}
function targetKind(value: unknown): GuidanceEventImpactReview["targets"][number]["targetKind"] {
  const result = text(value);
  if (!( ["thesis", "risk", "scenario", "dcf", "reverse_dcf"] as const).includes(result as GuidanceEventImpactReview["targets"][number]["targetKind"])) throw new Error("stored impact review target kind is invalid");
  return result as GuidanceEventImpactReview["targets"][number]["targetKind"];
}
function reviewState(value: unknown): GuidanceEventImpactReview["targets"][number]["reviewState"] {
  const result = text(value);
  if (!( ["requires_review", "no_change", "follow_up_recorded", "not_applicable"] as const).includes(result as GuidanceEventImpactReview["targets"][number]["reviewState"])) throw new Error("stored impact review target state is invalid");
  return result as GuidanceEventImpactReview["targets"][number]["reviewState"];
}
function mapTargetAction(row: Row): GuidanceEventImpactReviewTargetAction {
  const decision = reviewState(row.decision);
  if (decision === "requires_review") throw new Error("stored impact review action decision is invalid");
  return {
    actionId: text(row.action_id), impactReviewTargetId: text(row.impact_review_target_id), previousState: "requires_review",
    decision, rationale: text(row.rationale), actedBy: text(row.acted_by), followUpTargetId: nullable(row.follow_up_target_id), actedAt: number(row.acted_at),
  };
}
function sourceLabel(kind: GuidanceEventImpactReview["sourceKind"]): string {
  return kind === "management_guidance" ? "管理层指引" : kind === "catalyst_actual" ? "事件实际复盘" : "已接受法定实际";
}
function text(value: unknown): string { const result = String(value ?? "").trim(); if (!result) throw new Error("stored impact review text is missing"); return result; }
function nullable(value: unknown): string | null { const result = String(value ?? "").trim(); return result || null; }
function number(value: unknown): number { const result = Number(value); if (!Number.isFinite(result)) throw new Error("stored impact review number is invalid"); return result; }
