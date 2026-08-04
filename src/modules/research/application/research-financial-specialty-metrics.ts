import { loadResearchFinancialProfile } from "./research-financial-profile";
import { requireConfirmedSecurityCompanyScope } from "./research-company-scope";
import {
  assertResearchFinancialSpecialtyFactVersion,
  researchFinancialSpecialtyMetricConfigVersion,
  resolveResearchFinancialSpecialtyLedger,
  type ResearchFinancialSpecialtyFactVersion,
} from "../domain/research-financial-specialty-metrics";
import type { ResearchInformationEvidenceTargetModule } from "../domain/research-information-evidence";

type Row = Record<string, unknown>;
export type ResearchFinancialSpecialtyFactWrite = {
  expectedSecurityCode: string;
  financialSpecialtyFactId?: string;
  financialProfileId: string;
  evidenceReferenceId: string;
  metricKey: string;
  reportedLabel: string;
  reportedValue: string;
  valueNumber: number;
  unit: string;
  currency?: string | null;
  amountScale?: string | null;
  asOf: string;
  periodLabel: string;
  definitionNote: string;
  comparabilityNote: string;
  recordedBy?: string;
  recordedAt?: number;
};

/** Records one human-normalized specialty source fact.  The exact document
 * chain is copied only from an accepted information-preprocessing reference;
 * callers cannot supply a free-form URL, statement, company, entity type, or
 * source type.  It cannot write a model, scenario, valuation, or decision. */
export async function recordResearchFinancialSpecialtyFact(db: D1Database, input: ResearchFinancialSpecialtyFactWrite): Promise<ResearchFinancialSpecialtyFactVersion> {
  const code = required(input.expectedSecurityCode, "expectedSecurityCode").toUpperCase();
  const scope = await requireConfirmedSecurityCompanyScope(db, code, "financial specialty fact");
  const evidence = await acceptedEvidenceReference(db, input.evidenceReferenceId, code);
  if (!evidence) throw new Error("accepted reusable evidence reference was not found for requested security");
  if (evidence.targetModule !== "financial_specialty" || evidence.targetField !== required(input.metricKey, "metricKey")) {
    throw new Error("accepted evidence target must match the requested financial specialty metric");
  }
  const profile = await loadResearchFinancialProfile(db, code);
  if (profile.status !== "confirmed" || !profile.entityType || !isSpecialtyEntity(profile.entityType)) throw new Error("financial specialty fact requires a confirmed bank, insurer, or broker profile");
  const profileRecord = profile.records.find((item) => item.financialProfileId === required(input.financialProfileId, "financialProfileId") && item.asOf === profile.asOf && item.entityType === profile.entityType);
  if (!profileRecord) throw new Error("financialProfileId must be a current, confirmed source-bound profile record for requested security");
  if (profileRecord.companyId !== scope.companyId) throw new Error("financial specialty fact profile company does not match the confirmed security mapping");
  const now = input.recordedAt ?? Date.now();
  const fact: ResearchFinancialSpecialtyFactVersion = {
    financialSpecialtyFactId: required(input.financialSpecialtyFactId ?? `research-financial-specialty-fact:${crypto.randomUUID()}`, "financialSpecialtyFactId"),
    financialProfileId: profileRecord.financialProfileId, companyId: profileRecord.companyId, securityCode: evidence.securityCode,
    evidenceReferenceId: evidence.evidenceReferenceId, candidateId: evidence.candidateId, candidateReviewId: evidence.candidateReviewId,
    entityType: profile.entityType, metricKey: required(input.metricKey, "metricKey"), reportedLabel: required(input.reportedLabel, "reportedLabel"),
    reportedValue: required(input.reportedValue, "reportedValue"), valueNumber: input.valueNumber, unit: required(input.unit, "unit"),
    currency: optional(input.currency), amountScale: optional(input.amountScale), asOf: required(input.asOf, "asOf"), periodLabel: required(input.periodLabel, "periodLabel"),
    definitionNote: required(input.definitionNote, "definitionNote"), comparabilityNote: required(input.comparabilityNote, "comparabilityNote"),
    statement: evidence.statement, sourceUrl: evidence.sourceUrl, contentUrl: evidence.contentUrl, sourceTitle: evidence.sourceTitle,
    sourceName: evidence.sourceName, publishedAt: evidence.publishedAt, sourceLocator: evidence.sourceLocator,
    metricConfigVersion: researchFinancialSpecialtyMetricConfigVersion(), recordedBy: required(input.recordedBy ?? "local-user", "recordedBy"), recordedAt: now, createdAt: now,
  };
  assertResearchFinancialSpecialtyFactVersion(fact);
  await db.prepare(`insert into research_financial_specialty_fact_versions (
    financial_specialty_fact_id, financial_profile_id, company_id, security_code, evidence_reference_id, candidate_id, candidate_review_id,
    entity_type, metric_key, reported_label, reported_value, value_number, unit, currency, amount_scale, as_of, period_label,
    definition_note, comparability_note, statement, source_url, content_url, source_title, source_name, published_at, source_locator,
    metric_config_version, recorded_by, recorded_at, created_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(fact.financialSpecialtyFactId, fact.financialProfileId, fact.companyId, fact.securityCode, fact.evidenceReferenceId, fact.candidateId, fact.candidateReviewId,
      fact.entityType, fact.metricKey, fact.reportedLabel, fact.reportedValue, fact.valueNumber, fact.unit, fact.currency, fact.amountScale, fact.asOf, fact.periodLabel,
      fact.definitionNote, fact.comparabilityNote, fact.statement, fact.sourceUrl, fact.contentUrl, fact.sourceTitle, fact.sourceName, fact.publishedAt, fact.sourceLocator,
      fact.metricConfigVersion, fact.recordedBy, fact.recordedAt, fact.createdAt).run();
  return fact;
}

export async function loadResearchFinancialSpecialtyLedger(db: D1Database, securityCode: string) {
  const code = required(securityCode, "securityCode").toUpperCase();
  const profile = await loadResearchFinancialProfile(db, code);
  try {
    const rows = await db.prepare(`select financial_specialty_fact_id, financial_profile_id, company_id, security_code, evidence_reference_id,
      candidate_id, candidate_review_id, entity_type, metric_key, reported_label, reported_value, value_number, unit, currency, amount_scale,
      as_of, period_label, definition_note, comparability_note, statement, source_url, content_url, source_title, source_name, published_at,
      source_locator, metric_config_version, recorded_by, recorded_at, created_at
      from research_financial_specialty_fact_versions
      where company_id=(select company_id from research_listed_securities where security_code=?)
      order by as_of desc, recorded_at desc, financial_specialty_fact_id desc`).bind(code).all<Row>();
    const facts = rows.results.map(mapFact);
    return resolveResearchFinancialSpecialtyLedger(profile, facts, facts.length ? "available" : "empty");
  } catch (error) {
    if (missing(error, "research_financial_specialty_fact_versions")) return resolveResearchFinancialSpecialtyLedger(profile, [], "unavailable");
    throw error;
  }
}

type AcceptedEvidence = {
  evidenceReferenceId: string; candidateId: string; candidateReviewId: string; securityCode: string; statement: string;
  targetModule: ResearchInformationEvidenceTargetModule; targetField: string;
  sourceUrl: string | null; contentUrl: string | null; sourceTitle: string | null; sourceName: string | null; publishedAt: string | null; sourceLocator: string;
};
async function acceptedEvidenceReference(db: D1Database, evidenceReferenceId: string, expectedSecurityCode: string): Promise<AcceptedEvidence | null> {
  const row = await db.prepare(`select reference.evidence_reference_id as evidenceReferenceId, reference.candidate_id as candidateId,
      reference.candidate_review_id as candidateReviewId, reference.security_code as securityCode, candidate.statement,
      candidate.target_module as targetModule, candidate.target_field as targetField,
      reference.source_url as sourceUrl, reference.content_url as contentUrl, reference.title as sourceTitle,
      reference.source_name as sourceName, reference.published_at as publishedAt, reference.locator as sourceLocator,
      review.decision as reviewDecision
    from research_reusable_evidence_references reference
    join research_information_evidence_candidates candidate on candidate.candidate_id=reference.candidate_id
    join research_information_evidence_candidate_reviews review on review.candidate_review_id=reference.candidate_review_id
    where reference.evidence_reference_id=? and reference.security_code=?`).bind(required(evidenceReferenceId, "evidenceReferenceId"), expectedSecurityCode).first<Row>();
  if (!row || text(row.reviewDecision) !== "accepted") return null;
  return {
    evidenceReferenceId: text(row.evidenceReferenceId), candidateId: text(row.candidateId), candidateReviewId: text(row.candidateReviewId), securityCode: text(row.securityCode), statement: text(row.statement), targetModule: text(row.targetModule) as ResearchInformationEvidenceTargetModule, targetField: text(row.targetField),
    sourceUrl: optional(row.sourceUrl), contentUrl: optional(row.contentUrl), sourceTitle: optional(row.sourceTitle), sourceName: optional(row.sourceName), publishedAt: optional(row.publishedAt), sourceLocator: text(row.sourceLocator),
  };
}
function mapFact(row: Row): ResearchFinancialSpecialtyFactVersion { return {
  financialSpecialtyFactId: text(row.financial_specialty_fact_id), financialProfileId: text(row.financial_profile_id), companyId: text(row.company_id), securityCode: text(row.security_code), evidenceReferenceId: text(row.evidence_reference_id), candidateId: text(row.candidate_id), candidateReviewId: text(row.candidate_review_id), entityType: text(row.entity_type) as ResearchFinancialSpecialtyFactVersion["entityType"], metricKey: text(row.metric_key), reportedLabel: text(row.reported_label), reportedValue: text(row.reported_value), valueNumber: number(row.value_number), unit: text(row.unit), currency: optional(row.currency), amountScale: optional(row.amount_scale), asOf: text(row.as_of), periodLabel: text(row.period_label), definitionNote: text(row.definition_note), comparabilityNote: text(row.comparability_note), statement: text(row.statement), sourceUrl: optional(row.source_url), contentUrl: optional(row.content_url), sourceTitle: optional(row.source_title), sourceName: optional(row.source_name), publishedAt: optional(row.published_at), sourceLocator: text(row.source_locator), metricConfigVersion: text(row.metric_config_version), recordedBy: text(row.recorded_by), recordedAt: number(row.recorded_at), createdAt: number(row.created_at),
}; }
function isSpecialtyEntity(value: string): value is ResearchFinancialSpecialtyFactVersion["entityType"] { return value === "bank" || value === "insurer" || value === "broker"; }
function required(value: unknown, label: string): string { const result = String(value ?? "").trim(); if (!result) throw new Error(`${label} is required`); return result; }
function text(value: unknown): string { return required(value, "stored financial specialty field"); }
function optional(value: unknown): string | null { const result = String(value ?? "").trim(); return result || null; }
function number(value: unknown): number { const result = Number(value); if (!Number.isFinite(result)) throw new Error("stored financial specialty number is invalid"); return result; }
function missing(error: unknown, table: string): boolean { return String(error).includes(`no such table: ${table}`); }
