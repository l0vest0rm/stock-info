import { calculateDcf, calculateDcfSensitivity, type DcfAssumptions, type DcfResult, type OperatingForecastYear } from "./research-valuation";
import { assertAsOf, assertSourceReferences, type ResearchEpistemicType, type ResearchSourceReference } from "./research-dossier";

export const VALUATION_MODEL_ALGORITHM_VERSION = "research-dcf.v1";

export type ValuationModelInput = {
  key: string;
  label: string;
  value: number;
  unit: string;
  epistemicType: Exclude<ResearchEpistemicType, "user_decision">;
  sourceReferences: ResearchSourceReference[];
};

export type ResearchDcfValuationModelVersion = {
  modelVersionId: string;
  companyId: string | null;
  securityCode: string;
  asOf: number;
  status: "draft" | "reviewed" | "superseded";
  valuationCurrency: string;
  amountScale: string;
  securityCurrency: string;
  fxRateToSecurity: number | null;
  fxAsOf: number | null;
  fxSourceReferences: ResearchSourceReference[];
  underlyingSharesPerSecurity: number;
  inputs: ValuationModelInput[];
  operatingForecasts: OperatingForecastYear[];
  result: DcfResult;
  perSecurityValue: number;
  sensitivity: ReturnType<typeof calculateDcfSensitivity>;
  sourceReferences: ResearchSourceReference[];
  createdAt: number;
};

export type BuildDcfValuationModelInput = Omit<ResearchDcfValuationModelVersion, "result" | "perSecurityValue" | "sensitivity">;

export function buildDcfValuationModelVersion(input: BuildDcfValuationModelInput): ResearchDcfValuationModelVersion {
  assertAsOf(input.asOf);
  assertAsOf(input.createdAt);
  requireText(input.modelVersionId, "valuation model version id");
  requireText(input.securityCode, "valuation security code");
  requireText(input.amountScale, "valuation amount scale");
  const valuationCurrency = currency(input.valuationCurrency, "valuation currency");
  const securityCurrency = currency(input.securityCurrency, "security currency");
  if (!Number.isFinite(input.underlyingSharesPerSecurity) || input.underlyingSharesPerSecurity <= 0) throw new Error("underlyingSharesPerSecurity must be positive");
  if (valuationCurrency === securityCurrency) {
    if (input.fxRateToSecurity !== null || input.fxAsOf !== null || input.fxSourceReferences.length) throw new Error("same-currency valuation must not carry an FX bridge");
  } else {
    if (!Number.isFinite(input.fxRateToSecurity) || input.fxRateToSecurity! <= 0 || input.fxAsOf === null) throw new Error("cross-currency valuation requires an explicit positive FX rate and asOf");
    assertAsOf(input.fxAsOf);
    if (!input.fxSourceReferences.length) throw new Error("cross-currency valuation requires FX source references");
    assertSourceReferences("observed_fact", input.fxSourceReferences);
  }
  if (!input.inputs.length) throw new Error("valuation model requires classified inputs");
  const byKey = new Map<string, ValuationModelInput>();
  for (const item of input.inputs) {
    requireText(item.key, "valuation input key"); requireText(item.label, "valuation input label"); requireText(item.unit, "valuation input unit");
    if (!Number.isFinite(item.value)) throw new Error(`valuation input ${item.key} must be finite`);
    if (byKey.has(item.key)) throw new Error(`duplicate valuation input key ${item.key}`);
    assertSourceReferences(item.epistemicType, item.sourceReferences);
    if (["net_debt", "diluted_shares"].includes(item.key)) {
      if (item.epistemicType !== "observed_fact") throw new Error(`valuation input ${item.key} must be an observed fact`);
      assertSourceReferences("observed_fact", item.sourceReferences);
    }
    byKey.set(item.key, item);
  }
  const assumptions: DcfAssumptions = {
    currency: valuationCurrency,
    wacc: requiredInput(byKey, "wacc").value,
    terminalGrowth: requiredInput(byKey, "terminal_growth").value,
    netDebt: requiredInput(byKey, "net_debt").value,
    dilutedShares: requiredInput(byKey, "diluted_shares").value,
  };
  const result = calculateDcf(input.operatingForecasts, assumptions);
  const perSecurityInValuationCurrency = result.valuePerShare * input.underlyingSharesPerSecurity;
  const perSecurityValue = valuationCurrency === securityCurrency ? perSecurityInValuationCurrency : perSecurityInValuationCurrency * input.fxRateToSecurity!;
  // Keep the full grid mathematically valid even when the selected terminal
  // spread is narrower than one percentage point; a model should not become
  // unsaveable merely because its sensitivity axis was too wide.
  const sensitivityStep = Math.min(0.01, (assumptions.wacc - assumptions.terminalGrowth) / 4);
  const sensitivity = calculateDcfSensitivity(input.operatingForecasts, assumptions,
    [assumptions.wacc - sensitivityStep, assumptions.wacc, assumptions.wacc + sensitivityStep],
    [assumptions.terminalGrowth - sensitivityStep, assumptions.terminalGrowth, assumptions.terminalGrowth + sensitivityStep]);
  assertSourceReferences("analysis_assumption", input.sourceReferences);
  return { ...input, valuationCurrency, securityCurrency, result, perSecurityValue, sensitivity };
}

function requiredInput(inputs: Map<string, ValuationModelInput>, key: string): ValuationModelInput { const item = inputs.get(key); if (!item) throw new Error(`valuation model requires ${key} input`); return item; }
function requireText(value: string, label: string): void { if (!value.trim()) throw new Error(`${label} is required`); }
function currency(value: string, label: string): string { const normalized = value.trim().toUpperCase(); if (!normalized) throw new Error(`${label} is required`); return normalized; }
