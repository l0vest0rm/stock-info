import { loadFinancialStatementReadModel } from "./load-financial-statements";
import { isFormalAnnualIncomeStatement } from "../domain/annual-income-statements";
import type { Bindings, FinancialStatement } from "../../../types";
import type { ExternalHttpOptions } from "../../../shared/http";

type ValuationMetric = "netProfit" | "revenue" | "operatingCashFlow";
export type FinancialValuationSource = "financial_report" | "performance_report" | "performance_forecast";

export type FinancialValuationBasis = {
  reportDate: string;
  noticeDate: string | null;
  source: FinancialValuationSource;
};

export type LatestFinancialValuation = {
  source: "financial-statements";
  peTtm: number | null;
  pb: number | null;
  psTtm: number | null;
  pcfTtm: number | null;
  basis: {
    income: FinancialValuationBasis | null;
    balance: FinancialValuationBasis | null;
    cashflow: FinancialValuationBasis | null;
  };
};

type ValuationEnvironment = Pick<Bindings, "DB" | "MARKET_DATA_BUCKET">;

/**
 * Loads the latest available financial facts and derives current multiples.
 * Price and market capitalization may come from a market-data provider, but
 * its attached valuation fields are deliberately never an input here.
 */
export async function loadLatestFinancialValuation(
  env: ValuationEnvironment,
  code: string,
  marketCapitalization: number | null | undefined,
  options: { availableAt?: Date | string | number; httpOptions?: ExternalHttpOptions } = {},
): Promise<LatestFinancialValuation> {
  const [income, balance, cashflow] = await Promise.all([
    loadFinancialStatementReadModel(env, code, "income", { httpOptions: options.httpOptions }),
    loadFinancialStatementReadModel(env, code, "balance", { httpOptions: options.httpOptions }),
    loadFinancialStatementReadModel(env, code, "cashflow", { httpOptions: options.httpOptions }),
  ]);
  return deriveLatestFinancialValuation({
    marketCapitalization,
    availableAt: options.availableAt,
    incomeRows: income.sourceHealth.status === "failed" ? [] : income.rows,
    balanceRows: balance.sourceHealth.status === "failed" ? [] : balance.rows,
    cashflowRows: cashflow.sourceHealth.status === "failed" ? [] : cashflow.rows,
  });
}

/** Pure counterpart used by every current-valuation consumer and its tests. */
export function deriveLatestFinancialValuation(input: {
  marketCapitalization: number | null | undefined;
  availableAt?: Date | string | number;
  incomeRows: FinancialStatement[];
  balanceRows: FinancialStatement[];
  cashflowRows: FinancialStatement[];
}): LatestFinancialValuation {
  const availableAt = timestamp(input.availableAt) ?? Date.now();
  const incomeRows = effectiveRows(input.incomeRows, availableAt);
  const balanceRows = effectiveRows(input.balanceRows, availableAt);
  const cashflowRows = effectiveRows(input.cashflowRows, availableAt);
  const income = incomeRows[0] ?? null;
  const balance = balanceRows[0] ?? null;
  const cashflow = cashflowRows[0] ?? null;
  const marketCapitalization = finitePositive(input.marketCapitalization);
  const netProfit = trailingTwelveMonths(incomeRows, "netProfit");
  const revenue = trailingTwelveMonths(incomeRows, "revenue");
  const operatingCashFlow = trailingTwelveMonths(cashflowRows, "operatingCashFlow");
  const parentEquity = balance ? firstFinite(payload(balance).TOTAL_PARENT_EQUITY, payload(balance).TOTAL_EQUITY) : null;

  return {
    source: "financial-statements",
    peTtm: quotient(marketCapitalization, netProfit),
    pb: quotient(marketCapitalization, parentEquity),
    psTtm: quotient(marketCapitalization, revenue),
    pcfTtm: quotient(marketCapitalization, operatingCashFlow),
    basis: {
      income: income ? basis(income) : null,
      balance: balance ? basis(balance) : null,
      cashflow: cashflow ? basis(cashflow) : null,
    },
  };
}

function trailingTwelveMonths(rows: FinancialStatement[], metric: ValuationMetric): number | null {
  const latest = rows[0];
  if (!latest) return null;
  const latestDate = reportDate(latest);
  const match = latestDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const monthDay = `${match[2]}-${match[3]}`;
  const latestValue = cumulativeValue(latest, metric);
  if (latestValue === null) return null;

  // A source-declared annual row is already a full trailing-twelve-month flow.
  if (isAnnualFlow(latest) || monthDay === "12-31") {
    return latestValue;
  }
  const previousAnnual = rows.find((row) => reportDate(row) === `${year - 1}-12-31` && isAnnualFlow(row));
  const priorComparable = rows.find((row) => reportDate(row) === `${year - 1}-${monthDay}`);
  const annualValue = previousAnnual ? cumulativeValue(previousAnnual, metric) : null;
  const priorValue = priorComparable ? cumulativeValue(priorComparable, metric) : null;
  if (annualValue === null || priorValue === null) return null;
  return annualValue + latestValue - priorValue;
}

function effectiveRows(rows: FinancialStatement[], availableAt: number): FinancialStatement[] {
  const selected = new Map<string, FinancialStatement>();
  for (const row of rows) {
    const date = reportDate(row);
    if (!date || availableTimestamp(row) > availableAt) continue;
    const current = selected.get(date);
    if (!current || compareCurrentFacts(row, current) < 0) selected.set(date, row);
  }
  return [...selected.values()].sort((left, right) => reportDate(right).localeCompare(reportDate(left)) || compareCurrentFacts(left, right));
}

function compareCurrentFacts(left: FinancialStatement, right: FinancialStatement): number {
  return sourceRank(right) - sourceRank(left)
    || availableTimestamp(right) - availableTimestamp(left)
    || Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0)
    || Number(isAnnualFlow(right)) - Number(isAnnualFlow(left));
}

function sourceRank(row: FinancialStatement): number {
  const source = sourceKind(row);
  return source === "financial_report" ? 3 : source === "performance_report" ? 2 : 1;
}

function sourceKind(row: FinancialStatement): FinancialValuationSource {
  const value = String(payload(row).dataSource ?? "");
  if (value === "performance_report") return "performance_report";
  if (value === "performance_forecast") return "performance_forecast";
  return "financial_report";
}

function isAnnualFlow(row: FinancialStatement): boolean {
  if (row.statementType === "income" && isFormalAnnualIncomeStatement(row)) return true;
  const value = payload(row);
  return /^(12M|FY|ANNUAL|年报)$/i.test(String(row.fiscalPeriod ?? value.FISCAL_PERIOD ?? value.REPORT_TYPE ?? "").trim());
}

function cumulativeValue(row: FinancialStatement, metric: ValuationMetric): number | null {
  const value = payload(row);
  if (metric === "netProfit") {
    return firstFinite(value.cumulativeParentNetprofit, value.PARENT_NETPROFIT, value.HOLDER_PROFIT, value.NETPROFIT, value.parentNetprofit, value.netProfit);
  }
  if (metric === "revenue") {
    return firstFinite(value.cumulativeTotalOperateIncome, value.TOTAL_OPERATE_INCOME, value.OPERATE_INCOME, value.totalOperateIncome, value.operateIncome);
  }
  return firstFinite(value.cumulativeNetcashOperate, value.NETCASH_OPERATE, value.netcashOperate);
}

function basis(row: FinancialStatement): FinancialValuationBasis {
  const value = payload(row);
  return { reportDate: reportDate(row), noticeDate: dateText(value.NOTICE_DATE ?? value.noticeDate), source: sourceKind(row) };
}

function payload(row: FinancialStatement): Record<string, unknown> {
  return row.payload && typeof row.payload === "object" ? row.payload as Record<string, unknown> : {};
}

function reportDate(row: FinancialStatement): string {
  return dateText(row.reportDate ?? payload(row).REPORT_DATE) ?? "";
}

function availableTimestamp(row: FinancialStatement): number {
  return timestamp(payload(row).NOTICE_DATE ?? payload(row).noticeDate ?? reportDate(row)) ?? Number.POSITIVE_INFINITY;
}

function dateText(value: unknown): string | null {
  const result = typeof value === "string" ? value.slice(0, 10) : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(result) ? result : null;
}

function timestamp(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const date = Date.parse(value.length === 10 ? `${value}T23:59:59.999Z` : value);
  return Number.isFinite(date) ? date : null;
}

function firstFinite(...values: unknown[]): number | null {
  for (const value of values) {
    const number = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function finitePositive(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function quotient(numerator: number | null, denominator: number | null): number | null {
  return numerator !== null && denominator !== null && denominator > 0 ? numerator / denominator : null;
}
