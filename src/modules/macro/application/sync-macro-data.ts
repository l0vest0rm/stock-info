import seriesConfig from "../config/series.json";
import {
  BlsPublicDataAdapter,
  FredAdapter,
  HkmaOpenApiAdapter,
  loadFredReleaseCalendar,
  macroFetch,
  MacroSourceError,
  NyFedSofrAdapter,
  sourceHealthFromError,
  unsupportedChinaSourceHealth,
  type MacroAdapterResult,
  type MacroSourceHealth as AdapterSourceHealth,
} from "../adapters";
import type { MacroFrequency, MacroObservationVintage, MacroSeries, MacroSourceHealth } from "../domain/model";
import { D1MacroRepository } from "./macro-repository";
import type { Bindings } from "../../../types";

type ConfiguredSeries = {
  id: string;
  name: string;
  category: string;
  region: string;
  regions: string[];
  frequency: MacroFrequency;
  unit: string;
  staleDays: number;
  sourceId: string;
  transmissions: MacroSeries["transmissions"];
  interpretation: string;
  enabled: boolean;
  fredSeriesId?: string;
};

type SyncStats = { sourcesAttempted: number; sourcesSucceeded: number; observationsWritten: number; seriesConfigured: number };

const configuredSeries = seriesConfig as ConfiguredSeries[];

export async function syncMacroData(env: Bindings, scheduledTime = Date.now()): Promise<SyncStats> {
  const repository = new D1MacroRepository(env.DB);
  const upstreamFetch = macroFetch(env);
  const startedAt = Date.now();
  const jobId = `macro-sync:${scheduledTime}`;
  const stats: SyncStats = { sourcesAttempted: 0, sourcesSucceeded: 0, observationsWritten: 0, seriesConfigured: configuredSeries.length };
  await startJob(env.DB, jobId, startedAt);
  try {
    for (const definition of configuredSeries) await repository.upsertSeries(toDomainSeries(definition, scheduledTime));
    const previousHealth = new Map((await repository.listSourceHealth()).map((item) => [item.sourceId, item]));
    const tasks: Array<{ sourceId: string; displayName: string; run: () => Promise<MacroAdapterResult[]> }> = [
      {
        sourceId: "ny-fed",
        displayName: "Federal Reserve Bank of New York",
        run: async () => [await new NyFedSofrAdapter().load({ startDate: dateYearsAgo(5), endDate: isoDate(scheduledTime) })],
      },
      {
        sourceId: "bls",
        displayName: "U.S. BLS series (BLS API / FRED official mirror)",
        run: async () => {
          const definitions = configuredSeries.filter((item) => item.sourceId === "bls");
          try {
            return [await new BlsPublicDataAdapter(upstreamFetch).load({
              series: definitions.map((item) => ({ id: item.id, name: item.name, unit: item.unit, frequency: item.frequency })),
              startYear: new Date(scheduledTime).getUTCFullYear() - 9,
              endYear: new Date(scheduledTime).getUTCFullYear(),
              registrationKey: env.BLS_API_KEY,
            })];
          } catch (error) {
            if (!(error instanceof MacroSourceError) || (error.code !== "timeout" && error.code !== "http_error")) throw error;
            console.warn("BLS API unavailable; using the official FRED CSV mirror", error);
            const adapter = new FredAdapter(undefined, upstreamFetch);
            const results: MacroAdapterResult[] = [];
            for (const item of definitions) results.push(await adapter.load({
              seriesId: item.id, sourceSeriesId: item.fredSeriesId, name: item.name, frequency: item.frequency, unit: item.unit,
              observationStart: dateYearsAgo(10), observationEnd: isoDate(scheduledTime),
            }));
            return results;
          }
        },
      },
      {
        sourceId: "hkma",
        displayName: "Hong Kong Monetary Authority",
        run: async () => {
          const adapter = new HkmaOpenApiAdapter();
          return await Promise.all([
            adapter.load({
              dataset: "market-data-and-statistics/monthly-statistical-bulletin/er-ir/er-eeri-daily",
              fields: [
                { field: "usd", id: "HKMA_USD_HKD", name: "USD/HKD reference rate", unit: "HKD/USD" },
                { field: "neeri_2020_trade_wgt", id: "HKMA_NEERI", name: "HKD nominal effective exchange rate", unit: "index" },
              ],
            }),
            adapter.load({
              dataset: "market-data-and-statistics/monthly-statistical-bulletin/er-ir/hk-interbank-ir-daily",
              fields: [
                { field: "ir_overnight", id: "HKMA_HIBOR_ON", name: "Overnight HIBOR", unit: "%" },
                { field: "ir_1m", id: "HKMA_HIBOR_1M", name: "1-month HIBOR", unit: "%" },
                { field: "ir_3m", id: "HKMA_HIBOR_3M", name: "3-month HIBOR", unit: "%" },
              ],
            }),
          ]);
        },
      },
    ];

    tasks.push({
      sourceId: "fred",
      displayName: "Federal Reserve Bank of St. Louis (FRED)",
      run: async () => {
        const adapter = new FredAdapter(env.FRED_API_KEY, upstreamFetch);
        const definitions = configuredSeries.filter((item) => item.sourceId === "fred");
        const results: MacroAdapterResult[] = [];
        for (const item of definitions) {
          results.push(await adapter.load({
            seriesId: item.id,
            name: item.name,
            frequency: item.frequency,
            unit: item.unit,
            observationStart: dateYearsAgo(10),
            observationEnd: isoDate(scheduledTime),
          }));
        }
        return results;
      },
    });
    try {
      const calendar = await loadFredReleaseCalendar(env.FRED_API_KEY, isoDate(scheduledTime), isoDate(scheduledTime + 30 * 86_400_000), upstreamFetch);
      for (const event of calendar) await repository.upsertEvent({
          eventId: `fred:${event.releaseId}:${event.date}`,
          scheduledAt: Date.parse(`${event.date}T00:00:00Z`),
          region: "us",
          importance: releaseImportance(event.name),
          title: event.name,
          seriesId: null,
          actual: null,
          consensus: null,
          previous: null,
          unit: null,
          status: "scheduled",
          sourceId: "fred-calendar",
          sourceUrl: event.sourceUrl,
          metadata: { timePrecision: "date_only" },
          updatedAt: scheduledTime,
      });
    } catch (err) {
      console.warn("FRED release calendar sync failed", err);
    }

    for (const task of tasks) {
      stats.sourcesAttempted += 1;
      const attemptedAt = Date.now();
      try {
        const results = await task.run();
        let written = 0;
        for (const result of results) written += await persistAdapterResult(repository, result, scheduledTime);
        stats.sourcesSucceeded += 1;
        stats.observationsWritten += written;
        await repository.putSourceHealth(successHealth(task.sourceId, task.displayName, attemptedAt, Date.now(), written));
      } catch (err) {
        const mapped = err instanceof MacroSourceError ? sourceHealthFromError(err) : null;
        const previous = previousHealth.get(task.sourceId);
        await repository.putSourceHealth(failedHealth(task.sourceId, task.displayName, err, mapped, previous, attemptedAt));
      }
    }

    for (const health of unsupportedChinaSourceHealth(new Date(scheduledTime).toISOString())) {
      await repository.putSourceHealth(adapterHealthToDomain(health, health.sourceId, scheduledTime));
    }
    for (const [sourceId, name, message] of [
      ["bok-ecos", "Bank of Korea ECOS", env.BOK_ECOS_API_KEY ? "ECOS series mapping requires verification before ingestion" : "BOK_ECOS_API_KEY is not configured"],
      ["kosis", "KOSIS", env.KOSIS_API_KEY ? "KOSIS table mapping requires verification before ingestion" : "KOSIS_API_KEY is not configured"],
      ["motie", "Korea MOTIE", "A stable official structured export contract has not been verified"],
    ] as const) await repository.putSourceHealth(disabledHealth(sourceId, name, message, scheduledTime));

    await finishJob(env.DB, jobId, "succeeded", stats, null);
    return stats;
  } catch (err) {
    await finishJob(env.DB, jobId, "failed", stats, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

async function persistAdapterResult(repository: D1MacroRepository, result: MacroAdapterResult, syncTime: number): Promise<number> {
  let written = 0;
  for (const series of result.series) {
    const definition = configuredSeries.find((item) => item.id === series.id);
    if (!definition) continue;
    const observations = result.observations.filter((item) => item.seriesId === series.id);
    if (observations.length === 0) continue;
    const dates = observations.map((item) => normalizeObservationDate(item.observedAt)).filter((item): item is string => Boolean(item));
    const existing = dates.length === 0 ? [] : await repository.getObservationSeries(series.id, { from: dates.sort()[0], to: dates.sort().at(-1) });
    const latest = new Map(existing.map((item) => [item.observationDate, item]));
    const pending: MacroObservationVintage[] = [];
    for (const observation of observations) {
      const observationDate = normalizeObservationDate(observation.observedAt);
      if (!observationDate) continue;
      const previous = latest.get(observationDate);
      if (previous?.value === observation.value) continue;
      const releasedAt = parseTimestamp(observation.releasedAt) ?? syncTime;
      const vintageAt = previous ? syncTime : Math.max(releasedAt, syncTime);
      const item: MacroObservationVintage = {
        seriesId: series.id,
        observationDate,
        releasedAt,
        vintageAt,
        revisionNumber: previous ? previous.revisionNumber + 1 : 0,
        value: observation.value,
        consensus: null,
        previousValue: previous?.value ?? null,
        isPreliminary: false,
        qualityStatus: "valid",
        sourceUrl: observation.sourceUrl,
        rawR2Key: null,
        observedAt: syncTime,
      };
      pending.push(item);
      latest.set(observationDate, item);
    }
    await repository.putObservationVintages(pending);
    written += pending.length;
  }
  return written;
}

function toDomainSeries(item: ConfiguredSeries, now: number): MacroSeries {
  return {
    seriesId: item.id,
    name: item.name,
    category: item.category,
    region: item.region,
    frequency: item.frequency,
    unit: item.unit,
    sourceId: item.sourceId,
    transmissions: item.transmissions,
    regions: item.regions,
    licenseClass: "official",
    staleAfterSeconds: item.staleDays * 86_400,
    enabled: item.enabled,
    metadata: { interpretation: item.interpretation },
    updatedAt: now,
  };
}

function successHealth(sourceId: string, displayName: string, startedAt: number, finishedAt: number, observations: number): MacroSourceHealth {
  return { sourceId, displayName, state: "healthy", lastAttemptAt: startedAt, lastSuccessAt: finishedAt, consecutiveFailures: 0, lastError: null, nextRetryAt: null, latencyMs: finishedAt - startedAt, metadata: { observations }, updatedAt: finishedAt };
}

function failedHealth(sourceId: string, displayName: string, err: unknown, mapped: AdapterSourceHealth | null, previous: MacroSourceHealth | undefined, attemptedAt: number): MacroSourceHealth {
  const now = Date.now();
  return { sourceId, displayName, state: "failed", lastAttemptAt: attemptedAt, lastSuccessAt: previous?.lastSuccessAt ?? null, consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1, lastError: mapped?.message ?? (err instanceof Error ? err.message : String(err)), nextRetryAt: now + 60 * 60 * 1000, latencyMs: now - attemptedAt, metadata: {}, updatedAt: now };
}

function disabledHealth(sourceId: string, displayName: string, message: string, now: number): MacroSourceHealth {
  return { sourceId, displayName, state: "disabled", lastAttemptAt: null, lastSuccessAt: null, consecutiveFailures: 0, lastError: message, nextRetryAt: null, latencyMs: null, metadata: {}, updatedAt: now };
}

function adapterHealthToDomain(health: AdapterSourceHealth, displayName: string, now: number): MacroSourceHealth {
  return { sourceId: health.sourceId, displayName, state: health.state === "healthy" ? "healthy" : health.state === "degraded" ? "degraded" : "disabled", lastAttemptAt: now, lastSuccessAt: null, consecutiveFailures: 0, lastError: health.message, nextRetryAt: null, latencyMs: null, metadata: {}, updatedAt: now };
}

function normalizeObservationDate(value: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (/^\d{4}-\d{2}$/.test(value)) return `${value}-01`;
  const quarter = /^(\d{4})-Q([1-4])$/.exec(value);
  if (quarter) return `${quarter[1]}-${String(Number(quarter[2]) * 3).padStart(2, "0")}-01`;
  if (/^\d{4}$/.test(value)) return `${value}-01-01`;
  return null;
}

function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateYearsAgo(years: number): string {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - years);
  return date.toISOString().slice(0, 10);
}

function isoDate(timestamp: number): string { return new Date(timestamp).toISOString().slice(0, 10); }
function releaseImportance(name: string): "low" | "medium" | "high" {
  return /(Consumer Price|Employment Situation|Gross Domestic Product|FOMC|Personal Income)/i.test(name) ? "high" : /(Producer Price|Industrial Production|Retail Sales|Job Openings)/i.test(name) ? "medium" : "low";
}

async function startJob(db: D1Database, jobId: string, startedAt: number): Promise<void> {
  await db.prepare(`insert into sync_jobs (job_id, job_type, status, started_at, stats_json) values (?, 'macro-data', 'running', ?, '{}') on conflict(job_id) do nothing`).bind(jobId, startedAt).run();
}

async function finishJob(db: D1Database, jobId: string, status: "succeeded" | "failed", stats: SyncStats, error: string | null): Promise<void> {
  await db.prepare(`update sync_jobs set status = ?, finished_at = ?, error = ?, stats_json = ? where job_id = ?`).bind(status, Date.now(), error, JSON.stringify(stats), jobId).run();
}
