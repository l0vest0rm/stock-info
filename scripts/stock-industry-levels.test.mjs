import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import test from "node:test";

const profiles = JSON.parse(readFileSync(resolve("config/generated/eastmoney-company-em2016-profiles.json"), "utf8")).profiles;
const migration = readFileSync(resolve("migrations/0145_stock_em2016_industry_levels.sql"), "utf8");

test("EM2016 migration seeds all three industry levels without overwriting canonical names", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE stock (
      code TEXT PRIMARY KEY,
      short_name TEXT NOT NULL CHECK (trim(short_name) <> ''),
      updated_at INTEGER NOT NULL
    );
    INSERT INTO stock VALUES ('000001.SZ', '现有简称', 123), ('AAPL.US', 'Apple', 456);`);
    db.exec(migration);

    const columns = db.prepare("PRAGMA table_info(stock)").all().map((column) => column.name);
    for (const level of [1, 2, 3]) assert.ok(columns.includes(`industry_level_${level}`));

    const actual = new Map(db.prepare(`SELECT code, short_name, industry_level_1,
      industry_level_2, industry_level_3, updated_at FROM stock`).all().map((row) => [row.code, row]));
    assert.equal(actual.size, profiles.length + 1);
    for (const profile of profiles) {
      const row = actual.get(profile.code);
      assert.ok(row, `missing stock ${profile.code}`);
      assert.deepEqual([row.industry_level_1, row.industry_level_2, row.industry_level_3], profile.industryLevels);
      assert.equal(row.short_name, profile.code === "000001.SZ" ? "现有简称" : profile.name);
    }
    assert.equal(actual.get("000001.SZ").updated_at, 123);
    assert.deepEqual(
      [actual.get("AAPL.US").industry_level_1, actual.get("AAPL.US").industry_level_2, actual.get("AAPL.US").industry_level_3],
      [null, null, null],
    );
  } finally {
    db.close();
  }
});
