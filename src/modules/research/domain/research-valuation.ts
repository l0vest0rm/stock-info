export type OperatingForecastYear = {
  fiscalYear: number;
  revenue: number;
  ebitMargin: number;
  taxRate: number;
  depreciationAmortization: number;
  capitalExpenditure: number;
  changeInNetWorkingCapital: number;
};

export type DcfAssumptions = {
  currency: string;
  wacc: number;
  terminalGrowth: number;
  netDebt: number;
  dilutedShares: number;
};

export type DcfYearResult = OperatingForecastYear & {
  ebit: number;
  nopat: number;
  unleveredFreeCashFlow: number;
  discountFactor: number;
  presentValue: number;
};

export type DcfResult = {
  currency: string;
  forecastYears: DcfYearResult[];
  terminalValue: number;
  terminalPresentValue: number;
  enterpriseValue: number;
  equityValue: number;
  valuePerShare: number;
  formula: string;
};

export type ReverseDcfResult = {
  currency: string;
  enterpriseValue: number;
  impliedTerminalUnleveredFreeCashFlow: number;
  impliedTerminalRevenue: number | null;
  impliedTerminalEbitMargin: number | null;
  formula: string;
};

/**
 * Explicit market-security bridge for a reverse DCF.  This boundary is
 * intentionally narrow: callers must supply a dated price, the diluted
 * underlying share count, ADR/depositary ratio, FX and net debt themselves.
 * It never reads a quote, a security master or a financial statement.
 */
export type ReverseDcfSecurityInput = {
  pricePerSecurity: number;
  dilutedUnderlyingShares: number;
  underlyingSharesPerSecurity: number;
  securityCurrency: string;
  valuationCurrency: string;
  /** Number of valuation-currency units for one security-currency unit. */
  fxRateToValuation: number | null;
  netDebtAtValuation: number;
  wacc: number;
  terminalGrowth: number;
  terminalFreeCashFlowMargin?: number;
  /** Conditional only: used with an explicit terminal UFCF margin. */
  terminalEbitMargin?: number;
};

export type ReverseDcfSecurityResult = ReverseDcfResult & {
  pricePerSecurity: number;
  marketCapitalizationInSecurityCurrency: number;
  equityValue: number;
  netDebtAtValuation: number;
  impliedTerminalEbit: number | null;
  securityCurrency: string;
  underlyingSharesPerSecurity: number;
  dilutedUnderlyingShares: number;
};

/**
 * Deterministic company-to-security valuation bridge. All monetary inputs must
 * already be expressed in one currency and one explicit scale. The caller owns
 * any accounting adjustments and FX conversion; this function never guesses.
 */
export function calculateDcf(forecasts: OperatingForecastYear[], assumptions: DcfAssumptions): DcfResult {
  validateAssumptions(assumptions);
  if (!Array.isArray(forecasts) || forecasts.length === 0) throw new Error("at least one forecast year is required");
  const ordered = [...forecasts].sort((left, right) => left.fiscalYear - right.fiscalYear);
  ordered.forEach(validateForecast);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].fiscalYear !== ordered[index - 1].fiscalYear + 1) throw new Error("forecast years must be consecutive");
  }
  const forecastYears = ordered.map((year, index) => {
    const ebit = year.revenue * year.ebitMargin;
    const nopat = ebit * (1 - year.taxRate);
    const unleveredFreeCashFlow = nopat + year.depreciationAmortization - year.capitalExpenditure - year.changeInNetWorkingCapital;
    const discountFactor = 1 / Math.pow(1 + assumptions.wacc, index + 1);
    return { ...year, ebit, nopat, unleveredFreeCashFlow, discountFactor, presentValue: unleveredFreeCashFlow * discountFactor };
  });
  const terminalFreeCashFlow = forecastYears.at(-1)!.unleveredFreeCashFlow * (1 + assumptions.terminalGrowth);
  const terminalValue = terminalFreeCashFlow / (assumptions.wacc - assumptions.terminalGrowth);
  const terminalPresentValue = terminalValue * forecastYears.at(-1)!.discountFactor;
  const enterpriseValue = forecastYears.reduce((sum, year) => sum + year.presentValue, 0) + terminalPresentValue;
  const equityValue = enterpriseValue - assumptions.netDebt;
  return {
    currency: assumptions.currency,
    forecastYears,
    terminalValue,
    terminalPresentValue,
    enterpriseValue,
    equityValue,
    valuePerShare: equityValue / assumptions.dilutedShares,
    formula: "UFCF = EBIT × (1 − tax) + D&A − capex − ΔNWC; EV = ΣPV(UFCF) + PV(UFCF_terminal × (1+g)/(WACC−g)); equity = EV − net debt; per share = equity / diluted shares",
  };
}

/** Calculates the terminal operating requirement implied by an explicit EV. */
export function calculateReverseDcf(input: {
  enterpriseValue: number;
  currency: string;
  wacc: number;
  terminalGrowth: number;
  terminalFreeCashFlowMargin?: number;
  terminalEbitMargin?: number;
}): ReverseDcfResult {
  if (!Number.isFinite(input.enterpriseValue) || input.enterpriseValue <= 0) throw new Error("enterpriseValue must be positive");
  validateWaccGrowth(input.wacc, input.terminalGrowth);
  const impliedTerminalUnleveredFreeCashFlow = input.enterpriseValue * (input.wacc - input.terminalGrowth) / (1 + input.terminalGrowth);
  const margin = optionalPositiveRate(input.terminalFreeCashFlowMargin, "terminalFreeCashFlowMargin");
  const ebitMargin = optionalPositiveRate(input.terminalEbitMargin, "terminalEbitMargin");
  return {
    currency: requiredCurrency(input.currency), enterpriseValue: input.enterpriseValue, impliedTerminalUnleveredFreeCashFlow,
    impliedTerminalRevenue: margin === null ? null : impliedTerminalUnleveredFreeCashFlow / margin,
    impliedTerminalEbitMargin: ebitMargin,
    formula: "Implied terminal UFCF = EV × (WACC − g) / (1 + g); implied revenue is shown only when an explicit terminal UFCF margin is supplied.",
  };
}

/**
 * Converts explicitly supplied market-security facts to the enterprise value
 * required by a reverse DCF.  Unlike a forward DCF this has no forecast
 * schedule: it answers only what terminal cash flow (and, conditionally,
 * revenue/EBIT) the stated market price implies.
 */
export function calculateReverseDcfFromSecurity(input: ReverseDcfSecurityInput): ReverseDcfSecurityResult {
  const valuationCurrency = requiredCurrency(input.valuationCurrency);
  const securityCurrency = requiredCurrency(input.securityCurrency);
  if (!Number.isFinite(input.pricePerSecurity) || input.pricePerSecurity <= 0) throw new Error("pricePerSecurity must be positive");
  if (!Number.isFinite(input.dilutedUnderlyingShares) || input.dilutedUnderlyingShares <= 0) throw new Error("dilutedUnderlyingShares must be positive");
  if (!Number.isFinite(input.underlyingSharesPerSecurity) || input.underlyingSharesPerSecurity <= 0) throw new Error("underlyingSharesPerSecurity must be positive");
  if (!Number.isFinite(input.netDebtAtValuation)) throw new Error("netDebtAtValuation must be finite");
  const fxRate = securityCurrency === valuationCurrency ? 1 : input.fxRateToValuation;
  if (!Number.isFinite(fxRate) || fxRate! <= 0) throw new Error("cross-currency reverse valuation requires an explicit positive FX rate");
  const marketCapitalizationInSecurityCurrency = input.pricePerSecurity * input.dilutedUnderlyingShares / input.underlyingSharesPerSecurity;
  const equityValue = marketCapitalizationInSecurityCurrency * fxRate!;
  const base = calculateReverseDcf({
    enterpriseValue: equityValue + input.netDebtAtValuation,
    currency: valuationCurrency,
    wacc: input.wacc,
    terminalGrowth: input.terminalGrowth,
    terminalFreeCashFlowMargin: input.terminalFreeCashFlowMargin,
    terminalEbitMargin: input.terminalEbitMargin,
  });
  return {
    ...base,
    pricePerSecurity: input.pricePerSecurity,
    marketCapitalizationInSecurityCurrency,
    equityValue,
    netDebtAtValuation: input.netDebtAtValuation,
    impliedTerminalEbit: base.impliedTerminalRevenue === null || base.impliedTerminalEbitMargin === null
      ? null
      : base.impliedTerminalRevenue * base.impliedTerminalEbitMargin,
    securityCurrency,
    underlyingSharesPerSecurity: input.underlyingSharesPerSecurity,
    dilutedUnderlyingShares: input.dilutedUnderlyingShares,
    formula: "Market capitalization = stated security price × diluted underlying shares ÷ underlying shares per security; EV = converted equity value + stated net debt; " + base.formula,
  };
}

export function calculateDcfSensitivity(forecasts: OperatingForecastYear[], assumptions: DcfAssumptions, waccValues: number[], terminalGrowthValues: number[]) {
  if (!waccValues.length || !terminalGrowthValues.length) throw new Error("sensitivity axes cannot be empty");
  return terminalGrowthValues.map((terminalGrowth) => ({ terminalGrowth, values: waccValues.map((wacc) => ({ wacc, result: calculateDcf(forecasts, { ...assumptions, wacc, terminalGrowth }) })) }));
}

function validateForecast(year: OperatingForecastYear) {
  if (!Number.isInteger(year.fiscalYear) || year.fiscalYear < 1900 || year.fiscalYear > 2200) throw new Error("fiscalYear is invalid");
  for (const [label, value] of Object.entries(year)) if (label !== "fiscalYear" && !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  for (const rate of [year.ebitMargin, year.taxRate]) if (rate < -1 || rate > 1) throw new Error("margin and tax rate must be between -100% and 100%");
}
function validateAssumptions(input: DcfAssumptions) {
  requiredCurrency(input.currency); validateWaccGrowth(input.wacc, input.terminalGrowth);
  if (!Number.isFinite(input.netDebt)) throw new Error("netDebt must be finite");
  if (!Number.isFinite(input.dilutedShares) || input.dilutedShares <= 0) throw new Error("dilutedShares must be positive");
}
function validateWaccGrowth(wacc: number, growth: number) {
  if (!Number.isFinite(wacc) || !Number.isFinite(growth) || wacc <= growth) throw new Error("wacc must be greater than terminalGrowth");
  if (wacc <= -1 || growth <= -1) throw new Error("wacc and terminalGrowth must be greater than -100%");
}
function requiredCurrency(value: string) { const currency = String(value || "").trim().toUpperCase(); if (!currency) throw new Error("currency is required"); return currency; }
function optionalPositiveRate(value: number | undefined, label: string) { if (value === undefined || value === null) return null; if (!Number.isFinite(value) || value <= 0 || value > 1) throw new Error(`${label} must be between 0 and 100%`); return value; }
