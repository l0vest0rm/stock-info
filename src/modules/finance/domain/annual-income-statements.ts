import type { FinancialStatement } from "../../../types";

/**
 * A source-declared full-year income-statement observation.
 *
 * This is intentionally a selector, not a quarter-to-year calculator.  The
 * three primary feeds use different shapes: Eastmoney A-share has a distinct
 * annual statement family, Eastmoney HK F10 uses cumulative interim rows, and
 * Yahoo can return 3M and 12M values for the same end date.  Summing rows by
 * calendar month silently corrupts at least the latter two cases.
 */
export type AnnualIncomeStatement = {
  fiscalYear: number;
  reportDate: string;
  revenue: number | null;
  netProfit: number | null;
  source: string;
  row: FinancialStatement;
};

/**
 * Select one source-declared FY observation for every fiscal-year end.  Rows
 * with no explicit annual identity remain unavailable instead of being
 * reconstructed from possibly cumulative or incomplete interim data.
 */
export function selectAnnualIncomeStatements(rows: FinancialStatement[]): AnnualIncomeStatement[] {
  const selectedYears = new Set<number>();
  const result: AnnualIncomeStatement[] = [];
  for (const row of [...rows].sort(compareAnnualRows)) {
    if (!isFormalAnnualIncomeStatement(row)) continue;
    const reportDate = statementReportDate(row);
    const fiscalYear = Number(reportDate.slice(0, 4));
    if (!Number.isInteger(fiscalYear) || selectedYears.has(fiscalYear)) continue;
    selectedYears.add(fiscalYear);
    const payload = statementPayload(row);
    result.push({
      fiscalYear,
      reportDate,
      revenue: firstFiniteNumber(payload.TOTAL_OPERATE_INCOME, payload.OPERATE_INCOME, payload.totalOperateIncome, payload.operateIncome),
      netProfit: firstFiniteNumber(
        payload.PARENT_NETPROFIT,
        payload.HOLDER_PROFIT,
        payload.NETPROFIT,
        payload.parentNetprofit,
        payload.netProfit,
      ),
      source: row.source,
      row,
    });
  }
  return result;
}

/**
 * Identifies only a provider's explicit full-year income row.  In particular,
 * a 12-31 Eastmoney `*INCOMEQC` row is Q4, not an annual statement.
 */
export function isFormalAnnualIncomeStatement(row: FinancialStatement): boolean {
  if (row.statementType !== "income" || isProvisional(row)) return false;
  const payload = statementPayload(row);
  const contract = stringValue(payload.FINANCIAL_SOURCE_CONTRACT);
  if (contract === "eastmoney_f10_annual_income.v1") {
    return annualPeriod(payload.FISCAL_PERIOD ?? row.fiscalPeriod);
  }
  if (contract === "eastmoney_hk_f10_main_indicator.v1" || contract === "eastmoney_hk_f10_main_indicator.v2") {
    // HK F10 Q1/H1/9M values are cumulative.  DATE_TYPE_CODE=001 is its FY
    // record and is the only row that may be consumed as an annual actual.
    return stringValue(payload.DATE_TYPE_CODE) === "001";
  }
  if (contract === "yahoo_finance_timeseries.v2" || contract === "yahoo_finance_timeseries.v3") {
    return annualPeriod(payload.FISCAL_PERIOD ?? row.fiscalPeriod);
  }
  // Backward-compatible cache support is deliberately narrow: accept only a
  // source-labelled annual period, never infer FY from a December end date.
  return annualPeriod(payload.FISCAL_PERIOD ?? row.fiscalPeriod ?? payload.REPORT_TYPE);
}

function compareAnnualRows(left: FinancialStatement, right: FinancialStatement): number {
  return statementReportDate(right).localeCompare(statementReportDate(left))
    || Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0)
    || String(right.source).localeCompare(String(left.source));
}

function statementReportDate(row: FinancialStatement): string {
  return stringValue(row.reportDate) || stringValue(statementPayload(row).REPORT_DATE);
}

function statementPayload(row: FinancialStatement): Record<string, unknown> {
  return row.payload && typeof row.payload === "object" ? row.payload as Record<string, unknown> : {};
}

function isProvisional(row: FinancialStatement): boolean {
  const dataSource = stringValue(statementPayload(row).dataSource);
  return dataSource === "performance_report" || dataSource === "performance_forecast"
    || row.source === "eastmoney_performance" || row.source === "eastmoney_forecast";
}

function annualPeriod(value: unknown): boolean {
  return /^(12M|FY|ANNUAL|年报)$/i.test(stringValue(value));
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstFiniteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const parsed = typeof value === "number" ? value : Number(String(value).replaceAll(",", ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}
