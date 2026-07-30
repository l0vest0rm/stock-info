import type {
  MacroEvent,
  MacroObservationVintage,
  MacroSeries,
  MacroSourceHealth,
  MacroUserWatchConfig,
} from "../domain/model";

export class D1MacroRepository {
  constructor(private readonly db: D1Database) {}

  async upsertSeries(series: MacroSeries): Promise<void> {
    await this.db.prepare(
      `insert into macro_series
        (series_id, name, category, region, frequency, unit, source_id,
         transmission_json, regions_json, license_class, stale_after_seconds,
         enabled, metadata_json, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(series_id) do update set
         name = excluded.name,
         category = excluded.category,
         region = excluded.region,
         frequency = excluded.frequency,
         unit = excluded.unit,
         source_id = excluded.source_id,
         transmission_json = excluded.transmission_json,
         regions_json = excluded.regions_json,
         license_class = excluded.license_class,
         stale_after_seconds = excluded.stale_after_seconds,
         enabled = excluded.enabled,
         metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at`
    ).bind(
      series.seriesId,
      series.name,
      series.category,
      series.region,
      series.frequency,
      series.unit,
      series.sourceId,
      JSON.stringify(series.transmissions),
      JSON.stringify(series.regions),
      series.licenseClass,
      series.staleAfterSeconds,
      series.enabled ? 1 : 0,
      JSON.stringify(series.metadata),
      series.updatedAt
    ).run();
  }

  async listSeries(filters: { region?: string; category?: string; enabledOnly?: boolean } = {}): Promise<MacroSeries[]> {
    const clauses: string[] = [];
    const bindings: unknown[] = [];
    if (filters.region) {
      clauses.push("region = ?");
      bindings.push(filters.region);
    }
    if (filters.category) {
      clauses.push("category = ?");
      bindings.push(filters.category);
    }
    if (filters.enabledOnly !== false) clauses.push("enabled = 1");
    const result = await this.db.prepare(
      `select series_id as seriesId, name, category, region, frequency, unit,
        source_id as sourceId, transmission_json as transmissionsJson,
        regions_json as regionsJson, license_class as licenseClass,
        stale_after_seconds as staleAfterSeconds, enabled,
        metadata_json as metadataJson, updated_at as updatedAt
       from macro_series
       ${clauses.length ? `where ${clauses.join(" and ")}` : ""}
       order by region, category, series_id`
    ).bind(...bindings).all<SeriesRow>();
    return (result.results ?? []).map(mapSeriesRow);
  }

  async putObservationVintages(observations: readonly MacroObservationVintage[]): Promise<void> {
    if (observations.length === 0) return;
    const sql = `insert into macro_observation_vintages
      (series_id, observation_date, released_at, vintage_at, revision_number,
       value, consensus, previous_value, is_preliminary, quality_status,
       source_url, raw_r2_key, observed_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(series_id, observation_date, vintage_at) do update set
       released_at = excluded.released_at,
       revision_number = excluded.revision_number,
       value = excluded.value,
       consensus = excluded.consensus,
       previous_value = excluded.previous_value,
       is_preliminary = excluded.is_preliminary,
       quality_status = excluded.quality_status,
       source_url = excluded.source_url,
       raw_r2_key = excluded.raw_r2_key,
       observed_at = excluded.observed_at`;
    for (let offset = 0; offset < observations.length; offset += 100) {
      await this.db.batch(observations.slice(offset, offset + 100).map((item) => this.db.prepare(sql).bind(
        item.seriesId,
        item.observationDate,
        item.releasedAt,
        item.vintageAt,
        item.revisionNumber,
        item.value,
        item.consensus,
        item.previousValue,
        item.isPreliminary ? 1 : 0,
        item.qualityStatus,
        item.sourceUrl,
        item.rawR2Key,
        item.observedAt
      )));
    }
  }

  async getObservationSeries(
    seriesId: string,
    options: { from?: string; to?: string; asOf?: number; includeAllVintages?: boolean } = {}
  ): Promise<MacroObservationVintage[]> {
    const clauses = ["series_id = ?"];
    const bindings: unknown[] = [seriesId];
    if (options.from) {
      clauses.push("observation_date >= ?");
      bindings.push(options.from);
    }
    if (options.to) {
      clauses.push("observation_date <= ?");
      bindings.push(options.to);
    }
    if (options.asOf !== undefined) {
      clauses.push("vintage_at <= ?");
      bindings.push(options.asOf);
    }
    const where = clauses.join(" and ");
    const ranked = `select series_id as seriesId, observation_date as observationDate,
      released_at as releasedAt, vintage_at as vintageAt, revision_number as revisionNumber,
      value, consensus, previous_value as previousValue, is_preliminary as isPreliminary,
      quality_status as qualityStatus, source_url as sourceUrl, raw_r2_key as rawR2Key,
      observed_at as observedAt,
      row_number() over (partition by series_id, observation_date order by vintage_at desc) as vintageRank
     from macro_observation_vintages where ${where}`;
    const query = options.includeAllVintages
      ? `select * from (${ranked}) order by observationDate, vintageAt`
      : `select * from (${ranked}) where vintageRank = 1 order by observationDate`;
    const result = await this.db.prepare(query).bind(...bindings).all<ObservationRow>();
    return (result.results ?? []).map(mapObservationRow);
  }

  async upsertEvent(event: MacroEvent): Promise<void> {
    await this.db.prepare(
      `insert into macro_events
        (event_id, scheduled_at, region, importance, title, series_id, actual,
         consensus, previous, unit, status, source_id, source_url, metadata_json, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(event_id) do update set
         scheduled_at = excluded.scheduled_at,
         region = excluded.region,
         importance = excluded.importance,
         title = excluded.title,
         series_id = excluded.series_id,
         actual = excluded.actual,
         consensus = excluded.consensus,
         previous = excluded.previous,
         unit = excluded.unit,
         status = excluded.status,
         source_id = excluded.source_id,
         source_url = excluded.source_url,
         metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at`
    ).bind(
      event.eventId, event.scheduledAt, event.region, event.importance, event.title,
      event.seriesId, event.actual, event.consensus, event.previous, event.unit,
      event.status, event.sourceId, event.sourceUrl, JSON.stringify(event.metadata), event.updatedAt
    ).run();
  }

  async listEvents(options: { from: number; to: number; regions?: string[]; importance?: string }): Promise<MacroEvent[]> {
    const clauses = ["scheduled_at >= ?", "scheduled_at <= ?"];
    const bindings: unknown[] = [options.from, options.to];
    if (options.regions?.length) {
      clauses.push(`region in (${options.regions.map(() => "?").join(",")})`);
      bindings.push(...options.regions);
    }
    if (options.importance) {
      clauses.push("importance = ?");
      bindings.push(options.importance);
    }
    const result = await this.db.prepare(
      `select event_id as eventId, scheduled_at as scheduledAt, region, importance,
        title, series_id as seriesId, actual, consensus, previous, unit, status,
        source_id as sourceId, source_url as sourceUrl, metadata_json as metadataJson,
        updated_at as updatedAt
       from macro_events where ${clauses.join(" and ")}
       order by scheduled_at, importance desc, event_id`
    ).bind(...bindings).all<EventRow>();
    return (result.results ?? []).map(mapEventRow);
  }

  async putSourceHealth(health: MacroSourceHealth): Promise<void> {
    await this.db.prepare(
      `insert into macro_source_health
        (source_id, display_name, state, last_attempt_at, last_success_at,
         consecutive_failures, last_error, next_retry_at, latency_ms, metadata_json, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(source_id) do update set
         display_name = excluded.display_name,
         state = excluded.state,
         last_attempt_at = excluded.last_attempt_at,
         last_success_at = excluded.last_success_at,
         consecutive_failures = excluded.consecutive_failures,
         last_error = excluded.last_error,
         next_retry_at = excluded.next_retry_at,
         latency_ms = excluded.latency_ms,
         metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at`
    ).bind(
      health.sourceId, health.displayName, health.state, health.lastAttemptAt,
      health.lastSuccessAt, health.consecutiveFailures, health.lastError,
      health.nextRetryAt, health.latencyMs, JSON.stringify(health.metadata), health.updatedAt
    ).run();
  }

  async listSourceHealth(): Promise<MacroSourceHealth[]> {
    const result = await this.db.prepare(
      `select source_id as sourceId, display_name as displayName, state,
        last_attempt_at as lastAttemptAt, last_success_at as lastSuccessAt,
        consecutive_failures as consecutiveFailures, last_error as lastError,
        next_retry_at as nextRetryAt, latency_ms as latencyMs,
        metadata_json as metadataJson, updated_at as updatedAt
       from macro_source_health order by source_id`
    ).all<SourceHealthRow>();
    return (result.results ?? []).map((row) => ({ ...row, metadata: parseObject(row.metadataJson) }));
  }

  async putUserWatch(config: MacroUserWatchConfig): Promise<void> {
    await this.db.prepare(
      `insert into macro_user_watch_configs
        (owner_key, series_id, enabled, position, alert_rules_json,
         display_options_json, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(owner_key, series_id) do update set
         enabled = excluded.enabled,
         position = excluded.position,
         alert_rules_json = excluded.alert_rules_json,
         display_options_json = excluded.display_options_json,
         updated_at = excluded.updated_at`
    ).bind(
      config.ownerKey, config.seriesId, config.enabled ? 1 : 0, config.position,
      JSON.stringify(config.alertRules), JSON.stringify(config.displayOptions),
      config.createdAt, config.updatedAt
    ).run();
  }

  async listUserWatches(ownerKey: string): Promise<MacroUserWatchConfig[]> {
    const result = await this.db.prepare(
      `select owner_key as ownerKey, series_id as seriesId, enabled, position,
        alert_rules_json as alertRulesJson, display_options_json as displayOptionsJson,
        created_at as createdAt, updated_at as updatedAt
       from macro_user_watch_configs where owner_key = ?
       order by position, series_id`
    ).bind(ownerKey).all<UserWatchRow>();
    return (result.results ?? []).map((row) => ({
      ...row,
      enabled: Boolean(row.enabled),
      alertRules: parseArray(row.alertRulesJson),
      displayOptions: parseObject(row.displayOptionsJson),
    }));
  }
}

type SeriesRow = Omit<MacroSeries, "transmissions" | "regions" | "metadata" | "enabled"> & {
  transmissionsJson: string; regionsJson: string; metadataJson: string; enabled: number;
};
type ObservationRow = Omit<MacroObservationVintage, "isPreliminary"> & { isPreliminary: number; vintageRank: number };
type EventRow = Omit<MacroEvent, "metadata"> & { metadataJson: string };
type SourceHealthRow = Omit<MacroSourceHealth, "metadata"> & { metadataJson: string };
type UserWatchRow = Omit<MacroUserWatchConfig, "enabled" | "alertRules" | "displayOptions"> & {
  enabled: number; alertRulesJson: string; displayOptionsJson: string;
};

function mapSeriesRow(row: SeriesRow): MacroSeries {
  return {
    ...row,
    enabled: Boolean(row.enabled),
    transmissions: parseArray(row.transmissionsJson) as MacroSeries["transmissions"],
    regions: parseArray(row.regionsJson) as string[],
    metadata: parseObject(row.metadataJson),
  };
}

function mapObservationRow(row: ObservationRow): MacroObservationVintage {
  const { vintageRank: _vintageRank, ...observation } = row;
  return { ...observation, isPreliminary: Boolean(row.isPreliminary) };
}

function mapEventRow(row: EventRow): MacroEvent {
  return { ...row, metadata: parseObject(row.metadataJson) };
}

function parseArray(value: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
