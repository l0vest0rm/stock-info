import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  aggregateEarningsEvents,
  analyzeCandidate,
  attachMarketsAndFilter,
  previousQuarterEndDate,
  rankAnalyzedCandidates,
  renderPrompt,
} from "./earnings-research.mjs";

const fixtureDir = resolve("scripts/fixtures/earnings-research");
const fixture = JSON.parse(readFileSync(join(fixtureDir, "fixture.json"), "utf8"));
const ranking = JSON.parse(readFileSync(resolve("config/earnings-research.json"), "utf8")).ranking;

test("latest completed quarter uses the prior quarter end", () => {
  assert.equal(previousQuarterEndDate("2026-07-15"), "2026-06-30");
  assert.equal(previousQuarterEndDate("2026-01-05"), "2025-12-31");
});

test("event aggregation excludes future notices and preserves forecast ranges", () => {
  const events = aggregateEarningsEvents(fixture.performanceRows, fixture.forecastRows, {
    asOf: "2026-07-15",
    fromDate: "2026-06-16",
    reportDate: "2026-06-30",
  });
  assert.deepEqual(events.map((event) => event.code).sort(), ["600001.SH", "600002.SH"]);
  const forecast = events.find((event) => event.code === "600001.SH");
  assert.equal(forecast.profit.lowYuan, 100000000);
  assert.equal(forecast.profit.highYuan, 120000000);
  assert.equal(forecast.deductProfit.lowYuan, 90000000);
});

test("analysis splits cumulative profit into a quarter and keeps PE units consistent", () => {
  const events = aggregateEarningsEvents(fixture.performanceRows, fixture.forecastRows, {
    asOf: "2026-07-15",
    fromDate: "2026-06-16",
    reportDate: "2026-06-30",
  });
  const candidates = attachMarketsAndFilter(events, fixture.marketRows, {
    minMarketCapYi: 1,
    maxMarketCapYi: 1000,
    excludeNamePatterns: [],
  });
  const candidate = candidates.find((item) => item.code === "600001.SH");
  const analyzed = analyzeCandidate(candidate, {
    income: fixture.statements.income[candidate.code],
    balance: fixture.statements.balance[candidate.code],
    cashflow: fixture.statements.cashflow[candidate.code],
  }, { asOf: "2026-07-15", forecastYear: 2026, ranking });
  assert.equal(analyzed.trends.singleQuarterProfitYi, 0.7);
  assert.equal(analyzed.trends.singleQuarterYoY, 55.56);
  assert.equal(analyzed.trends.singleQuarterQoQ, 75);
  assert.equal(analyzed.projection.profitYi.base, 2.2);
  assert.ok(analyzed.projection.pe.base > 14.4 && analyzed.projection.pe.base < 14.7);
  assert.ok(analyzed.trends.effectiveGrowth > 60);
  assert.ok(analyzed.projection.pegLike < 0.3);
  assert.equal(analyzed.quality.debtToAssets, 35);
});

test("missing previous quarter leaves single-quarter comparisons empty", () => {
  const events = aggregateEarningsEvents(fixture.performanceRows, fixture.forecastRows, {
    asOf: "2026-07-15",
    fromDate: "2026-06-16",
    reportDate: "2026-06-30",
  });
  const candidate = attachMarketsAndFilter(events, fixture.marketRows, {
    minMarketCapYi: 1,
    maxMarketCapYi: 1000,
    excludeNamePatterns: [],
  }).find((item) => item.code === "600001.SH");
  const analyzed = analyzeCandidate(candidate, { income: [], balance: [], cashflow: [] }, {
    asOf: "2026-07-15",
    forecastYear: 2026,
    ranking,
  });
  assert.equal(analyzed.trends.singleQuarterProfitYi, null);
  assert.equal(analyzed.trends.singleQuarterYoY, null);
  assert.match(analyzed.warnings.join(" "), /单季增速不可计算/);
});

test("a negative comparison base does not produce a misleading growth percentage", () => {
  const events = aggregateEarningsEvents(fixture.performanceRows, fixture.forecastRows, {
    asOf: "2026-07-15",
    fromDate: "2026-06-16",
    reportDate: "2026-06-30",
  });
  const candidate = attachMarketsAndFilter(events, fixture.marketRows, {
    minMarketCapYi: 1,
    maxMarketCapYi: 1000,
    excludeNamePatterns: [],
  }).find((item) => item.code === "600001.SH");
  const lowBaseCandidate = { ...candidate, profit: { ...candidate.profit, previousYuan: -10000000 } };
  const analyzed = analyzeCandidate(lowBaseCandidate, {
    income: [
      { reportDate: "2026-03-31", noticeDate: "2026-04-20", parentNetprofit: 40000000 },
      { reportDate: "2025-06-30", noticeDate: "2025-08-20", parentNetprofit: -10000000 },
    ],
    balance: [],
    cashflow: [],
  }, { asOf: "2026-07-15", forecastYear: 2026, ranking });
  assert.equal(analyzed.trends.singleQuarterYoY, null);
  assert.equal(analyzed.trends.cumulativeProfitYoYComparable, false);
  assert.equal(analyzed.trends.effectiveGrowth, 75);
  assert.match(analyzed.warnings.join(" "), /上年同季利润非正/);
  assert.match(analyzed.warnings.join(" "), /同比属于扭亏或低基数/);
});

test("ranking combines forward PE and effective growth instead of raw turnaround YoY", () => {
  const base = {
    noticeDate: "2026-07-15",
    sourceType: "performance_forecast",
    market: { marketCapYi: 100 },
    profit: { lowYuan: 100, highYuan: 100 },
    deductProfit: { lowYuan: 100, highYuan: 100 },
    projection: { pe: { base: 15 }, pegLike: 0.5, confidence: "medium" },
    trends: { singleQuarterProfitYi: 1, effectiveGrowth: 30 },
  };
  const improving = { ...base, code: "A", trends: { ...base.trends, effectiveGrowth: 40 } };
  const slowingTurnaround = { ...base, code: "B", projection: { ...base.projection, pe: { base: 10 }, pegLike: null }, trends: { ...base.trends, effectiveGrowth: -15 } };
  const ranked = rankAnalyzedCandidates([slowingTurnaround, improving], ranking);
  assert.equal(ranked[0].code, "A");
  assert.ok(ranked[0].screening.score > ranked[1].screening.score);
});

test("prompt rendering replaces all run placeholders", () => {
  const prompt = renderPrompt("{{AS_OF}} {{REPORT_DATE}} {{EVIDENCE_PATH}} {{OUTPUT_PATH}} {{EVIDENCE}}", {
    asOf: "2026-07-15",
    reportDate: "2026-06-30",
    evidencePath: "/tmp/evidence.md",
    outputPath: "/tmp/recommendations.md",
    evidence: "facts",
  });
  assert.equal(prompt, "2026-07-15 2026-06-30 /tmp/evidence.md /tmp/recommendations.md facts");
});

test("fixture CLI writes a complete evidence package and no recommendation placeholder", () => {
  const output = mkdtempSync(join(tmpdir(), "earnings-research-test-"));
  try {
    execFileSync(process.execPath, [
      "scripts/earnings-research.mjs",
      "--fixture-dir", fixtureDir,
      "--as-of", "2026-07-15",
      "--days", "30",
      "--limit", "10",
      "--include-consensus",
      "--output", output,
    ], { cwd: resolve("."), stdio: "pipe" });
    const evidence = JSON.parse(readFileSync(join(output, "evidence.json"), "utf8"));
    const markdown = readFileSync(join(output, "evidence.md"), "utf8");
    const prompt = readFileSync(join(output, "prompt.md"), "utf8");
    assert.equal(evidence.stats.futureRowsExcluded, 1);
    assert.equal(evidence.candidates.length, 2);
    assert.ok(evidence.candidates.every((candidate) => candidate.noticeDate <= "2026-07-15"));
    assert.match(markdown, /业绩研究证据包/);
    assert.match(prompt, /最近业绩候选股票分析/);
    assert.throws(() => readFileSync(join(output, "recommendations.md"), "utf8"), /ENOENT/);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
