import { financialSourcePolicyForMarket, type ResearchMarket } from "./research-identity";
import type { FinancialStatutoryVerificationRecord } from "../application/financial-statutory-verification";
import type { ResearchFinancialMetric, ResearchFinancialPeriod, StandardizedResearchFinancialFact } from "./research-financial-quality";

/**
 * These are the five field-level facts required before the formal-financial
 * gate can pass.  The matrix deliberately follows this narrow contract rather
 * than implying that every line item in a structured provider was verified.
 */
export const REQUIRED_FORMAL_DISCLOSURE_METRICS = [
  "revenue",
  "net_profit",
  "operating_cash_flow",
  "total_equity",
  "diluted_shares",
] as const satisfies readonly ResearchFinancialMetric[];

export type FormalDisclosureRequirementMetric = typeof REQUIRED_FORMAL_DISCLOSURE_METRICS[number];
export type FormalDisclosureCoverageOutcome = "match" | "conflict" | "unverified" | "not_recorded";
export type FormalDisclosureRevisionState = "matched" | "mismatch" | "not_checked" | "primary_conflict";

export type FormalDisclosureCoverageRow = {
  requirement: { metric: FormalDisclosureRequirementMetric; label: string };
  period: ResearchFinancialPeriod | null;
  primary: {
    provider: string;
    status: "available" | "missing";
    facts: Array<Pick<StandardizedResearchFinancialFact, "id" | "value" | "basis" | "provenance">>;
  };
  statutory: {
    provider: string;
    outcome: FormalDisclosureCoverageOutcome;
    verificationId: string | null;
    observedAt: number | null;
    documentUrl: string | null;
    locator: string | null;
    reasonCodes: string[];
    revision: string | null;
    observationCount: number;
  };
  revisionState: FormalDisclosureRevisionState;
  blockers: string[];
};

export type FormalDisclosureCoverageMatrix = {
  policy: { primaryProvider: string; statutoryProvider: string; noAutomaticFallback: true };
  availability: "available" | "empty";
  rows: FormalDisclosureCoverageRow[];
  summary: { match: number; conflict: number; unverified: number; notRecorded: number; missingPrimary: number; revisionMismatch: number; primaryConflict: number };
  reason: string;
};

const labels: Record<FormalDisclosureRequirementMetric, string> = {
  revenue: "营业收入",
  net_profit: "净利润",
  operating_cash_flow: "经营活动现金流",
  total_equity: "所有者权益合计",
  diluted_shares: "稀释后股数",
};

/**
 * A read-only audit view over the current structured facts and immutable
 * statutory comparisons. It never fetches a different provider and never
 * promotes a statutory document into a primary financial statement.
 */
export function buildFormalDisclosureCoverageMatrix(input: {
  market: ResearchMarket;
  facts: StandardizedResearchFinancialFact[];
  verifications: FinancialStatutoryVerificationRecord[];
}): FormalDisclosureCoverageMatrix {
  const policy = financialSourcePolicyForMarket(input.market);
  const requiredFacts = input.facts.filter((fact): fact is StandardizedResearchFinancialFact & { metric: FormalDisclosureRequirementMetric } =>
    REQUIRED_FORMAL_DISCLOSURE_METRICS.includes(fact.metric as FormalDisclosureRequirementMetric),
  );
  const periods = uniquePeriods(requiredFacts.map((fact) => fact.period));
  const rows = periods.length
    ? periods.flatMap((period) => REQUIRED_FORMAL_DISCLOSURE_METRICS.map((metric) => rowFor(metric, period, requiredFacts, input.verifications, policy.primaryProvider, policy.verificationProvider)))
    : REQUIRED_FORMAL_DISCLOSURE_METRICS.map((metric) => rowFor(metric, null, requiredFacts, input.verifications, policy.primaryProvider, policy.verificationProvider));
  const summary = rows.reduce((result, row) => {
    if (row.statutory.outcome === "match") result.match += 1;
    if (row.statutory.outcome === "conflict") result.conflict += 1;
    if (row.statutory.outcome === "unverified") result.unverified += 1;
    if (row.statutory.outcome === "not_recorded") result.notRecorded += 1;
    if (row.primary.status === "missing") result.missingPrimary += 1;
    if (row.revisionState === "mismatch") result.revisionMismatch += 1;
    if (row.revisionState === "primary_conflict") result.primaryConflict += 1;
    return result;
  }, { match: 0, conflict: 0, unverified: 0, notRecorded: 0, missingPrimary: 0, revisionMismatch: 0, primaryConflict: 0 });
  return {
    policy: { primaryProvider: policy.primaryProvider, statutoryProvider: policy.verificationProvider, noAutomaticFallback: true },
    availability: periods.length ? "available" : "empty",
    rows,
    summary,
    reason: periods.length
      ? "每行仅显示当前结构化主源事实与同一规范比较键的法定核验历史；法定文件只作核验，绝不替代主源或自动回退。"
      : "当前主结构化来源没有返回本合同覆盖的报告期；不能以法定文件、零值或其他来源填补。",
  };
}

function rowFor(
  metric: FormalDisclosureRequirementMetric,
  period: ResearchFinancialPeriod | null,
  facts: Array<StandardizedResearchFinancialFact & { metric: FormalDisclosureRequirementMetric }>,
  verifications: FinancialStatutoryVerificationRecord[],
  primaryProvider: string,
  statutoryProvider: string,
): FormalDisclosureCoverageRow {
  const primaryFacts = facts.filter((fact) => fact.metric === metric && (!period || periodKey(fact.period) === periodKey(period)));
  const comparisonKeys = new Set(primaryFacts.map((fact) => fact.canonicalComparisonKey).filter((value): value is string => Boolean(value)));
  const history = verifications
    // Pre-0076 immutable rows have no canonical comparison key. They remain
    // auditable but cannot silently satisfy a current structured-source gate.
    .filter((verification) => verification.provider === statutoryProvider
      && verification.normalizedFact.canonicalComparisonKey !== null
      && comparisonKeys.has(verification.normalizedFact.canonicalComparisonKey))
    .sort((left, right) => right.observedAt - left.observedAt || right.createdAt - left.createdAt);
  const latest = history[0] ?? null;
  const revisions = new Set(primaryFacts.map((fact) => fact.basis.revision));
  const primaryConflict = revisions.size > 1;
  const primaryValueMissing = primaryFacts.some((fact) => fact.value === null);
  const revisionState: FormalDisclosureRevisionState = primaryConflict ? "primary_conflict"
    : !latest?.statutoryDisclosure?.basis ? "not_checked"
      : latest.statutoryDisclosure?.basis?.revision === primaryFacts[0]?.basis.revision ? "matched" : "mismatch";
  const outcome: FormalDisclosureCoverageOutcome = latest?.outcome ?? "not_recorded";
  const blockers = [
    ...(primaryFacts.length ? [] : [period ? "primary_fact_missing_for_report_period" : "primary_fact_not_collected"]),
    ...(primaryValueMissing ? ["primary_fact_value_missing"] : []),
    ...(primaryConflict ? ["primary_revision_conflict"] : []),
    ...(latest ? latest.reasonCodes : ["statutory_verification_not_recorded"]),
    ...(outcome === "conflict" ? ["statutory_conflict"] : []),
    ...(outcome === "unverified" ? ["statutory_unverified"] : []),
    ...(revisionState === "mismatch" ? ["accounting_revision_mismatch"] : []),
  ];
  return {
    requirement: { metric, label: labels[metric] }, period,
    primary: { provider: primaryProvider, status: primaryFacts.length ? "available" : "missing", facts: primaryFacts.map((fact) => ({ id: fact.id, value: fact.value, basis: fact.basis, provenance: fact.provenance })) },
    statutory: {
      provider: statutoryProvider, outcome, verificationId: latest?.verificationId ?? null, observedAt: latest?.observedAt ?? null,
      documentUrl: latest?.statutoryDisclosure?.disclosureUrl ?? null, locator: latest?.statutoryDisclosure?.locator ?? null,
      reasonCodes: latest?.reasonCodes ?? ["statutory_verification_not_recorded"], revision: latest?.statutoryDisclosure?.basis?.revision ?? null,
      observationCount: history.length,
    },
    revisionState,
    blockers: [...new Set(blockers)],
  };
}

function uniquePeriods(periods: ResearchFinancialPeriod[]): ResearchFinancialPeriod[] {
  const seen = new Map<string, ResearchFinancialPeriod>();
  for (const period of periods) seen.set(periodKey(period), period);
  return [...seen.values()].sort((left, right) => periodKey(right).localeCompare(periodKey(left)));
}
function periodKey(period: ResearchFinancialPeriod): string { return `${period.kind}:${period.startDate}:${period.endDate}:${period.fiscalYear}:${period.fiscalQuarter ?? ""}`; }
