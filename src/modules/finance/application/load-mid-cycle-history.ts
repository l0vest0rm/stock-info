/**
 * Mid-cycle (through-cycle) earnings lookback.
 *
 * The TTM window exists to answer "what is the company earning now".  A
 * cyclical needs a different question answered — "what does this business earn
 * across a full cycle" — and that cannot be derived from any number of recent
 * quarters: the answer requires five to ten *annual* reports.
 *
 * This module issues that separate request from the same Eastmoney F10 source
 * and caches it under its own key.  It deliberately does not widen the window
 * used by TTM consumers: an 11-year request through every TTM call would
 * bloat every snapshot and slow every page for a figure only cyclicals use.
 *
 * Only the A-share primary statement family is requested here.  US and Hong
 * Kong companies fall back to whatever annual rows the regular snapshot already
 * holds, which means a long-enough history is checked, not fabricated.
 */
import { fetchEastmoneyDataRows } from "../../../adapters/eastmoney";
import { normalizeSecurityCode } from "../../../shared/codes";
import { externalHttpOptions, type ExternalHttpOptions } from "../../../shared/http";
import type { Bindings, FinancialStatement } from "../../../types";
import { loadFinancialStatements } from "./load-financial-statements";
import { buildMidCycleEarnings, type AnnualEarningsRow, type MidCycleEarnings } from "../domain/mid-cycle-earnings";

type Environment = Pick<Bindings, "DB" | "MARKET_DATA_BUCKET">;

/** Eleven fiscal years: a ten-year window plus the current partial year's anchor. */
export const MID_CYCLE_REPORT_DATES = (years = 11): string[] =>
  Array.from({ length: years }, (_, index) => `${new Date().getFullYear() - 1 - index}-12-31`);

export async function loadMidCycleHistory(
  env: Environment,
  rawCode: string,
  options?: { httpOptions?: ExternalHttpOptions; basis?: MidCycleEarnings["basis"]; years?: number },
): Promise<{ code: string; source: "eastmoney_annual" | "snapshot"; earnings: MidCycleEarnings }> {
  const code = normalizeSecurityCode(rawCode);
  const httpOptions = options?.httpOptions ?? externalHttpOptions(env);

  if (isCnExchangeCode(code)) {
    try {
      const rows = await fetchEastmoneyDataRows(
        env.DB,
        "https://datacenter-web.eastmoney.com/securities/api/data/get",
        {
          type: "RPT_F10_FINANCE_GINCOME",
          sty: "APP_F10_GINCOME",
          filter: `(SECUCODE="${code}")(REPORT_DATE in ('${MID_CYCLE_REPORT_DATES().join("','")}'))`,
          p: "1",
          ps: "",
          sr: "-1",
          st: "REPORT_DATE",
          source: "HSF10",
          client: "PC",
        },
      );
      const annualRows = rows.map((row) => annualRowFromPayload(row));
      if (annualRows.length > 0) {
        return {
          code,
          source: "eastmoney_annual",
          earnings: buildMidCycleEarnings({ rows: annualRows, basis: options?.basis, years: options?.years }),
        };
      }
    } catch {
      // Fall through to the regular snapshot; the note on the result says which
      // history level was actually used.
    }
  }

  // Non-A-share or failed A-share fetch: use whatever annual rows the regular
  // snapshot already holds.  The window check then decides whether that is
  // enough; nothing is padded to reach the minimum.
  const snapshot = await loadFinancialStatements(env, code, "income", { httpOptions }).catch(() => ({ rows: [] as never[] }));
  return {
    code,
    source: "snapshot",
    earnings: buildMidCycleEarnings({ rows: snapshot.rows.map(toAnnualRow), basis: options?.basis, years: options?.years }),
  };
}

function isCnExchangeCode(code: string): boolean {
  return /\.(SH|SZ|BJ)$/.test(code);
}

/** Reduce one statement row to the annual fields the centre needs. */
export function toAnnualRow(row: FinancialStatement): AnnualEarningsRow {
  const payload = row.payload && typeof row.payload === "object" ? row.payload as Record<string, unknown> : {};
  const reportDate = row.reportDate;
  const numberOrNull = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  return {
    reportDate,
    isAnnual: reportDate.endsWith("12-31"),
    parentNetProfit: numberOrNull(payload.PARENT_NETPROFIT ?? payload.HOLDER_PROFIT ?? payload.parentNetprofit),
    netProfit: numberOrNull(payload.NETPROFIT ?? payload.netProfit),
    operatingProfit: numberOrNull(payload.OPERATE_PROFIT ?? payload.operateProfit),
    investIncome: numberOrNull(payload.INVEST_INCOME ?? payload.investIncome),
    fairValueChangeIncome: numberOrNull(payload.FAIRVALUE_CHANGE_INCOME ?? payload.fairvalueChangeIncome),
  };
}

function annualRowFromPayload(row: Record<string, unknown>): AnnualEarningsRow {
  const reportDate = String(row.REPORT_DATE ?? "").slice(0, 10);
  const numberOrNull = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  return {
    reportDate,
    isAnnual: reportDate.endsWith("12-31"),
    parentNetProfit: numberOrNull(row.PARENT_NETPROFIT ?? row.HOLDER_PROFIT),
    netProfit: numberOrNull(row.NETPROFIT),
    operatingProfit: numberOrNull(row.OPERATE_PROFIT),
    investIncome: numberOrNull(row.INVEST_INCOME),
    fairValueChangeIncome: numberOrNull(row.FAIRVALUE_CHANGE_INCOME),
  };
}
