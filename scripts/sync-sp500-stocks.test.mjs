import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const script = new URL("./sync-sp500-stocks.mjs", import.meta.url).pathname;

test("imports share classes and quoted names into stock and stock_alias idempotently", () => {
  const dir = mkdtempSync(join(tmpdir(), "sp500-test-"));
  try {
    const databasePath = join(dir, "stocks.sqlite");
    const input = join(dir, "constituents.csv");
    const db = new DatabaseSync(databasePath);
    db.exec(`create table stock (code text primary key, short_name text not null, updated_at integer not null);
      create table stock_alias (alias text not null, code text not null, source text, updated_at integer not null,
        primary key(alias, code), foreign key(code) references stock(code));
      insert into stock values ('AAPL.US', '已有简称', 1);`);
    const entries = Array.from({ length: 500 }, (_, index) => `T${index},Test ${index}`);
    entries[0] = 'AAPL,Apple Inc.';
    entries[1] = 'BRK.B,"Berkshire ""B"" Hathaway"';
    writeFileSync(input, `Symbol,Security\n${entries.join("\n")}\n`);
    const run = () => execFileSync(process.execPath, [script, "--input", input], {
      encoding: "utf8", env: { ...process.env, LOCAL_DB_PATH: databasePath },
    });
    run();
    run();
    assert.equal(db.prepare("select count(*) as n from stock").get().n, 500);
    assert.equal(db.prepare("select short_name from stock where code='AAPL.US'").get().short_name, "已有简称");
    assert.equal(db.prepare("select short_name from stock where code='BRK.B.US'").get().short_name, 'Berkshire "B" Hathaway');
    assert.deepEqual(db.prepare("select alias from stock_alias where code='BRK.B.US' order by alias").all().map((row) => row.alias),
      ['berkshire "b" hathaway']);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refuses partial lists before writing", () => {
  const dir = mkdtempSync(join(tmpdir(), "sp500-test-"));
  try {
    const input = join(dir, "partial.csv");
    writeFileSync(input, "Symbol,Security\nAAPL,Apple Inc.\n");
    assert.throws(() => execFileSync(process.execPath, [script, "--input", input, "--dry-run"], { stdio: "pipe" }),
      /Unexpected S&P 500 constituent count/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
