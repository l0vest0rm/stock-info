import { calculateReverseDcfFromSecurity, type ReverseDcfSecurityResult } from "./research-valuation";
import { assertAsOf, assertSourceReferences, type ResearchSourceReference } from "./research-dossier";

/** A separately versioned reverse DCF; it is never substituted for a forward model. */
export const REVERSE_DCF_MODEL_ALGORITHM_VERSION = "research-reverse-dcf.v1";

export type ReverseDcfValuationModelVersion = {
  modelVersionId: string;
  companyId: string | null;
  securityCode: string;
  asOf: number;
  status: "draft" | "reviewed" | "superseded";
  valuationCurrency: string;
  amountScale: string;
  securityCurrency: string;
  pricePerSecurity: number;
  priceAsOf: number;
  priceSourceReferences: ResearchSourceReference[];
  dilutedUnderlyingShares: number;
  /** For example `shares` or `million shares`; it fixes the price × shares scale. */
  dilutedSharesScale: string;
  dilutedSharesSourceReferences: ResearchSourceReference[];
  underlyingSharesPerSecurity: number;
  netDebtAtValuation: number;
  netDebtSourceReferences: ResearchSourceReference[];
  fxRateToValuation: number | null;
  fxAsOf: number | null;
  fxSourceReferences: ResearchSourceReference[];
  wacc: number;
  terminalGrowth: number;
  terminalFreeCashFlowMargin: number | null;
  terminalEbitMargin: number | null;
  assumptionSourceReferences: ResearchSourceReference[];
  result: ReverseDcfSecurityResult;
  sourceReferences: ResearchSourceReference[];
  createdAt: number;
};

export type BuildReverseDcfValuationModelInput = Omit<ReverseDcfValuationModelVersion, "result" | "sourceReferences"> & {
  sourceReferences?: ResearchSourceReference[];
};

export function buildReverseDcfValuationModelVersion(input: BuildReverseDcfValuationModelInput): ReverseDcfValuationModelVersion {
  assertAsOf(input.asOf); assertAsOf(input.createdAt); assertAsOf(input.priceAsOf);
  text(input.modelVersionId, "reverse valuation model version id");
  text(input.securityCode, "reverse valuation security code");
  text(input.amountScale, "reverse valuation amount scale");
  const valuationCurrency = currency(input.valuationCurrency, "reverse valuation currency");
  const securityCurrency = currency(input.securityCurrency, "reverse valuation security currency");
  observed(input.priceSourceReferences, "stated security price");
  text(input.dilutedSharesScale, "diluted underlying share scale");
  observed(input.dilutedSharesSourceReferences, "diluted underlying shares");
  observed(input.netDebtSourceReferences, "net debt at valuation");
  if (valuationCurrency === securityCurrency) {
    if (input.fxRateToValuation !== null || input.fxAsOf !== null || input.fxSourceReferences.length) throw new Error("same-currency reverse valuation must not carry an FX bridge");
  } else {
    if (!Number.isFinite(input.fxRateToValuation) || input.fxRateToValuation! <= 0 || input.fxAsOf === null) throw new Error("cross-currency reverse valuation requires explicit FX rate and asOf");
    assertAsOf(input.fxAsOf);
    observed(input.fxSourceReferences, "FX bridge");
  }
  assertSourceReferences("analysis_assumption", input.assumptionSourceReferences);
  const result = calculateReverseDcfFromSecurity({
    pricePerSecurity: input.pricePerSecurity,
    dilutedUnderlyingShares: input.dilutedUnderlyingShares,
    underlyingSharesPerSecurity: input.underlyingSharesPerSecurity,
    securityCurrency,
    valuationCurrency,
    fxRateToValuation: input.fxRateToValuation,
    netDebtAtValuation: input.netDebtAtValuation,
    wacc: input.wacc,
    terminalGrowth: input.terminalGrowth,
    terminalFreeCashFlowMargin: nullableRate(input.terminalFreeCashFlowMargin, "terminalFreeCashFlowMargin"),
    terminalEbitMargin: nullableRate(input.terminalEbitMargin, "terminalEbitMargin"),
  });
  const sourceReferences = unique([
    ...input.priceSourceReferences,
    ...input.dilutedSharesSourceReferences,
    ...input.netDebtSourceReferences,
    ...input.fxSourceReferences,
    ...input.assumptionSourceReferences,
    ...(input.sourceReferences ?? []),
  ]);
  assertSourceReferences("analysis_assumption", input.sourceReferences ?? []);
  return { ...input, valuationCurrency, securityCurrency, terminalFreeCashFlowMargin: input.terminalFreeCashFlowMargin ?? null, terminalEbitMargin: input.terminalEbitMargin ?? null, result, sourceReferences };
}

function observed(references: ResearchSourceReference[], label: string): void {
  if (!Array.isArray(references) || !references.length) throw new Error(`${label} requires at least one source reference`);
  assertSourceReferences("observed_fact", references);
}
function text(value: string, label: string): string { const result = String(value ?? "").trim(); if (!result) throw new Error(`${label} is required`); return result; }
function currency(value: string, label: string): string { return text(value, label).toUpperCase(); }
function nullableRate(value: number | null, label: string): number | undefined { if (value === null || value === undefined) return undefined; if (!Number.isFinite(value) || value <= 0 || value > 1) throw new Error(`${label} must be between 0 and 100%`); return value; }
function unique(references: ResearchSourceReference[]): ResearchSourceReference[] { const seen = new Set<string>(); return references.filter((reference) => { const key = JSON.stringify(reference); if (seen.has(key)) return false; seen.add(key); return true; }); }
