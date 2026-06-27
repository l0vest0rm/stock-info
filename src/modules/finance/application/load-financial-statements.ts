import { fetchEastmoneyFinance } from "../../../adapters/eastmoney";
import { getFinancialStatements, upsertFinancialStatements } from "../../../db/queries";
import { normalizeSecurityCode } from "../../../shared/codes";
import type { ExternalHttpOptions } from "../../../shared/http";
import type { FinancialStatement, StatementType } from "../../../types";

export async function loadFinancialStatements(
  db: D1Database,
  rawCode: string,
  statementType: StatementType,
  _options?: { httpOptions?: ExternalHttpOptions }
): Promise<{ code: string; source: "d1" | "eastmoney" | "yahoo"; rows: FinancialStatement[] }> {
  const code = normalizeSecurityCode(rawCode);
  const cached = await getFinancialStatements(db, code, statementType);
  if (cached.length > 0 && Date.now() - cached[0].updatedAt < 24 * 60 * 60 * 1000) {
    return { code, source: "d1", rows: cached };
  }
  if (!isCnExchangeCode(code)) {
    return { code, source: "yahoo", rows: [] };
  }
  const rows = await fetchEastmoneyFinance(db, code, statementType);
  await upsertFinancialStatements(db, rows);
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
