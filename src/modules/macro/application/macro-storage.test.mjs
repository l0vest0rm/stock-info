import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const migrations = [
  new URL("../../../../migrations/0018_macro_research_storage.sql", import.meta.url),
  new URL("../../../../migrations/0019_macro_alert_history.sql", import.meta.url),
  new URL("../../../../migrations/0020_compact_macro_series_history.sql", import.meta.url),
  new URL("../../../../migrations/0117_create_kv_cache.sql", import.meta.url),
  new URL("../../../../migrations/0130_create_macro_indicator_catalog.sql", import.meta.url),
  new URL("../../../../migrations/0131_drop_retired_macro_radar.sql", import.meta.url),
  new URL("../../../../migrations/0132_expand_macro_indicator_directory.sql", import.meta.url),
  new URL("../../../../migrations/0133_backfill_macro_directory_display_metadata.sql", import.meta.url),
];

test("final macro migration leaves only the catalog and four-value fact ledger", () => {
  const directory = mkdtempSync(join(tmpdir(), "macro-storage-"));
  const database = join(directory, "macro.sqlite");
  try {
    migrate(database, migrations.length - 3);
    execute(database, `
      pragma foreign_keys = on;
      insert into macro_series
        (series_id, name, category, region, frequency, unit, source_id, stale_after_seconds, updated_at)
      values ('SOFR', 'SOFR', 'rates', 'us', 'daily', '%', 'ny-fed', 1, 1);
      insert into macro_source_health
        (source_id, display_name, state, consecutive_failures, updated_at)
      values ('ny-fed', 'NY Fed', 'healthy', 0, 1);
      insert into macro_user_watch_configs
        (owner_key, series_id, created_at, updated_at)
      values ('local', 'SOFR', 1, 1);
      insert into macro_alert_history
        (owner_key, series_id, observation_date, observation_vintage_at, observed_at, value,
         rule_operator, rule_threshold, notification_state, evaluated_at)
      values ('local', 'SOFR', '2026-01-01', 1, 1, 4.25, 'gte', 4, 'not_configured', 1);
      insert into kv_cache (namespace, key, value_json, updated_at) values
        ('sync_state', 'macro-data', '{}', 1),
        ('sync_state', 'financial-provisional', '{}', 1);
      insert into macro_indicators
        (id, metric_id, category_id, region_code, definition_id, name, frequency, unit,
         source_id, refresh_interval_seconds, revision_lookback_periods, next_fetch_at)
      values (12, 1, 1, 'US', 0, '美国实际GDP增速', 'quarterly', '%', 'fred', 86400, 12, 1000);
      insert into macro_data (indicator_id, period_day, published_at, value) values
        (12, 20260101, 1000, 2.0),
        (12, 20260101, 2000, 2.5);
    `);
    migrate(database, migrations.length);

    assert.equal(queryScalar(database, `select group_concat(name, ',') from (
      select name from sqlite_master where type = 'table' and name glob 'macro_*' order by name
    )`), "macro_data,macro_indicators");
    assert.equal(queryScalar(database, `select group_concat(name, ',') from pragma_table_info('macro_data') order by cid`),
      "indicator_id,period_day,published_at,value");
    assert.equal(queryScalar(database, "select sql like '%WITHOUT ROWID%' from sqlite_master where type = 'table' and name = 'macro_data'"), "1");
    assert.equal(queryScalar(database, "select count(*) from macro_data where indicator_id = 12"), "2");
    assert.equal(queryScalar(database, "select region_name from macro_indicators where id = 12"), "美国");
    assert.equal(queryScalar(database, "select category_name from macro_indicators where id = 12"), "经济增长与景气");
    assert.equal(queryScalar(database, "select metric_name from macro_indicators where id = 12"), "实际GDP增速");
    assert.equal(queryScalar(database, "select count(*) from kv_cache where namespace = 'sync_state' and key = 'macro-data'"), "0");
    assert.equal(queryScalar(database, "select count(*) from kv_cache where namespace = 'sync_state' and key = 'financial-provisional'"), "1");
    assert.equal(queryScalar(database, "pragma foreign_key_check"), "");

    // Neither the physical catalog nor the ledger may impose the original
    // CN/US, eight-category, or sixty-metric bootstrap boundary.
    execute(database, `
      insert into macro_indicators (
        id, metric_id, category_id, region_code, definition_id,
        region_name, region_sort, category_code, category_name, category_sort,
        metric_code, metric_name, metric_description, metric_sort, statistical_definition,
        name, frequency, unit, unit_format, measurement_kind,
        yoy_method, yoy_base_periods, yoy_display_format,
        mom_method, mom_base_periods, mom_display_format, default_trend_periods
      ) values (
        77, 61, 9, 'KR', 0,
        '韩国', 30, 'I', '第九分类', 9,
        'I01', '韩国消费者物价', '第三地区的第九分类测试指标', 61, '全国、季调后',
        '韩国消费者物价', 'monthly', 'index', 'decimal_2', 'index',
        'percent_change', 12, 'percent',
        'percent_change', 1, 'percent', 24
      );
      insert into macro_data (indicator_id, period_day, published_at, value) values
        (77, 20250101, 100, 100.0),
        (77, 20260101, 200, 110.0),
        (77, 20260101, 300, 111.0);
    `);
    assert.equal(queryScalar(database, "select region_name || ':' || category_name || ':' || metric_name from macro_indicators where id = 77"),
      "韩国:第九分类:韩国消费者物价");
    assert.equal(queryScalar(database, "select value from macro_data where indicator_id = 77 and period_day = 20260101 and published_at = 300"), "111.0");

    // Select revisions only after applying asOf: the later revision must not
    // leak into the 250 replay.
    assert.equal(queryScalar(database, `
      select value from (
        select period_day, value, row_number() over (partition by period_day order by published_at desc) as version_rank
        from macro_data where indicator_id = 77 and published_at <= 250
      ) where version_rank = 1 and value = 110.0
    `), "110.0");
    assert.equal(queryScalar(database, `
      select value from (
        select period_day, value, row_number() over (partition by period_day order by published_at desc) as version_rank
        from macro_data where indicator_id = 77 and published_at <= 300
      ) where version_rank = 1 and period_day = 20260101
    `), "111.0");
    assert.match(queryScalar(database, `
      explain query plan select value from macro_data
       where indicator_id = 77 and period_day between 20250101 and 20260101 and published_at <= 300
    `), /SEARCH macro_data USING PRIMARY KEY \(indicator_id=\? AND period_day>\? AND period_day<\?\)/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function migrate(database, count) {
  for (const migration of migrations.slice(0, count)) {
    execFileSync("sqlite3", [database], { input: readFileSync(migration), encoding: "utf8" });
  }
}

function execute(database, sql) {
  execFileSync("sqlite3", ["-batch", database], { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

function queryScalar(database, sql) {
  return execFileSync("sqlite3", ["-batch", database, sql], { encoding: "utf8" }).trim();
}
