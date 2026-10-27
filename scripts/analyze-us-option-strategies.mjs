#!/usr/bin/env node
/**
 * Compare option strategies for a US-listed equity.
 *
 * Mirrors scripts/compare-option-strategies.mjs but adapts the US conventions:
 *   - contract multiplier 100 (not 10,000)
 *   - weekly + monthly expiries, so expiry choice is a real dimension
 *   - live bid/ask on every strike, so no vendor gap-filling is needed
 *
 * Strikes always come from the REAL listed chain, never from a moneyness multiple.
 *
 * Usage:
 *   node scripts/analyze-us-option-strategies.mjs --code NVDA.US
 *   node scripts/analyze-us-option-strategies.mjs --code MU.US --dir data/research/us-options/MU
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { bsPrice, impliedVol, realizedVol, quantile } from "./lib/option-pricing.mjs";

const RISK_FREE_RATE = 0.042; // USD short rate proxy; documented, not tuned
const TRADING_DAYS = 252; // US convention
const MULTIPLIER = 100;

function parseArgs(argv) {
  const options = { code: "NVDA.US", dir: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--code") options.code = next();
    else if (a === "--dir") options.dir = next();
    else if (a === "--out") options.out = next();
    else if (a === "--help" || a === "-h") options.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return options;
}

function ewmaVol(closes, lambda = 0.94, seedWindow = 60) {
  if (closes.length < seedWindow + 2) return null;
  const rets = [];
  for (let i = 1; i < closes.length; i += 1) rets.push(Math.log(closes[i] / closes[i - 1]));
  const seed = rets.slice(0, seedWindow);
  const m = seed.reduce((a, b) => a + b, 0) / seed.length;
  let v = seed.reduce((a, b) => a + (b - m) ** 2, 0) / (seed.length - 1);
  for (let i = seedWindow; i < rets.length; i += 1) v = lambda * v + (1 - lambda) * rets[i] * rets[i];
  return Math.sqrt(v * TRADING_DAYS) * 100;
}

function blendedVol(closes) {
  const parts = [realizedVol(closes, 20), realizedVol(closes, 60), ewmaVol(closes)].filter((v) => v !== null);
  return parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
}

function calendarDaysBetween(fromIso, toIso) {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  if (!(Number.isFinite(a) && Number.isFinite(b))) return null;
  return Math.round((b - a) / 86_400_000);
}

function tradingDaysBetween(fromIso, toIso) {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  if (!(Number.isFinite(a) && Number.isFinite(b)) || b <= a) return 0;
  let n = 0;
  for (let t = a + 86_400_000; t <= b; t += 86_400_000) {
    const d = new Date(t).getUTCDay();
    if (d !== 0 && d !== 6) n += 1;
  }
  return n;
}

/** ATM implied vol from the chain, using mid prices. */
function atmIv(contracts, spot, T) {
  const pts = [];
  for (const c of contracts) {
    if (!(c.mid > 0) || !(c.strike > 0)) continue;
    const iv = impliedVol(c.mid, spot, c.strike, T, RISK_FREE_RATE, "call");
    if (iv && iv > 0.01 && iv < 5) pts.push({ strike: c.strike, ivPct: iv * 100 });
  }
  if (pts.length < 3) return null;
  pts.sort((a, b) => a.strike - b.strike);
  let lo = null, hi = null;
  for (const p of pts) { if (p.strike <= spot) lo = p; if (p.strike >= spot && !hi) hi = p; }
  if (lo && hi && lo.strike !== hi.strike) {
    const w = (spot - lo.strike) / (hi.strike - lo.strike);
    return { atmPct: lo.ivPct * (1 - w) + hi.ivPct * w, points: pts };
  }
  return lo || hi ? { atmPct: (lo ?? hi).ivPct, points: pts } : null;
}

/** Nearest listed strike to a target price. */
function nearestStrike(contracts, target) {
  const ks = contracts.map((c) => c.strike).filter((k) => k > 0);
  if (ks.length === 0) return null;
  return ks.reduce((b, k) => (Math.abs(k - target) < Math.abs(b - target) ? k : b), ks[0]);
}

function settle(legs, exitSpot, entrySpot) {
  let pnl = 0;
  for (const leg of legs) {
    const intrinsic = leg.type === "call" ? Math.max(0, exitSpot - leg.strike) : Math.max(0, leg.strike - exitSpot);
    const dir = leg.side === "long" ? 1 : -1;
    pnl += dir * (intrinsic - leg.price) * leg.qty;
  }
  return pnl / entrySpot;
}

/**
 * Historical replay with model pricing.
 * IV proxy: trailing realized vol scaled by today's IV/forecast ratio, so historical
 * entries carry a similar volatility-risk-premium to the live board.
 */
function replay(legSpecs, closes, dates, horizon, { ivRatio, ivFloor = 0.1, ivCap = 3 }) {
  const out = [];
  for (let i = 60; i + horizon < closes.length; i += 1) {
    const spot = closes[i];
    const rv = realizedVol(closes.slice(0, i + 1), 60);
    if (rv === null) continue;
    const sigma = Math.min(ivCap, Math.max(ivFloor, (rv / 100) * ivRatio));
    const T = horizon / TRADING_DAYS;
    const legs = legSpecs.map((spec) => ({
      type: spec.type,
      side: spec.side,
      strike: Math.round(spot * (spec.strikeMult) * 100) / 100,
      price: bsPrice(spot, Math.round(spot * spec.strikeMult * 100) / 100, T, RISK_FREE_RATE, sigma, spec.type),
      qty: 1,
    }));
    const exitSpot = closes[i + horizon];
    out.push({
      entryDate: dates[i],
      returnOnSpot: settle(legs, exitSpot, spot),
      sigmaPct: sigma * 100,
    });
  }
  return out;
}

function summarize(rows, label) {
  if (rows.length === 0) return null;
  const rs = rows.map((r) => r.returnOnSpot).sort((a, b) => a - b);
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = (xs) => { const m = mean(xs); return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1)); };
  const wins = rs.filter((r) => r > 0);
  const losses = rs.filter((r) => r < 0);
  return {
    label, n: rows.length,
    avg: mean(rs), median: quantile(rs, 0.5), stdev: sd(rs),
    worst: rs[0], p05: quantile(rs, 0.05), p95: quantile(rs, 0.95), best: rs[rs.length - 1],
    winRate: wins.length / rs.length,
    returnPerRisk: sd(rs) > 0 ? mean(rs) / sd(rs) : null,
    payoffRatio: wins.length && losses.length ? mean(wins) / Math.abs(mean(losses)) : null,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log("node scripts/analyze-us-option-strategies.mjs --code NVDA.US [--dir DIR] [--out DIR]"); return; }
  const code = options.code.toUpperCase().endsWith(".US") ? options.code.toUpperCase() : `${options.code.toUpperCase()}.US`;
  const dir = path.resolve(options.dir ?? `data/research/us-options/${code.replace(/\.US$/, "")}`);
  const outDir = path.resolve(options.out ?? dir);
  await mkdir(outDir, { recursive: true });

  const chain = JSON.parse(await readFile(path.join(dir, "option-chain.json"), "utf8"));
  const kline = JSON.parse(await readFile(path.join(dir, "kline-qfq.json"), "utf8")).rows;
  const closes = kline.map((r) => r.close);
  const dates = kline.map((r) => r.date);
  const spot = chain.underlying.price ?? closes.at(-1);
  const asOf = chain.tradeDate;

  const volForecast = blendedVol(closes);

  // Build per-expiry analysis from the REAL chains.
  const expiryAnalysis = [];
  for (const c of chain.chains) {
    const td = tradingDaysBetween(asOf, c.expiry);
    if (td <= 0) continue;
    const T = td / TRADING_DAYS;
    const ivInfo = atmIv(c.calls, spot, T);
    const iv = ivInfo?.atmPct ?? volForecast;
    const ivRatio = volForecast ? iv / volForecast : 1;

    const listed = [...new Set(c.calls.map((x) => x.strike))].sort((a, b) => a - b);
    const atmK = nearestStrike(c.calls, spot);
    const callAt = (k) => c.calls.find((x) => x.strike === k) ?? null;
    const putAt = (k) => c.puts.find((x) => x.strike === k) ?? null;

    // Standard structure set, all struck on listed levels.
    const structures = [];
    /** Annotate payoff bounds so the report never shows a meaningless "unlimited" loss. */
    const annotate = (st) => {
      const longOnly = st.legs.every((l) => l.side === "long");
      const hasShort = st.legs.some((l) => l.side === "short");
      let maxGainText;
      let maxLossText;
      if (hasShort && st.maxGainOnSpot !== undefined) {
        maxGainText = pct(st.maxGainOnSpot, 1);
        maxLossText = pct(st.maxLossOnSpot, 1);
      } else if (longOnly) {
        maxGainText = "无上限";
        maxLossText = `-$${fx(st.capitalPerContract, 0)}（权利金全损）`;
      } else if (st.legs[0].kind === "put") {
        maxGainText = `$${fx(st.legs[0].execPrice * MULTIPLIER, 0)}`;
        maxLossText = `-$${fx((st.legs[0].strike - st.legs[0].execPrice) * MULTIPLIER, 0)}（标的大跌时）`;
      } else {
        maxGainText = `$${fx(st.legs[0].execPrice * MULTIPLIER, 0)}`;
        maxLossText = "理论无上限";
      }
      structures.push({ ...st, maxGainText, maxLossText });
    };

    const addLong = (k) => {
      const ct = callAt(k);
      if (!ct?.executableAsk) return;
      annotate({
        id: `long_call_${k}`, name: `买入认购 ${k}`, family: "买方·方向",
        legs: [{ kind: "call", side: "long", strike: k, execPrice: ct.executableAsk, mid: ct.mid, oi: ct.openInterest }],
        capitalPerContract: ct.executableAsk * MULTIPLIER,
      });
    };
    addLong(atmK);
    addLong(nearestStrike(c.calls, spot * 1.05));
    addLong(nearestStrike(c.calls, spot * 1.1));

    // Bull call spreads across listed strikes.
    const above = listed.filter((k) => k > atmK);
    for (const shortK of above.slice(0, 5)) {
      const l = callAt(atmK), sShort = callAt(shortK);
      if (!l?.executableAsk || !sShort?.executableBid) continue;
      const debit = l.executableAsk - sShort.executableBid;
      if (!(debit > 0)) continue;
      annotate({
        id: `bull_call_${atmK}_${shortK}`,
        name: `牛市认购价差 ${atmK}/${shortK}`, family: "组合·垂直价差",
        legs: [
          { kind: "call", side: "long", strike: atmK, execPrice: l.executableAsk, mid: l.mid, oi: l.openInterest },
          { kind: "call", side: "short", strike: shortK, execPrice: sShort.executableBid, mid: sShort.mid, oi: sShort.openInterest },
        ],
        capitalPerContract: debit * MULTIPLIER,
        maxGainOnSpot: ((shortK - atmK) - debit) / spot,
        maxLossOnSpot: -debit / spot,
      });
    }

    // Long straddle at ATM.
    {
      const cO = callAt(atmK), pO = putAt(atmK);
      if (cO?.executableAsk && pO?.executableAsk) {
        annotate({
          id: `straddle_${atmK}`, name: `买入跨式 ${atmK}`, family: "买方·波动",
          legs: [
            { kind: "call", side: "long", strike: atmK, execPrice: cO.executableAsk, mid: cO.mid, oi: cO.openInterest },
            { kind: "put", side: "long", strike: atmK, execPrice: pO.executableAsk, mid: pO.mid, oi: pO.openInterest },
          ],
          capitalPerContract: (cO.executableAsk + pO.executableAsk) * MULTIPLIER,
        });
      }
    }

    // Cash-secured short put at -10%.
    {
      const k = nearestStrike(c.puts, spot * 0.9);
      const pO = putAt(k);
      if (pO?.executableBid) {
        annotate({
          id: `short_put_${k}`, name: `卖出认沽 ${k}`, family: "卖方·收租",
          legs: [{ kind: "put", side: "short", strike: k, execPrice: pO.executableBid, mid: pO.mid, oi: pO.openInterest }],
          capitalPerContract: k * MULTIPLIER,
        });
      }
    }

    expiryAnalysis.push({
      expiry: c.expiry,
      calendarDays: calendarDaysBetween(asOf, c.expiry),
      tradingDays: td,
      atmIvPct: ivInfo?.atmPct ?? null,
      ivMinusForecastPct: ivInfo ? ivInfo.atmPct - (volForecast ?? 0) : null,
      atmStrike: atmK,
      listedStrikes: listed.length,
      calls: c.calls.length,
      puts: c.puts.length,
      totalCallOi: c.calls.reduce((a, x) => a + (x.openInterest ?? 0), 0),
      structures,
    });
  }

  // Historical replay for the main structures at each available horizon.
  const replayRows = [];
  for (const e of expiryAnalysis) {
    const horizon = e.tradingDays;
    const ivRatio = volForecast && e.atmIvPct ? e.atmIvPct / volForecast : 1;
    const specs = [
      { id: "long_call_atm", name: "买入认购(平值)", family: "买方·方向", legs: [{ type: "call", side: "long", strikeMult: 1.0 }] },
      { id: "long_call_10", name: "买入认购(虚10%)", family: "买方·方向", legs: [{ type: "call", side: "long", strikeMult: 1.1 }] },
      { id: "bull_call_10", name: "牛市认购价差(平值/虚10%)", family: "组合·垂直价差", legs: [
        { type: "call", side: "long", strikeMult: 1.0 },
        { type: "call", side: "short", strikeMult: 1.1 },
      ] },
      { id: "bull_call_15", name: "牛市认购价差(平值/虚15%)", family: "组合·垂直价差", legs: [
        { type: "call", side: "long", strikeMult: 1.0 },
        { type: "call", side: "short", strikeMult: 1.15 },
      ] },
      { id: "straddle", name: "买入跨式(平值)", family: "买方·波动", legs: [
        { type: "call", side: "long", strikeMult: 1.0 },
        { type: "put", side: "long", strikeMult: 1.0 },
      ] },
    ];
    for (const s of specs) {
      const rows = replay(s.legs, closes, dates, horizon, { ivRatio });
      const summary = summarize(rows, s.name);
      if (summary) replayRows.push({ ...summary, strategyId: s.id, family: s.family, expiry: e.expiry, horizon });
    }
  }

  // Buy-and-hold baseline per horizon.
  const baselines = [];
  for (const e of [...new Set(expiryAnalysis.map((x) => x.tradingDays))]) {
    const rets = [];
    for (let i = 0; i + e < closes.length; i += 1) rets.push(closes[i + e] / closes[i] - 1);
    if (rets.length === 0) continue;
    rets.sort((a, b) => a - b);
    const nonOverlap = [];
    for (let i = 0; i + e < closes.length; i += e) nonOverlap.push(closes[i + e] / closes[i] - 1);
    baselines.push({
      tradingDays: e,
      n: rets.length,
      median: quantile(rets, 0.5),
      mean: rets.reduce((a, b) => a + b, 0) / rets.length,
      p05: quantile(rets, 0.05),
      p95: quantile(rets, 0.95),
      nonOverlappingMean: nonOverlap.reduce((a, b) => a + b, 0) / nonOverlap.length,
      nonOverlappingN: nonOverlap.length,
    });
  }

  // Downside/tail context for the underlying.
  // Track the running peak date at the moment of the worst drawdown, not the final peak.
  let peak = -Infinity;
  let runningPeakDate = "";
  let worstPeakDate = "";
  let troughDate = "";
  let maxDrawdown = 0;
  for (let i = 0; i < closes.length; i += 1) {
    if (closes[i] > peak) { peak = closes[i]; runningPeakDate = dates[i]; }
    const dd = closes[i] / peak - 1;
    if (dd < maxDrawdown) { maxDrawdown = dd; troughDate = dates[i]; worstPeakDate = runningPeakDate; }
  }
  // Tail stats on a recent window measured in BARS, not calendar days, because some
  // tickers have listing gaps (e.g. SNDK delisted in 2016 and relisted in 2025).
  // Slicing by date would silently mix pre-delisting data with the current company.
  const recent = closes.slice(-756); // ~3 years of trading
  const recentDates = dates.slice(-756);
  const hasGap = (() => {
    for (let i = 1; i < recentDates.length; i += 1) {
      const gap = (Date.parse(`${recentDates[i]}T00:00:00Z`) - Date.parse(`${recentDates[i - 1]}T00:00:00Z`)) / 86_400_000;
      if (gap > 30) return { after: recentDates[i - 1], before: recentDates[i], gapDays: Math.round(gap) };
    }
    return null;
  })();
  const fwd21 = [];
  for (let i = 0; i + 21 < recent.length; i += 1) fwd21.push(recent[i + 21] / recent[i] - 1);
  fwd21.sort((a, b) => a - b);

  const result = {
    code, symbol: chain.symbol, asOf, spot,
    historyBars: closes.length,
    volForecastPct: volForecast,
    hv20: realizedVol(closes, 20),
    hv60: realizedVol(closes, 60),
    hv252: realizedVol(closes, 252),
    maxDrawdownPct: maxDrawdown * 100,
    maxDrawdownPeriod: { peakDate: worstPeakDate, troughDate },
    tailWindow: { from: recentDates[0], to: recentDates[recentDates.length - 1], bars: recent.length, listingGap: hasGap },
    probUp10_21d: fwd21.filter((r) => r > 0.1).length / fwd21.length,
    probUp20_21d: fwd21.filter((r) => r > 0.2).length / fwd21.length,
    p95_21d: quantile(fwd21, 0.95),
    p05_21d: quantile(fwd21, 0.05),
    expiryAnalysis,
    replayRows,
    baselines,
    assumptions: {
      multiplier: MULTIPLIER,
      riskFreeRate: RISK_FREE_RATE,
      tradingDaysPerYear: TRADING_DAYS,
      note: "US options: buyer pays ask, seller receives bid; no early-assignment modelling.",
    },
  };

  await writeFile(path.join(outDir, "strategy-analysis.json"), JSON.stringify(result, null, 1));
  const md = render(result);
  await writeFile(path.join(outDir, "strategy-analysis.md"), md);
  console.log(md);
}

function pct(x, d = 2) { return x === null || x === undefined || Number.isNaN(x) ? "—" : `${(x * 100).toFixed(d)}%`; }
function fx(x, d = 2) { return x === null || x === undefined || Number.isNaN(x) ? "—" : x.toFixed(d); }

function render(r) {
  const L = [];
  const p = (...x) => L.push(...x);
  p(`# ${r.code} 美股期权策略分析`, "");
  p(`- 基准日：**${r.asOf}**，标的价 **${fx(r.spot)}**`);
  p(`- 波动率预测（20/60日+EWMA）：**${fx(r.volForecastPct)}%**｜20日HV ${fx(r.hv20)}%｜60日HV ${fx(r.hv60)}%｜252日HV ${fx(r.hv252)}%`);
  p(`- 历史最大回撤：**${fx(r.maxDrawdownPct)}%**（${r.maxDrawdownPeriod.peakDate} → ${r.maxDrawdownPeriod.troughDate}）`);
  p(`- 近3年尾部（${r.tailWindow.from} ~ ${r.tailWindow.to}，${r.tailWindow.bars}根K线）：21日涨超10%概率 ${pct(r.probUp10_21d, 1)}｜涨超20%概率 ${pct(r.probUp20_21d, 1)}｜P95 ${pct(r.p95_21d, 1)}｜P05 ${pct(r.p05_21d, 1)}`);
  if (r.tailWindow.listingGap) {
    p(`- ⚠️ 数据断层：${r.tailWindow.listingGap.after} → ${r.tailWindow.listingGap.before}（间隔 ${r.tailWindow.listingGap.gapDays} 天，可能为退市/重新上市），该窗口内统计需谨慎解读`);
  }
  p(`- 合约乘数 ${r.assumptions.multiplier}｜无风险利率 ${(r.assumptions.riskFreeRate * 100).toFixed(1)}%`, "");

  p("## 1. 到期日与 IV 结构", "");
  p("| 到期日 | 日历天 | 交易日 | ATM IV | IV-预测 | ATM行权价 | 档位数 | 认购持仓 |", "|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const e of r.expiryAnalysis) {
    p(`| ${e.expiry} | ${e.calendarDays} | ${e.tradingDays} | ${fx(e.atmIvPct)}% | ${e.ivMinusForecastPct === null ? "—" : (e.ivMinusForecastPct > 0 ? "+" : "") + fx(e.ivMinusForecastPct)}pt | ${fx(e.atmStrike)} | ${e.listedStrikes} | ${e.totalCallOi.toLocaleString()} |`);
  }
  p("");

  p("## 2. 可交易结构（真实盘口价）", "");
  p("| 到期日 | 结构 | 腿 | 每组合成本 | 最大收益 | 最大亏损 |", "|---|---|---|---:|---:|---:|");
  for (const e of r.expiryAnalysis) {
    for (const s of e.structures) {
      const legs = s.legs.map((l) => `${l.side === "long" ? "买" : "卖"}${l.kind === "call" ? "购" : "沽"}${l.strike}@${fx(l.execPrice, 2)}`).join(" + ");
      p(`| ${e.expiry} | ${s.name} | ${legs} | $${fx(s.capitalPerContract, 0)} | ${s.maxGainText ?? "—"} | ${s.maxLossText ?? "—"} |`);
    }
  }
  p("");

  p("## 3. 历史回放（真实价格路径结算）", "");
  const sampleCounts = [...new Set(r.replayRows.map((x) => x.n))].sort((a, b) => a - b);
  const minSamples = sampleCounts[0] ?? 0;
  if (minSamples < 30) {
    p(`> ⚠️ **样本严重不足**：该标的上市仅 ${r.historyBars} 根K线，最长期限的回放只有 ${minSamples} 个独立窗口。`);
    p(`> 下面的胜率、平均收益、P05/P95 **不具备统计意义**，只能作为「历史上发生过什么」的轶事参考。`);
    p(`> 决策应以第 1、2 节的实时盘口与 IV 结构为主。`, "");
  }
  p("| 到期日 | 期限(交易日) | 策略 | 样本 | 胜率 | 平均 | 中位 | 最差 | P05 | P95 | 收益/风险 | 盈亏比 |", "|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const row of [...r.replayRows].sort((a, b) => (b.returnPerRisk ?? -9) - (a.returnPerRisk ?? -9))) {
    p(`| ${row.expiry} | ${row.horizon} | ${row.label} | ${row.n} | ${pct(row.winRate, 0)} | ${pct(row.avg)} | ${pct(row.median)} | ${pct(row.worst)} | ${pct(row.p05)} | ${pct(row.p95)} | ${row.returnPerRisk?.toFixed(3) ?? "—"} | ${row.payoffRatio?.toFixed(2) ?? "—"} |`);
  }
  p("");

  p("## 4. 基准（直接持股）", "");
  p("| 交易日 | 样本 | 平均 | 中位 | P05 | P95 | 不重叠均值 | 不重叠样本 |", "|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const b of r.baselines) {
    p(`| ${b.tradingDays} | ${b.n} | ${pct(b.mean)} | ${pct(b.median)} | ${pct(b.p05)} | ${pct(b.p95)} | ${pct(b.nonOverlappingMean)} | ${b.nonOverlappingN} |`);
  }
  p("");
  return L.join("\n");
}

main().catch((e) => { console.error(`us strategy analysis failed: ${e.message}`); process.exitCode = 1; });
