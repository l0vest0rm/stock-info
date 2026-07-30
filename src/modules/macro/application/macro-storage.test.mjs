import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const migration = new URL("../../../../migrations/0018_macro_research_storage.sql", import.meta.url);

test("macro storage preserves initial and revised vintages and supports as-of reads", () => {
  const directory = mkdtempSync(join(tmpdir(), "macro-storage-"));
  const database = join(directory, "macro.sqlite");
  try {
    execFileSync("sqlite3", [database], { input: readFileSync(migration), encoding: "utf8" });
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

test("watch configuration enforces a known macro series", () => {
  const directory = mkdtempSync(join(tmpdir(), "macro-storage-"));
  const database = join(directory, "macro.sqlite");
  try {
    execFileSync("sqlite3", [database], { input: readFileSync(migration), encoding: "utf8" });
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
