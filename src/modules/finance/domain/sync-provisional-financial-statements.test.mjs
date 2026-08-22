import assert from "node:assert/strict";
import test from "node:test";

import { syncProvisionalFinancialStatements } from "../application/sync-provisional-financial-statements.ts";

const SCHEDULED_TIME = Date.UTC(2026, 7, 10);
const REPORT_DATE = "2026-06-30";

test("bootstrap consumes multiple pages, resumes by source/report-period, then incrementally scans both source configs", async () => {
  const db = new FakeD1();
  const bucket = new FakeBucket();
  const calls = [];
  let runNumber = 0;
  const fetchPage = async (source, _db, _reportDate, pageNumber) => {
    calls.push({ run: runNumber, source, pageNumber });
    if (runNumber <= 2) return bootstrapPage(source, pageNumber);
    return incrementalPage(source, pageNumber);
  };

  runNumber = 1;
  await syncProvisionalFinancialStatements({ DB: db, MARKET_DATA_BUCKET: bucket }, SCHEDULED_TIME, {
    fetchPage,
    maxBootstrapPagesPerRun: 2,
  });
  assert.deepEqual(pageCalls(calls, 1, "performance_report"), [1, 2]);
  assert.deepEqual(pageCalls(calls, 1, "performance_forecast"), [1, 2]);
  assertCheckpoint(db, "performance_report", { bootstrapNextPage: 3, bootstrapComplete: false });
  assertCheckpoint(db, "performance_forecast", { bootstrapNextPage: 3, bootstrapComplete: false });

  runNumber = 2;
  await syncProvisionalFinancialStatements({ DB: db, MARKET_DATA_BUCKET: bucket }, SCHEDULED_TIME, {
    fetchPage,
    maxBootstrapPagesPerRun: 2,
  });
  // A resumed bootstrap fetches page 1 for the current total-page metadata,
  // then continues at the durable cursor rather than stalling on one page.
  assert.deepEqual(pageCalls(calls, 2, "performance_report"), [1, 3, 4]);
  assert.deepEqual(pageCalls(calls, 2, "performance_forecast"), [1, 3]);
  assertCheckpoint(db, "performance_report", { bootstrapNextPage: 5, bootstrapComplete: true, watermarkDate: "2026-07-10" });
  assertCheckpoint(db, "performance_forecast", { bootstrapNextPage: 4, bootstrapComplete: true, watermarkDate: "2026-07-10" });

  runNumber = 3;
  const incrementalStats = await syncProvisionalFinancialStatements({ DB: db, MARKET_DATA_BUCKET: bucket }, SCHEDULED_TIME, {
    fetchPage,
  });
  assert.deepEqual(pageCalls(calls, 3, "performance_report"), [1, 2]);
  assert.deepEqual(pageCalls(calls, 3, "performance_forecast"), [1, 2]);
  for (const source of ["performance_report", "performance_forecast"]) {
    const sourceStats = incrementalStats.sourceStats[source];
    assert.equal(sourceStats.stopDate, "2026-07-08");
    assert.equal(sourceStats.incrementalRowsRead, 3, `${source} keeps the two-day overlap rows`);
    assert.equal(sourceStats.watermarkBefore, "2026-07-10");
    assert.equal(sourceStats.watermarkAfter, "2026-07-15");
    assert.equal(sourceStats.watermarkAdvanced, true);
  }
  assertCheckpoint(db, "performance_report", { watermarkDate: "2026-07-15" });
  assertCheckpoint(db, "performance_forecast", { watermarkDate: "2026-07-15" });
  assert.deepEqual(syncState(db), {
    status: "succeeded",
    error: null,
    stats: incrementalStats,
  });
});

test("incremental fetch failure leaves the per-source watermark unchanged", async () => {
  const db = new FakeD1();
  const bucket = new FakeBucket();
  let runNumber = 0;
  const fetchPage = async (source, _db, _reportDate, pageNumber) => {
    if (runNumber <= 2) return bootstrapPage(source, pageNumber);
    if (runNumber === 3) return incrementalPage(source, pageNumber);
    if (source === "performance_report" && pageNumber === 2) throw new Error("synthetic page failure");
    return failedCyclePage(source, pageNumber);
  };
  const env = { DB: db, MARKET_DATA_BUCKET: bucket };
  for (runNumber = 1; runNumber <= 2; runNumber += 1) {
    await syncProvisionalFinancialStatements(env, SCHEDULED_TIME, {
      fetchPage,
      maxBootstrapPagesPerRun: 10,
    });
  }
  runNumber = 3;
  await syncProvisionalFinancialStatements(env, SCHEDULED_TIME, { fetchPage });
  const before = checkpoint(db, "performance_report");
  runNumber = 4;
  await assert.rejects(
    syncProvisionalFinancialStatements(env, SCHEDULED_TIME, { fetchPage }),
    /synthetic page failure/
  );
  assert.deepEqual(checkpoint(db, "performance_report"), before);
});

function bootstrapPage(source, pageNumber) {
  const pages = source === "performance_report" ? 4 : 3;
  const rows = {
    performance_report: {
      1: [rawRow("300001.SZ", "2026-07-10", "performance")],
      2: [rawRow("300002.SZ", "2026-07-09", "performance")],
      3: [rawRow("300003.SZ", "2026-07-08", "performance")],
      4: [rawRow("300004.SZ", "2026-07-07", "performance")],
    },
    performance_forecast: {
      1: [rawRow("600001.SH", "2026-07-10", "forecast", "004")],
      2: [rawRow("600002.SH", "2026-07-09", "forecast", "004")],
      3: [rawRow("600003.SH", "2026-07-08", "forecast", "004")],
    },
  };
  return { rows: rows[source][pageNumber] ?? [], pages, count: pages };
}

function incrementalPage(source, pageNumber) {
  const rows = {
    performance_report: {
      1: [
        rawRow("300101.SZ", "2026-07-15", "performance"),
        rawRow("300102.SZ", "2026-07-10", "performance"),
        rawRow("300103.SZ", "2026-07-09", "performance"),
      ],
      2: [rawRow("300199.SZ", "2026-07-07", "performance")],
    },
    performance_forecast: {
      1: [
        rawRow("600101.SH", "2026-07-15", "forecast", "004"),
        rawRow("600102.SH", "2026-07-10", "forecast", "004"),
        rawRow("600103.SH", "2026-07-09", "forecast", "004"),
      ],
      2: [rawRow("600199.SH", "2026-07-07", "forecast", "004")],
    },
  };
  return { rows: rows[source][pageNumber] ?? [], pages: 2, count: 4 };
}

function failedCyclePage(source, pageNumber) {
  const code = source === "performance_report" ? "300201.SZ" : "600201.SH";
  const metric = source === "performance_forecast" ? "004" : undefined;
  return {
    rows: pageNumber === 1 ? [
      rawRow(code, "2026-07-16", source === "performance_report" ? "performance" : "forecast", metric),
      rawRow(source === "performance_report" ? "300202.SZ" : "600202.SH", "2026-07-15", source === "performance_report" ? "performance" : "forecast", metric),
    ] : [],
    pages: 2,
    count: 2,
  };
}

function rawRow(code, disclosureDate, kind, metric = undefined) {
  const row = {
    SECUCODE: code,
    SECURITY_CODE: code.slice(0, 6),
    REPORT_DATE: `${REPORT_DATE} 00:00:00`,
    NOTICE_DATE: `${disclosureDate} 00:00:00`,
    UPDATE_DATE: `${disclosureDate} 00:00:00`,
    FORECAST_PROFIT_JZ: 100,
    FORECAST_REVENUE_JZ: 200,
    TOTAL_OPERATE_INCOME: 200,
    PARENT_NETPROFIT: 100,
    IS_LATEST: "T",
  };
  if (kind === "forecast") row.PREDICT_FINANCE_CODE = metric;
  return row;
}

function pageCalls(calls, run, source) {
  return calls.filter((call) => call.run === run && call.source === source).map((call) => call.pageNumber);
}

function checkpoint(db, source) {
  const state = fullSyncState(db);
  return state.checkpoints[`${REPORT_DATE}:${source}`];
}

function assertCheckpoint(db, source, expected) {
  for (const [key, value] of Object.entries(expected)) assert.equal(checkpoint(db, source)[key], value, `${source}.${key}`);
}

function syncState(db) {
  const state = fullSyncState(db);
  return { status: state.status, error: state.error, stats: state.stats };
}

function fullSyncState(db) {
  const value = db.kvCache.get("sync_state|financial-provisional");
  assert.ok(value, "financial sync state exists");
  assert.equal([...db.kvCache.keys()].filter((key) => key.startsWith("sync_state|")).length, 1, "financial state and cursors share one kv key");
  return JSON.parse(value.valueJson);
}

class FakeD1 {
  constructor() {
    this.kvCache = new Map();
  }

  prepare(sql) {
    const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
    return {
      bind: (...args) => ({
        first: async () => {
          if (normalized.includes("from kv_cache")) return this.kvCache.get(`${args[0]}|${args[1]}`) ?? null;
          return null;
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
          }
          return { success: true };
        },
      }),
    };
  }
}

class FakeBucket {
  constructor() {
    this.objects = new Map();
  }

  async get(key) {
    if (!this.objects.has(key)) return null;
    const value = this.objects.get(key);
    return { json: async () => JSON.parse(value) };
  }

  async put(key, value) {
    this.objects.set(key, String(value));
  }
}
