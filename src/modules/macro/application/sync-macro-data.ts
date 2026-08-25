import {
  BlsPublicDataAdapter,
  DbnomicsAdapter,
  FredAdapter,
  loadBlsReleaseCalendar,
  macroFetch,
  MacroSourceError,
  type MacroAdapterResult,
} from "../adapters";
import {
  resolveRegisteredMacroSourceMapping,
  type RegisteredMacroSourceMapping,
} from "../config/indicators";
import type { MacroDataWrite, MacroIndicator } from "../domain/model";
import { D1MacroRepository } from "./macro-repository";
import type { Bindings } from "../../../types";

const LEASE_SECONDS = 5 * 60;
const FAILURE_BACKOFF_MAX_SECONDS = 24 * 60 * 60;
const INITIAL_BACKFILL_YEARS = 10;

export type MacroSyncStats = {
  indicatorsDue: number;
  indicatorsClaimed: number;
  indicatorsRejectedSourceMapping: number;
  sourceBatchesAttempted: number;
  sourceBatchesSucceeded: number;
  observationsWritten: number;
  observationsRejectedWithoutPublishedAt: number;
};

type ClaimedIndicator = MacroIndicator & { leaseUntil: number; mapping: RegisteredMacroSourceMapping };

export type MacroSyncRepository = Pick<
  D1MacroRepository,
  "listDueIndicators" | "claimIndicator" | "scheduleNextFetch" | "putData" | "getLatestData"
>;

export type MacroSyncDependencies = {
  repository?: MacroSyncRepository;
};

/** Fetches only concrete source mappings already registered in the directory. */
export async function syncMacroData(env: Bindings, scheduledTime = Date.now(), dependencies: MacroSyncDependencies = {}): Promise<MacroSyncStats> {
  const now = toSeconds(scheduledTime);
  const repository = dependencies.repository ?? new D1MacroRepository(env.DB);

  const stats: MacroSyncStats = {
    indicatorsDue: 0, indicatorsClaimed: 0, indicatorsRejectedSourceMapping: 0,
    sourceBatchesAttempted: 0, sourceBatchesSucceeded: 0,
    observationsWritten: 0, observationsRejectedWithoutPublishedAt: 0,
  };
  const due = await repository.listDueIndicators(now);
  stats.indicatorsDue = due.length;
  const claimed: ClaimedIndicator[] = [];
  for (const indicator of due) {
    const leaseUntil = now + LEASE_SECONDS;
    if (!await repository.claimIndicator(indicator.id, now, leaseUntil)) continue;
    try {
      const mapping = resolveRegisteredMacroSourceMapping(indicator);
      claimed.push({ ...indicator, leaseUntil, mapping });
    } catch (error) {
      stats.indicatorsRejectedSourceMapping += 1;
      await repository.scheduleNextFetch({
        indicatorId: indicator.id,
        leaseUntil,
        nextFetchAt: now + failureBackoffSeconds(indicator.consecutiveFailures),
        completedAt: now,
        success: false,
        lastError: errorMessage(error),
      });
    }
  }
  stats.indicatorsClaimed = claimed.length;

  const bySource = groupBySource(claimed);
  for (const indicators of bySource.values()) {
    if (indicators.length === 0) continue;
    stats.sourceBatchesAttempted += 1;
    try {
      const outcome = await syncSourceBatch(indicators[0].mapping.sourceId, indicators, repository, env, now);
      stats.sourceBatchesSucceeded += 1;
      stats.observationsWritten += outcome.observationsWritten;
      stats.observationsRejectedWithoutPublishedAt += outcome.rejectedWithoutPublishedAt;
      await Promise.all(indicators.map((indicator) => repository.scheduleNextFetch({
        indicatorId: indicator.id, leaseUntil: indicator.leaseUntil,
        nextFetchAt: now + indicator.refreshIntervalSeconds, completedAt: now, success: true,
      })));
    } catch (error) {
      const message = errorMessage(error);
      await Promise.all(indicators.map((indicator) => repository.scheduleNextFetch({
        indicatorId: indicator.id, leaseUntil: indicator.leaseUntil,
        nextFetchAt: now + failureBackoffSeconds(indicator.consecutiveFailures), completedAt: now,
        success: false, lastError: message,
      })));
    }
  }
  return stats;
}

async function syncSourceBatch(
  sourceId: RegisteredMacroSourceMapping["sourceId"],
  indicators: readonly ClaimedIndicator[],
  repository: MacroSyncRepository,
  env: Bindings,
  now: number,
): Promise<{ observationsWritten: number; rejectedWithoutPublishedAt: number }> {
  const fetcher = macroFetch(env);
  if (sourceId === "fred") {
    // FRED public CSV has no release/vintage timestamp. Do not fabricate it
    // from the scheduler's fetch time.
    if (!env.FRED_API_KEY?.trim()) throw new MacroSourceError("fred", "missing_credential", "FRED_API_KEY is required for trustworthy realtime_start timestamps", false);
    const adapter = new FredAdapter(env.FRED_API_KEY, fetcher);
    const results = await Promise.all(indicators.map(async (indicator) => adapter.load({
      seriesId: String(indicator.id), sourceSeriesId: indicator.mapping.sourceSeriesId,
      name: indicator.name, frequency: indicator.frequency, unit: indicator.unit,
      observationStart: await observationStart(repository, indicator, now), observationEnd: isoDate(now),
    })));
    return persistResults(results, indicators, repository, (indicator, observation) =>
      indicator.mapping.publicationTimestampStrategy === "fred_realtime_start" ? timestampFromSource(observation.releasedAt) : null,
    );
  }
  if (sourceId === "bls") {
    // BLS supplies a current snapshot but no per-row timestamp.  A value is
    // eligible only when its registered release family has an official,
    // already-published calendar record. That date is the conservative
    // known-at boundary for this fetched snapshot, never an invented historic
    // publication date. `observationStart` bounds an initial load and every
    // later refresh to the directory-owned revisionLookbackPeriods window.
    const releaseCalendar = await loadBlsReleaseCalendar(fetcher, now);
    const earliest = Math.min(...await Promise.all(indicators.map((indicator) => observationStartYear(repository, indicator, now))));
    const result = await new BlsPublicDataAdapter(fetcher).load({
      series: indicators.map((indicator) => ({ id: indicator.mapping.sourceSeriesId, name: indicator.name, unit: indicator.unit, frequency: indicator.frequency })),
      startYear: earliest, endYear: new Date(now * 1000).getUTCFullYear(), registrationKey: env.BLS_API_KEY,
    });
    return persistResults(
      [result], indicators, repository,
      (indicator) => {
        return indicator.mapping.publicationTimestampStrategy === "bls_release_calendar" && indicator.mapping.blsReleaseFamily
          ? releaseCalendar.get(indicator.mapping.blsReleaseFamily) ?? null : null;
      },
    );
  }
  if (sourceId === "dbnomics") {
    const releaseAfterSchedule = indicators.find((indicator) => (indicator.mapping.datasetReleasedAt ?? Number.POSITIVE_INFINITY) > now);
    if (releaseAfterSchedule) {
      throw new MacroSourceError(
        "dbnomics",
        "invalid_request",
        `DBnomics WEO batch ${releaseAfterSchedule.mapping.sourceBatchKey} was not released at the scheduled time`,
        false,
      );
    }
    const results = await Promise.all(indicators.map((indicator) => new DbnomicsAdapter(fetcher).load({
      sourceSeriesId: indicator.mapping.sourceSeriesId,
      name: indicator.name,
      frequency: indicator.frequency,
      unit: indicator.unit,
      observationEnd: indicator.mapping.observedThrough,
    })));
    return persistResults(results, indicators, repository, (indicator) =>
      indicator.mapping.publicationTimestampStrategy === "dbnomics_dataset_release"
        ? indicator.mapping.datasetReleasedAt ?? null : null,
    );
  }
  throw new Error(`unsupported scheduled macro source: ${sourceId}`);
}

async function persistResults(
  results: readonly MacroAdapterResult[],
  indicators: readonly ClaimedIndicator[],
  repository: MacroSyncRepository,
  publishedAt: (indicator: ClaimedIndicator, observation: MacroAdapterResult["observations"][number]) => number | null,
): Promise<{ observationsWritten: number; rejectedWithoutPublishedAt: number }> {
  const bySourceSeries = new Map(indicators.map((indicator) => [indicator.mapping.sourceSeriesId, indicator]));
  const observations = results.flatMap((result) => result.observations);
  const pending: MacroDataWrite[] = [];
  let rejectedWithoutPublishedAt = 0;
  for (const observation of observations) {
    const indicator = bySourceSeries.get(observation.seriesId);
    if (!indicator) continue;
    const releasedAt = publishedAt(indicator, observation);
    if (releasedAt === null) { rejectedWithoutPublishedAt += 1; continue; }
    pending.push({ indicatorId: indicator.id, period: observation.observedAt, frequency: indicator.frequency, publishedAt: releasedAt, value: observation.value });
  }
  await repository.putData(pending);
  return { observationsWritten: pending.length, rejectedWithoutPublishedAt };
}

async function observationStart(repository: MacroSyncRepository, indicator: MacroIndicator, now: number): Promise<string> {
  const latest = await repository.getLatestData(indicator.id);
  return latest ? dateBeforePeriod(latest.periodDay, indicator.frequency, indicator.revisionLookbackPeriods) : dateYearsAgo(now, INITIAL_BACKFILL_YEARS);
}
async function observationStartYear(repository: MacroSyncRepository, indicator: MacroIndicator, now: number): Promise<number> { return Number((await observationStart(repository, indicator, now)).slice(0, 4)); }

function groupBySource(indicators: readonly ClaimedIndicator[]): Map<string, ClaimedIndicator[]> {
  const groups = new Map<string, ClaimedIndicator[]>();
  for (const indicator of indicators) {
    const key = `${indicator.mapping.sourceId}:${indicator.mapping.sourceBatchKey}`;
    const group = groups.get(key);
    if (group) group.push(indicator);
    else groups.set(key, [indicator]);
  }
  return groups;
}
function timestampFromSource(value: string | null): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const timestamp = Date.parse(`${value}T12:00:00.000Z`);
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : null;
}
function dateBeforePeriod(periodDay: number, frequency: MacroIndicator["frequency"], count: number): string {
  const date = new Date(Date.UTC(Math.floor(periodDay / 10_000), Math.floor(periodDay / 100) % 100 - 1, periodDay % 100));
  const months = frequency === "annual" ? count * 12 : frequency === "quarterly" ? count * 3 : frequency === "monthly" ? count : 0;
  if (months) date.setUTCMonth(date.getUTCMonth() - months);
  else date.setUTCDate(date.getUTCDate() - (frequency === "weekly" ? count * 7 : count));
  return date.toISOString().slice(0, 10);
}
function dateYearsAgo(now: number, years: number): string { const date = new Date(now * 1000); date.setUTCFullYear(date.getUTCFullYear() - years); return date.toISOString().slice(0, 10); }
function isoDate(now: number): string { return new Date(now * 1000).toISOString().slice(0, 10); }
function toSeconds(value: number): number { return Math.floor(value >= 100_000_000_000 ? value / 1000 : value); }
function failureBackoffSeconds(consecutiveFailures: number): number { return Math.min(60 * 60 * 2 ** Math.min(consecutiveFailures, 5), FAILURE_BACKOFF_MAX_SECONDS); }
function errorMessage(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 1_000); }
