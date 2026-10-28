import { fetchEastmoneyCompanyOverview } from "../../../adapters/eastmoney";
import { normalizeSecurityCode } from "../../../shared/codes";
import { externalHttpOptions, type ExternalHttpOptions } from "../../../shared/http";
import type { Bindings, FinancialStatement } from "../../../types";
import { loadFinancialStatementReadModel } from "./load-financial-statements";
import { loadValuationInputs } from "./load-valuation-inputs";
import { loadMidCycleHistory } from "./load-mid-cycle-history";
import { deriveLatestFinancialValuation } from "./latest-financial-valuation";
import { isProvisionalFinancialStatement } from "./select-quarterly-income-statements";
import { balanceSheetArchetypeFor } from "./load-valuation-inputs";
import { companyValuationArchetype } from "../../research/domain/valuation-coverage";
import { buildValuationBands, type ValuationBandReadModel, type ValuationBandInput } from "../domain/valuation-bands";
import { isCumulativeIncomeRow } from "../domain/income-row-contracts";

type Environment = Pick<Bindings, "DB" | "MARKET_DATA_BUCKET">;

/**
 * Assemble conservative valuation bands for one security from the same
 * disclosed inputs the rest of the finance module uses.
 *
 * Market capitalisation is best-effort: the band anchors (TTM flows, EBIT,
 * EBITDA, equity) all come from statements, so an unavailable quote degrades
 * the implied column only.  Nothing here writes a price into the public JSON.
 */
export async function loadValuationBands(
  env: Environment,
  rawCode: string,
  options?: { httpOptions?: ExternalHttpOptions; marketCap?: number | null },
): Promise<ValuationBandReadModel> {
  const code = normalizeSecurityCode(rawCode);
  const httpOptions = options?.httpOptions ?? externalHttpOptions(env);

  const archetype = companyValuationArchetype(code) ?? "other";
  const [valuationInputs, income, cashflow, balance, midCycleHistory] = await Promise.all([
    loadValuationInputs(env, code, { httpOptions }),
    loadFinancialStatementReadModel(env, code, "income", { httpOptions }),
    loadFinancialStatementReadModel(env, code, "cashflow", { httpOptions }),
    loadFinancialStatementReadModel(env, code, "balance", { httpOptions }),
    // Only cyclicals need a through-cycle centre, and only they pay for the
    // separate eleven-year request.
    archetype === "cyclical_commodity"
      ? loadMidCycleHistory(env, code, { httpOptions, basis: "net_income_parent" })
      : Promise.resolve(null),
  ]);

  const marketCap = options?.marketCap ?? await loadMarketCap(env, code);
  const valuation = deriveLatestFinancialValuation({
    marketCapitalization: marketCap,
    incomeRows: income.sourceHealth.status === "failed" ? [] : income.rows,
    balanceRows: balance.sourceHealth.status === "failed" ? [] : balance.rows,
    cashflowRows: cashflow.sourceHealth.status === "failed" ? [] : cashflow.rows,
  });

  const lineValue = (key: string) => valuationInputs.lines.find((item) => item.key === key)?.value ?? null;
  const ebit = lineValue("ebit");
  const ebitda = lineValue("ebitda");
  const capitalExpenditure = ttmCapitalExpenditure(cashflow.rows);

  const input: ValuationBandInput = {
    code,
    archetype,
    asOf: {
      income: valuation.basis.income?.reportDate ?? null,
      balance: valuation.basis.balance?.reportDate ?? null,
      cashflow: valuation.basis.cashflow?.reportDate ?? null,
    },
    ttm: {
      netProfit: ttmNetProfit(income.rows),
      revenue: ttmRevenue(income.rows),
      operatingCashFlow: lineValue("operatingCashFlow"),
      ebit,
      ebitda,
      freeCashFlow: freeCashFlow(lineValue("operatingCashFlow"), capitalExpenditure),
    },
    balance: {
      parentEquity: lineValue("parentEquity"),
      grossDebt: lineValue("grossDebtDisclosed"),
      cash: lineValue("cashDisclosed"),
      minorityEquity: lineValue("minorityEquity"),
      // The valuation-inputs module records every missing debt line as a gap;
      // any such gap means the debt total is a partial sum.
      debtIncomplete: valuationInputs.gaps.some((gap) => DEBT_GAP_KEYS.has(gap.key)),
    },
    forward: null,
    marketCap,
    capitalIntensity: ebit && ebitda && ebit > 0 ? { depreciationToEbit: (ebitda - ebit) / ebit } : null,
    midCycle: midCycleHistory
      ? {
          status: midCycleHistory.earnings.status,
          mean: midCycleHistory.earnings.mean,
          median: midCycleHistory.earnings.median,
          window: midCycleHistory.earnings.status === "available" ? midCycleHistory.earnings.window : null,
          notes: midCycleHistory.earnings.notes,
        }
      : null,
  };

  const model = buildValuationBands(input);
  if (isProvisionalFinancialStatement(income.rows[0])) {
    model.warnings.push("最新利润表是业绩快报/预告口径，区间应视为临时值。");
  }
  return model;
}

const DEBT_GAP_KEYS = new Set(["shortLoan", "noncurrentLiab1year", "longLoan", "bondPayable", "leaseLiab", "shortLeaseLiab"]);

async function loadMarketCap(env: Environment, code: string): Promise<number | null> {
  try {
    const overview = await fetchEastmoneyCompanyOverview(env.DB, code);
    return overview.marketCapYi !== null ? overview.marketCapYi * 100_000_000 : null;
  } catch {
    // A blocked quote provider must not fail the whole model: the bands are
    // anchored on statements, and the implied column simply stays empty.
    return null;
  }
}

/**
 * TTM net profit and revenue from the cumulative family only, mirroring the
 * quarterly-series contract: prior FY + current cumulative − prior-year
 * cumulative.  A missing annual base returns null instead of promoting Q4.
 */
function ttmNetProfit(rows: FinancialStatement[]): number | null {
  return trailingCumulative(rows, "PARENT_NETPROFIT", "NETPROFIT");
}

function ttmRevenue(rows: FinancialStatement[]): number | null {
  return trailingCumulative(rows, "TOTAL_OPERATE_INCOME", "OPERATE_INCOME");
}

function trailingCumulative(rows: FinancialStatement[], ...fields: string[]): number | null {
  const cumulative = rows.filter((row) => isCumulativeIncomeRow(payloadOf(row)));
  const byDate = new Map(cumulative.map((row) => [row.reportDate, row]));
  const latest = cumulative[0];
  if (!latest) return null;
  const value = (row: FinancialStatement | undefined) => {
    if (!row) return null;
    const payload = payloadOf(row);
    for (const field of fields) {
      const candidate = payload[field];
      if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
    }
    return null;
  };
  const [year, month, day] = latest.reportDate.split("-");
  if (month === "12" && day === "31") return value(latest);
  const annual = value(byDate.get(`${Number(year) - 1}-12-31`));
  const priorSame = value(byDate.get(`${Number(year) - 1}-${month}-${day}`));
  const current = value(latest);
  if (annual === null || priorSame === null || current === null) return null;
  return annual + current - priorSame;
}

/** TTM capital expenditure from the cumulative cash-flow rows. */
function ttmCapitalExpenditure(rows: FinancialStatement[]): number | null {
  const capexOf = (row: FinancialStatement) => {
    const raw = payloadOf(row).CONSTRUCT_LONG_ASSET;
    return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
  };
  const sorted = [...rows].sort((left, right) => right.reportDate.localeCompare(left.reportDate));
  const latest = sorted[0];
  if (!latest) return null;
  const [year, month, day] = latest.reportDate.split("-");
  if (month === "12" && day === "31") return capexOf(latest);
  const annual = sorted.find((row) => row.reportDate === `${Number(year) - 1}-12-31`);
  const priorSame = sorted.find((row) => row.reportDate === `${Number(year) - 1}-${month}-${day}`);
  if (!annual || !priorSame) return null;
  const [a, c, p] = [capexOf(annual), capexOf(latest), capexOf(priorSame)];
  return a === null || c === null || p === null ? null : a + c - p;
}

function freeCashFlow(operatingCashFlow: number | null, capex: number | null): number | null {
  if (operatingCashFlow === null || capex === null) return null;
  return operatingCashFlow - capex;
}

function payloadOf(row: FinancialStatement): Record<string, unknown> {
  return row.payload && typeof row.payload === "object" ? row.payload as Record<string, unknown> : {};
}
