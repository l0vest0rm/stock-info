export type CashDividend = {
  cashPerShare: number;
};

/**
 * A non-cash disclosure (for example, a future payout-ratio announcement)
 * must not advance the trailing dividend window.  Historical yield is based
 * on cash amounts that can actually be summed.
 */
export function cashDividends<T extends CashDividend>(decisions: readonly T[]): T[] {
  return decisions.filter((decision) => Number.isFinite(decision.cashPerShare) && decision.cashPerShare > 0);
}
