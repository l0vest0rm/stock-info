import { fetchEastmoneyFinance, fetchYahooFinance } from "../../../adapters/eastmoney";
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
  normalizeFinancialStatements,
  type NormalizedFinancialStatement,
} from "../domain/normalize-financial-statements";
import {
  resolveFinancialStatementSource,
  type FinancialStatementProvider,
  type FinancialStatementSourceAvailability,
} from "../domain/financial-statement-source";

const PROVISIONAL_FINANCE_TTL_MS = 30 * 60 * 1000;

export async function loadFinancialStatements(
  env: Pick<Bindings, "DB" | "MARKET_DATA_BUCKET">,
  rawCode: string,
  statementType: StatementType,
  options?: { httpOptions?: ExternalHttpOptions }
): Promise<{
  code: string;
  source: "r2" | FinancialStatementProvider | "unavailable";
  provider: FinancialStatementProvider | null;
  availability: FinancialStatementSourceAvailability;
  sourceReason: string | null;
  rows: FinancialStatement[];
  normalizedRows: NormalizedFinancialStatement[];
}> {
  const code = normalizeSecurityCode(rawCode);
  const sourcePolicy = resolveFinancialStatementSource(code);
  const snapshot = await getFinancialStatementsSnapshot(env, code, statementType);
  const snapshotRows = snapshot ? ensureFinancialSourceMetadata(snapshot.rows) : [];
  const pendingProvisional = statementType === "income" ? snapshot?.provisionalData : undefined;
  if (snapshotRows.length > 0) {
    const now = Date.now();
    const latest = snapshotRows[0];
    if (isProvisionalFinancialStatement(latest) && now - latest.updatedAt < PROVISIONAL_FINANCE_TTL_MS) {
      return loadedSnapshot(code, sourcePolicy.provider, snapshotRows);
    }
    const unresolvedPending = pendingProvisional
      ? !snapshotRows.some((row) => row.reportDate === pendingProvisional.reportDate)
      : false;
    if (!unresolvedPending && !isProvisionalFinancialStatement(latest) && areFinancialStatementsFresh(snapshotRows, now)) {
      return loadedSnapshot(code, sourcePolicy.provider, snapshotRows);
    }
  }
  if (sourcePolicy.availability !== "available" || !sourcePolicy.provider) {
    return {
      code,
      source: "unavailable",
      provider: sourcePolicy.provider,
      availability: sourcePolicy.availability,
      sourceReason: sourcePolicy.reason,
      rows: [],
      normalizedRows: [],
    };
  }
  const formalRows = sourcePolicy.provider === "eastmoney"
    ? await fetchEastmoneyFinance(env.DB, code, statementType, options?.httpOptions)
    : await fetchYahooFinance(env.DB, code, statementType, options?.httpOptions);
  let rows = ensureFinancialSourceMetadata(formalRows);
  if (sourcePolicy.provider === "eastmoney" && statementType === "income") {
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
  return {
    code,
    source: sourcePolicy.provider,
    provider: sourcePolicy.provider,
    availability: "available",
    sourceReason: null,
    rows,
    normalizedRows: normalizeFinancialStatements(rows),
  };
}

export function parseStatementType(value: string): StatementType | null {
  if (value === "income" || value === "balance" || value === "cashflow") {
    return value;
  }
  return null;
}

function loadedSnapshot(
  code: string,
  provider: FinancialStatementProvider | null,
  rows: FinancialStatement[]
): {
  code: string;
  source: "r2";
  provider: FinancialStatementProvider | null;
  availability: "available";
  sourceReason: null;
  rows: FinancialStatement[];
  normalizedRows: NormalizedFinancialStatement[];
} {
  return {
    code,
    source: "r2",
    provider,
    availability: "available",
    sourceReason: null,
    rows,
    normalizedRows: normalizeFinancialStatements(rows),
  };
}
