import {
  evaluateFinancialStatutoryVerification,
  type FinancialStatutoryVerification,
  type FinancialStatutoryVerificationInput,
  type FinancialStatutoryVerificationOutcome,
  type FinancialStatutoryVerificationProvider,
} from "../domain/financial-statutory-verification";
import type {
  ResearchFinancialBasis,
  ResearchFinancialMetric,
  ResearchFinancialPeriod,
  ResearchFinancialProvenance,
} from "../domain/research-financial-quality";

export type PersistFinancialStatutoryVerificationInput = FinancialStatutoryVerificationInput & {
  verificationId: string;
  createdAt?: number;
};

export type FinancialStatutoryVerificationRecord = FinancialStatutoryVerification & {
  verificationId: string;
  createdAt: number;
};

/**
 * Persists a single immutable comparison observation.  Callers create a new
 * id for a re-extraction or revised filing; previous match/conflict states are
 * intentionally retained rather than silently updated.
 */
export async function recordFinancialStatutoryVerification(
  db: D1Database,
  input: PersistFinancialStatutoryVerificationInput,
): Promise<FinancialStatutoryVerificationRecord> {
  const verificationId = required(input.verificationId, "verificationId");
  const createdAt = input.createdAt ?? Date.now();
  if (!Number.isFinite(createdAt) || createdAt <= 0) throw new Error("createdAt must be a positive timestamp");
  const evaluated = evaluateFinancialStatutoryVerification(input);
  const fact = evaluated.normalizedFact;
  const disclosure = evaluated.statutoryDisclosure;
  await db.prepare(`insert into research_financial_statutory_verifications (
      verification_id, security_code, normalized_fact_id, canonical_comparison_key, metric, period_kind,
      period_start_date, period_end_date, fiscal_year, fiscal_quarter, normalized_value,
      normalized_basis_id, normalized_currency, normalized_accounting_standard, normalized_scope, normalized_revision,
      primary_source_id, primary_source_type, primary_document_id, primary_source_url, primary_locator, primary_published_at,
      statutory_provider, outcome, statutory_value, statutory_basis_id, statutory_currency,
      statutory_accounting_standard, statutory_scope, statutory_revision, statutory_document_id,
      statutory_disclosure_url, statutory_locator, statutory_published_at, statutory_report_date,
      comparison_rule_version, absolute_tolerance, relative_tolerance, absolute_delta, relative_delta,
      reason_codes_json, metadata_json, observed_at, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      verificationId, evaluated.securityCode, fact.id, fact.canonicalComparisonKey, fact.metric, fact.period.kind,
      fact.period.startDate, fact.period.endDate, fact.period.fiscalYear, fact.period.fiscalQuarter ?? null, fact.value,
      fact.basis.id, fact.basis.currency, fact.basis.accountingStandard, fact.basis.scope, fact.basis.revision,
      fact.provenance.sourceId, fact.provenance.sourceType, nullable(fact.provenance.documentId), nullable(fact.provenance.url),
      nullable(fact.provenance.locator), nullable(fact.provenance.publishedAt),
      evaluated.provider, evaluated.outcome, disclosure?.value ?? null, nullable(disclosure?.basis?.id), nullable(disclosure?.basis?.currency),
      nullable(disclosure?.basis?.accountingStandard), nullable(disclosure?.basis?.scope), nullable(disclosure?.basis?.revision),
      nullable(disclosure?.documentId), nullable(disclosure?.disclosureUrl), nullable(disclosure?.locator),
      nullable(disclosure?.publishedAt), nullable(disclosure?.reportDate), evaluated.ruleVersion,
      evaluated.absoluteTolerance, evaluated.relativeTolerance, evaluated.absoluteDelta, evaluated.relativeDelta,
      JSON.stringify(evaluated.reasonCodes), JSON.stringify({ ...evaluated.metadata, statutoryDisclosureMetadata: disclosure?.metadata ?? {} }),
      evaluated.observedAt, createdAt,
    ).run();
  return { ...evaluated, verificationId, createdAt };
}

export async function loadFinancialStatutoryVerifications(
  db: D1Database,
  securityCode: string,
  options: { normalizedFactId?: string; outcome?: FinancialStatutoryVerificationOutcome; limit?: number; offset?: number } = {},
): Promise<FinancialStatutoryVerificationRecord[]> {
  const where = ["security_code=?"];
  const bindings: unknown[] = [required(securityCode, "securityCode")];
  if (options.normalizedFactId) {
    where.push("normalized_fact_id=?");
    bindings.push(required(options.normalizedFactId, "normalizedFactId"));
  }
  if (options.outcome) {
    where.push("outcome=?");
    bindings.push(options.outcome);
  }
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 100), 1), 500);
  const offset = Math.max(Math.floor(options.offset ?? 0), 0);
  const rows = await db.prepare(`select verification_id as verificationId, security_code as securityCode,
      normalized_fact_id as normalizedFactId, canonical_comparison_key as canonicalComparisonKey, metric, period_kind as periodKind,
      period_start_date as periodStartDate, period_end_date as periodEndDate, fiscal_year as fiscalYear,
      fiscal_quarter as fiscalQuarter, normalized_value as normalizedValue,
      normalized_basis_id as normalizedBasisId, normalized_currency as normalizedCurrency,
      normalized_accounting_standard as normalizedAccountingStandard, normalized_scope as normalizedScope,
      normalized_revision as normalizedRevision, primary_source_id as primarySourceId,
      primary_source_type as primarySourceType, primary_document_id as primaryDocumentId,
      primary_source_url as primarySourceUrl, primary_locator as primaryLocator,
      primary_published_at as primaryPublishedAt, statutory_provider as statutoryProvider, outcome,
      statutory_value as statutoryValue, statutory_basis_id as statutoryBasisId,
      statutory_currency as statutoryCurrency, statutory_accounting_standard as statutoryAccountingStandard,
      statutory_scope as statutoryScope, statutory_revision as statutoryRevision,
      statutory_document_id as statutoryDocumentId, statutory_disclosure_url as statutoryDisclosureUrl,
      statutory_locator as statutoryLocator, statutory_published_at as statutoryPublishedAt,
      statutory_report_date as statutoryReportDate, comparison_rule_version as ruleVersion,
      absolute_tolerance as absoluteTolerance, relative_tolerance as relativeTolerance,
      absolute_delta as absoluteDelta, relative_delta as relativeDelta, reason_codes_json as reasonCodesJson,
      metadata_json as metadataJson, observed_at as observedAt, created_at as createdAt
    from research_financial_statutory_verifications where ${where.join(" and ")}
    order by observed_at desc, created_at desc, verification_id desc limit ? offset ?`).bind(...bindings, limit, offset).all<VerificationRow>();
  return rows.results.map(mapRow);
}

type VerificationRow = Record<string, unknown>;

function mapRow(row: VerificationRow): FinancialStatutoryVerificationRecord {
  const basis = (prefix: "normalized" | "statutory"): ResearchFinancialBasis | null => {
    const id = text(row[`${prefix}BasisId`]);
    if (!id) return null;
    return {
      id,
      currency: required(row[`${prefix}Currency`], `${prefix} currency`),
      accountingStandard: required(row[`${prefix}AccountingStandard`], `${prefix} accounting standard`),
      scope: required(row[`${prefix}Scope`], `${prefix} scope`),
      revision: required(row[`${prefix}Revision`], `${prefix} revision`),
    };
  };
  const normalizedBasis = basis("normalized");
  if (!normalizedBasis) throw new Error("stored statutory verification is missing normalized basis");
  const period: ResearchFinancialPeriod = row.periodKind === "quarter"
    ? { kind: "quarter", startDate: required(row.periodStartDate, "period start"), endDate: required(row.periodEndDate, "period end"), fiscalYear: number(row.fiscalYear), fiscalQuarter: number(row.fiscalQuarter) as 1 | 2 | 3 | 4 }
    : { kind: "annual", startDate: required(row.periodStartDate, "period start"), endDate: required(row.periodEndDate, "period end"), fiscalYear: number(row.fiscalYear) };
  const statutoryBasis = basis("statutory");
  const statutoryProvider = row.statutoryProvider as FinancialStatutoryVerificationProvider;
  const disclosure = row.statutoryDocumentId || row.statutoryDisclosureUrl || row.statutoryLocator || row.statutoryValue !== null
    ? {
      provider: statutoryProvider,
      documentId: text(row.statutoryDocumentId), disclosureUrl: text(row.statutoryDisclosureUrl), locator: text(row.statutoryLocator),
      publishedAt: text(row.statutoryPublishedAt), reportDate: text(row.statutoryReportDate), value: nullableNumber(row.statutoryValue), basis: statutoryBasis,
      metadata: parseMetadata(row.metadataJson).statutoryDisclosureMetadata as Record<string, unknown> ?? {},
    }
    : null;
  const metadata = parseMetadata(row.metadataJson);
  delete metadata.statutoryDisclosureMetadata;
  return {
    verificationId: required(row.verificationId, "verificationId"),
    ruleVersion: required(row.ruleVersion, "ruleVersion") as FinancialStatutoryVerification["ruleVersion"],
    securityCode: required(row.securityCode, "securityCode"),
    normalizedFact: {
      id: required(row.normalizedFactId, "normalizedFactId"), canonicalComparisonKey: text(row.canonicalComparisonKey), metric: row.metric as ResearchFinancialMetric, period,
      value: nullableNumber(row.normalizedValue), basis: normalizedBasis,
      provenance: {
        sourceId: required(row.primarySourceId, "primarySourceId"), sourceType: required(row.primarySourceType, "primarySourceType"),
        documentId: text(row.primaryDocumentId) ?? undefined, url: text(row.primarySourceUrl) ?? undefined,
        locator: text(row.primaryLocator) ?? undefined, publishedAt: text(row.primaryPublishedAt) ?? undefined,
      },
    },
    provider: statutoryProvider,
    outcome: row.outcome as FinancialStatutoryVerificationOutcome,
    statutoryDisclosure: disclosure,
    absoluteTolerance: number(row.absoluteTolerance), relativeTolerance: number(row.relativeTolerance),
    absoluteDelta: nullableNumber(row.absoluteDelta), relativeDelta: nullableNumber(row.relativeDelta),
    reasonCodes: parseReasonCodes(row.reasonCodesJson), observedAt: number(row.observedAt), metadata,
    createdAt: number(row.createdAt),
  };
}

function required(value: unknown, label: string): string {
  const result = String(value ?? "").trim();
  if (!result) throw new Error(`${label} is required`);
  return result;
}
function nullable(value: unknown): string | null { const result = String(value ?? "").trim(); return result || null; }
function text(value: unknown): string | null { return nullable(value); }
function number(value: unknown): number { const result = Number(value); if (!Number.isFinite(result)) throw new Error("stored statutory verification number is invalid"); return result; }
function nullableNumber(value: unknown): number | null { return value === null || value === undefined ? null : number(value); }
function parseReasonCodes(value: unknown): string[] { try { const parsed = JSON.parse(String(value ?? "[]")); return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []; } catch { return []; } }
function parseMetadata(value: unknown): Record<string, unknown> { try { const parsed = JSON.parse(String(value ?? "{}")); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; } }
