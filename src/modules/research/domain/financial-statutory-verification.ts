import {
  classifyResearchSecurity,
  financialSourcePolicyForMarket,
  type FinancialProvider,
} from "./research-identity";
import type {
  ResearchFinancialBasis,
  ResearchFinancialMetric,
  ResearchFinancialPeriod,
  ResearchFinancialProvenance,
  StandardizedResearchFinancialFact,
} from "./research-financial-quality";

export const FINANCIAL_STATUTORY_VERIFICATION_RULE_VERSION = "financial-statutory-verification.v1";

/**
 * A provider is selected solely from the market policy.  `cninfo` and `hkex`
 * are evidence registries for the Eastmoney A/H primary statements; neither
 * is a secondary structured-statement fallback.
 */
export type FinancialStatutoryVerificationProvider = Extract<FinancialProvider, "cninfo" | "hkex" | "sec">;
export type FinancialStatutoryVerificationOutcome = "match" | "conflict" | "unverified";

export type FinancialStatutoryDisclosure = {
  provider: FinancialStatutoryVerificationProvider;
  documentId?: string | null;
  disclosureUrl?: string | null;
  locator?: string | null;
  publishedAt?: string | null;
  reportDate?: string | null;
  value?: number | null;
  basis?: ResearchFinancialBasis | null;
  metadata?: Record<string, unknown>;
};

export type FinancialStatutoryVerificationInput = {
  securityCode: string;
  normalizedFact: StandardizedResearchFinancialFact;
  statutoryDisclosure?: FinancialStatutoryDisclosure | null;
  /**
   * Exact evidence-collection blockers from the selected statutory registry.
   * They remain distinct from this domain layer's comparison outcome reason;
   * for example, a CNINFO `股本` row must not become a generic missing value
   * that conceals that there is intentionally no diluted-share mapping.
   */
  statutoryCollectionReasonCodes?: string[];
  /** A date on which this comparison was actually performed, not the report date. */
  observedAt: number;
  absoluteTolerance?: number;
  relativeTolerance?: number;
  metadata?: Record<string, unknown>;
};

export type FinancialStatutoryVerification = {
  ruleVersion: typeof FINANCIAL_STATUTORY_VERIFICATION_RULE_VERSION;
  securityCode: string;
  normalizedFact: {
    id: string;
    /** Null only for a pre-0076 immutable observation. */
    canonicalComparisonKey: string | null;
    metric: ResearchFinancialMetric;
    period: ResearchFinancialPeriod;
    value: number | null;
    basis: ResearchFinancialBasis;
    provenance: ResearchFinancialProvenance;
  };
  provider: FinancialStatutoryVerificationProvider;
  outcome: FinancialStatutoryVerificationOutcome;
  statutoryDisclosure: FinancialStatutoryDisclosure | null;
  absoluteTolerance: number;
  relativeTolerance: number;
  absoluteDelta: number | null;
  relativeDelta: number | null;
  reasonCodes: string[];
  observedAt: number;
  metadata: Record<string, unknown>;
};

/**
 * Returns the one statutory registry allowed for a security's market.  It is a
 * policy lookup, never a candidate list: callers cannot fall through HKEX to
 * SEC (or the reverse) when a disclosure is missing.
 */
export function statutoryVerificationProviderForSecurity(code: string): FinancialStatutoryVerificationProvider {
  const market = classifyResearchSecurity({ code, instrumentType: "stock" }).market;
  const provider = financialSourcePolicyForMarket(market).verificationProvider;
  if (provider !== "cninfo" && provider !== "hkex" && provider !== "sec") {
    throw new Error(`Statutory financial verification is not implemented for ${market}; policy provider is ${provider}.`);
  }
  return provider;
}

export function evaluateFinancialStatutoryVerification(
  input: FinancialStatutoryVerificationInput,
): FinancialStatutoryVerification {
  const security = classifyResearchSecurity({ code: input.securityCode, instrumentType: "stock" });
  const provider = statutoryVerificationProviderForSecurity(security.code);
  validateFact(input.normalizedFact);
  const absoluteTolerance = nonNegative(input.absoluteTolerance ?? 0, "absoluteTolerance");
  const relativeTolerance = nonNegative(input.relativeTolerance ?? 0, "relativeTolerance");
  if (!Number.isFinite(input.observedAt) || input.observedAt <= 0) throw new Error("observedAt must be a positive timestamp");

  const disclosure = input.statutoryDisclosure ?? null;
  if (disclosure && disclosure.provider !== provider) {
    throw new Error(`Statutory provider ${disclosure.provider} violates ${security.market} policy; only ${provider} is allowed.`);
  }
  if (!disclosure) {
    return unverified(input, provider, absoluteTolerance, relativeTolerance, ["statutory_disclosure_not_collected"]);
  }
  validateDisclosureShape(disclosure);
  if (input.normalizedFact.value === null) {
    return unverified(input, provider, absoluteTolerance, relativeTolerance, ["normalized_fact_value_missing"]);
  }
  if (disclosure.value === null || disclosure.value === undefined) {
    return unverified(input, provider, absoluteTolerance, relativeTolerance, ["statutory_field_value_missing"]);
  }
  if (!disclosure.basis) {
    return unverified(input, provider, absoluteTolerance, relativeTolerance, ["statutory_field_basis_missing"]);
  }
  validateBasis(disclosure.basis, "statutory disclosure");
  if (!hasReproducibleLocator(disclosure)) {
    return unverified(input, provider, absoluteTolerance, relativeTolerance, ["statutory_disclosure_locator_incomplete"]);
  }
  if (!sameBasis(input.normalizedFact.basis, disclosure.basis)) {
    return completed(input, provider, disclosure, absoluteTolerance, relativeTolerance, "conflict", null, null, ["accounting_basis_or_revision_mismatch"]);
  }
  const absoluteDelta = Math.abs(input.normalizedFact.value - disclosure.value);
  const denominator = Math.max(Math.abs(input.normalizedFact.value), Math.abs(disclosure.value));
  const relativeDelta = denominator === 0 ? 0 : absoluteDelta / denominator;
  const outcome = absoluteDelta <= absoluteTolerance || relativeDelta <= relativeTolerance ? "match" : "conflict";
  return completed(
    input,
    provider,
    disclosure,
    absoluteTolerance,
    relativeTolerance,
    outcome,
    absoluteDelta,
    relativeDelta,
    outcome === "match" ? [] : ["statutory_value_outside_tolerance"],
  );
}

function completed(
  input: FinancialStatutoryVerificationInput,
  provider: FinancialStatutoryVerificationProvider,
  disclosure: FinancialStatutoryDisclosure,
  absoluteTolerance: number,
  relativeTolerance: number,
  outcome: "match" | "conflict",
  absoluteDelta: number | null,
  relativeDelta: number | null,
  reasonCodes: string[],
): FinancialStatutoryVerification {
  return {
    ruleVersion: FINANCIAL_STATUTORY_VERIFICATION_RULE_VERSION,
    securityCode: classifyResearchSecurity({ code: input.securityCode, instrumentType: "stock" }).code,
    normalizedFact: factReference(input.normalizedFact),
    provider,
    outcome,
    statutoryDisclosure: disclosure,
    absoluteTolerance,
    relativeTolerance,
    absoluteDelta,
    relativeDelta,
    reasonCodes,
    observedAt: input.observedAt,
    metadata: input.metadata ?? {},
  };
}

function unverified(
  input: FinancialStatutoryVerificationInput,
  provider: FinancialStatutoryVerificationProvider,
  absoluteTolerance: number,
  relativeTolerance: number,
  reasonCodes: string[],
): FinancialStatutoryVerification {
  return {
    ruleVersion: FINANCIAL_STATUTORY_VERIFICATION_RULE_VERSION,
    securityCode: classifyResearchSecurity({ code: input.securityCode, instrumentType: "stock" }).code,
    normalizedFact: factReference(input.normalizedFact),
    provider,
    outcome: "unverified",
    statutoryDisclosure: input.statutoryDisclosure ?? null,
    absoluteTolerance,
    relativeTolerance,
    absoluteDelta: null,
    relativeDelta: null,
    reasonCodes: combinedReasonCodes(input, reasonCodes),
    observedAt: input.observedAt,
    metadata: input.metadata ?? {},
  };
}

function combinedReasonCodes(input: FinancialStatutoryVerificationInput, reasonCodes: string[]): string[] {
  const collection = input.statutoryCollectionReasonCodes ?? [];
  return [...new Set([...reasonCodes, ...collection]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean))];
}

function factReference(fact: StandardizedResearchFinancialFact): FinancialStatutoryVerification["normalizedFact"] {
  return {
    id: fact.id,
    canonicalComparisonKey: requiredComparisonKey(fact.canonicalComparisonKey),
    metric: fact.metric,
    period: fact.period,
    value: fact.value,
    basis: fact.basis,
    provenance: fact.provenance,
  };
}

function validateFact(fact: StandardizedResearchFinancialFact): void {
  if (!fact.id.trim() || !fact.provenance.sourceId.trim() || !fact.provenance.sourceType.trim()) {
    throw new Error("normalized financial fact identity and provenance are required");
  }
  if (fact.value !== null && !Number.isFinite(fact.value)) throw new Error("normalized financial fact value must be finite or null");
  validateBasis(fact.basis, "normalized financial fact");
  if (!validDate(fact.period.startDate) || !validDate(fact.period.endDate) || fact.period.startDate > fact.period.endDate) {
    throw new Error("normalized financial fact period is invalid");
  }
  if (fact.period.kind === "quarter" && ![1, 2, 3, 4].includes(fact.period.fiscalQuarter ?? 0)) {
    throw new Error("quarterly normalized financial fact requires fiscalQuarter");
  }
  requiredComparisonKey(fact.canonicalComparisonKey);
}

function requiredComparisonKey(value: string | undefined): string {
  const result = String(value ?? "").trim();
  if (!result) throw new Error("normalized financial fact canonical comparison key is required");
  return result;
}

function validateDisclosureShape(disclosure: FinancialStatutoryDisclosure): void {
  for (const [label, value] of Object.entries({
    documentId: disclosure.documentId,
    disclosureUrl: disclosure.disclosureUrl,
    locator: disclosure.locator,
    publishedAt: disclosure.publishedAt,
    reportDate: disclosure.reportDate,
  })) {
    if (value !== null && value !== undefined && !String(value).trim()) throw new Error(`statutory ${label} cannot be blank`);
  }
  if (disclosure.value !== null && disclosure.value !== undefined && !Number.isFinite(disclosure.value)) {
    throw new Error("statutory field value must be finite or null");
  }
  if (disclosure.publishedAt && !validDate(disclosure.publishedAt)) throw new Error("statutory publishedAt must be YYYY-MM-DD");
  if (disclosure.reportDate && !validDate(disclosure.reportDate)) throw new Error("statutory reportDate must be YYYY-MM-DD");
}

function validateBasis(basis: ResearchFinancialBasis, label: string): void {
  if (![basis.id, basis.currency, basis.accountingStandard, basis.scope, basis.revision].every((value) => value.trim())) {
    throw new Error(`${label} basis and revision are required`);
  }
}

function hasReproducibleLocator(disclosure: FinancialStatutoryDisclosure): boolean {
  return Boolean(disclosure.documentId?.trim() && disclosure.disclosureUrl?.trim() && disclosure.locator?.trim()
    && disclosure.publishedAt?.trim() && disclosure.reportDate?.trim());
}

function sameBasis(left: ResearchFinancialBasis, right: ResearchFinancialBasis): boolean {
  // Primary providers retain their original labels.  Comparison only accepts
  // a small audited alias set; unknown labels remain different rather than
  // being guessed into compatibility.
  const leftCurrency = canonicalCurrency(left.currency);
  const rightCurrency = canonicalCurrency(right.currency);
  const leftStandard = canonicalAccountingStandard(left.accountingStandard);
  const rightStandard = canonicalAccountingStandard(right.accountingStandard);
  return leftCurrency !== null && leftCurrency === rightCurrency
    && leftStandard !== null && leftStandard === rightStandard
    && left.scope === right.scope
    && left.revision === right.revision;
}

function canonicalCurrency(value: string): "CNY" | "HKD" | "USD" | null {
  const normalized = value.trim().toUpperCase();
  if (["CNY", "RMB", "人民币"].includes(normalized)) return "CNY";
  if (["HKD", "HK$", "港元"].includes(normalized)) return "HKD";
  if (["USD", "US$", "美元"].includes(normalized)) return "USD";
  return null;
}

function canonicalAccountingStandard(value: string): "IFRS" | "CAS" | "US_GAAP" | null {
  const normalized = value.trim().toUpperCase();
  if (["IFRS", "国际会计准则", "国际财务报告准则"].includes(normalized)) return "IFRS";
  if (["CAS", "中国企业会计准则"].includes(normalized)) return "CAS";
  if (["US_GAAP", "US GAAP", "美国通用会计准则"].includes(normalized)) return "US_GAAP";
  return null;
}

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function nonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a finite non-negative number`);
  return value;
}
