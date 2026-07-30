export type DatedValue = { date: string; value: number };
export type NullableDatedValue = { date: string; value: number | null };
export type SeriesTransform = "level" | "mom" | "yoy" | "zscore" | "percentile";

export function transformSeries(
  input: readonly DatedValue[],
  transform: SeriesTransform,
  options: { window?: number } = {}
): NullableDatedValue[] {
  const points = normalizePoints(input);
  if (transform === "level") return points;
  if (transform === "mom") return calendarPercentChange(points, 1);
  if (transform === "yoy") return calendarPercentChange(points, 12);
  const window = Math.max(2, Math.floor(options.window ?? 60));
  return transform === "zscore"
    ? rollingZScore(points, window)
    : rollingPercentile(points, window);
}

export function normalizePoints(input: readonly DatedValue[]): DatedValue[] {
  const byDate = new Map<string, number>();
  for (const point of input) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(point.date) && Number.isFinite(point.value)) {
      byDate.set(point.date, point.value);
    }
  }
  return [...byDate].sort(([left], [right]) => left.localeCompare(right))
    .map(([date, value]) => ({ date, value }));
}

export function calendarPercentChange(points: readonly DatedValue[], months: number): NullableDatedValue[] {
  const normalized = normalizePoints(points);
  return normalized.map((point, index) => {
    const target = shiftUtcMonths(point.date, -months);
    const base = latestOnOrBefore(normalized, target, index);
    const value = base && base.value !== 0 ? ((point.value / base.value) - 1) * 100 : null;
    return { date: point.date, value: finiteOrNull(value) };
  });
}

export function rollingZScore(points: readonly DatedValue[], window: number): NullableDatedValue[] {
  const normalized = normalizePoints(points);
  const size = Math.max(2, Math.floor(window));
  return normalized.map((point, index) => {
    const values = normalized.slice(Math.max(0, index - size + 1), index + 1).map((item) => item.value);
    if (values.length < 2) return { date: point.date, value: null };
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    const deviation = Math.sqrt(variance);
    return { date: point.date, value: deviation === 0 ? 0 : (point.value - mean) / deviation };
  });
}

export function rollingPercentile(points: readonly DatedValue[], window: number): NullableDatedValue[] {
  const normalized = normalizePoints(points);
  const size = Math.max(2, Math.floor(window));
  return normalized.map((point, index) => {
    const values = normalized.slice(Math.max(0, index - size + 1), index + 1).map((item) => item.value);
    if (values.length < 2) return { date: point.date, value: null };
    const below = values.filter((value) => value < point.value).length;
    const equal = values.filter((value) => value === point.value).length;
    return { date: point.date, value: ((below + equal * 0.5) / values.length) * 100 };
  });
}

function latestOnOrBefore(points: readonly DatedValue[], target: string, beforeIndex: number): DatedValue | null {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    if (points[index].date <= target) return points[index];
  }
  return null;
}

function shiftUtcMonths(date: string, months: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  // Resolve against the end of the target calendar month. This lets a monthly
  // series compare Jan 30 with Feb 28 without accidentally falling back a year.
  const monthEnd = new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + months + 1, 0));
  return monthEnd.toISOString().slice(0, 10);
}

function finiteOrNull(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null;
}
