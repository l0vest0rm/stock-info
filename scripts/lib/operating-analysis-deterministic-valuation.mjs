import { validateScenarioValuationOutput } from "./operating-analysis-scenario-valuation.mjs";

export const DETERMINISTIC_VALUATION_SCHEMA_VERSION = "deterministic-valuation.v1";
export const DETERMINISTIC_VALUATION_FORMULA_VERSION = "deterministic-valuation-formula.v1";
const ROUNDING_DECIMALS = 8;

/**
 * Execute only the numeric requests already confirmed by S9. This function
 * never adds an operating assumption or reads a Markdown artifact.
 */
export function calculateDeterministicValuation({ scenarioOutput, context = {}, allowedIds = {} } = {}) {
  const input = scenarioOutput && typeof scenarioOutput === "object" ? scenarioOutput : {};
  if (isFinancialEntity(context)) return notApplicableResult(input, "DCF/证券桥接口径不适用于金融主体；需要专用资本与资产质量模型");
  if (input.status === "blocked") return blockedResult(input, [{ code: "scenario_valuation_blocked", reason: "S9 is blocked" }]);
  let validated;
  try { validated = validateScenarioValuationOutput(input, { allowedIds }); }
  catch (error) { return blockedResult(input, [{ code: "scenario_valuation_invalid", reason: error instanceof Error ? error.message : String(error) }]); }
  const results = [];
  const blockedItems = [];
  const calculationTrace = [];
  for (const request of validated.valuationCalculationRequest.dcfScenarios || []) {
    try {
      const result = calculateDcfScenario(request);
      results.push(result);
      calculationTrace.push(result.calculationTrace);
    } catch (error) {
      blockedItems.push({ code: "dcf_request_invalid", scenario: request?.scenario || "unknown", reason: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const target of validated.reverseValuationSolveTargets || []) {
    try {
      const result = calculateReverseValuationTarget(target, context);
      results.push(result);
      calculationTrace.push(result.calculationTrace);
    } catch (error) {
      blockedItems.push({ code: "reverse_dcf_request_invalid", scenario: target?.scenario || "unknown", reason: error instanceof Error ? error.message : String(error) });
    }
  }
  const sensitivity = [];
  for (const request of validated.sensitivityRequests || []) {
    try {
      const base = findDcfRequest(validated, request);
      if (!base) throw new Error("sensitivity request has no matching DCF scenario");
      const result = calculateSensitivity(base, request);
      sensitivity.push(result);
      calculationTrace.push(result.calculationTrace);
    } catch (error) {
      blockedItems.push({ code: "sensitivity_request_invalid", scenario: request?.scenario || "unknown", reason: error instanceof Error ? error.message : String(error) });
    }
  }
  const status = results.length === 0 ? "blocked" : blockedItems.length ? "partial" : "complete";
  return {
    schemaVersion: DETERMINISTIC_VALUATION_SCHEMA_VERSION,
    formulaVersion: DETERMINISTIC_VALUATION_FORMULA_VERSION,
    status,
    results,
    sensitivity,
    blockedValuationItems: blockedItems,
    calculationTrace,
    input: { scenarioIds: (validated.scenarios || []).map((scenario) => scenario.scenario), upstreamArtifactIds: validated.usedUpstreamArtifactIds || [], sourceIds: validated.sourceIds || [], claimIds: validated.claimIds || [], evidenceIds: validated.evidenceIds || [] },
    rounding: { mode: "decimal_places", decimals: ROUNDING_DECIMALS },
  };
}

export function calculateDcfScenario(request) {
  const input = validateDcfRequest(request);
  let revenue = input.openingRevenue;
  let netWorkingCapital = input.openingNetWorkingCapital;
  let enterpriseValue = 0;
  const annuals = [];
  for (const [index, year] of input.years.entries()) {
    revenue *= 1 + year.revenueGrowth;
    const ebit = revenue * year.ebitMargin;
    const nopat = ebit * (1 - year.taxRate);
    const depreciationAmortization = revenue * year.depreciationAmortizationMargin;
    const capitalExpenditure = revenue * year.capitalExpenditureMargin;
    const endingNetWorkingCapital = revenue * year.netWorkingCapitalToRevenue;
    const changeInNetWorkingCapital = endingNetWorkingCapital - netWorkingCapital;
    const unleveredFreeCashFlow = nopat + depreciationAmortization - capitalExpenditure - changeInNetWorkingCapital;
    const discountFactor = 1 / ((1 + input.wacc) ** (index + 1));
    const presentValue = unleveredFreeCashFlow * discountFactor;
    enterpriseValue += presentValue;
    annuals.push({ fiscalYear: year.fiscalYear, revenue: round(revenue), ebit: round(ebit), nopat: round(nopat), depreciationAmortization: round(depreciationAmortization), capitalExpenditure: round(capitalExpenditure), endingNetWorkingCapital: round(endingNetWorkingCapital), changeInNetWorkingCapital: round(changeInNetWorkingCapital), unleveredFreeCashFlow: round(unleveredFreeCashFlow), discountFactor: round(discountFactor), presentValue: round(presentValue) });
    netWorkingCapital = endingNetWorkingCapital;
  }
  const terminalFreeCashFlow = annuals.at(-1).unleveredFreeCashFlow * (1 + input.terminalGrowth);
  const terminalValue = terminalFreeCashFlow / (input.wacc - input.terminalGrowth);
  const terminalPresentValue = terminalValue / ((1 + input.wacc) ** input.years.length);
  enterpriseValue += terminalPresentValue;
  const equityValue = enterpriseValue - input.netDebt;
  const result = {
    kind: "dcf",
    scenario: input.scenario,
    currency: input.currency,
    amountScale: input.amountScale,
    annuals,
    terminalFreeCashFlow: round(terminalFreeCashFlow),
    terminalValue: round(terminalValue),
    terminalPresentValue: round(terminalPresentValue),
    enterpriseValue: round(enterpriseValue),
    netDebt: round(input.netDebt),
    equityValue: round(equityValue),
    dilutedShares: round(input.dilutedShares),
    valuePerShare: round(equityValue / input.dilutedShares),
    terminalValueShare: round(terminalPresentValue / enterpriseValue),
    calculationTrace: {
      calculationId: `calculation:${input.scenario}:dcf`, formulaVersion: DETERMINISTIC_VALUATION_FORMULA_VERSION, scenario: input.scenario, currency: input.currency, amountScale: input.amountScale,
      inputFields: ["openingRevenue", "openingNetWorkingCapital", "years[].revenueGrowth", "years[].ebitMargin", "years[].taxRate", "years[].depreciationAmortizationMargin", "years[].capitalExpenditureMargin", "years[].netWorkingCapitalToRevenue", "wacc", "terminalGrowth", "netDebt", "dilutedShares"],
      formulas: { ufcf: "EBIT × (1 − tax) + D&A − capex − ΔNWC", terminalValue: "terminal UFCF × (1 + g) ÷ (WACC − g)", enterpriseValue: "Σ PV(UFCF) + PV(terminal value)", equityValue: "enterprise value − net debt", perShare: "equity value ÷ diluted shares" },
      rounding: { mode: "decimal_places", decimals: ROUNDING_DECIMALS },
    },
  };
  return result;
}

export function calculateReverseValuationTarget(target, context = {}) {
  const input = target && typeof target === "object" ? target : {};
  const scenario = text(input.scenario) || "base";
  const currency = requiredText(input.currency || context?.marketSnapshot?.currency || context?.marketSnapshot?.tradingCurrency, "reverse DCF currency").toUpperCase();
  const amountScale = requiredText(input.amountScale, "reverse DCF amountScale");
  const wacc = finiteNumber(input.wacc, "reverse DCF WACC");
  const terminalGrowth = finiteNumber(input.terminalGrowth, "reverse DCF terminal growth");
  if (wacc <= terminalGrowth) throw new Error("reverse DCF WACC must be greater than terminal growth");
  let enterpriseValue = finite(input.enterpriseValue);
  const netDebt = input.netDebt === undefined || input.netDebt === null ? null : finiteNumber(input.netDebt, "reverse DCF net debt");
  if (enterpriseValue === null) {
    if (netDebt === null) throw new Error("reverse DCF security bridge requires net debt");
    const pricePerSecurity = finiteNumber(input.pricePerSecurity, "reverse DCF pricePerSecurity");
    const dilutedShares = finiteNumber(input.dilutedShares, "reverse DCF dilutedShares");
    const underlyingSharesPerSecurity = finiteNumber(input.underlyingSharesPerSecurity ?? 1, "reverse DCF underlyingSharesPerSecurity");
    if (pricePerSecurity <= 0 || dilutedShares <= 0 || underlyingSharesPerSecurity <= 0) throw new Error("reverse DCF security bridge requires positive price, shares and ratio");
    enterpriseValue = pricePerSecurity * dilutedShares / underlyingSharesPerSecurity + netDebt;
  }
  if (enterpriseValue <= 0) throw new Error("reverse DCF enterpriseValue must be positive");
  const impliedTerminalFreeCashFlow = enterpriseValue * (wacc - terminalGrowth) / (1 + terminalGrowth);
  const terminalMargin = input.terminalFreeCashFlowMargin === undefined || input.terminalFreeCashFlowMargin === null ? null : finiteNumber(input.terminalFreeCashFlowMargin, "reverse DCF terminalFreeCashFlowMargin");
  const impliedTerminalRevenue = terminalMargin === null ? null : impliedTerminalFreeCashFlow / terminalMargin;
  return {
    kind: "reverse_dcf", scenario, currency, amountScale, enterpriseValue: round(enterpriseValue), netDebt: netDebt === null ? null : round(netDebt), impliedTerminalFreeCashFlow: round(impliedTerminalFreeCashFlow), impliedTerminalRevenue: impliedTerminalRevenue === null ? null : round(impliedTerminalRevenue), terminalFreeCashFlowMargin: terminalMargin,
    calculationTrace: { calculationId: `calculation:${scenario}:reverse-dcf`, formulaVersion: DETERMINISTIC_VALUATION_FORMULA_VERSION, inputFields: ["enterpriseValue|pricePerSecurity+dilutedShares+underlyingSharesPerSecurity", "netDebt", "wacc", "terminalGrowth", "terminalFreeCashFlowMargin"], formulas: { enterpriseValue: "price × diluted shares ÷ shares-per-security + net debt", terminalFreeCashFlow: "EV × (WACC − g) ÷ (1 + g)", terminalRevenue: "terminal UFCF ÷ explicit terminal UFCF margin" }, rounding: { mode: "decimal_places", decimals: ROUNDING_DECIMALS } },
  };
}

export function calculateSensitivity(request, sensitivityRequest) {
  const waccValues = numericArray(sensitivityRequest.waccValues, "sensitivity waccValues");
  const terminalGrowthValues = numericArray(sensitivityRequest.terminalGrowthValues, "sensitivity terminalGrowthValues");
  const values = terminalGrowthValues.map((terminalGrowth) => ({ terminalGrowth, values: waccValues.map((wacc) => {
    if (wacc <= terminalGrowth) return { wacc, status: "blocked", reason: "WACC must be greater than terminal growth" };
    const result = calculateDcfScenario({ ...request, wacc, terminalGrowth });
    return { wacc, status: "complete", enterpriseValue: result.enterpriseValue, equityValue: result.equityValue, valuePerShare: result.valuePerShare };
  }) }));
  return { kind: "sensitivity", scenario: request.scenario, currency: request.currency, amountScale: request.amountScale, values, calculationTrace: { calculationId: `calculation:${request.scenario}:sensitivity`, formulaVersion: DETERMINISTIC_VALUATION_FORMULA_VERSION, axes: { waccValues, terminalGrowthValues }, rounding: { mode: "decimal_places", decimals: ROUNDING_DECIMALS } } };
}

function findDcfRequest(output, request) { return output.valuationCalculationRequest.dcfScenarios.find((item) => item.scenario === request.scenario) || null; }
function validateDcfRequest(value) {
  const input = value && typeof value === "object" ? value : {};
  const fields = ["openingRevenue", "openingNetWorkingCapital", "wacc", "terminalGrowth", "netDebt", "dilutedShares"];
  for (const field of fields) finiteNumber(input[field], `DCF ${field}`);
  const currency = requiredText(input.currency, "DCF currency").toUpperCase();
  const amountScale = requiredText(input.amountScale, "DCF amountScale");
  const wacc = Number(input.wacc); const terminalGrowth = Number(input.terminalGrowth);
  if (wacc <= terminalGrowth) throw new Error("DCF WACC must be greater than terminal growth");
  if (Number(input.openingRevenue) <= 0 || Number(input.dilutedShares) <= 0) throw new Error("DCF opening revenue and diluted shares must be positive");
  if (!Array.isArray(input.years) || input.years.length === 0) throw new Error("DCF years are required");
  let previous = null;
  const years = input.years.map((year) => {
    const row = year && typeof year === "object" ? year : {};
    const fiscalYear = Number(row.fiscalYear);
    if (!Number.isInteger(fiscalYear) || (previous !== null && fiscalYear !== previous + 1)) throw new Error("DCF fiscal years must be consecutive");
    previous = fiscalYear;
    const normalized = { fiscalYear };
    for (const field of ["revenueGrowth", "ebitMargin", "taxRate", "depreciationAmortizationMargin", "capitalExpenditureMargin", "netWorkingCapitalToRevenue"]) normalized[field] = finiteNumber(row[field], `DCF ${field}`);
    return normalized;
  });
  return { scenario: text(input.scenario) || "base", openingRevenue: Number(input.openingRevenue), openingNetWorkingCapital: Number(input.openingNetWorkingCapital), wacc, terminalGrowth, netDebt: Number(input.netDebt), dilutedShares: Number(input.dilutedShares), currency, amountScale, years };
}
function blockedResult(input, blockedValuationItems) { return { schemaVersion: DETERMINISTIC_VALUATION_SCHEMA_VERSION, formulaVersion: DETERMINISTIC_VALUATION_FORMULA_VERSION, status: "blocked", results: [], sensitivity: [], blockedValuationItems, calculationTrace: [], input: { sourceIds: input?.sourceIds || [], claimIds: input?.claimIds || [], evidenceIds: input?.evidenceIds || [], upstreamArtifactIds: input?.usedUpstreamArtifactIds || [] }, rounding: { mode: "decimal_places", decimals: ROUNDING_DECIMALS } }; }
function notApplicableResult(input, reason) { return { schemaVersion: DETERMINISTIC_VALUATION_SCHEMA_VERSION, formulaVersion: DETERMINISTIC_VALUATION_FORMULA_VERSION, status: "not_applicable", results: [], sensitivity: [], blockedValuationItems: [{ code: "valuation_not_applicable", reason }], calculationTrace: [], input: { sourceIds: input?.sourceIds || [], claimIds: input?.claimIds || [], evidenceIds: input?.evidenceIds || [], upstreamArtifactIds: input?.usedUpstreamArtifactIds || [] }, rounding: { mode: "decimal_places", decimals: ROUNDING_DECIMALS } }; }
function isFinancialEntity(context) { const value = context && typeof context === "object" ? context : {}; const entityType = text(value.entityType || value.company?.entityType || value.company?.instrumentType).toLowerCase(); return /bank|insurance|insurer|broker|securit|financial|基金|银行|保险|券商/.test(entityType); }
function finite(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }
function finiteNumber(value, label) { const number = finite(value); if (number === null) throw new Error(`${label} must be finite`); return number; }
function numericArray(value, label) { if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be non-empty`); return value.map((item, index) => finiteNumber(item, `${label}[${index}]`)); }
function requiredText(value, label) { const result = text(value); if (!result) throw new Error(`${label} is required`); return result; }
function text(value) { return typeof value === "string" ? value.trim() : ""; }
function round(value) { return Number(Number(value).toFixed(ROUNDING_DECIMALS)); }
