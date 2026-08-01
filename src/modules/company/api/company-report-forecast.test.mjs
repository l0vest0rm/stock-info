import assert from "node:assert/strict";
import test from "node:test";

import { extractForecastsByPattern, normalizeReportTitleCore } from "./company.routes.ts";

test("extracts annual metrics when PDF conversion puts revenue values in the header", () => {
  const forecasts = extractForecastsByPattern(`
| |指标<br>营业收入(百万元)|**2024A**<br>5,442|**2025A**<br>5,901|**2026E**<br>6,582|**2027E**<br>7,392|**2028E**<br>8,499|
|---|---|---|---|---|---|---|
| |YOY(%)|12.4|8.4|11.5|12.3|15.0|
| |归母净利润(百万元)|504|567|774|945|1,141|
| |YOY(%)|-10.5|12.4|36.6|22.1|20.7|
| |EPS(摊薄/元)|0.64|0.72|0.98|1.20|1.45|
| |P/E(倍)|45.1|40.1|29.3|24.0|19.9|
`);

  assert.deepEqual(forecasts, [
    { year: 2026, revenue: 65.82, revenueGrowth: 11.5, netProfit: 7.74, profitGrowth: 36.6, eps: 0.98, pe: 29.3 },
    { year: 2027, revenue: 73.92, revenueGrowth: 12.3, netProfit: 9.45, profitGrowth: 22.1, eps: 1.2, pe: 24 },
    { year: 2028, revenue: 84.99, revenueGrowth: 15, netProfit: 11.41, profitGrowth: 20.7, eps: 1.45, pe: 19.9 },
  ]);
});

test("extracts sentence forecasts despite PDF-inserted whitespace in 归母净利润", () => {
  assert.deepEqual(extractForecastsByPattern(
    "我们预计 2026-2028 年归母 净利润为 7.74/9.45/11.41 亿元。",
  ), [
    { year: 2026, netProfit: 7.74 },
    { year: 2027, netProfit: 9.45 },
    { year: 2028, netProfit: 11.41 },
  ]);
});

test("extracts standard forecast tables with separate annual columns and 万元 units", () => {
  assert.deepEqual(extractForecastsByPattern(`
| 财务指标 | 2025A | 2026E | 2027E | 2028E |
| --- | --- | --- | --- | --- |
| 营业总收入(万元) | 590100 | 658200 | 739200 | 849900 |
| 同比增长率(%) | 8.4 | 11.5 | 12.3 | 15.0 |
| 归属于母公司股东的净利润(万元) | 56700 | 77400 | 94500 | 114100 |
| 同比(%) | 12.4 | 36.6 | 22.1 | 20.7 |
| 基本每股收益(元) | 0.72 | 0.98 | 1.20 | 1.45 |
| 市盈率 | 40.1 | 29.3 | 24.0 | 19.9 |
`), [
    { year: 2026, revenue: 65.82, revenueGrowth: 11.5, netProfit: 7.74, profitGrowth: 36.6, eps: 0.98, pe: 29.3 },
    { year: 2027, revenue: 73.92, revenueGrowth: 12.3, netProfit: 9.45, profitGrowth: 22.1, eps: 1.2, pe: 24 },
    { year: 2028, revenue: 84.99, revenueGrowth: 15, netProfit: 11.41, profitGrowth: 20.7, eps: 1.45, pe: 19.9 },
  ]);
});

test("prefers the most complete annual forecast table when a report has multiple tables", () => {
  assert.deepEqual(extractForecastsByPattern(`
| 指标 | 2026E | 2027E |
| --- | --- | --- |
| EPS(元) | 0.98 | 1.20 |

| 指标 | 2026E | 2027E |
| --- | --- | --- |
| 营业收入(百万元) | 6582 | 7392 |
| 归母净利润(百万元) | 774 | 945 |
| EPS(元) | 0.98 | 1.20 |
| P/E | 29.3 | 24.0 |
`), [
    { year: 2026, revenue: 65.82, netProfit: 7.74, eps: 0.98, pe: 29.3 },
    { year: 2027, revenue: 73.92, netProfit: 9.45, eps: 1.2, pe: 24 },
  ]);
});

test("extracts annual net profit, EPS, and PE from prose with Markdown formatting", () => {
  assert.deepEqual(extractForecastsByPattern(
    "预计公司 `2026-2028` 年分别实现净利润 `189.8` 亿元、`214.6` 亿元、`239.5` 亿元，EPS 分别为 `2.1` 元、`2.3` 元、`2.6` 元，当前股价对应动态 PE 分别为 `17X`、`15X`、`13X`。",
  ), [
    { year: 2026, netProfit: 189.8, eps: 2.1, pe: 17 },
    { year: 2027, netProfit: 214.6, eps: 2.3, pe: 15 },
    { year: 2028, netProfit: 239.5, eps: 2.6, pe: 13 },
  ]);
});

test("extracts two-year revenue, net-profit, and EPS forecasts from prose", () => {
  assert.deepEqual(extractForecastsByPattern(
    "我们预测兆易创新2026/27 年总营收和毛利率分别为255.6/339.8 亿元和65.3%/65.8%；预测归母净利润和基本EPS 分别为139.7/165.8 亿元和21.02/24.95 元。",
  ), [
    { year: 2026, revenue: 255.6, netProfit: 139.7, eps: 21.02 },
    { year: 2027, revenue: 339.8, netProfit: 165.8, eps: 24.95 },
  ]);
});

test("extracts revenue forecasts from an Eastmoney PDF financial-statement table", () => {
  assert.deepEqual(extractForecastsByPattern(
    "附一：合并损益表 百万元 2024 2025F 2026F 2027F 2028F 营业收入 1174 6497 17075 35795 63213 经营成本 508 2914 7513 16537 30532",
  ), [
    { year: 2025, revenue: 64.97 },
    { year: 2026, revenue: 170.75 },
    { year: 2027, revenue: 357.95 },
    { year: 2028, revenue: 632.13 },
  ]);
});

test("extracts three-year revenue and revenue growth forecasts from prose", () => {
  assert.deepEqual(extractForecastsByPattern(
    "投资建议：我们预计公司2026 年-2028 年营业收入为165.38 亿元、284.32 亿元、434.91 亿元，分别同比增长154.5%、71.9%、53.0%。",
  ), [
    { year: 2026, revenue: 165.38, revenueGrowth: 154.5 },
    { year: 2027, revenue: 284.32, revenueGrowth: 71.9 },
    { year: 2028, revenue: 434.91, revenueGrowth: 53 },
  ]);
});

test("preserves a report title's own colon while removing only a company-code prefix", () => {
  const eastmoneyTitle = "产能替代窗口开启：大厂淡出与长鑫赋能共振";
  const sinaTitle = "兆易创新(603986)：产能替代窗口开启：大厂淡出与长鑫赋能共振";
  assert.equal(normalizeReportTitleCore(eastmoneyTitle), normalizeReportTitleCore(sinaTitle));
});
