import assert from "node:assert/strict";
import test from "node:test";

import {
  calendarPercentChange,
  rollingPercentile,
  rollingZScore,
  transformSeries,
} from "./transforms.ts";
import {
  backtestSignal,
  initialReleasePoints,
  calculateMarketFactorContributions,
  replayScenario,
  rollingCorrelation,
} from "./research.ts";

test("level normalization sorts dates, removes invalid values and keeps the latest duplicate", () => {
  assert.deepEqual(transformSeries([
    { date: "2026-02-01", value: 2 },
    { date: "not-a-date", value: 9 },
    { date: "2026-01-01", value: 1 },
    { date: "2026-02-01", value: 3 },
  ], "level"), [
    { date: "2026-01-01", value: 1 },
    { date: "2026-02-01", value: 3 },
  ]);
});

test("mom and yoy use the latest observation available on or before the calendar anchor", () => {
  const points = [
    { date: "2025-01-31", value: 100 },
    { date: "2025-02-28", value: 105 },
    { date: "2026-01-30", value: 120 },
    { date: "2026-02-28", value: 126 },
  ];
  assert.ok(Math.abs(calendarPercentChange(points, 1).at(-1).value - 5) < 1e-12);
  assert.ok(Math.abs(transformSeries(points, "yoy").at(-1).value - 20) < 1e-12);
});

test("rolling standardization and percentile use only trailing observations", () => {
  const points = [1, 2, 3].map((value, index) => ({ date: `2026-01-0${index + 1}`, value }));
  const zscore = rollingZScore(points, 3);
  assert.equal(zscore[0].value, null);
  assert.ok(Math.abs(zscore[2].value - 1.224744871391589) < 1e-12);
  assert.equal(rollingPercentile(points, 3)[2].value, 83.33333333333334);
});

test("market aggregation preserves auditable factor contributions and direction", () => {
  assert.deepEqual(calculateMarketFactorContributions([
    { market: "hk", factor: "real-rate", signal: 2, weight: 0.5, direction: -1 },
    { market: "hk", factor: "cn-growth", signal: 1, weight: 1 },
    { market: "us", factor: "growth", signal: 0.5, weight: 1 },
  ]), [
    {
      market: "hk",
      score: 0,
      confidence: 1,
      confidenceLevel: "high",
      coverage: { configured: 2, available: 2, fresh: 2, stale: 0, missing: 0, configuredWeight: 1.5, availableWeight: 1.5, effectiveWeight: 1.5 },
      contributions: [
        { factor: "real-rate", contribution: -1, signal: 2, weight: 0.5, quality: "fresh", freshnessWeight: 1 },
        { factor: "cn-growth", contribution: 1, signal: 1, weight: 1, quality: "fresh", freshnessWeight: 1 },
      ],
    },
    {
      market: "us",
      score: 0.5,
      confidence: 1,
      confidenceLevel: "high",
      coverage: { configured: 1, available: 1, fresh: 1, stale: 0, missing: 0, configuredWeight: 1, availableWeight: 1, effectiveWeight: 1 },
      contributions: [{ factor: "growth", contribution: 0.5, signal: 0.5, weight: 1, quality: "fresh", freshnessWeight: 1 }],
    },
  ]);
});

test("market aggregation attenuates stale signals and reports missing configured exposure", () => {
  const [market] = calculateMarketFactorContributions([
    { market: "hk", factor: "fresh", seriesId: "FRESH", signal: 2, weight: 1, quality: "fresh", freshnessWeight: 1 },
    { market: "hk", factor: "stale", seriesId: "STALE", signal: 2, weight: 1, quality: "stale", freshnessWeight: 0.5 },
    { market: "hk", factor: "missing", seriesId: "MISSING", signal: null, weight: 1, quality: "missing", freshnessWeight: 0 },
  ]);
  assert.equal(market.score, 1);
  assert.equal(market.confidence, 0.5);
  assert.equal(market.confidenceLevel, "low");
  assert.deepEqual(market.coverage, {
    configured: 3, available: 2, fresh: 1, stale: 1, missing: 1,
    configuredWeight: 3, availableWeight: 2, effectiveWeight: 1.5,
  });
  assert.deepEqual(market.contributions, [
    { factor: "fresh", seriesId: "FRESH", contribution: 2, signal: 2, weight: 1, quality: "fresh", freshnessWeight: 1 },
    { factor: "stale", seriesId: "STALE", contribution: 1, signal: 2, weight: 1, quality: "stale", freshnessWeight: 0.5 },
    { factor: "missing", seriesId: "MISSING", contribution: 0, signal: null, weight: 1, quality: "missing", freshnessWeight: 0 },
  ]);
});

test("rolling correlation aligns by date and does not fabricate missing observations", () => {
  const result = rollingCorrelation([
    { date: "2026-01-01", value: 1 },
    { date: "2026-01-02", value: 2 },
    { date: "2026-01-03", value: 3 },
  ], [
    { date: "2026-01-01", value: 2 },
    { date: "2026-01-03", value: 6 },
  ], 2);
  assert.deepEqual(result, [
    { date: "2026-01-01", value: null, observations: 1 },
    { date: "2026-01-03", value: 1, observations: 2 },
  ]);
});

test("backtest enters strictly after the signal date and reports forward outcomes", () => {
  const result = backtestSignal([
    { date: "2026-01-01", value: 2 },
    { date: "2026-01-03", value: -1 },
  ], [
    { date: "2026-01-01", value: 100 },
    { date: "2026-01-02", value: 110 },
    { date: "2026-01-03", value: 121 },
  ], { operator: "gte", threshold: 1 }, 1);
  assert.equal(result.trades.length, 1);
  assert.deepEqual({ ...result.trades[0], returnPct: 10 }, {
    signalDate: "2026-01-01", entryDate: "2026-01-02", exitDate: "2026-01-03", signal: 2, returnPct: 10,
  });
  assert.ok(Math.abs(result.trades[0].returnPct - 10) < 1e-12);
  assert.ok(Math.abs(result.averageReturnPct - 10) < 1e-12);
  assert.equal(result.winRatePct, 100);
});

test("backtest does not reuse the first market price for signals before market history", () => {
  const result = backtestSignal([
    { date: "2025-01-01", value: 2 },
  ], [
    { date: "2026-01-01", value: 100 },
    { date: "2026-01-02", value: 110 },
  ], { operator: "gte", threshold: 1 }, 1);
  assert.equal(result.trades.length, 0);
});

test("point-in-time research uses only the initial vintage and its availability date", () => {
  const base = {
    seriesId: "TEST", observationDate: "2025-12-01", releasedAt: Date.parse("2026-01-10T00:00:00Z"),
    consensus: null, previousValue: null, isPreliminary: false, qualityStatus: "valid",
    sourceUrl: "https://example.test", rawR2Key: null, observedAt: Date.parse("2026-01-11T00:00:00Z"),
  };
  const result = initialReleasePoints([
    { ...base, vintageAt: Date.parse("2026-01-11T00:00:00Z"), revisionNumber: 0, value: 100 },
    { ...base, vintageAt: Date.parse("2026-02-01T00:00:00Z"), revisionNumber: 1, value: 200 },
  ]);
  assert.deepEqual(result, [{ date: "2026-01-11", value: 100 }]);
});

test("scenario replay returns exact boundary observations and handles zero bases", () => {
  assert.deepEqual(replayScenario({ factor: [
    { date: "2026-01-01", value: 0 },
    { date: "2026-01-31", value: 2 },
  ] }, "2026-01-01", "2026-01-31"), [{
    seriesId: "factor",
    start: { date: "2026-01-01", value: 0 },
    end: { date: "2026-01-31", value: 2 },
    change: 2,
    changePct: null,
  }]);
});
