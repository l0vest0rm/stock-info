/**
 * Mid-cycle earnings for cyclical archetypes.
 *
 * A cyclical is priced off the level its earnings revert to, not off today's
 * print.  Using TTM net profit for 中远海控 in a freight boom, or for 万华化学
 * at a chemical up-cycle, embeds the peak into the denominator and makes the
 * company look permanently cheap.
 *
 * Rules this module enforces:
 * - Only annual reports are used.  Interim rows are cumulative and a mid-year
 *   figure would quietly weight the most recent year twice.
 * - A year is used only when the annual statement is present AND the retained
 *   profit is a real number.  A missing year is reported, never interpolated.
 * - At least `MIN_YEARS` annual observations are required.  Below that the
 *   result is `insufficient_data`; the module never pads the series with TTM or
 *   quarterly numbers to reach the threshold.
 * - Two centres are exposed: the arithmetic mean (simple, transparent) and the
 *   median (robust to a single spike).  Both are reported because the gap
 *   between them is itself the signal — a wide gap means one year dominates.
 * - Loss years are kept.  Dropping them would overstate the centre, which is
 *   exactly the failure mode this module exists to prevent.
 */

export const MID_CYCLE_MIN_YEARS = 5;
export const MID_CYCLE_MAX_YEARS = 10;

export type MidCycleYear = {
  fiscalYear: number;
  /** Annual profit under the requested basis, in statement currency. */
  value: number;
  reportDate: string;
};

export type MidCycleEarningsStatus = "available" | "insufficient_data";

export type MidCycleEarnings = {
  status: MidCycleEarningsStatus;
  basis: "net_income_parent" | "net_income_total" | "ebit";
  /** Which years fed the calculation, oldest first. */
  years: MidCycleYear[];
  /** Years requested but absent or unusable, newest first; never filled in. */
  missingYears: number[];
  /** Calendar window actually requested, e.g. `2016..2025`. */
  window: string;
  mean: number | null;
  median: number | null;
  min: number | null;
  max: number | null;
  /** Spread of the observed years relative to the centre; a volatility read. */
  coefficientOfVariation: number | null;
  /** Loss years inside the window, kept on purpose. */
  lossYears: number[];
  /** Highest year divided by the centre; >2.5 means one cycle dominates. */
  peakToCentre: number | null;
  /** Why the centre is unusable or which caveats apply.  Always populated. */
  notes: string[];
};

/** One annual income statement, already reduced to the fields this module needs. */
export type AnnualEarningsRow = {
  reportDate: string;
  /** True only for a formal annual report (12-31 or an explicit FY flag). */
  isAnnual: boolean;
  parentNetProfit: number | null;
  netProfit: number | null;
  operatingProfit: number | null;
  investIncome: number | null;
  fairValueChangeIncome: number | null;
};

export type MidCycleInput = {
  rows: AnnualEarningsRow[];
  /** Last fiscal year to attempt. Defaults to the newest annual row's year. */
  latestFiscalYear?: number;
  /** How many fiscal years the window spans, default 10, clamped to [5, 10]. */
  years?: number;
  basis?: MidCycleEarnings["basis"];
};

export function buildMidCycleEarnings(input: MidCycleInput): MidCycleEarnings {
  const basis = input.basis ?? "net_income_parent";
  const annual = input.rows.filter((row) => row.isAnnual && isFiscalYearEnd(row.reportDate));
  const byYear = new Map<number, AnnualEarningsRow>();
  for (const row of annual) {
    const year = Number(row.reportDate.slice(0, 4));
    // Keep the first occurrence: the provider returns the newest revision first.
    if (!byYear.has(year)) byYear.set(year, row);
  }
  const newestYear = Math.max(...byYear.keys());
  const latestFiscalYear = input.latestFiscalYear ?? (Number.isFinite(newestYear) ? newestYear : new Date().getFullYear() - 1);
  const span = Math.min(Math.max(input.years ?? MID_CYCLE_MAX_YEARS, MID_CYCLE_MIN_YEARS), MID_CYCLE_MAX_YEARS);
  const firstYear = latestFiscalYear - span + 1;
  const window = `${firstYear}..${latestFiscalYear}`;

  const years: MidCycleYear[] = [];
  const missingYears: number[] = [];
  for (let year = latestFiscalYear; year >= firstYear; year -= 1) {
    const row = byYear.get(year);
    const value = row ? valueOf(row, basis) : null;
    if (value === null) {
      missingYears.push(year);
    } else {
      years.push({ fiscalYear: year, value, reportDate: row!.reportDate });
    }
  }
  years.sort((left, right) => left.fiscalYear - right.fiscalYear);

  const notes: string[] = [];
  if (missingYears.length > 0) {
    notes.push(`窗口内缺 ${missingYears.length} 个年度（${missingYears.join("、")}），未插值、未用季度或 TTM 补齐。`);
  }

  if (years.length < MID_CYCLE_MIN_YEARS) {
    notes.push(`可用年报仅 ${years.length} 个，少于中枢所需的最少 ${MID_CYCLE_MIN_YEARS} 个，不给中枢值。`);
    return {
      status: "insufficient_data",
      basis,
      years,
      missingYears,
      window,
      mean: null,
      median: null,
      min: null,
      max: null,
      coefficientOfVariation: null,
      lossYears: [],
      peakToCentre: null,
      notes,
    };
  }

  const values = years.map((year) => year.value);
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  const sorted = [...values].sort((left, right) => left - right);
  const median = sorted.length % 2 === 1
    ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length;
  const coefficientOfVariation = Math.abs(mean) > 0 ? Math.sqrt(variance) / Math.abs(mean) : null;
  const lossYears = years.filter((year) => year.value < 0).map((year) => year.fiscalYear);
  const peakToCentre = median > 0 ? max / median : null;

  if (lossYears.length > 0) {
    notes.push(`窗口内有 ${lossYears.length} 个亏损年度（${lossYears.join("、")}），亏损年已计入中枢，不能剔除。`);
  }
  if (mean !== null && median !== null && mean > 0 && Math.abs(mean - median) / mean > 0.3) {
    notes.push(`均值与中位数相差 ${((Math.abs(mean - median) / mean) * 100).toFixed(0)}%，说明单一年份主导，优先参考中位数。`);
  }
  if (coefficientOfVariation !== null && coefficientOfVariation > 0.5) {
    notes.push(`年度利润变异系数 ${coefficientOfVariation.toFixed(2)}，周期波动极大，中枢本身的不确定性很高。`);
  }
  if (peakToCentre !== null && peakToCentre > 2.5) {
    notes.push(`峰值是中枢的 ${peakToCentre.toFixed(1)} 倍，TTM 若处在峰值附近会严重低估倍数。`);
  }
  notes.push("周期中枢用年报口径，仅适用于业务模型被判定为周期型的公司；非周期公司使用中枢会抹掉真实成长。");

  return {
    status: "available",
    basis,
    years,
    missingYears,
    window,
    mean,
    median,
    min,
    max,
    coefficientOfVariation,
    lossYears,
    peakToCentre,
    notes,
  };
}

function valueOf(row: AnnualEarningsRow, basis: MidCycleEarnings["basis"]): number | null {
  if (basis === "net_income_parent") return finite(row.parentNetProfit) ?? finite(row.netProfit);
  if (basis === "net_income_total") return finite(row.netProfit) ?? finite(row.parentNetProfit);
  // EBIT proxy must match the valuation-inputs definition: operating profit net
  // of investment income and fair-value changes.
  const operating = finite(row.operatingProfit);
  if (operating === null) return null;
  return operating - (finite(row.investIncome) ?? 0) - (finite(row.fairValueChangeIncome) ?? 0);
}

function finite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isFiscalYearEnd(reportDate: string): boolean {
  return /^\d{4}-12-31$/.test(reportDate);
}
