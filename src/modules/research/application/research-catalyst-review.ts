import { assertResearchCatalystReview, type ResearchCatalystReview } from "../domain/research-catalyst-review";

type CatalystSubject = { catalyst_id: string; company_id: string | null; security_code: string | null; event_at: number | null; status: string };

/** Append a source-bound result to a prior event without changing its original expectation. */
export async function insertResearchCatalystReview(db: D1Database, input: ResearchCatalystReview) {
  assertResearchCatalystReview(input);
  const catalyst = await db.prepare(`select catalyst_id, company_id, security_code, event_at, status from research_catalysts where catalyst_id=?`)
    .bind(input.catalystId).first<CatalystSubject>();
  if (!catalyst) throw new Error("catalyst review requires an existing catalyst");
  if (catalyst.security_code !== input.securityCode) throw new Error("catalyst review security does not match catalyst");
  if (catalyst.company_id !== input.companyId) throw new Error("catalyst review company does not match catalyst");
  if (catalyst.event_at === null || catalyst.event_at > input.asOf) throw new Error("catalyst review cannot precede the event date");
  await db.prepare(`insert into research_catalyst_reviews (
    catalyst_review_id, catalyst_id, company_id, security_code, as_of, review_status, outcome_summary,
    expected_vs_actual, impacted_assumption_status, next_action, source_refs_json, reviewed_at, created_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(input.catalystReviewId, input.catalystId, input.companyId, input.securityCode, input.asOf, input.reviewStatus,
      input.outcomeSummary, input.expectedVsActual, input.impactedAssumptionStatus, input.nextAction,
      JSON.stringify(input.sourceReferences), input.reviewedAt, input.createdAt).run();
  return { catalystReviewId: input.catalystReviewId, catalystId: input.catalystId };
}

export async function loadResearchCatalystReviews(db: D1Database, input: { catalystIds: string[]; asOf: number }): Promise<Map<string, ResearchCatalystReview[]>> {
  const result = new Map<string, ResearchCatalystReview[]>();
  if (!input.catalystIds.length) return result;
  const placeholders = input.catalystIds.map(() => "?").join(", ");
  const rows = await db.prepare(`select * from research_catalyst_reviews where catalyst_id in (${placeholders}) and as_of<=?
    order by catalyst_id, as_of desc, reviewed_at desc, created_at desc, catalyst_review_id`).bind(...input.catalystIds, input.asOf).all<Record<string, unknown>>();
  for (const row of rows.results) {
    const review = mapCatalystReview(row);
    const list = result.get(review.catalystId) ?? [];
    list.push(review); result.set(review.catalystId, list);
  }
  return result;
}

function mapCatalystReview(row: Record<string, unknown>): ResearchCatalystReview {
  const review: ResearchCatalystReview = {
    catalystReviewId: text(row.catalyst_review_id), catalystId: text(row.catalyst_id), companyId: nullable(row.company_id), securityCode: text(row.security_code),
    asOf: number(row.as_of), reviewStatus: text(row.review_status) as ResearchCatalystReview["reviewStatus"], outcomeSummary: text(row.outcome_summary),
    expectedVsActual: text(row.expected_vs_actual), impactedAssumptionStatus: text(row.impacted_assumption_status) as ResearchCatalystReview["impactedAssumptionStatus"], nextAction: text(row.next_action),
    sourceReferences: json(row.source_refs_json), reviewedAt: number(row.reviewed_at), createdAt: number(row.created_at),
  };
  assertResearchCatalystReview(review);
  return review;
}

function text(value: unknown) { const result = String(value ?? "").trim(); if (!result) throw new Error("stored catalyst review text is missing"); return result; }
function nullable(value: unknown) { const result = String(value ?? "").trim(); return result || null; }
function number(value: unknown) { const result = Number(value); if (!Number.isFinite(result)) throw new Error("stored catalyst review number is invalid"); return result; }
function json(value: unknown) { try { return JSON.parse(String(value)) as ResearchCatalystReview["sourceReferences"]; } catch { throw new Error("stored catalyst review source refs are invalid"); } }
