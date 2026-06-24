import { fetchEastmoneyFinance } from "../adapters/eastmoney";
import { getFinancialStatements, upsertFinancialStatements } from "../db/queries";
import { normalizeSecurityCode } from "../shared/codes";
import type { FinancialStatement, StatementType } from "../types";

export async function loadFinancialStatements(
  db: D1Database,
  rawCode: string,
  statementType: StatementType
): Promise<{ code: string; source: "d1" | "eastmoney"; rows: FinancialStatement[] }> {
  const code = normalizeSecurityCode(rawCode);
  const cached = await getFinancialStatements(db, code, statementType);
  if (cached.length > 0 && Date.now() - cached[0].updatedAt < 24 * 60 * 60 * 1000) {
    return { code, source: "d1", rows: cached };
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
