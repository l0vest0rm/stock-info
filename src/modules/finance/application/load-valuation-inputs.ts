import financeMappings from "../../../../shared/finance-mappings.json";
import { normalizeSecurityCode } from "../../../shared/codes";
import type { Bindings, FinancialStatement, StatementType } from "../../../types";
import { externalHttpOptions, type ExternalHttpOptions } from "../../../shared/http";
import { loadFinancialStatements } from "./load-financial-statements";
import { isProvisionalFinancialStatement } from "./select-quarterly-income-statements";
import {
  buildValuationInputs,
  type BalanceSheetRevenueArchetype,
  type StatementRows,
  type ValuationInputsReadModel,
} from "../domain/valuation-inputs";

type FinanceMappings = { bankCodes?: string[]; insuranceCodes?: string[]; securityCodes?: string[] };

const mappings = financeMappings as FinanceMappings;
const bankCodes = new Set((mappings.bankCodes ?? []).map((code) => normalizeSecurityCode(code)));
const insuranceCodes = new Set((mappings.insuranceCodes ?? []).map((code) => normalizeSecurityCode(code)));
const brokerCodes = new Set((mappings.securityCodes ?? []).map((code) => normalizeSecurityCode(code)));

/**
 * Same two-row contract as the latest financial valuation: a latest statement
 * plus the same fiscal period one year earlier, so growth comparisons never
 * reuse a half-year against a full year.
 */
type PeriodRows = StatementRows;

export function balanceSheetArchetypeFor(code: string): BalanceSheetRevenueArchetype {
  const normalized = normalizeSecurityCode(code);
  if (bankCodes.has(normalized)) return "bank";
  if (insuranceCodes.has(normalized)) return "insurer";
  if (brokerCodes.has(normalized)) return "broker";
  return "non_financial";
}

/**
 * Valuation inputs are the arithmetic those archetype-specific models need.
 * They are not a price, a target value or a recommendation; the caller still
 * has to pair them with a dated quote of the same security and currency.
 */
export async function loadValuationInputs(
  env: Pick<Bindings, "DB" | "MARKET_DATA_BUCKET">,
  rawCode: string,
  options?: { httpOptions?: ExternalHttpOptions },
): Promise<ValuationInputsReadModel> {
  const code = normalizeSecurityCode(rawCode);
  const httpOptions = options?.httpOptions ?? externalHttpOptions(env);
  const [income, balance, cashflow] = await Promise.all([
    loadRows(env, code, "income", httpOptions),
    loadRows(env, code, "balance", httpOptions),
    loadRows(env, code, "cashflow", httpOptions),
  ]);
  return buildValuationInputs({
    code,
    income,
    balance,
    cashflow,
    balanceSheetArchetype: balanceSheetArchetypeFor(code),
    provisional: isProvisionalFinancialStatement(income.latest ?? undefined),
  });
}

async function loadRows(
  env: Pick<Bindings, "DB" | "MARKET_DATA_BUCKET">,
  code: string,
  statementType: StatementType,
  httpOptions: ExternalHttpOptions,
): Promise<PeriodRows> {
  try {
    const { rows } = await loadFinancialStatements(env, code, statementType, { httpOptions });
    return selectPeriodRows(rows);
  } catch {
    // A missing statement is reported through the read model's gaps, not by
    // faulting the whole valuation-input request.
    return { latest: null, priorYearSamePeriod: null, priorFiscalYear: null, currentFiscalYearSamePeriod: null };
  }
}

export function selectPeriodRows(rows: FinancialStatement[]): PeriodRows {
  const empty: PeriodRows = { latest: null, priorYearSamePeriod: null, priorFiscalYear: null, currentFiscalYearSamePeriod: null };
  const latest = rows[0] ?? null;
  if (!latest) return empty;
  const match = latest.reportDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return { ...empty, latest };
  const year = Number(match[1]);
  const priorDate = `${year - 1}-${match[2]}-${match[3]}`;
  const priorYearSamePeriod = rows.find((row) => row.reportDate === priorDate) ?? null;
  // Depreciation lives in the cash-flow supplement block, which the provider
  // publishes only with annual and half-year reports.  Resolve the prior year
  // end here so a Q1/Q3 statement can fall back with an explicit label instead
  // of reporting a hard zero.
  const priorFiscalYear = rows.find((row) => row.reportDate === `${year - 1}-12-31`) ?? null;
  const currentFiscalYearSamePeriod = priorDate.endsWith("12-31") ? null : priorYearSamePeriod;
  return { latest, priorYearSamePeriod, priorFiscalYear, currentFiscalYearSamePeriod };
}
