import type { ResearchFinancialMetric, ResearchFinancialPeriod, StandardizedResearchFinancialFact } from "./research-financial-quality";

export const US_FINANCIAL_PERIOD_EQUIVALENCE_RULE_VERSION = "us-financial-period-equivalence.v1";

export type UsFinancialPeriodEquivalenceDecision = "accepted" | "rejected";
export type UsFinancialPeriodEquivalence = {
  periodEquivalenceId: string;
  securityCode: string;
  primaryComparisonKey: string;
  primaryStatementType: "income" | "balance" | "cashflow";
  metric: ResearchFinancialMetric;
  primaryPeriod: ResearchFinancialPeriod;
  primaryCurrency: string;
  secCik: string;
  secAccession: string;
  secNamespace: "us-gaap" | "ifrs-full";
  secConcept: string;
  secUnit: string;
  secPeriodStartDate: string | null;
  secPeriodEndDate: string;
  secForm: "10-K" | "10-Q" | "20-F" | "6-K";
  evidenceUrl: string;
  evidenceTitle: string;
  reviewDecision: UsFinancialPeriodEquivalenceDecision;
  reviewReason: string;
  reviewedBy: string;
  reviewedAt: number;
  createdAt: number;
};

export type UsFinancialPeriodEquivalenceWrite = Omit<UsFinancialPeriodEquivalence, "securityCode" | "primaryComparisonKey" | "primaryStatementType" | "metric" | "primaryPeriod" | "primaryCurrency" | "createdAt">;

export function assertUsFinancialPeriodEquivalence(record: UsFinancialPeriodEquivalence): void {
  required(record.periodEquivalenceId, "periodEquivalenceId");
  if (!/^[A-Z0-9._-]+\.US$/.test(record.securityCode)) throw new Error("US financial period equivalence requires a US security code");
  required(record.primaryComparisonKey, "primaryComparisonKey");
  if (!["income", "balance", "cashflow"].includes(record.primaryStatementType)) throw new Error("primaryStatementType is invalid");
  required(record.metric, "metric");
  assertPeriod(record.primaryPeriod, "primaryPeriod");
  if (!/^[A-Z]{3}$/.test(record.primaryCurrency)) throw new Error("primaryCurrency must be ISO currency");
  if (!/^\d{10}$/.test(record.secCik)) throw new Error("secCik must be a zero-padded 10 digit CIK");
  if (!/^\d{10}-\d{2}-\d{6}$/.test(record.secAccession)) throw new Error("secAccession is invalid");
  if (record.secNamespace !== "us-gaap" && record.secNamespace !== "ifrs-full") throw new Error("secNamespace is invalid");
  required(record.secConcept, "secConcept"); required(record.secUnit, "secUnit");
  if (record.secPeriodStartDate !== null) assertDate(record.secPeriodStartDate, "secPeriodStartDate");
  assertDate(record.secPeriodEndDate, "secPeriodEndDate");
  if (record.secPeriodStartDate && record.secPeriodStartDate >= record.secPeriodEndDate) throw new Error("SEC duration period is invalid");
  if (!["10-K", "10-Q", "20-F", "6-K"].includes(record.secForm)) throw new Error("secForm is invalid");
  if (!/^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\//.test(record.evidenceUrl)) throw new Error("evidenceUrl must be an SEC filing archive URL");
  required(record.evidenceTitle, "evidenceTitle");
  if (record.reviewDecision !== "accepted" && record.reviewDecision !== "rejected") throw new Error("reviewDecision is invalid");
  required(record.reviewReason, "reviewReason"); required(record.reviewedBy, "reviewedBy");
  if (!Number.isInteger(record.reviewedAt) || record.reviewedAt <= 0 || !Number.isInteger(record.createdAt) || record.createdAt <= 0) throw new Error("review timestamps are invalid");
}

/** A mapping is usable only after a human explicitly accepted this exact Yahoo fact identity. */
export function acceptedUsFinancialPeriodEquivalenceForFact(
  mappings: readonly UsFinancialPeriodEquivalence[], fact: StandardizedResearchFinancialFact,
): UsFinancialPeriodEquivalence | null {
  const key = String(fact.canonicalComparisonKey ?? "");
  if (!key || fact.provenance.sourceType !== "yahoo") return null;
  const matches = mappings.filter((item) => item.reviewDecision === "accepted"
    && item.primaryComparisonKey === key
    && item.metric === fact.metric
    && item.primaryCurrency === fact.basis.currency
    && samePeriod(item.primaryPeriod, fact.period));
  // More than one accepted review for the same primary fact is an audit
  // conflict, not a license to choose the most recent filing silently.
  return matches.length === 1 ? matches[0] : null;
}

function samePeriod(left: ResearchFinancialPeriod, right: ResearchFinancialPeriod): boolean {
  return left.kind === right.kind && left.startDate === right.startDate && left.endDate === right.endDate;
}
function assertPeriod(period: ResearchFinancialPeriod, label: string): void {
  if (!period || (period.kind !== "annual" && period.kind !== "quarter")) throw new Error(`${label} kind is invalid`);
  assertDate(period.startDate, `${label}.startDate`); assertDate(period.endDate, `${label}.endDate`);
  if (period.startDate > period.endDate) throw new Error(`${label} dates are invalid`);
  if (!Number.isInteger(period.fiscalYear)) throw new Error(`${label}.fiscalYear is invalid`);
  if (period.kind === "quarter" && ![1, 2, 3, 4].includes(period.fiscalQuarter ?? 0)) throw new Error(`${label}.fiscalQuarter is invalid`);
}
function assertDate(value: string, label: string): void { if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} must be YYYY-MM-DD`); }
function required(value: unknown, label: string): string { const result = String(value ?? "").trim(); if (!result) throw new Error(`${label} is required`); return result; }
