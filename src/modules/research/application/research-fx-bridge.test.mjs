import assert from "node:assert/strict";
import test from "node:test";
import { loadResearchFxBridge } from "./research-fx-bridge.ts";

const db = {};
const cnyUsd = {
  seriesId: "DEXCHUS", observationDate: "2026-08-21", value: 7.2, unit: "CNY/USD",
  sourceUrl: "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DEXCHUS", observedAt: 1,
};
const hkdUsd = {
  seriesId: "HKMA_USD_HKD", observationDate: "2026-08-21", value: 7.8, unit: "HKD/USD",
  sourceUrl: "https://api.hkma.gov.hk/public/market-data-and-statistics/monthly-statistical-bulletin/er-ir/er-eeri-daily?lang=en&offset=0", observedAt: 2,
};

function sources({ cny = cnyUsd, hkd = hkdUsd } = {}) {
  return async (_db, source) => source === "DEXCHUS" ? cny : hkd;
}

test("research FX bridge retains FRED CNY/USD source for both conversion directions", async () => {
  const cnyToUsd = await loadResearchFxBridge(db, { fromCurrency: "CNY", toCurrency: "USD", asOf: 100 }, { loadSource: sources() });
  const usdToCny = await loadResearchFxBridge(db, { fromCurrency: "USD", toCurrency: "CNY", asOf: 100 }, { loadSource: sources() });

  assert.deepEqual(pick(cnyToUsd), { status: "ready", rate: 1 / 7.2, asOf: "2026-08-21", reason: null });
  assert.deepEqual(pick(usdToCny), { status: "ready", rate: 7.2, asOf: "2026-08-21", reason: null });
  assert.equal(cnyToUsd.sources[0].seriesId, "DEXCHUS");
  assert.match(cnyToUsd.sources[0].sourceUrl, /fred\.stlouisfed\.org/);
});

test("research FX bridge retains HKMA HKD/USD source for both conversion directions", async () => {
  const hkdToUsd = await loadResearchFxBridge(db, { fromCurrency: "HKD", toCurrency: "USD", asOf: 100 }, { loadSource: sources() });
  const usdToHkd = await loadResearchFxBridge(db, { fromCurrency: "USD", toCurrency: "HKD", asOf: 100 }, { loadSource: sources() });

  assert.deepEqual(pick(hkdToUsd), { status: "ready", rate: 1 / 7.8, asOf: "2026-08-21", reason: null });
  assert.deepEqual(pick(usdToHkd), { status: "ready", rate: 7.8, asOf: "2026-08-21", reason: null });
  assert.equal(hkdToUsd.sources[1].seriesId, "HKMA_USD_HKD");
  assert.match(hkdToUsd.sources[1].sourceUrl, /api\.hkma\.gov\.hk/);
});

test("research FX bridge blocks instead of estimating a missing required official rate", async () => {
  const result = await loadResearchFxBridge(db, { fromCurrency: "CNY", toCurrency: "HKD", asOf: 100 }, { loadSource: sources({ hkd: null }) });

  assert.deepEqual(pick(result), { status: "blocked", rate: null, asOf: "2026-08-21", reason: "source_series_missing:HKMA_USD_HKD" });
  assert.equal(result.sources.length, 1);
});

test("research FX bridge surfaces an unavailable required official source without falling back", async () => {
  const result = await loadResearchFxBridge(db, { fromCurrency: "CNY", toCurrency: "USD", asOf: 100 }, {
    loadSource: async (_db, source) => {
      if (source === "DEXCHUS") throw new Error("FRED unavailable");
      return hkdUsd;
    },
  });

  assert.deepEqual(pick(result), { status: "blocked", rate: null, asOf: "2026-08-21", reason: "official_fx_source_unavailable:DEXCHUS" });
  assert.equal(result.sources.length, 1);
});

function pick(result) {
  return { status: result.status, rate: result.rate, asOf: result.asOf, reason: result.reason };
}
