import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { LocalD1Database, LocalR2Bucket } = await import("../data/local/runtime/bindings.mjs");

test("Node D1 adapter preserves prepared bindings, batch writes, and result metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stock-info-node-bindings-"));
  try {
    const db = new LocalD1Database(join(dir, "database.sqlite"));
    assert.equal((await db.prepare("pragma journal_mode").first("journal_mode")), "wal");
    assert.equal((await db.prepare("pragma busy_timeout").first("timeout")), 30000);
    await db.exec("create table records (id integer primary key, value text not null)");
    const results = await db.batch([
      db.prepare("insert into records (value) values (?)").bind("first"),
      db.prepare("insert into records (value) values (?)").bind("second"),
    ]);
    assert.equal(results[0].success, true);
    assert.equal(results[1].meta.changes, 1);
    assert.deepEqual((await db.prepare("select id, value from records order by id").all()).results, [
      { id: 1, value: "first" }, { id: 2, value: "second" },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Node R2 adapter stores and retrieves objects below its configured root", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stock-info-node-r2-"));
  try {
    const bucket = new LocalR2Bucket(dir);
    await bucket.put("nested/value.json", JSON.stringify({ source: "local" }));
    assert.deepEqual(await (await bucket.get("nested/value.json")).json(), { source: "local" });
    assert.equal(await bucket.get("missing.json"), null);
    await assert.rejects(() => bucket.put("../outside.json", "unsafe"), /invalid local object key/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
