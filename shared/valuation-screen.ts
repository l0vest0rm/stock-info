// Public Rust screening response contract. No screening implementation lives here.

export type ValuationScreenVerdict =
  /** Inside the conservative range with margin — a human should read the filing. */
  | "research_candidate"
  /** Computable, but not inside the range, or inside it without margin. */
  | "watch"
  /** Not computable for a stated reason. Never approximated. */
  | "blocked";

/** Why a company could not be screened. Each is a real, checkable condition. */
export type ValuationScreenBlockReason =
  /** No band with a usable denominator for this archetype. */
  | "no_available_band"
  /** Bands exist but every one needs a quote this screen does not have. */
  | "quote_missing"
  /** Band denominator currency differs from the quote currency. */
  | "currency_mismatch"
  /**
   * One side's currency could not be determined at all.
   *
   * Kept separate from `currency_mismatch` because it is a different fact and a
   * different fix: a mismatch is structural (阿里 reports CNY, trades HKD) and
   * needs an official rate, whereas an unknown currency usually means the row we
   * read the currency from was a forecast that does not carry the field.  Merging
   * the two is how an A-share reporting in CNY got reported as a currency
   * problem — the diagnosis was wrong even though the refusal was right.
   */
  | "currency_unknown"
  /** Band anchors and quote are too far apart in time to be one observation. */
  | "stale_basis"
  /** Only EV-style bands are usable; EV is not comparable to a market cap. */
  | "no_market_cap_band"
  /** Trailing profit is shrinking fast enough that a low multiple is not a discount. */
  | "earnings_shrinking";


export type ValuationScreenResult = {
  code: string;
  archetype: string;
  verdict: ValuationScreenVerdict;
  /** The band the verdict rests on, or null when blocked. */
  basis: {
    key: string;
    role: "primary" | "auxiliary";
    reportDate: string;
    range: { low: number; high: number };
    /** `multiple` compares market cap to a range; `percent` compares a yield. */
    unit: "multiple" | "percent";
  } | null;
  /**
   * Where the quote sits inside the band.
   *
   * `marketCap` is always the company's market value in its trading currency;
   * `impliedHigh` is the top of the conservative range expressed the same way,
   * so a reader can redo the subtraction.  `metric` names the ratio family, and
   * for yield bands the comparison runs the other way: a *higher* current yield
   * than `range.high` is the discount.
   */
  position: {
    metric: "pe" | "ev" | "pb" | "yield";
    marketCap: number;
    impliedHigh: number;
    /** Positive means inside the range with room; never inferred when blocked. */
    marginOfSafety: number;
  } | null;
  /** Machine-readable reasons; empty only for a clean verdict. */
  blockReasons: ValuationScreenBlockReason[];
  /**
   * Growth reading, always present so a reader can see whether the veto was
   * even available.  `unknown` means no reading, which never blocks.
   */
  growth?: {
    verdict: "supports" | "weakens" | "vetoes" | "unknown" | "not_meaningful";
    ttmGrowth: number | null;
    reportDate: string | null;
    note: string | null;
  };
  /** One line a reader can act on, stating the arithmetic and its limits. */
  note: string;
  /**
   * Always false. A screen is never a trading decision, and this field exists so
   * that any consumer serialising the result carries that fact with it.
   */
  executable: false;
};
