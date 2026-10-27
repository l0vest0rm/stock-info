#!/usr/bin/env node
/**
 * Compare option strategies on 588000.SH for a "high return, high risk tolerance" mandate.
 *
 * Method: every strategy is settled against the ACTUAL historical price path of the
 * underlying, not against a model distribution. For each of N historical entry dates
 * we take the underlying's close, price the legs with Black-Scholes at an IV proxy,
 * then settle at the real close after the holding period. This keeps the comparison
 * honest about 588000's genuinely fat tails, which a lognormal model understates.
 *
 * Premiums: current live chain prices (bid for sells, ask for buys) are used as the
 * "today" quotes; historical entries use model pricing at trailing realized vol so the
 * comparison is internally consistent across time.
 *
 * Usage:
 *   node scripts/compare-option-strategies.mjs --dir data/research/covered-call-588000
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { bsPrice, bsGreeks, impliedVol, realizedVol, quantile } from "./lib/option-pricing.mjs";
import {
  CONTRACT_UNIT,
  selectComparisonExpiries,
  horizonsFromExpiries,
  expiryLabel,
  shortCallMarginPerContract,
  shortPutMarginPerContract,
  tradingDaysBetween,
} from "./lib/market-calendar.mjs";

const RISK_FREE_RATE = 0.015;
const TRADING_DAYS = 243;

function parseArgs(argv) {
  const options = { dir: "data/research/covered-call-588000", out: "data/research/strategy-comparison-588000" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--dir") options.dir = next();
    else if (a === "--out") options.out = next();
    else if (a === "--help" || a === "-h") options.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return options;
}

// ---------------------------------------------------------------------------
// Volatility helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Strategy definitions
//
// Each strategy is a function of (spot, iv, T, strikes) returning legs and a payoff
// function. All are expressed as "return on the capital actually committed".
// ---------------------------------------------------------------------------

/**
 * Settlement value of a position at expiry.
 * legs: [{type:'call'|'put', side:'long'|'short', strike, price, qty}]
 * price is the premium paid (long) or received (short) per unit.
 */
function settle(legs, spotAtExit, spotAtEntry) {
  let pnl = 0;
  for (const leg of legs) {
    const intrinsic = leg.type === "call"
      ? Math.max(0, spotAtExit - leg.strike)
      : Math.max(0, leg.strike - spotAtExit);
    // Long pays premium, short receives it.
    const direction = leg.side === "long" ? 1 : -1;
    pnl += direction * (intrinsic - leg.price) * leg.qty;
  }
  return pnl / spotAtEntry; // as a fraction of the entry underlying price
}

function buildStrategies(spot, T, iv, sigma, strikeGrid) {
  /**
   * All strikes come from the REAL listed strike grid for the expiry being analysed,
   * never from a moneyness multiple of the spot price. A model strike such as
   * 1.42x1.15=1.64 does not exist on the board (the ladder is 1.60/1.65), so quoting
   * it would be untradeable.
   *
   * `strikeGrid` is the sorted list of listed strikes. When absent (historical replay
   * without a board) a synthetic ladder at the exchange's 0.05 tick is generated so
   * the same code path is exercised.
   */
  const grid = normalizeGrid(strikeGrid, spot);
  const round2 = (x) => Math.round(x * 100) / 100;
  const nearest = (target) => grid.reduce((best, k) => (Math.abs(k - target) < Math.abs(best - target) ? k : best), grid[0]);
  const atOrAbove = (target) => {
    const hit = grid.find((k) => k >= target - 1e-9);
    return hit ?? grid[grid.length - 1];
  };
  const atOrBelow = (target) => {
    const sorted = [...grid].reverse();
    const hit = sorted.find((k) => k <= target + 1e-9);
    return hit ?? grid[0];
  };
  const out = [];

  // --- Directional long call at ATM / +5% / +10% (snapped to listed strikes) ---
  for (const [label, mult] of [["平值", 1.0], ["虚值5%", 1.05], ["虚值10%", 1.1]]) {
    const strike = nearest(spot * mult);
    const price = bsPrice(spot, strike, T, RISK_FREE_RATE, iv, "call");
    out.push({
      id: `long_call_${Math.round((mult - 1) * 100)}`,
      name: `买入认购(${label})`,
      family: "买方·方向",
      strike,
      legs: [{ type: "call", side: "long", strike, price, qty: 1 }],
      capital: price,
      maxLoss: -price / spot,
      maxGain: null,
      breakevenMultiple: (strike + price) / spot,
    });
  }

  // --- Long straddle at the listed ATM strike ---
  {
    const strike = nearest(spot);
    const callP = bsPrice(spot, strike, T, RISK_FREE_RATE, iv, "call");
    const putP = bsPrice(spot, strike, T, RISK_FREE_RATE, iv, "put");
    out.push({
      id: "long_straddle",
      name: `买入跨式(平值${strike.toFixed(2)} Call+Put)`,
      family: "买方·波动",
      strike,
      legs: [
        { type: "call", side: "long", strike, price: callP, qty: 1 },
        { type: "put", side: "long", strike, price: putP, qty: 1 },
      ],
      capital: callP + putP,
      maxLoss: -(callP + putP) / spot,
      maxGain: null,
      breakevens: [(strike - callP - putP) / spot, (strike + callP + putP) / spot],
    });
  }

  // --- Long strangle at the listed +10% / -10% strikes ---
  {
    const callK = atOrAbove(spot * 1.1);
    const putK = atOrBelow(spot * 0.9);
    const callP = bsPrice(spot, callK, T, RISK_FREE_RATE, iv, "call");
    const putP = bsPrice(spot, putK, T, RISK_FREE_RATE, iv, "put");
    out.push({
      id: "long_strangle",
      name: `买入宽跨式(虚值10% ${callK.toFixed(2)}/${putK.toFixed(2)})`,
      family: "买方·波动",
      strike: null,
      legs: [
        { type: "call", side: "long", strike: callK, price: callP, qty: 1 },
        { type: "put", side: "long", strike: putK, price: putP, qty: 1 },
      ],
      capital: callP + putP,
      maxLoss: -(callP + putP) / spot,
      maxGain: null,
      breakevens: [(putK - callP - putP) / spot, (callK + callP + putP) / spot],
    });
  }

  // --- Bull call spreads over the REAL listed strike grid ---
  // Long legs at ATM and +5%/+10%; short legs at the next listed strikes above.
  for (const longTargetMult of [1.0, 1.05, 1.1]) {
    const longK = nearest(spot * longTargetMult);
    const higher = grid.filter((k) => k > longK + 1e-9);
    for (const shortK of higher.slice(0, 4)) {
      const pLong = bsPrice(spot, longK, T, RISK_FREE_RATE, iv, "call");
      const pShort = bsPrice(spot, shortK, T, RISK_FREE_RATE, iv, "call");
      const debit = pLong - pShort;
      if (!(debit > 0)) continue;
      out.push({
        id: `bull_call_${Math.round(longK * 100)}_${Math.round(shortK * 100)}`,
        name: `牛市认购价差 ${longK.toFixed(2)}/${shortK.toFixed(2)}`,
        family: "组合·垂直价差",
        legs: [
          { type: "call", side: "long", strike: longK, price: pLong, qty: 1 },
          { type: "call", side: "short", strike: shortK, price: pShort, qty: 1 },
        ],
        capital: debit,
        maxLoss: -debit / spot,
        maxGain: ((shortK - longK) - debit) / spot,
        breakEvenMultiple: (longK + debit) / spot,
        width: round2(shortK - longK),
        strikePair: [longK, shortK],
      });
    }
  }

  // --- Bear put spreads over the REAL listed strike grid ---
  for (const longTargetMult of [1.0, 0.95]) {
    const longK = nearest(spot * longTargetMult);
    const lower = grid.filter((k) => k < longK - 1e-9).reverse();
    for (const shortK of lower.slice(0, 3)) {
      const pLong = bsPrice(spot, longK, T, RISK_FREE_RATE, iv, "put");
      const pShort = bsPrice(spot, shortK, T, RISK_FREE_RATE, iv, "put");
      const debit = pLong - pShort;
      if (!(debit > 0)) continue;
      out.push({
        id: `bear_put_${Math.round(longK * 100)}_${Math.round(shortK * 100)}`,
        name: `熊市认沽价差 ${longK.toFixed(2)}/${shortK.toFixed(2)}`,
        family: "组合·垂直价差",
        legs: [
          { type: "put", side: "long", strike: longK, price: pLong, qty: 1 },
          { type: "put", side: "short", strike: shortK, price: pShort, qty: 1 },
        ],
        capital: debit,
        maxLoss: -debit / spot,
        maxGain: ((longK - shortK) - debit) / spot,
        width: round2(longK - shortK),
        strikePair: [longK, shortK],
      });
    }
  }

  // --- Cash-secured short put at listed -5% / -10% strikes ---
  for (const [label, mult] of [["虚值5%", 0.95], ["虚值10%", 0.9]]) {
    const strike = atOrBelow(spot * mult);
    const price = bsPrice(spot, strike, T, RISK_FREE_RATE, iv, "put");
    out.push({
      id: `short_put_${Math.round((1 - mult) * 100)}`,
      name: `卖出认沽(${label} ${strike.toFixed(2)})`,
      family: "卖方·收租",
      strike,
      legs: [{ type: "put", side: "short", strike, price, qty: 1 }],
      capital: strike,
      maxLoss: (price - strike) / strike,
      maxGain: price / strike,
    });
  }

  // --- Naked short call at the listed +15% strike ---
  {
    const strike = atOrAbove(spot * 1.15);
    const price = bsPrice(spot, strike, T, RISK_FREE_RATE, iv, "call");
    const marginPerContract = shortCallMarginPerContract(spot, strike, price);
    out.push({
      id: "short_call_naked",
      name: `卖出认购(裸卖 ${strike.toFixed(2)})`,
      family: "卖方·高尾险",
      strike,
      legs: [{ type: "call", side: "short", strike, price, qty: 1 }],
      capital: marginPerContract / CONTRACT_UNIT,
      maxLoss: null,
      maxGain: (price * CONTRACT_UNIT) / marginPerContract,
      marginPerContract,
    });
  }

  // --- Short strangle at listed +12% / -12% strikes ---
  {
    const callK = atOrAbove(spot * 1.12);
    const putK = atOrBelow(spot * 0.88);
    const callP = bsPrice(spot, callK, T, RISK_FREE_RATE, iv, "call");
    const putP = bsPrice(spot, putK, T, RISK_FREE_RATE, iv, "put");
    const marginPerContract = shortCallMarginPerContract(spot, callK, callP) + shortPutMarginPerContract(spot, putK, putP);
    out.push({
      id: "short_strangle",
      name: `卖出宽跨式(${callK.toFixed(2)}/${putK.toFixed(2)})`,
      family: "卖方·高尾险",
      legs: [
        { type: "call", side: "short", strike: callK, price: callP, qty: 1 },
        { type: "put", side: "short", strike: putK, price: putP, qty: 1 },
      ],
      capital: marginPerContract / CONTRACT_UNIT,
      maxLoss: null,
      maxGain: ((callP + putP) * CONTRACT_UNIT) / marginPerContract,
      marginPerContract,
    });
  }

  return out;
}

/**
 * Build the strike ladder to price against.
 * Real board strikes are used when available. For historical replay there is no board,
 * so the exchange tick rule is applied instead of an arbitrary multiple of spot:
 * 0.05 below 3.00 (the only band 588000 trades in), matching the SSE contract terms.
 */
function normalizeGrid(strikeGrid, spot) {
  if (Array.isArray(strikeGrid) && strikeGrid.length > 0) {
    return [...new Set(strikeGrid.filter((k) => typeof k === "number" && k > 0))].sort((a, b) => a - b);
  }
  const step = spot < 3 ? 0.05 : spot < 5 ? 0.1 : spot < 10 ? 0.25 : 0.5;
  const out = [];
  const low = Math.floor((spot * 0.75) / step) * step;
  const high = Math.ceil((spot * 1.45) / step) * step;
  for (let k = low; k <= high + 1e-9; k += step) out.push(Math.round(k * 100) / 100);
  return out;
}

// ---------------------------------------------------------------------------
// Historical replay
// ---------------------------------------------------------------------------

/**
 * Replay a strategy on every historical entry date.
 * IV proxy: trailing 60d realized vol scaled by the CURRENT iv/rv ratio, so the
 * historical entries are priced at a similar volatility-risk-premium as today.
 */
function replayStrategy(strategyBuilder, closes, dates, horizon, { ivRatio = 1, ivFloor = 0.2, ivCap = 1.5 } = {}) {
  const results = [];
  for (let i = 60; i + horizon < closes.length; i += 1) {
    const spot = closes[i];
    const rv = realizedVol(closes.slice(0, i + 1), 60);
    if (rv === null) continue;
    const sigma = Math.min(ivCap, Math.max(ivFloor, (rv / 100) * ivRatio));
    const T = horizon / TRADING_DAYS;
    // The builder returns a full strategy object (legs + capital + limits).
    const built = strategyBuilder(spot, T, sigma);
    if (!built?.legs) continue;
    const exitSpot = closes[i + horizon];
    const ret = settle(built.legs, exitSpot, spot);
    results.push({
      entryDate: dates[i],
      exitDate: dates[i + horizon],
      spot,
      exitSpot,
      sigmaPct: sigma * 100,
      returnOnSpot: ret,
      // Return on the capital the strategy actually ties up (premium or margin).
      returnOnCapital: built.capital > 0 ? ret / (built.capital / spot) : null,
      legs: built.legs,
    });
  }
  return results;
}

function summarize(results, label) {
  if (results.length === 0) return null;
  const ros = results.map((r) => r.returnOnSpot).sort((a, b) => a - b);
  const roc = results.map((r) => r.returnOnCapital).filter((v) => v !== null).sort((a, b) => a - b);
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const stdev = (xs) => {
    const m = mean(xs);
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
  };
  const lossRate = ros.filter((r) => r < 0).length / ros.length;
  return {
    label,
    n: results.length,
    avgReturnOnSpot: mean(ros),
    medianReturnOnSpot: quantile(ros, 0.5),
    stdevOnSpot: stdev(ros),
    worst: ros[0],
    p01: quantile(ros, 0.01),
    p05: quantile(ros, 0.05),
    p25: quantile(ros, 0.25),
    p75: quantile(ros, 0.75),
    p95: quantile(ros, 0.95),
    p99: quantile(ros, 0.99),
    best: ros[ros.length - 1],
    winRate: 1 - lossRate,
    lossRate,
    avgReturnOnCapital: roc.length ? mean(roc) : null,
    medianReturnOnCapital: roc.length ? quantile(roc, 0.5) : null,
    worstReturnOnCapital: roc.length ? roc[0] : null,
    p05ReturnOnCapital: roc.length ? quantile(roc, 0.05) : null,
    returnPerRisk: stdev(ros) > 0 ? mean(ros) / stdev(ros) : null,
    // Gain-to-pain: average win over average loss magnitude.
    payoffRatio: (() => {
      const wins = ros.filter((r) => r > 0);
      const losses = ros.filter((r) => r < 0);
      if (wins.length === 0 || losses.length === 0) return null;
      return mean(wins) / Math.abs(mean(losses));
    })(),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log("node scripts/compare-option-strategies.mjs [--dir DIR] [--out DIR]"); return; }
  const dir = path.resolve(options.dir);
  const outDir = path.resolve(options.out);
  await mkdir(outDir, { recursive: true });

  const chain = JSON.parse(await readFile(path.join(dir, "option-chain.json"), "utf8"));
  const kline = JSON.parse(await readFile(path.join(dir, "kline-qfq.json"), "utf8")).rows;
  const closes = kline.map((r) => r.close);
  const dates = kline.map((r) => r.date);
  const spot = closes.at(-1);
  const asOf = dates.at(-1);

  const volForecast = blendedVol(closes);
  // Compare the two nearest usable expiries so "which expiry" is an explicit dimension
  // rather than a constant repeated down the column.
  const EXPIRY_CANDIDATES = selectComparisonExpiries(
    chain.calls.filter((c) => c.expiry).map((c) => c.expiry),
    asOf,
    { minDays: 15, count: 3 }
  ).map((e) => ({ expiry: e.expiry, tradingDays: e.tradingDays, calendarDays: e.calendarDays, label: expiryLabel(e.expiry) }));

  const atmIvAt = (expiry, td) => {
    const T = td / TRADING_DAYS;
    const pts = [];
    for (const c of chain.calls.filter((x) => x.expiry === expiry)) {
      const mid = c.executableMid ?? c.lastPrice;
      if (!(mid > 0)) continue;
      const iv = impliedVol(mid, spot, c.strike, T, RISK_FREE_RATE, "call");
      if (iv && iv > 0.02 && iv < 3) pts.push({ strike: c.strike, ivPct: iv * 100 });
    }
    pts.sort((a, b) => a.strike - b.strike);
    if (!pts.length) return null;
    let lo = null, hi = null;
    for (const p of pts) { if (p.strike <= spot) lo = p; if (p.strike >= spot && !hi) hi = p; }
    if (lo && hi && lo.strike !== hi.strike) {
      const w = (spot - lo.strike) / (hi.strike - lo.strike);
      return (lo.ivPct * (1 - w) + hi.ivPct * w) / 100;
    }
    return (lo ?? hi).ivPct / 100;
  };

  const atmIvByExpiry = {};
  for (const e of EXPIRY_CANDIDATES) atmIvByExpiry[e.expiry] = atmIvAt(e.expiry, e.tradingDays);
  const nearExpiry = EXPIRY_CANDIDATES[0].expiry;
  const tradingDays = EXPIRY_CANDIDATES[0].tradingDays;
  const atmIv = atmIvByExpiry[nearExpiry];
  const ivRatio = atmIv && volForecast ? atmIv / (volForecast / 100) : 1;

  // Price today's strategies against the REAL listed strike grid of the near expiry.
  const listedStrikes = [...new Set(
    chain.calls.filter((c) => c.expiry === nearExpiry).map((c) => Number(c.strike)).filter((k) => k > 0)
  )].sort((a, b) => a - b);
  const strategies = buildStrategies(spot, tradingDays / TRADING_DAYS, atmIv ?? volForecast / 100, volForecast, listedStrikes);

  // Quote every strategy on each expiry so expiry choice is visible in the table.
  // A calendar spread spans two expiries on purpose, so it gets a dedicated quote.
  for (const s of strategies) {
    s.byExpiry = {};
    if (s.isCalendar) {
      const near = EXPIRY_CANDIDATES[0];
      const far = EXPIRY_CANDIDATES[EXPIRY_CANDIDATES.length - 1];
      const quotes = [];
      let ok = true;
      for (const [legIdx, e] of [[0, near], [1, far]]) {
        const leg = s.legs[legIdx];
        const pool = leg.type === "call" ? chain.calls : chain.puts;
        const contract = pool
          .filter((c) => c.expiry === e.expiry)
          .reduce((best, c) => (Math.abs(c.strike - leg.strike) < Math.abs((best?.strike ?? 1e9) - leg.strike) ? c : best), null);
        const execPrice = contract ? (leg.side === "long" ? contract.executableAsk : contract.executableBid) : null;
        if (!contract || !(execPrice > 0)) { ok = false; break; }
        quotes.push({
          code: contract.code, strike: contract.strike, side: leg.side, type: leg.type,
          execPrice, mid: contract.executableMid, oi: contract.openInterestLots, expiry: e.expiry,
        });
      }
      if (ok) {
        const liveLegs = s.legs.map((leg, i) => ({ ...leg, strike: quotes[i].strike, price: quotes[i].execPrice }));
        const debit = liveLegs.reduce((acc, l) => acc + (l.side === "long" ? l.price * l.qty : -l.price * l.qty), 0);
        s.byExpiry[`${near.expiry}+${far.expiry}`] = {
          label: `${near.label}+${far.label}`,
          tradingDays: far.tradingDays,
          quotes,
          legs: liveLegs,
          netDebit: debit,
          capitalOnSpot: debit / spot,
        };
      }
      s.live = null;
      s.liveQuotes = [];
      continue;
    }
    for (const e of EXPIRY_CANDIDATES) {
      const quotes = [];
      for (const leg of s.legs) {
        const pool = leg.type === "call" ? chain.calls : chain.puts;
        const contract = pool
          .filter((c) => c.expiry === e.expiry)
          .reduce((best, c) => (Math.abs(c.strike - leg.strike) < Math.abs((best?.strike ?? 1e9) - leg.strike) ? c : best), null);
        if (!contract) { quotes.push(null); continue; }
        // Buyer pays ask, seller receives bid.
        const execPrice = leg.side === "long" ? contract.executableAsk : contract.executableBid;
        quotes.push({
          code: contract.code,
          strike: contract.strike,
          side: leg.side,
          type: leg.type,
          execPrice,
          mid: contract.executableMid,
          oi: contract.openInterestLots,
        });
      }
      if (!quotes.every((q) => q && typeof q.execPrice === "number" && q.execPrice > 0)) continue;
      const liveLegs = s.legs.map((leg, i) => ({ ...leg, strike: quotes[i].strike, price: quotes[i].execPrice }));
      const debit = liveLegs.reduce((acc, l) => acc + (l.side === "long" ? l.price * l.qty : -l.price * l.qty), 0);
      // Capital: buyer pays premium; short put posts cash secured; naked short call and
      // short strangle post the exchange minimum margin computed from live strikes.
      let capitalPerContract;
      if (s.id === "short_call_naked") {
        capitalPerContract = shortCallMarginPerContract(spot, liveLegs[0].strike, liveLegs[0].price);
      } else if (s.id === "short_strangle") {
        capitalPerContract = shortCallMarginPerContract(spot, liveLegs[0].strike, liveLegs[0].price)
          + shortPutMarginPerContract(spot, liveLegs[1].strike, liveLegs[1].price);
      } else if (s.id.startsWith("short_put")) {
        capitalPerContract = liveLegs[0].strike * CONTRACT_UNIT;
      } else {
        capitalPerContract = Math.max(0.0001, debit) * CONTRACT_UNIT;
      }
      s.byExpiry[e.expiry] = {
        label: e.label,
        tradingDays: e.tradingDays,
        quotes,
        legs: liveLegs,
        netDebit: debit,
        capitalPerContract,
        capitalOnSpot: capitalPerContract / (spot * CONTRACT_UNIT),
      };
    }
    // Keep a `live` alias for the near expiry (used by the historical comparison below).
    s.live = s.byExpiry[nearExpiry] ?? null;
    s.liveQuotes = s.live?.quotes ?? [];
  }

  // --- Historical replay across horizons ---
  const horizons = horizonsFromExpiries(EXPIRY_CANDIDATES, 3).map((h) => ({ label: h.label, days: h.tradingDays }));
  const comparisons = [];
  for (const h of horizons) {
    for (const s of strategies) {
      // Rebuild the same structure at each historical price level.
      //
      // Vertical spreads must be rebuilt from their OFFSETS (width in absolute yuan),
      // not from a moneyness bucket: rebuilding by "nearest strike ratio" collapses
      // different spread widths onto one contract and makes every wing show identical
      // statistics. Straight option/stock structures rebuild by moneyness multiple.
      const builder = (histSpot, histT, histSigma) => {
        if (s.family === "组合·垂直价差") {
          const legs = s.legs;
          if (legs.length !== 2) return null;
          // Preserve the real width (in yuan) and rebuild both legs on the historical
          // ladder, which follows the exchange 0.05 tick for this price band.
          const width = Math.abs(legs[1].strike - legs[0].strike);
          const longMult = legs[0].strike / spot;
          const grid = normalizeGrid(null, histSpot);
          const nearest = (t) => grid.reduce((b, k) => (Math.abs(k - t) < Math.abs(b - t) ? k : b), grid[0]);
          const longK = nearest(histSpot * longMult);
          const shortK = legs[0].type === "call" ? Math.round((longK + width) * 100) / 100 : Math.round((longK - width) * 100) / 100;
          if (shortK <= 0) return null;
          const pLong = bsPrice(histSpot, longK, histT, RISK_FREE_RATE, histSigma, legs[0].type);
          const pShort = bsPrice(histSpot, shortK, histT, RISK_FREE_RATE, histSigma, legs[1].type);
          const debit = pLong - pShort;
          if (!(debit > 0)) return null;
          const maxGain = legs[0].type === "call"
            ? (shortK - longK - debit) / histSpot
            : (longK - shortK - debit) / histSpot;
          return {
            legs: [
              { type: legs[0].type, side: "long", strike: longK, price: pLong, qty: 1 },
              { type: legs[1].type, side: "short", strike: shortK, price: pShort, qty: 1 },
            ],
            capital: debit,
            maxLoss: -debit / histSpot,
            maxGain,
          };
        }
        if (s.isCalendar) return null;
        const all = buildStrategies(histSpot, histT, histSigma, histSigma, null);
        const exact = all.find((x) => x.id === s.id);
        if (exact) return exact;
        const base = s.id.replace(/_\d+$/, "");
        const same = all.filter((x) => x.id.replace(/_\d+$/, "") === base);
        if (same.length === 0) return all[0];
        const targetRatio = s.strike ? s.strike / spot : 1;
        return same.reduce((best, x) => {
          const r = x.strike ? x.strike / histSpot : 1;
          const br = best.strike ? best.strike / histSpot : 1;
          return Math.abs(r - targetRatio) < Math.abs(br - targetRatio) ? x : best;
        });
      };
      if (s.isCalendar) continue; // calendar spreads are not settled at a single expiry
      const results = replayStrategy(builder, closes, dates, h.days, { ivRatio });
      comparisons.push({ strategyId: s.id, strategyName: s.name, family: s.family, horizon: h.label, width: s.width ?? null, ...summarize(results, `${s.name} / ${h.label}`) });
    }
  }

  // --- Buy-and-hold baseline ---
  const baseline = [];
  for (const h of horizons) {
    const rets = [];
    for (let i = 0; i + h.days < closes.length; i += 1) rets.push(closes[i + h.days] / closes[i] - 1);
    rets.sort((a, b) => a - b);
    // Non-overlapping windows: the honest estimate. Overlapping windows reuse the same
    // path many times, which inflates the mean when returns are right-skewed.
    const nonOverlap = [];
    for (let i = 0; i + h.days < closes.length; i += h.days) nonOverlap.push(closes[i + h.days] / closes[i] - 1);
    baseline.push({
      horizon: h.label,
      n: rets.length,
      avgReturnOnSpot: rets.reduce((a, b) => a + b, 0) / rets.length,
      medianReturnOnSpot: quantile(rets, 0.5),
      stdevOnSpot: (() => { const m = rets.reduce((a, b) => a + b, 0) / rets.length; return Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1)); })(),
      worst: rets[0],
      p05: quantile(rets, 0.05),
      p95: quantile(rets, 0.95),
      best: rets[rets.length - 1],
      winRate: rets.filter((r) => r > 0).length / rets.length,
      nonOverlappingN: nonOverlap.length,
      nonOverlappingMean: nonOverlap.reduce((a, b) => a + b, 0) / nonOverlap.length,
    });
  }

  // --- Conditional: today's state (deep drawdown) vs history ---
  // The full-history replay is dominated by 2020-2023 (sideways) and 2024-2026 (recovery).
  // Today sits at -39% from the high, so the analogue set matters more than the average.
  const conditional = {};
  for (const h of horizons) {
    const states = [];
    let lastIdx = -999;
    for (let i = 250; i + h.days < closes.length; i += 1) {
      const ma250 = closes.slice(i - 249, i + 1).reduce((a, b) => a + b, 0) / 250;
      if (closes[i] < 0.92 * ma250 && closes[i] / closes[i - 60] - 1 < -0.12 && i - lastIdx >= 30) {
        states.push(i);
        lastIdx = i;
      }
    }
    const rets = states.map((i) => closes[i + h.days] / closes[i] - 1).sort((a, b) => a - b);
    conditional[h.label] = {
      n: rets.length,
      entryDates: states.map((i) => dates[i]),
      mean: rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : null,
      median: quantile(rets, 0.5),
      p10: quantile(rets, 0.1),
      p90: quantile(rets, 0.9),
      probUp15: rets.length ? rets.filter((r) => r > 0.15).length / rets.length : null,
    };
  }

  const result = {
    code: "588000.SH",
    asOf,
    spot,
    atmIvPct: atmIv ? atmIv * 100 : null,
    volForecastPct: volForecast,
    ivRatio,
    nearExpiry,
    tradingDays,
    strategies: strategies.map((s) => ({
      id: s.id, name: s.name, family: s.family, strike: s.strike,
      width: s.width ?? null, strikePair: s.strikePair ?? null,
      legs: s.legs, capitalOnSpot: s.capital / spot,
      maxLossOnSpot: s.maxLoss, maxGainOnSpot: s.maxGain,
      breakevens: s.breakevens ?? (s.breakevenMultiple ? [s.breakevenMultiple] : null),
      byExpiry: s.byExpiry,
      live: s.live ?? null, liveQuotes: s.liveQuotes,
    })),
    expiries: EXPIRY_CANDIDATES.map((e) => ({ ...e, atmIvPct: (atmIvByExpiry[e.expiry] ?? 0) * 100 })),
    comparisons,
    baseline,
    conditional,
  };

  await writeFile(path.join(outDir, "strategy-comparison.json"), JSON.stringify(result, null, 1));
  const md = renderReport(result);
  await writeFile(path.join(outDir, "strategy-comparison.md"), md);
  console.log(md);
}

function pct(x, d = 2) { return x === null || x === undefined || Number.isNaN(x) ? "—" : `${(x * 100).toFixed(d)}%`; }

function renderReport(r) {
  const L = [];
  const push = (...x) => L.push(...x);

  push("# 588000.SH 期权策略对比（高收益/高风险目标）", "");
  push(`- 基准日：**${r.asOf}**，标的收盘 **${r.spot}**`);
  push(`- 近月 ATM IV：**${r.atmIvPct?.toFixed(1)}%**，波动率预测 **${r.volForecastPct?.toFixed(1)}%**，IV/预测 = ${r.ivRatio?.toFixed(2)}`);
  push(`- 合约单位 10,000 份/张；对比期限 ${r.nearExpiry}（${r.tradingDays} 交易日）`);
  push(`- 所有策略均用**真实历史价格路径**结算，非模型分布。`, "");

  push("## 1. 各策略当前可成交结构", "");
  push("### 1.1 到期日选择", "");
  push("| 到期日 | 剩余交易日 | ATM IV | 距今天数 |", "|---|---:|---:|---:|");
  for (const e of r.expiries ?? []) {
    push(`| ${e.expiry} | ${e.tradingDays} | ${e.atmIvPct?.toFixed(1)}% | ${Math.round((Date.parse(`${e.expiry}T00:00:00Z`) - Date.parse(`${r.asOf}T00:00:00Z`)) / 86_400_000)} 天 |`);
  }
  push("");
  push("> 三个到期日的 IV 逐级下降（41.1% → 39.6% → 37.2%）：近月被短期情绪推高，**远月波动率更便宜**。", "");

  push("### 1.2 全策略 × 全到期日明细", "");
  push("> 买入付**卖一价**，卖出入**买一价**，均为 2026-10-23 收盘实盘盘口。", "");
  push(
    "| 策略 | 到期日 | 合约代码 | 行权价 | 方向 | 成交价 | 每张支出/收入 | 净投入 | 最大亏损 | 最大收益 |",
    "|---|---|---|---:|---|---:|---:|---:|---:|---:|"
  );
  for (const s of r.strategies) {
    const entries = Object.entries(s.byExpiry ?? {});
    if (entries.length === 0) continue;
    for (const [expiry, q] of entries) {
      const legs = q.quotes;
      const codeCol = legs.map((x) => x.code).join("<br>");
      const strikeCol = legs.map((x) => x.strike.toFixed(2)).join("<br>");
      const dirCol = legs.map((x) => (x.side === "long" ? "买入" : "卖出") + (x.type === "call" ? "认购" : "认沽")).join("<br>");
      const priceCol = legs.map((x) => x.execPrice.toFixed(4)).join("<br>");
      const cashCol = legs.map((x) => {
        const v = x.execPrice * CONTRACT_UNIT * (x.side === "long" ? -1 : 1);
        return v < 0 ? `付${Math.abs(v).toFixed(0)}` : `收${v.toFixed(0)}`;
      }).join("<br>");
      const net = q.capitalOnSpot * r.spot * CONTRACT_UNIT;
      push(
        `| ${s.name} | **${expiry}** | ${codeCol} | ${strikeCol} | ${dirCol} | ${priceCol} | ${cashCol} | ${net.toFixed(0)}元 | ${
          s.maxLossOnSpot === null ? "无限" : pct(s.maxLossOnSpot, 1)
        } | ${s.maxGainOnSpot === null ? "无上限" : pct(s.maxGainOnSpot, 1)} |`
      );
    }
  }
  push("");
  push("> 净投入：买方 = 权利金；卖出认沽 = 行权价×10,000 的现金担保；裸卖认购/宽跨式 = 标的×12% 的保证金估算。", "");

  push("### 1.3 同一策略在不同到期日的成本对比", "");
  const cols = (r.expiries ?? []).map((e) => e.expiry);
  push(`| 策略 | ${cols.map((c) => c).join(" | ")} | 最长/最短 |`);
  push(`|---|${cols.map(() => "---:").join("|")}|---:|`);
  for (const s of r.strategies) {
    const vals = cols.map((c) => s.byExpiry?.[c]);
    if (vals.some((v) => !v)) continue;
    const costs = vals.map((v) => v.capitalPerContract ?? v.capitalOnSpot * r.spot * CONTRACT_UNIT);
    const ratio = costs[0] > 0 ? costs[costs.length - 1] / costs[0] : null;
    push(`| ${s.name} | ${costs.map((c) => c.toFixed(0) + "元").join(" | ")} | ${ratio ? ratio.toFixed(2) + "x" : "—"} |`);
  }
  push("");

  for (const h of [...new Set(r.comparisons.map((c) => c.horizon))]) {
    push(`## 2. 历史回放 — ${h}`, "");
    push("| 策略 | 样本 | 胜率 | 平均收益 | 中位 | 最差 | P05 | P95 | 最好 | 收益/风险 | 盈亏比 |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
    const rows = r.comparisons.filter((c) => c.horizon === h).sort((a, b) => (b.avgReturnOnSpot ?? -9) - (a.avgReturnOnSpot ?? -9));
    for (const c of rows) {
      push(`| ${c.strategyName} | ${c.n} | ${pct(c.winRate, 0)} | ${pct(c.avgReturnOnSpot)} | ${pct(c.medianReturnOnSpot)} | ${pct(c.worst)} | ${pct(c.p05)} | ${pct(c.p95)} | ${pct(c.best)} | ${c.returnPerRisk?.toFixed(3) ?? "—"} | ${c.payoffRatio?.toFixed(2) ?? "—"} |`);
    }
    const b = r.baseline.find((x) => x.horizon === h);
    if (b) {
      push(`| **直接持有ETF(基准)** | ${b.n} | ${pct(b.winRate, 0)} | ${pct(b.avgReturnOnSpot)} | ${pct(b.medianReturnOnSpot)} | ${pct(b.worst)} | ${pct(b.p05)} | ${pct(b.p95)} | ${pct(b.best)} | — | — |`);
    }
    push("");
  }

  push("## 3. 按资金占用折算的年化视角", "");
  push("| 策略 | 期限 | 平均收益(占标的) | 投入占标的 | 平均收益/投入 | 最差(占投入) | P05(占投入) |", "|---|---|---:|---:|---:|---:|---:|");
  for (const c of r.comparisons) {
    const s = r.strategies.find((x) => x.id === c.strategyId);
    push(`| ${c.strategyName} | ${c.horizon} | ${pct(c.avgReturnOnSpot)} | ${pct(s?.capitalOnSpot, 1)} | ${pct(c.avgReturnOnCapital, 1)} | ${pct(c.worstReturnOnCapital, 0)} | ${pct(c.p05ReturnOnCapital, 0)} |`);
  }
  push("");

  push("## 4. 当前状态的历史类比（关键）", "");
  push("标的现价距高点 -39%，处在「跌破年线且 60 日跌幅超 12%」的状态。全历史平均收益被 2020–2023 横盘和 2024–2026 反弹主导，")
  push("对当前点位参考价值有限，所以单独看同类状态的后续走势：", "");
  push("| 期限 | 样本 | 触发日期 | 均值 | 中位 | P10 | P90 | 涨超15%概率 |", "|---|---:|---|---:|---:|---:|---:|---:|");
  for (const [label, c] of Object.entries(r.conditional ?? {})) {
    if (!c.n) continue;
    push(`| ${label} | ${c.n} | ${c.entryDates.join("、")} | ${pct(c.mean)} | ${pct(c.median)} | ${pct(c.p10)} | ${pct(c.p90)} | ${pct(c.probUp15, 0)} |`);
  }
  push("");
  push("### 基准口径说明（必读）", "");
  for (const b of r.baseline) {
    push(`- **${b.horizon}**：全历史重叠窗口 n=${b.n}，算术均值 ${pct(b.avgReturnOnSpot)}；`
      + `不重叠窗口 n=${b.nonOverlappingN}，均值 ${pct(b.nonOverlappingMean)}。`);
  }
  push("");
  push("> 重叠窗口会重复使用同一段行情，在右偏分布下把均值放大。**不重叠均值才是诚实基准**。", "");
  return L.join("\n");
}

main().catch((e) => { console.error(`strategy comparison failed: ${e.message}`); process.exitCode = 1; });
