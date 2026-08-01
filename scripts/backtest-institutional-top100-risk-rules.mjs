#!/usr/bin/env node

/**
 * Point-in-time test for the A-share institutional-holding Top 100 portfolio.
 *
 * The selection is refreshed only after the statutory reporting deadline for
 * each quarter.  Signals use the previous close and orders are valued at the
 * next close, so the script deliberately does not use same-close information.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
const baseUrl = args["base-url"] ?? "https://tinfo.cc";
const to = args.to ?? "2026-07-31";
const from = args.from ?? "2023-12-01";
const oneWayCost = Number(args["one-way-cost-bp"] ?? "15") / 10_000;
const output = path.resolve(args.output ?? "docs/research/机构持仓Top100-风控规则回测.md");

if (!Number.isFinite(oneWayCost) || oneWayCost < 0 || oneWayCost > 0.01) {
  throw new Error("--one-way-cost-bp must be between 0 and 100");
}

const reportDates = quarterEndsBetween("2024-03-31", "2026-03-31");
const rankingRows = await Promise.all(reportDates.map(async (reportDate) => ({
  reportDate,
  rows: await fetchTop100(baseUrl, reportDate),
})));
const universe = [...new Set(rankingRows.flatMap(({ rows }) => rows.map((row) => row.code)))];
const priceRows = await mapConcurrent(universe, 6, async (code) => [code, await fetchKline(baseUrl, code, from, to)]);
const priceByCode = new Map(priceRows);
const masterDates = [...new Set(priceRows.flatMap(([, rows]) => rows.map((row) => row.date)))].sort();
const schedules = rankingRows
  .map(({ reportDate, rows }) => ({
    reportDate,
    availableDate: availabilityDate(reportDate),
    tradeDate: nextTradingDate(masterDates, availabilityDate(reportDate)),
    codes: rows.map((row) => row.code),
  }))
  .filter((item) => item.tradeDate && item.tradeDate <= to);

if (schedules.length < 2) throw new Error("not enough completed quarterly holding schedules");
if (masterDates.length === 0) throw new Error("no kline data");

const pointByCode = new Map([...priceByCode.entries()].map(([code, rows]) => [code, buildPoints(rows)]));
const startDate = schedules[0].tradeDate;
const testDates = masterDates.filter((date) => date >= startDate && date <= to);
const scheduleByDate = new Map(schedules.map((item) => [item.tradeDate, item]));
const strategies = [
  { id: "hold", name: "季度等权持有（基准）", signal: "always" },
  { id: "ma20", name: "收盘跌破MA20全卖；重新站上即买回", signal: "ma20" },
  { id: "ma60", name: "收盘跌破MA60全卖；重新站上即买回", signal: "ma60" },
  { id: "ma60-half", name: "收盘跌破MA60减半；重新站上恢复", signal: "ma60", riskWeight: 0.5 },
  { id: "ma60-buffer", name: "跌破0.98×MA60卖；站上1.02×MA60买", signal: "ma60-buffer" },
  { id: "dual-ma", name: "收盘低于MA60且MA20低于MA60卖；双重恢复再买", signal: "dual-ma" },
  { id: "dual-ma-half", name: "双均线转空减半；双重恢复", signal: "dual-ma", riskWeight: 0.5 },
  { id: "dd15-dual", name: "距60日高点回撤15%且双均线转空卖；双重恢复再买", signal: "dd15-dual" },
  { id: "dd20-dual", name: "距60日高点回撤20%且双均线转空卖；双重恢复再买", signal: "dd20-dual" },
];

const results = strategies.map((strategy) => runBacktest({
  strategy,
  dates: testDates,
  scheduleByDate,
  pointByCode,
  oneWayCost,
}));
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, renderReport({
  baseUrl,
  from,
  to,
  oneWayCost,
  universe: universe.length,
  schedules,
  results,
}), "utf8");
console.log(JSON.stringify({ output, strategies: results.length, stocks: universe.length, schedules: schedules.length }, null, 2));

async function fetchTop100(base, reportDate) {
  const pages = await Promise.all([1, 2].map((page) => fetchJson(base, "/api/companies/holding/rank", {
    date: reportDate,
    type: "0",
    rank: "HOLD_VALUE",
    page: String(page),
  })));
  const rows = pages.flat().slice(0, 100).map((row) => ({
    code: String(row.SECUCODE ?? ""),
    name: String(row.SECURITY_NAME_ABBR ?? ""),
  })).filter((row) => /^\d{6}\.(SH|SZ|BJ)$/.test(row.code));
  if (rows.length !== 100 || new Set(rows.map((row) => row.code)).size !== 100) {
    throw new Error(`${reportDate}: expected 100 unique A-share holdings, got ${rows.length}`);
  }
  return rows;
}

async function fetchKline(base, code, fromDate, toDate) {
  const rows = await fetchJson(base, "/api/kline", { code, period: "day", fq: "qfq", from: fromDate, to: toDate });
  return rows.map((row) => ({
    date: new Date(Number(row[0])).toISOString().slice(0, 10),
    close: Number(row[1]),
  })).filter((row) => Number.isFinite(row.close) && row.close > 0).sort((a, b) => a.date.localeCompare(b.date));
}

function buildPoints(rows) {
  const points = new Map();
  for (let index = 0; index < rows.length; index += 1) {
    const closes = rows.slice(0, index + 1).map((row) => row.close);
    const point = { close: rows[index].close, ma20: null, ma60: null, high60: null };
    if (closes.length >= 20) point.ma20 = average(closes.slice(-20));
    if (closes.length >= 60) {
      point.ma60 = average(closes.slice(-60));
      point.high60 = Math.max(...closes.slice(-60));
    }
    points.set(rows[index].date, point);
  }
  return points;
}

function runBacktest({ strategy, dates, scheduleByDate, pointByCode, oneWayCost: cost }) {
  let cash = 1;
  let shares = new Map();
  let selected = [];
  let turnover = 0;
  let totalCosts = 0;
  let signalChanges = 0;
  let previousSignals = new Map();
  const curve = [];

  for (let index = 0; index < dates.length; index += 1) {
    const date = dates[index];
    const previousDate = dates[index - 1] ?? null;
    const schedule = scheduleByDate.get(date);
    if (schedule) {
      selected = schedule.codes;
      previousSignals = new Map();
      const rebalanced = rebalance({
        cash, shares, selected, date, previousDate, strategy, pointByCode, cost, turnover, totalCosts,
      });
      ({ cash, shares, turnover, totalCosts } = rebalanced);
      previousSignals = rebalanced.signals;
    } else if (selected.length > 0 && previousDate) {
      const changes = [];
      for (const code of selected) {
        const signal = isInvested(strategy.signal, pointByCode.get(code)?.get(previousDate), previousSignals.get(code));
        const before = previousSignals.get(code);
        if (signal !== null) {
          previousSignals.set(code, signal);
          if (before !== undefined && before !== signal) {
            changes.push([code, signal]);
            signalChanges += 1;
          }
        }
      }
      ({ cash, shares, turnover, totalCosts } = applyChanges({
        cash, shares, changes, strategy, pointByCode, date, selectedCount: selected.length, cost, turnover, totalCosts,
      }));
    }
    const nav = portfolioValue(cash, shares, pointByCode, date);
    curve.push({ date, nav, stockExposure: exposure(shares, nav, pointByCode, date) });
  }
  return summarize(strategy, curve, turnover, totalCosts, signalChanges, selected.length);
}

function rebalance({ cash, shares, selected, date, previousDate, strategy, pointByCode, cost, turnover, totalCosts }) {
  const navBefore = portfolioValue(cash, shares, pointByCode, date);
  for (const [code, quantity] of shares) {
    const price = pointByCode.get(code)?.get(date)?.close;
    if (!price) continue;
    const gross = quantity * price;
    cash += gross * (1 - cost);
    turnover += gross / Math.max(navBefore, Number.EPSILON);
    totalCosts += gross * cost;
    shares.delete(code);
  }
  const targetNav = portfolioValue(cash, shares, pointByCode, date);
  const desired = [];
  const signals = new Map();
  for (const code of selected) {
    const signal = isInvested(strategy.signal, pointByCode.get(code)?.get(previousDate), undefined);
    const invested = signal ?? false;
    signals.set(code, invested);
    desired.push([code, invested ? 1 : (strategy.riskWeight ?? 0)]);
  }
  for (const [code, scale] of desired) {
    const price = pointByCode.get(code)?.get(date)?.close;
    if (!price || cash <= 0) continue;
    const gross = Math.min(targetNav / selected.length * scale / (1 + cost), cash / (1 + cost));
    if (gross <= 0) continue;
    shares.set(code, gross / price);
    cash -= gross * (1 + cost);
    turnover += gross / Math.max(targetNav, Number.EPSILON);
    totalCosts += gross * cost;
  }
  // The signal map is attached to the shares object only for this function's caller.
  // It is reconstructed from the prior-day data on the next loop; no future prices leak in.
  return { cash, shares, turnover, totalCosts, signals };
}

function applyChanges({ cash, shares, changes, strategy, pointByCode, date, selectedCount, cost, turnover, totalCosts }) {
  const navBefore = portfolioValue(cash, shares, pointByCode, date);
  for (const [code, invested] of changes) {
    const price = pointByCode.get(code)?.get(date)?.close;
    if (!price) continue;
    const currentGross = (shares.get(code) ?? 0) * price;
    const targetGross = navBefore / selectedCount * (invested ? 1 : (strategy.riskWeight ?? 0)) / (1 + cost);
    const sellGross = Math.max(0, currentGross - targetGross);
    if (sellGross <= 0) continue;
    cash += sellGross * (1 - cost);
    shares.set(code, (currentGross - sellGross) / price);
    if (currentGross - sellGross < 1e-12) shares.delete(code);
    turnover += sellGross / Math.max(navBefore, Number.EPSILON);
    totalCosts += sellGross * cost;
  }
  let nav = portfolioValue(cash, shares, pointByCode, date);
  for (const [code, invested] of changes) {
    const price = pointByCode.get(code)?.get(date)?.close;
    if (!price) continue;
    const currentGross = (shares.get(code) ?? 0) * price;
    const targetGross = nav / selectedCount * (invested ? 1 : (strategy.riskWeight ?? 0)) / (1 + cost);
    const buyGross = Math.min(Math.max(0, targetGross - currentGross), cash / (1 + cost));
    if (buyGross <= 0) continue;
    shares.set(code, (currentGross + buyGross) / price);
    cash -= buyGross * (1 + cost);
    turnover += buyGross / Math.max(nav, Number.EPSILON);
    totalCosts += buyGross * cost;
    nav = portfolioValue(cash, shares, pointByCode, date);
  }
  return { cash, shares, turnover, totalCosts };
}

function isInvested(kind, point, previous) {
  if (kind === "always") return true;
  if (!point?.ma20 || !point?.ma60 || !point?.high60) return null;
  if (kind === "ma20") return point.close >= point.ma20;
  if (kind === "ma60") return point.close >= point.ma60;
  if (kind === "ma60-buffer") {
    if (point.close < point.ma60 * 0.98) return false;
    if (point.close > point.ma60 * 1.02) return true;
    return previous ?? point.close >= point.ma60;
  }
  const dual = point.close >= point.ma60 && point.ma20 >= point.ma60;
  if (kind === "dual-ma") return dual;
  const threshold = kind === "dd15-dual" ? 0.85 : 0.80;
  return dual && point.close / point.high60 > threshold;
}

function portfolioValue(cash, shares, pointByCode, date) {
  let value = cash;
  for (const [code, quantity] of shares) {
    const price = pointByCode.get(code)?.get(date)?.close;
    if (price) value += quantity * price;
  }
  return value;
}

function exposure(shares, nav, pointByCode, date) {
  if (!nav) return 0;
  let value = 0;
  for (const [code, quantity] of shares) value += quantity * (pointByCode.get(code)?.get(date)?.close ?? 0);
  return value / nav;
}

function summarize(strategy, curve, turnover, totalCosts, signalChanges, selectedCount) {
  const peak = { value: 0 };
  let maxDrawdown = 0;
  let exposureSum = 0;
  for (const point of curve) {
    peak.value = Math.max(peak.value, point.nav);
    maxDrawdown = Math.min(maxDrawdown, point.nav / peak.value - 1);
    exposureSum += point.stockExposure;
  }
  const start = curve[0].nav;
  const end = curve.at(-1).nav;
  const years = Math.max((curve.length - 1) / 252, 1 / 252);
  const returns = curve.slice(1).map((point, index) => point.nav / curve[index].nav - 1);
  const volatility = standardDeviation(returns) * Math.sqrt(252);
  return {
    ...strategy,
    start: curve[0].date,
    end: curve.at(-1).date,
    cagr: (end / start) ** (1 / years) - 1,
    maxDrawdown,
    volatility,
    calmar: maxDrawdown ? ((end / start) ** (1 / years) - 1) / Math.abs(maxDrawdown) : null,
    turnover,
    totalCosts,
    signalChanges,
    averageExposure: exposureSum / curve.length,
    endingNav: end,
    selectedCount,
  };
}

function renderReport({ baseUrl, from, to, oneWayCost: cost, universe, schedules, results }) {
  const rows = [...results].sort((a, b) => b.calmar - a.calmar);
  return `# 机构持仓 Top100：个股风控规则回测（初步）\n\n> 生成日期：${new Date().toISOString().slice(0, 10)}；行情截止：${to}。本报告是策略研究，不构成投资建议。\n\n## 回测结论\n\n以下结果只适用于本定义的、滚动机构持仓 Top100 等权股票篮子；不能直接外推到单一个股，更不能保证未来收益或回撤。按回撤收益比（Calmar）排序的候选中，应优先比较换手、持仓暴露和执行难度，而不是只选择历史数值最高者。\n\n| 规则 | 年化收益 | 年化波动 | 最大回撤 | Calmar | 平均股票暴露 | 累计换手 | 信号切换 | 成本拖累 |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${rows.map((row) => `| ${row.name} | ${pct(row.cagr)} | ${pct(row.volatility)} | ${pct(row.maxDrawdown)} | ${row.calmar.toFixed(2)} | ${pct(row.averageExposure)} | ${(row.turnover * 100).toFixed(1)}% | ${row.signalChanges} | ${pct(row.totalCosts)} |`).join("\n")}\n\n## 固定的策略定义\n\n- 每季按全机构汇总持仓市值（\`HOLD_VALUE\`）取前100只 A 股，等权配置；持仓榜在可获得日期后才换仓。报告披露可用日采用保守的完整报告截止日：一季报后5月1日、中报后9月1日、三季报后11月1日、年报后次年4月1日，再取其后的首个交易日。\n- 信号仅使用**前一交易日**前复权收盘价，交易记在下一交易日收盘；不存在用当天收盘价产生信号、再以同一收盘价成交的前视偏差。\n- 卖出的资金留为现金，未把它重新加到仍在持有的股票；重新转强时只恢复该股票约1%的初始等权仓。现金收益记为0%，因此并未把货币基金收益算入风控策略。\n- 每笔买卖假定单边总摩擦 ${Math.round(cost * 10_000)}bp（佣金、印花税和滑点的简化合并假设）；没有模拟涨跌停、停牌无法成交、冲击成本和个股最低佣金。\n- MA20、MA60、60日高点均按各股票自身前复权收盘价计算。双均线“转空”为收盘低于MA60且MA20低于MA60；恢复要求二者同时重新转多。\n\n## 样本与限制\n\n- 成分股报告期：${schedules.map((item) => item.reportDate).join("、")}；形成日期：${schedules.map((item) => item.tradeDate).join("、")}。实际策略样本为 ${results[0].start} 至 ${results[0].end}，仅约两年多，包含的完整熊市/牛市周期有限。\n- 历史成分股有 ${universe} 只不同股票，使用东方财富经 \`${baseUrl}\` 转发的日线前复权价格。此设计避免使用今天的Top100回看过去的主要幸存者偏差，但不能消除季度披露滞后、数据修订及前复权口径的局限。\n- 这是“机构重仓个股篮子”的组合规则，不是对基本面已证伪、财务造假、连续跌停等事件的替代。此类事件仍须走基本面紧急退出规则。\n- 先在这个预先定义的规则集合中比较，再做未来新季度的走样本外跟踪；不要因回测中某个参数最好而继续细调到历史最优。\n\n## 数据来源\n\n- 机构持仓：东方财富 \`/api/companies/holding/rank\`，\`type=0\`、\`rank=HOLD_VALUE\`，每个报告期前两页。\n- 行情：东方财富日线前复权，\`/api/kline?period=day&fq=qfq\`。\n`;
}

function availabilityDate(reportDate) {
  const [year, month] = reportDate.split("-").map(Number);
  if (month === 3) return `${year}-05-01`;
  if (month === 6) return `${year}-09-01`;
  if (month === 9) return `${year}-11-01`;
  return `${year + 1}-04-01`;
}

function quarterEndsBetween(start, end) {
  const dates = [];
  for (let year = Number(start.slice(0, 4)); year <= Number(end.slice(0, 4)); year += 1) {
    for (const tail of ["03-31", "06-30", "09-30", "12-31"]) {
      const date = `${year}-${tail}`;
      if (date >= start && date <= end) dates.push(date);
    }
  }
  return dates;
}

function nextTradingDate(dates, availableDate) { return dates.find((date) => date >= availableDate) ?? null; }
function average(values) { return values.reduce((sum, value) => sum + value, 0) / values.length; }
function standardDeviation(values) {
  if (values.length < 2) return 0;
  const mean = average(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
}
function pct(value) { return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`; }

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

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    if (!values[index].startsWith("--")) throw new Error(`unexpected argument: ${values[index]}`);
    parsed[values[index].slice(2)] = values[++index];
  }
  return parsed;
}
