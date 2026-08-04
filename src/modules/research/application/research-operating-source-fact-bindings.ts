import {
  assertResearchOperatingSourceFactBinding,
  assertResearchOperatingSourceFactBindingReview,
  isReviewedOperatingModelInput,
  type ResearchOperatingSourceFactBinding,
  type ResearchOperatingSourceFactBindingReview,
} from "../domain/research-operating-source-fact-bindings";
import type { ResearchOperatingSourceFactKind } from "../domain/research-operating-source-facts";

type Row = Record<string, unknown>;
export type OperatingSourceFactBindingSection = {
  availability: "available" | "empty" | "unavailable";
  reason: "identity_not_found" | "no_records" | "storage_not_initialized" | null;
  items: ResearchOperatingSourceFactBinding[];
  reviewedInputs: ResearchOperatingSourceFactBinding[];
};
export type OperatingSourceFactBindingWrite = Omit<ResearchOperatingSourceFactBinding, "reviewStatus" | "reviewNote" | "reviewedBy" | "reviewedAt" | "factKind">;

/**
 * Records a proposed source-fact-to-field interpretation. The target is
 * ownership-checked, but the target row is never updated: a later model author
 * must deliberately copy a reviewed input into a new immutable model version.
 */
export async function recordResearchOperatingSourceFactBinding(db: D1Database, input: OperatingSourceFactBindingWrite): Promise<{ state: "saved" | "unavailable"; operatingSourceFactBindingId: string; reason: "storage_not_initialized" | null }> {
  const source = await sourceFact(db, input.operatingSourceFactId);
  if (!source || source.operatingCompanyId !== input.operatingCompanyId) throw new Error("operating source fact was not found for the mapped operating company");
  assertResearchOperatingSourceFactBinding({ ...input, factKind: source.factKind });
  const targetCompanyId = await targetCompany(db, input.targetKind, input.targetId);
  if (!targetCompanyId || targetCompanyId !== input.operatingCompanyId) throw new Error("selected operating-model target was not found for the mapped operating company");
  const model = await modelCompany(db, input.operatingModelId);
  if (!model || model !== input.operatingCompanyId || !await targetBelongsToModel(db, input.targetKind, input.targetId, input.operatingModelId)) throw new Error("selected target does not belong to the requested operating model");
  try {
    await db.prepare(`insert into research_operating_source_fact_bindings (
      operating_source_fact_binding_id, operating_company_id, operating_source_fact_id, operating_model_id,
      target_kind, target_id, target_field, formula, applicable_period, applicability_description,
      uncovered_scope, created_by, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      input.operatingSourceFactBindingId, input.operatingCompanyId, input.operatingSourceFactId, input.operatingModelId,
      input.targetKind, input.targetId, input.targetField, input.formula, input.applicablePeriod,
      input.applicabilityDescription, input.uncoveredScope, input.createdBy, input.createdAt,
    ).run();
    return { state: "saved", operatingSourceFactBindingId: input.operatingSourceFactBindingId, reason: null };
  } catch (error) { if (missing(error, "research_operating_source_fact_bindings")) return { state: "unavailable", operatingSourceFactBindingId: input.operatingSourceFactBindingId, reason: "storage_not_initialized" }; throw error; }
}

/** Reviews append an audit event. Only a latest `reviewed` event exposes an input. */
export async function reviewResearchOperatingSourceFactBinding(db: D1Database, input: ResearchOperatingSourceFactBindingReview, operatingCompanyId: string): Promise<{ state: "saved" | "unavailable"; operatingSourceFactBindingReviewId: string; reason: "storage_not_initialized" | null }> {
  assertResearchOperatingSourceFactBindingReview(input);
  const binding = await db.prepare(`select operating_source_fact_binding_id from research_operating_source_fact_bindings where operating_source_fact_binding_id=? and operating_company_id=?`).bind(input.operatingSourceFactBindingId, operatingCompanyId).first<Row>();
  if (!binding) throw new Error("operating source fact binding was not found for the mapped operating company");
  try {
    await db.prepare(`insert into research_operating_source_fact_binding_reviews (
      operating_source_fact_binding_review_id, operating_source_fact_binding_id, review_status, review_note, reviewed_by, reviewed_at
    ) values (?, ?, ?, ?, ?, ?)`).bind(input.operatingSourceFactBindingReviewId, input.operatingSourceFactBindingId, input.reviewStatus, input.reviewNote, input.reviewedBy, input.reviewedAt).run();
    return { state: "saved", operatingSourceFactBindingReviewId: input.operatingSourceFactBindingReviewId, reason: null };
  } catch (error) { if (missing(error, "research_operating_source_fact_binding_reviews")) return { state: "unavailable", operatingSourceFactBindingReviewId: input.operatingSourceFactBindingReviewId, reason: "storage_not_initialized" }; throw error; }
}

export async function loadResearchOperatingSourceFactBindings(db: D1Database, query: { operatingCompanyId: string | null; limit?: number }): Promise<OperatingSourceFactBindingSection> {
  if (!query.operatingCompanyId) return unavailable("identity_not_found");
  try {
    const rows = await db.prepare(`select binding.*, fact.fact_kind,
      review.review_status, review.review_note, review.reviewed_by, review.reviewed_at
      from research_operating_source_fact_bindings binding
      join research_operating_source_facts fact on fact.operating_source_fact_id=binding.operating_source_fact_id
      left join research_operating_source_fact_binding_reviews review on review.operating_source_fact_binding_review_id=(
        select latest.operating_source_fact_binding_review_id
        from research_operating_source_fact_binding_reviews latest
        where latest.operating_source_fact_binding_id=binding.operating_source_fact_binding_id
        order by latest.reviewed_at desc, latest.operating_source_fact_binding_review_id desc limit 1
      )
      where binding.operating_company_id=?
      order by binding.created_at desc, binding.operating_source_fact_binding_id desc limit ?`).bind(query.operatingCompanyId, boundedLimit(query.limit ?? 200)).all<Row>();
    const items = rows.results.map(binding);
    return { availability: items.length ? "available" : "empty", reason: items.length ? null : "no_records", items, reviewedInputs: items.filter(isReviewedOperatingModelInput) };
  } catch (error) { if (missing(error, "research_operating_source_fact_bindings")) return unavailable("storage_not_initialized"); throw error; }
}

async function sourceFact(db: D1Database, id: string): Promise<{ operatingCompanyId: string; factKind: ResearchOperatingSourceFactKind } | null> {
  const row = await db.prepare(`select operating_company_id, fact_kind from research_operating_source_facts where operating_source_fact_id=?`).bind(required(id, "operatingSourceFactId")).first<Row>();
  return row ? { operatingCompanyId: text(row.operating_company_id), factKind: text(row.fact_kind) as ResearchOperatingSourceFactKind } : null;
}
async function modelCompany(db: D1Database, id: string): Promise<string | null> { const row = await db.prepare(`select company_id from research_operating_models_typed where operating_model_id=?`).bind(required(id, "operatingModelId")).first<Row>(); return row ? text(row.company_id) : null; }
async function targetCompany(db: D1Database, kind: string, id: string): Promise<string | null> {
  const query = kind === "segment_variable"
    ? `select model.company_id from research_operating_model_segments_typed segment join research_operating_models_typed model on model.operating_model_id=segment.operating_model_id where segment.operating_segment_id=?`
    : kind === "contract_parameter"
      ? `select model.company_id from research_operating_model_contracts_typed contract join research_operating_model_segments_typed segment on segment.operating_segment_id=contract.operating_segment_id join research_operating_models_typed model on model.operating_model_id=segment.operating_model_id where contract.contract_driver_id=?`
      : `select model.company_id from research_operating_model_growth_constraints_typed constraint join research_operating_models_typed model on model.operating_model_id=constraint.operating_model_id where constraint.growth_constraint_id=?`;
  const row = await db.prepare(query).bind(required(id, "targetId")).first<Row>(); return row ? text(row.company_id) : null;
}
async function targetBelongsToModel(db: D1Database, kind: string, id: string, modelId: string): Promise<boolean> {
  const query = kind === "segment_variable"
    ? `select 1 as found from research_operating_model_segments_typed where operating_segment_id=? and operating_model_id=?`
    : kind === "contract_parameter"
      ? `select 1 as found from research_operating_model_contracts_typed contract join research_operating_model_segments_typed segment on segment.operating_segment_id=contract.operating_segment_id where contract.contract_driver_id=? and segment.operating_model_id=?`
      : `select 1 as found from research_operating_model_growth_constraints_typed where growth_constraint_id=? and operating_model_id=?`;
  return Boolean(await db.prepare(query).bind(id, modelId).first<Row>());
}
function binding(row: Row): ResearchOperatingSourceFactBinding { return { operatingSourceFactBindingId: text(row.operating_source_fact_binding_id), operatingCompanyId: text(row.operating_company_id), operatingSourceFactId: text(row.operating_source_fact_id), operatingModelId: text(row.operating_model_id), targetKind: text(row.target_kind) as ResearchOperatingSourceFactBinding["targetKind"], targetId: text(row.target_id), targetField: text(row.target_field), factKind: text(row.fact_kind) as ResearchOperatingSourceFactKind, formula: text(row.formula), applicablePeriod: text(row.applicable_period), applicabilityDescription: text(row.applicability_description), uncoveredScope: text(row.uncovered_scope), reviewStatus: optional(row.review_status) as ResearchOperatingSourceFactBinding["reviewStatus"] || "pending", reviewNote: optional(row.review_note), reviewedBy: optional(row.reviewed_by), reviewedAt: nullableNumber(row.reviewed_at), createdBy: text(row.created_by), createdAt: number(row.created_at) }; }
function unavailable(reason: "identity_not_found" | "storage_not_initialized"): OperatingSourceFactBindingSection { return { availability: "unavailable", reason, items: [], reviewedInputs: [] }; }
function required(value: unknown, label: string): string { const result = String(value ?? "").trim(); if (!result) throw new Error(`${label} is required`); return result; }
function text(value: unknown): string { return required(value, "stored operating source fact binding field"); }
function optional(value: unknown): string | null { const result = String(value ?? "").trim(); return result || null; }
function number(value: unknown): number { const result = Number(value); if (!Number.isFinite(result)) throw new Error("stored operating source fact binding timestamp is invalid"); return result; }
function nullableNumber(value: unknown): number | null { return value === null || value === undefined || value === "" ? null : number(value); }
function boundedLimit(value: number): number { return Math.min(500, Math.max(1, Math.floor(value))); }
function missing(error: unknown, table: string) { return String(error).includes(`no such table: ${table}`); }
