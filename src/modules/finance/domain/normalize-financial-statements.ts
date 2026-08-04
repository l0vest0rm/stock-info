import type { FinancialStatement, StatementType } from "../../../types";

export type NormalizedFinancialMetric =
  | "revenue"
  | "costOfRevenue"
  | "grossProfit"
  | "operatingIncome"
  | "netIncome"
  | "parentNetIncome"
  | "basicEps"
  | "dilutedEps"
  | "totalAssets"
  | "totalLiabilities"
  | "totalEquity"
  | "cashAndCashEquivalents"
  | "operatingCashFlow"
  | "freeCashFlow"
  | "capitalExpenditure";

export type NormalizedFinancialMetricValue = {
  metric: NormalizedFinancialMetric;
  value: number;
  sourceField: string;
};

/**
 * A small, source-preserving common surface for downstream financial analysis.
 * Values are never synthesized: unavailable inputs simply do not appear in
 * `values`, so callers cannot mistake a missing disclosure for zero.
 */
export type NormalizedFinancialStatement = {
  code: string;
  statementType: StatementType;
  reportDate: string;
  fiscalPeriod: string | null;
  noticeDate: string | null;
  source: string;
  updatedAt: number;
  currency: string | null;
  values: NormalizedFinancialMetricValue[];
};

const METRICS_BY_STATEMENT: Record<StatementType, Array<[NormalizedFinancialMetric, string[]]>> = {
  income: [
    ["revenue", ["TOTAL_OPERATE_INCOME", "OPERATE_INCOME", "totalOperateIncome", "operateIncome"]],
    ["costOfRevenue", ["OPERATE_COST", "TOTAL_OPERATE_COST", "operateCost", "totalOperateCost"]],
    ["grossProfit", ["GROSS_PROFIT", "grossProfit"]],
    ["operatingIncome", ["OPERATE_PROFIT", "operateProfit"]],
    ["netIncome", ["NETPROFIT", "netProfit"]],
    ["parentNetIncome", ["PARENT_NETPROFIT"]],
    ["basicEps", ["BASIC_EPS", "basicEps"]],
    ["dilutedEps", ["DILUTED_EPS", "dilutedEps"]],
  ],
  balance: [
    ["totalAssets", ["TOTAL_ASSETS", "totalAssets", "totaAssets"]],
    ["totalLiabilities", ["TOTAL_LIABILITIES", "totalLiabilities"]],
    ["totalEquity", ["TOTAL_EQUITY", "totalEquity"]],
    ["cashAndCashEquivalents", ["MONETARYFUNDS", "END_CCE", "endCce"]],
  ],
  cashflow: [
    ["operatingCashFlow", ["NETCASH_OPERATE", "netcashOperate"]],
    ["freeCashFlow", ["FREE_CASH_FLOW", "freeCashFlow"]],
    ["capitalExpenditure", ["CONSTRUCT_LONG_ASSET", "capitalExpenditure"]],
    ["cashAndCashEquivalents", ["END_CCE", "endCce"]],
  ],
};

export function normalizeFinancialStatement(row: FinancialStatement): NormalizedFinancialStatement {
  const payload = asRecord(row.payload);
  const values: NormalizedFinancialMetricValue[] = [];
  for (const [metric, candidates] of METRICS_BY_STATEMENT[row.statementType]) {
    const matched = firstFiniteNumber(payload, candidates);
    if (matched) {
      values.push({ metric, value: matched.value, sourceField: matched.sourceField });
    }
  }
  return {
    code: row.code,
    statementType: row.statementType,
    reportDate: row.reportDate,
    fiscalPeriod: row.fiscalPeriod,
    noticeDate: dateValue(payload.NOTICE_DATE ?? payload.noticeDate),
    source: row.source,
    updatedAt: row.updatedAt,
    currency: stringValue(payload.CURRENCY ?? payload.CURRENCY_TYPE ?? payload.currency),
    values,
  };
}

export function normalizeFinancialStatements(rows: FinancialStatement[]): NormalizedFinancialStatement[] {
  return rows.map(normalizeFinancialStatement);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function firstFiniteNumber(
  payload: Record<string, unknown>,
  candidates: string[]
): { value: number; sourceField: string } | null {
  for (const sourceField of candidates) {
    const value = payload[sourceField];
    if (typeof value === "number" && Number.isFinite(value)) {
      return { value, sourceField };
    }
  }
  return null;
}

function dateValue(value: unknown): string | null {
  return typeof value === "string" && value ? value.slice(0, 10) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
