import type { FinancialStatement } from "../../../types";

export type FinancialDataSource = "financial_report" | "performance_report" | "performance_forecast";

type QuarterAccumulator = {
  lastQuarter: number;
  revenue?: number;
  profit?: number;
  eps?: number;
  revenueComplete: boolean;
  profitComplete: boolean;
  epsComplete: boolean;
};

const SOURCE_LABELS: Record<FinancialDataSource, string> = {
  financial_report: "正式财报",
  performance_report: "业绩快报",
  performance_forecast: "业绩预告",
};

export function selectQuarterlyIncomeStatements(
  formalRows: FinancialStatement[],
  performanceRows: Record<string, unknown>[],
  forecastRows: Record<string, unknown>[],
  now = Date.now()
): FinancialStatement[] {
  const formalByDate = latestRowsByDate(formalRows);
  const performanceByDate = latestPayloadRowsByDate(performanceRows);
  const forecastByDate = latestForecastRowsByDate(forecastRows);
  const earliestYear = new Date(now).getUTCFullYear() - 4;
  const reportDates = new Set([...formalByDate.keys(), ...performanceByDate.keys(), ...forecastByDate.keys()]);
  const accumulators = new Map<number, QuarterAccumulator>();
  const selected: FinancialStatement[] = [];

  for (const reportDate of [...reportDates].sort()) {
    const year = Number(reportDate.slice(0, 4));
    const quarter = quarterNumber(reportDate);
    if (!Number.isInteger(year) || year < earliestYear || quarter === null) {
      continue;
    }
    const accumulator = accumulators.get(year) ?? emptyAccumulator();
    const formal = formalByDate.get(reportDate);
    let row: FinancialStatement | null = null;
    if (formal) {
      row = markFormalStatement(formal);
    } else {
      const performance = performanceByDate.get(reportDate);
      if (performance) {
        row = provisionalStatement(
          formalRows[0]?.code ?? String(performance.SECUCODE ?? performance.SECURITY_CODE ?? ""),
          reportDate,
          performance,
          "performance_report",
          accumulator,
          quarter,
          now
        );
      } else {
        const forecast = forecastByDate.get(reportDate);
        if (forecast) {
          row = provisionalStatement(
            formalRows[0]?.code ?? String(forecast.SECUCODE ?? forecast.SECURITY_CODE ?? ""),
            reportDate,
            forecast,
            "performance_forecast",
            accumulator,
            quarter,
            now
          );
        }
      }
    }
    if (!row) {
      continue;
    }
    selected.push(row);
    advanceAccumulator(accumulator, row.payload, quarter);
    accumulators.set(year, accumulator);
  }

  return selected.sort((a, b) => b.reportDate.localeCompare(a.reportDate));
}

export function mergeProvisionalFinancialStatements(
  existingRows: FinancialStatement[],
  incomingPerformanceRows: Record<string, unknown>[],
  incomingForecastRows: Record<string, unknown>[],
  now = Date.now()
): FinancialStatement[] {
  const normalized = ensureFinancialSourceMetadata(existingRows);
  const formalRows = normalized.filter((row) => asRecord(row.payload).dataSource === "financial_report");
  const storedPerformanceRows = normalized
    .filter((row) => asRecord(row.payload).dataSource === "performance_report")
    .map((row) => restoreCumulativePayload(row.payload));
  const storedForecastRows = normalized
    .filter((row) => asRecord(row.payload).dataSource === "performance_forecast")
    .map((row) => asRecord(row.payload));
  return selectQuarterlyIncomeStatements(
    formalRows,
    [...storedPerformanceRows, ...incomingPerformanceRows],
    [...storedForecastRows, ...incomingForecastRows],
    now
  );
}

export function ensureFinancialSourceMetadata(rows: FinancialStatement[]): FinancialStatement[] {
  return rows.map((row) => {
    const payload = asRecord(row.payload);
    if (isFinancialDataSource(payload.dataSource)) {
      if (payload.dataSource !== "financial_report" && payload.NETPROFIT == null && payload.PARENT_NETPROFIT != null) {
        return { ...row, payload: { ...payload, NETPROFIT: payload.PARENT_NETPROFIT } };
      }
      return row;
    }
    return markFormalStatement(row);
  });
}

export function isProvisionalFinancialStatement(row: FinancialStatement | undefined): boolean {
  const source = asRecord(row?.payload).dataSource;
  return source === "performance_report" || source === "performance_forecast";
}

function markFormalStatement(row: FinancialStatement): FinancialStatement {
  return {
    ...row,
    payload: withSource(asRecord(row.payload), "financial_report"),
  };
}

function restoreCumulativePayload(value: unknown): Record<string, unknown> {
  const payload = asRecord(value);
  return {
    ...payload,
    TOTAL_OPERATE_INCOME: payload.cumulativeTotalOperateIncome ?? payload.TOTAL_OPERATE_INCOME,
    PARENT_NETPROFIT: payload.cumulativeParentNetprofit ?? payload.PARENT_NETPROFIT,
    BASIC_EPS: payload.cumulativeBasicEps ?? payload.BASIC_EPS,
  };
}

function provisionalStatement(
  code: string,
  reportDate: string,
  raw: Record<string, unknown>,
  source: Exclude<FinancialDataSource, "financial_report">,
  accumulator: QuarterAccumulator,
  quarter: number,
  now: number
): FinancialStatement | null {
  const cumulativeRevenue = source === "performance_report"
    ? numberValue(raw.TOTAL_OPERATE_INCOME)
    : numberValue(raw.FORECAST_REVENUE_JZ);
  const cumulativeProfit = source === "performance_report"
    ? numberValue(raw.PARENT_NETPROFIT)
    : numberValue(raw.FORECAST_PROFIT_JZ);
  const cumulativeEps = source === "performance_report" ? numberValue(raw.BASIC_EPS) : undefined;
  const revenue = quarterValue(cumulativeRevenue, accumulator.revenue, accumulator.revenueComplete, quarter);
  const profit = quarterValue(cumulativeProfit, accumulator.profit, accumulator.profitComplete, quarter);
  const eps = quarterValue(cumulativeEps, accumulator.eps, accumulator.epsComplete, quarter);
  if (revenue === undefined && profit === undefined && eps === undefined) {
    return null;
  }
  const payload = withSource({
    ...raw,
    REPORT_DATE: reportDate,
    NOTICE_DATE: trimDate(raw.NOTICE_DATE) || reportDate,
    REPORT_TYPE: SOURCE_LABELS[source],
    TOTAL_OPERATE_INCOME: revenue ?? null,
    OPERATE_INCOME: revenue ?? null,
    PARENT_NETPROFIT: profit ?? null,
    NETPROFIT: profit ?? null,
    BASIC_EPS: eps ?? null,
    cumulativeTotalOperateIncome: cumulativeRevenue ?? null,
    cumulativeParentNetprofit: cumulativeProfit ?? null,
    cumulativeBasicEps: cumulativeEps ?? null,
  }, source);
  return {
    code,
    statementType: "income",
    reportDate,
    fiscalPeriod: `${quarter * 3}M`,
    payload,
    source: source === "performance_report" ? "eastmoney_performance" : "eastmoney_forecast",
    rawR2Key: null,
    updatedAt: now,
  };
}

function advanceAccumulator(accumulator: QuarterAccumulator, payloadValue: unknown, quarter: number): void {
  const payload = asRecord(payloadValue);
  const sequential = quarter === 1 || accumulator.lastQuarter === quarter - 1;
  accumulator.revenueComplete = sequential && numberValue(payload.TOTAL_OPERATE_INCOME) !== undefined && (quarter === 1 || accumulator.revenueComplete);
  accumulator.profitComplete = sequential && numberValue(payload.PARENT_NETPROFIT) !== undefined && (quarter === 1 || accumulator.profitComplete);
  accumulator.epsComplete = sequential && numberValue(payload.BASIC_EPS) !== undefined && (quarter === 1 || accumulator.epsComplete);
  accumulator.revenue = accumulator.revenueComplete
    ? (quarter === 1 ? 0 : accumulator.revenue ?? 0) + numberValue(payload.TOTAL_OPERATE_INCOME)!
    : undefined;
  accumulator.profit = accumulator.profitComplete
    ? (quarter === 1 ? 0 : accumulator.profit ?? 0) + numberValue(payload.PARENT_NETPROFIT)!
    : undefined;
  accumulator.eps = accumulator.epsComplete
    ? (quarter === 1 ? 0 : accumulator.eps ?? 0) + numberValue(payload.BASIC_EPS)!
    : undefined;
  accumulator.lastQuarter = quarter;
}

function quarterValue(
  cumulative: number | undefined,
  previousCumulative: number | undefined,
  previousComplete: boolean,
  quarter: number
): number | undefined {
  if (cumulative === undefined) return undefined;
  if (quarter === 1) return cumulative;
  if (!previousComplete || previousCumulative === undefined) return undefined;
  return cumulative - previousCumulative;
}

function latestRowsByDate(rows: FinancialStatement[]): Map<string, FinancialStatement> {
  const result = new Map<string, FinancialStatement>();
  for (const row of rows) {
    if (row.reportDate && !result.has(row.reportDate)) result.set(row.reportDate, row);
  }
  return result;
}

function latestPayloadRowsByDate(rows: Record<string, unknown>[]): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  for (const row of [...rows].sort(compareNoticeDateDesc)) {
    const reportDate = trimDate(row.REPORT_DATE);
    if (reportDate && !result.has(reportDate)) result.set(reportDate, row);
  }
  return result;
}

function latestForecastRowsByDate(rows: Record<string, unknown>[]): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  for (const row of [...rows].sort(compareNoticeDateDesc)) {
    const reportDate = trimDate(row.REPORT_DATE);
    if (reportDate && (row.FORECAST_PROFIT_JZ !== undefined || row.FORECAST_REVENUE_JZ !== undefined)) {
      const current = result.get(reportDate) ?? {};
      result.set(reportDate, { ...current, ...row });
      continue;
    }
    const financeCode = String(row.PREDICT_FINANCE_CODE ?? "");
    if (!reportDate || !["004", "006"].includes(financeCode) || String(row.IS_LATEST ?? "T") === "F") {
      continue;
    }
    const current = result.get(reportDate) ?? {
      SECUCODE: row.SECUCODE,
      SECURITY_CODE: row.SECURITY_CODE,
      REPORT_DATE: row.REPORT_DATE,
      NOTICE_DATE: row.NOTICE_DATE,
    };
    if (financeCode === "004" && current.FORECAST_PROFIT_JZ === undefined) {
      Object.assign(current, row, { FORECAST_PROFIT_JZ: forecastAmount(row) });
    }
    if (financeCode === "006" && current.FORECAST_REVENUE_JZ === undefined) {
      current.FORECAST_REVENUE_JZ = forecastAmount(row);
    }
    result.set(reportDate, current);
  }
  return result;
}

function compareNoticeDateDesc(a: Record<string, unknown>, b: Record<string, unknown>): number {
  return String(b.NOTICE_DATE ?? "").localeCompare(String(a.NOTICE_DATE ?? ""));
}

function forecastAmount(row: Record<string, unknown>): number | undefined {
  const center = numberValue(row.FORECAST_JZ);
  if (center !== undefined) return center;
  const lower = numberValue(row.PREDICT_AMT_LOWER);
  const upper = numberValue(row.PREDICT_AMT_UPPER);
  if (lower !== undefined && upper !== undefined) return (lower + upper) / 2;
  return lower ?? upper;
}

function withSource(payload: Record<string, unknown>, source: FinancialDataSource): Record<string, unknown> {
  return { ...payload, dataSource: source, dataSourceLabel: SOURCE_LABELS[source] };
}

function emptyAccumulator(): QuarterAccumulator {
  return { lastQuarter: 0, revenueComplete: false, profitComplete: false, epsComplete: false };
}

function quarterNumber(reportDate: string): number | null {
  const month = Number(reportDate.slice(5, 7));
  if (month === 3) return 1;
  if (month === 6) return 2;
  if (month === 9) return 3;
  if (month === 12) return 4;
  return null;
}

function numberValue(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const result = typeof value === "number" ? value : Number(String(value).replaceAll(",", ""));
  return Number.isFinite(result) ? result : undefined;
}

function trimDate(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 10) : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function isFinancialDataSource(value: unknown): value is FinancialDataSource {
  return value === "financial_report" || value === "performance_report" || value === "performance_forecast";
}
