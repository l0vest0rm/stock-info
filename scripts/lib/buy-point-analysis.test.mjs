import assert from "node:assert/strict";
import test from "node:test";

import config from "../../web/src/config/buy-point-analysis.json" with { type: "json" };
import { analyzeBuyPoint, buildTradeAdvice, normalizeKlineRows } from "./buy-point-analysis.mjs";

test("normalizes legacy API rows and sorts them by date", () => {
  const rows = normalizeKlineRows([
    [Date.UTC(2026, 0, 2), 9, 10, 10, 8, 100, 1.2, 90_000_000],
    [Date.UTC(2026, 0, 1), 10, 10, 11, 9, 90, 1.1, 80_000_000],
  ]);
  assert.deepEqual(rows.map((row) => row.date), ["2026-01-01", "2026-01-02"]);
  assert.equal(rows[1].turnover, 1.2);
  assert.equal(rows[1].amount, 90_000_000);
});

test("a fresh breakdown in a falling trend is not labeled as a buy", () => {
  const rows = makeRows(70, (index) => 120 - index * 0.7, { latestDrop: 8 });
  const result = analyzeBuyPoint(rows, config);
  assert.equal(result.flags.breakdown, true);
  assert.equal(result.flags.fallingTrend, true);
  assert.equal(result.decision.status, "暂不接飞刀");
  assert.ok(result.scores.riskPenalty >= 40);
});

test("oversold conditions plus a confirmed reversal can become a staged entry", () => {
  const rows = makeRows(70, (index) => index < 58 ? 120 + index * 0.05 : 123 - (index - 58) * 2.2);
  const last = rows.at(-1);
  const previous = rows.at(-2);
  last.open = previous.close - 1;
  last.close = previous.high + 3;
  last.high = last.close + 1;
  last.low = last.open - 1;
  last.volume = 5000;
  const result = analyzeBuyPoint(rows, config);
  assert.ok(result.scores.setup >= config.decisions.minimumSetupForEntry);
  assert.ok(result.scores.confirmation >= config.decisions.minimumConfirmationForEntry);
  assert.equal(result.decision.status, "可考虑分批试仓");
});

test("rejects histories too short for MA60 and slope analysis", () => {
  assert.throws(() => analyzeBuyPoint(makeRows(64, (index) => 100 + index), config), /at least 65/);
});

test("a support breakdown overrides oversold entry signals for existing positions", () => {
  const analysis = analyzeBuyPoint(makeRows(70, (index) => 120 - index * 0.7, { latestDrop: 8 }), config);
  const advice = buildTradeAdvice(analysis, true, 130);
  assert.equal(advice.action, "exit");
  assert.equal(advice.label, "破位：退出/显著减仓");
});

test("an empty position never receives a sell action", () => {
  const analysis = analyzeBuyPoint(makeRows(70, (index) => 120 - index * 0.7, { latestDrop: 8 }), config);
  const advice = buildTradeAdvice(analysis, false);
  assert.equal(advice.action, "watch");
  assert.equal(advice.buyLabel, "暂停买入");
});

test("confirmed price reversal is rejected when 20-day liquidity is below the configured floor", () => {
  const rows = makeRows(70, (index) => index < 58 ? 120 + index * 0.05 : 123 - (index - 58) * 2.2, {
    amount: 1_000_000,
    turnover: 0.05,
  });
  const last = rows.at(-1);
  const previous = rows.at(-2);
  last.open = previous.close - 1;
  last.close = previous.high + 3;
  last.high = last.close + 1;
  last.low = last.open - 1;
  last.volume = 5000;
  const result = analyzeBuyPoint(rows, config);
  assert.equal(result.flags.lowLiquidity, true);
  assert.equal(result.decision.status, "流动性不足");
  assert.equal(buildTradeAdvice(result, false).action, "watch");
  assert.equal(buildTradeAdvice(result, true).action, "reduce");
});

test("a high-volume down day is recorded as distribution risk", () => {
  const rows = makeRows(70, (index) => 100 + index * 0.1);
  const last = rows.at(-1);
  last.close = rows.at(-2).close - 2;
  last.low = last.close - 0.5;
  last.volume = 5000;
  const result = analyzeBuyPoint(rows, config);
  assert.equal(result.flags.distributionRisk, true);
  assert.ok(result.scores.riskPenalty >= config.scores.distributionPenalty);
  assert.equal(buildTradeAdvice(result, true).action, "reduce");
});

test("missing amount and turnover data is reported as unknown rather than low liquidity", () => {
  const rows = makeRows(70, (index) => 100 + index * 0.1, { omitLiquidity: true });
  const result = analyzeBuyPoint(rows, config);
  assert.equal(result.indicators.liquidityCoverage, 0);
  assert.equal(result.flags.lowLiquidity, false);
});

function makeRows(count, closeAt, options = {}) {
  return Array.from({ length: count }, (_, index) => {
    let close = closeAt(index);
    if (index === count - 1 && options.latestDrop) close -= options.latestDrop;
    const previousClose = index === 0 ? close : closeAt(index - 1);
    const open = previousClose;
    return {
      date: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
      open,
      close,
      high: Math.max(open, close) + 0.5,
      low: Math.min(open, close) - 0.5,
      volume: 1000,
      amount: options.omitLiquidity ? null : options.amount ?? 100_000_000,
      turnover: options.omitLiquidity ? null : options.turnover ?? 1,
    };
  });
}
