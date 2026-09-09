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

test("SQLite batch rolls back all writes and does not interleave independent commands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stock-info-batch-"));
  const db = new LocalD1Database(join(dir, "database.sqlite"));
  try {
    await db.exec("create table records (id integer primary key, value text not null)");
    await assert.rejects(db.batch([
      db.prepare("insert into records values (?, ?)").bind(1, "rollback"),
      db.prepare("insert into records values (?, ?)").bind(1, "duplicate"),
    ]), /UNIQUE/);
    assert.equal(await db.prepare("select count(*) as n from records").first("n"), 0);
    const [batch, independent] = await Promise.all([
      db.batch([db.prepare("insert into records values (1, 'batch')"), db.prepare("select count(*) as n from records")]),
      db.prepare("insert into records values (2, 'independent')").run(),
    ]);
    assert.equal(batch[1].results[0].n, 1);
    assert.equal(independent.meta.changes, 1);
    assert.deepEqual(await db.prepare("select id from records where id = -1").raw({ columnNames: true }), [["id"]]);
  } finally { await db.close(); await rm(dir, { recursive: true, force: true }); }
});

test("SQLite lock contention leaves the HTTP event loop responsive", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stock-info-lock-"));
  const file = join(dir, "database.sqlite");
  const owner = new LocalD1Database(file);
  const waiter = new LocalD1Database(file);
  try {
    await owner.exec("create table records (id integer primary key)");
    await waiter.prepare("select 1").first();
    await owner.exec("begin immediate");
    const started = performance.now();
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 10);
    const write = waiter.prepare("insert into records values (1)").run();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await owner.exec("commit");
    await write;
    clearInterval(timer);
    assert.ok(ticks >= 3, `event loop stalled during lock wait: ticks=${ticks}`);
    assert.ok(performance.now() - started < 3000, "lock owner could not release through event loop");
    assert.equal(await owner.prepare("select count(*) as n from records").first("n"), 1);
  } finally { await owner.close(); await waiter.close(); await rm(dir, { recursive: true, force: true }); }
});

test("Object adapter preserves content metadata and stable object identity across instances", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stock-info-object-contract-"));
  try {
    const first = await new LocalR2Bucket(dir).put("report.md", "# report", { httpMetadata: { contentType: "text/markdown" } });
    const second = await new LocalR2Bucket(dir).get("report.md");
    assert.equal(await second.text(), "# report");
    assert.equal(second.httpMetadata.contentType, "text/markdown");
    assert.equal(second.etag, first.etag);
    assert.equal(second.uploaded.getTime(), first.uploaded.getTime());
    assert.equal(second.size, 8);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
