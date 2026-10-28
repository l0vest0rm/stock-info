/**
 * Price scaling for Eastmoney's `qt/stock/get` quote payload.
 *
 * Eastmoney returns `f43` (latest price) and `f169` (change amount) as
 * integers plus a separate `f59` declaring how many decimals they carry.  The
 * count is per-market, not fixed: A-shares carry 2 (`f43=4243` → 42.43) while
 * HK and US carry 3 (`f43=386400` → 386.4, `f43=217940` → 217.94).
 *
 * Reading the divisor as a constant is a silent order-of-magnitude error.  The
 * company page computes 市值 as price × total shares, and the total-share
 * fallback derives shares as market cap ÷ price, so a 10x-too-large price both
 * inflates the displayed price and deflates 市值 by 10x — with no NaN and no
 * missing field to notice.
 *
 * `f116` (market cap) is NOT scaled by this: it is already a full currency
 * amount.  Use `eastmoneyMarketCapYi` for it.
 */

/** Decimal places Eastmoney uses when it declares none. A-shares are the historical default. */
const FALLBACK_PRICE_DECIMALS = 2;

/** Plausible bounds; anything else means the payload is not what we think it is. */
const MIN_PRICE_DECIMALS = 0;
const MAX_PRICE_DECIMALS = 6;

/**
 * Divisor to apply to `f43`/`f169`, taken from the payload's own `f59`.
 *
 * An absent or implausible `f59` falls back to 2 decimals rather than throwing:
 * the price is still usable, and refusing the whole quote would turn a missing
 * cosmetic field into a missing company.
 */
export function eastmoneyPriceDivisor(f59: number | null | undefined): number {
  const decimals =
    typeof f59 === "number" && Number.isFinite(f59) && f59 >= MIN_PRICE_DECIMALS && f59 <= MAX_PRICE_DECIMALS
      ? Math.trunc(f59)
      : FALLBACK_PRICE_DECIMALS;
  return 10 ** decimals;
}

/** `f116` is a full currency amount; convert to 亿 for display. */
export function eastmoneyMarketCapYi(f116: number | null | undefined): number | null {
  return typeof f116 === "number" && Number.isFinite(f116) ? f116 / 100_000_000 : null;
}
