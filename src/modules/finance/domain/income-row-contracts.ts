/**
 * Which income rows the year-to-date TTM formula may consume.
 *
 * The TTM formula is `prior FY + current cumulative − prior-year same period`,
 * which only holds for rows whose value is cumulative year-to-date.  Getting this
 * classification wrong does not throw: the row is simply filtered out, the
 * denominator becomes null, and the valuation band reports `insufficient_data`
 * with the generic "denominator missing" reason.  A plumbing bug then reads
 * exactly like a company with no earnings.
 *
 * That is what happened to Hong Kong: `load-valuation-bands.ts` listed only the
 * two A-share contracts, so every HK band came back empty while A-shares were
 * fine.  HK rows are cumulative too — `DATE_TYPE_CODE=002` for the interim,
 * `001` for the fiscal year — so this module names the contract set explicitly
 * and is covered by `scripts/check-income-contracts-selftest.mjs`.
 *
 * Yahoo rows are deliberately absent: their `FISCAL_PERIOD` is a *duration*
 * (`12M`/`3M`), not a cumulative-versus-quarter distinction, so a 3M row must
 * not be fed to the year-to-date formula.
 */

const CUMULATIVE_INCOME_CONTRACTS = new Set([
  "eastmoney_f10_income.v1",
  "eastmoney_f10_annual_income.v1",
  "eastmoney_hk_f10_main_indicator.v1",
  "eastmoney_hk_f10_main_indicator.v2",
]);

/**
 * Is this income row's value cumulative year-to-date?
 *
 * Fails closed: an unknown contract is not cumulative until it is classified
 * deliberately, so a new provider shape cannot silently join the TTM input.
 */
export function isCumulativeIncomeRow(payload: Record<string, unknown>): boolean {
  return CUMULATIVE_INCOME_CONTRACTS.has(String(payload.FINANCIAL_SOURCE_CONTRACT ?? ""));
}
