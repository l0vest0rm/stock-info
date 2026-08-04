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
];

test("macro storage preserves initial and revised vintages and supports as-of reads", () => {
  const directory = mkdtempSync(join(tmpdir(), "macro-storage-"));
  const database = join(directory, "macro.sqlite");
  try {
    migrate(database, 1);
    execute(database, `
      pragma foreign_keys = on;
      insert into macro_series
        (series_id, name, category, region, frequency, unit, source_id,
         stale_after_seconds, updated_at)
      values ('GDP', 'GDP', 'growth', 'us', 'quarterly', 'index', 'official', 7776000, 1000);
      insert into macro_observation_vintages
        (series_id, observation_date, released_at, vintage_at, revision_number,
         value, is_preliminary, observed_at)
      values
        ('GDP', '2026-03-31', 1000, 1000, 0, 100.0, 1, 1001),
        ('GDP', '2026-03-31', 2000, 2000, 1, 101.5, 0, 2001);
    `);
    assert.equal(queryScalar(database, "select count(*) from macro_observation_vintages"), "2");
    assert.equal(queryScalar(database, latestVintageSql(1500)), "100.0");
    assert.equal(queryScalar(database, latestVintageSql(2500)), "101.5");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("compaction retains vintages in one D1 history row per series", () => {
  const directory = mkdtempSync(join(tmpdir(), "macro-storage-"));
  const database = join(directory, "macro.sqlite");
  try {
    execFileSync("sqlite3", [database], { input: readFileSync(migrations[0]), encoding: "utf8" });
    execute(database, `insert into macro_series (series_id, name, category, region, frequency, unit, source_id, stale_after_seconds, updated_at) values ('GDP', 'GDP', 'growth', 'us', 'quarterly', 'index', 'official', 1, 1);
      insert into macro_observation_vintages (series_id, observation_date, released_at, vintage_at, revision_number, value, source_url, observed_at) values ('GDP', '2026-03-31', 1, 1, 0, 100, 'https://official.example/gdp', 1), ('GDP', '2026-03-31', 2, 2, 1, 101, 'https://official.example/gdp', 2);`);
    execFileSync("sqlite3", [database], { input: readFileSync(migrations[2]), encoding: "utf8" });
    assert.equal(queryScalar(database, "select count(*) from sqlite_master where type = 'table' and name = 'macro_observation_vintages'"), "0");
    assert.equal(queryScalar(database, "select count(*) from macro_series_history where series_id = 'GDP'"), "1");
    assert.equal(queryScalar(database, "select json_array_length(vintages_json, '$.o') from macro_series_history where series_id = 'GDP'"), "2");
    assert.equal(queryScalar(database, "select json_extract(vintages_json, '$.v') from macro_series_history where series_id = 'GDP'"), "1");
    assert.equal(queryScalar(database, "select json_array_length(vintages_json, '$.u') from macro_series_history where series_id = 'GDP'"), "1");
    assert.equal(queryScalar(database, "select json_extract(vintages_json, '$.o[1][9]') from macro_series_history where series_id = 'GDP'"), "0");
    assert.equal(queryScalar(database, "select json_type(vintages_json, '$.o[0]') from macro_series_history where series_id = 'GDP'"), "array");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("watch configuration enforces a known macro series", () => {
  const directory = mkdtempSync(join(tmpdir(), "macro-storage-"));
  const database = join(directory, "macro.sqlite");
  try {
    migrate(database);
    assert.throws(() => execute(database, `
      pragma foreign_keys = on;
      insert into macro_user_watch_configs
        (owner_key, series_id, created_at, updated_at)
      values ('local', 'UNKNOWN', 1, 1);
    `), /FOREIGN KEY constraint failed/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("alert history deduplicates repeated evaluations but preserves a new data vintage", () => {
  const directory = mkdtempSync(join(tmpdir(), "macro-storage-"));
  const database = join(directory, "macro.sqlite");
  try {
    migrate(database);
    execute(database, `
      pragma foreign_keys = on;
      insert into macro_series
        (series_id, name, category, region, frequency, unit, source_id, stale_after_seconds, updated_at)
      values ('SOFR', 'SOFR', 'rates', 'us', 'daily', '%', 'ny-fed', 259200, 1);
      insert into macro_alert_history
        (owner_key, series_id, observation_date, observation_vintage_at, observed_at, value,
         rule_operator, rule_threshold, notification_state, evaluated_at)
      values ('local', 'SOFR', '2026-07-30', 1000, 1000, 4.25, 'gte', 4, 'not_configured', 2000);
      insert or ignore into macro_alert_history
        (owner_key, series_id, observation_date, observation_vintage_at, observed_at, value,
         rule_operator, rule_threshold, notification_state, evaluated_at)
      values ('local', 'SOFR', '2026-07-30', 1000, 1000, 4.25, 'gte', 4, 'not_configured', 3000);
      insert into macro_alert_history
        (owner_key, series_id, observation_date, observation_vintage_at, observed_at, value,
         rule_operator, rule_threshold, notification_state, evaluated_at)
      values ('local', 'SOFR', '2026-07-30', 4000, 4000, 4.5, 'gte', 4, 'not_configured', 4000);
    `);
    assert.equal(queryScalar(database, "select count(*) from macro_alert_history"), "2");
    assert.equal(queryScalar(database, "select max(observation_vintage_at) from macro_alert_history"), "4000");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function migrate(database, count = migrations.length) {
  for (const migration of migrations.slice(0, count)) {
    execFileSync("sqlite3", [database], { input: readFileSync(migration), encoding: "utf8" });
  }
}

function latestVintageSql(asOf) {
  return `select value from macro_observation_vintages
    where series_id = 'GDP' and vintage_at <= ${asOf}
    order by vintage_at desc limit 1`;
}

function execute(database, sql) {
  execFileSync("sqlite3", ["-batch", database], { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

function queryScalar(database, sql) {
  return execFileSync("sqlite3", ["-batch", database, sql], { encoding: "utf8" }).trim();
}
