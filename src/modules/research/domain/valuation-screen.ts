/**
 * Machine screening for research candidates — not trading instructions.
 *
 * The daily report has seven action words, and three of them (`consider_buy`,
 * `consider_add`, `consider_trim`) read like instructions.  A machine must not
 * produce them, because it cannot see the two things that make an instruction
 * responsible: how much money the owner has and what the owner already holds.
 * Neither may ever enter the public JSON, so no automated pass can be a trade
 * decision — it can only nominate a company for a human to look at.
 *
 * So this module answers one question and refuses the rest:
 *
 *     given a dated valuation band and a dated quote, is this company inside
 *     its own conservative range with enough margin to be worth studying?
 *
 * What it deliberately does not do:
 *
 * - it does not emit `consider_buy` / `consider_add` / `consider_trim`;
 *   the output vocabulary is `research_candidate` / `watch` / `blocked`,
 *   which has no instruction in it;
 * - it does not size a position, name a target price, or compare against any
 *   holding;
 * - it does not convert currencies by assumption.  A band denominator is in the
 *   reporting currency and a market capitalisation is in the trading currency;
 *   for 友邦保险 those differ (USD reports, HKD trades) and 阿里巴巴 reports in
 *   CNY while trading in HKD. Dividing one by the other without an explicit
 *   rate is a silent 7.8x error, so a currency mismatch is `blocked`, never
 *   "approximately fine";
 * - it does not re-derive the band's implied value from `band.implied`.  That
 *   field is only populated when the band engine already had a quote, so using
 *   it as the comparability test conflates "no quote" with "no valuation" and
 *   reports a missing price as an empty model.  Comparability is decided from
 *   the band's own key and unit, which never depend on a quote.
 *
 * Everything here is derived from data the repository already stores; nothing
 * is fetched, and no number is invented to make a company screenable.
 */

import { assessGrowthAgainstBand } from "./growth-veto.ts";

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

export type ValuationScreenInput = {
  code: string;
  archetype: string;
  /** Bands exactly as `buildValuationBands` emits them. */
  bands: Array<{
    key: string;
    role: "primary" | "auxiliary";
    status: "available" | "insufficient_data" | "forbidden_for_archetype";
    unit: "multiple" | "percent" | null;
    range: { low: number; high: number } | null;
    denominator: { basis: string; value: number; reportDate: string } | null;
  }>;
  /** Currency of the band denominators, as reported. */
  bandCurrency?: string | null;
  quote?: {
    /** Currency of the share price / market cap. */
    currency: string | null;
    priceAsOf: string | null;
    marketCap?: number | null;
  } | null;
  /** Max days between the quote and the statement anchor. */
  maxBasisAgeDays?: number;
  /**
   * Trailing earnings growth, when available.
   *
   * This can only stop a nomination, never create one.  See `growth-veto.ts`
   * for why growth is a veto rather than the band itself: measured on this
   * watchlist it explains 2–13% of the multiple's variation, which is not
   * enough to set the band, but a collapsing denominator is enough to make a
   * low multiple meaningless.
   */
  growth?: {
    ttmGrowth: number;
    reportDate: string;
    provisional?: boolean;
  } | null;
};

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

/**
 * The margin a company must clear before it is worth a human's time.
 *
 * Twenty percent is an assumption, not a finding, and it is stated as one:
 * a company five percent inside its range is noise, because the band itself
 * spans a range of multiples. The threshold is exported so a reviewer can
 * disagree with it explicitly rather than reverse-engineer it.
 */
export const SCREEN_MARGIN_OF_SAFETY = 0.2;

/**
 * A band is a statement-time anchor. Comparing it to a quote from a different
 * quarter measures the quote's drift, not the company's valuation, so a wide
 * gap is reported instead of silently combined.
 */
export const SCREEN_MAX_BASIS_AGE_DAYS = 120;

/**
 * Freshness bound for a through-cycle band.
 *
 * A mid-cycle band is the median of five to ten annual profits. Its newest
 * observation is *supposed* to be the last completed fiscal year, so a
 * 2025-12-31 anchor quoted in October 2026 is correct, not stale — 2026's
 * annual does not exist yet. Holding it to the 120-day trailing-flow bound
 * blocked every cyclical in the watchlist permanently (中远海控, 紫金矿业,
 * 万华化学, 中国海油 …), which reads as "no valuation" when the model is
 * working exactly as designed.
 *
 * So the question for a through-cycle band is different: is a whole annual
 * cycle missing? Fifteen months leaves room for a late filer without silently
 * accepting a band that skipped a year.
 */
export const SCREEN_MAX_THROUGH_CYCLE_AGE_DAYS = 460;

/** Denominators that are a multi-year centre rather than a trailing flow. */
function isThroughCycle(basis: string): boolean {
  return basis === "net_income_mid_cycle" || basis === "ebit_mid_cycle";
}

type ComparableBand = {
  key: string;
  role: "primary" | "auxiliary";
  unit: "multiple" | "percent";
  range: { low: number; high: number };
  denominator: { basis: string; value: number; reportDate: string };
};

/**
 * Preference order among comparable bands.
 *
 * Role alone is not enough: `growth_manufacturing` marks both `pe_ttm` and
 * `fcf_yield` as primary, so two primaries compete.  Earnings-based multiples
 * rank above cash-flow yields because a yield range of 3–6% covers almost every
 * company and therefore discriminates less, and it is the cross-check rather
 * than the anchor.  The order is explicit so a reviewer can argue with it.
 */
const BAND_PREFERENCE = [
  "pe_ttm",
  "pe_mid_cycle",
  "pb",
  "ev_ebit",
  "ev_ebitda",
  "ev_revenue",
  "fcf_yield",
  "dividend_yield",
];

export function screenValuationCandidate(input: ValuationScreenInput): ValuationScreenResult {
  const code = input.code;
  const archetype = input.archetype;
  const growthAssessment = assessGrowthAgainstBand(
    input.growth ? { ttmGrowth: input.growth.ttmGrowth, reportDate: input.growth.reportDate, provisional: input.growth.provisional } : null,
  );
  const growth = {
    verdict: growthAssessment.verdict,
    ttmGrowth: growthAssessment.reading ? growthAssessment.reading.ttmGrowth : null,
    reportDate: growthAssessment.reading ? growthAssessment.reading.reportDate : null,
    note: growthAssessment.note,
  };
  const blocked = (reasons: ValuationScreenBlockReason[], note: string): ValuationScreenResult => ({
    code, archetype, verdict: "blocked", basis: null, position: null, blockReasons: reasons, note, executable: false, growth,
  });

  const usable = input.bands.filter((band) => band.status === "available" && band.denominator && band.range && band.unit);
  if (usable.length === 0) {
    return blocked(["no_available_band"], "本原型没有任何可用区间，估值输入不足。");
  }

  // Comparability comes from the band's own definition, never from whether the
  // engine happened to have a quote.  An EV band's implied value is enterprise
  // value: subtract debt and add cash first, and this repository refuses to
  // compute EV when any debt line is missing, so EV is never compared to a cap.
  const comparable: ComparableBand[] = usable
    .filter((band) => band.unit === "percent" || !band.key.startsWith("ev_"))
    .map((band) => ({
      key: band.key,
      role: band.role,
      unit: band.unit as "multiple" | "percent",
      range: band.range as { low: number; high: number },
      denominator: band.denominator as { basis: string; value: number; reportDate: string },
    }));
  if (comparable.length === 0) {
    return blocked(
      ["no_market_cap_band"],
      "只有 EV 口径区间可用；EV 需先扣有息负债加现金，且本仓库在负债科目不全时拒绝计算，不能直接与市值比较。",
    );
  }

  // A company with no quote at all cannot be screened, and that is a provider
  // fact, not a currency one.
  if (!input.quote) {
    return blocked(["quote_missing"], "缺少同日期行情，无法把区间与市场定价对照；区间本身仍然成立。");
  }

  // Currency is a hard gate, and it is checked before the quote value because
  // it is the more fundamental fact: 阿里巴巴 reports in CNY and trades in HKD;
  // 友邦保险 reports in USD and trades in HKD.  Reporting `quote_missing` first
  // would hide a structural gap behind a provider outage.  Dividing across
  // currencies without an explicit rate is a ~7.8x error that still looks like
  // a number.
  const bandCurrency = normalizeCurrency(input.bandCurrency);
  const quoteCurrency = normalizeCurrency(input.quote.currency);
  if (!bandCurrency || !quoteCurrency) {
    return blocked(["currency_unknown"], "区间分母或行情的币种缺失，无法确认两边同币种；不做隐含换算。");
  }
  if (bandCurrency !== quoteCurrency) {
    return blocked(
      ["currency_mismatch"],
      `区间分母以 ${bandCurrency} 计价、行情以 ${quoteCurrency} 计价；需先取官方汇率换算，本判定不做隐含换算。`,
    );
  }

  const marketCap = positive(input.quote.marketCap) ? (input.quote.marketCap as number) : null;
  if (marketCap === null) {
    return blocked(["quote_missing"], "缺少同日期市值，无法把区间与市场定价对照；区间本身仍然成立。");
  }

  const chosen = pickBand(comparable);
  const reportDate = chosen.denominator.reportDate;

  // A verdict may rest on an auxiliary band only as a *demotion*.  The archetype
  // definition says which methods carry the conclusion, and for an insurer PE is
  // explicitly "辅助，不单独使用" — its denominator is moved by investment returns
  // and reserve assumptions, so a 67% "margin of safety" on PE for 中国平安
  // measured the wrong thing.  When no primary band is computable, the company
  // cannot become a candidate; it stays on watch with the reason named.
  const hasPrimary = comparable.some((band) => band.role === "primary");

  // A trailing-flow band must sit within one quarter of its quote; a
  // through-cycle band is anchored on the last completed fiscal year by
  // design and is measured against a wider bound.
  const throughCycle = isThroughCycle(chosen.denominator.basis);
  const maxAge = input.maxBasisAgeDays ?? (throughCycle ? SCREEN_MAX_THROUGH_CYCLE_AGE_DAYS : SCREEN_MAX_BASIS_AGE_DAYS);
  const ageDays = daysBetween(reportDate, input.quote.priceAsOf ?? null);
  if (ageDays === null) {
    return blocked(["stale_basis"], "缺少报告期或行情日期，无法确认两边是同一时点。");
  }
  if (ageDays > maxAge) {
    return blocked(
      ["stale_basis"],
      throughCycle
        ? `中枢锚点 ${reportDate} 与行情 ${input.quote.priceAsOf} 相隔 ${ageDays} 天（上限 ${maxAge} 天），已缺一个完整年度；此时中枢不代表当前周期位置。`
        : `报表锚点 ${reportDate} 与行情 ${input.quote.priceAsOf} 相隔 ${ageDays} 天（上限 ${maxAge} 天）；此时比较测的是股价漂移，不是公司估值。`,
    );
  }

  const basis = {
    key: chosen.key,
    role: chosen.role,
    reportDate,
    range: { low: chosen.range.low, high: chosen.range.high },
    unit: chosen.unit,
  };

  // A multiple band says "the company is worth between low and high times its
  // denominator"; a yield band says "the flow should be between low and high
  // percent of the price".  The two imply opposite directions, so they are
  // compared separately rather than through a shared formula.
  if (chosen.unit === "percent") {
    const currentYield = (chosen.denominator.value / marketCap) * 100;
    const impliedHigh = (chosen.denominator.value / chosen.range.high) * 100;
    const margin = (currentYield - chosen.range.high) / chosen.range.high;
    const position = { metric: "yield" as const, marketCap, impliedHigh, marginOfSafety: margin };
    if (currentYield < chosen.range.low) {
      return watch(
        `当前收益率 ${currentYield.toFixed(2)}% 低于区间下限 ${chosen.range.low}%（区间 ${chosen.range.low}–${chosen.range.high}%）。`,
        basis,
        position,
      );
    }
    if (margin < SCREEN_MARGIN_OF_SAFETY) {
      return watch(
        `当前收益率 ${currentYield.toFixed(2)}% 在区间内，但高出上限仅 ${(margin * 100).toFixed(1)}%，低于 ${(SCREEN_MARGIN_OF_SAFETY * 100).toFixed(0)}% 门槛。`,
        basis,
        position,
      );
    }
    if (!hasPrimary) {
      return watch(
        `只有辅助方法 ${chosen.key} 可用（当前收益率 ${currentYield.toFixed(2)}%，高出上限 ${(margin * 100).toFixed(1)}%）；该原型的主方法不可计算，辅助方法不单独形成候选。`,
        basis,
        position,
      );
    }
    if (earningsVetoApplies(chosen, growthAssessment)) {
      return blocked(["earnings_shrinking"], `${growthAssessment.note}现金流收益率因此不能单独作为入选依据。`);
    }
    return {
      code, archetype, verdict: "research_candidate", basis, position, blockReasons: [],
      note: `${chosen.key} 当前 ${currentYield.toFixed(2)}%，高出保守上限 ${chosen.range.high}% 达 ${(margin * 100).toFixed(1)}%；这只是研究候选，不是交易指令。`,
      executable: false,
      growth,
    };
  }

  const impliedLow = chosen.denominator.value * chosen.range.low;
  const impliedHigh = chosen.denominator.value * chosen.range.high;
  // Margin of safety is measured against the band's own high end: at the top of
  // the conservative range there is no discount left to be wrong about.
  const margin = (impliedHigh - marketCap) / impliedHigh;
  const position = { metric: metricOf(chosen.key), marketCap, impliedHigh, marginOfSafety: margin };
  if (marketCap > impliedHigh) {
    return watch(
      `市值 ${formatYi(marketCap)} 高于区间上限 ${formatYi(impliedHigh)}（区间 ${chosen.range.low}–${chosen.range.high}x）。`,
      basis,
      position,
    );
  }
  if (margin < SCREEN_MARGIN_OF_SAFETY) {
    return watch(
      `安全边际 ${(margin * 100).toFixed(1)}% 低于 ${(SCREEN_MARGIN_OF_SAFETY * 100).toFixed(0)}% 门槛（市值 ${formatYi(marketCap)}，区间上限 ${formatYi(impliedHigh)}）。`,
      basis,
      position,
    );
  }
  if (!hasPrimary) {
    return watch(
      `只有辅助方法 ${chosen.key} 可用（安全边际 ${(margin * 100).toFixed(1)}%）；该原型的主方法不可计算，辅助方法不单独形成候选。`,
      basis,
      position,
    );
  }
  if (earningsVetoApplies(chosen, growthAssessment)) {
    return blocked(["earnings_shrinking"], `${growthAssessment.note}区间本身成立，但分母在收缩时不能把低倍数当作折价。`);
  }
  return {
    code, archetype, verdict: "research_candidate", basis, position, blockReasons: [],
    note: `${chosen.key} 口径下市值 ${formatYi(marketCap)} 低于区间上限 ${formatYi(impliedHigh)} 约 ${(margin * 100).toFixed(1)}%，达到研究门槛；这只是研究候选，不是交易指令。`,
    executable: false,
    growth,
  };

  function watch(reason: string, basisValue: NonNullable<ValuationScreenResult["basis"]>, positionValue: NonNullable<ValuationScreenResult["position"]>): ValuationScreenResult {
    return {
      code, archetype, verdict: "watch", basis: basisValue, position: positionValue, blockReasons: [],
      note: `${reason}这只是观察项，不是交易指令。`,
      executable: false,
      growth,
    };
  }
}

/**
 * Pick the band a verdict rests on.
 *
 * Preference is: primary before auxiliary, then the declared band order.  The
 * result must be deterministic, because two runs on the same day have to agree
 * — a verdict that flips because a filter reordered an array is not evidence.
 */
function pickBand(bands: ComparableBand[]): ComparableBand {
  const rank = (band: ComparableBand) => {
    const index = BAND_PREFERENCE.indexOf(band.key);
    return index === -1 ? BAND_PREFERENCE.length : index;
  };
  return [...bands].sort((a, b) => {
    if (a.role !== b.role) return a.role === "primary" ? -1 : 1;
    return rank(a) - rank(b);
  })[0];
}

/**
 * Does the growth veto apply to *this* band?
 *
 * Only when the band's denominator is trailing net profit.  A PB band for a
 * bank, an EV/EBITDA band or a NAV band is anchored on something other than
 * trailing earnings, so shrinking profit does not invalidate it in the same
 * way — applying the veto there would block banks and asset-backed companies
 * for a reason that does not touch their multiple.
 */
function earningsVetoApplies(
  chosen: ComparableBand,
  assessment: ReturnType<typeof assessGrowthAgainstBand>,
): boolean {
  if (assessment.verdict !== "vetoes") return false;
  return chosen.denominator.basis === "net_income_ttm";
}

function metricOf(key: string): "pe" | "ev" | "pb" | "yield" {
  if (key.startsWith("pe")) return "pe";
  if (key.startsWith("ev")) return "ev";
  if (key.startsWith("pb")) return "pb";
  return "yield";
}

function formatYi(value: number): string {
  return `${(value / 100_000_000).toFixed(2)} 亿`;
}

/**
 * Normalize the currency spellings this repository actually emits.
 *
 * Eastmoney returns HK reporting currency in Chinese (`人民币` / `美元` / `港元`)
 * while the quote side is `ISO` (`CNY` / `USD` / `HKD`).  Treating those as
 * different currencies would block every HK company for the wrong reason, and
 * treating unknown spellings as matching would let a real mismatch through —
 * so an unrecognised value normalises to null and blocks.
 */
export function normalizeCurrency(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim().toUpperCase();
  if (!text) return null;
  const table: Record<string, string> = {
    CNY: "CNY", RMB: "CNY", "人民币": "CNY", "人民幣": "CNY",
    HKD: "HKD", "港元": "HKD", "港币": "HKD", "港幣": "HKD",
    USD: "USD", "美元": "USD", US$: "USD",
    KRW: "KRW", "韩元": "KRW", "韓元": "KRW",
  };
  return table[text] ?? null;
}

function daysBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.abs(Math.round((end - start) / 86_400_000));
}

function positive(value: number | null | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
