import { Hono } from "hono";
import seriesConfig from "../config/series.json";
import exposureConfig from "../config/market-exposures.json";
import industryExposureConfig from "../config/industry-exposures.json";
import { buildResearchSeries } from "../application/build-research-series";
import { D1MacroRepository } from "../application/macro-repository";
import { syncMacroData } from "../application/sync-macro-data";
import type { MacroSeries, MacroUserWatchConfig, DatedValue } from "../domain/model";
import { transformSeries, type SeriesTransform } from "../domain/transforms";
import { backtestSignal, calculateMarketFactorContributions, initialReleasePoints, replayScenario, rollingCorrelation } from "../domain/research";
import { loadKline } from "../../market/application/load-kline";
import { fail, ok } from "../../../shared/http";
import { isLocalDevelopmentRuntime } from "../../../shared/request";
import type { AppEnv, FundNavRow, KlineBar } from "../../../types";

type ConfiguredSeries = {
  id: string; name: string; category: string; region: string; regions: string[]; frequency: MacroSeries["frequency"];
  unit: string; staleDays: number; sourceId: string; transmissions: MacroSeries["transmissions"];
  interpretation: string; enabled: boolean;
};
type ExposureConfig = { seriesId: string; factor: string; markets: Record<string, number> };
type IndustryExposureConfig = { id: string; market: string; name: string; series: Record<string, number> };
type Quality = "fresh" | "stale" | "missing";

const configured = seriesConfig as ConfiguredSeries[];
const configuredById = new Map(configured.map((item) => [item.id, item]));
const exposures = exposureConfig as ExposureConfig[];
const industryExposures = industryExposureConfig as unknown as IndustryExposureConfig[];
const transforms = new Set<SeriesTransform>(["level", "mom", "yoy", "zscore", "percentile"]);
const benchmarkCodes: Record<string, string> = { us: "SPX.US", cn: "000300.SH", hk: "HSI.HK", kr: "KS11.UI" };
const MAX_SERIES_PER_REQUEST = 20;

export const macroRoutes = new Hono<AppEnv>();

macroRoutes.get("/macro/dashboard", async (c) => {
  const repository = new D1MacroRepository(c.env.DB);
  const regions = csvValues(c.req.query("regions"));
  const catalog = await loadCatalog(repository);
  const selected = regions.length === 0 ? catalog : catalog.filter((item) => item.region === "global" || item.regions.some((region) => regions.includes(region)));
  const now = Date.now();
  const indicators = await Promise.all(selected.map(async (definition) => {
    const observations = await repository.getObservationSeries(definition.seriesId, { from: dateDaysAgo(800) });
    return summarize(definition, observations.map((item) => ({ date: item.observationDate, value: item.value })), now);
  }));
  const sourceHealth = await repository.listSourceHealth();
  const status = summarizeStatus(indicators, sourceHealth);
  return ok(c, {
    generatedAt: new Date(now).toISOString(),
    source: { id: "official-multi-source", name: "NY Fed、BLS、FRED、HKMA及已配置官方源", url: "/api/macro/status" },
    coverage: {
      live: [...new Set(indicators.filter((item) => item.quality !== "missing").map((item) => item.region))],
      pending: sourceHealth.filter((item) => item.state !== "healthy").map((item) => item.sourceId),
    },
    indicators,
    status,
  });
});

macroRoutes.get("/macro/catalog", async (c) => ok(c, await loadCatalog(new D1MacroRepository(c.env.DB))));

macroRoutes.get("/macro/series", async (c) => {
  const ids = csvValues(c.req.query("ids"));
  if (ids.length === 0) return fail(c, 400, "Missing ids parameter");
  if (ids.length > MAX_SERIES_PER_REQUEST) return fail(c, 400, `Too many series; maximum is ${MAX_SERIES_PER_REQUEST}`);
  const unknown = ids.filter((id) => !configuredById.has(id));
  if (unknown.length) return fail(c, 400, `Unknown macro series: ${unknown.join(", ")}`);
  const from = validDate(c.req.query("from")) ?? dateDaysAgo(730);
  const to = validDate(c.req.query("to")) ?? today();
  if (from > to) return fail(c, 400, "from must not be after to");
  const transform = (c.req.query("transform") ?? "level") as SeriesTransform;
  if (!transforms.has(transform)) return fail(c, 400, "invalid transform");
  const window = boundedInteger(c.req.query("window"), 60, 2, 1000);
  const asOf = parseAsOf(c.req.query("asOf"));
  if (c.req.query("asOf") && asOf === null) return fail(c, 400, "invalid asOf");
  const includeVintages = c.req.query("includeVintages") === "true";
  const repository = new D1MacroRepository(c.env.DB);
  const catalog = new Map((await loadCatalog(repository)).map((item) => [item.seriesId, item]));
  const rows = await Promise.all(ids.map(async (id) => {
    const observations = await repository.getObservationSeries(id, { from, to, asOf: asOf ?? undefined, includeAllVintages: includeVintages });
    const points = includeVintages ? observations.map((item) => ({
      date: item.observationDate, value: item.value, releasedAt: item.releasedAt, vintageAt: item.vintageAt,
      revisionNumber: item.revisionNumber, isPreliminary: item.isPreliminary, consensus: item.consensus,
    })) : transformSeries(observations.map((item) => ({ date: item.observationDate, value: item.value })), transform, { window });
    return { definition: toApiDefinition(catalog.get(id) ?? configToDomain(configuredById.get(id)!, Date.now())), transform, points };
  }));
  return ok(c, rows);
});

macroRoutes.get("/macro/revisions", async (c) => {
  const id = c.req.query("id")?.trim() ?? "";
  if (!configuredById.has(id)) return fail(c, 400, "unknown series id");
  const repository = new D1MacroRepository(c.env.DB);
  const observations = await repository.getObservationSeries(id, {
    from: validDate(c.req.query("from")) ?? undefined,
    to: validDate(c.req.query("to")) ?? undefined,
    includeAllVintages: true,
  });
  return ok(c, { seriesId: id, observations });
});

macroRoutes.get("/macro/events", async (c) => {
  const from = parseDateBoundary(c.req.query("from"), false) ?? Date.now();
  const to = parseDateBoundary(c.req.query("to"), true) ?? from + 7 * 86_400_000;
  if (from > to) return fail(c, 400, "from must not be after to");
  const events = await new D1MacroRepository(c.env.DB).listEvents({ from, to, regions: csvValues(c.req.query("regions")), importance: c.req.query("importance") });
  return ok(c, { events, status: events.length ? "ready" : "empty", message: events.length ? null : "当前区间没有已验证的官方日历事件。" });
});

macroRoutes.get("/macro/status", async (c) => ok(c, { generatedAt: new Date().toISOString(), sources: await new D1MacroRepository(c.env.DB).listSourceHealth() }));

macroRoutes.get("/macro/signals", async (c) => {
  const repository = new D1MacroRepository(c.env.DB);
  const signals = new Map<string, number>();
  for (const definition of await loadCatalog(repository)) {
    const observations = await repository.getObservationSeries(definition.seriesId, { from: dateDaysAgo(3650) });
    const series = buildResearchSeries(observations, "zscore", { window: 60 });
    const latest = [...series].reverse().find((item) => item.value !== null)?.value;
    if (latest !== null && latest !== undefined) signals.set(definition.seriesId, latest);
  }
  const factorExposures = exposures.flatMap((exposure) => {
    const signal = signals.get(exposure.seriesId);
    if (signal === undefined) return [];
    return Object.entries(exposure.markets).map(([market, weight]) => ({ market, factor: `${exposure.factor}/${exposure.seriesId}`, signal, weight }));
  });
  return ok(c, { generatedAt: new Date().toISOString(), methodology: "60-observation rolling z-score × configured market exposure; components remain visible", markets: calculateMarketFactorContributions(factorExposures) });
});

macroRoutes.get("/macro/research/industries", async (c) => {
  const requestedMarkets = csvValues(c.req.query("markets"));
  const definitions = requestedMarkets.length
    ? industryExposures.filter((item) => requestedMarkets.includes(item.market))
    : industryExposures;
  const repository = new D1MacroRepository(c.env.DB);
  const requiredIds = [...new Set(definitions.flatMap((item) => Object.keys(item.series)))];
  const signals = new Map<string, number>();
  for (const seriesId of requiredIds) {
    const observations = await repository.getObservationSeries(seriesId, { from: dateDaysAgo(3650) });
    const latest = [...buildResearchSeries(observations, "zscore", { window: 60 })].reverse().find((item) => item.value !== null)?.value;
    if (latest !== null && latest !== undefined) signals.set(seriesId, latest);
  }
  const sectors = definitions.map((definition) => {
    const contributions = Object.entries(definition.series).flatMap(([seriesId, weight]) => {
      const signal = signals.get(seriesId);
      return signal === undefined ? [] : [{ seriesId, signal, weight, contribution: signal * weight }];
    }).sort((left, right) => Math.abs(right.contribution) - Math.abs(left.contribution));
    const denominator = contributions.reduce((sum, item) => sum + Math.abs(item.weight), 0);
    return {
      id: definition.id, market: definition.market, name: definition.name,
      score: denominator ? contributions.reduce((sum, item) => sum + item.contribution, 0) / denominator : null,
      coverage: { available: contributions.length, configured: Object.keys(definition.series).length },
      contributions,
    };
  });
  return ok(c, { generatedAt: new Date().toISOString(), methodology: "latest 60-observation z-score × configured industry exposure", sectors });
});

macroRoutes.get("/macro/research/scenario", async (c) => {
  const ids = csvValues(c.req.query("ids"));
  const from = validDate(c.req.query("from"));
  const to = validDate(c.req.query("to"));
  if (!ids.length || ids.some((id) => !configuredById.has(id)) || !from || !to || from > to) return fail(c, 400, "valid ids, from and to are required");
  const asOf = parseAsOf(c.req.query("asOf"));
  const repository = new D1MacroRepository(c.env.DB);
  const byId: Record<string, DatedValue[]> = {};
  for (const id of ids) byId[id] = (await repository.getObservationSeries(id, { from, to, asOf: asOf ?? undefined })).map((item) => ({ date: item.observationDate, value: item.value }));
  return ok(c, { from, to, asOf, results: replayScenario(byId, from, to) });
});

macroRoutes.get("/macro/research/correlation", async (c) => {
  const seriesId = c.req.query("seriesId")?.trim() ?? "";
  const market = c.req.query("market")?.trim() ?? "us";
  if (!configuredById.has(seriesId) || !benchmarkCodes[market]) return fail(c, 400, "unknown seriesId or market");
  const from = validDate(c.req.query("from")) ?? dateDaysAgo(1825);
  const to = validDate(c.req.query("to")) ?? today();
  const window = boundedInteger(c.req.query("window"), 20, 2, 500);
  const macro = await new D1MacroRepository(c.env.DB).getObservationSeries(seriesId, { from, to, asOf: parseAsOf(c.req.query("asOf")) ?? undefined });
  const marketPoints = await loadBenchmark(c.env, benchmarkCodes[market], from, to);
  return ok(c, { seriesId, market, benchmark: benchmarkCodes[market], window, points: rollingCorrelation(macro.map((item) => ({ date: item.observationDate, value: item.value })), marketPoints, window) });
});

macroRoutes.get("/macro/research/backtest", async (c) => {
  const seriesId = c.req.query("seriesId")?.trim() ?? "";
  const market = c.req.query("market")?.trim() ?? "us";
  const operator = c.req.query("operator") === "lte" ? "lte" : "gte";
  const threshold = Number(c.req.query("threshold") ?? "1");
  if (!configuredById.has(seriesId) || !benchmarkCodes[market] || !Number.isFinite(threshold)) return fail(c, 400, "invalid research parameters");
  const from = validDate(c.req.query("from")) ?? dateDaysAgo(3650);
  const to = validDate(c.req.query("to")) ?? today();
  const horizon = boundedInteger(c.req.query("horizon"), 20, 1, 500);
  const transform = (c.req.query("transform") ?? "zscore") as SeriesTransform;
  if (!transforms.has(transform)) return fail(c, 400, "invalid transform");
  const retrospective = c.req.query("vintageMode") === "retrospective";
  const repository = new D1MacroRepository(c.env.DB);
  const observations = await repository.getObservationSeries(seriesId, {
    from, to, asOf: parseAsOf(c.req.query("asOf")) ?? undefined, includeAllVintages: !retrospective,
  });
  const signalSeries = retrospective
    ? buildResearchSeries(observations, transform, { window: boundedInteger(c.req.query("window"), 60, 2, 1000) })
    : transformSeries(initialReleasePoints(observations), transform, { window: boundedInteger(c.req.query("window"), 60, 2, 1000) });
  const signals = signalSeries.flatMap((item) => item.value === null ? [] : [{ date: item.date, value: item.value }]);
  const marketPrices = await loadBenchmark(c.env, benchmarkCodes[market], from, to);
  return ok(c, {
    seriesId, market, benchmark: benchmarkCodes[market], condition: { operator, threshold }, horizon,
    vintagePolicy: retrospective ? "retrospective-latest-revision" : "initial-release-only",
    signalDatePolicy: retrospective ? "observationDate" : "max(releasedAt,vintageAt)",
    lookAheadSafe: !retrospective,
    ...backtestSignal(signals, marketPrices, { operator, threshold }, horizon),
  });
});

macroRoutes.get("/macro/watch", async (c) => {
  const owner = validOwner(c.req.query("owner") ?? "local");
  if (!owner) return fail(c, 400, "invalid owner");
  return ok(c, await new D1MacroRepository(c.env.DB).listUserWatches(owner));
});

macroRoutes.put("/macro/watch", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const ownerKey = validOwner(String(body?.ownerKey ?? "local"));
  const seriesId = String(body?.seriesId ?? "");
  if (!ownerKey || !configuredById.has(seriesId)) return fail(c, 400, "invalid watch configuration");
  const now = Date.now();
  const rules = Array.isArray(body?.alertRules) ? body.alertRules.filter(validAlertRule) : [];
  const config: MacroUserWatchConfig = { ownerKey, seriesId, enabled: body?.enabled !== false, position: boundedNumber(body?.position, 100, 0, 10000), alertRules: rules, displayOptions: isRecord(body?.displayOptions) ? body.displayOptions : {}, createdAt: now, updatedAt: now };
  await new D1MacroRepository(c.env.DB).putUserWatch(config);
  return ok(c, config);
});

macroRoutes.get("/macro/alerts/evaluate", async (c) => {
  const owner = validOwner(c.req.query("owner") ?? "local");
  if (!owner) return fail(c, 400, "invalid owner");
  const repository = new D1MacroRepository(c.env.DB);
  const watches = await repository.listUserWatches(owner);
  const triggered: unknown[] = [];
  for (const watch of watches.filter((item) => item.enabled)) {
    const points = await repository.getObservationSeries(watch.seriesId, { from: dateDaysAgo(800) });
    const latest = points.at(-1);
    if (!latest) continue;
    for (const rule of watch.alertRules.filter(validAlertRule)) {
      const typed = rule as { operator: "gte" | "lte"; threshold: number };
      if ((typed.operator === "gte" && latest.value >= typed.threshold) || (typed.operator === "lte" && latest.value <= typed.threshold)) triggered.push({ seriesId: watch.seriesId, observationDate: latest.observationDate, value: latest.value, rule: typed });
    }
  }
  return ok(c, { owner, evaluatedAt: new Date().toISOString(), triggered, notification: "not_configured" });
});

macroRoutes.post("/macro/sync", async (c) => {
  if (!isLocalDevelopmentRuntime()) return fail(c, 404, "macro sync endpoint is only available in local development");
  return ok(c, await syncMacroData(c.env));
});

async function loadCatalog(repository: D1MacroRepository): Promise<MacroSeries[]> {
  const stored = await repository.listSeries();
  return stored.length ? stored : configured.filter((item) => item.enabled).map((item) => configToDomain(item, Date.now()));
}

function configToDomain(item: ConfiguredSeries, now: number): MacroSeries {
  return { seriesId: item.id, name: item.name, category: item.category, region: item.region, frequency: item.frequency, unit: item.unit, sourceId: item.sourceId, transmissions: item.transmissions, regions: item.regions, licenseClass: "official", staleAfterSeconds: item.staleDays * 86_400, enabled: item.enabled, metadata: { interpretation: item.interpretation }, updatedAt: now };
}

function toApiDefinition(item: MacroSeries) {
  return { id: item.seriesId, name: item.name, category: item.category, region: item.region, regions: item.regions, frequency: item.frequency, unit: item.unit, sourceId: item.sourceId, transmission: item.transmissions[0] ?? "earnings", transmissions: item.transmissions, interpretation: String(item.metadata.interpretation ?? ""), staleDays: Math.ceil(item.staleAfterSeconds / 86_400), enabled: item.enabled };
}

function summarize(item: MacroSeries, points: DatedValue[], now: number) {
  const latest = points.at(-1); const previous = points.at(-2);
  const ageDays = latest ? Math.max(0, Math.floor((now - freshnessTimestamp(latest.date, item.frequency)) / 86_400_000)) : null;
  const quality: Quality = ageDays === null ? "missing" : ageDays > item.staleAfterSeconds / 86_400 ? "stale" : "fresh";
  return { ...toApiDefinition(item), latest: latest?.value ?? null, previous: previous?.value ?? null, change: latest && previous ? latest.value - previous.value : null, latestDate: latest?.date ?? null, ageDays, quality };
}

function freshnessTimestamp(date: string, frequency: MacroSeries["frequency"]): number {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (frequency === "monthly" || frequency === "quarterly") return Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, 0);
  if (frequency === "annual") return Date.UTC(parsed.getUTCFullYear(), 11, 31);
  return parsed.getTime();
}

function summarizeStatus(indicators: Array<{ quality: Quality }>, sources: Array<{ state: string; sourceId: string; lastError: string | null }>) {
  const fresh = indicators.filter((item) => item.quality === "fresh").length;
  const stale = indicators.filter((item) => item.quality === "stale").length;
  const missing = indicators.length - fresh - stale;
  const failed = sources.filter((item) => item.state === "failed");
  return { state: failed.length || missing ? "degraded" : stale ? "stale" : "healthy", total: indicators.length, fresh, stale, missing, error: failed.map((item) => `${item.sourceId}: ${item.lastError ?? "failed"}`).join("; ") || null };
}

async function loadBenchmark(env: AppEnv["Bindings"], code: string, from: string, to: string): Promise<DatedValue[]> {
  const result = await loadKline(env, code, "day", "normal", from, to);
  return result.rows.flatMap((row: KlineBar | FundNavRow) => "close" in row && row.close !== null ? [{ date: row.date, value: row.close }] : []);
}

function csvValues(value: string | undefined): string[] { return [...new Set((value ?? "").split(",").map((item) => item.trim()).filter(Boolean))]; }
function validDate(value: string | undefined): string | null { return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null; }
function today(): string { return new Date().toISOString().slice(0, 10); }
function dateDaysAgo(days: number): string { return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10); }
function parseAsOf(value: string | undefined): number | null { if (!value) return null; const numeric = Number(value); const parsed = Number.isFinite(numeric) ? numeric : Date.parse(value); return Number.isFinite(parsed) ? parsed : null; }
function parseDateBoundary(value: string | undefined, end: boolean): number | null { const date = validDate(value); return date ? Date.parse(`${date}T${end ? "23:59:59.999" : "00:00:00.000"}Z`) : null; }
function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number { const parsed = Number(value); return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback; }
function boundedNumber(value: unknown, fallback: number, min: number, max: number): number { const parsed = Number(value); return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback; }
function validOwner(value: string): string | null { return /^[A-Za-z0-9:_-]{1,80}$/.test(value) ? value : null; }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function validAlertRule(value: unknown): boolean { if (!isRecord(value)) return false; return (value.operator === "gte" || value.operator === "lte") && Number.isFinite(Number(value.threshold)); }
