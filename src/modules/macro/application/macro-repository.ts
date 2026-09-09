import type { Database } from "../../../platform/contracts";
import type {
  MacroDataPoint,
  MacroDataWrite,
  MacroIndicator,
  MacroIndicatorFrequency,
} from "../domain/model";

/** The only persistence boundary for the redesigned two-table macro module. */
export class D1MacroRepository {
  constructor(private readonly db: Database) {}

  /** Upserts the static catalog/source contract without resetting scheduler state. */
  async upsertIndicator(indicator: MacroIndicator): Promise<void> {
    validateIndicator(indicator);
    await this.assertDirectoryConsistency(indicator);
    await this.db.prepare(
      `insert into macro_indicators (
        id, metric_id, category_id, region_code, definition_id,
        region_name, region_sort, category_code, category_name, category_sort,
        metric_code, metric_name, metric_description, metric_sort, statistical_definition,
        name, frequency, unit, unit_format, measurement_kind,
        yoy_method, yoy_base_periods, yoy_display_format,
        mom_method, mom_base_periods, mom_display_format, default_trend_periods, enabled,
        source_id, source_series_id, source_url, publisher, publication_timestamp_strategy, source_batch_key,
        seasonal_adjustment, lead_lag, transform_method, stale_after_seconds, refresh_interval_seconds,
        revision_lookback_periods, next_fetch_at, last_success_at, fetch_lease_until,
        consecutive_failures, last_error
      ) values (${new Array(45).fill("?").join(", ")})
      on conflict(id) do update set
        metric_id = excluded.metric_id,
        category_id = excluded.category_id,
        region_code = excluded.region_code,
        definition_id = excluded.definition_id,
        region_name = excluded.region_name,
        region_sort = excluded.region_sort,
        category_code = excluded.category_code,
        category_name = excluded.category_name,
        category_sort = excluded.category_sort,
        metric_code = excluded.metric_code,
        metric_name = excluded.metric_name,
        metric_description = excluded.metric_description,
        metric_sort = excluded.metric_sort,
        statistical_definition = excluded.statistical_definition,
        name = excluded.name,
        frequency = excluded.frequency,
        unit = excluded.unit,
        unit_format = excluded.unit_format,
        measurement_kind = excluded.measurement_kind,
        yoy_method = excluded.yoy_method,
        yoy_base_periods = excluded.yoy_base_periods,
        yoy_display_format = excluded.yoy_display_format,
        mom_method = excluded.mom_method,
        mom_base_periods = excluded.mom_base_periods,
        mom_display_format = excluded.mom_display_format,
        default_trend_periods = excluded.default_trend_periods,
        enabled = excluded.enabled,
        source_id = excluded.source_id,
        source_series_id = excluded.source_series_id,
        source_url = excluded.source_url,
        publisher = excluded.publisher,
        publication_timestamp_strategy = excluded.publication_timestamp_strategy,
        source_batch_key = excluded.source_batch_key,
        seasonal_adjustment = excluded.seasonal_adjustment,
        lead_lag = excluded.lead_lag,
        transform_method = excluded.transform_method,
        stale_after_seconds = excluded.stale_after_seconds,
        refresh_interval_seconds = excluded.refresh_interval_seconds,
        revision_lookback_periods = excluded.revision_lookback_periods`
    ).bind(
      indicator.id, indicator.metricId, indicator.categoryId, indicator.regionCode, indicator.definitionId,
      indicator.regionName, indicator.regionSort, indicator.categoryCode, indicator.categoryName, indicator.categorySort,
      indicator.metricCode, indicator.metricName, indicator.metricDescription, indicator.metricSort, indicator.statisticalDefinition,
      indicator.name, indicator.frequency, indicator.unit, indicator.unitFormat, indicator.measurementKind,
      indicator.yoyMethod, indicator.yoyBasePeriods, indicator.yoyDisplayFormat,
      indicator.momMethod, indicator.momBasePeriods, indicator.momDisplayFormat, indicator.defaultTrendPeriods,
      indicator.enabled ? 1 : 0,
      indicator.sourceId, indicator.sourceSeriesId, indicator.sourceUrl, indicator.publisher,
      indicator.publicationTimestampStrategy, indicator.sourceBatchKey,
      indicator.seasonalAdjustment, indicator.leadLag, indicator.transformMethod,
      indicator.staleAfterSeconds, indicator.refreshIntervalSeconds, indicator.revisionLookbackPeriods,
      indicator.nextFetchAt, indicator.lastSuccessAt, indicator.fetchLeaseUntil,
      indicator.consecutiveFailures, indicator.lastError,
    ).run();
  }

  async listIndicators(options: { regions?: readonly MacroIndicator["regionCode"][]; enabledOnly?: boolean } = {}): Promise<MacroIndicator[]> {
    const clauses: string[] = [];
    const bindings: unknown[] = [];
    if (options.regions?.length) {
      clauses.push(`region_code in (${options.regions.map(() => "?").join(",")})`);
      bindings.push(...options.regions);
    }
    if (options.enabledOnly !== false) clauses.push("enabled = 1");
    const result = await this.db.prepare(
      `select ${indicatorColumns} from macro_indicators
       ${clauses.length ? `where ${clauses.join(" and ")}` : ""}
       order by region_sort, region_name, category_sort, category_name, metric_sort, metric_name, definition_id`
    ).bind(...bindings).all<IndicatorRow>();
    return (result.results ?? []).map(mapIndicatorRow);
  }

  /** Returns all dynamic display dimensions derived from the persisted catalog. */
  async listCatalog(options: { enabledOnly?: boolean } = {}): Promise<MacroCatalog> {
    const series = await this.listIndicators({ enabledOnly: options.enabledOnly });
    const regions = distinctDirectory(series, (indicator) => indicator.regionCode, (indicator) => ({
      code: indicator.regionCode, name: indicator.regionName, sort: indicator.regionSort,
    }), compareDirectory);
    const categories = distinctDirectory(series, (indicator) => String(indicator.categoryId), (indicator) => ({
      id: indicator.categoryId, code: indicator.categoryCode, name: indicator.categoryName, sort: indicator.categorySort,
    }), compareDirectory);
    const metrics = distinctDirectory(series, (indicator) => String(indicator.metricId), (indicator) => ({
      id: indicator.metricId, categoryId: indicator.categoryId, code: indicator.metricCode,
      name: indicator.metricName, description: indicator.metricDescription, sort: indicator.metricSort,
    }), compareMetricDirectory);
    return {
      regions,
      categories,
      metrics,
      series,
      capabilities: {
        frequencies: uniqueSorted(series.map((indicator) => indicator.frequency)),
        measurementKinds: uniqueSorted(series.map((indicator) => indicator.measurementKind)),
        yoyMethods: uniqueSorted(series.map((indicator) => indicator.yoyMethod)),
        momMethods: uniqueSorted(series.map((indicator) => indicator.momMethod)),
      },
    };
  }

  async listDueIndicators(now: number, limit = 100): Promise<MacroIndicator[]> {
    const result = await this.db.prepare(
      `select ${indicatorColumns} from macro_indicators
       where enabled = 1
         and source_id is not null
         and refresh_interval_seconds > 0
         and next_fetch_at is not null
         and next_fetch_at <= ?
         and (fetch_lease_until is null or fetch_lease_until <= ?)
       order by next_fetch_at, id limit ?`
    ).bind(now, now, boundedLimit(limit)).all<IndicatorRow>();
    return (result.results ?? []).map(mapIndicatorRow);
  }

  /** Atomically claims one due indicator so overlapping scheduled runs cannot duplicate a fetch. */
  async claimIndicator(indicatorId: number, now: number, leaseUntil: number): Promise<boolean> {
    if (!Number.isInteger(indicatorId) || !Number.isInteger(now) || !Number.isInteger(leaseUntil) || leaseUntil <= now) return false;
    const result = await this.db.prepare(
      `update macro_indicators set fetch_lease_until = ?
       where id = ?
         and enabled = 1
         and source_id is not null
         and refresh_interval_seconds > 0
         and next_fetch_at is not null
         and next_fetch_at <= ?
         and (fetch_lease_until is null or fetch_lease_until <= ?)`
    ).bind(leaseUntil, indicatorId, now, now).run();
    return (result.meta.changes ?? 0) === 1;
  }

  /** Records completion only when this worker still owns its lease. */
  async scheduleNextFetch(input: {
    indicatorId: number;
    leaseUntil: number;
    nextFetchAt: number | null;
    completedAt: number;
    success: boolean;
    lastError?: string | null;
  }): Promise<boolean> {
    const result = await this.db.prepare(
      `update macro_indicators set
        next_fetch_at = ?,
        last_success_at = case when ? = 1 then ? else last_success_at end,
        fetch_lease_until = null,
        consecutive_failures = case when ? = 1 then 0 else consecutive_failures + 1 end,
        last_error = case when ? = 1 then null else ? end
       where id = ? and fetch_lease_until = ?`
    ).bind(
      input.nextFetchAt, input.success ? 1 : 0, input.completedAt,
      input.success ? 1 : 0, input.success ? 1 : 0, input.lastError ?? null,
      input.indicatorId, input.leaseUntil,
    ).run();
    return (result.meta.changes ?? 0) === 1;
  }

  async putData(points: readonly MacroDataWrite[]): Promise<void> {
    for (const point of points) {
      if (!Number.isInteger(point.indicatorId) || !Number.isInteger(point.publishedAt) || !Number.isFinite(point.value)) {
        throw new Error("macro data requires an integer indicatorId/publishedAt and finite value");
      }
      const periodDay = toMacroPeriodDay(point.period, point.frequency);
      await this.db.prepare(
        `insert into macro_data (indicator_id, period_day, published_at, value)
         values (?, ?, ?, ?)
         on conflict(indicator_id, period_day, published_at) do update set value = excluded.value`
      ).bind(point.indicatorId, periodDay, point.publishedAt, point.value).run();
    }
  }

  async getDataSeries(
    indicatorId: number,
    options: { fromPeriodDay?: number; toPeriodDay?: number; asOf?: number; includeAllVersions?: boolean } = {},
  ): Promise<MacroDataPoint[]> {
    const clauses = ["indicator_id = ?"];
    const bindings: number[] = [indicatorId];
    if (options.fromPeriodDay !== undefined) { clauses.push("period_day >= ?"); bindings.push(options.fromPeriodDay); }
    if (options.toPeriodDay !== undefined) { clauses.push("period_day <= ?"); bindings.push(options.toPeriodDay); }
    if (options.asOf !== undefined) { clauses.push("published_at <= ?"); bindings.push(options.asOf); }
    const where = clauses.join(" and ");
    const sql = options.includeAllVersions
      ? `select indicator_id as indicatorId, period_day as periodDay, published_at as publishedAt, value
         from macro_data where ${where} order by period_day, published_at`
      : `select indicator_id as indicatorId, period_day as periodDay, published_at as publishedAt, value
          from (
            select indicator_id, period_day, published_at, value,
              row_number() over (partition by period_day order by published_at desc) as version_rank
            from macro_data where ${where}
          ) where version_rank = 1 order by period_day`;
    const result = await this.db.prepare(sql).bind(...bindings).all<MacroDataPoint>();
    return result.results ?? [];
  }

  /**
   * Retrieves at most one visible latest revision per requested concrete
   * series. The query is bounded by explicit IDs and selects revisions after
   * applying `asOf`, preventing future revisions from leaking into a replay.
   */
  async getLatestSnapshots(indicatorIds: readonly number[], asOf?: number): Promise<MacroDataPoint[]> {
    const ids = boundedIndicatorIds(indicatorIds);
    if (ids.length === 0) return [];
    const idPlaceholders = ids.map(() => "?").join(",");
    const asOfClause = asOf === undefined ? "" : " and published_at <= ?";
    const result = await this.db.prepare(
      `select indicator_id as indicatorId, period_day as periodDay, published_at as publishedAt, value
       from (
         select indicator_id, period_day, published_at, value,
           row_number() over (
             partition by indicator_id
             order by period_day desc, published_at desc
           ) as snapshot_rank
         from macro_data
         where indicator_id in (${idPlaceholders})${asOfClause}
       ) where snapshot_rank = 1
       order by indicator_id`
    ).bind(...ids, ...(asOf === undefined ? [] : [asOf])).all<MacroDataPoint>();
    return result.results ?? [];
  }

  async getLatestData(indicatorId: number, asOf?: number): Promise<MacroDataPoint | null> {
    return (await this.getLatestSnapshots([indicatorId], asOf))[0] ?? null;
  }

  private async assertDirectoryConsistency(indicator: MacroIndicator): Promise<void> {
    const self = indicator.id;
    await this.assertNoDirectoryConflict(
      `region_code = ? and id <> ? and region_name <> '' and (region_name <> ? or region_sort <> ?)`,
      [indicator.regionCode, self, indicator.regionName, indicator.regionSort],
      `conflicting directory metadata for region ${indicator.regionCode}`,
    );
    await this.assertNoDirectoryConflict(
      `category_id = ? and id <> ? and category_code <> '' and (category_code <> ? or category_name <> ? or category_sort <> ?)`,
      [indicator.categoryId, self, indicator.categoryCode, indicator.categoryName, indicator.categorySort],
      `conflicting directory metadata for category ${indicator.categoryId}`,
    );
    await this.assertNoDirectoryConflict(
      `metric_id = ? and id <> ? and metric_code <> '' and (
        category_id <> ? or metric_code <> ? or metric_name <> ? or metric_description <> ? or metric_sort <> ?
      )`,
      [indicator.metricId, self, indicator.categoryId, indicator.metricCode, indicator.metricName, indicator.metricDescription, indicator.metricSort],
      `conflicting directory metadata for metric ${indicator.metricId}`,
    );
  }

  private async assertNoDirectoryConflict(where: string, bindings: readonly unknown[], message: string): Promise<void> {
    const conflict = await this.db.prepare(`select id from macro_indicators where ${where} limit 1`).bind(...bindings).first<{ id: number }>();
    if (conflict) throw new Error(message);
  }
}

type IndicatorRow = Omit<MacroIndicator, "enabled"> & { enabled: number };

export type MacroCatalog = {
  regions: { code: string; name: string; sort: number }[];
  categories: { id: number; code: string; name: string; sort: number }[];
  metrics: { id: number; categoryId: number; code: string; name: string; description: string; sort: number }[];
  series: MacroIndicator[];
  capabilities: { frequencies: string[]; measurementKinds: string[]; yoyMethods: string[]; momMethods: string[] };
};

const indicatorColumns = `
  id, metric_id as metricId, category_id as categoryId, region_code as regionCode,
  definition_id as definitionId,
  region_name as regionName, region_sort as regionSort,
  category_code as categoryCode, category_name as categoryName, category_sort as categorySort,
  metric_code as metricCode, metric_name as metricName, metric_description as metricDescription,
  metric_sort as metricSort, statistical_definition as statisticalDefinition,
  name, frequency, unit, unit_format as unitFormat, measurement_kind as measurementKind,
  yoy_method as yoyMethod, yoy_base_periods as yoyBasePeriods, yoy_display_format as yoyDisplayFormat,
  mom_method as momMethod, mom_base_periods as momBasePeriods, mom_display_format as momDisplayFormat,
  default_trend_periods as defaultTrendPeriods, enabled,
  source_id as sourceId, source_series_id as sourceSeriesId, source_url as sourceUrl,
  publisher, publication_timestamp_strategy as publicationTimestampStrategy, source_batch_key as sourceBatchKey,
  seasonal_adjustment as seasonalAdjustment, lead_lag as leadLag,
  transform_method as transformMethod,
  stale_after_seconds as staleAfterSeconds,
  refresh_interval_seconds as refreshIntervalSeconds,
  revision_lookback_periods as revisionLookbackPeriods,
  next_fetch_at as nextFetchAt, last_success_at as lastSuccessAt,
  fetch_lease_until as fetchLeaseUntil, consecutive_failures as consecutiveFailures,
  last_error as lastError`;

function mapIndicatorRow(row: IndicatorRow): MacroIndicator {
  return { ...row, enabled: Boolean(row.enabled) };
}

function boundedLimit(value: number): number {
  return Number.isInteger(value) && value > 0 ? Math.min(value, 500) : 100;
}

function boundedIndicatorIds(indicatorIds: readonly number[]): number[] {
  const ids = [...new Set(indicatorIds)];
  if (ids.length > 200) throw new Error("macro latest snapshot query accepts at most 200 indicators");
  if (!ids.every((id) => Number.isInteger(id) && id > 0)) throw new Error("macro latest snapshot query requires positive integer indicator IDs");
  return ids;
}

function validateIndicator(indicator: MacroIndicator): void {
  const positiveIntegers: [string, number][] = [
    ["id", indicator.id], ["metricId", indicator.metricId], ["categoryId", indicator.categoryId],
    ["definitionId", indicator.definitionId], ["yoyBasePeriods", indicator.yoyBasePeriods],
    ["momBasePeriods", indicator.momBasePeriods], ["defaultTrendPeriods", indicator.defaultTrendPeriods],
  ];
  for (const [name, value] of positiveIntegers) {
    const permitsZero = name === "definitionId" || name === "yoyBasePeriods" || name === "momBasePeriods";
    if (!Number.isInteger(value) || value < (permitsZero ? 0 : 1)) throw new Error(`macro indicator requires a valid ${name}`);
  }
  for (const [name, value] of Object.entries({
    regionCode: indicator.regionCode, regionName: indicator.regionName, categoryCode: indicator.categoryCode,
    categoryName: indicator.categoryName, metricCode: indicator.metricCode, metricName: indicator.metricName,
    name: indicator.name, frequency: indicator.frequency, unit: indicator.unit, unitFormat: indicator.unitFormat,
    measurementKind: indicator.measurementKind, yoyMethod: indicator.yoyMethod, yoyDisplayFormat: indicator.yoyDisplayFormat,
    momMethod: indicator.momMethod, momDisplayFormat: indicator.momDisplayFormat,
  })) {
    if (!value.trim()) throw new Error(`macro indicator requires a non-empty ${name}`);
  }
}

function distinctDirectory<T>(
  series: readonly MacroIndicator[],
  key: (indicator: MacroIndicator) => string,
  value: (indicator: MacroIndicator) => T,
  compare: (left: T, right: T) => number,
): T[] {
  const entries = new Map<string, T>();
  for (const indicator of series) entries.set(key(indicator), value(indicator));
  return [...entries.values()].sort(compare);
}

function compareDirectory(left: { name: string; sort: number }, right: { name: string; sort: number }): number {
  return left.sort - right.sort || left.name.localeCompare(right.name);
}

function compareMetricDirectory(
  left: { name: string; sort: number; categoryId: number },
  right: { name: string; sort: number; categoryId: number },
): number {
  return left.categoryId - right.categoryId || left.sort - right.sort || left.name.localeCompare(right.name);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

/** Converts source calendar labels to the period start required by macro_data. */
export function toMacroPeriodDay(period: string | number | Date, frequency: MacroIndicatorFrequency): number {
  const parsed = parseMacroPeriod(period);
  let month = parsed.month;
  let day = parsed.day;
  if (frequency === "annual") { month = 1; day = 1; }
  else if (frequency === "quarterly") { month = Math.floor((month - 1) / 3) * 3 + 1; day = 1; }
  else if (frequency === "monthly") day = 1;
  validateCalendarDay(parsed.year, month, day);
  return parsed.year * 10_000 + month * 100 + day;
}

function parseMacroPeriod(period: string | number | Date): { year: number; month: number; day: number } {
  if (period instanceof Date) {
    if (!Number.isFinite(period.getTime())) throw new Error("invalid macro period date");
    return { year: period.getUTCFullYear(), month: period.getUTCMonth() + 1, day: period.getUTCDate() };
  }
  const text = String(period).trim();
  let match = /^(\d{4})[- ]?[Qq]([1-4])$/.exec(text);
  if (match) return { year: Number(match[1]), month: (Number(match[2]) - 1) * 3 + 1, day: 1 };
  match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(text);
  if (!match) throw new Error(`invalid macro period: ${text}`);
  return { year: Number(match[1]), month: match[2] ? Number(match[2]) : 1, day: match[3] ? Number(match[3]) : 1 };
}

function validateCalendarDay(year: number, month: number, day: number): void {
  if (!Number.isInteger(year) || year < 1000 || year > 9999 || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new Error("invalid macro period calendar value");
  }
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) {
    throw new Error("invalid macro period calendar date");
  }
}
