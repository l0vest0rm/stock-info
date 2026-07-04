import { fetchEastmoneyFinance } from "../../../adapters/eastmoney";
import { areFinancialStatementsFresh } from "../../../shared/cache-policy";
import { normalizeSecurityCode } from "../../../shared/codes";
import {
  getFinancialStatementsSnapshot,
  putFinancialStatementsSnapshot,
} from "../../../storage/market-data";
import type { ExternalHttpOptions } from "../../../shared/http";
import type { Bindings, FinancialStatement, StatementType } from "../../../types";

export async function loadFinancialStatements(
  env: Pick<Bindings, "DB" | "MARKET_DATA_BUCKET">,
  rawCode: string,
  statementType: StatementType,
  _options?: { httpOptions?: ExternalHttpOptions }
): Promise<{ code: string; source: "r2" | "eastmoney" | "yahoo"; rows: FinancialStatement[] }> {
  const code = normalizeSecurityCode(rawCode);
  const snapshot = await getFinancialStatementsSnapshot(env, code, statementType);
  if (snapshot && snapshot.rows.length > 0 && areFinancialStatementsFresh(snapshot.rows, Date.now())) {
    return { code, source: "r2", rows: snapshot.rows };
  }
  if (!isCnExchangeCode(code)) {
    return { code, source: "yahoo", rows: [] };
  }
  const rows = await fetchEastmoneyFinance(env.DB, code, statementType);
  if (rows.length > 0) {
    await putFinancialStatementsSnapshot(env, code, statementType, rows);
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
