#!/usr/bin/env node
/**
 * Long-dated (LEAPS) option analysis for a medium/long-term bullish view.
 *
 * Different question from the short-dated strategy comparison:
 *   - theta decay per day is small, so time is less of an enemy
 *   - the real cost is the premium's implied volatility and the opportunity cost
 *   - deep-ITM calls behave like leveraged stock; OTM calls are a bet on a move
 *   - a diagonal/calendar or a call spread changes the payoff shape materially
 *
 * This script pulls specific far expiries, then reports:
 *   1. cost per unit of delta (leverage efficiency)
 *   2. breakeven move required by expiry
 *   3. annualized carry / theta drag
 *   4. IV term structure across the far expiries
 *
 * Usage:
 *   node scripts/analyze-us-leaps.mjs --code NVDA.US
 *   node scripts/analyze-us-leaps.mjs --code MU.US --expiries 2027-01-15,2027-12-17,2029-01-19
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { bsGreeks, bsPrice, impliedVol, realizedVol } from "./lib/option-pricing.mjs";

const RISK_FREE_RATE = 0.042;
const TRADING_DAYS = 252;
const MULTIPLIER = 100;
const API = "http://127.0.0.1:8000";

function parseArgs(argv) {
  const options = { code: "NVDA.US", expiries: null, out: null, maxExpiries: 4 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--code") options.code = next();
    else if (a === "--expiries") options.expiries = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--max-expiries") options.maxExpiries = Number(next());
    else if (a === "--out") options.out = next();
    else if (a === "--help" || a === "-h") options.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return options;
}

async function fetchJson(url, timeoutMs = 180_000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const body = await response.json();
  if (body?.code !== 200) throw new Error(`${body?.msg ?? "api error"} (${url})`);
  return body.data;
}

function usDateToIso(label) {
  const t = Date.parse(label);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

function isoToVendor(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
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

function calendarDaysBetween(fromIso, toIso) {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** Blended realized vol, same definition as the other scripts. */
function blendedVol(closes) {
  const hv = (w) => realizedVol(closes, w);
  const parts = [hv(60), hv(120), hv(252)].filter((v) => v !== null);
  return parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
}

/**
 * Volatility forecast for LONG-dated pricing.
 *
 * Deliberately different from the short-dated scripts: a 252-day trailing HV is the
 * wrong yardstick for a 1-2 year option when the trailing year contained a 5x or 13x
 * move (MU/SNDK in 2026). Using it would make every LEAPS look "cheap" by 20-30 vol
 * points purely because the recent past was exceptional.
 *
 * Instead we blend the recent 60/120-day HV (current regime) with a long-run median
 * computed over rolling 120-day windows across all available history, which is far
 * more stable and reflects what vol this name can sustain.
 */
function longRunVolForecast(closes) {
  const recent = [realizedVol(closes, 60), realizedVol(closes, 120)].filter((v) => v !== null);
  const rolling = [];
  for (let end = 120; end <= closes.length; end += 10) {
    const v = realizedVol(closes.slice(0, end), 120);
    if (v !== null && Number.isFinite(v)) rolling.push(v);
  }
  rolling.sort((a, b) => a - b);
  const median = rolling.length ? rolling[Math.floor(rolling.length / 2)] : null;
  const parts = [...recent, ...(median !== null ? [median] : [])];
  return {
    forecastPct: parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null,
    currentRegimePct: recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : null,
    longRunMedianPct: median,
    rollingObservations: rolling.length,
  };
}

function pickLongExpiries(all, maxCount) {
  // "Long-dated" means at least ~9 months out: that is where theta is slow enough for
  // a thesis to play out. Near-dated weeklies are deliberately excluded even though the
  // API returns them.
  const MIN_DAYS = 270;
  const asOf = all.length ? all[0].asOf : null;
  const upcoming = all
    .filter((e) => e.calendarDays !== null && e.calendarDays !== undefined && e.calendarDays >= MIN_DAYS)
    .sort((a, b) => a.iso.localeCompare(b.iso));
  if (upcoming.length === 0) return [];
  // One representative per calendar year, always including the farthest.
  const byYear = new Map();
  for (const e of upcoming) {
    const y = e.iso.slice(0, 4);
    if (!byYear.has(y)) byYear.set(y, e);
  }
  const picks = [...byYear.values()];
  const farthest = upcoming[upcoming.length - 1];
  if (farthest && !picks.some((p) => p.iso === farthest.iso)) picks.push(farthest);
  // Prefer January expiries when a year has both, since Jan LEAPS are the most liquid.
  const janPreferred = upcoming.filter((e) => e.iso.slice(5, 7) === "01");
  for (const j of janPreferred) {
    const y = j.iso.slice(0, 4);
    const idx = picks.findIndex((p) => p.iso.slice(0, 4) === y);
    if (idx >= 0 && picks[idx].iso !== j.iso && picks[idx].calendarDays > 0) picks[idx] = j;
    else if (idx < 0) picks.push(j);
  }
  return picks.sort((a, b) => a.iso.localeCompare(b.iso)).slice(-maxCount);
}

async function fetchChain(code, vendorExpiry) {
  const url = new URL("/api/options/us/contracts", API);
  url.searchParams.set("code", code);
  url.searchParams.set("expirations", vendorExpiry);
  const body = await fetchJson(url.toString());
  const exp = (body.expirations ?? [])[0];
  if (!exp) return null;
  const norm = (c, kind) => {
    const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const bid = n(c.bid), ask = n(c.ask);
    return {
      kind,
      strike: n(c.strike),
      bid, ask,
      mid: bid !== null && ask !== null && bid > 0 && ask > 0 ? (bid + ask) / 2 : n(c.price),
      last: n(c.last),
      volume: n(c.volume),
      openInterest: n(c.openInterest),
      executableBid: bid !== null && bid > 0 ? bid : null,
      executableAsk: ask !== null && ask > 0 ? ask : null,
    };
  };
  return {
    expiry: usDateToIso(exp.date),
    calls: (exp.calls ?? []).map((c) => norm(c, "call")).filter((c) => c.strike > 0),
    puts: (exp.puts ?? []).map((c) => norm(c, "put")).filter((c) => c.strike > 0),
  };
}

async function fetchKline(code) {
  const url = new URL("/api/kline", API);
  url.searchParams.set("code", code);
  url.searchParams.set("period", "day");
  url.searchParams.set("fq", "qfq");
  url.searchParams.set("from", "1990-01-01");
  url.searchParams.set("format", "structured");
  return fetchJson(url.toString(), 120_000);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("node scripts/analyze-us-leaps.mjs --code NVDA.US [--max-expiries 4]");
    return;
  }
  const code = options.code.toUpperCase().endsWith(".US") ? options.code.toUpperCase() : `${options.code.toUpperCase()}.US`;
  const symbol = code.replace(/\.US$/, "");
  const outDir = path.resolve(options.out ?? `data/research/us-options/${symbol}`);
  await mkdir(outDir, { recursive: true });

  const summary = await fetchJson(`${API}/api/options/us/summary?code=${encodeURIComponent(code)}`);
  const allExpiries = (summary.expirations ?? [])
    .map((e) => ({ iso: usDateToIso(e.date), vendor: e.date }))
    .filter((e) => e.iso)
    .map((e) => ({ ...e, calendarDays: calendarDaysBetween(new Date().toISOString().slice(0, 10), e.iso) }))
    .sort((a, b) => a.iso.localeCompare(b.iso));

  const kline = await fetchKline(code);
  const closes = kline.map((r) => r.close);
  const dates = kline.map((r) => r.date);
  const spot = summary.currentPrice ?? closes.at(-1);
  const asOf = dates.at(-1);
  const volCtx = longRunVolForecast(closes);
  const volForecast = volCtx.forecastPct;

  const targets = options.expiries
    ? options.expiries.map((iso) => ({ iso, vendor: isoToVendor(iso) }))
    : pickLongExpiries(allExpiries, options.maxExpiries);

  const expiryAnalysis = [];
  for (const t of targets) {
    const chain = await fetchChain(code, t.vendor);
    if (!chain) { console.warn(`  warn: no chain for ${t.iso}`); continue; }
    const td = tradingDaysBetween(asOf, chain.expiry);
    if (td <= 0) continue;
    const cd = calendarDaysBetween(asOf, chain.expiry);
    const T = td / TRADING_DAYS;

    // ATM IV from the call side.
    const pts = [];
    for (const c of chain.calls) {
      if (!(c.mid > 0)) continue;
      const iv = impliedVol(c.mid, spot, c.strike, T, RISK_FREE_RATE, "call");
      if (iv && iv > 0.01 && iv < 5) pts.push({ strike: c.strike, ivPct: iv * 100 });
    }
    pts.sort((a, b) => a.strike - b.strike);
    let atmIv = null;
    if (pts.length) {
      let lo = null, hi = null;
      for (const p of pts) { if (p.strike <= spot) lo = p; if (p.strike >= spot && !hi) hi = p; }
      atmIv = lo && hi && lo.strike !== hi.strike
        ? lo.ivPct * (1 - (spot - lo.strike) / (hi.strike - lo.strike)) + hi.ivPct * ((spot - lo.strike) / (hi.strike - lo.strike))
        : (lo ?? hi).ivPct;
    }

    // Candidate calls: ATM-20% .. ATM+50% by listed strike, with a tradeable book.
    const candidates = [];
    for (const c of chain.calls) {
      const moneyness = c.strike / spot - 1;
      if (moneyness < -0.25 || moneyness > 0.6) continue;
      if (!(c.executableAsk > 0)) continue;
      if ((c.openInterest ?? 0) < 20) continue; // LEAPS books are thinner; 20 is a low bar
      const iv = impliedVol(c.mid ?? c.executableAsk, spot, c.strike, T, RISK_FREE_RATE, "call");
      if (!iv || iv <= 0 || iv > 5) continue;
      const greeks = bsGreeks(spot, c.strike, T, RISK_FREE_RATE, iv, "call");
      const premium = c.executableAsk;               // buyer pays ask
      const cost = premium * MULTIPLIER;
      const delta = greeks.delta;
      const leverage = delta > 0 ? (spot * delta) / premium : null;   // underlying exposure per $1 premium
      const breakeven = c.strike + premium;
      const breakevenMovePct = (breakeven / spot - 1) * 100;
      // Theta burn expressed as % of premium per month.
      const thetaPerMonthPct = premium > 0 ? (Math.abs(greeks.theta) * 21 / premium) * 100 : null;
      candidates.push({
        strike: c.strike,
        moneynessPct: moneyness * 100,
        ask: premium,
        bid: c.executableBid,
        mid: c.mid,
        cost,
        ivPct: iv * 100,
        delta,
        gamma: greeks.gamma,
        vega: greeks.vega,
        thetaPerDay: greeks.theta,
        thetaPerMonthPct,
        leverage,
        breakeven,
        breakevenMovePct,
        openInterest: c.openInterest,
        volume: c.volume,
        spreadPct: c.executableBid && c.executableAsk ? ((c.executableAsk - c.executableBid) / ((c.executableAsk + c.executableBid) / 2)) * 100 : null,
      });
    }

    expiryAnalysis.push({
      expiry: chain.expiry,
      calendarDays: cd,
      tradingDays: td,
      years: T,
      atmIvPct: atmIv,
      ivMinusForecastPct: atmIv !== null && volForecast !== null ? atmIv - volForecast : null,
      listedCalls: chain.calls.length,
      candidates,
    });
  }

  // --- What if the thesis plays out? ---
  // For each candidate, compute P&L at a set of multiple-of-spot outcomes.
  const scenarioMultiples = [0.7, 0.9, 1.0, 1.2, 1.5, 2.0];
  for (const e of expiryAnalysis) {
    for (const c of e.candidates) {
      c.scenarios = scenarioMultiples.map((m) => {
        const exitSpot = spot * m;
        const intrinsic = Math.max(0, exitSpot - c.strike);
        const pnl = (intrinsic - c.ask) * MULTIPLIER;
        return { multiple: m, exitSpot, pnl, roiPct: (pnl / c.cost) * 100 };
      });
    }
  }

  // --- Long-term realized stats (what a multi-year holder actually faced) ---
  const horizons = [{ label: "1年", days: 252 }, { label: "2年", days: 504 }];
  const holdStats = [];
  for (const h of horizons) {
    const rets = [];
    for (let i = 0; i + h.days < closes.length; i += 1) rets.push(closes[i + h.days] / closes[i] - 1);
    if (rets.length === 0) continue;
    rets.sort((a, b) => a - b);
    holdStats.push({
      label: h.label,
      n: rets.length,
      median: rets[Math.floor(rets.length / 2)],
      mean: rets.reduce((a, b) => a + b, 0) / rets.length,
      p25: rets[Math.floor(rets.length * 0.25)],
      p75: rets[Math.floor(rets.length * 0.75)],
      p05: rets[Math.floor(rets.length * 0.05)],
      p95: rets[Math.floor(rets.length * 0.95)],
      worst: rets[0],
      best: rets[rets.length - 1],
      probGain50: rets.filter((r) => r > 0.5).length / rets.length,
      probLoss30: rets.filter((r) => r < -0.3).length / rets.length,
    });
  }

  const result = {
    code, symbol, asOf, spot,
    historyBars: closes.length,
    volForecastPct: volForecast,
    volContext: volCtx,
    hv60: realizedVol(closes, 60),
    hv252: realizedVol(closes, 252),
    assumptions: { riskFreeRate: RISK_FREE_RATE, multiplier: MULTIPLIER, tradingDaysPerYear: TRADING_DAYS },
    expiryAnalysis,
    holdStats,
  };

  await writeFile(path.join(outDir, "leaps-analysis.json"), JSON.stringify(result, null, 1));
  const md = render(result);
  await writeFile(path.join(outDir, "leaps-analysis.md"), md);
  console.log(md);
}

function fx(x, d = 2) { return x === null || x === undefined || Number.isNaN(x) ? "—" : x.toFixed(d); }
function pct(x, d = 1) { return x === null || x === undefined || Number.isNaN(x) ? "—" : `${(x * 100).toFixed(d)}%`; }

function render(r) {
  const L = [];
  const p = (...x) => L.push(...x);
  p(`# ${r.code} 中长期期权（LEAPS）分析`, "");
  p(`- 基准日 **${r.asOf}**，标的价 **${fx(r.spot)}**`);
  p(`- 波动率预测 **${fx(r.volForecastPct)}%**（当前区间 ${fx(r.volContext?.currentRegimePct)}%、长期中位 ${fx(r.volContext?.longRunMedianPct)}%）`);
  p(`- 60日HV ${fx(r.hv60)}%｜252日HV ${fx(r.hv252)}%${r.hv252 && r.volContext?.longRunMedianPct && r.hv252 > r.volContext.longRunMedianPct * 1.4 ? "（252日HV 被近期极端行情拉高，不宜作为长期波动率基准）" : ""}`);
  p(`- 历史K线 ${r.historyBars} 根`, "");

  p("## 1. 远月 IV 期限结构", "");
  p("| 到期日 | 日历天 | 年数 | ATM IV | IV−预测 | 认购档位 |", "|---|---:|---:|---:|---:|---:|");
  for (const e of r.expiryAnalysis) {
    p(`| ${e.expiry} | ${e.calendarDays} | ${fx(e.years)} | ${fx(e.atmIvPct)}% | ${e.ivMinusForecastPct === null ? "—" : (e.ivMinusForecastPct > 0 ? "+" : "") + fx(e.ivMinusForecastPct)}pt | ${e.listedCalls} |`);
  }
  p("");

  for (const e of r.expiryAnalysis) {
    p(`## 2. 到期 ${e.expiry}（${fx(e.years)} 年）`, "");
    p("| 行权价 | 虚值% | 卖一价 | 每张成本 | Delta | 杠杆 | IV | 盈亏平衡 | 需涨 | Theta/月 | 持仓 |", "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
    const core = e.candidates
      .filter((c) => c.moneynessPct >= -20 && c.moneynessPct <= 55)
      .sort((a, b) => a.strike - b.strike);
    for (const c of core) {
      p(`| ${fx(c.strike, 2)} | ${fx(c.moneynessPct)}% | ${fx(c.ask, 2)} | $${fx(c.cost, 0)} | ${fx(c.delta, 2)} | ${fx(c.leverage)}x | ${fx(c.ivPct)}% | ${fx(c.breakeven, 2)} | ${fx(c.breakevenMovePct)}% | ${fx(c.thetaPerMonthPct)}% | ${c.openInterest?.toLocaleString() ?? "—"} |`);
    }
    p("");

    p(`**到期 ${e.expiry} 情景（每张 P&L）**`, "");
    const picks = e.candidates
      .filter((c) => [-0.1, 0, 0.1, 0.25].some((m) => Math.abs(c.moneynessPct - m * 100) < 6))
      .sort((a, b) => a.strike - b.strike)
      .slice(0, 5);
    if (picks.length) {
      p(`| 行权价 | 成本 | ${picks[0].scenarios.map((s) => `标的${fx(s.exitSpot, 0)}`).join(" | ")} |`);
      p(`|---:|---:|${picks[0].scenarios.map(() => "---:").join("|")}|`);
      for (const c of picks) {
        p(`| ${fx(c.strike, 2)} | $${fx(c.cost, 0)} | ${c.scenarios.map((s) => `${s.pnl >= 0 ? "+" : ""}$${fx(s.pnl, 0)}`).join(" | ")} |`);
      }
      p("");
      p(`| 行权价 | 成本 | ${picks[0].scenarios.map((s) => `标的${fx(s.exitSpot, 0)}`).join(" | ")} |`);
      p(`|---:|---:|${picks[0].scenarios.map(() => "---:").join("|")}|`);
      for (const c of picks) {
        p(`| ${fx(c.strike, 2)} | $${fx(c.cost, 0)} | ${c.scenarios.map((s) => `${fx(s.roiPct, 0)}%`).join(" | ")} |`);
      }
      p("");
    }
  }

  p("## 3. 长期持有的历史分布（直接持股基准）", "");
  p("| 期限 | 样本 | 中位 | 均值 | P05 | P25 | P75 | P95 | 最差 | 最好 | 涨超50%概率 | 跌超30%概率 |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const h of r.holdStats) {
    p(`| ${h.label} | ${h.n} | ${pct(h.median)} | ${pct(h.mean)} | ${pct(h.p05)} | ${pct(h.p25)} | ${pct(h.p75)} | ${pct(h.p95)} | ${pct(h.worst)} | ${pct(h.best)} | ${pct(h.probGain50)} | ${pct(h.probLoss30)} |`);
  }
  p("");
  return L.join("\n");
}

main().catch((e) => { console.error(`leaps analysis failed: ${e.message}`); process.exitCode = 1; });
