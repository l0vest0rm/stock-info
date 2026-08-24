import assert from "node:assert/strict";
import test from "node:test";
import type { MacroIndicator } from "../domain/model";
import {
  syncMacroData,
  type MacroSyncRepository,
} from "./sync-macro-data";

function indicator(overrides: Partial<MacroIndicator>): MacroIndicator {
  return {
    id: 701,
    metricId: 81,
    categoryId: 9,
    regionCode: "KR",
    definitionId: 0,
    regionName: "Korea",
    regionSort: 3,
    categoryCode: "I",
    categoryName: "Test category",
    categorySort: 9,
    metricCode: "I01",
    metricName: "Test metric",
    metricDescription: "registered solely by the test directory row",
    metricSort: 81,
    statisticalDefinition: "headline",
    name: "Korea test metric",
    frequency: "monthly",
    unit: "%",
    unitFormat: "percent",
    measurementKind: "level",
    yoyMethod: "percent_change",
    yoyBasePeriods: 12,
    yoyDisplayFormat: "percent",
    momMethod: "percent_change",
    momBasePeriods: 1,
    momDisplayFormat: "percent",
    defaultTrendPeriods: 12,
    enabled: true,
    sourceId: "fred",
    sourceSeriesId: null,
    sourceUrl: "https://fred.stlouisfed.org/series/KRCPIALL",
    publisher: "Test publisher",
    publicationTimestampStrategy: "fred_realtime_start",
    sourceBatchKey: "korea-test",
    seasonalAdjustment: "not_seasonally_adjusted",
    leadLag: "lagging",
    transformMethod: "none",
    staleAfterSeconds: 100,
    refreshIntervalSeconds: 100,
    revisionLookbackPeriods: 1,
    nextFetchAt: 1,
    lastSuccessAt: null,
    fetchLeaseUntil: null,
    consecutiveFailures: 0,
    lastError: null,
    ...overrides,
  };
}

function repositoryFor(due: MacroIndicator, writes: Array<Parameters<MacroSyncRepository["putData"]>[0]>) {
  const completions: Array<Parameters<MacroSyncRepository["scheduleNextFetch"]>[0]> = [];
  const repository: MacroSyncRepository = {
    listDueIndicators: async () => [due],
    claimIndicator: async () => true,
    scheduleNextFetch: async (input) => { completions.push(input); return true; },
    putData: async (points) => { writes.push(points); },
    getLatestData: async () => null,
  };
  return { repository, completions };
}

function blsFetch(calendarHtml: string, rows: readonly Record<string, unknown>[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("schedule/news_release")) {
      return new Response(calendarHtml, { status: 200, headers: { "Content-Type": "text/html" } });
    }
    assert.equal(url, "https://api.bls.gov/publicAPI/v2/timeseries/data/");
    assert.equal(init?.method, "POST");
    return new Response(JSON.stringify({
      status: "REQUEST_SUCCEEDED",
      Results: { series: [{ seriesID: "LNS14000000", data: rows }] },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

test("sync records a directory mapping error instead of falling back or fabricating a value", async () => {
  const due = indicator({ sourceId: "dbnomics", sourceSeriesId: "KRCPIALL", publicationTimestampStrategy: "published_at" });
  const completions: Array<Parameters<MacroSyncRepository["scheduleNextFetch"]>[0]> = [];
  const repository: MacroSyncRepository = {
    listDueIndicators: async () => [due],
    claimIndicator: async () => true,
    scheduleNextFetch: async (input) => { completions.push(input); return true; },
    putData: async () => {},
    getLatestData: async () => null,
  };

  const stats = await syncMacroData({} as never, 1_780_000_000, { repository });

  assert.deepEqual(stats, {
    indicatorsDue: 1,
    indicatorsClaimed: 0,
    indicatorsRejectedSourceMapping: 1,
    sourceBatchesAttempted: 0,
    sourceBatchesSucceeded: 0,
    observationsWritten: 0,
    observationsRejectedWithoutPublishedAt: 0,
  });
  assert.equal(completions.length, 1);
  assert.equal(completions[0].success, false);
  assert.match(completions[0].lastError ?? "", /unsupported scheduled source: dbnomics/);
});

test("sync ingests a third-region and ninth-category series using its directory mapping only", async () => {
  const due = indicator({ sourceSeriesId: "KRCPIALL" });
  const completions: Array<Parameters<MacroSyncRepository["scheduleNextFetch"]>[0]> = [];
  const writes: Array<Parameters<MacroSyncRepository["putData"]>[0]> = [];
  const repository: MacroSyncRepository = {
    listDueIndicators: async () => [due],
    claimIndicator: async () => true,
    scheduleNextFetch: async (input) => { completions.push(input); return true; },
    putData: async (points) => { writes.push(points); },
    getLatestData: async () => null,
  };
  const originalFetch = globalThis.fetch;
  let requested = "";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requested = String(input);
    return new Response(JSON.stringify({
      observations: [{ date: "2026-06-01", value: "3.2", realtime_start: "2026-07-01", realtime_end: "2026-07-31" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    const stats = await syncMacroData({ FRED_API_KEY: "test-key" } as never, 1_780_000_000, { repository });
    assert.equal(stats.indicatorsClaimed, 1);
    assert.equal(stats.observationsWritten, 1);
    assert.match(requested, /series_id=KRCPIALL/);
    assert.deepEqual(writes, [[{
      indicatorId: 701,
      period: "2026-06-01",
      frequency: "monthly",
      publishedAt: 1782907200,
      value: 3.2,
    }]]);
    assert.equal(completions[0].success, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sync persists all BLS observations from a bounded initial backfill when the official release calendar supplies a trusted known-at timestamp", async () => {
  const due = indicator({
    sourceId: "bls",
    sourceSeriesId: "LNS14000000",
    sourceUrl: "https://www.bls.gov/cps/",
    publicationTimestampStrategy: "bls_release_calendar",
    sourceBatchKey: "us-labor",
    revisionLookbackPeriods: 2,
  });
  const writes: Array<Parameters<MacroSyncRepository["putData"]>[0]> = [];
  const { repository, completions } = repositoryFor(due, writes);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = blsFetch(
    "<table><tr><td>Employment Situation</td><td>May 8, 2026</td></tr></table>",
    [
      { year: "2026", period: "M05", value: "4.2", latest: "true" },
      { year: "2026", period: "M04", value: "4.1" },
      { year: "2026", period: "M03", value: "4.0" },
    ],
  );
  try {
    const stats = await syncMacroData({} as never, 1_780_000_000, { repository });

    assert.equal(stats.observationsWritten, 3);
    assert.equal(stats.observationsRejectedWithoutPublishedAt, 0);
    assert.deepEqual(writes, [[
      { indicatorId: 701, period: "2026-03", frequency: "monthly", publishedAt: 1778241600, value: 4.0 },
      { indicatorId: 701, period: "2026-04", frequency: "monthly", publishedAt: 1778241600, value: 4.1 },
      { indicatorId: 701, period: "2026-05", frequency: "monthly", publishedAt: 1778241600, value: 4.2 },
    ]]);
    assert.equal(completions[0].success, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sync retains BLS diagnostics and writes nothing when no trusted official release timestamp is available", async () => {
  const due = indicator({
    sourceId: "bls",
    sourceSeriesId: "LNS14000000",
    sourceUrl: "https://www.bls.gov/cps/",
    publicationTimestampStrategy: "bls_release_calendar",
    sourceBatchKey: "us-labor",
  });
  const writes: Array<Parameters<MacroSyncRepository["putData"]>[0]> = [];
  const { repository, completions } = repositoryFor(due, writes);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = blsFetch(
    "<table><tr><td>Producer Price Index</td><td>May 14, 2026</td></tr></table>",
    [
      { year: "2026", period: "M05", value: "4.2", latest: "true" },
      { year: "2026", period: "M04", value: "4.1" },
    ],
  );
  try {
    const stats = await syncMacroData({} as never, 1_780_000_000, { repository });

    assert.equal(stats.observationsWritten, 0);
    assert.equal(stats.observationsRejectedWithoutPublishedAt, 2);
    assert.deepEqual(writes, [[]]);
    assert.equal(completions[0].success, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
