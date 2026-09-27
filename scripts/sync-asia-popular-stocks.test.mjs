import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const script = new URL("./sync-asia-popular-stocks.mjs", import.meta.url).pathname;

test("sync is idempotent and preserves curated existing names", () => {
  const dir = mkdtempSync(join(tmpdir(), "asia-stock-test-"));
  try {
    const databasePath = join(dir, "stocks.sqlite");
    const manifest = join(dir, "stocks.json");
    const db = new DatabaseSync(databasePath);
    db.exec(`create table stock (code text primary key, short_name text not null, updated_at integer not null);
      create table stock_alias (alias text not null, code text not null, source text, updated_at integer not null,
        primary key(alias, code), foreign key(code) references stock(code));
      insert into stock values ('005930.KS', '已有简称', 1);`);
    writeFileSync(manifest, JSON.stringify({ stocks: [
      { code: "005930.KS", name: "Samsung Electronics", aliases: ["三星"] },
      { code: "7203.T", name: "Toyota Motor", aliases: ["丰田汽车"] },
    ] }));
    const run = () => execFileSync(process.execPath, [script, "--manifest", manifest], {
      encoding: "utf8", env: { ...process.env, LOCAL_DB_PATH: databasePath },
    });
    run();
    run();
    assert.equal(db.prepare("select count(*) as n from stock").get().n, 2);
    assert.equal(db.prepare("select short_name from stock where code='005930.KS'").get().short_name, "已有简称");
    assert.deepEqual(db.prepare("select alias from stock_alias where code='7203.T' order by alias").all().map((row) => row.alias),
      ["toyota motor", "丰田汽车"]);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects duplicate or malformed codes before writing", () => {
  const dir = mkdtempSync(join(tmpdir(), "asia-stock-test-"));
  try {
    const manifest = join(dir, "stocks.json");
    writeFileSync(manifest, JSON.stringify({ stocks: [
      { code: "005930.KS", name: "Samsung Electronics", aliases: [] },
      { code: "005930.KS", name: "Duplicate", aliases: [] },
    ] }));
    assert.throws(() => execFileSync(process.execPath, [script, "--manifest", manifest, "--dry-run"], { stdio: "pipe" }),
      /Invalid or duplicate stock identity/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
