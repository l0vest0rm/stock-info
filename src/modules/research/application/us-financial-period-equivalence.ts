import { normalizeSecurityCode } from "../../../shared/codes";
import type { StandardizedResearchFinancialFact } from "../domain/research-financial-quality";
import {
  assertUsFinancialPeriodEquivalence,
  type UsFinancialPeriodEquivalence,
  type UsFinancialPeriodEquivalenceWrite,
} from "../domain/us-financial-period-equivalence";

export async function appendUsFinancialPeriodEquivalence(
  db: D1Database,
  rawSecurityCode: string,
  primaryFact: StandardizedResearchFinancialFact,
  input: UsFinancialPeriodEquivalenceWrite,
): Promise<UsFinancialPeriodEquivalence> {
  const securityCode = normalizeSecurityCode(rawSecurityCode);
  const comparisonKey = String(primaryFact.canonicalComparisonKey ?? "").trim();
  if (!comparisonKey || primaryFact.provenance.sourceType !== "yahoo" || !securityCode.endsWith(".US")) {
    throw new Error("period equivalence requires a current Yahoo US primary fact with canonical identity");
  }
  const createdAt = Date.now();
  const record: UsFinancialPeriodEquivalence = {
    ...input, securityCode, primaryComparisonKey: comparisonKey,
    primaryStatementType: statementTypeFromFact(primaryFact), metric: primaryFact.metric,
    primaryPeriod: primaryFact.period, primaryCurrency: primaryFact.basis.currency, createdAt,
  };
  assertUsFinancialPeriodEquivalence(record);
  await db.prepare(`insert into research_us_financial_period_equivalences (
    period_equivalence_id, security_code, primary_comparison_key, primary_statement_type, metric,
    primary_period_kind, primary_period_start_date, primary_period_end_date, primary_currency,
    sec_cik, sec_accession, sec_namespace, sec_concept, sec_unit, sec_period_start_date, sec_period_end_date, sec_form,
    evidence_url, evidence_title, review_decision, review_reason, reviewed_by, reviewed_at, created_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(record.periodEquivalenceId, record.securityCode, record.primaryComparisonKey, record.primaryStatementType, record.metric,
      record.primaryPeriod.kind, record.primaryPeriod.startDate, record.primaryPeriod.endDate, record.primaryCurrency,
      record.secCik, record.secAccession, record.secNamespace, record.secConcept, record.secUnit, record.secPeriodStartDate,
      record.secPeriodEndDate, record.secForm, record.evidenceUrl, record.evidenceTitle, record.reviewDecision, record.reviewReason,
      record.reviewedBy, record.reviewedAt, record.createdAt).run();
  return record;
}

export async function loadUsFinancialPeriodEquivalences(db: D1Database, rawSecurityCode: string) {
  const securityCode = normalizeSecurityCode(rawSecurityCode);
  try {
    const rows = await db.prepare(`select period_equivalence_id as periodEquivalenceId, security_code as securityCode,
      primary_comparison_key as primaryComparisonKey, primary_statement_type as primaryStatementType, metric,
      primary_period_kind as primaryPeriodKind, primary_period_start_date as primaryPeriodStartDate, primary_period_end_date as primaryPeriodEndDate,
      primary_currency as primaryCurrency, sec_cik as secCik, sec_accession as secAccession, sec_namespace as secNamespace,
      sec_concept as secConcept, sec_unit as secUnit, sec_period_start_date as secPeriodStartDate, sec_period_end_date as secPeriodEndDate,
      sec_form as secForm, evidence_url as evidenceUrl, evidence_title as evidenceTitle, review_decision as reviewDecision,
      review_reason as reviewReason, reviewed_by as reviewedBy, reviewed_at as reviewedAt, created_at as createdAt
      from research_us_financial_period_equivalences where security_code=? order by reviewed_at desc, created_at desc`)
      .bind(securityCode).all<Record<string, unknown>>();
    const items = rows.results.map(mapRow);
    return { availability: items.length ? "available" as const : "empty" as const, reason: items.length ? null : "尚无人工审核的 Yahoo—SEC 报告期等价映射；非自然财年不会按相邻日期自动匹配。", items };
  } catch (error) {
    if (/no such table|does not exist|not found/i.test(error instanceof Error ? error.message : String(error))) {
      return { availability: "unavailable" as const, reason: "Yahoo—SEC 报告期等价账本尚未初始化。", items: [] as UsFinancialPeriodEquivalence[] };
    }
    throw error;
  }
}

export async function loadAcceptedUsFinancialPeriodEquivalences(db: D1Database, rawSecurityCode: string): Promise<UsFinancialPeriodEquivalence[]> {
  const result = await loadUsFinancialPeriodEquivalences(db, rawSecurityCode);
  return result.items.filter((item) => item.reviewDecision === "accepted");
}

function statementTypeFromFact(fact: StandardizedResearchFinancialFact): "income" | "balance" | "cashflow" {
  const source = fact.provenance.sourceId.split(":")[2];
  if (source === "income" || source === "balance" || source === "cashflow") return source;
  throw new Error("Yahoo primary fact source identity has no statement type");
}
function mapRow(row: Record<string, unknown>): UsFinancialPeriodEquivalence {
  const primaryPeriod = String(row.primaryPeriodKind) === "quarter"
    ? { kind: "quarter" as const, startDate: text(row.primaryPeriodStartDate), endDate: text(row.primaryPeriodEndDate), fiscalYear: year(row.primaryPeriodEndDate), fiscalQuarter: Math.ceil(Number(text(row.primaryPeriodEndDate).slice(5, 7)) / 3) as 1 | 2 | 3 | 4 }
    : { kind: "annual" as const, startDate: text(row.primaryPeriodStartDate), endDate: text(row.primaryPeriodEndDate), fiscalYear: year(row.primaryPeriodEndDate) };
  const record: UsFinancialPeriodEquivalence = {
    periodEquivalenceId: text(row.periodEquivalenceId), securityCode: text(row.securityCode), primaryComparisonKey: text(row.primaryComparisonKey),
    primaryStatementType: text(row.primaryStatementType) as UsFinancialPeriodEquivalence["primaryStatementType"], metric: text(row.metric) as UsFinancialPeriodEquivalence["metric"],
    primaryPeriod, primaryCurrency: text(row.primaryCurrency), secCik: text(row.secCik), secAccession: text(row.secAccession),
    secNamespace: text(row.secNamespace) as UsFinancialPeriodEquivalence["secNamespace"], secConcept: text(row.secConcept), secUnit: text(row.secUnit),
    secPeriodStartDate: optional(row.secPeriodStartDate), secPeriodEndDate: text(row.secPeriodEndDate), secForm: text(row.secForm) as UsFinancialPeriodEquivalence["secForm"],
    evidenceUrl: text(row.evidenceUrl), evidenceTitle: text(row.evidenceTitle), reviewDecision: text(row.reviewDecision) as UsFinancialPeriodEquivalence["reviewDecision"],
    reviewReason: text(row.reviewReason), reviewedBy: text(row.reviewedBy), reviewedAt: number(row.reviewedAt), createdAt: number(row.createdAt),
  };
  assertUsFinancialPeriodEquivalence(record); return record;
}
function text(value: unknown): string { const result = String(value ?? "").trim(); if (!result) throw new Error("stored period equivalence is incomplete"); return result; }
function optional(value: unknown): string | null { const result = String(value ?? "").trim(); return result || null; }
function number(value: unknown): number { const result = Number(value); if (!Number.isInteger(result) || result <= 0) throw new Error("stored period equivalence timestamp is invalid"); return result; }
function year(value: unknown): number { const result = Number(text(value).slice(0, 4)); if (!Number.isInteger(result)) throw new Error("stored period equivalence date is invalid"); return result; }
