# Investment Backtest Vocabulary

## Asset sleeve

A named tradable price series held by a strategy. The four built-in sleeve roles are `growth`, `dividend`, `bond`, and `cash`; a configured stock code can replace either stock sleeve.

## Allocation set

The starting portfolio weights for the four sleeve roles. Weights are percentages of starting net asset value and must total 100%.

## Static allocation benchmark

The matched benchmark that starts with the same allocation set and makes no subsequent trades. It is distinct from the `full-stock benchmark`, which starts with 100% of the configured stock target.

## Deployment ladder

Ordered stock-price drawdown triggers. Each rung transfers a configured portion of the initial designated reserve from cash and/or bonds into a configured stock sleeve.

## Funding order

The deterministic order in which source sleeves are sold to fund a deployment rung, for example `cash,bond`. A sleeve cannot be sold below zero and the remaining amount is taken from the next source.

## Rotation signal

A periodic rule that reallocates between the `growth` and `dividend` sleeves. A `price` signal is computed only from price history; a `valuation` signal requires a dated, user-supplied valuation series and never invents missing values.

## Tradable valuation series

A date-indexed valuation measure explicitly mapped to the growth and dividend sleeves. Missing values result in no valuation-based rotation for that date.

## Institutional Holdings Classification

**Primary business track**:
A broad economic activity determined by a company's principal business. Each company has exactly one primary business track.
_Avoid_: Concept track, hot-theme track

**Secondary business track**:
A narrower principal-business category within one primary business track. It is mutually exclusive for concentration measurement even when a company participates in several themes.
_Avoid_: Concept tag, Eastmoney concept

**Theme tag**:
A non-exclusive market or technology exposure associated with a company. Theme tags describe participation but never determine the primary or secondary business track.
_Avoid_: Primary industry, principal business

**Classification basis**:
The auditable evidence used for a business-track assignment: an exact source-industry mapping or a documented company-level principal-business correction.
_Avoid_: First keyword match

## Institutional Buy Recommendation

**Institutional candidate universe**:
The dated Top300 set ranked by institutional holder count. It is a discovery universe, not a buy signal or a portfolio instruction.

**Valuation status**:
A sector-specific, evidence-dated assessment of relative valuation. A green status is necessary but never sufficient for a new position.

**Valuation observation**:
A dated market valuation measure, such as PB, PE, or market capitalisation, paired with the closing-price record from the same source and trading day. It is distinct from a point-in-time quote and is unavailable when that dated source observation is missing.

**K-line source response**:
The unmodified provider response captured with a K-line snapshot. It preserves the provider's column definitions and every returned row so that structured observations can be audited or remapped if the provider adds fields.

**Buy plan**:
A user-owned record containing a conservative value range, target weight, invalidation conditions, tranche conditions, and evidence-review confirmation. It does not place an order.

**Plan-ready candidate**:
A candidate whose valuation, evidence, buy plan, cash, and company/theme/industry concentration checks all pass. The user still makes the trade decision.
