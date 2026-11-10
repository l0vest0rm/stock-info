// 赛道龙头超跌筛选的口径回归：没有网络也能跑，固定住三个最容易改错的点。
//
// 1. TTM 利润 = 上年报 + 本期累计 − 上年同期累计（与 backend/src/finance/series.rs 一致）
// 2. 单季值 = 本年累计 − 本年上一份累计；一季度即单季；缺上一份就返回 null，不内插
// 3. 5 年分位只在当前值本身有效时才有定义（亏损时不能返回 0）
import { test } from "node:test";
import assert from "node:assert/strict";
import { ttmValue, quarterValue, percentileRank } from "../analyze-track-leader-oversold.mjs";

const row = (reportDate, netProfit, fiscalPeriod = "三季报") => ({
  reportDate,
  fiscalPeriod,
  payload: { PARENT_NETPROFIT: netProfit },
});
const pick = (row) => row?.payload?.PARENT_NETPROFIT ?? null;
const YI = 1e8;

test("TTM 用「上年报 + 本期累计 − 上年同期累计」", () => {
  const rows = [
    row("2026-09-30", 90 * YI),
    row("2025-12-31", 120 * YI, "年报"),
    row("2025-09-30", 70 * YI),
    row("2024-12-31", 100 * YI, "年报"),
    row("2024-09-30", 60 * YI),
  ];
  const latest = ttmValue(rows, pick);
  assert.equal(latest.value, 140 * YI);
  assert.equal(latest.basis, "cumulative_roll");
});

test("最新一期是年报时直接取年报，不做滚动", () => {
  const rows = [row("2025-12-31", 120 * YI, "年报"), row("2024-12-31", 100 * YI, "年报")];
  const latest = ttmValue(rows, pick);
  assert.equal(latest.value, 120 * YI);
  assert.equal(latest.basis, "annual");
});

test("缺上年报时不编造 TTM", () => {
  const rows = [row("2026-09-30", 90 * YI), row("2025-09-30", 70 * YI)];
  assert.equal(ttmValue(rows, pick), null);
});

test("单季值由累计相减得到，一季度等于自身，Q4 = 年报 − 三季报", () => {
  const rows = [
    row("2026-09-30", 90 * YI),
    row("2026-06-30", 55 * YI, "中报"),
    row("2026-03-31", 25 * YI, "一季报"),
    row("2025-12-31", 100 * YI, "年报"),
    row("2025-09-30", 75 * YI),
  ];
  assert.equal(quarterValue(rows, pick, "2026-03-31").value, 25 * YI);
  assert.equal(quarterValue(rows, pick, "2026-06-30").value, 30 * YI);
  assert.equal(quarterValue(rows, pick, "2026-09-30").value, 35 * YI);
  assert.equal(quarterValue(rows, pick, "2025-12-31").value, 25 * YI);
});

test("单季缺上一份累计时返回 null，不内插", () => {
  const rows = [row("2026-09-30", 90 * YI)];
  assert.equal(quarterValue(rows, pick, "2026-09-30"), null);
});

test("5 年分位：当前值无效时返回 null，而不是 0", () => {
  const series = Array.from({ length: 300 }, (_, index) => (index % 10) + 1);
  // 300 个样本、取值 1–10 循环：≤5 的样本占一半
  assert.equal(percentileRank(series, 5), 0.5);
  assert.equal(percentileRank(series, -3), null);
  assert.equal(percentileRank(series, null), null);
  assert.equal(percentileRank(series.slice(0, 100), 5), null);
});
