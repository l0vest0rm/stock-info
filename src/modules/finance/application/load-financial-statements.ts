import { fetchEastmoneyFinance } from "../../../adapters/eastmoney";
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

const PROVISIONAL_FINANCE_TTL_MS = 30 * 60 * 1000;

export async function loadFinancialStatements(
  env: Pick<Bindings, "DB" | "MARKET_DATA_BUCKET">,
  rawCode: string,
  statementType: StatementType,
  options?: { httpOptions?: ExternalHttpOptions }
): Promise<{ code: string; source: "r2" | "eastmoney"; rows: FinancialStatement[] }> {
  const code = normalizeSecurityCode(rawCode);
  const snapshot = await getFinancialStatementsSnapshot(env, code, statementType);
  const snapshotRows = snapshot ? ensureFinancialSourceMetadata(snapshot.rows) : [];
  const pendingProvisional = statementType === "income" ? snapshot?.provisionalData : undefined;
  if (snapshotRows.length > 0) {
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
  if (!isCnExchangeCode(code)) {
    return { code, source: "eastmoney", rows: [] };
  }
  const formalRows = await fetchEastmoneyFinance(env.DB, code, statementType, options?.httpOptions);
  let rows = ensureFinancialSourceMetadata(formalRows);
  if (statementType === "income") {
    rows = mergeProvisionalFinancialStatements(
      [...formalRows, ...snapshotRows],
      pendingProvisional?.performanceRows ?? [],
      pendingProvisional?.forecastRows ?? []
    );
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

export function parseStatementType(value: string): StatementType | null {
  if (value === "income" || value === "balance" || value === "cashflow") {
    return value;
  }
  return null;
}

function isCnExchangeCode(code: string): boolean {
  return /\.(SH|SZ|BJ)$/.test(normalizeSecurityCode(code));
}
