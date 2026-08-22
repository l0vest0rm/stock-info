import type { StrategyLeg } from './strategy-calculator'

/**
 * Identifies a listed option contract independently of how a strategy uses it.
 * Side, quantity, and premium are deliberately excluded so one quote update can
 * be applied to every matching leg across several strategies.
 */
export function optionContractKey(underlyingCode: string, leg: Pick<StrategyLeg, 'type' | 'strike' | 'expiration' | 'multiplier'>): string {
  return [
    underlyingCode.trim().toUpperCase(),
    leg.type,
    String(leg.strike),
    leg.expiration,
    String(leg.multiplier),
  ].join('|')
}
