import type { MacroDataPoint, MacroIndicator, MacroIndicatorFrequency } from "./model";

/** Query-time display choices; none of these values are stored in macro_data. */
export type MacroDisplayMeasure = "level" | "yoy" | "mom";
export type MacroDerivedStatus = "available" | "unavailable";
export type MacroDerivedReason = "not_applicable" | "not_configured" | "base_period_missing" | "base_zero";
export type MacroDerivedMeasure = {
  value: number | null;
  basePeriod: string | null;
  basePublishedAt: string | null;
  method: string;
  status: MacroDerivedStatus;
  reason: MacroDerivedReason | null;
};

export type MacroComparisonReason =
  | "metric_mismatch"
  | "definition_mismatch"
  | "statistical_definition_mismatch"
  | "frequency_mismatch"
  | "unit_mismatch";
export type MacroComparisonSafety = {
  /** `comparable` is deliberately stricter than sharing a metric ID. */
  status: "not_requested" | "single_series" | "comparable" | "not_comparable";
  comparedIndicatorIds: number[];
  reasons: MacroComparisonReason[];
};

/**
 * Computes a display measure only after the caller has selected one visible
 * vintage per period for the requested asOf. This keeps the measure layer
 * source-independent and prevents a derived value from becoming a fact row.
 */
export function deriveMacroDisplayMeasure(
  point: MacroDataPoint,
  indicator: MacroIndicator,
  measure: Exclude<MacroDisplayMeasure, "level">,
  byPeriod: ReadonlyMap<number, MacroDataPoint>,
): MacroDerivedMeasure {
  const method = measure === "yoy" ? indicator.yoyMethod : indicator.momMethod;
  const basePeriods = measure === "yoy" ? indicator.yoyBasePeriods : indicator.momBasePeriods;
  if (method === "native") return available(point.value, null, null, method);
  if (method !== "percent_change" && method !== "annualized_percent_change" && method !== "percentage_point_change") {
    return unavailable(method, method === "not_applicable" ? "not_applicable" : "not_configured");
  }
  if (basePeriods < 1) return unavailable(method, "not_configured");

  const expectedBasePeriod = shiftMacroPeriodDay(point.periodDay, indicator.frequency, -basePeriods);
  const base = byPeriod.get(expectedBasePeriod);
  if (!base) return {
    value: null, basePeriod: periodDayToIso(expectedBasePeriod), basePublishedAt: null, method,
    status: "unavailable", reason: "base_period_missing",
  };
  if ((method === "percent_change" || method === "annualized_percent_change") && base.value === 0) {
    return unavailable(method, "base_zero", periodDayToIso(base.periodDay), timestampToIso(base.publishedAt));
  }
  if (method === "annualized_percent_change" && (point.value / base.value) < 0) {
    // A fractional annualization exponent is undefined across a sign change.
    return unavailable(method, "base_zero", periodDayToIso(base.periodDay), timestampToIso(base.publishedAt));
  }

  const value = method === "percent_change"
    ? (point.value / base.value - 1) * 100
    : method === "annualized_percent_change"
      ? (Math.pow(point.value / base.value, periodsPerYear(indicator.frequency) / basePeriods) - 1) * 100
      : point.value - base.value;
  return available(value, periodDayToIso(base.periodDay), timestampToIso(base.publishedAt), method);
}

/**
 * The current schema has no compatibility-key column. Until T1 introduces an
 * explicit declaration, this is intentionally conservative: comparisons need
 * the same metric, definition ID, definition text, frequency, and unit.
 */
export function assessMacroComparisonSafety(series: readonly MacroIndicator[]): MacroComparisonSafety {
  const comparedIndicatorIds = series.map((indicator) => indicator.id);
  if (series.length === 0) return { status: "not_requested", comparedIndicatorIds, reasons: [] };
  if (series.length === 1) return { status: "single_series", comparedIndicatorIds, reasons: [] };

  const reference = series[0];
  const reasons = new Set<MacroComparisonReason>();
  for (const candidate of series.slice(1)) {
    if (candidate.metricId !== reference.metricId) reasons.add("metric_mismatch");
    if (candidate.definitionId !== reference.definitionId) reasons.add("definition_mismatch");
    if (candidate.statisticalDefinition !== reference.statisticalDefinition) reasons.add("statistical_definition_mismatch");
    if (candidate.frequency !== reference.frequency) reasons.add("frequency_mismatch");
    if (candidate.unit !== reference.unit || candidate.unitFormat !== reference.unitFormat) reasons.add("unit_mismatch");
  }
  return { status: reasons.size ? "not_comparable" : "comparable", comparedIndicatorIds, reasons: [...reasons] };
}

function available(value: number, basePeriod: string | null, basePublishedAt: string | null, method: string): MacroDerivedMeasure {
  return { value, basePeriod, basePublishedAt, method, status: "available", reason: null };
}

function unavailable(method: string, reason: MacroDerivedReason, basePeriod: string | null = null, basePublishedAt: string | null = null): MacroDerivedMeasure {
  return { value: null, basePeriod, basePublishedAt, method, status: "unavailable", reason };
}

function periodsPerYear(frequency: MacroIndicatorFrequency): number {
  switch (frequency) {
    case "daily": return 365;
    case "weekly": return 52;
    case "monthly": return 12;
    case "quarterly": return 4;
    case "annual": return 1;
  }
}

/** Shifts exact period starts; it never substitutes a nearby observation. */
export function shiftMacroPeriodDay(periodDay: number, frequency: MacroIndicatorFrequency, periods: number): number {
  const iso = periodDayToIso(periodDay);
  if (!iso) throw new Error(`invalid macro period day: ${periodDay}`);
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  if (frequency === "daily") return dateToPeriodDay(new Date(Date.UTC(year, month - 1, day + periods)));
  if (frequency === "weekly") return dateToPeriodDay(new Date(Date.UTC(year, month - 1, day + periods * 7)));
  const monthDelta = frequency === "monthly" ? periods : frequency === "quarterly" ? periods * 3 : periods * 12;
  const shifted = new Date(Date.UTC(year, month - 1 + monthDelta, 1));
  return shifted.getUTCFullYear() * 10_000 + (shifted.getUTCMonth() + 1) * 100 + 1;
}

export function periodDayToIso(periodDay: number): string | null {
  const text = String(periodDay);
  if (!/^\d{8}$/.test(text)) return null;
  const iso = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(iso) ? iso : null;
}

export function timestampToIso(seconds: number): string { return new Date(seconds * 1000).toISOString(); }

function dateToPeriodDay(date: Date): number { return date.getUTCFullYear() * 10_000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate(); }
