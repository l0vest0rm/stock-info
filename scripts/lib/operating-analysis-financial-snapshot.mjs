const text = (value) => typeof value === "string" ? value.trim() : "";
const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;

/**
 * The model receives this compact, source-bound projection, never a finance
 * API response or a raw-provider payload.  It intentionally preserves the
 * report period and only the fields needed for cross-statement reasoning.
 */
export function buildOperatingAnalysisFinancialContext({ income, balance, cashflow }) {
  const incomeRows = compactRows(income, ["TOTAL_OPERATE_INCOME", "OPERATE_INCOME", "OPERATE_COST", "OPERATE_PROFIT", "TOTAL_PROFIT", "NETPROFIT", "PARENT_NETPROFIT", "DEDUCT_PARENT_NETPROFIT", "RESEARCH_EXPENSE", "SALE_EXPENSE", "MANAGE_EXPENSE", "FINANCE_EXPENSE", "ASSET_IMPAIRMENT_LOSS", "CREDIT_IMPAIRMENT_LOSS"]);
  const balanceRows = compactRows(balance, ["MONETARYFUNDS", "ACCOUNTS_RECE", "NOTE_ACCOUNTS_RECE", "INVENTORY", "PREPAYMENT", "CONTRACT_ASSET", "TOTAL_ASSETS", "TOTAL_LIABILITIES", "TOTAL_PARENT_EQUITY", "MINORITY_EQUITY", "SHORT_LOAN", "LONG_LOAN", "BOND_PAYABLE", "NONCURRENT_LIAB_1YEAR", "ACCOUNTS_PAYABLE", "NOTE_ACCOUNTS_PAYABLE", "CONTRACT_LIAB", "FIXED_ASSET", "CIP", "INTANGIBLE_ASSET", "GOODWILL", "LEASE_LIAB"]);
  const cashflowRows = compactRows(cashflow, ["NETCASH_OPERATE", "CONSTRUCT_LONG_ASSET", "NETCASH_INVEST", "NETCASH_FINANCE", "END_CCE", "BEGIN_CCE", "RECEIVE_LOAN_CASH", "PAY_DEBT_CASH", "ASSIGN_DIVIDEND_PORFIT", "BUY_SUBSIDIARY_EQUITY"]);
  const byPeriod = new Map(incomeRows.map((item) => [item.period, item]));
  const cashByPeriod = new Map(cashflowRows.map((item) => [item.period, item]));
  const trend = incomeRows.map((incomeRow) => {
    const cashRow = cashByPeriod.get(incomeRow.period);
    const revenue = pick(incomeRow, "TOTAL_OPERATE_INCOME", "OPERATE_INCOME");
    const cost = pick(incomeRow, "OPERATE_COST");
    const parentNetProfit = pick(incomeRow, "PARENT_NETPROFIT", "NETPROFIT");
    const cfo = pick(cashRow, "NETCASH_OPERATE");
    const capex = pick(cashRow, "CONSTRUCT_LONG_ASSET");
    return compact({ period: incomeRow.period, fiscalPeriod: incomeRow.fiscalPeriod, revenue, grossMargin: ratio(revenue, cost === null ? null : revenue - cost), operatingMargin: ratio(revenue, pick(incomeRow, "OPERATE_PROFIT")), parentNetProfit, netMargin: ratio(revenue, parentNetProfit), operatingCashFlow: cfo, cashConversion: ratio(parentNetProfit, cfo), capitalExpenditure: capex, freeCashFlow: cfo === null || capex === null ? null : cfo - capex });
  });
  const latestBalance = balanceRows[0] || null;
  return {
    descriptor: descriptor(income, balance, cashflow),
    operatingTrend: trend.slice(0, 8),
    financialAnalysis: {
      incomeStatement: incomeRows.slice(0, 8),
      balanceSheet: balanceRows.slice(0, 6),
      cashFlowStatement: cashflowRows.slice(0, 8),
      deterministicMetrics: trend.slice(0, 8),
      latestBalanceSheetSummary: latestBalance ? compact({ period: latestBalance.period, fiscalPeriod: latestBalance.fiscalPeriod, cash: pick(latestBalance, "MONETARYFUNDS"), receivables: sum(latestBalance, ["ACCOUNTS_RECE", "NOTE_ACCOUNTS_RECE"]), inventory: pick(latestBalance, "INVENTORY"), totalAssets: pick(latestBalance, "TOTAL_ASSETS"), totalLiabilities: pick(latestBalance, "TOTAL_LIABILITIES"), parentEquity: pick(latestBalance, "TOTAL_PARENT_EQUITY"), interestBearingDebt: sum(latestBalance, ["SHORT_LOAN", "LONG_LOAN", "BOND_PAYABLE", "NONCURRENT_LIAB_1YEAR"]), fixedAssets: pick(latestBalance, "FIXED_ASSET"), constructionInProgress: pick(latestBalance, "CIP"), goodwill: pick(latestBalance, "GOODWILL") }) : null,
    },
    valuationSummary: { operatingTrend: trend.slice(0, 5), latestBalanceSheetSummary: latestBalance ? compact({ period: latestBalance.period, cash: pick(latestBalance, "MONETARYFUNDS"), interestBearingDebt: sum(latestBalance, ["SHORT_LOAN", "LONG_LOAN", "BOND_PAYABLE", "NONCURRENT_LIAB_1YEAR"]), parentEquity: pick(latestBalance, "TOTAL_PARENT_EQUITY") }) : null },
  };
}

export function financialSnapshotForStage(sharedDescriptor, context, stageKey) {
  if (stageKey === "research_context") return sharedDescriptor;
  if (["company_facts", "industry_structure", "supply_demand_cycle", "competition_peers", "company_operating_drivers"].includes(stageKey)) return sharedDescriptor;
  if (stageKey === "financial_quality") return { ...sharedDescriptor, ...context.financialAnalysis };
  if (stageKey === "market_valuation_facts") return context.marketSnapshot || context.marketValuation || { ...sharedDescriptor, ...context.valuationSummary };
  if (stageKey === "operating_thesis") return { ...sharedDescriptor, operatingTrend: context.operatingTrend };
  if (stageKey === "company_baseline" || stageKey === "industry_validation") return sharedDescriptor;
  if (stageKey === "operating_analysis") return { ...sharedDescriptor, operatingTrend: context.operatingTrend };
  if (stageKey === "financial_analysis") return { ...sharedDescriptor, ...context.financialAnalysis };
  if (stageKey === "valuation_inputs") return { ...sharedDescriptor, ...context.valuationSummary };
  return sharedDescriptor;
}

/** Compact S0 market facts. The stock market source remains Xueqiu-only. */
export function buildOperatingAnalysisMarketSnapshot({ overview, security, asOf } = {}) {
  const value = overview && typeof overview === "object" ? overview : {};
  const securityValue = security && typeof security === "object" ? security : {};
  return {
    asOf: text(value.marketDate) || text(asOf) || null,
    schemaVersion: "market-snapshot.v1",
    source: "xueqiu",
    securityId: text(securityValue.securityId) || null,
    securityCode: text(securityValue.securityCode || securityValue.code) || null,
    listingVenue: text(securityValue.listingVenue || securityValue.venue) || null,
    shareClass: text(securityValue.shareClass) || null,
    tradingCurrency: text(securityValue.tradingCurrency || securityValue.currency) || null,
    price: finite(value.latestPrice),
    marketCapitalization: finite(value.marketCapYi),
    sharesOutstanding: finite(value.sharesOutstanding || value.totalShares),
    rights: securityValue.rights && typeof securityValue.rights === "object" && !Array.isArray(securityValue.rights)
      ? securityValue.rights
      : value.rights && typeof value.rights === "object" && !Array.isArray(value.rights) ? value.rights : null,
    reportedMultiples: { peTtm: finite(value.peTtm), pb: finite(value.pb), psTtm: finite(value.psTtm), pcfTtm: finite(value.pcfTtm) },
    historicalValuation: Array.isArray(value.historicalValuation) ? value.historicalValuation : [],
    qualityIssues: [],
  };
}

/** Deterministic S6 input gate; model output cannot fill these gaps. */
export function validateFinancialQualitySnapshot(snapshot, { entityType = "operating" } = {}) {
  const value = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) ? snapshot : {};
  const gaps = [];
  for (const field of ["asOf", "schemaVersion", "source"]) if (!text(value[field])) gaps.push({ code: `financial_snapshot_${field}_missing`, field, blocking: true });
  for (const statement of ["incomeStatement", "balanceSheet", "cashFlowStatement"]) {
    if (!Array.isArray(value[statement]) || value[statement].length === 0) { gaps.push({ code: `${statement}_missing`, field: statement, blocking: true }); continue; }
    value[statement].forEach((row, index) => {
      if (!text(row?.period)) gaps.push({ code: `${statement}_period_missing`, field: `${statement}[${index}].period`, blocking: true });
      if (!text(row?.currency) || !text(row?.unit) || !text(row?.source)) gaps.push({ code: `${statement}_unit_source_missing`, field: `${statement}[${index}]`, blocking: true });
    });
  }
  if (entityType === "financial") return { status: "not_applicable", gaps: [...gaps, { code: "financial_entity_specialty_metrics_not_applicable", field: "entityType", blocking: false }] };
  return { status: gaps.some((gap) => gap.blocking) ? "blocked" : gaps.length ? "partial" : "available", gaps };
}

function descriptor(income, balance, cashflow) {
  const statements = { income, balance, cashflow };
  return {
    asOf: maxTimestamp(Object.values(statements)), schemaVersion: "operating-analysis-financial-snapshot.v1", source: "系统结构化财务接口",
    periods: [...new Set(Object.values(statements).flatMap((statement) => (statement?.rows || []).map((row) => text(row.reportDate)).filter(Boolean)))].sort().reverse().slice(0, 8),
    reportingCurrencies: [...new Set(Object.values(statements).flatMap((statement) => Array.isArray(statement?.reportingCurrencies) ? statement.reportingCurrencies : []).filter(Boolean))],
    qualityIssues: Object.entries(statements).flatMap(([statementType, statement]) => statement?.sourceHealth?.healthy === false ? [`${statementType}: ${text(statement.sourceHealth.message) || "source unavailable"}`] : []),
  };
}
function compactRows(statement, keys) {
  return (statement?.rows || []).slice().sort((left, right) => text(right.reportDate).localeCompare(text(left.reportDate))).slice(0, 8).map((row) => {
    const payload = row?.payload && typeof row.payload === "object" ? row.payload : {};
    return compact({ period: text(row.reportDate), fiscalPeriod: text(row.fiscalPeriod), currency: text(payload.CURRENCY) || null, unit: "reported currency unit", source: text(row.source) || null, values: Object.fromEntries(keys.map((key) => [key, finite(payload[key])]).filter(([, value]) => value !== null)) });
  });
}
function pick(row, ...keys) { for (const key of keys) { const value = finite(row?.values?.[key]); if (value !== null) return value; } return null; }
function sum(row, keys) { const values = keys.map((key) => pick(row, key)).filter((value) => value !== null); return values.length ? values.reduce((total, value) => total + value, 0) : null; }
function ratio(denominator, numerator) { return denominator && numerator !== null ? numerator / denominator : null; }
function compact(value) { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)); }
function maxTimestamp(statements) { const values = statements.map((statement) => text(statement?.dataAsOf)).filter(Boolean); return values.sort().at(-1) || new Date().toISOString(); }
