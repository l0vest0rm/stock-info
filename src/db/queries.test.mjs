import assert from "node:assert/strict";
import test from "node:test";

import { deleteKvCache, getKvCache, listKvCacheByNamespace, putKvCache } from "./queries.ts";

class FakeD1 {
  constructor() {
    this.kvCache = new Map();
  }

  prepare(sql) {
    const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
    return {
      bind: (...args) => ({
        first: async () => {
          if (normalized.includes("from kv_cache")) {
            const row = this.kvCache.get(`${args[0]}|${args[1]}`) ?? null;
            if (!row) return null;
            if (row.expiresAt != null && row.expiresAt <= args[2]) return null;
            return row;
          }
          throw new Error(`Unexpected D1 statement: ${sql}`);
        },
        all: async () => {
          if (normalized.includes("from kv_cache")) {
            const rows = [...this.kvCache.values()]
              .filter((row) => row.namespace === args[0])
              .filter((row) => row.expiresAt == null || row.expiresAt > args[1])
              .sort((left, right) => right.updatedAt - left.updatedAt || left.key.localeCompare(right.key));
            return { results: rows };
          }
          throw new Error(`Unexpected D1 statement: ${sql}`);
        },
        run: async () => {
          if (normalized.includes("insert into kv_cache")) {
            this.kvCache.set(`${args[0]}|${args[1]}`, {
              namespace: args[0],
              key: args[1],
              valueJson: args[2],
              expiresAt: args[3],
              updatedAt: args[4],
            });
            return { success: true };
          }
          if (normalized.includes("delete from kv_cache")) {
            this.kvCache.delete(`${args[0]}|${args[1]}`);
            return { success: true };
          }
          throw new Error(`Unexpected D1 statement: ${sql}`);
        },
      }),
    };
  }
}

test("kv_cache stores and reads one live record by namespace and key", async () => {
  const db = new FakeD1();
  await putKvCache(db, {
    namespace: "report_forecast",
    key: "600519.SH",
    valueJson: JSON.stringify({ ok: true }),
    expiresAt: 2_000,
    updatedAt: 1_000,
  });

  const row = await getKvCache(db, "report_forecast", "600519.SH", 1_500);
  assert.deepEqual(row, {
    namespace: "report_forecast",
    key: "600519.SH",
    valueJson: JSON.stringify({ ok: true }),
    expiresAt: 2_000,
    updatedAt: 1_000,
  });
});

test("kv_cache hides expired records", async () => {
  const db = new FakeD1();
  await putKvCache(db, {
    namespace: "report_forecast",
    key: "expired",
    valueJson: "{}",
    expiresAt: 1_000,
    updatedAt: 900,
  });

  assert.equal(await getKvCache(db, "report_forecast", "expired", 1_000), null);
  assert.deepEqual(await listKvCacheByNamespace(db, "report_forecast", 1_000), []);
});

test("kv_cache lists only one namespace and sorts by updated_at desc then key asc", async () => {
  const db = new FakeD1();
  await putKvCache(db, {
    namespace: "report_forecast",
    key: "b",
    valueJson: "{\"id\":2}",
    expiresAt: null,
    updatedAt: 2_000,
  });
  await putKvCache(db, {
    namespace: "report_forecast",
    key: "a",
    valueJson: "{\"id\":1}",
    expiresAt: null,
    updatedAt: 2_000,
  });
  await putKvCache(db, {
    namespace: "company_reports",
    key: "a",
    valueJson: "{\"id\":3}",
    expiresAt: null,
    updatedAt: 3_000,
  });

  const rows = await listKvCacheByNamespace(db, "report_forecast", 1_000);
  assert.deepEqual(rows.map((row) => row.key), ["a", "b"]);
});

test("kv_cache delete removes one namespace/key pair", async () => {
  const db = new FakeD1();
  await putKvCache(db, {
    namespace: "report_forecast",
    key: "600519.SH",
    valueJson: "{}",
    expiresAt: null,
    updatedAt: 1_000,
  });

  await deleteKvCache(db, "report_forecast", "600519.SH");
  assert.equal(await getKvCache(db, "report_forecast", "600519.SH", 1_001), null);
});
