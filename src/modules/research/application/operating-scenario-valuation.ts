import type { BuildDcfValuationModelInput, ValuationModelInput } from "../domain/valuation-model-version";
import type { OperatingForecastYear } from "../domain/research-valuation";
import { assertAsOf, assertSourceReferences, type ResearchSourceReference } from "../domain/research-dossier";
import { formalActualModelAnchorBlockReason, type FormalActual } from "../domain/forecast-actual-calibration";

/**
 * A self-built scenario is deliberately a different input boundary from a
 * source forecast or a later actual.  It contains only researcher-chosen
 * operating assumptions plus optional evidence that motivated those choices.
 * The projection below never reads the forecast ledger, an LLM draft, or a
 * financial-statement result.
 */
export type SelfBuiltOperatingScenario = {
  scenarioId: string;
  scenarioName: "downside" | "base" | "upside";
  version: number;
  asOf: number;
  valuationCurrency: string;
  amountScale: string;
  openingRevenue: number;
  openingNetWorkingCapital: number;
  valuation: {
    wacc: number;
    terminalGrowth: number;
    /** Net debt at the valuation as-of date, not a future debt forecast. */
    netDebtAtValuation: number;
    dilutedShares: number;
    sourceReferences?: ResearchSourceReference[];
    netDebtSourceReferences?: ResearchSourceReference[];
    dilutedSharesSourceReferences?: ResearchSourceReference[];
  };
  years: SelfBuiltOperatingScenarioYear[];
  sourceReferences?: ResearchSourceReference[];
};

export type SelfBuiltOperatingScenarioYear = {
  fiscalYear: number;
  revenueGrowth: number;
  ebitMargin: number;
  taxRate: number;
  depreciationAmortizationMargin: number;
  capitalExpenditureMargin: number;
  netWorkingCapitalToRevenue: number;
  /** A disclosed scenario output for deleveraging/leverage review. It is not silently used as as-of net debt. */
  forecastNetDebt: number;
  sourceReferences?: ResearchSourceReference[];
};

export type OperatingScenarioAnnualProjection = OperatingForecastYear & {
  revenueGrowth: number;
  ebit: number;
  nopat: number;
  endingNetWorkingCapital: number;
  forecastNetDebt: number;
  unleveredFreeCashFlow: number;
};

export type OperatingScenarioValuationProjection = {
  scenarioId: string;
  scenarioName: SelfBuiltOperatingScenario["scenarioName"];
  scenarioVersion: number;
  valuationCurrency: string;
  amountScale: string;
  annuals: OperatingScenarioAnnualProjection[];
  operatingForecasts: OperatingForecastYear[];
  valuationInputs: ValuationModelInput[];
  sourceReferences: ResearchSourceReference[];
};

export type OperatingScenarioDcfModelTarget = {
  modelVersionId: string;
  companyId: string | null;
  securityCode: string;
  asOf?: number;
  createdAt?: number;
  status?: "draft" | "reviewed" | "superseded";
  securityCurrency: string;
  fxRateToSecurity: number | null;
  fxAsOf: number | null;
  fxSourceReferences: ResearchSourceReference[];
  underlyingSharesPerSecurity: number;
  /** Extra evidence for the security/rights bridge, never a source forecast. */
  sourceReferences?: ResearchSourceReference[];
};

/**
 * Opt-in bridge from the formal-actual ledger to a self-built model.  It adds
 * an observed-fact input alongside the researcher-owned opening assumption;
 * it never replaces that assumption or changes the scenario projection.
 */
export type FormalActualScenarioModelAnchor = {
  inputKey: "opening_revenue";
  actual: FormalActual;
};

/**
 * Deterministically expands a researcher-owned operating scenario into annual
 * revenue, operating profit, cash-flow, working-capital and debt projections.
 * Forecast debt remains visible in the annual output, while the DCF equity
 * bridge uses the separately declared net debt at the valuation as-of date.
 */
export function projectOperatingScenarioForValuation(input: SelfBuiltOperatingScenario): OperatingScenarioValuationProjection {
  validateScenario(input);
  const sourceReferences = collectReferences(input);
  let priorRevenue = input.openingRevenue;
  let priorNetWorkingCapital = input.openingNetWorkingCapital;
  const annuals = input.years.map((year) => {
    const revenue = priorRevenue * (1 + year.revenueGrowth);
    const ebit = revenue * year.ebitMargin;
    const nopat = ebit * (1 - year.taxRate);
    const depreciationAmortization = revenue * year.depreciationAmortizationMargin;
    const capitalExpenditure = revenue * year.capitalExpenditureMargin;
    const endingNetWorkingCapital = revenue * year.netWorkingCapitalToRevenue;
    const changeInNetWorkingCapital = endingNetWorkingCapital - priorNetWorkingCapital;
    const unleveredFreeCashFlow = nopat + depreciationAmortization - capitalExpenditure - changeInNetWorkingCapital;
    priorRevenue = revenue;
    priorNetWorkingCapital = endingNetWorkingCapital;
    return {
      fiscalYear: year.fiscalYear,
      revenueGrowth: year.revenueGrowth,
      revenue,
      ebitMargin: year.ebitMargin,
      taxRate: year.taxRate,
      depreciationAmortization,
      capitalExpenditure,
      changeInNetWorkingCapital,
      ebit,
      nopat,
      endingNetWorkingCapital,
      forecastNetDebt: year.forecastNetDebt,
      unleveredFreeCashFlow,
    };
  });
  const operatingForecasts = annuals.map(({ revenueGrowth: _revenueGrowth, ebit: _ebit, nopat: _nopat, endingNetWorkingCapital: _endingNetWorkingCapital, forecastNetDebt: _forecastNetDebt, unleveredFreeCashFlow: _unleveredFreeCashFlow, ...forecast }) => forecast);
  return {
    scenarioId: input.scenarioId,
    scenarioName: input.scenarioName,
    scenarioVersion: input.version,
    valuationCurrency: currency(input.valuationCurrency, "scenario valuation currency"),
    amountScale: requiredText(input.amountScale, "scenario amount scale"),
    annuals,
    operatingForecasts,
    valuationInputs: buildValuationInputs(input),
    sourceReferences,
  };
}

/**
 * Creates the payload accepted by the existing immutable DCF model-version
 * writer.  This is intentionally a one-way compilation: a DCF version keeps
 * its full copy of the scenario inputs and never mutates the scenario ledger.
 */
export function buildDcfValuationInputFromOperatingScenario(
  scenario: SelfBuiltOperatingScenario,
  target: OperatingScenarioDcfModelTarget,
): BuildDcfValuationModelInput {
  const projection = projectOperatingScenarioForValuation(scenario);
  const asOf = target.asOf ?? scenario.asOf;
  const createdAt = target.createdAt ?? asOf;
  assertAsOf(asOf);
  assertAsOf(createdAt);
  const securityCode = requiredText(target.securityCode, "valuation security code").toUpperCase();
  const modelVersionId = requiredText(target.modelVersionId, "valuation model version id");
  const targetReferences = target.sourceReferences ?? [];
  assertSourceReferences("analysis_assumption", targetReferences);
  return {
    modelVersionId,
    companyId: target.companyId,
    securityCode,
    asOf,
    createdAt,
    status: target.status ?? "draft",
    valuationCurrency: projection.valuationCurrency,
    amountScale: projection.amountScale,
    securityCurrency: currency(target.securityCurrency, "security currency"),
    fxRateToSecurity: target.fxRateToSecurity,
    fxAsOf: target.fxAsOf,
    fxSourceReferences: target.fxSourceReferences,
    underlyingSharesPerSecurity: target.underlyingSharesPerSecurity,
    inputs: projection.valuationInputs,
    operatingForecasts: projection.operatingForecasts,
    sourceReferences: uniqueReferences([scenarioRecordReference(scenario), ...projection.sourceReferences, ...targetReferences]),
  };
}

/**
 * Compiles an immutable DCF input with explicit filing-backed historical
 * anchors.  Callers must load `actual` from the formal-actual ledger; this
 * compiler intentionally accepts no raw number or source URL substitute.
 */
export function buildDcfValuationInputFromOperatingScenarioWithFormalActualAnchors(
  scenario: SelfBuiltOperatingScenario,
  target: OperatingScenarioDcfModelTarget,
  anchors: FormalActualScenarioModelAnchor[],
): BuildDcfValuationModelInput {
  const input = buildDcfValuationInputFromOperatingScenario(scenario, target);
  if (!Array.isArray(anchors)) throw new Error("formal actual anchors must be an array");
  const seen = new Set<string>();
  const formalInputs = anchors.map((anchor) => buildFormalActualAnchorInput(scenario, target, anchor, seen));
  return {
    ...input,
    inputs: [...input.inputs, ...formalInputs],
    sourceReferences: uniqueReferences([...input.sourceReferences, ...formalInputs.flatMap((item) => item.sourceReferences)]),
  };
}

function buildValuationInputs(input: SelfBuiltOperatingScenario): ValuationModelInput[] {
  const scenarioReferences = input.sourceReferences ?? [];
  const valuationReferences = input.valuation.sourceReferences ?? [];
  const inputs: ValuationModelInput[] = [
    assumption("wacc", "WACC", input.valuation.wacc, "ratio", valuationReferences),
    assumption("terminal_growth", "Terminal growth", input.valuation.terminalGrowth, "ratio", valuationReferences),
    observed("net_debt", "Net debt at valuation as-of", input.valuation.netDebtAtValuation, input.amountScale, input.valuation.netDebtSourceReferences ?? []),
    observed("diluted_shares", "Diluted shares", input.valuation.dilutedShares, "shares", input.valuation.dilutedSharesSourceReferences ?? []),
    assumption("scenario_version", "Self-built operating scenario version", input.version, "version", scenarioReferences),
    assumption("opening_revenue", "Opening revenue", input.openingRevenue, input.amountScale, scenarioReferences),
    assumption("opening_net_working_capital", "Opening net working capital", input.openingNetWorkingCapital, input.amountScale, scenarioReferences),
  ];
  for (const year of input.years) {
    const refs = year.sourceReferences ?? scenarioReferences;
    const prefix = `fy${year.fiscalYear}`;
    inputs.push(
      assumption(`${prefix}_revenue_growth`, `${year.fiscalYear} revenue growth`, year.revenueGrowth, "ratio", refs),
      assumption(`${prefix}_ebit_margin`, `${year.fiscalYear} EBIT margin`, year.ebitMargin, "ratio", refs),
      assumption(`${prefix}_tax_rate`, `${year.fiscalYear} tax rate`, year.taxRate, "ratio", refs),
      assumption(`${prefix}_da_margin`, `${year.fiscalYear} D&A / revenue`, year.depreciationAmortizationMargin, "ratio", refs),
      assumption(`${prefix}_capex_margin`, `${year.fiscalYear} capex / revenue`, year.capitalExpenditureMargin, "ratio", refs),
      assumption(`${prefix}_nwc_to_revenue`, `${year.fiscalYear} NWC / revenue`, year.netWorkingCapitalToRevenue, "ratio", refs),
      assumption(`${prefix}_forecast_net_debt`, `${year.fiscalYear} forecast net debt`, year.forecastNetDebt, input.amountScale, refs),
    );
  }
  return inputs;
}

function buildFormalActualAnchorInput(
  scenario: SelfBuiltOperatingScenario,
  target: OperatingScenarioDcfModelTarget,
  anchor: FormalActualScenarioModelAnchor,
  seen: Set<string>,
): ValuationModelInput {
  if (!anchor || anchor.inputKey !== "opening_revenue") throw new Error("formal actual model anchor inputKey is invalid");
  if (seen.has(anchor.inputKey)) throw new Error(`duplicate formal actual model anchor: ${anchor.inputKey}`);
  seen.add(anchor.inputKey);
  const actual = anchor.actual;
  const targetCode = requiredText(target.securityCode, "valuation security code").toUpperCase();
  if (actual.securityCode !== targetCode) throw new Error("formal actual model anchor must belong to the valuation security");
  const reason = formalActualModelAnchorBlockReason(actual);
  if (reason) throw new Error(`formal actual model anchor is blocked: ${reason}`);
  const firstForecastYear = scenario.years[0]?.fiscalYear;
  const expectedPeriod = `${firstForecastYear - 1}FY`;
  if (actual.metric !== "revenue") throw new Error("opening revenue anchor requires a revenue formal actual");
  if (actual.fiscalPeriod !== expectedPeriod) throw new Error(`opening revenue anchor must use ${expectedPeriod}`);
  if (actual.currency !== scenario.valuationCurrency.trim().toUpperCase()) throw new Error("formal actual model anchor currency must match valuation currency");
  assertSourceReferences("observed_fact", actual.sourceReferences);
  return {
    key: "formal_actual_opening_revenue",
    label: `${actual.fiscalPeriod} filing-backed revenue (model anchor)`,
    value: actual.normalizedValue!,
    unit: actual.normalizedUnit!,
    epistemicType: "observed_fact",
    sourceReferences: uniqueReferences(actual.sourceReferences),
  };
}

function assumption(key: string, label: string, value: number, unit: string, sourceReferences: ResearchSourceReference[]): ValuationModelInput {
  assertSourceReferences("analysis_assumption", sourceReferences);
  return { key, label, value, unit, epistemicType: "analysis_assumption", sourceReferences: uniqueReferences(sourceReferences) };
}
function observed(key: string, label: string, value: number, unit: string, sourceReferences: ResearchSourceReference[]): ValuationModelInput {
  assertSourceReferences("observed_fact", sourceReferences);
  return { key, label, value, unit, epistemicType: "observed_fact", sourceReferences: uniqueReferences(sourceReferences) };
}

function validateScenario(input: SelfBuiltOperatingScenario): void {
  requiredText(input.scenarioId, "operating scenario id");
  if (!["downside", "base", "upside"].includes(input.scenarioName)) throw new Error("operating scenario name is invalid");
  if (!Number.isInteger(input.version) || input.version <= 0) throw new Error("operating scenario version must be a positive integer");
  assertAsOf(input.asOf);
  currency(input.valuationCurrency, "scenario valuation currency");
  requiredText(input.amountScale, "scenario amount scale");
  positive(input.openingRevenue, "opening revenue");
  finite(input.openingNetWorkingCapital, "opening net working capital");
  finite(input.valuation.wacc, "scenario WACC");
  finite(input.valuation.terminalGrowth, "scenario terminal growth");
  if (input.valuation.wacc <= input.valuation.terminalGrowth) throw new Error("scenario WACC must be greater than terminal growth");
  finite(input.valuation.netDebtAtValuation, "net debt at valuation as-of");
  positive(input.valuation.dilutedShares, "diluted shares");
  assertSourceReferences("analysis_assumption", input.sourceReferences ?? []);
  assertSourceReferences("analysis_assumption", input.valuation.sourceReferences ?? []);
  assertSourceReferences("observed_fact", input.valuation.netDebtSourceReferences ?? []);
  assertSourceReferences("observed_fact", input.valuation.dilutedSharesSourceReferences ?? []);
  if (!Array.isArray(input.years) || !input.years.length) throw new Error("operating scenario requires at least one annual assumption");
  input.years.forEach((year, index) => {
    if (!Number.isInteger(year.fiscalYear) || year.fiscalYear < 1900 || year.fiscalYear > 2200) throw new Error("scenario fiscal year is invalid");
    if (index > 0 && year.fiscalYear !== input.years[index - 1].fiscalYear + 1) throw new Error("scenario fiscal years must be consecutive");
    finite(year.revenueGrowth, "scenario revenue growth");
    if (year.revenueGrowth <= -1) throw new Error("scenario revenue growth must be greater than -100%");
    rate(year.ebitMargin, "scenario EBIT margin");
    rate(year.taxRate, "scenario tax rate");
    nonNegative(year.depreciationAmortizationMargin, "scenario D&A margin");
    nonNegative(year.capitalExpenditureMargin, "scenario capex margin");
    finite(year.netWorkingCapitalToRevenue, "scenario NWC to revenue");
    finite(year.forecastNetDebt, "scenario forecast net debt");
    assertSourceReferences("analysis_assumption", year.sourceReferences ?? []);
  });
}

function collectReferences(input: SelfBuiltOperatingScenario): ResearchSourceReference[] {
  return uniqueReferences([
    ...(input.sourceReferences ?? []),
    ...(input.valuation.sourceReferences ?? []),
    ...(input.valuation.netDebtSourceReferences ?? []),
    ...(input.valuation.dilutedSharesSourceReferences ?? []),
    ...input.years.flatMap((year) => year.sourceReferences ?? []),
  ]);
}

function scenarioRecordReference(input: SelfBuiltOperatingScenario): ResearchSourceReference {
  return {
    sourceKind: "research_record",
    sourceId: input.scenarioId,
    title: `Self-built operating scenario: ${input.scenarioName} v${input.version}`,
    publishedAt: input.asOf,
  };
}

function uniqueReferences(references: ResearchSourceReference[]): ResearchSourceReference[] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = JSON.stringify(reference);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function requiredText(value: string, label: string): string { const result = String(value ?? "").trim(); if (!result) throw new Error(`${label} is required`); return result; }
function currency(value: string, label: string): string { return requiredText(value, label).toUpperCase(); }
function finite(value: number, label: string): void { if (!Number.isFinite(value)) throw new Error(`${label} must be finite`); }
function positive(value: number, label: string): void { finite(value, label); if (value <= 0) throw new Error(`${label} must be positive`); }
function nonNegative(value: number, label: string): void { finite(value, label); if (value < 0) throw new Error(`${label} must be non-negative`); }
function rate(value: number, label: string): void { finite(value, label); if (value < -1 || value > 1) throw new Error(`${label} must be between -100% and 100%`); }
