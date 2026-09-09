import { Hono } from "hono";
import { D1MacroRepository } from "../application/macro-repository";
import { syncMacroData } from "../application/sync-macro-data";
import type { MacroDataPoint, MacroIndicator } from "../domain/model";
import {
  assessMacroComparisonSafety,
  deriveMacroDisplayMeasure,
  periodDayToIso,
  shiftMacroPeriodDay,
  timestampToIso,
  type MacroDisplayMeasure,
} from "../domain/display-measures";
import { fail, ok } from "../../../shared/http";
import { isLocalDevelopmentRuntime } from "../../../shared/request";
import { isTaskdReadUnavailable } from "../../../shared/taskd-client";
import type { AppEnv } from "../../../types";
import { enqueueMacroAnalysis, loadMacroAnalysis, resumeMacroAnalysis, syncMacroAnalysis } from "../application/macro-analysis";

const MAX_INDICATORS_PER_REQUEST = 20;
const MAX_FILTER_VALUES = 100;
/** Must stay aligned with D1MacroRepository.getLatestSnapshots' public ID bound. */
const MAX_LATEST_SNAPSHOT_IDS_PER_QUERY = 200;
const MEASURES = new Set(["level", "yoy", "mom"]);

type Measure = MacroDisplayMeasure;

export const macroRoutes = new Hono<AppEnv>();

macroRoutes.get("/macro/analysis", async (c) => {
  try {
    return ok(c, await loadMacroAnalysis(c.env));
  } catch (error) {
    return fail(c, 400, error instanceof Error ? error.message : String(error));
  }
});

macroRoutes.post("/macro/analysis/refresh", async (c) => {
  if (c.env.LLM_RUNTIME !== "local") return fail(c, 404, "macro analysis refresh is only available in local LLM runtime");
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  try {
    return ok(c, await enqueueMacroAnalysis(c.env, { reasoningEffort: typeof body.reasoningEffort === "string" ? body.reasoningEffort : null }));
  } catch (error) {
    return fail(c, 400, error instanceof Error ? error.message : String(error));
  }
});

macroRoutes.post("/macro/analysis/resume", async (c) => {
  if (c.env.LLM_RUNTIME !== "local") return fail(c, 404, "macro analysis resume is only available in local LLM runtime");
  try {
    return ok(c, await resumeMacroAnalysis(c.env));
  } catch (error) {
    return fail(c, 400, error instanceof Error ? error.message : String(error));
  }
});

macroRoutes.post("/macro/analysis/sync", async (c) => {
  if (c.env.LLM_RUNTIME !== "local") return fail(c, 404, "macro analysis synchronization is only available in local LLM runtime");
  try {
    return ok(c, await syncMacroAnalysis(c.env));
  } catch (error) {
    if (isTaskdReadUnavailable(error)) return fail(c, 503, "暂时无法连接 taskd；本地任务状态未改变，请稍后再同步。");
    return fail(c, 400, error instanceof Error ? error.message : String(error));
  }
});

/** Directory only: loading selectors must never scan macro_data history. */
macroRoutes.get("/macro/catalog", async (c) => {
  const catalog = await new D1MacroRepository(c.env.DB).listCatalog();
  return ok(c, {
    generatedAt: new Date().toISOString(),
    regions: catalog.regions,
    categories: catalog.categories,
    metrics: catalog.metrics,
    series: catalog.series.map(toDefinition),
    capabilities: catalog.capabilities,
  });
});

/** Compact card data; it uses an ID-bounded snapshot plus a limited lookback. */
macroRoutes.get("/macro/overview", async (c) => {
  const regions = parseCsv(c.req.query("regions"));
  const categories = parseCsv(c.req.query("categories"));
  if (regions === null || categories === null) return fail(c, 400, `filters may contain at most ${MAX_FILTER_VALUES} values`);
  const requestedAsOf = parseTimestamp(c.req.query("asOf"));
  if (c.req.query("asOf") && requestedAsOf === null) return fail(c, 400, "invalid asOf timestamp");
  const asOf = requestedAsOf ?? nowSeconds();

  const repository = new D1MacroRepository(c.env.DB);
  const catalog = await repository.listCatalog();
  const selected = catalog.series.filter((indicator) =>
    (regions.length === 0 || regions.includes(indicator.regionCode))
    && (categories.length === 0 || categories.includes(indicator.categoryCode) || categories.includes(String(indicator.categoryId))),
  );
  const snapshots = new Map((await getLatestSnapshotsInBatches(repository, selected.map((indicator) => indicator.id), asOf))
    .map((point) => [point.indicatorId, point]));
  const series = await Promise.all(selected.map((indicator) =>
    toOverviewEntry(repository, indicator, snapshots.get(indicator.id) ?? null, asOf),
  ));
  return ok(c, { generatedAt: new Date().toISOString(), asOf: timestampToIso(asOf), regions, categories, series });
});

/**
 * The repository deliberately bounds a single snapshot query to keep its SQL
 * parameter count predictable. The overview is catalog-driven, though, so a
 * newly added directory must not become unusable once it contains more IDs.
 * Keeping the batches sequential makes DB pressure bounded while preserving
 * the catalog's deterministic response order below.
 */
async function getLatestSnapshotsInBatches(repository: D1MacroRepository, indicatorIds: readonly number[], asOf: number) {
  const snapshots: MacroDataPoint[] = [];
  for (let start = 0; start < indicatorIds.length; start += MAX_LATEST_SNAPSHOT_IDS_PER_QUERY) {
    snapshots.push(...await repository.getLatestSnapshots(
      indicatorIds.slice(start, start + MAX_LATEST_SNAPSHOT_IDS_PER_QUERY),
      asOf,
    ));
  }
  return snapshots;
}

/** Detail history is windowed: `from` and `to` are required by contract. */
macroRoutes.get("/macro/series", async (c) => {
  const ids = parseIndicatorIds(c.req.query("ids"));
  if (ids === null) return fail(c, 400, "ids must be positive integer indicator IDs");
  if (ids.length === 0) return fail(c, 400, "Missing ids parameter");
  if (ids.length > MAX_INDICATORS_PER_REQUEST) return fail(c, 400, `Too many indicators; maximum is ${MAX_INDICATORS_PER_REQUEST}`);
  const from = parsePeriodDay(c.req.query("from"));
  const to = parsePeriodDay(c.req.query("to"));
  if (from === null || to === null) return fail(c, 400, "from and to dates are required");
  if (from > to) return fail(c, 400, "from must not be after to");
  const requestedAsOf = parseTimestamp(c.req.query("asOf"));
  if (c.req.query("asOf") && requestedAsOf === null) return fail(c, 400, "invalid asOf timestamp");
  const measure = (c.req.query("measure") ?? c.req.query("transform") ?? "level").trim();
  if (!MEASURES.has(measure)) return fail(c, 400, "measure must be level, yoy, or mom");
  const asOf = requestedAsOf ?? nowSeconds();

  const repository = new D1MacroRepository(c.env.DB);
  const catalog = await repository.listCatalog();
  const byId = new Map(catalog.series.map((indicator) => [indicator.id, indicator]));
  const unknown = ids.filter((id) => !byId.has(id));
  if (unknown.length) return fail(c, 400, `Unknown macro indicator IDs: ${unknown.join(", ")}`);
  const series = await Promise.all(ids.map(async (id) => {
    const indicator = byId.get(id)!;
    // A level trend can expose its matching YoY/MoM in a tooltip without
    // another request, but derived values still need their exact base periods.
    const lookupFrom = (["yoy", "mom"] as const).reduce((earliest, derivedMeasure) => {
      const basePeriods = basePeriodsFor(indicator, derivedMeasure);
      return basePeriods > 0 ? Math.min(earliest, shiftMacroPeriodDay(from, indicator.frequency, -basePeriods)) : earliest;
    }, from);
    const raw = await repository.getDataSeries(id, { fromPeriodDay: lookupFrom, toPeriodDay: to, asOf });
    const byPeriod = new Map(raw.map((point) => [point.periodDay, point]));
    const points = raw.filter((point) => point.periodDay >= from)
      .map((point) => toSeriesPoint(point, indicator, measure as Measure, byPeriod));
    return { definition: toDefinition(indicator), measure, points };
  }));
  return ok(c, {
    generatedAt: new Date().toISOString(), asOf: timestampToIso(asOf), series,
    // `/macro/series` already accepts multiple IDs, so parallel histories are
    // never mistaken for a safe merged comparison by an API consumer.
    comparison: assessMacroComparisonSafety(ids.map((id) => byId.get(id)!)),
  });
});

macroRoutes.post("/macro/sync", async (c) => {
  if (!isLocalDevelopmentRuntime(c.env)) return fail(c, 404, "macro sync endpoint is only available in local development");
  return ok(c, await syncMacroData(c.env));
});

async function toOverviewEntry(repository: D1MacroRepository, indicator: MacroIndicator, latest: MacroDataPoint | null, asOf: number) {
  const definition = toDefinition(indicator);
  const availability = availabilityFor(indicator, latest);
  if (!latest) return {
    definition, current: null,
    yoy: unavailableForAvailability(indicator.yoyMethod, availability.reason ?? "awaiting_data"),
    mom: unavailableForAvailability(indicator.momMethod, availability.reason ?? "awaiting_data"),
    freshness: { status: "missing", ageSeconds: null, staleAfterSeconds: indicator.staleAfterSeconds },
    availability,
    trend: { status: "unavailable", reason: availability.reason, defaultPeriods: indicator.defaultTrendPeriods, points: [] },
  };

  const trendPeriods = boundedTrendPeriods(indicator.defaultTrendPeriods);
  const yoyBasePeriods = basePeriodsFor(indicator, "yoy");
  const momBasePeriods = basePeriodsFor(indicator, "mom");
  const readStart = Math.min(
    shiftMacroPeriodDay(latest.periodDay, indicator.frequency, -(trendPeriods - 1)),
    yoyBasePeriods > 0 ? shiftMacroPeriodDay(latest.periodDay, indicator.frequency, -yoyBasePeriods) : latest.periodDay,
    momBasePeriods > 0 ? shiftMacroPeriodDay(latest.periodDay, indicator.frequency, -momBasePeriods) : latest.periodDay,
  );
  const raw = await repository.getDataSeries(indicator.id, { fromPeriodDay: readStart, toPeriodDay: latest.periodDay, asOf });
  const byPeriod = new Map(raw.map((point) => [point.periodDay, point]));
  // The snapshot is authoritative if a new revision appears between reads.
  byPeriod.set(latest.periodDay, latest);
  const trendStart = shiftMacroPeriodDay(latest.periodDay, indicator.frequency, -(trendPeriods - 1));
  const trendPoints = raw.filter((point) => point.periodDay >= trendStart && point.periodDay <= latest.periodDay).map(toRawPoint);
  const ageSeconds = Math.max(0, asOf - latest.publishedAt);
  return {
    definition,
    current: toRawPoint(latest),
    yoy: derivePoint(latest, indicator, "yoy", byPeriod),
    mom: derivePoint(latest, indicator, "mom", byPeriod),
    freshness: { status: ageSeconds > indicator.staleAfterSeconds ? "stale" : "fresh", ageSeconds, staleAfterSeconds: indicator.staleAfterSeconds },
    availability,
    trend: trendPoints.length >= 2
      ? { status: "available", reason: null, defaultPeriods: trendPeriods, points: trendPoints }
      : { status: "unavailable", reason: "insufficient_history", defaultPeriods: trendPeriods, points: trendPoints },
  };
}

function toSeriesPoint(point: MacroDataPoint, indicator: MacroIndicator, measure: Measure, byPeriod: ReadonlyMap<number, MacroDataPoint>) {
  const displayed = measure === "level"
    ? { value: point.value, method: "level", status: "available" as const, reason: null }
    : derivePoint(point, indicator, measure, byPeriod);
  return {
    ...toRawPoint(point),
    ...displayed,
    derived: {
      yoy: derivePoint(point, indicator, "yoy", byPeriod),
      mom: derivePoint(point, indicator, "mom", byPeriod),
    },
  };
}

function derivePoint(point: MacroDataPoint, indicator: MacroIndicator, measure: Exclude<Measure, "level">, byPeriod: ReadonlyMap<number, MacroDataPoint>) {
  return deriveMacroDisplayMeasure(point, indicator, measure, byPeriod);
}

function unavailableForAvailability(method: string, reason: "unmapped" | "awaiting_first_release" | "awaiting_data") {
  return { value: null, basePeriod: null, basePublishedAt: null, method, status: "unavailable" as const, reason };
}

function availabilityFor(indicator: MacroIndicator, latest: MacroDataPoint | null) {
  if (latest) return { status: "available" as const, reason: null };
  if (!indicator.sourceId) return { status: "unmapped" as const, reason: "unmapped" as const };
  if (indicator.lastSuccessAt === null) return { status: "awaiting_first_release" as const, reason: "awaiting_first_release" as const };
  return { status: "awaiting_data" as const, reason: "awaiting_data" as const };
}

/** Scheduler state and provider errors intentionally stay out of the public catalog. */
function toDefinition(indicator: MacroIndicator) {
  return {
    id: indicator.id, metricId: indicator.metricId, categoryId: indicator.categoryId, regionCode: indicator.regionCode, definitionId: indicator.definitionId,
    region: { code: indicator.regionCode, name: indicator.regionName, sort: indicator.regionSort },
    category: { id: indicator.categoryId, code: indicator.categoryCode, name: indicator.categoryName, sort: indicator.categorySort },
    metric: { id: indicator.metricId, code: indicator.metricCode, name: indicator.metricName, description: indicator.metricDescription, sort: indicator.metricSort },
    name: indicator.name, statisticalDefinition: indicator.statisticalDefinition,
    frequency: indicator.frequency, unit: indicator.unit, unitFormat: indicator.unitFormat,
    measurementKind: indicator.measurementKind, seasonalAdjustment: indicator.seasonalAdjustment, leadLag: indicator.leadLag,
    measures: {
      yoy: { method: indicator.yoyMethod, basePeriods: indicator.yoyBasePeriods, displayFormat: indicator.yoyDisplayFormat },
      mom: { method: indicator.momMethod, basePeriods: indicator.momBasePeriods, displayFormat: indicator.momDisplayFormat },
    },
    defaultTrendPeriods: indicator.defaultTrendPeriods,
    source: indicator.sourceId ? { id: indicator.sourceId, seriesId: indicator.sourceSeriesId, url: indicator.sourceUrl, publisher: indicator.publisher } : null,
  };
}

function toRawPoint(point: MacroDataPoint) { return { value: point.value, period: periodDayToIso(point.periodDay), publishedAt: timestampToIso(point.publishedAt) }; }

function parseIndicatorIds(value: string | undefined): number[] | null {
  if (!value?.trim()) return [];
  const values = value.split(",").map((item) => Number(item.trim()));
  if (values.some((item) => !Number.isSafeInteger(item) || item < 1)) return null;
  return [...new Set(values)];
}

function parseCsv(value: string | undefined): string[] | null {
  const values = [...new Set((value ?? "").split(",").map((item) => item.trim()).filter(Boolean))];
  return values.length <= MAX_FILTER_VALUES ? values : null;
}

function parsePeriodDay(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const periodDay = Number(`${match[1]}${match[2]}${match[3]}`);
  return periodDayToIso(periodDay) ? periodDay : null;
}

function parseTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) return Math.floor(numeric >= 10_000_000_000 ? numeric / 1000 : numeric);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function nowSeconds(): number { return Math.floor(Date.now() / 1000); }
function basePeriodsFor(indicator: MacroIndicator, measure: Exclude<Measure, "level">): number { return measure === "yoy" ? indicator.yoyBasePeriods : indicator.momBasePeriods; }
function boundedTrendPeriods(value: number): number { return Number.isInteger(value) ? Math.min(240, Math.max(2, value)) : 12; }
