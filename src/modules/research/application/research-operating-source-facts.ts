import {
  assertResearchOperatingSourceFact,
  operatingSourceFactConfigVersion,
  type ResearchOperatingSourceFact,
  type ResearchOperatingSourceFactKind,
  type ResearchOperatingSourceFactPeriodKind,
} from "../domain/research-operating-source-facts";
import type { ResearchInformationEvidenceTargetModule } from "../domain/research-information-evidence";

type Row = Record<string, unknown>;
export type OperatingSourceFactWrite = Omit<ResearchOperatingSourceFact, "operatingSourceFactId" | "sourceSecurityCode" | "candidateId" | "candidateReviewId" | "targetModule" | "targetField" | "informationType" | "mappingConfigVersion" | "statement" | "createdAt"> & { operatingSourceFactId?: string; createdAt?: number; expectedSecurityCode: string };
export type ResearchOperatingSourceFactRead = ResearchOperatingSourceFact & {
  /** Immutable source-document metadata from the accepted evidence reference. */
  sourceUrl: string | null;
  sourceTitle: string | null;
  sourcePublishedAt: string | null;
};
export type OperatingSourceFactSection = { availability: "available" | "empty" | "unavailable"; reason: "identity_not_found" | "no_records" | "storage_not_initialized" | null; items: ResearchOperatingSourceFactRead[] };

/**
 * Creates an append-only normalized source fact from exactly one previously
 * accepted evidence reference.  It never writes an operating model, driver
 * plan, scenario, market model, or valuation version.
 */
export async function recordResearchOperatingSourceFact(db: D1Database, input: OperatingSourceFactWrite): Promise<{ state: "saved" | "unavailable"; operatingSourceFactId: string; reason: "storage_not_initialized" | null }> {
  const evidence = await acceptedEvidenceReference(db, input.evidenceReferenceId, input.expectedSecurityCode, input.operatingCompanyId);
  if (!evidence) throw new Error("accepted reusable evidence reference was not found for a confirmed security of the requested operating company");
  const fact: ResearchOperatingSourceFact = {
    ...input,
    operatingSourceFactId: input.operatingSourceFactId ?? `operating-source-fact:${crypto.randomUUID()}`,
    sourceSecurityCode: evidence.securityCode,
    candidateId: evidence.candidateId,
    candidateReviewId: evidence.candidateReviewId,
    targetModule: evidence.targetModule,
    targetField: evidence.targetField,
    informationType: evidence.informationType,
    statement: evidence.statement,
    mappingConfigVersion: operatingSourceFactConfigVersion(),
    createdAt: input.createdAt ?? input.recordedAt,
  };
  assertResearchOperatingSourceFact(fact);
  try {
    await db.prepare(`insert into research_operating_source_facts (
      operating_source_fact_id, operating_company_id, source_security_code, evidence_reference_id, candidate_id, candidate_review_id,
      fact_kind, subject_label, segment_label, customer_or_channel, period_label, period_kind, reported_value, numeric_value,
      unit, currency, amount_scale, scope_description, comparability_note, statement, information_type, mapping_config_version,
      recorded_by, recorded_at, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(fact.operatingSourceFactId, fact.operatingCompanyId, fact.sourceSecurityCode, fact.evidenceReferenceId, fact.candidateId, fact.candidateReviewId,
        fact.factKind, fact.subjectLabel, fact.segmentLabel, fact.customerOrChannel, fact.periodLabel, fact.periodKind, fact.reportedValue, fact.numericValue,
        fact.unit, fact.currency, fact.amountScale, fact.scopeDescription, fact.comparabilityNote, fact.statement, fact.informationType, fact.mappingConfigVersion,
        fact.recordedBy, fact.recordedAt, fact.createdAt).run();
    return { state: "saved", operatingSourceFactId: fact.operatingSourceFactId, reason: null };
  } catch (error) { if (missing(error, "research_operating_source_facts")) return { state: "unavailable", operatingSourceFactId: fact.operatingSourceFactId, reason: "storage_not_initialized" }; throw error; }
}

/** Facts follow the operating company, while retaining the exact source security. */
export async function loadResearchOperatingSourceFacts(db: D1Database, query: { operatingCompanyId: string | null; limit?: number }): Promise<OperatingSourceFactSection> {
  if (!query.operatingCompanyId) return { availability: "unavailable", reason: "identity_not_found", items: [] };
  try {
    const rows = await db.prepare(`select fact.*, candidate.target_module as targetModule, candidate.target_field as targetField,
        reference.source_url as sourceUrl, reference.title as sourceTitle, reference.published_at as sourcePublishedAt
      from research_operating_source_facts fact
      join research_information_evidence_candidates candidate on candidate.candidate_id=fact.candidate_id
      join research_reusable_evidence_references reference on reference.evidence_reference_id=fact.evidence_reference_id
      where fact.operating_company_id=? order by fact.recorded_at desc, fact.operating_source_fact_id desc limit ?`)
      .bind(query.operatingCompanyId, boundedLimit(query.limit ?? 200)).all<Row>();
    const items = rows.results.map(mapFact);
    return { availability: items.length ? "available" : "empty", reason: items.length ? null : "no_records", items };
  } catch (error) { if (missing(error, "research_operating_source_facts")) return { availability: "unavailable", reason: "storage_not_initialized", items: [] }; throw error; }
}

type AcceptedEvidence = { securityCode: string; candidateId: string; candidateReviewId: string; targetModule: ResearchInformationEvidenceTargetModule; targetField: string; informationType: string; statement: string };
async function acceptedEvidenceReference(db: D1Database, evidenceReferenceId: string, expectedSecurityCode: string, operatingCompanyId: string): Promise<AcceptedEvidence | null> {
  const row = await db.prepare(`select reference.security_code as securityCode, reference.candidate_id as candidateId,
      reference.candidate_review_id as candidateReviewId, candidate.target_module as targetModule, candidate.target_field as targetField,
      candidate.information_type as informationType, candidate.statement as statement, review.decision as decision
    from research_reusable_evidence_references reference
    join research_information_evidence_candidates candidate on candidate.candidate_id=reference.candidate_id
    join research_information_evidence_candidate_reviews review on review.candidate_review_id=reference.candidate_review_id
    join research_listed_securities security on security.security_code=reference.security_code
      and security.company_id=? and security.mapping_status='confirmed'
    where reference.evidence_reference_id=? and reference.security_code=?`).bind(required(operatingCompanyId, "operatingCompanyId"), required(evidenceReferenceId, "evidenceReferenceId"), required(expectedSecurityCode, "expectedSecurityCode").toUpperCase()).first<Row>();
  if (!row || text(row.decision) !== "accepted") return null;
  return { securityCode: text(row.securityCode), candidateId: text(row.candidateId), candidateReviewId: text(row.candidateReviewId), targetModule: text(row.targetModule) as ResearchInformationEvidenceTargetModule, targetField: text(row.targetField), informationType: text(row.informationType), statement: text(row.statement) };
}
function mapFact(row: Row): ResearchOperatingSourceFactRead {
  return {
    operatingSourceFactId: text(row.operating_source_fact_id), operatingCompanyId: text(row.operating_company_id), sourceSecurityCode: text(row.source_security_code), evidenceReferenceId: text(row.evidence_reference_id), candidateId: text(row.candidate_id), candidateReviewId: text(row.candidate_review_id), targetModule: text(row.targetModule) as ResearchInformationEvidenceTargetModule, targetField: text(row.targetField), factKind: text(row.fact_kind) as ResearchOperatingSourceFactKind, subjectLabel: text(row.subject_label), segmentLabel: optional(row.segment_label), customerOrChannel: optional(row.customer_or_channel), periodLabel: text(row.period_label), periodKind: text(row.period_kind) as ResearchOperatingSourceFactPeriodKind, reportedValue: text(row.reported_value), numericValue: nullableNumber(row.numeric_value), unit: optional(row.unit), currency: optional(row.currency), amountScale: optional(row.amount_scale), scopeDescription: text(row.scope_description), comparabilityNote: text(row.comparability_note), statement: text(row.statement), informationType: text(row.information_type), mappingConfigVersion: text(row.mapping_config_version), recordedBy: text(row.recorded_by), recordedAt: number(row.recorded_at), createdAt: number(row.created_at), sourceUrl: optional(row.sourceUrl), sourceTitle: optional(row.sourceTitle), sourcePublishedAt: optional(row.sourcePublishedAt),
  };
}
function required(value: unknown, label: string): string { const result = String(value ?? "").trim(); if (!result) throw new Error(`${label} is required`); return result; }
function text(value: unknown): string { return required(value, "stored operating source fact field"); }
function optional(value: unknown): string | null { const result = String(value ?? "").trim(); return result || null; }
function number(value: unknown): number { const result = Number(value); if (!Number.isFinite(result)) throw new Error("stored operating source fact timestamp is invalid"); return result; }
function nullableNumber(value: unknown): number | null { return value === null || value === undefined || value === "" ? null : number(value); }
function boundedLimit(value: number): number { return Math.min(500, Math.max(1, Math.floor(value))); }
function missing(error: unknown, table: string) { return String(error).includes(`no such table: ${table}`); }
