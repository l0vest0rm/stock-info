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
