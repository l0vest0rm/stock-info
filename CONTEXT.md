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

## Information Processing

**Document**:
An immutable captured version of an original news item, announcement, research report, or other source material. It is the source record, not a verified conclusion.
_Avoid_: Fact, research conclusion

**Information record**:
One compact, source-bound statement extracted from a document. It records an entity, information type, category, optional period, and self-contained statement; it is not a verified conclusion or article rewrite.
_Avoid_: Claim graph, investment conclusion, quote snippet

**Entity**:
The one stable, concrete real-world object that an information record is about. For issuer activity, use the issuer's concise stable name, not a legal suffix, ticker, share class, offering name, or a combined relationship phrase. Keep counterparties and transaction qualifiers in the statement.
_Avoid_: Article topic, category label, `中际旭创H股`, `中际旭创H股全球发售`, `甲公司与乙公司`

**Information type**:
The source's epistemic form: fact, guidance, forecast, opinion, event, or relationship.
_Avoid_: Business topic, investment impact

**Category**:
The controlled business topic of a record, such as revenue, financing, listing, or product development. It is independent of information type.
_Avoid_: Entity type, sentiment

**Processing outcome**:
The result for one document version: extracted, no information, or needs review. A failed model attempt is not a processing outcome and does not remain in the information-processing ledger.

## Company Investment Analysis

**Operating company**:
The economic business whose products, customers, assets, management, and financial results are being analysed, independent of where or how its equity is listed.
_Avoid_: Ticker, listing venue, share class

**Listed security**:
A specific tradable equity claim on an operating company, identified by venue, currency, share class, holder rights, and any depositary ratio.
_Avoid_: Company, interchangeable A-share/H-share/ADR

**Security-rights profile**:
A dated, source-bound description of the rights held through one listed security, including holder structure, voting and economic rights, transferability, and depositary or structural terms where applicable. It belongs to the security, not to the operating company.
_Avoid_: Implied parity across A/H shares, an ADR ratio without a source, generic company governance

**Security-rights link**:
An explicit, source-bound relationship between two distinct listed securities that have separately confirmed operating-company mappings. It records whether they are different listings of the same company or an ADR-to-underlying relationship, any stated ratio, and conversion availability; it never asserts price, liquidity, tax, or legal-right equivalence that its evidence does not establish.
_Avoid_: Name-only merge, ticker-stem match, automatic target-price conversion

**Investment analysis snapshot**:
A dated assessment that combines an operating-company view with the market and rights of one listed security, while preserving evidence, assumptions, scenarios, valuation, risks, and gaps separately.
_Avoid_: Timeless stock conclusion, source summary, trade order

**Owner holding snapshot reference**:
An immutable, owner-scoped link from an already configured holding profile for one listed security to one frozen public investment-analysis snapshot of that same security. It records the snapshot identity and link time without copying, editing, or feeding back into the holding profile or public research.
_Avoid_: Trade order, cross-security parity assumption, mutable bookmark, a channel for personal position data to enter public research

**Common analysis core**:
The non-optional questions and evidence rules applied to every company, including business model, financial quality, capital allocation, valuation, risk, and data provenance.
_Avoid_: Universal score, generic checklist result

**Financial analysis profile**:
The common and business-model-specific financial measures, definitions, comparisons, and exception rules used to assess growth, profitability, cash conversion, balance-sheet safety, capital efficiency, and per-share value.
_Avoid_: Universal ratio checklist, cross-industry fixed thresholds

**Financial entity profile**:
A dated, source-bound classification of an operating company as non-financial, bank, insurer, broker, or other financial business. It selects an applicable financial-analysis profile, but does not itself contain financial facts or permit a ticker/name-based inference. Missing or conflicting records leave the classification unknown and block measures that depend on non-financial operating assumptions.
_Avoid_: Auto-classification from code/name, a generic sector tag, a source-free exemption

**Financial specialty source fact**:
An immutable, human-normalized direct disclosure for one configured bank, insurer, or broker metric, descended from an accepted information-preprocessing evidence reference and a current financial entity profile. It preserves the reported value, period, definition, scope, and source locator; it is not a score, peer comparison, scenario, valuation input, or investment conclusion.
_Avoid_: Generic industrial KPI, inferred ratio, automated bank rating

**U.S. reporting-period equivalence**:
An immutable, local human-review record that relates one exact Yahoo primary financial-fact identity to one exact SEC filing fact when Yahoo's display period differs from the issuer's fiscal end. It retains both periods and all metric, unit, filing, and review evidence; it never alters Yahoo dates, replaces Yahoo values, or authorizes nearest-date matching.
_Avoid_: Date tolerance, SEC fallback, inferred fiscal-calendar alignment

**Valuation archetype**:
The primary valuation approach selected from the company's main earnings and cash-flow mechanism, such as growth earnings, stable cash return, cycle-normalized earnings, financial capital, asset value, milestone value, or sum of parts.
_Avoid_: Industry multiple, whichever method gives the highest value

**Market and listing profile**:
The accounting, currency, shareholder-rights, regulatory, liquidity, and security-structure considerations specific to an A-share, Hong Kong share, U.S. share, or ADR.
_Avoid_: Industry profile, company fundamentals

**Track research profile**:
A versioned set of demand, supply, operating, cycle, valuation, and risk questions shared by companies in one primary business track.
_Avoid_: Theme narrative, concept-stock template

**Company track exposure**:
An evidence-bound, versioned statement of how one operating company or its named business segment participates in one track research profile, including product, customer and geographic scope and any attributable share with its measurement period. It does not turn a theme tag into a primary business classification.
_Avoid_: Concept tag, unreferenced industry label, company-wide share inferred from a segment name

**Peer comparison set**:
A dated, purpose-specific set of candidate peers for one operating company and one track profile. Each member records inclusion or exclusion, its comparability status, and any business-model, currency, accounting, fiscal-year, capital-intensity, cycle or security-rights adjustment.
_Avoid_: Automatically ranked ticker list, universal competitor universe, unexplained cross-market multiple table

**Relevant competitive market**:
The dated product, customer, geographic, and use-case boundary within which competitors, substitutes, market shares, and pricing are meaningfully comparable.
_Avoid_: Entire industry label, target company's strongest niche only

**Competitive advantage thesis**:
A falsifiable explanation of why a company can sustain superior share, pricing, unit economics, or capital returns relative to relevant competitors.
_Avoid_: Leadership claim, high margin without a mechanism

**Barrier to entry or expansion**:
A structural obstacle that makes it costly or slow for a competitor to enter or scale in a relevant market, distinct from the incumbent's current lead.
_Avoid_: Current market share, temporary shortage, management claim

**Advantage durability horizon**:
The explicit period over which a competitive advantage is expected to persist, together with its likely erosion paths and invalidation conditions.
_Avoid_: Permanent moat, unbounded terminal advantage

**Company focus profile**:
An optional, evidence-backed set of drivers, metrics, theses, events, and invalidations maintained for an important company in addition to the common, market, and track analysis.
_Avoid_: Free-form company introduction, exception that removes evidence requirements

**Focus membership**:
A private, owner-scoped, append-only selection of an operating company for additional research attention. It is shared across that company's A/H/ADR securities but contains no holding, rationale, public fact, or investment conclusion.
_Avoid_: Public watchlist, position record, company analysis status

**Public company focus profile**:
A versioned public `system_judgment` reference graph that selects existing source-gated research ledger records for an operating company. It may be snapshotted, but never includes an owner's focus membership or personal note.
_Avoid_: Copied KPI/risk/event narrative, personal research reason, second factual ledger

**Research thesis**:
A falsifiable proposition connecting observable business drivers to a company's financial outcome over a stated period.
_Avoid_: Bull case slogan, price target

**Total addressable market**:
The total annual demand within an explicitly dated product, customer, and geographic boundary before applying one company's eligibility or capacity constraints.
_Avoid_: Entire downstream industry value, cumulative installed base

**Serviceable available market**:
The portion of the total addressable market that matches a company's products, permitted geographies, reachable customers, and relevant time horizon.
_Avoid_: Global market copied into a company forecast

**Attainable market share**:
The scenario-specific percentage of a serviceable market that a company can plausibly capture after competition, customer sourcing limits, capacity, yield, price, and time are considered.
_Avoid_: Leadership label, unconstrained target share

**Serviceable obtainable market**:
The revenue opportunity produced by applying an attainable market share to the serviceable available market, before testing recognition, margins, working capital, and capital expenditure.
_Avoid_: Guaranteed revenue, company valuation

**Industry profit pool**:
The sustainable operating profit available across a defined industry scope, distinct from its revenue size and from any one company's market share.
_Avoid_: Market revenue, target company's net profit

**Valuation scenario**:
One explicit set of operating assumptions, forecast results, and valuation inputs for a stated period, normally identified as downside, base, or upside.
_Avoid_: Unattributed consensus, single target price

**Self-built operating scenario**:
A versioned, researcher-owned chain of explicit starting conditions and annual operating assumptions that deterministically derives revenue, operating profit, cash flow, working-capital movement, and forecast debt balances. It may cite evidence that motivates an assumption, but it never imports a source forecast, forecast consolidation, local-model draft, or later actual as its own output.
_Avoid_: Analyst consensus, copied forecast table, actual result, mutable calculator state

**Valuation input projection**:
The reproducible DCF-ready annual forecast and valuation-input set derived from exactly one self-built operating scenario. It records the scenario identity and version, retains the explicit as-of net-debt bridge separately from forecast debt balances, and is an input to an immutable valuation-model version rather than a source forecast or a valuation conclusion.
_Avoid_: Market consensus, source forecast normalization, automatic target price

**Invalidation condition**:
An observable event or metric threshold that requires a research thesis or valuation assumption to be re-examined.
_Avoid_: Stop-loss price, generic risk warning

**Risk register**:
The dated set of material operating-company and listed-security risks, each linked to exposure, transmission, impact, evidence, mitigation, triggers, and review status.
_Avoid_: Generic disclaimer list, volatility dashboard

**Risk transmission path**:
The explicit chain by which a risk event affects operating drivers, financial statements, valuation, or shareholder rights.
_Avoid_: Risk label without financial consequence

**Early-warning trigger**:
An observable signal that increases review urgency without by itself invalidating a research thesis.
_Avoid_: Automatic sell signal, thesis invalidation

**Residual risk**:
The shareholder exposure remaining after only evidenced and stress-tested mitigation measures are considered.
_Avoid_: Management assurance, gross risk before mitigation

**Permanent capital-loss risk**:
A plausible path to value destruction that is difficult to recover through time or normal operations, such as insolvency, severe dilution, fraud, permanent impairment, technological obsolescence, or loss of shareholder rights.
_Avoid_: Ordinary price volatility, temporary earnings miss

**Analysis gap**:
A required but missing, stale, conflicting, unhealthy, or non-comparable input that prevents a stronger assessment.
_Avoid_: Neutral score, assumed zero

**Research coverage level**:
The declared evidence depth of an investment analysis: basic, standard, or deep. A completed lower level does not imply that a higher-level conclusion is available.
_Avoid_: Page length, universal completeness score

**Factual data requirement**:
A defined observed input needed by one or more analysis modules, including its object, period, unit, source expectation, freshness, and the conclusion blocked when it is unavailable.
_Avoid_: Nice-to-have field, assumed model input

**Data availability status**:
A dated assessment of whether a factual data requirement is verified available, partially available, dependent on a new source, limited to document extraction, or currently unreliable.
_Avoid_: Permanent provider capability, non-null value

**Derived observation**:
A reproducible result calculated from identified source facts using an explicit formula and adjustments. It is neither a source fact nor an investment judgement.
_Avoid_: Extracted fact, opaque model conclusion

**Research completion state**:
The state of a module at a declared research coverage level after object, blocking-data, conflict, freshness, and review rules are applied in order.
_Avoid_: Average completion percentage, investment rating

**Forecast calibration record**:
A comparison between a versioned management, third-party, or analyst-built forecast and the later actual result on a comparable basis, including forecast date, error, and driver deviation.
_Avoid_: Latest forecast only, hindsight-adjusted prediction

**Formal actual**:
A dated value reported in a formal filing or official financial disclosure, retained with its raw unit, normalized comparison form, accounting bases, filing reference, and revision lineage. It is an observed fact, not a source forecast or an analyst adjustment.
_Avoid_: Screened estimate, live market-data field, reconstructed actual

**Restated actual**:
A new formal actual that explicitly supersedes an earlier reported value for the same metric and period. It remains visible as a revision, but it blocks forecast-error statistics until comparability is explicitly re-established.
_Avoid_: Quietly overwriting the original actual, ordinary source refresh

**Source forecast**:
One dated, attributable forward estimate made by a third-party research source for a defined company, metric, period, and accounting basis. Management forward statements remain guidance.
_Avoid_: Management guidance, fact, current result, consensus

**Forecast synthesis draft**:
A source-linked, reviewable local-model draft that proposes how multiple source forecasts map, conflict, and relate to stated drivers; it has no authority to create a forecast number or source fact.
_Avoid_: Verified extraction, consensus, final forecast

**Forecast consolidation**:
A dated derived observation that summarizes a defined, deduplicated set of comparable source forecasts, with its membership, normalization rules, statistics, and exclusions preserved.
_Avoid_: Market consensus, new third-party forecast, self-built scenario

**Market consensus**:
A forecast consolidation whose declared source universe and coverage rules support a claim of broad market coverage. It is unavailable for an opportunistic or incomplete collection of reports.
_Avoid_: Multi-report summary, latest analyst estimate

**Research subject mapping**:
An evidenced relationship between one operating company and one listed security. Until confirmed, company-level sharing and cross-listed comparison remain unavailable even when the ticker or company name appears obvious.
_Avoid_: Ticker-as-company identity, name-only merge

**Forecast source review**:
A recorded decision that a source-bound forecast candidate is included, excluded, or still needs review, together with its reason and the current immutable source-forecast version.
_Avoid_: Silent filtering, model auto-approval

**Financial-statement source policy**:
The market-specific primary structured source for financial statements—Eastmoney for A-shares and Hong Kong shares, Yahoo for U.S. shares—paired with the relevant statutory filing as the verification source. It does not permit automatic fallback between providers.
_Avoid_: Interchangeable finance-provider fallback, statutory filing substitute

**Research workflow**:
The ordered research process that first confirms the operating-company/security mapping and factual coverage, then develops operating assumptions and security valuation, and finally records falsification, review and private follow-up. A blocked earlier step prevents a stronger later conclusion.
_Avoid_: Dashboard section order, completion percentage, automatic trade workflow

**Typed research record**:
A dated, versioned entry for one research domain that uses domain-specific fields and declares its epistemic type and source references where required. It is not a free-form JSON blob or an overwrite of historical analysis.
_Avoid_: Generic note, raw JSON editor, mutable current-state field

**Valuation model version**:
An immutable, security-specific calculation record containing its declared operating inputs, calculation rule version, source references, FX/share-rights assumptions, outputs, and sensitivity axes at one as-of time. It is distinct from a narrative valuation case and may not silently refresh from later facts.
_Avoid_: Editable calculator state, timeless target price, company-level value reused across securities
