import type { ResearchFinancialBasis, ResearchFinancialMetric, ResearchFinancialPeriod } from "./research-financial-quality";

/**
 * Stable link between one structured-provider field and its statutory
 * comparison history.  It deliberately excludes transport/display details
 * such as an upstream array index and `fiscalPeriod`: both have changed in
 * otherwise identical Eastmoney payloads.
 *
 * This is an identity for comparison, not a provider-selection mechanism.
 * The provider remains fixed by the market source policy at collection time.
 */
export function canonicalFinancialComparisonKey(input: {
  source: string;
  securityCode: string;
  statementType: "income" | "balance" | "cashflow";
  metric: ResearchFinancialMetric;
  period: ResearchFinancialPeriod;
  basis: ResearchFinancialBasis;
}): string {
  const source = required(input.source, "source");
  const securityCode = required(input.securityCode, "securityCode").toUpperCase();
  const statementType = required(input.statementType, "statementType");
  const metric = required(input.metric, "metric");
  const period = input.period;
  const basis = input.basis;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(period.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(period.endDate) || period.startDate > period.endDate) {
    throw new Error("financial comparison period is invalid");
  }
  if (period.kind === "quarter" && ![1, 2, 3, 4].includes(period.fiscalQuarter ?? 0)) {
    throw new Error("quarterly financial comparison identity requires fiscalQuarter");
  }
  const basisParts = [basis.id, basis.currency, basis.accountingStandard, basis.scope, basis.revision].map((value) => required(value, "accounting basis"));
  // JSON has an explicit field order here, making the key readable and stable
  // across runtimes without relying on escaping-sensitive delimiters.
  return JSON.stringify({
    v: 1,
    source,
    securityCode,
    statementType,
    metric,
    period: { kind: period.kind, startDate: period.startDate, endDate: period.endDate },
    accountingBasis: { id: basisParts[0], currency: basisParts[1], accountingStandard: basisParts[2], scope: basisParts[3], revision: basisParts[4] },
  });
}

function required(value: string, label: string): string {
  const result = value.trim();
  if (!result) throw new Error(`${label} is required`);
  return result;
}
