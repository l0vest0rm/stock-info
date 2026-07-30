#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeBuyPoint } from "./lib/buy-point-analysis.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    process.exit(0);
  }
  const code = normalizeCode(options.code);
  const asOf = options.asOf ?? new Date().toISOString().slice(0, 10);
  const from = options.from ?? shiftYear(asOf, -1);
  const baseUrl = options.baseUrl ?? "https://tinfo.cc";
  const configPath = path.resolve(options.config ?? path.join(repositoryRoot, "web/src/config/buy-point-analysis.json"));
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const rawRows = await fetchKline(baseUrl, code, from, asOf);
  const result = { code, source: "eastmoney", from, to: asOf, ...analyzeBuyPoint(rawRows, config) };
  console.log(options.json ? JSON.stringify(result, null, 2) : renderText(result));
} catch (error) {
  console.error(`买点分析失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

async function fetchKline(baseUrl, code, from, to) {
  const url = new URL("/api/kline", baseUrl);
  for (const [key, value] of Object.entries({ code, period: "day", fq: "qfq", from, to })) url.searchParams.set(key, value);
  const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(45_000) });
  if (!response.ok) throw new Error(`K-line API returned HTTP ${response.status}: ${url}`);
  const body = await response.json();
  if (body?.code !== 200 || !Array.isArray(body.data)) throw new Error(`invalid K-line response from ${url}`);
  return body.data;
}

function renderText(result) {
  const { decision, scores, returns, decline, indicators, levels } = result;
  const lines = [
    `${result.code} 买点分析（${result.date}，前复权日 K，${result.bars} 根）`,
    `结论：${decision.status} — ${decision.reason}`,
    `成熟度：${scores.total}/100（超跌 ${scores.setup} + 确认 ${scores.confirmation} + 趋势 ${scores.trend} - 风险 ${scores.riskPenalty}）`,
    "",
    `价格：收盘 ${price(result.close)}；3/5/10/20 日涨跌 ${pct(returns.day3)} / ${pct(returns.day5)} / ${pct(returns.day10)} / ${pct(returns.day20)}`,
    `下跌：近 10 日 ${decline.downDays10} 天下跌，下跌日复合 ${pct(decline.downDayReturn10)}；连续下跌 ${decline.consecutiveDown} 天（${pct(decline.consecutiveReturn)}）`,
    `反弹/回撤：20 日高点回撤 ${pct(decline.drawdown20)}；自 ${decline.reboundFromDate} 低点以来 ${decline.reboundBars} 个交易日反弹 ${pct(decline.rebound20)}`,
    `均线：MA5 ${price(indicators.ma5)}，MA10 ${price(indicators.ma10)}，MA20 ${price(indicators.ma20)}，MA60 ${price(indicators.ma60)}；MA20 近 5 日斜率 ${pct(indicators.ma20SlopePct)}`,
    `动量/风险：RSI14 ${indicators.rsi14.toFixed(1)}；ATR14 ${price(indicators.atr14)}（${pct(indicators.atrPct, false)}）`,
    `量能：当日/20日均量 ${ratio(indicators.volumeRatio)}；5日/20日均量 ${ratio(indicators.volumeShortRatio)}；上涨日/下跌日均量 ${ratio(indicators.upDownVolumeRatio)}`,
    `流动性：当日成交额 ${compact(indicators.latestAmount)}；20日平均成交额 ${compact(indicators.amountMa20)}；当日换手率 ${nullablePct(indicators.latestTurnover)}；20日平均换手率 ${nullablePct(indicators.turnoverMa20)}；数据覆盖 ${pct(indicators.liquidityCoverage * 100, false)}`,
    `量价风险：${result.flags.volumeContraction ? "下跌缩量" : "未出现下跌缩量"}；${result.flags.distributionRisk ? "放量下跌" : "未触发放量下跌"}；${result.flags.lowLiquidity ? "流动性不足" : indicators.liquidityCoverage > 0 ? "流动性门槛通过" : "流动性数据不足"}`,
    "",
    `20 日支撑观察区：${price(levels.supportZone[0])}–${price(levels.supportZone[1])}`,
    `右侧确认触发：下一收盘有效站上 ${price(levels.confirmationTrigger)}（MA5 与前一日高点取较高值）`,
    `参考失效位：${price(levels.invalidation)}（20 日低点下方 1×ATR；触发后停止加仓并重新评估）`,
    `当前证据：${result.evidence.length ? result.evidence.join("；") : "无显著信号"}`,
    "",
    "执行纪律：先等收盘确认，计划分批买入时用“单笔可承受亏损 ÷（计划买价−失效位）”反推仓位；不要因下跌继续无上限补仓。",
    "提示：这是基于历史价格与成交量的规则化观察，不包含估值、基本面、事件风险和个人资金约束，不构成投资建议。",
  ];
  return lines.join("\n");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--code") options.code = requireValue(argv, ++index, arg);
    else if (arg === "--from") options.from = requireValue(argv, ++index, arg);
    else if (arg === "--as-of") options.asOf = requireValue(argv, ++index, arg);
    else if (arg === "--base-url") options.baseUrl = requireValue(argv, ++index, arg);
    else if (arg === "--config") options.config = requireValue(argv, ++index, arg);
    else if (!arg.startsWith("-") && !options.code) options.code = arg;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.help && !options.code) throw new Error("missing stock code; use --code 688256 or pass 688256 directly");
  return options;
}

function normalizeCode(input) {
  const raw = String(input ?? "").trim().toUpperCase();
  if (/^\d{6}$/.test(raw)) return `${raw}.${raw.startsWith("5") || raw.startsWith("6") || raw.startsWith("9") ? "SH" : "SZ"}`;
  if (/^(SH|SZ|BJ)\d{6}$/.test(raw)) return `${raw.slice(2)}.${raw.slice(0, 2)}`;
  if (/^\d{6}\.(SH|SZ|BJ)$/.test(raw)) return raw;
  throw new Error(`unsupported stock code: ${input}`);
}

function requireValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function shiftYear(date, amount) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`invalid date: ${date}`);
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year + amount, month - 1, day));
  if (shifted.getUTCMonth() !== month - 1) shifted.setUTCDate(0);
  return shifted.toISOString().slice(0, 10);
}

function price(value) { return value >= 100 ? value.toFixed(2) : value >= 10 ? value.toFixed(3) : value.toFixed(4); }
function pct(value, signed = true) { return `${signed && value > 0 ? "+" : ""}${value.toFixed(2)}%`; }
function ratio(value) { return value === null ? "—" : `${value.toFixed(2)} 倍`; }
function nullablePct(value) { return value === null ? "—" : `${value.toFixed(2)}%`; }
function compact(value) {
  if (value === null) return "—";
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(2)} 亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(2)} 万`;
  return value.toFixed(0);
}

function printUsage() {
  console.log(`用法：npm run analyze:buy-point -- <股票代码> [选项]

示例：npm run analyze:buy-point -- 688256

选项：
  --code CODE       股票代码；支持 688256、SH688256、688256.SH
  --as-of DATE      分析截止日期，默认今天
  --from DATE       K 线起始日期，默认截止日期前一年
  --base-url URL    stock-info API 地址，默认 https://tinfo.cc
  --config FILE     指标阈值配置文件
  --json            输出机器可读 JSON
  -h, --help        显示帮助`);
}
