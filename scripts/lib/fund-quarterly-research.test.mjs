import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  aggregateCurrentFundHoldings,
  aggregateReportForecasts,
  analyzePositionChanges,
  buildHoldingMarketSnapshot,
  buildOutputFilename,
  dedupeFundShareClasses,
  findFundReportNotice,
  latestQuarterlyReportDate,
  outputAlreadyExists,
  parseFundRankRows,
  parseFundTotalShares,
  previousReportDate,
  returnBetweenKlines,
  renderPrompt,
  renderFundIndexMarkdown,
  renderFundHoldingsStatisticsHtml,
  selectDisclosedHoldings,
} from "./fund-quarterly-research.mjs";

test("latest quarterly report date never invents a Q4 quarterly report", () => {
  assert.equal(latestQuarterlyReportDate("2026-01-15"), "2025-09-30");
  assert.equal(latestQuarterlyReportDate("2026-04-01"), "2026-03-31");
  assert.equal(latestQuarterlyReportDate("2026-07-23"), "2026-06-30");
  assert.equal(latestQuarterlyReportDate("2026-10-01"), "2026-09-30");
  assert.equal(previousReportDate("2026-03-31"), "2025-12-31");
});

test("rank parsing and ABC dedupe prefer the configured share class", () => {
  const funds = parseFundRankRows([
    [1, "000002", '<a href="x">示例成长混合C</a>', "2026-07-22", "", "", "1", "2", "3", "90"],
    [2, "000001", '<a href="x">示例成长混合A</a>', "2026-07-22", "", "", "1", "2", "3", "89"],
    [3, "000003", '<a href="x">另一基金</a>', "2026-07-22", "", "", "1", "2", "3", "80"],
  ]);
  const deduped = dedupeFundShareClasses(funds, ["A", "B", "C", ""]);
  assert.deepEqual(deduped.map((fund) => fund.code), ["000001", "000003"]);
  assert.equal(deduped[0].baseName, "示例成长混合");
  assert.equal(deduped[0].threeMonthReturnPct, 89);
});

test("notice selection accepts the exact quarter and excludes summary notices", () => {
  const notices = [
    { FUNDCODE: "005844", TITLE: "东方基金旗下基金2026年第2季度报告提示性公告", ID: "tip" },
    { FUNDCODE: "005844", TITLE: "东方人工智能主题混合型证券投资基金 2026 年第 2 季度报告", ID: "report" },
    { FUNDCODE: "005844", TITLE: "东方人工智能主题混合型证券投资基金2026年第1季度报告", ID: "old" },
  ];
  assert.equal(findFundReportNotice(notices, "005844", "2026-06-30").ID, "report");
  assert.equal(findFundReportNotice(notices, "005844", "2026-03-31").ID, "old");
});

test("annual report can supply the previous period total shares for Q1", () => {
  const notices = [
    { FUNDCODE: "005844", TITLE: "东方人工智能主题混合型证券投资基金2025年年度报告摘要", ID: "summary" },
    { FUNDCODE: "005844", TITLE: "东方人工智能主题混合型证券投资基金2025年年度报告", ID: "annual" },
  ];
  assert.equal(findFundReportNotice(notices, "005844", "2025-12-31").ID, "annual");
  assert.equal(parseFundTotalShares("报告期末基金份额总额 8,203,933,062.34 份"), 8203933062.34);
});

test("formal report holdings remove extra API rows but preserve duplicated ranks", () => {
  const holdings = [
    { code: "688361.SH", name: "甲" },
    { code: "01347.HK", name: "乙H" },
    { code: "688347.SH", name: "乙A" },
    { code: "688596.SH", name: "接口多余行" },
  ];
  const report = `
5.3.1 报告期末按公允价值占基金资产净值比例大小排序的前十名股票投资明细
1 688361 甲 100 1000 10.00
7 01347 乙H 100 900 5.00
7 688347 乙A 100 800 4.00
5.4 报告期末按债券品种分类的债券投资组合
`;
  assert.deepEqual(
    selectDisclosedHoldings(holdings, report).map((holding) => holding.code),
    ["688361.SH", "01347.HK", "688347.SH"],
  );
});

test("position actions adjust holdings for whole-fund share growth", () => {
  const changes = analyzePositionChanges({
    previousHoldings: [
      { code: "A.SH", name: "甲", weightPct: 10, shares: 100 },
      { code: "B.SH", name: "乙", weightPct: 8, shares: 100 },
      { code: "D.SH", name: "丁", weightPct: 5, shares: 50 },
    ],
    currentHoldings: [
      { code: "A.SH", name: "甲", weightPct: 9, shares: 200 },
      { code: "B.SH", name: "乙", weightPct: 9, shares: 260 },
      { code: "C.SH", name: "丙", weightPct: 6, shares: 80 },
    ],
    previousFundShares: 1000,
    currentFundShares: 2000,
    returnsByCode: {
      "A.SH": { periodReturnPct: 100, postReportReturnPct: -10 },
      "B.SH": { periodReturnPct: 50, postReportReturnPct: 10 },
      "C.SH": { periodReturnPct: 30, postReportReturnPct: -8 },
      "D.SH": { periodReturnPct: 20, postReportReturnPct: -7 },
    },
    actionThresholdPct: 10,
    assessmentThresholdPct: 3,
  });
  const byCode = Object.fromEntries(changes.map((item) => [item.code, item]));
  assert.equal(byCode["A.SH"].action, "基本持平");
  assert.equal(byCode["A.SH"].perFundShareChangePct, 0);
  assert.equal(byCode["B.SH"].action, "加仓");
  assert.equal(byCode["B.SH"].perFundShareChangePct, 30);
  assert.equal(byCode["B.SH"].shortTermAssessment, "短期正确");
  assert.equal(byCode["C.SH"].action, "新进前十大");
  assert.equal(byCode["C.SH"].shortTermAssessment, "短期错误");
  assert.equal(byCode["D.SH"].action, "退出前十大");
  assert.equal(byCode["D.SH"].shortTermAssessment, "短期正确");
  assert.equal(byCode["A.SH"].estimatedContributionPct, 9.5);
});

test("kline return uses the latest close on or before each boundary", () => {
  const ts = (date) => Date.parse(`${date}T00:00:00Z`);
  const rows = [
    [ts("2026-03-30"), 10],
    [ts("2026-04-01"), 12],
    [ts("2026-06-30"), 20],
  ];
  assert.equal(returnBetweenKlines(rows, "2026-03-31", "2026-06-30"), 100);
});

test("output filename preserves fund identity and existence is the idempotency marker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fund-quarterly-research-"));
  try {
    const filename = buildOutputFilename("示例/成长混合A", "000001", "2026-06-30");
    assert.equal(filename, "示例-成长混合A-000001-2026Q2.md");
    const path = join(directory, filename);
    assert.equal(await outputAlreadyExists(path), false);
    await writeFile(path, "", "utf8");
    assert.equal(await outputAlreadyExists(path), false);
    await writeFile(path, "# done\n", "utf8");
    assert.equal(await outputAlreadyExists(path), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("prompt rendering replaces configured placeholders and rejects missing values", () => {
  assert.equal(
    renderPrompt("{{EVIDENCE_PATH}} {{OUTPUT_PATH}}", { EVIDENCE_PATH: "/tmp/a.json", OUTPUT_PATH: "/tmp/a.md" }),
    "/tmp/a.json /tmp/a.md",
  );
  assert.throws(() => renderPrompt("{{MISSING}}", {}), /unresolved prompt placeholders/);
});

test("quarter index sorts by rank and links each generated fund report", () => {
  const markdown = renderFundIndexMarkdown({
    asOf: "2026-07-23",
    reportDate: "2026-06-30",
    quarter: "2026Q2",
    funds: [
      { rank: 5, code: "000002", name: "乙基金A", shareClass: "A", threeMonthReturnPct: 80, oneMonthReturnPct: 10, sixMonthReturnPct: 90, navDate: "2026-07-22", reportPublishDate: "2026-07-21", outputFilename: "乙基金A-000002-2026Q2.md" },
      { rank: 1, code: "000001", name: "甲基金A", shareClass: "A", threeMonthReturnPct: 100, oneMonthReturnPct: 20, sixMonthReturnPct: 120, navDate: "2026-07-22", reportPublishDate: "2026-07-20", outputFilename: "甲基金A-000001-2026Q2.md" },
    ],
  });
  assert.ok(markdown.indexOf("| 1 | 100.00%") < markdown.indexOf("| 5 | 80.00%"));
  assert.match(markdown, new RegExp(encodeURI("甲基金A-000001-2026Q2.md")));
  assert.match(markdown, /已生成报告：2 只/);
});

test("holding statistics aggregate fund counts, performance, and report forecasts", () => {
  const holdings = aggregateCurrentFundHoldings([
    { fund: { code: "F1", name: "甲基金", rank: 1 }, positions: { current: [
      { code: "600001.SH", name: "甲公司", weightPct: 8 },
      { code: "600002.SH", name: "乙公司", weightPct: 4 },
    ] } },
    { fund: { code: "F2", name: "乙基金", rank: 2 }, positions: { current: [
      { code: "600001.SH", name: "甲公司", weightPct: 6 },
    ] } },
  ]);
  assert.equal(holdings[0].code, "600001.SH");
  assert.equal(holdings[0].fundCount, 2);
  assert.equal(holdings[0].totalWeightPct, 14);
  assert.equal(holdings[0].averageWeightPct, 7);

  const ts = (date) => Date.parse(`${date}T00:00:00Z`);
  const market = buildHoldingMarketSnapshot([
    [ts("2026-06-23"), 10],
    [ts("2026-07-23"), 12],
  ], "2026-07-24", [{ key: "oneMonth", label: "近1月", startDate: "2026-06-24" }]);
  assert.equal(market.price, 12);
  assert.equal(market.performance.oneMonth, 20);

  const forecasts = aggregateReportForecasts([
    { infoCode: "R1", forecasts: [
      { year: 2026, revenue: 100, netProfit: 10, eps: 1 },
      { year: 2027, revenue: 120, netProfit: 15, eps: 1.5 },
    ] },
    { infoCode: "R2", forecasts: [
      { year: 2026, revenue: 110, netProfit: 12, eps: 1.2 },
      { year: 2027, revenue: 132, netProfit: 18, eps: 1.8 },
    ] },
  ], { years: [2026, 2027, 2028], currentPrice: 20, marketCapYi: 240 });
  assert.equal(forecasts[0].revenueYi, 105);
  assert.equal(forecasts[0].netProfitYi, 11);
  assert.equal(forecasts[0].sampleCount, 2);
  assert.equal(forecasts[1].revenueGrowthPct, 20);
  assert.equal(forecasts[1].netProfitGrowthPct, 50);
  assert.equal(forecasts[1].pe, 14.55);

  const html = renderFundHoldingsStatisticsHtml({
    asOf: "2026-07-24",
    reportDate: "2026-06-30",
    quarter: "2026Q2",
    fundsAnalyzed: 2,
    holdings: [{ ...holdings[0], market, forecasts }],
    periods: [{ key: "oneMonth", label: "近1月" }],
    forecastYears: [2026, 2027, 2028],
    baseUrl: "http://127.0.0.1:8000",
  });
  assert.match(html, /<!doctype html>/);
  assert.match(html, /data-type="number"/);
  assert.match(html, /position: sticky/);
  assert.match(html, /company\.html\?code=600001\.SH/);
  assert.doesNotMatch(html, /api\/company\/reports\?code=/);
  assert.match(html, /2026E营收/);
  assert.match(html, /2027E PE/);
  assert.match(html, /126\.00<small>n=2<\/small>/);
  assert.match(html, /14\.55/);
  assert.doesNotMatch(html, /主要持有基金/);
});
