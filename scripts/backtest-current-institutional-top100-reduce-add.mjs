#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

if (process.argv.slice(2).includes("--help")) {
  console.log(`Usage: node scripts/backtest-current-institutional-top100-reduce-add.mjs [options]

Parameter-grid options (replace the candidate rules from --rules):
  --first-loss-pcts 10,15,20       first reduction thresholds, in percent
  --second-loss-pcts 20,25,30,40   repurchase thresholds, in percent; must exceed the first threshold
  --sell-fractions 35,50,70        percentages of the original holding to sell
  --buy-mode restore               restore (default) or all-cash

Cash-ladder options (use with --strategy cash-ladder):
  --initial-cash-pcts 20,35,50     cash held at entry, in percent of starting capital
  --cash-buy-splits 35/65,50/50    fractions of the initial cash reserve used at the first/second threshold
  --cash-baseline full-stock        compare with starting 100% in the stock; default is static-cash

Other useful options:
  --stock-limit 300 --from 2021-07-31 --to 2026-07-31
  --analysis-cohort triggered          report only windows where the first reduction actually occurred
  --rules config/institutional-top300-reduce-add-grid.json
  --output docs/research/report.md`);
  process.exit(0);
}

const args = parseArgs(process.argv.slice(2));
const baseUrl = args["base-url"] ?? "https://tinfo.cc";
const from = args.from ?? "2023-12-01";
const to = args.to ?? "2026-07-31";
const warmupFrom = dateDaysBefore(from, 180);
const horizon = Number(args["horizon-days"] ?? "252");
const cost = Number(args["one-way-cost-bp"] ?? "15") / 10_000;
const stockLimit = Number(args["stock-limit"] ?? "100");
const minIndustryStocks = Number(args["min-industry-stocks"] ?? "3");
const concurrency = Number(args.concurrency ?? "6");
const analysisCohort = String(args["analysis-cohort"] ?? "all");
const strategy = String(args.strategy ?? "reduce-add");
const cashBaseline = String(args["cash-baseline"] ?? "static-cash");
const output = path.resolve(args.output ?? "docs/research/当前机构持股Top100-逐股减仓加仓回测.md");
const csvOutput = output.replace(/\.md$/i, ".csv");
const stockSummaryOutput = output.replace(/\.md$/i, "-逐股汇总.csv");
const industrySummaryOutput = output.replace(/\.md$/i, "-行业汇总.csv");
const triggeredOutput = output.replace(/\.md$/i, "-触发样本.csv");
const rulesPath = path.resolve(args.rules ?? "config/institutional-top100-reduce-add-rules.json");
const industryGroupsPath = path.resolve(args["industry-groups"] ?? "config/institutional-backtest-industry-groups.json");

if (!Number.isInteger(horizon) || horizon < 20) throw new Error("--horizon-days must be an integer of at least 20");
if (!Number.isFinite(cost) || cost < 0 || cost > 0.01) throw new Error("--one-way-cost-bp must be between 0 and 100");
if (!Number.isInteger(stockLimit) || stockLimit < 1 || stockLimit > 300) throw new Error("--stock-limit must be an integer from 1 to 300");
if (!Number.isInteger(minIndustryStocks) || minIndustryStocks < 1) throw new Error("--min-industry-stocks must be a positive integer");
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 20) throw new Error("--concurrency must be an integer from 1 to 20");
if (!['all', 'triggered'].includes(analysisCohort)) throw new Error("--analysis-cohort must be all or triggered");
if (!['reduce-add', 'cash-ladder'].includes(strategy)) throw new Error("--strategy must be reduce-add or cash-ladder");
if (!['static-cash', 'full-stock'].includes(cashBaseline)) throw new Error("--cash-baseline must be static-cash or full-stock");

const snapshotPath = new URL("../web/src/config/institutional-track-snapshot.json", import.meta.url);
const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
const industryGroups = parseIndustryGroups(JSON.parse(await readFile(industryGroupsPath, "utf8")));
const stocks = snapshot.rows.slice(0, stockLimit).map((row) => ({
  code: row.code,
  name: row.name,
  institutionCount: row.institutionCount,
  industry: String(row.industry || "未分类"),
  industryGroup: industryGroups.get(String(row.industry || "未分类")) ?? String(row.industry || "未分类"),
}));
if (stocks.length !== stockLimit) throw new Error(`current institutional-track snapshot does not contain ${stockLimit} rows`);
const rulesConfig = JSON.parse(await readFile(rulesPath, "utf8"));
const rules = strategy === 'cash-ladder' ? parseCashLadderRules(args) : parseRules(withGridArguments(rulesConfig, args));

const klineResults = await mapConcurrent(stocks, concurrency, async (stock) => ({
  ...stock,
  rows: buildIndicators(await fetchKline(baseUrl, stock.code, warmupFrom, to)),
}));
const marketPoints = new Map(buildIndicators(await fetchKline(baseUrl, "000300.SH", warmupFrom, to)).map((row) => [row.date, row]));
const industryPointsByGroup = buildIndustryPeerIndexes(klineResults);

if (strategy === 'cash-ladder') {
  const cashEpisodes = [];
  for (const stock of klineResults) {
    for (const entryIndex of monthlyEntryIndices(stock.rows, horizon, from)) {
      const window = stock.rows.slice(entryIndex, entryIndex + horizon + 1);
      for (const rule of rules) {
        const baseline = simulateCashHold(window, rule, cost, cashBaseline === 'full-stock' ? 0 : rule.initialCashPct);
        const result = simulateCashLadder(window, rule, cost);
        cashEpisodes.push({
          code: stock.code,
          name: stock.name,
          institutionCount: stock.institutionCount,
          industry: stock.industry,
          industryGroup: stock.industryGroup,
          entryDate: window[0].date,
          exitDate: window.at(-1).date,
          rule: rule.id,
          ruleName: rule.name,
          initialCashPct: rule.initialCashPct,
          firstLossPct: rule.loss1 * 100,
          secondLossPct: rule.loss2 * 100,
          firstCashSpendPct: rule.firstCashSpendPct,
          secondCashSpendPct: rule.secondCashSpendPct,
          returnPct: result.returnPct,
          maxDrawdownPct: result.maxDrawdownPct,
          firstBought: result.firstBought,
          secondBought: result.secondBought,
          baselineReturnPct: baseline.returnPct,
          baselineMaxDrawdownPct: baseline.maxDrawdownPct,
        });
      }
    }
  }
  const cashSummaries = summarizeCashLadder(rules, cashEpisodes);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, renderCashLadderReport({ snapshot, from, to, horizon, cost, stockLimit, cashBaseline, cashSummaries, cashCsvOutput: csvOutput }), 'utf8');
  await writeFile(csvOutput, renderCashLadderCsv(cashEpisodes), 'utf8');
  console.log(JSON.stringify({ output, csvOutput, stocks: stocks.length, episodes: cashEpisodes.length / rules.length, rules: rules.length, strategy }, null, 2));
} else {
const episodes = [];
for (const stock of klineResults) {
  for (const entryIndex of monthlyEntryIndices(stock.rows, horizon, from)) {
    const window = stock.rows.slice(entryIndex, entryIndex + horizon + 1);
    const context = { marketPoints, industryPoints: industryPointsByGroup.get(stock.industryGroup) };
    const baseline = simulate(window, rules[0], cost, context);
    for (const rule of rules) {
      const result = rule.id === "hold" ? baseline : simulate(window, rule, cost, context);
      episodes.push({
        code: stock.code,
        name: stock.name,
        institutionCount: stock.institutionCount,
        industry: stock.industry,
        industryGroup: stock.industryGroup,
        entryDate: window[0].date,
        exitDate: window.at(-1).date,
        rule: rule.id,
        ruleName: rule.name,
        returnPct: result.returnPct,
        maxDrawdownPct: result.maxDrawdownPct,
        reduced: result.reduced,
        added: result.added,
        baselineReturnPct: baseline.returnPct,
        baselineMaxDrawdownPct: baseline.maxDrawdownPct,
      });
    }
  }
}

const stockSummaries = summarizeStocks(stocks, rules, episodes);
const validStockCount = new Set(episodes.map((row) => row.code)).size;
const stockMedianSummaries = summarizeStockMedians(rules, stockSummaries);
const industrySummaries = summarizeIndustries(rules, stockSummaries, minIndustryStocks);
const industryMedianSummaries = summarizeIndustryMedians(rules, industrySummaries);
const triggeredCohortSummaries = summarizeTriggeredCohort(rules, episodes);
await mkdir(path.dirname(output), { recursive: true });
const report = analysisCohort === 'triggered' ? renderTriggeredCohortReport({
  snapshot,
  from,
  to,
  horizon,
  cost,
  stockLimit,
  validStockCount,
  triggeredCohortSummaries,
  triggeredOutput,
}) : renderMedianReport({
  snapshot,
  from,
  to,
  horizon,
  cost,
  stockLimit,
  validStockCount,
  stocks: klineResults,
  stockMedianSummaries,
  minIndustryStocks,
  industryGroupsPath,
  industrySummaries,
  industryMedianSummaries,
});
await writeFile(output, report, "utf8");
await writeFile(csvOutput, renderCsv(episodes), "utf8");
await writeFile(stockSummaryOutput, renderStockSummaryCsv(stockSummaries), "utf8");
await writeFile(industrySummaryOutput, renderIndustrySummaryCsv(industrySummaries), "utf8");
await writeFile(triggeredOutput, renderTriggeredCsv(episodes), "utf8");
console.log(JSON.stringify({ output, csvOutput, stockSummaryOutput, industrySummaryOutput, triggeredOutput, stocks: stocks.length, episodes: episodes.length / rules.length, rules: rules.length }, null, 2));
}

function monthlyEntryIndices(rows, days, firstDate) {
  const result = [];
  const months = new Set();
  for (let index = 0; index + days < rows.length; index += 1) {
    if (rows[index].date < firstDate) continue;
    const month = rows[index].date.slice(0, 7);
    if (months.has(month)) continue;
    months.add(month);
    result.push(index);
  }
  return result;
}

function simulate(rows, rule, oneWayCost, context) {
  if (rule.kind === "trend") return simulateTrend(rows, rule, oneWayCost, context);
  const entryPrice = rows[0].close;
  let cash = 0;
  let shares = 1 / entryPrice / (1 + oneWayCost);
  const originalShares = shares;
  let reduced = false;
  let added = false;
  let peak = cash + shares * entryPrice;
  let maxDrawdown = 0;

  for (let index = 1; index < rows.length; index += 1) {
    const price = rows[index].close;
    const priorClose = rows[index - 1].close;
    if (rule.loss1 !== null && !reduced && priorClose <= entryPrice * (1 - rule.loss1) && confirmationMatches(rule.confirm, rows[index - 1].date, context)) {
      const quantity = shares * rule.sellFraction;
      cash += quantity * price * (1 - oneWayCost);
      shares -= quantity;
      reduced = true;
    } else if (reduced && !added && priorClose <= entryPrice * (1 - rule.loss2)) {
      const desired = rule.buyMode === "restore" ? Math.max(0, originalShares - shares) : Infinity;
      const affordable = cash / price / (1 + oneWayCost);
      const quantity = Math.min(desired, affordable);
      cash -= quantity * price * (1 + oneWayCost);
      shares += quantity;
      added = quantity > 0;
    }
    const nav = cash + shares * price;
    peak = Math.max(peak, nav);
    maxDrawdown = Math.min(maxDrawdown, nav / peak - 1);
  }
  const finalPrice = rows.at(-1).close;
  const finalNav = cash + shares * finalPrice * (1 - oneWayCost);
  peak = Math.max(peak, finalNav);
  maxDrawdown = Math.min(maxDrawdown, finalNav / peak - 1);
  return { returnPct: (finalNav - 1) * 100, maxDrawdownPct: maxDrawdown * 100, reduced, added };
}

function simulateCashHold(rows, rule, oneWayCost, initialCashPct = rule.initialCashPct) {
  const entryPrice = rows[0].close;
  const cash = initialCashPct / 100;
  const shares = (1 - cash) / entryPrice / (1 + oneWayCost);
  let peak = cash + shares * entryPrice;
  let maxDrawdown = 0;
  for (let index = 1; index < rows.length; index += 1) {
    const nav = cash + shares * rows[index].close;
    peak = Math.max(peak, nav);
    maxDrawdown = Math.min(maxDrawdown, nav / peak - 1);
  }
  const finalNav = cash + shares * rows.at(-1).close * (1 - oneWayCost);
  peak = Math.max(peak, finalNav);
  maxDrawdown = Math.min(maxDrawdown, finalNav / peak - 1);
  return { returnPct: (finalNav - 1) * 100, maxDrawdownPct: maxDrawdown * 100 };
}

function simulateCashLadder(rows, rule, oneWayCost) {
  const entryPrice = rows[0].close;
  const initialCash = rule.initialCashPct / 100;
  let cash = initialCash;
  let shares = (1 - cash) / entryPrice / (1 + oneWayCost);
  let firstBought = false;
  let secondBought = false;
  let peak = cash + shares * entryPrice;
  let maxDrawdown = 0;
  for (let index = 1; index < rows.length; index += 1) {
    const price = rows[index].close;
    const priorClose = rows[index - 1].close;
    if (!firstBought && priorClose <= entryPrice * (1 - rule.loss1)) {
      const plannedCash = initialCash * rule.firstCashSpendPct / 100;
      const amount = Math.min(cash, plannedCash);
      const quantity = amount / price / (1 + oneWayCost);
      cash -= quantity * price * (1 + oneWayCost);
      shares += quantity;
      firstBought = quantity > 0;
    } else if (firstBought && !secondBought && priorClose <= entryPrice * (1 - rule.loss2)) {
      const plannedCash = initialCash * rule.secondCashSpendPct / 100;
      const amount = Math.min(cash, plannedCash);
      const quantity = amount / price / (1 + oneWayCost);
      cash -= quantity * price * (1 + oneWayCost);
      shares += quantity;
      secondBought = quantity > 0;
    }
    const nav = cash + shares * price;
    peak = Math.max(peak, nav);
    maxDrawdown = Math.min(maxDrawdown, nav / peak - 1);
  }
  const finalNav = cash + shares * rows.at(-1).close * (1 - oneWayCost);
  peak = Math.max(peak, finalNav);
  maxDrawdown = Math.min(maxDrawdown, finalNav / peak - 1);
  return { returnPct: (finalNav - 1) * 100, maxDrawdownPct: maxDrawdown * 100, firstBought, secondBought };
}

function simulateTrend(rows, rule, oneWayCost, context) {
  const entryPrice = rows[0].close;
  let cash = 0;
  let shares = 1 / entryPrice / (1 + oneWayCost);
  const originalShares = shares;
  let reduced = false;
  let added = false;
  let currentlyReduced = false;
  let peak = shares * entryPrice;
  let maxDrawdown = 0;

  for (let index = 1; index < rows.length; index += 1) {
    const price = rows[index].close;
    const invested = trendInvested(rule.signal, rows[index - 1]);
    if (invested === false && !currentlyReduced && confirmationMatches(rule.confirm, rows[index - 1].date, context)) {
      const quantity = shares * rule.sellFraction;
      cash += quantity * price * (1 - oneWayCost);
      shares -= quantity;
      currentlyReduced = true;
      reduced = true;
    } else if (invested === true && currentlyReduced) {
      const desired = Math.max(0, originalShares - shares);
      const quantity = Math.min(desired, cash / price / (1 + oneWayCost));
      cash -= quantity * price * (1 + oneWayCost);
      shares += quantity;
      currentlyReduced = false;
      added = added || quantity > 0;
    }
    const nav = cash + shares * price;
    peak = Math.max(peak, nav);
    maxDrawdown = Math.min(maxDrawdown, nav / peak - 1);
  }
  const finalPrice = rows.at(-1).close;
  const finalNav = cash + shares * finalPrice * (1 - oneWayCost);
  peak = Math.max(peak, finalNav);
  maxDrawdown = Math.min(maxDrawdown, finalNav / peak - 1);
  return { returnPct: (finalNav - 1) * 100, maxDrawdownPct: maxDrawdown * 100, reduced, added };
}

function trendInvested(signal, row) {
  if (!Number.isFinite(row.ma20) || !Number.isFinite(row.ma60) || !Number.isFinite(row.high60)) return null;
  const movingAverage = /^ma(5|10|20|30|60|120)$/.exec(signal);
  if (movingAverage) return row.close >= row[`ma${movingAverage[1]}`];
  if (signal === "ma5-ma20-cross") return row.ma5 >= row.ma20;
  if (signal === "ma10-ma20-cross") return row.ma10 >= row.ma20;
  if (signal === "ma20-ma60-cross") return row.ma20 >= row.ma60;
  const dualMa = row.close >= row.ma60 && row.ma20 >= row.ma60;
  if (signal === "dual-ma") return dualMa;
  if (signal === "dd15-dual-ma") return dualMa && row.close / row.high60 > 0.85;
  throw new Error(`unsupported trend signal: ${signal}`);
}

function confirmationMatches(confirm, date, context) {
  if (confirm === "none") return true;
  const marketDown = isDownTrend(context.marketPoints?.get(date));
  const industryDown = isDownTrend(context.industryPoints?.get(date));
  if (confirm === "market") return marketDown;
  if (confirm === "industry") return industryDown;
  if (confirm === "both") return marketDown && industryDown;
  throw new Error(`unsupported confirmation: ${confirm}`);
}

function isDownTrend(point) {
  return Boolean(point && Number.isFinite(point.ma20) && Number.isFinite(point.ma60) && point.close < point.ma60 && point.ma20 < point.ma60);
}

function summarize(rule, rows) {
  const returnValues = rows.map((row) => row.returnPct);
  const drawdownValues = rows.map((row) => row.maxDrawdownPct);
  const reduced = rows.filter((row) => row.reduced).length;
  const added = rows.filter((row) => row.added).length;
  const compared = rows.filter((row) => row.rule !== "hold");
  const betterReturn = compared.filter((row) => row.returnPct > row.baselineReturnPct).length;
  const betterDrawdown = compared.filter((row) => row.maxDrawdownPct > row.baselineMaxDrawdownPct).length;
  const betterBoth = compared.filter((row) => row.returnPct > row.baselineReturnPct && row.maxDrawdownPct > row.baselineMaxDrawdownPct).length;
  return {
    ...rule,
    count: rows.length,
    medianReturnPct: median(returnValues),
    medianDrawdownPct: median(drawdownValues),
    p10DrawdownPct: percentile(drawdownValues, 0.10),
    reducedRate: reduced / rows.length,
    addedRate: added / rows.length,
    betterReturnRate: compared.length ? betterReturn / compared.length : null,
    betterDrawdownRate: compared.length ? betterDrawdown / compared.length : null,
    betterBothRate: compared.length ? betterBoth / compared.length : null,
  };
}

function summarizeStocks(stocks, rules, episodes) {
  const byStock = new Map(stocks.map((stock) => [stock.code, {
    code: stock.code,
    name: stock.name,
    institutionCount: stock.institutionCount,
    industry: stock.industry,
    industryGroup: stock.industryGroup,
    rules: new Map(),
  }]));
  for (const episode of episodes) {
    const stock = byStock.get(episode.code);
    if (!stock) continue;
    const rows = stock.rules.get(episode.rule) ?? [];
    rows.push(episode);
    stock.rules.set(episode.rule, rows);
  }
  return [...byStock.values()].flatMap((stock) => {
    const baseline = stock.rules.get("hold") ?? [];
    const baselineReturnPct = median(baseline.map((row) => row.returnPct));
    const baselineDrawdownPct = median(baseline.map((row) => row.maxDrawdownPct));
    return rules.map((rule) => {
      const summary = summarize(rule, stock.rules.get(rule.id) ?? []);
      const hasSamples = summary.count > 0;
      const returnDeltaPct = rule.id === "hold" ? 0 : median((stock.rules.get(rule.id) ?? []).map((row) => row.returnPct - row.baselineReturnPct));
      const drawdownDeltaPct = rule.id === "hold" ? 0 : median((stock.rules.get(rule.id) ?? []).map((row) => row.maxDrawdownPct - row.baselineMaxDrawdownPct));
      return {
        code: stock.code,
        name: stock.name,
        institutionCount: stock.institutionCount,
        industry: stock.industry,
        industryGroup: stock.industryGroup,
        dataStatus: hasSamples ? "ok" : "insufficient_history",
        rule: rule.id,
        ruleName: rule.name,
        count: summary.count,
        medianReturnPct: hasSamples ? summary.medianReturnPct : null,
        medianDrawdownPct: hasSamples ? summary.medianDrawdownPct : null,
        reducedRate: hasSamples ? summary.reducedRate : null,
        addedRate: hasSamples ? summary.addedRate : null,
        betterBothRate: hasSamples ? summary.betterBothRate : null,
        baselineReturnPct: hasSamples ? baselineReturnPct : null,
        baselineDrawdownPct: hasSamples ? baselineDrawdownPct : null,
        // Compare matching entry windows first, then take the stock median.  This
        // preserves the requested "each stock gets one vote" comparison instead
        // of subtracting two independently ranked medians.
        returnDeltaPct: hasSamples ? returnDeltaPct : null,
        drawdownDeltaPct: hasSamples ? drawdownDeltaPct : null,
      };
    });
  });
}

function summarizeStockMedians(rules, stockSummaries) {
  return rules.map((rule) => {
    const rows = stockSummaries.filter((row) => row.rule === rule.id && row.dataStatus === "ok");
    return {
      ...rule,
      stockCount: rows.length,
      medianReturnPct: median(rows.map((row) => row.medianReturnPct)),
      medianDrawdownPct: median(rows.map((row) => row.medianDrawdownPct)),
      medianReturnDeltaPct: median(rows.map((row) => row.returnDeltaPct)),
      medianDrawdownDeltaPct: median(rows.map((row) => row.drawdownDeltaPct)),
      medianBetterBothRate: medianFinite(rows.map((row) => row.betterBothRate)),
    };
  });
}

function summarizeIndustries(rules, stockSummaries, minStockCount) {
  const industryNames = [...new Set(stockSummaries.map((row) => row.industryGroup))].sort();
  return industryNames.flatMap((industry) => rules.map((rule) => {
    const rows = stockSummaries.filter((row) => row.industryGroup === industry && row.rule === rule.id && row.dataStatus === "ok");
    const stockCount = new Set(stockSummaries.filter((row) => row.industryGroup === industry).map((row) => row.code)).size;
    const validStockCount = rows.length;
    return {
      industry,
      stockCount,
      validStockCount,
      includedInIndustryMedian: validStockCount >= minStockCount,
      dataStatus: validStockCount ? "ok" : "insufficient_history",
      ...rule,
      medianReturnPct: validStockCount ? median(rows.map((row) => row.medianReturnPct)) : null,
      medianDrawdownPct: validStockCount ? median(rows.map((row) => row.medianDrawdownPct)) : null,
      medianReturnDeltaPct: validStockCount ? median(rows.map((row) => row.returnDeltaPct)) : null,
      medianDrawdownDeltaPct: validStockCount ? median(rows.map((row) => row.drawdownDeltaPct)) : null,
      medianBetterBothRate: validStockCount ? medianFinite(rows.map((row) => row.betterBothRate)) : null,
    };
  }));
}

function summarizeIndustryMedians(rules, industrySummaries) {
  return rules.map((rule) => {
    const rows = industrySummaries.filter((row) => row.id === rule.id && row.includedInIndustryMedian && row.dataStatus === "ok");
    return {
      ...rule,
      industryCount: rows.length,
      medianReturnPct: median(rows.map((row) => row.medianReturnPct)),
      medianDrawdownPct: median(rows.map((row) => row.medianDrawdownPct)),
      medianReturnDeltaPct: median(rows.map((row) => row.medianReturnDeltaPct)),
      medianDrawdownDeltaPct: median(rows.map((row) => row.medianDrawdownDeltaPct)),
      medianBetterBothRate: medianFinite(rows.map((row) => row.medianBetterBothRate)),
    };
  });
}

function summarizeTriggeredCohort(rules, episodes) {
  return rules.filter((rule) => rule.id !== "hold").map((rule) => {
    const rows = episodes.filter((row) => row.rule === rule.id && row.reduced);
    const total = rows.length;
    const betterReturn = rows.filter((row) => row.returnPct > row.baselineReturnPct).length;
    const betterDrawdown = rows.filter((row) => row.maxDrawdownPct > row.baselineMaxDrawdownPct).length;
    const betterBoth = rows.filter((row) => row.returnPct > row.baselineReturnPct && row.maxDrawdownPct > row.baselineMaxDrawdownPct).length;
    return {
      ...rule,
      triggeringEpisodes: total,
      triggeredStockCount: new Set(rows.map((row) => row.code)).size,
      repurchasedEpisodes: rows.filter((row) => row.added).length,
      betterReturn,
      betterDrawdown,
      betterBoth,
      betterReturnRate: total ? betterReturn / total : null,
      betterDrawdownRate: total ? betterDrawdown / total : null,
      betterBothRate: total ? betterBoth / total : null,
    };
  });
}

function renderTriggeredCohortReport({ snapshot, from, to, horizon, cost, stockLimit, validStockCount, triggeredCohortSummaries, triggeredOutput }) {
  const candidates = triggeredCohortSummaries.filter((row) => row.triggeringEpisodes > 0);
  const bestBoth = [...candidates].sort((a, b) => b.betterBothRate - a.betterBothRate || b.betterDrawdownRate - a.betterDrawdownRate || b.triggeringEpisodes - a.triggeringEpisodes)[0];
  return `# 当前机构持股 Top${stockLimit}：实际触发减仓样本回测

> 生成日期：${new Date().toISOString().slice(0, 10)}；Top${stockLimit}快照日期：${snapshot.dataDate}；行情范围：${from} 至 ${to}；单笔持有窗口：${horizon} 个交易日。

## 统计口径

- **仅统计实际发生第一档减仓的样本。**一笔样本只有在持有窗口内真的跌到第一档、并按规则在下一交易日收盘减仓，才进入本报告；没有触发的股票或窗口完全不计入分母。
- 每个触发样本都与相同入场日、相同持有窗口的死扛基准比较。报告给出的是触发样本的**计数与比例**，不计算平均收益、平均回撤或中位数收益、回撤。
- “收益更高”“回撤更低”均为严格优于死扛；“双优”要求两者同时严格优于。买回比例表示已经触发减仓的样本中，后来又跌到第二档并执行该规则规定买入动作的占比。
- 减仓信号使用前一日收盘，在下一交易日收盘成交；每笔买卖扣 ${Math.round(cost * 10_000)}bp 单边摩擦。当前Top${stockLimit}回看历史仍存在幸存者偏差。

## 实际触发样本的比较

${bestBoth ? `双优比例最高的是 \`${bestBoth.name}\`（${formatPct(bestBoth.betterBothRate * 100, false)}，${bestBoth.triggeringEpisodes} 笔实际触发样本）；它仍只描述这个条件样本，不能直接推断为无条件策略优势。` : "没有任何规则形成实际触发样本。"}

| 规则 | 触发样本 | 涉及股票 | 后续补回 | 收益更高 | 回撤更低 | 收益与回撤双优 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
${triggeredCohortSummaries.map((row) => `| ${row.name} | ${row.triggeringEpisodes} | ${row.triggeredStockCount} | ${row.triggeringEpisodes ? formatPct(row.repurchasedEpisodes / row.triggeringEpisodes * 100, false) : "—"} | ${row.betterReturnRate === null ? "—" : formatPct(row.betterReturnRate * 100, false)} | ${row.betterDrawdownRate === null ? "—" : formatPct(row.betterDrawdownRate * 100, false)} | ${row.betterBothRate === null ? "—" : formatPct(row.betterBothRate * 100, false)} |`).join("\n")}

## 执行与限制

1. 本报告回答的是“跌到第一档之后，减仓/补回相对死扛怎么样”，而不是策略在所有持有期中的无条件表现；两种口径必须分开看。
2. 第二档的买入方式由规则名称明确标示：“买回卖出股数”最多恢复至初始股数；“用全部留存现金买入”则投入第一次减仓后的全部现金，可能恢复到超过初始股数，但不融资。未跌到第二档的样本继续持有减仓后的现金。
3. 触发明细见 \`${path.basename(triggeredOutput)}\`；其中不含从未触发减仓的样本。可完成一年窗口的股票为 ${validStockCount}/${stockLimit}。
`;
}

function renderMedianReport({ snapshot, from, to, horizon, cost, stockLimit, validStockCount, stocks, stockMedianSummaries, minIndustryStocks, industryGroupsPath, industrySummaries, industryMedianSummaries }) {
  const candidates = stockMedianSummaries.filter((row) => row.id !== "hold");
  const bestDrawdown = [...candidates].sort((a, b) => b.medianDrawdownDeltaPct - a.medianDrawdownDeltaPct || b.medianReturnDeltaPct - a.medianReturnDeltaPct)[0];
  const dominant = candidates.filter((row) => row.medianReturnDeltaPct > 0 && row.medianDrawdownDeltaPct > 0);
  const industryCandidates = industryMedianSummaries.filter((row) => row.id !== "hold");
  const industryBestDrawdown = [...industryCandidates].sort((a, b) => b.medianDrawdownDeltaPct - a.medianDrawdownDeltaPct || b.medianReturnDeltaPct - a.medianReturnDeltaPct)[0];
  const industryRows = industrySummaries.filter((row) => row.id !== "hold" && row.includedInIndustryMedian && row.dataStatus === "ok")
    .sort((a, b) => a.industry.localeCompare(b.industry) || b.medianDrawdownDeltaPct - a.medianDrawdownDeltaPct);
  const industryNames = [...new Set(industrySummaries.filter((row) => row.includedInIndustryMedian && row.dataStatus === "ok").map((row) => row.industry))];
  return `# 当前机构持股 Top${stockLimit}：逐股中位数减仓—加仓回测

> 生成日期：${new Date().toISOString().slice(0, 10)}；Top${stockLimit}快照日期：${snapshot.dataDate}；行情范围：${from} 至 ${to}；单笔持有窗口：${horizon} 个交易日。

## 统计口径

- **不使用平均收益或平均回撤。**每只股票先对其所有可完成的月度滚动一年样本取收益和最大回撤的中位数；下表再对每只股票的中位数取中位数。每只股票只有一票，不因历史窗口更多或涨幅更大而获得额外权重。相对死扛也按同一笔入场窗口逐笔相减、先取单股中位数，再跨股票取中位数，绝不是“两个总体中位数相减”。
- 行业层也不使用均值：先取行业内股票中位数，再在符合门槛的行业中取中位数。该口径降低半导体、电子、通信等成分数量多的行业对结论的影响。
- “沪深300转空”定义为收盘低于自身MA60且MA20低于MA60；“行业转空”采用当前Top${stockLimit}中同一行业、至少${minIndustryStocks}只股票的**日收益中位数指数**，使用相同定义。确认规则只在个股转空且对应外部状态已转空时减半；个股转多即恢复，不等待外部状态恢复。
- 当前快照回看历史仍有幸存者偏差；本工具只检验同一批当前机构重仓股票下，规则相对死扛的历史表现。

## 全部个股：股票中位数

${dominant.length ? `存在收益和回撤都严格优于死扛的规则：${dominant.map((row) => `\`${row.name}\``).join("、")}。` : "没有规则在逐股相对死扛变化的中位数上，同时严格改善收益和回撤。"} 表中的 \`0.00%\` 表示至少一半股票在其滚动窗口中没有形成中位数意义上的净变化，不能把它解释为交易优势。回撤中位数改善最大的是 \`${bestDrawdown.name}\`。

| 规则 | 有效股票数 | 一年收益中位数 | 相对死扛 | 最大回撤中位数 | 相对死扛 | 单股双优率中位数 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
${stockMedianSummaries.map((row) => `| ${row.name} | ${row.stockCount} | ${formatPct(row.medianReturnPct)} | ${row.id === "hold" ? "—" : formatPct(row.medianReturnDeltaPct)} | ${formatPct(row.medianDrawdownPct)} | ${row.id === "hold" ? "—" : formatPct(row.medianDrawdownDeltaPct)} | ${row.medianBetterBothRate === null || Number.isNaN(row.medianBetterBothRate) ? "—" : formatPct(row.medianBetterBothRate * 100, false)} |`).join("\n")}

## 行业中位数

- 当前 Top${stockLimit} 中，有 ${industryNames.length} 个行业组达到至少 ${minIndustryStocks} 只有效股票的门槛。行业别名来自 \`${path.relative(process.cwd(), industryGroupsPath)}\`；银行与银行Ⅱ合并，饮料相关标签归为“饮料（含白酒）”。
- 行业中位数口径下，回撤改善最大的是 \`${industryBestDrawdown.name}\`；它也必须与收益中位数的损失一起看，不能被自动解释为“最优”。

| 规则 | 覆盖行业数 | 一年收益中位数 | 相对死扛 | 最大回撤中位数 | 相对死扛 | 单行业双优率中位数 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
${industryMedianSummaries.map((row) => `| ${row.name} | ${row.industryCount} | ${formatPct(row.medianReturnPct)} | ${row.id === "hold" ? "—" : formatPct(row.medianReturnDeltaPct)} | ${formatPct(row.medianDrawdownPct)} | ${row.id === "hold" ? "—" : formatPct(row.medianDrawdownDeltaPct)} | ${row.medianBetterBothRate === null || Number.isNaN(row.medianBetterBothRate) ? "—" : formatPct(row.medianBetterBothRate * 100, false)} |`).join("\n")}

## 每个行业内：股票中位数相对死扛

| 行业 | 有效股数 | 规则 | 收益中位数变化 | 回撤中位数变化 | 单股双优率中位数 |
| --- | ---: | --- | ---: | ---: | ---: |
${industryRows.map((row) => `| ${row.industry} | ${row.validStockCount} | ${row.name} | ${formatPct(row.medianReturnDeltaPct)} | ${formatPct(row.medianDrawdownDeltaPct)} | ${row.medianBetterBothRate === null || Number.isNaN(row.medianBetterBothRate) ? "—" : formatPct(row.medianBetterBothRate * 100, false)} |`).join("\n")}

## 执行与限制

1. 每笔样本首日收盘买入；买入价跌幅与均线/回撤信号都使用**前一日收盘**，在下一日收盘成交；每笔买卖扣 ${Math.round(cost * 10_000)}bp 单边摩擦。
2. 单均线规则在收盘重新站上对应MA时买回；均线交叉规则在短均线重新上穿长均线时买回；双均线规则要求收盘重新站上MA60且MA20重新高于MA60；60日高点回撤规则的卖出条件还要求从60日高点回撤至少15%。这些趋势规则允许在一年窗口内重复减半、恢复。
3. “买回卖出股数”最多恢复原始持股数；“全部留存现金加仓”不融资，但可能超过原始持股数。
4. 行业确认指数由当前Top${stockLimit}样本构造，不是严格点时行业指数，仍含当前成分股的幸存者偏差；它只用于检验“同行业共跌是否值得确认减仓”。
5. 没有模拟涨跌停、停牌、冲击成本、分红税差异和基本面突发事件；基本面证伪应走独立退出规则。
6. 当前可完成一年滚动窗口的股票为 ${validStockCount}/${stockLimit}。逐股中位数明细见 \`${path.basename(stockSummaryOutput)}\`；逐行业中位数明细见 \`${path.basename(industrySummaryOutput)}\`；原始逐笔数据见 \`${path.basename(csvOutput)}\`。
`;
}

function renderIndustryReport({ stockLimit, minIndustryStocks, industryGroupsPath, industrySummaries, industryEqualSummaries }) {
  const baseline = industryEqualSummaries.find((row) => row.id === "hold");
  const candidates = industryEqualSummaries.filter((row) => row.id !== "hold");
  const bestDrawdown = [...candidates].sort((a, b) => b.meanDrawdownPct - a.meanDrawdownPct || b.meanReturnPct - a.meanReturnPct)[0];
  const dominant = candidates.filter((row) => row.meanReturnPct >= baseline.meanReturnPct && row.meanDrawdownPct >= baseline.meanDrawdownPct);
  const groups = [...new Set(industrySummaries.filter((row) => row.includedInIndustryEqual).map((row) => row.industry))];
  const industryRows = industrySummaries.filter((row) => row.id !== "hold" && row.includedInIndustryEqual)
    .map((row) => {
      const base = industrySummaries.find((item) => item.industry === row.industry && item.id === "hold");
      return { ...row, returnDeltaPct: row.meanReturnPct - base.meanReturnPct, drawdownDeltaPct: row.meanDrawdownPct - base.meanDrawdownPct };
    })
    .sort((a, b) => a.industry.localeCompare(b.industry) || b.drawdownDeltaPct - a.drawdownDeltaPct);
  return `\n## 行业分层：抵消 AI 集中度\n\n- 上面的“所有个股平均”会让半导体、电子、通信等成分数多的行业权重更高；这张表先在每个行业内与死扛比较，再对符合样本门槛的行业**等权**平均。它不会把一个行业中47只半导体股当成47倍证据。\n- 当前 Top${stockLimit} 中，达到至少 ${minIndustryStocks} 只且有完整一年样本门槛的行业组为 ${groups.length} 个。行业别名来自 \`${path.relative(process.cwd(), industryGroupsPath)}\`；银行与银行Ⅱ合并，饮料相关标签单列为“饮料（含白酒）”。\n- 行业等权后，${dominant.length ? `仍有 ${dominant.map((row) => `\`${row.name}\``).join("、")}在平均收益和平均最大回撤上不低于死扛。` : "仍没有纯价格阈值规则同时不低于死扛的平均收益与平均最大回撤。"} 风险优先时回撤改善最大的候选是 \`${bestDrawdown.name}\`。\n\n### 行业等权汇总\n\n| 规则 | 覆盖行业数 | 平均一年收益 | 相对死扛 | 平均最大回撤 | 相对死扛 | 行业内双优率均值 |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n${industryEqualSummaries.map((row) => `| ${row.name} | ${row.industryCount} | ${formatPct(row.meanReturnPct)} | ${row.id === "hold" ? "—" : formatPct(row.meanReturnPct - baseline.meanReturnPct)} | ${formatPct(row.meanDrawdownPct)} | ${row.id === "hold" ? "—" : formatPct(row.meanDrawdownPct - baseline.meanDrawdownPct)} | ${row.betterBothRate === null || Number.isNaN(row.betterBothRate) ? "—" : formatPct(row.betterBothRate * 100, false)} |`).join("\n")}\n\n### 各行业内相对死扛的变化\n\n| 行业 | 样本股数 | 规则 | 收益变化 | 最大回撤变化 | 行业内双优率 |\n| --- | ---: | --- | ---: | ---: | ---: |\n${industryRows.map((row) => `| ${row.industry} | ${row.validStockCount} | ${row.name} | ${formatPct(row.returnDeltaPct)} | ${formatPct(row.drawdownDeltaPct)} | ${formatPct(row.betterBothRate * 100, false)} |`).join("\n")}\n\n逐行业完整明细见同名文件：\`${path.basename(industrySummaryOutput)}\`。\n`;
}

function renderReport({ snapshot, from, to, horizon, cost, stocks, summaries, episodes }) {
  const baseline = summaries.find((row) => row.id === "hold");
  const candidates = summaries.filter((row) => row.id !== "hold");
  const bestBoth = [...candidates].sort((a, b) => b.betterBothRate - a.betterBothRate || b.meanReturnPct - a.meanReturnPct)[0];
  const bestDrawdown = [...candidates].sort((a, b) => b.meanDrawdownPct - a.meanDrawdownPct)[0];
  const episodeCount = summaries[0]?.count ?? 0;
  return `# 当前机构持股 Top100：逐股减仓—加仓规则回测\n\n> 生成日期：${new Date().toISOString().slice(0, 10)}；Top100快照日期：${snapshot.dataDate}；行情范围：${from} 至 ${to}；单笔持有窗口：${horizon} 个交易日。\n\n## 先看结论\n\n- 本研究把**当前**机构持股家数Top100分别当作样本股票，不假定同时持有它们。每只股票在每个可完成一年窗口的自然月首个交易日虚拟买入，因此共 ${episodeCount} 笔滚动样本。\n- 这是用户指定的“当前100只回测历史”口径，存在明显的幸存者偏差：今天仍在Top100的股票通常比落选股票更成功。结果只能用于这些当前热门机构股的历史行为比较，不能证明过去可以交易获得同样结果。\n- 相比死扛，\`${bestDrawdown.name}\`的平均单笔最大回撤最低（${formatPct(bestDrawdown.meanDrawdownPct)}），但是否值得采用，要同时看收益和“收益更高且回撤更低”的发生率。\n- 在本组固定规则中，\`${bestBoth.name}\`的“收益高于死扛且最大回撤更低”发生率最高，为 ${formatPct(bestBoth.betterBothRate * 100, false)}；它不是未来最优参数，只是下一步最值得用新样本继续观察的候选。\n\n## 汇总结果\n\n| 规则 | 平均一年收益 | 收益中位数 | 平均最大回撤 | 最大回撤中位数 | 回撤最差10%分位 | 触发减仓 | 触发二次买入 | 收益优于死扛 | 回撤优于死扛 | 两者都优于死扛 |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${summaries.map((row) => `| ${row.name} | ${formatPct(row.meanReturnPct)} | ${formatPct(row.medianReturnPct)} | ${formatPct(row.meanDrawdownPct)} | ${formatPct(row.medianDrawdownPct)} | ${formatPct(row.p10DrawdownPct)} | ${formatPct(row.reducedRate * 100, false)} | ${formatPct(row.addedRate * 100, false)} | ${row.betterReturnRate === null ? "—" : formatPct(row.betterReturnRate * 100, false)} | ${row.betterDrawdownRate === null ? "—" : formatPct(row.betterDrawdownRate * 100, false)} | ${row.betterBothRate === null ? "—" : formatPct(row.betterBothRate * 100, false)} |`).join("\n")}\n\n## 交易状态机（避免含糊解释）\n\n1. 在每笔样本首日收盘买入，初始资金为1；每次买卖均扣 ${Math.round(cost * 10_000)}bp 单边摩擦。\n2. 当**前一交易日收盘价**相对买入价跌至第一档，下一交易日收盘按规则卖出指定比例；因使用前一日信号，不存在同一收盘价触发又成交的前视偏差。\n3. 已减仓后，若前一日收盘价跌至第二档，下一交易日收盘买入：\n   - “买回卖出股数”最多恢复到初始股数，卖高买低后留下的现金继续保留；\n   - “用全部留存现金加仓”则把卖出所得现金全部投入，允许持股数超过初始股数，但不使用融资。\n4. 如果第二档从未触发，已卖出的部分保持现金直到一年窗口结束；这正是该类纪律在快速反弹行情中可能落后死扛的代价。\n5. 到第 ${horizon} 个交易日统一以收盘卖出，便于逐笔比较。没有模拟跌停、停牌、冲击成本、分红税差异或基本面事件。\n\n## 如何阅读\n\n- “平均最大回撤”越接近0越好；“回撤最差10%分位”反映较糟糕的十分之一交易，而不是单一极端案例。\n- 仅仅“回撤优于死扛”不够：如果收益也普遍更低，实质是长期持有更多现金。应优先关注“两个都优于死扛”的发生率和收益中位数。\n- 每月滚动样本之间会重叠，不能把 ${episodeCount} 笔当作完全独立的交易；它们用于稳定描述规则表现，不用于显著性检验。\n\n## 数据与范围\n\n- 样本股票：\`${snapshotPathLabel(snapshot)}\`中按持仓机构家数排序的前100只；当前可用日线的股票数为 ${stocks.filter((stock) => stock.rows.length > horizon).length}/100。\n- 行情：东方财富日线前复权，经 \`${baseUrl}/api/kline\` 获取。\n- 每笔明细见同名CSV：\`${path.basename(csvOutput)}\`，其中含代码、名称、买入日、每条规则的一年收益、最大回撤、是否减仓和是否二次买入。\n`;
}

function renderCsv(rows) {
  const fields = ["code", "name", "institutionCount", "entryDate", "exitDate", "rule", "ruleName", "returnPct", "maxDrawdownPct", "reduced", "added", "baselineReturnPct", "baselineMaxDrawdownPct"];
  return [fields.join(","), ...rows.map((row) => fields.map((field) => csvCell(row[field])).join(","))].join("\n") + "\n";
}

function renderTriggeredCsv(rows) {
  return renderCsv(rows.filter((row) => row.rule !== "hold" && row.reduced));
}

function summarizeCashLadder(rules, rows) {
  return rules.map((rule) => {
    const samples = rows.filter((row) => row.rule === rule.id);
    const triggered = samples.filter((row) => row.firstBought);
    const betterReturn = samples.filter((row) => row.returnPct > row.baselineReturnPct).length;
    const betterDrawdown = samples.filter((row) => row.maxDrawdownPct > row.baselineMaxDrawdownPct).length;
    const betterBoth = samples.filter((row) => row.returnPct > row.baselineReturnPct && row.maxDrawdownPct > row.baselineMaxDrawdownPct).length;
    const returnGainAtLeast5 = samples.filter((row) => row.returnPct - row.baselineReturnPct >= 5).length;
    const returnLossAtLeast5 = samples.filter((row) => row.returnPct - row.baselineReturnPct <= -5).length;
    const drawdownBetterAtLeast1 = samples.filter((row) => row.maxDrawdownPct - row.baselineMaxDrawdownPct >= 1).length;
    const drawdownBetterAtLeast3 = samples.filter((row) => row.maxDrawdownPct - row.baselineMaxDrawdownPct >= 3).length;
    const drawdownWorseAtLeast1 = samples.filter((row) => row.baselineMaxDrawdownPct - row.maxDrawdownPct >= 1).length;
    const drawdownWorseAtLeast3 = samples.filter((row) => row.baselineMaxDrawdownPct - row.maxDrawdownPct >= 3).length;
    const triggeredBetterBoth = triggered.filter((row) => row.returnPct > row.baselineReturnPct && row.maxDrawdownPct > row.baselineMaxDrawdownPct).length;
    return {
      ...rule,
      sampleCount: samples.length,
      triggeredCount: triggered.length,
      triggeredStockCount: new Set(triggered.map((row) => row.code)).size,
      secondBoughtCount: samples.filter((row) => row.secondBought).length,
      betterReturnRate: samples.length ? betterReturn / samples.length : null,
      betterDrawdownRate: samples.length ? betterDrawdown / samples.length : null,
      betterBothRate: samples.length ? betterBoth / samples.length : null,
      returnGainAtLeast5Rate: samples.length ? returnGainAtLeast5 / samples.length : null,
      returnLossAtLeast5Rate: samples.length ? returnLossAtLeast5 / samples.length : null,
      drawdownBetterAtLeast1Rate: samples.length ? drawdownBetterAtLeast1 / samples.length : null,
      drawdownBetterAtLeast3Rate: samples.length ? drawdownBetterAtLeast3 / samples.length : null,
      drawdownWorseAtLeast1Rate: samples.length ? drawdownWorseAtLeast1 / samples.length : null,
      drawdownWorseAtLeast3Rate: samples.length ? drawdownWorseAtLeast3 / samples.length : null,
      triggeredBetterBothRate: triggered.length ? triggeredBetterBoth / triggered.length : null,
    };
  });
}

function renderCashLadderReport({ snapshot, from, to, horizon, cost, stockLimit, cashBaseline, cashSummaries, cashCsvOutput }) {
  const bestAll = [...cashSummaries].sort((a, b) => b.betterBothRate - a.betterBothRate || b.betterDrawdownRate - a.betterDrawdownRate)[0];
  const isFullStockBaseline = cashBaseline === 'full-stock';
  const baselineDescription = isFullStockBaseline
    ? '基准为首日把全部资金买入该股票、之后死扛，不保留现金。'
    : '基准为同一初始配置且后续不主动交易；它不是每日或每月再平衡到固定市值比例。若要比较定期再平衡，需要另行指定再平衡频率。';
  const structuralLimit = isFullStockBaseline
    ? ''
    : '- **最大回撤的结构性限制：**在首次买入前策略与基准路径完全相同；买入当日净值不因换现金为股票而上升（还会承担交易成本），此后策略股票暴露不低于基准。因此这种“只加仓、不减仓”的策略不可能严格降低从入场开始计算的最大回撤；“回撤更低”和“双优”理论上应为零。它适合检验反弹后的收益增厚，不适合作为回撤控制工具。';
  const resultSummary = isFullStockBaseline
    ? (bestAll ? `全样本双优比例最高的是 \`${bestAll.name}\`（${formatPct(bestAll.betterBothRate * 100, false)}）。应同时检查收益和回撤至少改善5/3个百分点的比例，避免只看轻微变化。` : '没有可比较样本。')
    : (bestAll ? `由于上述最大回撤限制，全样本双优比例最高的规则也是 ${formatPct(bestAll.betterBothRate * 100, false)}。此处应主要比较“收益更高”比例与第一、二档实际买入频率，而不是把它误作风控策略。` : '没有可比较样本。');
  const resultTable = isFullStockBaseline
    ? `| 规则 | 全部窗口 | 第一档买入 | 涉及股票 | 第二档买入 | 收益更高 | 收益多≥5pct | 收益少≥5pct | 回撤改善≥1pct | 回撤改善≥3pct | 收益回撤双优 |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${cashSummaries.map((row) => `| ${row.name} | ${row.sampleCount} | ${formatPct(row.triggeredCount / row.sampleCount * 100, false)} | ${row.triggeredStockCount} | ${formatPct(row.secondBoughtCount / row.sampleCount * 100, false)} | ${formatPct(row.betterReturnRate * 100, false)} | ${formatPct(row.returnGainAtLeast5Rate * 100, false)} | ${formatPct(row.returnLossAtLeast5Rate * 100, false)} | ${formatPct(row.drawdownBetterAtLeast1Rate * 100, false)} | ${formatPct(row.drawdownBetterAtLeast3Rate * 100, false)} | ${formatPct(row.betterBothRate * 100, false)} |`).join("\n")}`
    : `| 规则 | 全部窗口 | 第一档买入 | 涉及股票 | 第二档买入 | 收益更高 | 收益多≥5pct | 收益少≥5pct | 回撤恶化≥1pct | 回撤恶化≥3pct |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${cashSummaries.map((row) => `| ${row.name} | ${row.sampleCount} | ${formatPct(row.triggeredCount / row.sampleCount * 100, false)} | ${row.triggeredStockCount} | ${formatPct(row.secondBoughtCount / row.sampleCount * 100, false)} | ${formatPct(row.betterReturnRate * 100, false)} | ${formatPct(row.returnGainAtLeast5Rate * 100, false)} | ${formatPct(row.returnLossAtLeast5Rate * 100, false)} | ${formatPct(row.drawdownWorseAtLeast1Rate * 100, false)} | ${formatPct(row.drawdownWorseAtLeast3Rate * 100, false)} |`).join("\n")}`;
  return `# 当前机构持股 Top${stockLimit}：预留现金分批买入回测

> 生成日期：${new Date().toISOString().slice(0, 10)}；Top${stockLimit}快照日期：${snapshot.dataDate}；行情范围：${from} 至 ${to}；单笔持有窗口：${horizon} 个交易日。

## 比较口径

- 每笔样本在首日把初始资金分为“个股仓位 + 现金”。例如初始现金30%，策略和基准都在首日买入70%个股、保留30%现金。
- ${baselineDescription}
- 策略仅在前一日收盘相对入场价达到第一/第二档跌幅时，分别使用“初始现金储备”的指定比例，在下一交易日收盘买入；每笔买卖扣 ${Math.round(cost * 10_000)}bp 单边摩擦。
- 本报告不使用平均收益、平均回撤或中位数。只报告相同入场窗口下，策略相对同配置静态基准的收益更高、回撤更低和双优发生比例。
${structuralLimit}

## 参数结果

${resultSummary}

${resultTable}

## 限制

1. 当前机构Top${stockLimit}成分回看历史存在幸存者偏差；本报告只能比较这批当前机构重仓股票的历史条件行为。
2. 未模拟涨跌停、停牌、冲击成本、分红税差异和基本面证伪；价格阈值不能替代基本面退出纪律。
3. 逐笔明细见 \`${path.basename(cashCsvOutput)}\`。
`;
}

function renderCashLadderCsv(rows) {
  const fields = ["code", "name", "institutionCount", "industry", "industryGroup", "entryDate", "exitDate", "rule", "ruleName", "initialCashPct", "firstLossPct", "secondLossPct", "firstCashSpendPct", "secondCashSpendPct", "returnPct", "maxDrawdownPct", "firstBought", "secondBought", "baselineReturnPct", "baselineMaxDrawdownPct"];
  return [fields.join(","), ...rows.map((row) => fields.map((field) => csvCell(row[field])).join(","))].join("\n") + "\n";
}

function renderStockSummaryCsv(rows) {
  const fields = ["code", "name", "institutionCount", "industry", "industryGroup", "dataStatus", "rule", "ruleName", "count", "medianReturnPct", "medianDrawdownPct", "reducedRate", "addedRate", "betterBothRate", "baselineReturnPct", "baselineDrawdownPct", "returnDeltaPct", "drawdownDeltaPct"];
  return [fields.join(","), ...rows.map((row) => fields.map((field) => csvCell(row[field])).join(","))].join("\n") + "\n";
}

function renderIndustrySummaryCsv(rows) {
  const fields = ["industry", "stockCount", "validStockCount", "includedInIndustryMedian", "dataStatus", "id", "name", "medianReturnPct", "medianDrawdownPct", "medianBetterBothRate"];
  return [fields.join(","), ...rows.map((row) => fields.map((field) => csvCell(row[field])).join(","))].join("\n") + "\n";
}

async function fetchKline(base, code, fromDate, toDate) {
  const data = await fetchJson(base, "/api/kline", { code, period: "day", fq: "qfq", from: fromDate, to: toDate });
  return data.map((row) => ({
    date: new Date(Number(row[0])).toISOString().slice(0, 10),
    close: Number(row[1]),
  })).filter((row) => Number.isFinite(row.close) && row.close > 0).sort((a, b) => a.date.localeCompare(b.date));
}

function buildIndicators(rows) {
  return rows.map((row, index) => {
    const closes = rows.slice(Math.max(0, index - 119), index + 1).map((item) => item.close);
    return {
      ...row,
      ma5: closes.length >= 5 ? average(closes.slice(-5)) : null,
      ma10: closes.length >= 10 ? average(closes.slice(-10)) : null,
      ma20: closes.length >= 20 ? average(closes.slice(-20)) : null,
      ma30: closes.length >= 30 ? average(closes.slice(-30)) : null,
      ma60: closes.length >= 60 ? average(closes.slice(-60)) : null,
      ma120: closes.length >= 120 ? average(closes) : null,
      high60: closes.length >= 60 ? Math.max(...closes.slice(-60)) : null,
    };
  });
}

function buildIndustryPeerIndexes(stocks) {
  const grouped = new Map();
  for (const stock of stocks) {
    const rows = grouped.get(stock.industryGroup) ?? [];
    rows.push(stock.rows);
    grouped.set(stock.industryGroup, rows);
  }
  const result = new Map();
  for (const [industry, stockRows] of grouped) {
    if (stockRows.length < minIndustryStocks) continue;
    const returnsByDate = new Map();
    for (const rows of stockRows) {
      for (let index = 1; index < rows.length; index += 1) {
        const prior = rows[index - 1];
        const current = rows[index];
        if (!Number.isFinite(prior.close) || !Number.isFinite(current.close) || prior.close <= 0) continue;
        const values = returnsByDate.get(current.date) ?? [];
        values.push(current.close / prior.close - 1);
        returnsByDate.set(current.date, values);
      }
    }
    let level = 1;
    const indexRows = [...returnsByDate.keys()].sort().map((date) => {
      level *= 1 + median(returnsByDate.get(date));
      return { date, close: level };
    });
    result.set(industry, new Map(buildIndicators(indexRows).map((row) => [row.date, row])));
  }
  return result;
}

async function fetchJson(base, pathname, params) {
  const url = new URL(pathname, base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(45_000) });
      const body = await response.json();
      if (!response.ok || body.code !== 200 || !Array.isArray(body.data)) throw new Error(`${response.status} ${url}`);
      return body.data;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  throw lastError;
}

async function mapConcurrent(items, concurrency, mapper) {
  const result = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      result[index] = await mapper(items[index], index);
    }
  }));
  return result;
}

function average(values) { return values.reduce((sum, value) => sum + value, 0) / values.length; }
function dateDaysBefore(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}
function median(values) { return percentile(values, 0.5); }
function medianFinite(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? median(finite) : null;
}
function percentile(values, probability) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}
function formatPct(value, signed = true) { return `${signed && value > 0 ? "+" : ""}${value.toFixed(2)}%`; }
function snapshotPathLabel(snapshot) { return `institutional-track-snapshot.json（${snapshot.dataDate}）`; }
function csvCell(value) { const text = String(value ?? ""); return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
function parseIndustryGroups(config) {
  if (!config || typeof config !== "object" || Array.isArray(config) || !config.aliases || typeof config.aliases !== "object" || Array.isArray(config.aliases)) {
    throw new Error("industry groups config must contain an aliases object");
  }
  return new Map(Object.entries(config.aliases).map(([industry, group]) => [String(industry), String(group)]));
}
function parseCashLadderRules(values) {
  const initialCashPcts = parsePercentageList(values["initial-cash-pcts"] ?? "20,35,50", "--initial-cash-pcts", false);
  const firstLossPcts = parsePercentageList(values["first-loss-pcts"] ?? "10,15,20", "--first-loss-pcts", false);
  const secondLossPcts = parsePercentageList(values["second-loss-pcts"] ?? "20,25,30,35,40", "--second-loss-pcts", false);
  const buySplits = parseCashBuySplits(values["cash-buy-splits"] ?? "35/65,50/50,65/35");
  const rules = [];
  for (const initialCashPct of initialCashPcts) {
    for (const firstLossPct of firstLossPcts) {
      for (const secondLossPct of secondLossPcts) {
        if (secondLossPct <= firstLossPct) continue;
        for (const split of buySplits) {
          const splitLabel = `${split.first}/${split.second}`;
          rules.push({
            id: `cash-ladder-${initialCashPct}-${firstLossPct}-${secondLossPct}-${split.first}-${split.second}`,
            name: `初始现金${initialCashPct}%；跌${firstLossPct}%买现金${split.first}%，跌${secondLossPct}%买现金${split.second}%`,
            kind: "cash-ladder",
            initialCashPct,
            loss1: firstLossPct / 100,
            loss2: secondLossPct / 100,
            firstCashSpendPct: split.first,
            secondCashSpendPct: split.second,
            splitLabel,
          });
        }
      }
    }
  }
  if (!rules.length) throw new Error("cash-ladder thresholds must contain at least one second threshold greater than the first threshold");
  return rules;
}
function parseCashBuySplits(value) {
  const splits = String(value).split(",").map((part) => {
    const match = part.trim().match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
    if (!match) throw new Error("--cash-buy-splits must be comma-separated first/second cash percentages, for example 35/65,50/50");
    const first = Number(match[1]);
    const second = Number(match[2]);
    if (!(first > 0) || !(second > 0) || first + second > 100) throw new Error("each --cash-buy-splits pair must be positive and sum to at most 100");
    return { first, second };
  });
  if (!splits.length) throw new Error("--cash-buy-splits must contain at least one pair");
  if (new Set(splits.map((split) => `${split.first}/${split.second}`)).size !== splits.length) throw new Error("--cash-buy-splits must not contain duplicate pairs");
  return splits;
}
function withGridArguments(config, values) {
  const gridKeys = ["first-loss-pcts", "second-loss-pcts", "sell-fractions"];
  const provided = gridKeys.filter((key) => values[key] !== undefined);
  if (!provided.length) return config;
  if (provided.length !== gridKeys.length) {
    throw new Error("--first-loss-pcts, --second-loss-pcts, and --sell-fractions must be provided together");
  }
  const baseline = config?.rules?.find((rule) => rule?.id === "hold");
  if (!baseline) throw new Error("rules config must contain a hold rule for --*-pcts grid arguments");
  return {
    rules: [baseline],
    entryLossGrids: [{
      idPrefix: String(values["grid-id-prefix"] ?? "loss-grid"),
      firstLossPcts: parsePercentageList(values["first-loss-pcts"], "--first-loss-pcts", false),
      secondLossPcts: parsePercentageList(values["second-loss-pcts"], "--second-loss-pcts", false),
      sellFractions: parsePercentageList(values["sell-fractions"], "--sell-fractions", true).map((value) => value / 100),
      buyMode: String(values["buy-mode"] ?? "restore"),
    }],
  };
}
function parsePercentageList(value, flag, allowHundred) {
  const numbers = String(value).split(",").map((part) => Number(part.trim()));
  if (!numbers.length || numbers.some((number) => !Number.isFinite(number) || number <= 0 || number > (allowHundred ? 100 : 99))) {
    throw new Error(`${flag} must be a comma-separated list of percentages between 0 and ${allowHundred ? 100 : 99}`);
  }
  if (new Set(numbers).size !== numbers.length) throw new Error(`${flag} must not contain duplicate percentages`);
  return numbers;
}
function parseRules(config) {
  if (!Array.isArray(config?.rules)) throw new Error("rules config must contain a rules array");
  const expandedRules = [...config.rules];
  for (const grid of config.entryLossGrids ?? []) {
    const idPrefix = String(grid?.idPrefix ?? "loss-grid");
    const firstLossPcts = grid?.firstLossPcts;
    const secondLossPcts = grid?.secondLossPcts;
    const sellFractions = grid?.sellFractions;
    const buyMode = String(grid?.buyMode ?? "restore");
    const buyLabel = buyMode === "all-cash" ? "用全部留存现金买入" : "买回卖出股数";
    if (!Array.isArray(firstLossPcts) || !Array.isArray(secondLossPcts) || !Array.isArray(sellFractions)) throw new Error(`${idPrefix}: entryLossGrids requires threshold and fraction arrays`);
    for (const firstLossPct of firstLossPcts) {
      for (const secondLossPct of secondLossPcts) {
        if (!(Number(secondLossPct) > Number(firstLossPct))) continue;
        for (const sellFraction of sellFractions) {
          const fractionPct = Math.round(Number(sellFraction) * 100);
          expandedRules.push({
            id: `${idPrefix}-${firstLossPct}-${secondLossPct}-${fractionPct}`,
            name: `跌${firstLossPct}%卖${fractionPct}%；跌${secondLossPct}%${buyLabel}`,
            loss1Pct: firstLossPct,
            loss2Pct: secondLossPct,
            sellFraction,
            buyMode,
          });
        }
      }
    }
  }
  if (expandedRules.length < 2) throw new Error("rules config must contain at least baseline and one candidate rule");
  const ids = new Set();
  const rules = expandedRules.map((raw) => {
    const id = String(raw?.id ?? "");
    const name = String(raw?.name ?? "");
    const sellFraction = Number(raw?.sellFraction);
    const buyMode = String(raw?.buyMode ?? "");
    const kind = String(raw?.kind ?? "entry-loss");
    const signal = raw?.signal === undefined ? null : String(raw.signal);
    const confirm = String(raw?.confirm ?? "none");
    const isBaseline = id === "hold";
    const loss1 = raw?.loss1Pct === undefined ? null : Number(raw.loss1Pct) / 100;
    const loss2 = raw?.loss2Pct === undefined ? null : Number(raw.loss2Pct) / 100;
    if (!id || !name || ids.has(id)) throw new Error(`rules config has an invalid or duplicate id: ${id || "(empty)"}`);
    ids.add(id);
    if (!Number.isFinite(sellFraction) || sellFraction < 0 || sellFraction > 1) throw new Error(`${id}: sellFraction must be between 0 and 1`);
    if (!["none", "market", "industry", "both"].includes(confirm)) throw new Error(`${id}: unsupported confirmation ${confirm}`);
    if (isBaseline) {
      if (loss1 !== null || loss2 !== null || sellFraction !== 0 || buyMode !== "none") throw new Error("hold rule must have no thresholds, sellFraction 0, and buyMode none");
    } else if (kind === "entry-loss" && (!Number.isFinite(loss1) || !Number.isFinite(loss2) || loss1 <= 0 || loss2 <= loss1 || loss2 >= 1 || sellFraction <= 0 || !["restore", "all-cash"].includes(buyMode))) {
      throw new Error(`${id}: require 0 < loss1Pct < loss2Pct < 100, a positive sellFraction, and buyMode restore or all-cash`);
    } else if (kind === "trend" && (loss1 !== null || loss2 !== null || sellFraction <= 0 || buyMode !== "restore" || !["ma5", "ma10", "ma20", "ma30", "ma60", "ma120", "ma5-ma20-cross", "ma10-ma20-cross", "ma20-ma60-cross", "dual-ma", "dd15-dual-ma"].includes(signal))) {
      throw new Error(`${id}: trend rules require a supported signal, positive sellFraction, and buyMode restore`);
    } else if (!isBaseline && !["entry-loss", "trend"].includes(kind)) {
      throw new Error(`${id}: unsupported rule kind ${kind}`);
    }
    return { id, name, kind, signal, confirm, loss1, loss2, sellFraction, buyMode };
  });
  if (rules.filter((rule) => rule.id === "hold").length !== 1) throw new Error("rules config must contain exactly one hold rule");
  return rules;
}
function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    if (!values[index].startsWith("--")) throw new Error(`unexpected argument: ${values[index]}`);
    parsed[values[index].slice(2)] = values[++index];
  }
  return parsed;
}
