// src/modules/macro/application/sync-macro-data.test.ts
import assert from "node:assert/strict";
import test from "node:test";

// src/modules/macro/adapters/errors.ts
var MacroSourceError = class extends Error {
  constructor(sourceId, code, message, retryable, options) {
    super(message, options);
    this.sourceId = sourceId;
    this.code = code;
    this.retryable = retryable;
    this.name = "MacroSourceError";
  }
  sourceId;
  code;
  retryable;
};

// src/modules/macro/adapters/http.ts
async function fetchJson(sourceId, fetcher, url, timeoutMs, init = {}) {
  let response;
  try {
    response = await fetcher(url, {
      ...init,
      headers: { Accept: "application/json", ...init.headers },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new MacroSourceError(
      sourceId,
      timedOut ? "timeout" : "http_error",
      `${sourceId} request ${timedOut ? "timed out" : "failed"}`,
      true,
      { cause: error }
    );
  }
  if (!response.ok) {
    throw new MacroSourceError(sourceId, "http_error", `${sourceId} request failed: status=${response.status}`, response.status >= 500 || response.status === 429);
  }
  try {
    return await response.json();
  } catch (error) {
    throw new MacroSourceError(sourceId, "invalid_response", `${sourceId} returned invalid JSON`, false, { cause: error });
  }
}
async function fetchText(sourceId, fetcher, url, timeoutMs, init = {}) {
  let response;
  try {
    response = await fetcher(url, {
      ...init,
      headers: { Accept: "text/plain,text/csv,text/html", ...init.headers },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new MacroSourceError(
      sourceId,
      timedOut ? "timeout" : "http_error",
      `${sourceId} request ${timedOut ? "timed out" : "failed"}`,
      true,
      { cause: error }
    );
  }
  if (!response.ok) {
    throw new MacroSourceError(sourceId, "http_error", `${sourceId} request failed: status=${response.status}`, response.status >= 500 || response.status === 429);
  }
  return response.text();
}
function finiteNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "" || value.trim() === ".") return null;
  const parsed = Number(value.replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : null;
}
function recordArray(value) {
  return Array.isArray(value) && value.every((item) => item !== null && typeof item === "object") ? value : null;
}

// src/modules/macro/adapters/fred.ts
var SOURCE_ID = "fred";
var ENDPOINT = "https://api.stlouisfed.org/fred/series/observations";
var PUBLIC_CSV_ENDPOINT = "https://fred.stlouisfed.org/graph/fredgraph.csv";
var FredAdapter = class {
  constructor(apiKey, fetcher = fetch, timeoutMs = 2e4) {
    this.apiKey = apiKey;
    this.fetcher = fetcher;
    this.timeoutMs = timeoutMs;
  }
  apiKey;
  fetcher;
  timeoutMs;
  sourceId = SOURCE_ID;
  async load(request) {
    if (!/^[A-Za-z0-9._-]+$/.test(request.seriesId)) {
      throw new MacroSourceError(SOURCE_ID, "invalid_request", "Invalid FRED series id", false);
    }
    return this.apiKey?.trim() ? this.loadApi(request, this.apiKey.trim()) : this.loadPublicCsv(request);
  }
  async loadApi(request, apiKey) {
    const sourceSeriesId = request.sourceSeriesId ?? request.seriesId;
    const url = new URL(ENDPOINT);
    url.searchParams.set("series_id", sourceSeriesId);
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("file_type", "json");
    if (request.observationStart) url.searchParams.set("observation_start", request.observationStart);
    if (request.observationEnd) url.searchParams.set("observation_end", request.observationEnd);
    const requestUrl = url.toString();
    const publicSourceUrl = redactApiKey(requestUrl);
    const payload = await fetchJson(SOURCE_ID, this.fetcher, requestUrl, this.timeoutMs);
    const root = asRecord(payload);
    const rows = recordArray(root?.observations);
    if (!rows) throw new MacroSourceError(SOURCE_ID, "invalid_response", "FRED response is missing observations", false);
    const observations = rows.flatMap((row) => {
      const observedAt = text(row.date);
      const value = finiteNumber(row.value);
      if (!observedAt || value === null) return [];
      return [{
        // Persistence joins observations to the source catalog by the
        // provider's series identifier.  `request.seriesId` is only an
        // internal caller label and must never leak into that join.
        seriesId: sourceSeriesId,
        value,
        observedAt,
        releasedAt: text(row.realtime_start),
        vintage: vintage(row),
        sourceUrl: publicSourceUrl
      }];
    });
    return {
      series: [{ id: request.seriesId, sourceId: SOURCE_ID, sourceSeriesId, name: request.name, frequency: request.frequency, unit: request.unit, sourceUrl: publicSourceUrl }],
      observations,
      health: { sourceId: SOURCE_ID, state: "healthy", checkedAt: (/* @__PURE__ */ new Date()).toISOString(), observationCount: observations.length, message: null }
    };
  }
  async loadPublicCsv(request) {
    const sourceSeriesId = request.sourceSeriesId ?? request.seriesId;
    const url = new URL(PUBLIC_CSV_ENDPOINT);
    url.searchParams.set("id", sourceSeriesId);
    if (request.observationStart) url.searchParams.set("cosd", request.observationStart);
    if (request.observationEnd) url.searchParams.set("coed", request.observationEnd);
    const sourceUrl = url.toString();
    const csv = await fetchText(SOURCE_ID, this.fetcher, sourceUrl, this.timeoutMs, {
      headers: { "User-Agent": "Mozilla/5.0 stock-info-macro/0.1", "Accept-Language": "en-US,en;q=0.8" }
    });
    const lines = csv.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
    const header = lines.shift()?.split(",").map((item) => item.trim()) ?? [];
    if (header[0] !== "observation_date" || header[1] !== sourceSeriesId) {
      throw new MacroSourceError(SOURCE_ID, "invalid_response", "FRED CSV response has an unexpected header", false);
    }
    const observations = lines.flatMap((line) => {
      const separator = line.indexOf(",");
      if (separator < 0) return [];
      const observedAt = line.slice(0, separator).trim();
      const value = finiteNumber(line.slice(separator + 1));
      return /^\d{4}-\d{2}-\d{2}$/.test(observedAt) && value !== null ? [{
        seriesId: sourceSeriesId,
        value,
        observedAt,
        releasedAt: null,
        vintage: null,
        sourceUrl
      }] : [];
    });
    return {
      series: [{ id: request.seriesId, sourceId: SOURCE_ID, sourceSeriesId, name: request.name, frequency: request.frequency, unit: request.unit, sourceUrl }],
      observations,
      health: { sourceId: SOURCE_ID, state: "healthy", checkedAt: (/* @__PURE__ */ new Date()).toISOString(), observationCount: observations.length, message: "official public CSV" }
    };
  }
};
function asRecord(value) {
  return value !== null && typeof value === "object" ? value : null;
}
function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function vintage(row) {
  const start = text(row.realtime_start);
  const end = text(row.realtime_end);
  return start && end ? `${start}/${end}` : start ?? end;
}
function redactApiKey(url) {
  const safe = new URL(url);
  safe.searchParams.delete("api_key");
  return safe.toString();
}

// src/modules/macro/adapters/bls.ts
var SOURCE_ID2 = "bls";
var ENDPOINT2 = "https://api.bls.gov/publicAPI/v2/timeseries/data/";
var RELEASE_CALENDAR_URL = "https://www.bls.gov/schedule/news_release/";
var BlsPublicDataAdapter = class {
  constructor(fetcher = fetch, timeoutMs = 7e3) {
    this.fetcher = fetcher;
    this.timeoutMs = timeoutMs;
  }
  fetcher;
  timeoutMs;
  sourceId = SOURCE_ID2;
  async load(request) {
    const maxSeries = request.registrationKey ? 50 : 25;
    if (request.series.length === 0 || request.series.length > maxSeries || request.startYear > request.endYear) {
      throw new MacroSourceError(SOURCE_ID2, "invalid_request", `BLS requires 1-${maxSeries} series and a valid year range`, false);
    }
    const body = { seriesid: request.series.map((item) => item.id), startyear: String(request.startYear), endyear: String(request.endYear) };
    if (request.registrationKey?.trim()) body.registrationkey = request.registrationKey.trim();
    const payload = await fetchJson(SOURCE_ID2, this.fetcher, ENDPOINT2, this.timeoutMs, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const root = asRecord2(payload);
    if (root?.status !== "REQUEST_SUCCEEDED") {
      throw new MacroSourceError(SOURCE_ID2, "invalid_response", `BLS request failed: ${messages(root).join("; ") || "unknown response"}`, false);
    }
    const results = asRecord2(root.Results);
    const returnedSeries = recordArray(results?.series);
    if (!returnedSeries) throw new MacroSourceError(SOURCE_ID2, "invalid_response", "BLS response is missing Results.series", false);
    const observations = returnedSeries.flatMap((sourceSeries) => {
      const seriesId = text2(sourceSeries.seriesID);
      const rows = recordArray(sourceSeries.data);
      if (!seriesId || !rows) return [];
      return rows.flatMap((row) => {
        const observedAt = periodDate(text2(row.year), text2(row.period));
        const value = finiteNumber(row.value);
        return observedAt && value !== null ? [{
          seriesId,
          value,
          observedAt,
          releasedAt: null,
          vintage: row.latest === "true" ? "latest" : null,
          sourceUrl: ENDPOINT2
        }] : [];
      });
    }).sort((a, b) => a.observedAt.localeCompare(b.observedAt));
    return {
      series: request.series.map((item) => ({ id: item.id, sourceId: SOURCE_ID2, sourceSeriesId: item.id, name: item.name, frequency: item.frequency ?? "monthly", unit: item.unit, sourceUrl: ENDPOINT2 })),
      observations,
      health: { sourceId: SOURCE_ID2, state: "healthy", checkedAt: (/* @__PURE__ */ new Date()).toISOString(), observationCount: observations.length, message: null }
    };
  }
};
async function loadBlsReleaseCalendar(fetcher = fetch, nowSeconds = Math.floor(Date.now() / 1e3), timeoutMs = 7e3) {
  const html = await fetchText("bls", fetcher, RELEASE_CALENDAR_URL, timeoutMs, {
    headers: { "User-Agent": "Mozilla/5.0 stock-info-macro/0.1", "Accept-Language": "en-US,en;q=0.8" }
  });
  const result = /* @__PURE__ */ new Map();
  for (const row of html.split(/<tr\b/i)) {
    const textRow = htmlText(row);
    const family = releaseFamily(textRow);
    const publishedAt = calendarTimestamp(textRow);
    if (!family || publishedAt === null || publishedAt > nowSeconds) continue;
    const previous = result.get(family);
    if (previous === void 0 || publishedAt > previous) result.set(family, publishedAt);
  }
  return result;
}
function asRecord2(value) {
  return value !== null && typeof value === "object" ? value : null;
}
function text2(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function messages(root) {
  return Array.isArray(root?.message) ? root.message.filter((item) => typeof item === "string") : [];
}
function periodDate(year, period) {
  if (!year || !period) return null;
  const monthly = /^M(0[1-9]|1[0-2])$/.exec(period);
  if (monthly) return `${year}-${monthly[1]}`;
  const quarterly = /^Q0?([1-4])$/.exec(period);
  if (quarterly) return `${year}-Q${quarterly[1]}`;
  return null;
}
function releaseFamily(value) {
  if (/employment situation/i.test(value)) return "employment";
  if (/job openings and labor turnover|jolts/i.test(value)) return "jolts";
  if (/producer price index/i.test(value)) return "ppi";
  return null;
}
function calendarTimestamp(value) {
  const numeric = /\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/.exec(value);
  const named = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(20\d{2})\b/i.exec(value);
  const parsed = numeric ? Date.UTC(Number(numeric[3]), Number(numeric[1]) - 1, Number(numeric[2]), 12) : named ? Date.parse(`${named[1]} ${named[2]}, ${named[3]} 12:00:00 UTC`) : NaN;
  return Number.isFinite(parsed) ? Math.floor(parsed / 1e3) : null;
}
function htmlText(value) {
  return value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
}

// src/modules/macro/adapters/local-relay.ts
var OFFICIAL_MACRO_HOSTS = /* @__PURE__ */ new Set([
  "api.bls.gov",
  "www.bls.gov",
  "api.stlouisfed.org",
  "fred.stlouisfed.org"
]);
function macroFetch(_env) {
  return (async (input, init) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
    if (url.protocol !== "https:" || !OFFICIAL_MACRO_HOSTS.has(url.hostname.toLowerCase())) {
      throw new Error(`macro source is not allowlisted: ${url.origin}`);
    }
    return fetch(input, init);
  });
}

// src/modules/macro/config/indicators.ts
var MacroSourceRegistrationError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "MacroSourceRegistrationError";
    this.code = code;
  }
};
function resolveRegisteredMacroSourceMapping(indicator2) {
  const sourceId = indicator2.sourceId?.trim();
  const sourceSeriesId = indicator2.sourceSeriesId?.trim();
  const publicationTimestampStrategy = indicator2.publicationTimestampStrategy?.trim();
  const sourceBatchKey = indicator2.sourceBatchKey?.trim();
  if (!sourceId || !sourceSeriesId || !publicationTimestampStrategy || !sourceBatchKey) {
    throw new MacroSourceRegistrationError(
      "unmapped_source",
      `macro indicator ${indicator2.id} has no complete source mapping`
    );
  }
  if (sourceId === "fred") {
    if (!/^[A-Za-z0-9._-]+$/.test(sourceSeriesId)) {
      throw new MacroSourceRegistrationError("invalid_source_series", `macro indicator ${indicator2.id} has an invalid FRED source series id`);
    }
    if (publicationTimestampStrategy !== "fred_realtime_start") {
      throw new MacroSourceRegistrationError("unsupported_release_calendar", `macro indicator ${indicator2.id} has an unsupported FRED publication timestamp strategy`);
    }
    return { sourceId, sourceSeriesId, publicationTimestampStrategy, sourceBatchKey };
  }
  if (sourceId === "bls") {
    if (!/^[A-Z0-9]+$/.test(sourceSeriesId)) {
      throw new MacroSourceRegistrationError("invalid_source_series", `macro indicator ${indicator2.id} has an invalid BLS source series id`);
    }
    const blsReleaseFamily = resolveBlsReleaseFamily(sourceSeriesId);
    if (!blsReleaseFamily) {
      throw new MacroSourceRegistrationError(
        "unsupported_release_calendar",
        `macro indicator ${indicator2.id} uses BLS series ${sourceSeriesId} without a verified release-calendar family`
      );
    }
    if (publicationTimestampStrategy !== "bls_release_calendar") {
      throw new MacroSourceRegistrationError("unsupported_release_calendar", `macro indicator ${indicator2.id} has an unsupported BLS publication timestamp strategy`);
    }
    return { sourceId, sourceSeriesId, publicationTimestampStrategy, sourceBatchKey, blsReleaseFamily };
  }
  throw new MacroSourceRegistrationError("unsupported_source", `macro indicator ${indicator2.id} uses unsupported scheduled source: ${sourceId}`);
}
function resolveBlsReleaseFamily(seriesId) {
  if (seriesId.startsWith("LNS")) return "employment";
  if (seriesId.startsWith("JTS")) return "jolts";
  if (seriesId.startsWith("WPU")) return "ppi";
  return null;
}

// src/modules/macro/application/macro-repository.ts
var D1MacroRepository = class {
  constructor(db) {
    this.db = db;
  }
  db;
  /** Upserts the static catalog/source contract without resetting scheduler state. */
  async upsertIndicator(indicator2) {
    validateIndicator(indicator2);
    await this.assertDirectoryConsistency(indicator2);
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
      indicator2.id,
      indicator2.metricId,
      indicator2.categoryId,
      indicator2.regionCode,
      indicator2.definitionId,
      indicator2.regionName,
      indicator2.regionSort,
      indicator2.categoryCode,
      indicator2.categoryName,
      indicator2.categorySort,
      indicator2.metricCode,
      indicator2.metricName,
      indicator2.metricDescription,
      indicator2.metricSort,
      indicator2.statisticalDefinition,
      indicator2.name,
      indicator2.frequency,
      indicator2.unit,
      indicator2.unitFormat,
      indicator2.measurementKind,
      indicator2.yoyMethod,
      indicator2.yoyBasePeriods,
      indicator2.yoyDisplayFormat,
      indicator2.momMethod,
      indicator2.momBasePeriods,
      indicator2.momDisplayFormat,
      indicator2.defaultTrendPeriods,
      indicator2.enabled ? 1 : 0,
      indicator2.sourceId,
      indicator2.sourceSeriesId,
      indicator2.sourceUrl,
      indicator2.publisher,
      indicator2.publicationTimestampStrategy,
      indicator2.sourceBatchKey,
      indicator2.seasonalAdjustment,
      indicator2.leadLag,
      indicator2.transformMethod,
      indicator2.staleAfterSeconds,
      indicator2.refreshIntervalSeconds,
      indicator2.revisionLookbackPeriods,
      indicator2.nextFetchAt,
      indicator2.lastSuccessAt,
      indicator2.fetchLeaseUntil,
      indicator2.consecutiveFailures,
      indicator2.lastError
    ).run();
  }
  async listIndicators(options = {}) {
    const clauses = [];
    const bindings = [];
    if (options.regions?.length) {
      clauses.push(`region_code in (${options.regions.map(() => "?").join(",")})`);
      bindings.push(...options.regions);
    }
    if (options.enabledOnly !== false) clauses.push("enabled = 1");
    const result = await this.db.prepare(
      `select ${indicatorColumns} from macro_indicators
       ${clauses.length ? `where ${clauses.join(" and ")}` : ""}
       order by region_sort, region_name, category_sort, category_name, metric_sort, metric_name, definition_id`
    ).bind(...bindings).all();
    return (result.results ?? []).map(mapIndicatorRow);
  }
  /** Returns all dynamic display dimensions derived from the persisted catalog. */
  async listCatalog(options = {}) {
    const series = await this.listIndicators({ enabledOnly: options.enabledOnly });
    const regions = distinctDirectory(series, (indicator2) => indicator2.regionCode, (indicator2) => ({
      code: indicator2.regionCode,
      name: indicator2.regionName,
      sort: indicator2.regionSort
    }), compareDirectory);
    const categories = distinctDirectory(series, (indicator2) => String(indicator2.categoryId), (indicator2) => ({
      id: indicator2.categoryId,
      code: indicator2.categoryCode,
      name: indicator2.categoryName,
      sort: indicator2.categorySort
    }), compareDirectory);
    const metrics = distinctDirectory(series, (indicator2) => String(indicator2.metricId), (indicator2) => ({
      id: indicator2.metricId,
      categoryId: indicator2.categoryId,
      code: indicator2.metricCode,
      name: indicator2.metricName,
      description: indicator2.metricDescription,
      sort: indicator2.metricSort
    }), compareMetricDirectory);
    return {
      regions,
      categories,
      metrics,
      series,
      capabilities: {
        frequencies: uniqueSorted(series.map((indicator2) => indicator2.frequency)),
        measurementKinds: uniqueSorted(series.map((indicator2) => indicator2.measurementKind)),
        yoyMethods: uniqueSorted(series.map((indicator2) => indicator2.yoyMethod)),
        momMethods: uniqueSorted(series.map((indicator2) => indicator2.momMethod))
      }
    };
  }
  async listDueIndicators(now, limit = 100) {
    const result = await this.db.prepare(
      `select ${indicatorColumns} from macro_indicators
       where enabled = 1
         and source_id is not null
         and refresh_interval_seconds > 0
         and next_fetch_at is not null
         and next_fetch_at <= ?
         and (fetch_lease_until is null or fetch_lease_until <= ?)
       order by next_fetch_at, id limit ?`
    ).bind(now, now, boundedLimit(limit)).all();
    return (result.results ?? []).map(mapIndicatorRow);
  }
  /** Atomically claims one due indicator so overlapping scheduled runs cannot duplicate a fetch. */
  async claimIndicator(indicatorId, now, leaseUntil) {
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
  async scheduleNextFetch(input) {
    const result = await this.db.prepare(
      `update macro_indicators set
        next_fetch_at = ?,
        last_success_at = case when ? = 1 then ? else last_success_at end,
        fetch_lease_until = null,
        consecutive_failures = case when ? = 1 then 0 else consecutive_failures + 1 end,
        last_error = case when ? = 1 then null else ? end
       where id = ? and fetch_lease_until = ?`
    ).bind(
      input.nextFetchAt,
      input.success ? 1 : 0,
      input.completedAt,
      input.success ? 1 : 0,
      input.success ? 1 : 0,
      input.lastError ?? null,
      input.indicatorId,
      input.leaseUntil
    ).run();
    return (result.meta.changes ?? 0) === 1;
  }
  async putData(points) {
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
  async getDataSeries(indicatorId, options = {}) {
    const clauses = ["indicator_id = ?"];
    const bindings = [indicatorId];
    if (options.fromPeriodDay !== void 0) {
      clauses.push("period_day >= ?");
      bindings.push(options.fromPeriodDay);
    }
    if (options.toPeriodDay !== void 0) {
      clauses.push("period_day <= ?");
      bindings.push(options.toPeriodDay);
    }
    if (options.asOf !== void 0) {
      clauses.push("published_at <= ?");
      bindings.push(options.asOf);
    }
    const where = clauses.join(" and ");
    const sql = options.includeAllVersions ? `select indicator_id as indicatorId, period_day as periodDay, published_at as publishedAt, value
         from macro_data where ${where} order by period_day, published_at` : `select indicator_id as indicatorId, period_day as periodDay, published_at as publishedAt, value
          from (
            select indicator_id, period_day, published_at, value,
              row_number() over (partition by period_day order by published_at desc) as version_rank
            from macro_data where ${where}
          ) where version_rank = 1 order by period_day`;
    const result = await this.db.prepare(sql).bind(...bindings).all();
    return result.results ?? [];
  }
  /**
   * Retrieves at most one visible latest revision per requested concrete
   * series. The query is bounded by explicit IDs and selects revisions after
   * applying `asOf`, preventing future revisions from leaking into a replay.
   */
  async getLatestSnapshots(indicatorIds, asOf) {
    const ids = boundedIndicatorIds(indicatorIds);
    if (ids.length === 0) return [];
    const idPlaceholders = ids.map(() => "?").join(",");
    const asOfClause = asOf === void 0 ? "" : " and published_at <= ?";
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
    ).bind(...ids, ...asOf === void 0 ? [] : [asOf]).all();
    return result.results ?? [];
  }
  async getLatestData(indicatorId, asOf) {
    return (await this.getLatestSnapshots([indicatorId], asOf))[0] ?? null;
  }
  async assertDirectoryConsistency(indicator2) {
    const self = indicator2.id;
    await this.assertNoDirectoryConflict(
      `region_code = ? and id <> ? and region_name <> '' and (region_name <> ? or region_sort <> ?)`,
      [indicator2.regionCode, self, indicator2.regionName, indicator2.regionSort],
      `conflicting directory metadata for region ${indicator2.regionCode}`
    );
    await this.assertNoDirectoryConflict(
      `category_id = ? and id <> ? and category_code <> '' and (category_code <> ? or category_name <> ? or category_sort <> ?)`,
      [indicator2.categoryId, self, indicator2.categoryCode, indicator2.categoryName, indicator2.categorySort],
      `conflicting directory metadata for category ${indicator2.categoryId}`
    );
    await this.assertNoDirectoryConflict(
      `metric_id = ? and id <> ? and metric_code <> '' and (
        category_id <> ? or metric_code <> ? or metric_name <> ? or metric_description <> ? or metric_sort <> ?
      )`,
      [indicator2.metricId, self, indicator2.categoryId, indicator2.metricCode, indicator2.metricName, indicator2.metricDescription, indicator2.metricSort],
      `conflicting directory metadata for metric ${indicator2.metricId}`
    );
  }
  async assertNoDirectoryConflict(where, bindings, message) {
    const conflict = await this.db.prepare(`select id from macro_indicators where ${where} limit 1`).bind(...bindings).first();
    if (conflict) throw new Error(message);
  }
};
var indicatorColumns = `
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
function mapIndicatorRow(row) {
  return { ...row, enabled: Boolean(row.enabled) };
}
function boundedLimit(value) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, 500) : 100;
}
function boundedIndicatorIds(indicatorIds) {
  const ids = [...new Set(indicatorIds)];
  if (ids.length > 200) throw new Error("macro latest snapshot query accepts at most 200 indicators");
  if (!ids.every((id) => Number.isInteger(id) && id > 0)) throw new Error("macro latest snapshot query requires positive integer indicator IDs");
  return ids;
}
function validateIndicator(indicator2) {
  const positiveIntegers = [
    ["id", indicator2.id],
    ["metricId", indicator2.metricId],
    ["categoryId", indicator2.categoryId],
    ["definitionId", indicator2.definitionId],
    ["yoyBasePeriods", indicator2.yoyBasePeriods],
    ["momBasePeriods", indicator2.momBasePeriods],
    ["defaultTrendPeriods", indicator2.defaultTrendPeriods]
  ];
  for (const [name, value] of positiveIntegers) {
    const permitsZero = name === "definitionId" || name === "yoyBasePeriods" || name === "momBasePeriods";
    if (!Number.isInteger(value) || value < (permitsZero ? 0 : 1)) throw new Error(`macro indicator requires a valid ${name}`);
  }
  for (const [name, value] of Object.entries({
    regionCode: indicator2.regionCode,
    regionName: indicator2.regionName,
    categoryCode: indicator2.categoryCode,
    categoryName: indicator2.categoryName,
    metricCode: indicator2.metricCode,
    metricName: indicator2.metricName,
    name: indicator2.name,
    frequency: indicator2.frequency,
    unit: indicator2.unit,
    unitFormat: indicator2.unitFormat,
    measurementKind: indicator2.measurementKind,
    yoyMethod: indicator2.yoyMethod,
    yoyDisplayFormat: indicator2.yoyDisplayFormat,
    momMethod: indicator2.momMethod,
    momDisplayFormat: indicator2.momDisplayFormat
  })) {
    if (!value.trim()) throw new Error(`macro indicator requires a non-empty ${name}`);
  }
}
function distinctDirectory(series, key, value, compare) {
  const entries = /* @__PURE__ */ new Map();
  for (const indicator2 of series) entries.set(key(indicator2), value(indicator2));
  return [...entries.values()].sort(compare);
}
function compareDirectory(left, right) {
  return left.sort - right.sort || left.name.localeCompare(right.name);
}
function compareMetricDirectory(left, right) {
  return left.categoryId - right.categoryId || left.sort - right.sort || left.name.localeCompare(right.name);
}
function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
function toMacroPeriodDay(period, frequency) {
  const parsed = parseMacroPeriod(period);
  let month = parsed.month;
  let day = parsed.day;
  if (frequency === "annual") {
    month = 1;
    day = 1;
  } else if (frequency === "quarterly") {
    month = Math.floor((month - 1) / 3) * 3 + 1;
    day = 1;
  } else if (frequency === "monthly") day = 1;
  validateCalendarDay(parsed.year, month, day);
  return parsed.year * 1e4 + month * 100 + day;
}
function parseMacroPeriod(period) {
  if (period instanceof Date) {
    if (!Number.isFinite(period.getTime())) throw new Error("invalid macro period date");
    return { year: period.getUTCFullYear(), month: period.getUTCMonth() + 1, day: period.getUTCDate() };
  }
  const text3 = String(period).trim();
  let match = /^(\d{4})[- ]?[Qq]([1-4])$/.exec(text3);
  if (match) return { year: Number(match[1]), month: (Number(match[2]) - 1) * 3 + 1, day: 1 };
  match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(text3);
  if (!match) throw new Error(`invalid macro period: ${text3}`);
  return { year: Number(match[1]), month: match[2] ? Number(match[2]) : 1, day: match[3] ? Number(match[3]) : 1 };
}
function validateCalendarDay(year, month, day) {
  if (!Number.isInteger(year) || year < 1e3 || year > 9999 || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new Error("invalid macro period calendar value");
  }
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) {
    throw new Error("invalid macro period calendar date");
  }
}

// src/modules/macro/application/sync-macro-data.ts
var LEASE_SECONDS = 5 * 60;
var FAILURE_BACKOFF_MAX_SECONDS = 24 * 60 * 60;
var INITIAL_BACKFILL_YEARS = 10;
async function syncMacroData(env, scheduledTime = Date.now(), dependencies = {}) {
  const now = toSeconds(scheduledTime);
  const repository = dependencies.repository ?? new D1MacroRepository(env.DB);
  const stats = {
    indicatorsDue: 0,
    indicatorsClaimed: 0,
    indicatorsRejectedSourceMapping: 0,
    sourceBatchesAttempted: 0,
    sourceBatchesSucceeded: 0,
    observationsWritten: 0,
    observationsRejectedWithoutPublishedAt: 0
  };
  const due = await repository.listDueIndicators(now);
  stats.indicatorsDue = due.length;
  const claimed = [];
  for (const indicator2 of due) {
    const leaseUntil = now + LEASE_SECONDS;
    if (!await repository.claimIndicator(indicator2.id, now, leaseUntil)) continue;
    try {
      const mapping = resolveRegisteredMacroSourceMapping(indicator2);
      claimed.push({ ...indicator2, leaseUntil, mapping });
    } catch (error) {
      stats.indicatorsRejectedSourceMapping += 1;
      await repository.scheduleNextFetch({
        indicatorId: indicator2.id,
        leaseUntil,
        nextFetchAt: now + failureBackoffSeconds(indicator2.consecutiveFailures),
        completedAt: now,
        success: false,
        lastError: errorMessage(error)
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
      await Promise.all(indicators.map((indicator2) => repository.scheduleNextFetch({
        indicatorId: indicator2.id,
        leaseUntil: indicator2.leaseUntil,
        nextFetchAt: now + indicator2.refreshIntervalSeconds,
        completedAt: now,
        success: true
      })));
    } catch (error) {
      const message = errorMessage(error);
      await Promise.all(indicators.map((indicator2) => repository.scheduleNextFetch({
        indicatorId: indicator2.id,
        leaseUntil: indicator2.leaseUntil,
        nextFetchAt: now + failureBackoffSeconds(indicator2.consecutiveFailures),
        completedAt: now,
        success: false,
        lastError: message
      })));
    }
  }
  return stats;
}
async function syncSourceBatch(sourceId, indicators, repository, env, now) {
  const fetcher = macroFetch(env);
  if (sourceId === "fred") {
    if (!env.FRED_API_KEY?.trim()) throw new MacroSourceError("fred", "missing_credential", "FRED_API_KEY is required for trustworthy realtime_start timestamps", false);
    const adapter = new FredAdapter(env.FRED_API_KEY, fetcher);
    const results = await Promise.all(indicators.map(async (indicator2) => adapter.load({
      seriesId: String(indicator2.id),
      sourceSeriesId: indicator2.mapping.sourceSeriesId,
      name: indicator2.name,
      frequency: indicator2.frequency,
      unit: indicator2.unit,
      observationStart: await observationStart(repository, indicator2, now),
      observationEnd: isoDate(now)
    })));
    return persistResults(
      results,
      indicators,
      repository,
      (indicator2, observation) => indicator2.mapping.publicationTimestampStrategy === "fred_realtime_start" ? timestampFromSource(observation.releasedAt) : null
    );
  }
  if (sourceId === "bls") {
    const releaseCalendar = await loadBlsReleaseCalendar(fetcher, now);
    const earliest = Math.min(...await Promise.all(indicators.map((indicator2) => observationStartYear(repository, indicator2, now))));
    const result = await new BlsPublicDataAdapter(fetcher).load({
      series: indicators.map((indicator2) => ({ id: indicator2.mapping.sourceSeriesId, name: indicator2.name, unit: indicator2.unit, frequency: indicator2.frequency })),
      startYear: earliest,
      endYear: new Date(now * 1e3).getUTCFullYear(),
      registrationKey: env.BLS_API_KEY
    });
    return persistResults(
      [result],
      indicators,
      repository,
      (indicator2) => {
        return indicator2.mapping.publicationTimestampStrategy === "bls_release_calendar" && indicator2.mapping.blsReleaseFamily ? releaseCalendar.get(indicator2.mapping.blsReleaseFamily) ?? null : null;
      }
    );
  }
  throw new Error(`unsupported scheduled macro source: ${sourceId}`);
}
async function persistResults(results, indicators, repository, publishedAt) {
  const bySourceSeries = new Map(indicators.map((indicator2) => [indicator2.mapping.sourceSeriesId, indicator2]));
  const observations = results.flatMap((result) => result.observations);
  const pending = [];
  let rejectedWithoutPublishedAt = 0;
  for (const observation of observations) {
    const indicator2 = bySourceSeries.get(observation.seriesId);
    if (!indicator2) continue;
    const releasedAt = publishedAt(indicator2, observation);
    if (releasedAt === null) {
      rejectedWithoutPublishedAt += 1;
      continue;
    }
    pending.push({ indicatorId: indicator2.id, period: observation.observedAt, frequency: indicator2.frequency, publishedAt: releasedAt, value: observation.value });
  }
  await repository.putData(pending);
  return { observationsWritten: pending.length, rejectedWithoutPublishedAt };
}
async function observationStart(repository, indicator2, now) {
  const latest = await repository.getLatestData(indicator2.id);
  return latest ? dateBeforePeriod(latest.periodDay, indicator2.frequency, indicator2.revisionLookbackPeriods) : dateYearsAgo(now, INITIAL_BACKFILL_YEARS);
}
async function observationStartYear(repository, indicator2, now) {
  return Number((await observationStart(repository, indicator2, now)).slice(0, 4));
}
function groupBySource(indicators) {
  const groups = /* @__PURE__ */ new Map();
  for (const indicator2 of indicators) {
    const key = `${indicator2.mapping.sourceId}:${indicator2.mapping.sourceBatchKey}`;
    const group = groups.get(key);
    if (group) group.push(indicator2);
    else groups.set(key, [indicator2]);
  }
  return groups;
}
function timestampFromSource(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const timestamp = Date.parse(`${value}T12:00:00.000Z`);
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1e3) : null;
}
function dateBeforePeriod(periodDay, frequency, count) {
  const date = new Date(Date.UTC(Math.floor(periodDay / 1e4), Math.floor(periodDay / 100) % 100 - 1, periodDay % 100));
  const months = frequency === "annual" ? count * 12 : frequency === "quarterly" ? count * 3 : frequency === "monthly" ? count : 0;
  if (months) date.setUTCMonth(date.getUTCMonth() - months);
  else date.setUTCDate(date.getUTCDate() - (frequency === "weekly" ? count * 7 : count));
  return date.toISOString().slice(0, 10);
}
function dateYearsAgo(now, years) {
  const date = new Date(now * 1e3);
  date.setUTCFullYear(date.getUTCFullYear() - years);
  return date.toISOString().slice(0, 10);
}
function isoDate(now) {
  return new Date(now * 1e3).toISOString().slice(0, 10);
}
function toSeconds(value) {
  return Math.floor(value >= 1e11 ? value / 1e3 : value);
}
function failureBackoffSeconds(consecutiveFailures) {
  return Math.min(60 * 60 * 2 ** Math.min(consecutiveFailures, 5), FAILURE_BACKOFF_MAX_SECONDS);
}
function errorMessage(error) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1e3);
}

// src/modules/macro/application/sync-macro-data.test.ts
function indicator(overrides) {
  return {
    id: 701,
    metricId: 81,
    categoryId: 9,
    regionCode: "KR",
    definitionId: 0,
    regionName: "Korea",
    regionSort: 3,
    categoryCode: "I",
    categoryName: "Test category",
    categorySort: 9,
    metricCode: "I01",
    metricName: "Test metric",
    metricDescription: "registered solely by the test directory row",
    metricSort: 81,
    statisticalDefinition: "headline",
    name: "Korea test metric",
    frequency: "monthly",
    unit: "%",
    unitFormat: "percent",
    measurementKind: "level",
    yoyMethod: "percent_change",
    yoyBasePeriods: 12,
    yoyDisplayFormat: "percent",
    momMethod: "percent_change",
    momBasePeriods: 1,
    momDisplayFormat: "percent",
    defaultTrendPeriods: 12,
    enabled: true,
    sourceId: "fred",
    sourceSeriesId: null,
    sourceUrl: "https://fred.stlouisfed.org/series/KRCPIALL",
    publisher: "Test publisher",
    publicationTimestampStrategy: "fred_realtime_start",
    sourceBatchKey: "korea-test",
    seasonalAdjustment: "not_seasonally_adjusted",
    leadLag: "lagging",
    transformMethod: "none",
    staleAfterSeconds: 100,
    refreshIntervalSeconds: 100,
    revisionLookbackPeriods: 1,
    nextFetchAt: 1,
    lastSuccessAt: null,
    fetchLeaseUntil: null,
    consecutiveFailures: 0,
    lastError: null,
    ...overrides
  };
}
function repositoryFor(due, writes) {
  const completions = [];
  const repository = {
    listDueIndicators: async () => [due],
    claimIndicator: async () => true,
    scheduleNextFetch: async (input) => {
      completions.push(input);
      return true;
    },
    putData: async (points) => {
      writes.push(points);
    },
    getLatestData: async () => null
  };
  return { repository, completions };
}
function blsFetch(calendarHtml, rows) {
  return (async (input, init) => {
    const url = String(input);
    if (url.includes("schedule/news_release")) {
      return new Response(calendarHtml, { status: 200, headers: { "Content-Type": "text/html" } });
    }
    assert.equal(url, "https://api.bls.gov/publicAPI/v2/timeseries/data/");
    assert.equal(init?.method, "POST");
    return new Response(JSON.stringify({
      status: "REQUEST_SUCCEEDED",
      Results: { series: [{ seriesID: "LNS14000000", data: rows }] }
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
}
test("sync records a directory mapping error instead of falling back or fabricating a value", async () => {
  const due = indicator({ sourceId: "dbnomics", sourceSeriesId: "KRCPIALL", publicationTimestampStrategy: "published_at" });
  const completions = [];
  const repository = {
    listDueIndicators: async () => [due],
    claimIndicator: async () => true,
    scheduleNextFetch: async (input) => {
      completions.push(input);
      return true;
    },
    putData: async () => {
    },
    getLatestData: async () => null
  };
  const stats = await syncMacroData({}, 178e7, { repository });
  assert.deepEqual(stats, {
    indicatorsDue: 1,
    indicatorsClaimed: 0,
    indicatorsRejectedSourceMapping: 1,
    sourceBatchesAttempted: 0,
    sourceBatchesSucceeded: 0,
    observationsWritten: 0,
    observationsRejectedWithoutPublishedAt: 0
  });
  assert.equal(completions.length, 1);
  assert.equal(completions[0].success, false);
  assert.match(completions[0].lastError ?? "", /unsupported scheduled source: dbnomics/);
});
test("sync ingests a third-region and ninth-category series using its directory mapping only", async () => {
  const due = indicator({ sourceSeriesId: "KRCPIALL" });
  const completions = [];
  const writes = [];
  const repository = {
    listDueIndicators: async () => [due],
    claimIndicator: async () => true,
    scheduleNextFetch: async (input) => {
      completions.push(input);
      return true;
    },
    putData: async (points) => {
      writes.push(points);
    },
    getLatestData: async () => null
  };
  const originalFetch = globalThis.fetch;
  let requested = "";
  globalThis.fetch = (async (input) => {
    requested = String(input);
    return new Response(JSON.stringify({
      observations: [{ date: "2026-06-01", value: "3.2", realtime_start: "2026-07-01", realtime_end: "2026-07-31" }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  try {
    const stats = await syncMacroData({ FRED_API_KEY: "test-key" }, 178e7, { repository });
    assert.equal(stats.indicatorsClaimed, 1);
    assert.equal(stats.observationsWritten, 1);
    assert.match(requested, /series_id=KRCPIALL/);
    assert.deepEqual(writes, [[{
      indicatorId: 701,
      period: "2026-06-01",
      frequency: "monthly",
      publishedAt: 1782907200,
      value: 3.2
    }]]);
    assert.equal(completions[0].success, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("sync persists all BLS observations from a bounded initial backfill when the official release calendar supplies a trusted known-at timestamp", async () => {
  const due = indicator({
    sourceId: "bls",
    sourceSeriesId: "LNS14000000",
    sourceUrl: "https://www.bls.gov/cps/",
    publicationTimestampStrategy: "bls_release_calendar",
    sourceBatchKey: "us-labor",
    revisionLookbackPeriods: 2
  });
  const writes = [];
  const { repository, completions } = repositoryFor(due, writes);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = blsFetch(
    "<table><tr><td>Employment Situation</td><td>May 8, 2026</td></tr></table>",
    [
      { year: "2026", period: "M05", value: "4.2", latest: "true" },
      { year: "2026", period: "M04", value: "4.1" },
      { year: "2026", period: "M03", value: "4.0" }
    ]
  );
  try {
    const stats = await syncMacroData({}, 178e7, { repository });
    assert.equal(stats.observationsWritten, 3);
    assert.equal(stats.observationsRejectedWithoutPublishedAt, 0);
    assert.deepEqual(writes, [[
      { indicatorId: 701, period: "2026-03", frequency: "monthly", publishedAt: 1778241600, value: 4 },
      { indicatorId: 701, period: "2026-04", frequency: "monthly", publishedAt: 1778241600, value: 4.1 },
      { indicatorId: 701, period: "2026-05", frequency: "monthly", publishedAt: 1778241600, value: 4.2 }
    ]]);
    assert.equal(completions[0].success, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("sync retains BLS diagnostics and writes nothing when no trusted official release timestamp is available", async () => {
  const due = indicator({
    sourceId: "bls",
    sourceSeriesId: "LNS14000000",
    sourceUrl: "https://www.bls.gov/cps/",
    publicationTimestampStrategy: "bls_release_calendar",
    sourceBatchKey: "us-labor"
  });
  const writes = [];
  const { repository, completions } = repositoryFor(due, writes);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = blsFetch(
    "<table><tr><td>Producer Price Index</td><td>May 14, 2026</td></tr></table>",
    [
      { year: "2026", period: "M05", value: "4.2", latest: "true" },
      { year: "2026", period: "M04", value: "4.1" }
    ]
  );
  try {
    const stats = await syncMacroData({}, 178e7, { repository });
    assert.equal(stats.observationsWritten, 0);
    assert.equal(stats.observationsRejectedWithoutPublishedAt, 2);
    assert.deepEqual(writes, [[]]);
    assert.equal(completions[0].success, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
