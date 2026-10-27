#!/usr/bin/env node
/**
 * Long-term (multi-year) bullish strategy comparison for a US equity.
 *
 * The right frame is NOT "which structure has the best ratio" but "given the SAME
 * capital, what does each structure do at various outcomes". A LEAPS with 3x leverage
 * is not comparable to stock unless you normalise the dollars committed.
 *
 * Compares, on equal capital:
 *   1. Long stock
 *   2. Long LEAPS call (ITM / ATM / OTM)
 *   3. Bull call spread (long-dated)
 *   4. Cash-secured short put (long-dated)
 *   5. Poor man's covered call (LEAPS + sell 6-month call against it)
 *
 * Usage:
 *   node scripts/compare-us-long-term-strategies.mjs --code NVDA.US --capital 10000
 */

import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { bsGreeks, bsPrice, impliedVol } from "./lib/option-pricing.mjs";

const RISK_FREE_RATE = 0.042;
const TRADING_DAYS = 252;
const MULTIPLIER = 100;
const API = "http://127.0.0.1:8000";

function parseArgs(argv) {
  const o = { code: "NVDA.US", capital: 10000, out: null, years: 2 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--code") o.code = next();
    else if (a === "--capital") o.capital = Number(next());
    else if (a === "--years") o.years = Number(next());
    else if (a === "--out") o.out = next();
    else if (a === "--help" || a === "-h") o.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

async function fetchJson(url, t = 180_000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(t), headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  const b = await r.json();
  if (b?.code !== 200) throw new Error(`${b?.msg} (${url})`);
  return b.data;
}

const iso = (label) => {
  // Nasdaq labels are US/Eastern dates. Parsing with Date.parse treats them as local
  // time, which can shift the ISO date back one day and make the API lookup miss.
  // Parse the components explicitly instead of relying on timezone conversion.
  const m = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/.exec(String(label ?? "").trim());
  if (!m) {
    const t = Date.parse(label);
    return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
  }
  const months = ["january","february","march","april","may","june","july","august","september","october","november","december"];
  const mi = months.indexOf(m[1].toLowerCase());
  if (mi < 0) return null;
  return `${m[3]}-${String(mi + 1).padStart(2, "0")}-${String(Number(m[2])).padStart(2, "0")}`;
};
const vendorDate = (isoStr) => {
  const d = new Date(`${isoStr}T00:00:00Z`);
  const m = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  return `${m[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
};
function tdays(a, b) {
  const s = Date.parse(`${a}T00:00:00Z`), e = Date.parse(`${b}T00:00:00Z`);
  if (!(Number.isFinite(s) && Number.isFinite(e)) || e <= s) return 0;
  let n = 0;
  for (let t = s + 86_400_000; t <= e; t += 86_400_000) { const d = new Date(t).getUTCDay(); if (d !== 0 && d !== 6) n += 1; }
  return n;
}

function norm(c, kind) {
  const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const bid = n(c.bid), ask = n(c.ask);
  return {
    kind, strike: n(c.strike), bid, ask, last: n(c.last),
    mid: bid !== null && ask !== null && bid > 0 && ask > 0 ? (bid + ask) / 2 : n(c.price),
    openInterest: n(c.openInterest), volume: n(c.volume),
    executableBid: bid !== null && bid > 0 ? bid : null,
    executableAsk: ask !== null && ask > 0 ? ask : null,
  };
}

async function chainFor(code, isoExpiry) {
  const url = new URL("/api/options/us/contracts", API);
  url.searchParams.set("code", code);
  url.searchParams.set("expirations", vendorDate(isoExpiry));
  const body = await fetchJson(url.toString());
  const e = (body.expirations ?? [])[0];
  if (!e) return null;
  return {
    expiry: iso(e.date),
    calls: (e.calls ?? []).map((c) => norm(c, "call")).filter((c) => c.strike > 0),
    puts: (e.puts ?? []).map((c) => norm(c, "put")).filter((c) => c.strike > 0),
  };
}

const nearest = (contracts, target) => {
  const pool = contracts.filter((c) => c.strike > 0);
  if (!pool.length) return null;
  return pool.reduce((b, c) => (Math.abs(c.strike - target) < Math.abs(b.strike - target) ? c : b));
};

/** P&L of a leg set at expiry, per contract group. */
function pnlAt(legs, exitSpot) {
  let v = 0;
  for (const l of legs) {
    const intrinsic = l.kind === "call" ? Math.max(0, exitSpot - l.strike) : Math.max(0, l.strike - exitSpot);
    const dir = l.side === "long" ? 1 : -1;
    v += dir * (intrinsic - l.price) * MULTIPLIER * l.qty;
  }
  return v;
}

/** P&L if the position is marked at a given vol/time instead of held to expiry. */
function markToMarketPnl(legs, exitSpot, remainingYears, ivAtExit) {
  let v = 0;
  for (const l of legs) {
    const dir = l.side === "long" ? 1 : -1;
    const value = remainingYears > 0
      ? bsPrice(exitSpot, l.strike, remainingYears, RISK_FREE_RATE, ivAtExit, l.kind)
      : (l.kind === "call" ? Math.max(0, exitSpot - l.strike) : Math.max(0, l.strike - exitSpot));
    v += dir * (value - l.price) * MULTIPLIER * l.qty;
  }
  return v;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log("node scripts/compare-us-long-term-strategies.mjs --code NVDA.US --capital 10000"); return; }
  const code = o.code.toUpperCase().endsWith(".US") ? o.code.toUpperCase() : `${o.code.toUpperCase()}.US`;
  const symbol = code.replace(/\.US$/, "");
  const outDir = path.resolve(o.out ?? `data/research/us-options/${symbol}`);
  await mkdir(outDir, { recursive: true });

  const summary = await fetchJson(`${API}/api/options/us/summary?code=${encodeURIComponent(code)}`);
  const spot = summary.currentPrice;
  const kline = await fetchJson((() => {
    const u = new URL("/api/kline", API);
    u.searchParams.set("code", code); u.searchParams.set("period", "day");
    u.searchParams.set("fq", "qfq"); u.searchParams.set("from", "1990-01-01");
    u.searchParams.set("format", "structured");
    return u.toString();
  })());
  const asOf = kline.at(-1).date;

  const allExp = (summary.expirations ?? []).map((e) => iso(e.date)).filter(Boolean).sort();
  // Target ~2 years out (clamped to what is listed).
  const targetDays = Math.round(o.years * 365);
  const far = allExp
    .map((e) => ({ e, d: Math.round((Date.parse(`${e}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / 86_400_000) }))
    .filter((x) => x.d > 200)
    .reduce((b, x) => (Math.abs(x.d - targetDays) < Math.abs(b.d - targetDays) ? x : b));
  if (!far) throw new Error("no long-dated expiry available");

  const longChain = await chainFor(code, far.e);
  const T = tdays(asOf, far.e) / TRADING_DAYS;

  // ATM IV from the long chain.
  const pts = [];
  for (const c of longChain.calls) {
    if (!(c.mid > 0)) continue;
    const iv = impliedVol(c.mid, spot, c.strike, T, RISK_FREE_RATE, "call");
    if (iv && iv > 0.01 && iv < 5) pts.push({ k: c.strike, iv });
  }
  const atmIv = pts.length
    ? pts.reduce((b, p) => (Math.abs(p.k - spot) < Math.abs(b.k - spot) ? p : b)).iv
    : 0.4;

  // 6-month expiry for the PMCC short leg.
  const mid = allExp
    .map((e) => ({ e, d: Math.round((Date.parse(`${e}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / 86_400_000) }))
    .filter((x) => x.d > 150 && x.d < 260)
    .reduce((b, x) => (Math.abs(x.d - 180) < Math.abs(b.d - 180) ? x : b), { e: null, d: null });
  const shortChain = mid.e ? await chainFor(code, mid.e) : null;

  const capital = o.capital;

  // --- Structures, sized to the SAME capital ------------------------------
  const structures = [];

  // 1. Long stock
  const shares = Math.floor(capital / spot);
  structures.push({
    id: "stock", name: "直接持股", kind: "stock",
    units: shares,
    capitalUsed: shares * spot,
    note: `买入 ${shares} 股`,
    legs: [],
    isStock: true,
  });

  // 2/3/4. Long LEAPS at ITM / ATM / OTM
  const leapsTargets = [
    { id: "leaps_itm", name: "LEAPS 深度实值", mult: 0.9 },
    { id: "leaps_atm", name: "LEAPS 平值", mult: 1.0 },
    { id: "leaps_otm", name: "LEAPS 虚值", mult: 1.15 },
  ];
  for (const t of leapsTargets) {
    const c = nearest(longChain.calls, spot * t.mult);
    if (!c?.executableAsk) continue;
    const cost = c.executableAsk * MULTIPLIER;
    const n = Math.floor(capital / cost);
    if (n < 1) { structures.push({ id: t.id, name: t.name, kind: "option", contracts: 0, capitalUsed: 0, note: `单张 $${cost.toFixed(0)}，资金不足`, legs: [] }); continue; }
    const iv = impliedVol(c.mid, spot, c.strike, T, RISK_FREE_RATE, "call") ?? atmIv;
    const g = bsGreeks(spot, c.strike, T, RISK_FREE_RATE, iv, "call");
    structures.push({
      id: t.id, name: `${t.name} ${c.strike}`, kind: "option",
      contracts: n, capitalUsed: n * cost,
      spotPerContract: c.strike,
      legs: [{ kind: "call", side: "long", strike: c.strike, price: c.executableAsk, qty: n }],
      lean: {
        strike: c.strike, premium: c.executableAsk, costPerContract: cost,
        delta: g.delta, leverage: (spot * g.delta) / c.executableAsk,
        ivPct: iv * 100, breakeven: c.strike + c.executableAsk,
        thetaPerDayPct: (Math.abs(g.theta) / c.executableAsk) * 100,
        openInterest: c.openInterest,
      },
      note: `买 ${n} 张，每张 $${cost.toFixed(0)}`,
    });
  }

  // 5. Bull call spread (long ATM, short +30%)
  {
    const lo = nearest(longChain.calls, spot * 1.0);
    const hi = nearest(longChain.calls, spot * 1.3);
    if (lo?.executableAsk && hi?.executableBid && hi.strike > lo.strike) {
      const debit = lo.executableAsk - hi.executableBid;
      const cost = debit * MULTIPLIER;
      const n = Math.floor(capital / cost);
      if (n >= 1 && debit > 0) {
        structures.push({
          id: "bull_spread", name: `牛市认购价差 ${lo.strike}/${hi.strike}`, kind: "spread",
          contracts: n, capitalUsed: n * cost,
          legs: [
            { kind: "call", side: "long", strike: lo.strike, price: lo.executableAsk, qty: n },
            { kind: "call", side: "short", strike: hi.strike, price: hi.executableBid, qty: n },
          ],
          lean: { debit, costPerContract: cost, maxGainPerContract: ((hi.strike - lo.strike) - debit) * MULTIPLIER },
          note: `买 ${n} 组，每组 $${cost.toFixed(0)}`,
        });
      }
    }
  }

  // 6. Cash-secured short put
  {
    const p = nearest(longChain.puts, spot * 0.9);
    if (p?.executableBid) {
      const sec = p.strike * MULTIPLIER;
      const n = Math.floor(capital / sec);
      if (n >= 1) {
        structures.push({
          id: "csp", name: `卖出认沽 ${p.strike}`, kind: "short",
          contracts: n, capitalUsed: n * sec,
          legs: [{ kind: "put", side: "short", strike: p.strike, price: p.executableBid, qty: n }],
          lean: { strike: p.strike, premium: p.executableBid, secured: sec },
          note: `卖 ${n} 张，需现金担保 $${sec.toFixed(0)}/张`,
        });
      }
    }
  }

  // 7. PMCC: long LEAPS ITM + short 6M call
  {
    const longLeg = nearest(longChain.calls, spot * 0.9);
    const shortLeg = shortChain ? nearest(shortChain.calls, spot * 1.2) : null;
    if (longLeg?.executableAsk && shortLeg?.executableBid) {
      const netCost = longLeg.executableAsk - shortLeg.executableBid;
      const cost = netCost * MULTIPLIER;
      const n = Math.floor(capital / cost);
      if (n >= 1 && netCost > 0) {
        structures.push({
          id: "pmcc", name: `穷人备兑 ${longLeg.strike}购/${shortLeg.strike}购`, kind: "spread",
          contracts: n, capitalUsed: n * cost,
          legs: [
            { kind: "call", side: "long", strike: longLeg.strike, price: longLeg.executableAsk, qty: n },
            { kind: "call", side: "short", strike: shortLeg.strike, price: shortLeg.executableBid, qty: n },
          ],
          lean: {
            debit: netCost, costPerContract: cost,
            shortExpiry: shortChain.expiry,
            creditReceived: shortLeg.executableBid * MULTIPLIER * n,
          },
          note: `买 ${n} 张 LEAPS + 卖 ${n} 张 ${shortChain.expiry} 认购`,
        });
      }
    }
  }

  // --- Scenario evaluation at the long expiry -----------------------------
  const multiples = [0.5, 0.7, 0.85, 1.0, 1.15, 1.3, 1.5, 2.0];
  for (const s of structures) {
    if (!s.contracts && !s.units) { s.scenarios = []; continue; }
    s.scenarios = multiples.map((m) => {
      const exitSpot = spot * m;
      let pnl;
      if (s.isStock) pnl = (exitSpot - spot) * s.units;
      else pnl = pnlAt(s.legs, exitSpot);
      return {
        multiple: m,
        exitSpot,
        pnl,
        roiOnCapital: s.capitalUsed > 0 ? (pnl / capital) * 100 : null,
        roiOnDeployed: s.capitalUsed > 0 ? (pnl / s.capitalUsed) * 100 : null,
      };
    });
  }

  // --- Historical probability that the thesis clears the breakeven --------
  const closes = kline.map((r) => r.close);
  const holdDays = tdays(asOf, far.e);
  const fwd = [];
  for (let i = 0; i + holdDays < closes.length; i += 1) fwd.push(closes[i + holdDays] / closes[i] - 1);
  fwd.sort((a, b) => a - b);
  const probAbove = (x) => fwd.filter((r) => r > x).length / fwd.length;

  // --- Breakeven multiple per structure, and how often history cleared it ---
  // This is the single most decision-relevant number: a levered structure only wins if
  // the underlying clears its (higher) breakeven, not merely if it goes up.
  const pnlFor = (s, exitSpot) => {
    if (s.isStock) return (exitSpot - spot) * s.units;
    return pnlAt(s.legs, exitSpot);
  };
  for (const s of structures) {
    if (!s.scenarios.length) { s.breakeven = null; continue; }
    let lo = 0.3, hi = 4.0;
    const atLo = pnlFor(s, spot * lo);
    const atHi = pnlFor(s, spot * hi);
    if (!(atLo < 0 && atHi > 0)) {
      // Monotonic payoff assumed; if it does not bracket, report the best effort.
      s.breakeven = null;
      s.breakevenMultiple = null;
      s.historicalHitRate = null;
      continue;
    }
    for (let i = 0; i < 80; i += 1) {
      const m = (lo + hi) / 2;
      if (pnlFor(s, spot * m) > 0) hi = m; else lo = m;
    }
    const bem = (lo + hi) / 2;
    s.breakevenMultiple = bem;
    s.breakevenMovePct = (bem - 1) * 100;
    s.historicalHitRate = fwd.filter((r) => r > bem - 1).length / fwd.length;
  }

  const result = {
    code, symbol, asOf, spot, capital,
    longExpiry: far.e, longExpiryDays: far.d, longExpiryYears: T,
    atmIvPct: atmIv * 100,
    shortExpiry: shortChain?.expiry ?? null,
    structures,
    historical: {
      horizonDays: holdDays,
      n: fwd.length,
      median: fwd[Math.floor(fwd.length / 2)],
      probUp10: probAbove(0.1),
      probUp20: probAbove(0.2),
      probUp30: probAbove(0.3),
      probUp50: probAbove(0.5),
      probDown30: fwd.filter((r) => r < -0.3).length / fwd.length,
    },
  };

  await writeFile(path.join(outDir, "long-term-strategies.json"), JSON.stringify(result, null, 1));
  const md = render(result);
  await writeFile(path.join(outDir, "long-term-strategies.md"), md);
  console.log(md);
}

const fx = (x, d = 0) => (x === null || x === undefined || Number.isNaN(x) ? "—" : x.toFixed(d));
const pc = (x, d = 0) => (x === null || x === undefined || Number.isNaN(x) ? "—" : `${x.toFixed(d)}%`);

function render(r) {
  const L = [];
  const p = (...x) => L.push(...x);
  p(`# ${r.code} 长期做多策略对比`, "");
  p(`- 基准日 **${r.asOf}**，现价 **${fx(r.spot, 2)}**，投入资金 **$${r.capital.toLocaleString()}**`);
  p(`- 长期到期日 **${r.longExpiry}**（${r.longExpiryDays} 天，${fx(r.longExpiryYears, 2)} 年），ATM IV **${fx(r.atmIvPct, 1)}%**`);
  if (r.shortExpiry) p(`- 短腿到期日 ${r.shortExpiry}`);
  p("");

  p("## 1. 同资金下的结构对比", "");
  p("| 策略 | 数量 | 占用资金 | 关键参数 |", "|---|---:|---:|---|");
  for (const s of r.structures) {
    if (!s.scenarios.length) { p(`| ${s.name} | — | — | ${s.note} |`); continue; }
    let key = "";
    if (s.isStock) key = `${s.units} 股，无到期日`;
    else if (s.lean?.leverage) key = `Delta ${fx(s.lean.delta, 2)}｜杠杆 ${fx(s.lean.leverage, 1)}x｜IV ${fx(s.lean.ivPct, 0)}%｜盈亏平衡 ${fx(s.lean.breakeven, 2)}｜Theta ${fx(s.lean.thetaPerDayPct, 2)}%/日`;
    else if (s.lean?.maxGainPerContract) key = `每组成本 $${fx(s.lean.costPerContract)}｜最大收益 $${fx(s.lean.maxGainPerContract)}/组`;
    else if (s.lean?.secured) key = `收入 $${fx(s.lean.premium * 100)}/张｜担保 $${fx(s.lean.secured)}/张`;
    else if (s.lean?.shortExpiry) key = `净成本 $${fx(s.lean.costPerContract)}/组｜先收 $${fx(s.lean.creditReceived)}`;
    p(`| ${s.name} | ${s.contracts ?? s.units} | $${fx(s.capitalUsed)} | ${key} |`);
  }
  p("");

  p(`## 2. 到期 ${r.longExpiry} 的盈亏（$ = 总盈亏）`, "");
  const muls = r.structures.find((s) => s.scenarios.length)?.scenarios ?? [];
  p(`| 策略 | ${muls.map((m) => `$${fx(m.exitSpot, 0)}<br>(${((m.multiple - 1) * 100).toFixed(0)}%)`).join(" | ")} |`);
  p(`|---|${muls.map(() => "---:").join("|")}|`);
  for (const s of r.structures) {
    if (!s.scenarios.length) continue;
    p(`| ${s.name} | ${s.scenarios.map((x) => `${x.pnl >= 0 ? "+" : ""}$${fx(x.pnl)}`).join(" | ")} |`);
  }
  p("");
  p(`## 3. 占投入资金的回报率`, "");
  p(`| 策略 | ${muls.map((m) => `$${fx(m.exitSpot, 0)}`).join(" | ")} |`);
  p(`|---|${muls.map(() => "---:").join("|")}|`);
  for (const s of r.structures) {
    if (!s.scenarios.length) continue;
    p(`| ${s.name} | ${s.scenarios.map((x) => pc(x.roiOnCapital, 0)).join(" | ")} |`);
  }
  p("");

  const h = r.historical;
  p(`## 4. 历史概率（持有 ${h.horizonDays} 天，n=${h.n}）`, "");
  p("| 涨幅档 | 历史达成概率 |", "|---|---:|");
  p(`| 涨超 10% | ${pc(h.probUp10 * 100, 1)} |`);
  p(`| 涨超 20% | ${pc(h.probUp20 * 100, 1)} |`);
  p(`| 涨超 30% | ${pc(h.probUp30 * 100, 1)} |`);
  p(`| 涨超 50% | ${pc(h.probUp50 * 100, 1)} |`);
  p(`| 跌超 30% | ${pc(h.probDown30 * 100, 1)} |`);
  p("");

  p("## 5. 回本门槛 vs 历史达成概率（最关键的一栏）", "");
  p("> 杠杆结构只有在标的**涨过它更高的回本线**时才赚钱。标的涨 20% 而 LEAPS 回本需 27%，依然是亏的。", "");
  p("| 策略 | 回本需涨幅 | 历史达成概率 | 杠杆 |", "|---|---:|---:|---:|");
  const ranked = r.structures
    .filter((s) => s.scenarios.length && s.breakevenMovePct !== null)
    .sort((a, b) => (b.historicalHitRate ?? -1) - (a.historicalHitRate ?? -1));
  for (const s of ranked) {
    p(`| ${s.name} | ${s.isStock ? "0.0%" : pc(s.breakevenMovePct, 1)} | ${pc((s.historicalHitRate ?? 0) * 100, 1)} | ${s.lean?.leverage ? fx(s.lean.leverage, 1) + "x" : "1x"} |`);
  }
  p("");

  p("## 6. 数据解读警告", "");
  p(`- 历史概率基于 ${r.symbol} 的全部可得历史（含 2000 年泡沫与 2023–2026 大涨），**样本存在严重的生存者偏差和趋势偏差**。`);
  p(`- 若把窗口缩短到近 5 年，上涨概率会更高；若只取 2000–2002，则几乎全负。**这类概率不能当作未来胜率。**`);
  p(`- 期权盈亏为**到期结算**，未计提前平仓、IV 变化、股息与税务。实际路径中 IV 下降会让所有买方结构更差。`, "");
  return L.join("\n");
}

main().catch((e) => { console.error(`failed: ${e.message}`); process.exitCode = 1; });
