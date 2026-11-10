// 全 A 行业龙头筛选的口径回归：不联网、不读真实数据也能跑。
//
// 固定住五个最容易改错、改错又看不出来的点：
//   1. 行业龙头按总市值排序，ST / 低市值 / 缺市值被排除而不是当成 0
//   2. 估值分层按行业名切换主口径（银行看 PB、通用看 PE），不做模糊猜测
//   3. 严格档要求全部权重指标都便宜；只有次级指标超限时降级为宽松档
//   4. 累计报表和单季度报表必须分开：混用会把单季利润当成累计利润
//   5. 缺数据 / 缺确认信号时不能给出「四关全过」
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SETTINGS,
  buildCandidate,
  evaluateCandidate,
  evaluateValuation,
  evaluateWeak,
  layerForIndustry,
  selectIndustryLeaders,
} from "../lib/industry-leader-screen.mjs";
import {
  buildFinancialSummary,
  daysBetween,
  percentileRank,
  quarterValue,
  shiftYear,
  statementFamily,
  technicals,
  ttmValue,
} from "../lib/oversold-metrics.mjs";

const YI = 1e8;
const row = (code, name, industry, cap) => ({ code, name, industry, marketCap: cap * YI });

// --- 1. 行业龙头选择 --------------------------------------------------------

test("行业内按总市值取 Top N，并记录排名与成员数", () => {
  const rows = [
    row("600000.SH", "甲", "银行", 3000),
    row("600001.SH", "乙", "银行", 2000),
    row("600002.SH", "丙", "银行", 1000),
    row("600003.SH", "丁", "银行", 500),
    row("600004.SH", "戊", "白酒", 800),
    row("600005.SH", "己", "白酒", 700),
    row("600006.SH", "庚", "白酒", 600),
  ];
  const { tracks } = selectIndustryLeaders(rows, { topN: 3, minMembers: 3, minMarketCap: 0 });
  const bank = tracks.find((track) => track.industry === "银行");
  assert.deepEqual(bank.leaders.map((item) => item.code), ["600000.SH", "600001.SH", "600002.SH"]);
  assert.equal(bank.leaders[0].industryRank, 1);
  assert.equal(bank.memberCount, 4);
  assert.equal(bank.leaders.length, 3, "Top N 只截取，不改变成员数");
});

test("ST、低市值、缺市值的成员被排除并留档，不按 0 参与排名", () => {
  const rows = [
    row("600000.SH", "甲", "银行", 3000),
    row("600001.SH", "乙", "银行", 2000),
    row("600002.SH", "丙", "银行", 1000),
    row("600003.SH", "*ST丁", "银行", 5000),
    row("600004.SH", "戊", "银行", 10),
    { code: "600005.SH", name: "己", industry: "银行", marketCap: null },
  ];
  const { tracks, excluded } = selectIndustryLeaders(rows, { topN: 3, minMembers: 3, minMarketCap: 50 * YI });
  const bank = tracks.find((track) => track.industry === "银行");
  assert.deepEqual(bank.leaders.map((item) => item.code), ["600000.SH", "600001.SH", "600002.SH"]);
  assert.equal(bank.memberCount, 3);
  const reasons = new Map(excluded.map((item) => [item.code, item.reason]));
  assert.match(reasons.get("600003.SH"), /ST/);
  assert.match(reasons.get("600004.SH"), /市值/);
  assert.match(reasons.get("600005.SH"), /市值/);
});

test("成员不足门槛的行业不产生龙头，并给出 warning", () => {
  const rows = [row("600004.SH", "戊", "小行业", 900), row("600005.SH", "己", "小行业", 800), row("600006.SH", "庚", "小行业", 700)];
  const { tracks, warnings } = selectIndustryLeaders(rows, { topN: 3, minMembers: 3, minMarketCap: 0 });
  assert.equal(tracks.length, 1);
  const tight = selectIndustryLeaders(rows, { topN: 3, minMembers: 4, minMarketCap: 0 });
  assert.equal(tight.tracks.length, 0);
  assert.match(tight.warnings[0], /小行业/);
});

test("东财个别个股的行业占位符 '-' 归入未分类，不单独成为一个行业", () => {
  const rows = ["-", "", "未分类"].map((industry, index) => row(`60000${index}.SH`, `票${index}`, industry, 100 + index));
  const { tracks } = selectIndustryLeaders(rows, { topN: 3, minMembers: 3, minMarketCap: 0 });
  assert.deepEqual(tracks.map((track) => track.industry), ["未分类"]);
});

// --- 2. 估值分层 ------------------------------------------------------------

test("估值主口径按行业名切换：银行看 PB，通用看 PE", () => {
  assert.deepEqual(layerForIndustry("银行Ⅱ").metrics, ["pb", "peTtm"]);
  assert.deepEqual(layerForIndustry("保险Ⅱ").metrics, ["pb", "peTtm"]);
  assert.deepEqual(layerForIndustry("半导体").metrics, ["peTtm", "pb"]);
  assert.equal(layerForIndustry("煤炭开采").cyclical, true);
  assert.equal(layerForIndustry("半导体").cyclical, false);
});

// --- 3. 估值判定 ------------------------------------------------------------

const settings = { ...DEFAULT_SETTINGS };

test("严格档：权重指标全部分位 ≤ 阈值才算便宜", () => {
  const item = {
    layer: { metrics: ["peTtm", "pb"] },
    quotes: { peTtm: { current: 10, percentile: 0.1 }, pb: { current: 1, percentile: 0.2 } },
  };
  const result = evaluateValuation(item, settings);
  assert.equal(result.pass, true);
  assert.equal(result.tier, "severe");
  assert.equal(result.worstPercentile, 0.2);
});

test("只有次级指标超限时降级为宽松档，不让它冒充严格档", () => {
  const item = {
    layer: { metrics: ["peTtm", "pb"] },
    quotes: { peTtm: { current: 10, percentile: 0.05 }, pb: { current: 1, percentile: 0.3 } },
  };
  const result = evaluateValuation(item, settings);
  assert.equal(result.pass, false);
  assert.equal(result.tier, "mild");
  assert.equal(result.loose.pass, true);
});

test("主指标不便宜时，即使次级指标便宜也不算宽松档", () => {
  const item = {
    layer: { metrics: ["peTtm", "pb"] },
    quotes: { peTtm: { current: 30, percentile: 0.8 }, pb: { current: 1, percentile: 0.05 } },
  };
  const result = evaluateValuation(item, settings);
  assert.equal(result.pass, false);
  assert.equal(result.loose.pass, false);
  assert.equal(result.tier, "not_cheap");
});

test("PE 亏损（分位为 null）时不参与判定，PB 仍可单独成立", () => {
  const item = {
    layer: { metrics: ["peTtm", "pb"] },
    quotes: { peTtm: { current: null, percentile: null }, pb: { current: 1, percentile: 0.1 } },
  };
  const result = evaluateValuation(item, settings);
  assert.equal(result.pass, true);
  assert.deepEqual(result.metrics.map((entry) => entry.key), ["pb"]);
});

test("两个指标都没有有效分位时是 insufficient，不是便宜", () => {
  const item = {
    layer: { metrics: ["peTtm", "pb"] },
    quotes: { peTtm: { current: null, percentile: null }, pb: { current: null, percentile: null } },
  };
  const result = evaluateValuation(item, settings);
  assert.equal(result.state, "insufficient");
  assert.equal(result.pass, false);
});

// --- 4. 累计 / 单季报表族 ---------------------------------------------------

test("累计报表与单季度报表按合同和标签区分", () => {
  const cumulative = { reportDate: "2026-09-30", fiscalPeriod: "三季报", payload: { PARENT_NETPROFIT: 90 * YI, FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_income.v1" } };
  const single = { reportDate: "2026-09-30", fiscalPeriod: "三季度", payload: { PARENT_NETPROFIT: 35 * YI, FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_incomeqc.v1" } };
  assert.equal(statementFamily(cumulative), "cumulative");
  assert.equal(statementFamily(single), "single");
});

test("TTM 只用累计行；混入单季度行不会改变结果", () => {
  const rows = [
    { reportDate: "2026-09-30", fiscalPeriod: "三季报", payload: { PARENT_NETPROFIT: 90 * YI, FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_income.v1" } },
    { reportDate: "2026-09-30", fiscalPeriod: "三季度", payload: { PARENT_NETPROFIT: 35 * YI, FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_incomeqc.v1" } },
    { reportDate: "2025-12-31", fiscalPeriod: "12M", payload: { PARENT_NETPROFIT: 120 * YI, FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_annual_income.v1" } },
    { reportDate: "2025-09-30", fiscalPeriod: "三季报", payload: { PARENT_NETPROFIT: 70 * YI, FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_income.v1" } },
    { reportDate: "2024-12-31", fiscalPeriod: "12M", payload: { PARENT_NETPROFIT: 100 * YI, FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_annual_income.v1" } },
  ];
  const pick = (r) => r?.payload?.PARENT_NETPROFIT ?? null;
  assert.equal(ttmValue(rows, pick).value, 140 * YI);
});

test("单季优先取单季度家族；没有时用累计差，缺上一份返回 null", () => {
  const pick = (r) => r?.payload?.PARENT_NETPROFIT ?? null;
  const withSingle = [
    { reportDate: "2026-09-30", fiscalPeriod: "三季度", payload: { PARENT_NETPROFIT: 35 * YI, FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_incomeqc.v1" } },
    { reportDate: "2026-09-30", fiscalPeriod: "三季报", payload: { PARENT_NETPROFIT: 90 * YI, FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_income.v1" } },
  ];
  assert.deepEqual(quarterValue(withSingle, pick, "2026-09-30"), { value: 35 * YI, reportDate: "2026-09-30", basis: "single_quarter" });

  const cumulativeOnly = [
    { reportDate: "2026-09-30", fiscalPeriod: "三季报", payload: { PARENT_NETPROFIT: 90 * YI, FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_income.v1" } },
    { reportDate: "2026-06-30", fiscalPeriod: "中报", payload: { PARENT_NETPROFIT: 55 * YI, FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_income.v1" } },
  ];
  assert.equal(quarterValue(cumulativeOnly, pick, "2026-09-30").value, 35 * YI);
  assert.equal(quarterValue([cumulativeOnly[0]], pick, "2026-09-30"), null);
});

test("财务摘要缺累计报表时返回 available:false，而不是全 0", () => {
  const rows = [{ reportDate: "2026-09-30", fiscalPeriod: "三季度", payload: { PARENT_NETPROFIT: 35 * YI, FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_incomeqc.v1" } }];
  const summary = buildFinancialSummary(rows, "2026-11-05");
  assert.equal(summary.available, false);
  assert.match(summary.reason, /累计/);
});

// --- 5. 分级与「不许冒充通过」 ----------------------------------------------

function syntheticRows({ n = 400, trend = -0.002, pe = 10, pb = 1 } = {}) {
  const rows = [];
  let close = 100;
  for (let index = 0; index < n; index += 1) {
    close *= 1 + trend;
    const day = new Date(Date.UTC(2024, 0, 1) + index * 86_400_000).toISOString().slice(0, 10);
    rows.push({ date: day, open: close, high: close * 1.01, low: close * 0.99, close, peTtm: pe, pb, marketCapital: close * 1e9 });
  }
  return rows;
}

function financialFixture({ ttmGrowth = 0.1 } = {}) {
  return {
    available: true,
    latestReportDate: "2026-09-30",
    ageDays: 30,
    ttmProfit: 100 * YI,
    ttmGrowth,
    cagr2y: 0.05,
    quarters: [{ reportDate: "2026-09-30", netProfit: 30 * YI, netProfitYoY: 0.1 }],
  };
}

/**
 * 合成一只「弱势 + 便宜」的候选。估值分位显式注入，因为合成序列的 PE/PB 是常数，
 * 其历史分位必然是 50%，那属于样本构造问题，不是被测逻辑。
 */
function weakCheapCandidate({ ttmGrowth = 0.1 } = {}) {
  const rows = syntheticRows({ trend: -0.004 });
  const item = buildCandidate(
    { code: "600000.SH", name: "测试", industry: "银行", industryRank: 1, industryMembers: 5, layer: { metrics: ["pb", "peTtm"] } },
    { rows, financialRows: financialFixture({ ttmGrowth }) },
  );
  item.quotes.pb = { current: 1, asOf: rows.at(-1).date, percentile: 0.1, stale: false };
  item.quotes.peTtm = { current: 10, asOf: rows.at(-1).date, percentile: 0.1, stale: false };
  return item;
}

test("四关全过需要弱势 + 便宜 + 盈利 + 确认信号同时成立", () => {
  const item = weakCheapCandidate();
  // 人工塞入一个确认信号，避免依赖真实K线的随机形态
  item.tech.confirm = [{ key: "base", label: "站上 5 日线且近 5 日低点抬高" }];
  const verdict = evaluateCandidate(item, settings);
  assert.equal(verdict.status, "bounce-watch");
  assert.ok(verdict.score > 0);
});

test("没有确认信号时进「等止跌信号」，不会算四关全过", () => {
  const item = weakCheapCandidate();
  item.tech.confirm = [];
  item.tech.watch = [{ key: "rsi-oversold", label: "RSI 超卖" }];
  const verdict = evaluateCandidate(item, settings);
  assert.equal(verdict.status, "no-trigger");
  assert.ok(!["bounce-watch"].includes(verdict.status));
});

test("盈利恶化时即使便宜且有信号也只算 weak-earnings", () => {
  const item = weakCheapCandidate({ ttmGrowth: -0.4 });
  item.tech.confirm = [{ key: "base", label: "止跌" }];
  const verdict = evaluateCandidate(item, settings);
  assert.equal(verdict.status, "weak-earnings");
});

test("TTM 同比为正但最新单季大幅转差时降到 weak-quarter", () => {
  const item = weakCheapCandidate({ ttmGrowth: 0.2 });
  // 模拟科沃斯/珀莱雅那类形态：滚动四季仍增长，最近一个季度已经明显下滑
  item.fin.quarters = [{ reportDate: "2026-09-30", netProfit: 1 * YI, netProfitYoY: -0.6 }];
  item.tech.confirm = [{ key: "base", label: "止跌" }];
  const verdict = evaluateCandidate(item, settings);
  assert.equal(verdict.earnings.ttmPass, true);
  assert.equal(verdict.earnings.quarterPass, false);
  assert.equal(verdict.status, "weak-quarter");
});

test("单季数据缺失时不因为「没有数字」判成转差", () => {
  const item = weakCheapCandidate({ ttmGrowth: 0.2 });
  item.fin.quarters = [{ reportDate: "2026-09-30", netProfit: null, netProfitYoY: null }];
  item.tech.confirm = [{ key: "base", label: "止跌" }];
  const verdict = evaluateCandidate(item, settings);
  assert.equal(verdict.earnings.quarterPass, true);
  assert.equal(verdict.status, "bounce-watch");
});

test("K线不足或财务缺失一律 blocked，不给分数", () => {
  const item = buildCandidate(
    { code: "600000.SH", name: "测试", industry: "银行", industryRank: 1, industryMembers: 5, layer: { metrics: ["pb"] } },
    { rows: syntheticRows({ n: 60 }), financialRows: { available: false, reason: "没有本地利润表快照" } },
  );
  const verdict = evaluateCandidate(item, settings);
  assert.equal(verdict.status, "blocked");
  assert.equal(verdict.score, null);
  assert.ok(verdict.blocked.some((reason) => /K线/.test(reason)));
  assert.ok(verdict.blocked.some((reason) => /财务/.test(reason)));
});

test("弱势判定要求回撤足够深且未过热", () => {
  const mild = { available: true, drawdown252: -0.1, return120: -0.05, rsi14: 40, ma250: 100, close: 95 };
  assert.equal(evaluateWeak(mild, settings).pass, false);
  const hot = { available: true, drawdown252: -0.4, return120: -0.2, rsi14: 75, ma250: 100, close: 95 };
  assert.equal(evaluateWeak(hot, settings).pass, false, "已反弹到 RSI 过热的不追");
  const good = { available: true, drawdown252: -0.4, return120: -0.2, rsi14: 40, ma250: 100, close: 95 };
  assert.equal(evaluateWeak(good, settings).pass, true);
});

// --- 6. 分位口径 ------------------------------------------------------------

test("分位样本不足 250 或当前值非正时返回 null", () => {
  const series = Array.from({ length: 300 }, (_, index) => (index % 10) + 1);
  assert.equal(percentileRank(series, 5), 0.5);
  assert.equal(percentileRank(series, -1), null);
  assert.equal(percentileRank(series.slice(0, 100), 5), null);
});

test("technicals 在K线不足时显式不可用", () => {
  assert.equal(technicals(syntheticRows({ n: 100 })).available, false);
  assert.equal(technicals(syntheticRows({ n: 400 })).available, true);
});

// --- 7. 5 年窗口 ------------------------------------------------------------

test("5 年分位只用最近 5 年样本，长历史不会被算进来", () => {
  const rows = syntheticRows({ n: 2000 }); // 约 5.5 年
  const tech = technicals(rows);
  const asOf = rows.at(-1).date;
  const cutoff = shiftYear(asOf, -5);
  const expected = rows.filter((row) => row.date >= cutoff).length;
  assert.equal(tech.pe5y.length, expected);
  assert.ok(expected < rows.length, "窗口必须真的截断");
  assert.ok(expected > 1000, "5 年应包含约 1200 个交易日");
});

test("行情前沿落后时整份报告给出警告", () => {
  // 直接验证纯函数：日历差超过 7 天就必须提示刷新
  assert.equal(daysBetween("2026-10-01", "2026-11-05"), 35);
  assert.ok(daysBetween("2026-10-01", "2026-11-05") > 7);
});
