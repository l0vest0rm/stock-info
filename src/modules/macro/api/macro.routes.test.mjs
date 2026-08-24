import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalD1Database } from "../../../platform/node/local-bindings.ts";
import { D1MacroRepository } from "../application/macro-repository.ts";
import { macroRoutes } from "./macro.routes.ts";

test("macro API is catalog driven and applies asOf before derived measurements", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stock-info-macro-api-"));
  try {
    const db = new LocalD1Database(join(directory, "macro.sqlite"));
    await createMacroTables(db);
    const repository = new D1MacroRepository(db);
    await repository.upsertIndicator(indicator({
      id: 101, regionCode: "SG", regionName: "新加坡", regionSort: 3,
      categoryId: 9, categoryCode: "I", categoryName: "数字经济", categorySort: 9,
      metricId: 71, metricCode: "I01", metricName: "生产指数", metricSort: 1,
      frequency: "monthly", yoyMethod: "percent_change", yoyBasePeriods: 12,
      momMethod: "percent_change", momBasePeriods: 1, defaultTrendPeriods: 3,
    }));
    await repository.upsertIndicator(indicator({
      id: 102, metricId: 72, metricCode: "I02", metricName: "政策利率", metricSort: 2,
      frequency: "daily", measurementKind: "rate", yoyMethod: "percentage_point_change", yoyBasePeriods: 365,
      momMethod: "percentage_point_change", momBasePeriods: 1,
    }));
    await repository.upsertIndicator(indicator({
      id: 103, metricId: 73, metricCode: "I03", metricName: "原生同比", metricSort: 3,
      measurementKind: "native_yoy", yoyMethod: "native", yoyBasePeriods: 0, momMethod: "not_applicable", momBasePeriods: 0,
    }));
    await repository.upsertIndicator(indicator({ id: 104, metricId: 74, metricCode: "I04", metricName: "未映射", metricSort: 4, sourceId: null, sourceSeriesId: null, sourceUrl: null, publisher: null }));
    await repository.upsertIndicator(indicator({ id: 105, metricId: 75, metricCode: "I05", metricName: "首发未到", metricSort: 5 }));
    await repository.upsertIndicator(indicator({ id: 106, metricId: 76, metricCode: "I06", metricName: "缺少基期", metricSort: 6 }));
    await repository.putData([
      point(101, "2025-01", 100, 1_000, "monthly"), point(101, "2025-12", 110, 1_000, "monthly"),
      point(101, "2026-01", 120, 2_000, "monthly"), point(101, "2026-01", 125, 3_000, "monthly"),
      point(102, "2025-01-01", 2, 1_000, "daily"), point(102, "2026-01-01", 3, 2_000, "daily"),
      point(103, "2026-01", 4.2, 2_000, "monthly"), point(106, "2026-01", 8, 2_000, "monthly"),
    ]);

    const catalog = await request(db, "/macro/catalog");
    assert.deepEqual(catalog.data.regions, [{ code: "SG", name: "新加坡", sort: 3 }]);
    assert.deepEqual(catalog.data.categories, [{ id: 9, code: "I", name: "数字经济", sort: 9 }]);
    assert.equal(catalog.data.metrics.length, 6, "new metrics come exclusively from the stored catalog");

    const overviewAtInitial = await request(db, "/macro/overview?regions=SG&categories=I&asOf=2500");
    const monthly = byId(overviewAtInitial.data.series, 101);
    assert.deepEqual(monthly.current, { value: 120, period: "2026-01-01", publishedAt: "1970-01-01T00:33:20.000Z" });
    assertMetric(monthly.yoy, 20, "2025-01-01", "percent_change");
    assertMetric(monthly.mom, 9.09090909090909, "2025-12-01", "percent_change");
    assert.equal(monthly.trend.status, "available");
    assert.equal(monthly.trend.points.length, 2, "trend uses the finite configured window");
    assert.equal(byId(overviewAtInitial.data.series, 102).yoy.value, 1, "rates use percentage-point changes");
    assert.equal(byId(overviewAtInitial.data.series, 103).yoy.value, 4.2, "native YoY is never transformed again");
    assert.equal(byId(overviewAtInitial.data.series, 103).mom.reason, "not_applicable");
    assert.equal(byId(overviewAtInitial.data.series, 104).availability.status, "unmapped");
    assert.equal(byId(overviewAtInitial.data.series, 105).availability.status, "awaiting_first_release");
    assert.equal(byId(overviewAtInitial.data.series, 106).yoy.reason, "base_period_missing");

    const overviewAfterRevision = await request(db, "/macro/overview?regions=SG&asOf=4000");
    assert.equal(byId(overviewAfterRevision.data.series, 101).current.value, 125, "later revision becomes visible only after its publication");
    assert.equal(byId(overviewAfterRevision.data.series, 101).yoy.value, 25);

    const series = await request(db, "/macro/series?ids=101&measure=yoy&from=2026-01-01&to=2026-01-01&asOf=2500");
    assertMetric(series.data.series[0].points[0], 20, "2025-01-01", "percent_change");
    assert.equal(series.data.series[0].points[0].publishedAt, "1970-01-01T00:33:20.000Z");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("macro overview batches latest snapshots for a dynamic catalog larger than 200 series", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stock-info-macro-overview-batches-"));
  try {
    const db = new LocalD1Database(join(directory, "macro.sqlite"));
    await createMacroTables(db);
    const repository = new D1MacroRepository(db);
    const seriesCount = 201;
    const indicators = Array.from({ length: seriesCount }, (_, index) => {
      const regionIndex = index % 3;
      const categoryIndex = index % 4;
      return indicator({
        id: 1_000 + index,
        metricId: 10_000 + index,
        metricCode: `M${index + 1}`,
        metricName: `动态指标 ${index + 1}`,
        metricSort: index + 1,
        regionCode: `R${regionIndex + 1}`,
        regionName: `地区 ${regionIndex + 1}`,
        regionSort: regionIndex + 1,
        categoryId: 100 + categoryIndex,
        categoryCode: `C${categoryIndex + 1}`,
        categoryName: `类别 ${categoryIndex + 1}`,
        categorySort: categoryIndex + 1,
        sourceSeriesId: `fixture-${index + 1}`,
      });
    });
    for (const item of indicators) await repository.upsertIndicator(item);
    await repository.putData(indicators.map((item, index) => point(item.id, "2026-01", index + 0.5, 1_000, "monthly")));

    const overview = await request(db, "/macro/overview?asOf=1000");
    assert.equal(overview.data.series.length, seriesCount, "the unfiltered dynamic catalog is not capped by a repository snapshot batch");
    assert.deepEqual(overview.data.regions, [], "response filter echoes the unfiltered request");
    assert.deepEqual(overview.data.categories, []);
    assert.equal(byId(overview.data.series, 1_000).current.value, 0.5);
    assert.equal(byId(overview.data.series, 1_200).current.value, 200.5, "series in the second snapshot batch retains its own latest value");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function request(db, path) {
  const response = await macroRoutes.request(`http://macro.test${path}`, undefined, { DB: db, APP_RUNTIME: "node" });
  assert.equal(response.status, 200);
  return response.json();
}

function byId(series, id) { return series.find((entry) => entry.definition.id === id); }
function assertMetric(value, expectedValue, basePeriod, method) {
  assert.ok(Math.abs(value.value - expectedValue) < 1e-10);
  assert.deepEqual({ basePeriod: value.basePeriod, method: value.method, status: value.status, reason: value.reason }, {
    basePeriod, method, status: "available", reason: null,
  });
}
function point(indicatorId, period, value, publishedAt, frequency) { return { indicatorId, period, value, publishedAt, frequency }; }

function indicator(overrides = {}) {
  return {
    id: 1, metricId: 1, categoryId: 9, regionCode: "SG", definitionId: 0,
    regionName: "新加坡", regionSort: 3, categoryCode: "I", categoryName: "数字经济", categorySort: 9,
    metricCode: "I01", metricName: "指标", metricDescription: "测试指标", metricSort: 1, statisticalDefinition: "总量",
    name: "新加坡测试指标", frequency: "monthly", unit: "%", unitFormat: "percent", measurementKind: "level",
    yoyMethod: "percent_change", yoyBasePeriods: 12, yoyDisplayFormat: "percent",
    momMethod: "percent_change", momBasePeriods: 1, momDisplayFormat: "percent", defaultTrendPeriods: 3,
    enabled: true, sourceId: "fixture", sourceSeriesId: "fixture-1", sourceUrl: "https://example.test/fixture", publisher: "fixture",
    publicationTimestampStrategy: "fixture", sourceBatchKey: "fixture", seasonalAdjustment: "not_applicable", leadLag: null,
    transformMethod: null, staleAfterSeconds: 9_999_999, refreshIntervalSeconds: 0, revisionLookbackPeriods: 0,
    nextFetchAt: null, lastSuccessAt: null, fetchLeaseUntil: null, consecutiveFailures: 0, lastError: null,
    ...overrides,
  };
}

async function createMacroTables(db) {
  await db.exec(`
    create table macro_indicators (
      id integer primary key, metric_id integer, category_id integer, region_code text, definition_id integer,
      region_name text, region_sort integer, category_code text, category_name text, category_sort integer,
      metric_code text, metric_name text, metric_description text, metric_sort integer, statistical_definition text,
      name text, frequency text, unit text, unit_format text, measurement_kind text,
      yoy_method text, yoy_base_periods integer, yoy_display_format text, mom_method text, mom_base_periods integer,
      mom_display_format text, default_trend_periods integer, enabled integer, source_id text, source_series_id text,
      source_url text, publisher text, publication_timestamp_strategy text, source_batch_key text, seasonal_adjustment text,
      lead_lag text, transform_method text, stale_after_seconds integer, refresh_interval_seconds integer,
      revision_lookback_periods integer, next_fetch_at integer, last_success_at integer, fetch_lease_until integer,
      consecutive_failures integer, last_error text
    );
    create table macro_data (
      indicator_id integer, period_day integer, published_at integer, value real,
      primary key (indicator_id, period_day, published_at)
    ) without rowid;
  `);
}
