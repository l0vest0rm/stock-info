import { fetchEastmoneyFinance, fetchEastmoneyHongKongFinance, fetchYahooFinance } from "../../../adapters/eastmoney";
import { areFinancialStatementsFresh } from "../../../shared/cache-policy";
import { normalizeSecurityCode } from "../../../shared/codes";
import {
  getFinancialStatementsSnapshot,
  putFinancialStatementsSnapshot,
} from "../../../storage/market-data";
import type { ExternalHttpOptions } from "../../../shared/http";
import type { Bindings, FinancialStatement, StatementType } from "../../../types";
import {
  ensureFinancialSourceMetadata,
  isProvisionalFinancialStatement,
  mergeProvisionalFinancialStatements,
} from "./select-quarterly-income-statements";
import {
  buildFinancialStatementReadModel,
  failedFinancialStatementReadModel,
  type FinancialStatementReadModel,
} from "../domain/financial-read-model";

const PROVISIONAL_FINANCE_TTL_MS = 30 * 60 * 1000;

export async function loadFinancialStatements(
  env: Pick<Bindings, "DB" | "MARKET_DATA_BUCKET">,
  rawCode: string,
  statementType: StatementType,
  options?: { httpOptions?: ExternalHttpOptions }
): Promise<{ code: string; source: "r2" | "eastmoney" | "yahoo"; rows: FinancialStatement[] }> {
  const code = normalizeSecurityCode(rawCode);
  const snapshot = await getFinancialStatementsSnapshot(env, code, statementType);
  const snapshotRows = snapshot ? ensureFinancialSourceMetadata(snapshot.rows) : [];
  const pendingProvisional = statementType === "income" ? snapshot?.provisionalData : undefined;
  // The HK F10 loader now attaches the reporting currency and accounting
  // standard from its own Eastmoney income-summary response.  Older R2
  // snapshots predate that source contract and falsely fall back to the
  // security trading currency (HKD), even where the issuer reports in RMB.
  // They cannot safely feed cross-source statutory verification, so refresh
  // them from the same Eastmoney primary source instead of guessing.
  const hongKongSnapshotNeedsSourceMetadata = isHongKongExchangeCode(code)
    && snapshotRows.length > 0
    && snapshotRows.some((row) => !hasHongKongReportingMetadata(row));
  // The original Yahoo snapshot contract grouped solely by end date and
  // therefore discarded source-reported currency and annual/quarterly period
  // identity. Refresh from Yahoo itself; do not repair it with ADS trading
  // currency or a secondary provider.
  const usSnapshotNeedsSourceMetadata = isUsExchangeCode(code)
    && snapshotRows.length > 0
    && snapshotRows.some((row) => !hasYahooReportingMetadata(row));
  // Old A-share income snapshots contain only the quarterized `*INCOMEQC`
  // family.  A 12-31 QC row is Q4, so it cannot stand in for the annual
  // `*INCOME` primary statement, and without the cumulative family the
  // quarterly series loses every year-to-date value.  Refresh once from
  // Eastmoney rather than relabelling or back-filling cached data.
  const aShareIncomeSnapshotNeedsAnnualSource = isCnExchangeCode(code)
    && statementType === "income"
    && snapshotRows.length > 0
    && (!snapshotRows.some(isEastmoneyAnnualIncomeStatement)
      || !snapshotRows.some(isEastmoneyCumulativeIncomeStatement));
  if (snapshotRows.length > 0 && !hongKongSnapshotNeedsSourceMetadata && !usSnapshotNeedsSourceMetadata && !aShareIncomeSnapshotNeedsAnnualSource) {
    const now = Date.now();
    const latest = snapshotRows[0];
    if (isProvisionalFinancialStatement(latest) && now - latest.updatedAt < PROVISIONAL_FINANCE_TTL_MS) {
      return { code, source: "r2", rows: snapshotRows };
    }
    const unresolvedPending = pendingProvisional
      ? !snapshotRows.some((row) => row.reportDate === pendingProvisional.reportDate)
      : false;
    if (!unresolvedPending && !isProvisionalFinancialStatement(latest) && areFinancialStatementsFresh(snapshotRows, now)) {
      return { code, source: "r2", rows: snapshotRows };
    }
  }
  if (isUsExchangeCode(code)) {
    const rows = ensureFinancialSourceMetadata(await fetchYahooFinance(env.DB, code, statementType, options?.httpOptions));
    if (rows.length > 0) await putFinancialStatementsSnapshot(env, code, statementType, rows);
    return { code, source: "yahoo", rows };
  }
  if (isHongKongExchangeCode(code)) {
    const rows = ensureFinancialSourceMetadata(await fetchEastmoneyHongKongFinance(env.DB, code, statementType, options?.httpOptions));
    if (rows.length > 0) await putFinancialStatementsSnapshot(env, code, statementType, rows);
    return { code, source: "eastmoney", rows };
  }
  if (!isCnExchangeCode(code)) {
    return { code, source: "eastmoney", rows: [] };
  }
  const formalRows = await fetchEastmoneyFinance(env.DB, code, statementType, options?.httpOptions);
  let rows = ensureFinancialSourceMetadata(formalRows);
  if (statementType === "income") {
    // `*INCOME` cumulative rows (一季报/中报/三季报/年报) are kept as their own
    // series: they answer "year to date", while `*INCOMEQC` answers "this
    // quarter".  Only the quarterized family goes through the provisional
    // merge, because that merge rewrites rows into single-quarter values.
    const cumulativeRows = rows.filter((row) => isEastmoneyCumulativeIncomeStatement(row));
    const quarterizedRows = formalRows.filter((row) => !isEastmoneyCumulativeIncomeStatement(row));
    const cachedQuarterizedRows = snapshotRows.filter((row) => !isEastmoneyCumulativeIncomeStatement(row));
    rows = [...cumulativeRows, ...mergeProvisionalFinancialStatements(
      [...quarterizedRows, ...cachedQuarterizedRows],
      pendingProvisional?.performanceRows ?? [],
      pendingProvisional?.forecastRows ?? []
    )].sort((left, right) => right.reportDate.localeCompare(left.reportDate)
      || Number(isEastmoneyCumulativeIncomeStatement(right)) - Number(isEastmoneyCumulativeIncomeStatement(left)));
  }
  if (rows.length > 0) {
    const latestFormalized = pendingProvisional
      ? rows.some((row) => row.reportDate === pendingProvisional.reportDate && !isProvisionalFinancialStatement(row))
      : false;
    await putFinancialStatementsSnapshot(env, code, statementType, rows, {
      provisionalData: latestFormalized ? undefined : pendingProvisional,
    });
  }
  return { code, source: "eastmoney", rows };
}

/**
 * Shared read boundary for APIs and research consumers.  It turns every
 * primary-provider failure into a machine-readable health result while the
 * legacy loader above retains its historical throw/rows contract.
 */
export async function loadFinancialStatementReadModel(
  env: Pick<Bindings, "DB" | "MARKET_DATA_BUCKET">,
  rawCode: string,
  statementType: StatementType,
  options?: { httpOptions?: ExternalHttpOptions },
): Promise<FinancialStatementReadModel> {
  const code = normalizeSecurityCode(rawCode);
  try {
    const result = await loadFinancialStatements(env, code, statementType, options);
    return buildFinancialStatementReadModel({
      ...result,
      statementType,
      fresh: result.source !== "r2" || areFinancialStatementsFresh(result.rows),
    });
  } catch (error) {
    return failedFinancialStatementReadModel(code, statementType, error);
  }
}

export function parseStatementType(value: string): StatementType | null {
  if (value === "income" || value === "balance" || value === "cashflow") {
    return value;
  }
  return null;
}

function isCnExchangeCode(code: string): boolean {
  return /\.(SH|SZ|BJ)$/.test(normalizeSecurityCode(code));
}

function isUsExchangeCode(code: string): boolean {
  return /\.US$/.test(normalizeSecurityCode(code));
}

function isHongKongExchangeCode(code: string): boolean {
  return /^\d{5}\.HK$/.test(normalizeSecurityCode(code));
}

function hasHongKongReportingMetadata(row: FinancialStatement): boolean {
  const payload = row.payload && typeof row.payload === "object" ? row.payload as Record<string, unknown> : {};
  return payload.FINANCIAL_SOURCE_CONTRACT === "eastmoney_hk_f10_main_indicator.v2"
    && typeof payload.REPORTING_CURRENCY === "string" && payload.REPORTING_CURRENCY.trim().length > 0
    && typeof payload.REPORTING_ACCOUNT_STANDARD === "string" && payload.REPORTING_ACCOUNT_STANDARD.trim().length > 0;
}

function hasYahooReportingMetadata(row: FinancialStatement): boolean {
  const payload = row.payload && typeof row.payload === "object" ? row.payload as Record<string, unknown> : {};
  return payload.FINANCIAL_SOURCE_CONTRACT === "yahoo_finance_timeseries.v3"
    && typeof payload.REPORTING_CURRENCY === "string" && payload.REPORTING_CURRENCY.trim().length > 0
    && typeof payload.FISCAL_PERIOD === "string" && payload.FISCAL_PERIOD.trim().length > 0;
}

function isEastmoneyCumulativeIncomeStatement(row: FinancialStatement): boolean {
  if (row.statementType !== "income" || row.source !== "eastmoney") return false;
  const payload = row.payload && typeof row.payload === "object" ? row.payload as Record<string, unknown> : {};
  return payload.FINANCIAL_SOURCE_CONTRACT === "eastmoney_f10_annual_income.v1"
    || payload.FINANCIAL_SOURCE_CONTRACT === "eastmoney_f10_income.v1";
}

function isEastmoneyAnnualIncomeStatement(row: FinancialStatement): boolean {
  if (row.statementType !== "income" || row.source !== "eastmoney") return false;
  const payload = row.payload && typeof row.payload === "object" ? row.payload as Record<string, unknown> : {};
  return payload.FINANCIAL_SOURCE_CONTRACT === "eastmoney_f10_annual_income.v1"
    && payload.FISCAL_PERIOD === "12M";
}
