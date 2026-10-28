/**
 * Growth as a veto on the PE band — not as the band itself.
 *
 * The proposal that led here was to set the PE band from the growth rate: a 30%
 * grower deserves a higher multiple than a 5% grower, so why apply one number to
 * both.  The premise is right and the mechanism is wrong, and the difference was
 * measurable on this watchlist.
 *
 * Measured on 2026-10-28, current TTM growth against current PE:
 *
 *     pooled cross-section, 83 companies, R² of log PE
 *       PEG normalised  PE = k·g        0.025
 *       log PE linear in growth         0.021
 *       Gordon          PE = 1/(r−g)    0.020
 *       constant multiple (status quo)  0.000
 *
 *   within an archetype, weighted mean R²
 *       PEG                             0.128
 *       linear in growth                0.111
 *       Gordon                          0.063
 *
 *   growth_manufacturing, n=23          0.02
 *
 * So growth explains 2–13% of the multiple's variation, and in the largest
 * archetype almost nothing.  Fitting PE to growth would mean replacing a stated
 * constant with a formula whose error is 98% noise — and it would do so for
 * every verdict at once.  Growth is therefore not used to *set* the band.
 *
 * What growth does support is a separate, weaker claim that is worth acting on:
 *
 *     a multiple is only cheap if the earnings behind it are not collapsing.
 *
 * The pool makes the case sharply.  Before the veto existed, the screen
 * nominated 13 companies; 10 of them on a PE band, and five of those ten had
 * shrinking trailing profit:
 *
 *     格力电器   PE  8.4   growth −21.7%
 *     泸州老窖   PE 13.7   growth −42.7%
 *     阳光电源   PE 13.0   growth −20.5%
 *     海尔智家   PE 10.2   growth −12.4%
 *     徐工机械   PE 13.4   growth  −7.2%
 *
 * A declining PE on declining earnings is not a discount, it is the numerator
 * and denominator falling together — the classic value trap.  A constant band
 * cannot see this, which is a real defect in the current rule and the part of
 * the original intuition that the data does support.
 *
 * Applying the veto on identical quotes takes 13 candidates to 10: 格力电器,
 * 泸州老窖 and 阳光电源 cross the −15% threshold, while 海尔智家 (−12.4%) and
 * 徐工机械 (−7.2%) do not.  That is the threshold doing its job, not a miss —
 * the line has to sit somewhere, and it sits where a rate is large enough that
 * the denominator itself is in question.
 *
 * So growth enters as a **veto**: it can stop a company from being nominated,
 * and it can never by itself promote one.  That direction is deliberate — a
 * veto can only make the screen more conservative, so an error in the growth
 * reading costs a missed candidate rather than a false one.
 *
 * Coverage is a real limit and is reported rather than papered over: 90 of 97
 * companies have TTM growth, but 9 US filers still quote a stale December
 * annual, and 7 have no usable figure at all.  Absent growth never blocks — it
 * cannot, because that would turn a data gap into a verdict about the company.
 *
 * Read-only. No price, no target, no instruction.
 */

/** Below this trailing growth rate, cheap-looking earnings are treated as eroding. */
export const SHRINKING_EARNINGS_THRESHOLD = -0.15;

/** Growth worse than this is reported even when it does not veto. */
export const WEAK_GROWTH_THRESHOLD = -0.05;

/**
 * Above this, a trailing growth rate is not read as a growth rate.
 *
 * 拉卡拉 is the live case for a distorted base: its TTM profit went from 1.77 亿
 * to 17.0 亿, which reads as +857%.  The cause is a one-off gain inside a single
 * 2025 quarter (8.32 亿 against ~1 亿 in the other three), which depressed the
 * base the comparison divides by.
 *
 * The ceiling is not the same claim as "this is a fake number".  On the same day
 * 中际旭创 read +200% and 寒武纪 +122%, and both look like genuine growth.  The
 * point is that a single TTM rate cannot tell a one-off base from a genuine
 * acceleration, so above the ceiling it is not used as evidence in either
 * direction — reported as `not_meaningful`, which carries the same consequence as
 * `unknown`: no veto, and no credit.  Distinguishing the two cases needs the
 * filings, not a bigger number.
 */
export const IMPLAUSIBLE_GROWTH_THRESHOLD = 1.0;

export type GrowthReading = {
  /** TTM net-profit growth as a fraction (−0.217 = −21.7%). */
  ttmGrowth: number;
  /** Report date the trailing figure ends at. */
  reportDate: string;
  /** True when the newest period came from a forecast or express report. */
  provisional?: boolean;
};

export type GrowthVerdict =
  /** Growth is fine, or good enough that it says nothing against the band. */
  | "supports"
  /** Shrinking, but not enough to override the band on its own. */
  | "weakens"
  /** Shrinking fast enough that a low multiple must not be read as a discount. */
  | "vetoes"
  /** No growth reading available; says nothing either way. Never a veto. */
  | "unknown"
  /** Above the plausibility ceiling — the rate reflects a distorted base, not the business. */
  | "not_meaningful";

export type GrowthAssessment = {
  verdict: GrowthVerdict;
  reading: GrowthReading | null;
  threshold: number;
  /** One sentence a reviewer can argue with, or null when there is nothing to say. */
  note: string | null;
};

/**
 * Classify a growth reading against the band.
 *
 * The asymmetry is the point: `vetoes` exists, `promotes` does not.  A company
 * growing 60% is not made a candidate by that fact — the band still has to be
 * satisfied — but a company shrinking 22% is stopped even when the band is
 * satisfied, because the band's denominator is the thing that is shrinking.
 */
export function assessGrowthAgainstBand(reading: GrowthReading | null | undefined): GrowthAssessment {
  if (!reading || !Number.isFinite(reading.ttmGrowth)) {
    return {
      verdict: "unknown",
      reading: null,
      threshold: SHRINKING_EARNINGS_THRESHOLD,
      note: null,
    };
  }
  const growth = reading.ttmGrowth;
  const asPct = `${(growth * 100).toFixed(1)}%`;
  const source = reading.provisional ? "业绩快报/预告口径" : "正式报告口径";

  if (growth <= SHRINKING_EARNINGS_THRESHOLD) {
    return {
      verdict: "vetoes",
      reading,
      threshold: SHRINKING_EARNINGS_THRESHOLD,
      note: `TTM 净利润同比 ${asPct}（${source}，截至 ${reading.reportDate}），低于 ${(SHRINKING_EARNINGS_THRESHOLD * 100).toFixed(0)}% 门槛；`
        + "此时低 PE 是分子分母同时下降，不能当作折价。",
    };
  }
  if (growth < WEAK_GROWTH_THRESHOLD) {
    return {
      verdict: "weakens",
      reading,
      threshold: SHRINKING_EARNINGS_THRESHOLD,
      note: `TTM 净利润同比 ${asPct}（${source}，截至 ${reading.reportDate}），利润在小幅收缩，需确认是一次性因素还是趋势。`,
    };
  }
  if (growth >= IMPLAUSIBLE_GROWTH_THRESHOLD) {
    return {
      verdict: "not_meaningful",
      reading,
      threshold: SHRINKING_EARNINGS_THRESHOLD,
      note: `TTM 净利润同比 ${asPct}（${source}，截至 ${reading.reportDate}），超过 ${(IMPLAUSIBLE_GROWTH_THRESHOLD * 100).toFixed(0)}% 上限；`
        + "这个量级无法只凭一个 TTM 数字区分「基期一次性损益」与「真实加速」（同期中际旭创 +200%、寒武纪 +122% 属真实增长），"
        + "因此既不支持也不否决区间，需查一手财报。",
    };
  }
  return {
    verdict: "supports",
    reading,
    threshold: SHRINKING_EARNINGS_THRESHOLD,
    note: null,
  };
}

/** True only for the one verdict that may stop a nomination. */
export function growthVetoesNomination(assessment: GrowthAssessment): boolean {
  return assessment.verdict === "vetoes";
}
