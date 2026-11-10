#!/usr/bin/env node
/**
 * Wheel / short-premium backtest for SSE ETF options (default 510050.SH, 上证50ETF).
 *
 * Question this answers: if you sell options instead of holding the ETF, what do 1/2/3
 * year returns look like for the "sell put -> get assigned -> sell covered call -> called
 * away -> sell put again" cycle, across tenors and strike rules?
 *
 * HONESTY CONSTRAINT (read before using the numbers)
 *   SSE option contracts stop being served by the quote history endpoints once they are
 *   delisted, so there is no full historical option-price panel in this repo. Historical
 *   option prices here are therefore MODEL prices, not traded prices:
 *     - the ETF price path is real (Xueqiu daily closes via the local /api/kline route),
 *     - the option SURFACE LEVEL and SHAPE are calibrated from the live board,
 *     - the volatility level over history is proxied by trailing realized volatility times
 *       a variance-risk-premium ratio measured on this repo's own IV history.
 *   Results are therefore a comparison of strategy structures under identical assumptions,
 *   not realizable historical P&L. The 2026-04..2026-11 slice is the only period where real
 *   option IV history exists, and it is used as a calibration/validation slice.
 *
 * Inputs (produced by the existing fetch scripts):
 *   <dir>/option-chain.json      scripts/fetch-etf-option-chain.mjs + fetch-option-quotes.mjs
 *   <dir>/iv-history.json        scripts/fetch-option-iv-history.mjs
 *   <dir>/kline-normal.json      unadjusted ETF closes (option strikes/settlement live here)
 *   <dir>/kline-qfq.json         adjusted ETF closes (dividend-reinvested total return)
 *
 * Usage:
 *   node scripts/backtest-option-wheel.mjs --dir data/research/wheel-510050
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { bsForwardPrice, impliedVolForward, normCdf, quantile, realizedVol } from "./lib/option-pricing.mjs";

// ---------------------------------------------------------------------------
// Conventions
// ---------------------------------------------------------------------------

const UNIT = 10_000; // shares per SSE ETF option contract
const TD_PER_YEAR = 243; // A-share sessions per year (repo convention)
const RISK_FREE_RATE = 0.015; // repo convention for A-share option research
const FEE_PER_SIDE = 2; // yuan per contract per side (exchange + typical retail commission)
const MIN_DAYS_TO_EXPIRY = 14; // never sell the front week: gamma dominates, vol is not comparable
const IV_FLOOR = 0.07; // modelled ATM IV never goes below this (calm 2016-2017 regimes)
const IV_CAP = 0.80; // and never above this (2015-08 / 2024-02 style panic)
const QUARTER_MONTHS = new Set([3, 6, 9, 12]);

const DEFAULTS = {
  dir: "data/research/wheel-510050",
  out: null,
  start: null,
  end: null,
  ivBase: null, // null => calibrated from iv-history
  ivSlope: null, // null => calibrated from iv-history
  carry: "dividend", // "dividend" | "market"
  freshStep: 21, // trading days between fresh-start samples
};

function parseArgs(argv) {
  const o = { ...DEFAULTS, scenarios: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--dir") o.dir = next();
    else if (a === "--out") o.out = next();
    else if (a === "--start") o.start = next();
    else if (a === "--end") o.end = next();
    else if (a === "--iv-base") o.ivBase = Number(next()) / 100;
    else if (a === "--iv-slope") o.ivSlope = Number(next());
    else if (a === "--carry") o.carry = next();
    else if (a === "--scenarios") {
      // "base:slope" pairs, base in percent (e.g. 12:0.2,14:0.34,16:0.5)
      o.scenarios = next().split(",").map((s) => {
        const [b, k] = s.split(":");
        return { base: Number(b) / 100, slope: Number(k) };
      });
    }
    else if (a === "--help" || a === "-h") o.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

async function readJson(p) {
  return JSON.parse(await readFile(p, "utf8"));
}

function tradingDayIndex(dates) {
  const map = new Map();
  dates.forEach((d, i) => map.set(d, i));
  return map;
}

/**
 * Recover cash dividends from the difference between the adjusted and unadjusted close
 * series. A dividend on day i shows up as qfq/normal drifting apart by exactly that cash
 * amount, so the implied payout is `normal[i-1] * (qfq[i]/qfq[i-1]) - normal[i]`.
 * This keeps the forward price honest without needing a separate dividend feed, and the
 * result is only ever used with trailing data (no look-ahead).
 */
function dividendSeries(normal, qfq) {
  const byDate = new Map(qfq.map((r) => [r.date, r.close]));
  const out = [];
  for (let i = 1; i < normal.length; i += 1) {
    const prev = byDate.get(normal[i - 1].date);
    const cur = byDate.get(normal[i].date);
    if (!(prev > 0) || !(cur > 0)) continue;
    const implied = normal[i - 1].close * (cur / prev) - normal[i].close;
    // 0.004 yuan is ~0.15% of the ETF price: anything smaller is quote noise, not a payout.
    if (implied > 0.004) out.push({ date: normal[i].date, cash: implied });
  }
  return out;
}

/**
 * Implied forward and discount factor per expiry from put-call parity, regressed on
 * near-the-money strikes: C - P = DF * (F - K). Solving on the FORWARD (not on spot with
 * q = 0) is what removes the fake put skew that appears when the ETF's dividend carry is
 * ignored — on this board the same strike otherwise reads "call 13% / put 20%".
 */
function forwardSurface(chain, spot, asOf, holidaysIgnored = true) {
  const idx = tradingDayIndex([asOf]);
  const out = [];
  const smilePoints = [];
  for (const exp of [...new Set(chain.calls.map((c) => c.expiry))].sort()) {
    const calls = new Map(
      chain.calls.filter((c) => c.expiry === exp && c.executableMid > 0).map((c) => [c.strike, c])
    );
    const puts = new Map(
      chain.puts.filter((c) => c.expiry === exp && c.executableMid > 0).map((c) => [c.strike, c])
    );
    const rows = [];
    for (const [k, c] of calls) {
      const p = puts.get(k);
      if (!p) continue;
      if (Math.abs(k / spot - 1) > 0.12) continue; // parity holds tightest near the money
      rows.push({ K: k, cp: c.executableMid - p.executableMid });
    }
    if (rows.length < 3) continue;
    const n = rows.length;
    const sx = rows.reduce((s, r) => s + r.K, 0);
    const sy = rows.reduce((s, r) => s + r.cp, 0);
    const sxx = rows.reduce((s, r) => s + r.K * r.K, 0);
    const sxy = rows.reduce((s, r) => s + r.K * r.cp, 0);
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    const intercept = (sy - slope * sx) / n;
    const df = -slope;
    const forward = intercept / df;
    const days = Math.round((Date.parse(exp) - Date.parse(asOf)) / 86_400_000);
    if (!(df > 0.9 && df < 1.1) || !(forward > 0)) continue;
    const T = days / 365;
    const expPoints = [];
    out.push({ expiry: exp, days, T, forward, df, basisPct: (forward / spot - 1) * 100, expPoints });
    for (const [k, c] of calls) {
      const p = puts.get(k);
      if (!p) continue;
      const m = Math.log(k / forward);
      const ci = impliedVolForward(c.executableMid, forward, k, T, "call", df);
      const pi = impliedVolForward(p.executableMid, forward, k, T, "put", df);
      for (const iv of [ci, pi]) {
        if (!iv || iv < 0.02 || iv > 3) continue;
        const point = { m, ivPct: iv * 100, expiry: exp, days };
        smilePoints.push(point);
        expPoints.push(point);
      }
    }
  }
  // ATM vol per expiry: average of the strikes inside +-2% moneyness.
  for (const e of out) {
    const near = e.expPoints.filter((p) => Math.abs(p.m) <= 0.02);
    e.atmIvPct = near.length ? near.reduce((s, p) => s + p.ivPct, 0) / near.length : null;
    delete e.expPoints;
  }
  const atmList = smilePoints.filter((p) => Math.abs(p.m) < 0.02).map((p) => p.ivPct);
  const atm = atmList.length ? atmList.reduce((a, b) => a + b, 0) / atmList.length : null;
  return { expiries: out, smilePoints, atmIvPct: atm };
}

/**
 * Fit the smile as a multiple of ATM vol: rel(m) = (c0 + a1*m + a2*m^2) / c0.
 * Only the SHAPE is taken from the live board; the level is driven by realized vol over
 * history, so an unusually calm or wild week on the capture date cannot leak into 2015.
 */
function fitSmile(points) {
  const pts = points.filter((p) => Math.abs(p.m) <= 0.16);
  if (pts.length < 8) return { a1: 0, a2: 0, c0: 1, n: 0 };
  // Least squares on [1, m, m^2] against relative IV (kept as a ratio to keep tenor out).
  const byExpiry = new Map();
  for (const p of pts) {
    if (!byExpiry.has(p.expiry)) byExpiry.set(p.expiry, []);
    byExpiry.get(p.expiry).push(p);
  }
  const rows = [];
  for (const list of byExpiry.values()) {
    const near = list.filter((p) => Math.abs(p.m) <= 0.02);
    const base = near.length
      ? near.reduce((s, p) => s + p.ivPct, 0) / near.length
      : list.reduce((s, p) => s + p.ivPct, 0) / list.length;
    if (!(base > 0)) continue;
    for (const p of list) rows.push({ x1: p.m, x2: p.m * p.m, y: p.ivPct / base });
  }
  if (rows.length < 6) return { a1: 0, a2: 0, c0: 1, n: rows.length };
  // Solve the 3x3 normal equations for y = c0 + a1*x1 + a2*x2.
  const A = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const b = [0, 0, 0];
  for (const r of rows) {
    const v = [1, r.x1, r.x2];
    for (let i = 0; i < 3; i += 1) {
      b[i] += v[i] * r.y;
      for (let j = 0; j < 3; j += 1) A[i][j] += v[i] * v[j];
    }
  }
  const solve = (M, rhs) => {
    const a = M.map((row, i) => [...row, rhs[i]]);
    for (let c = 0; c < 3; c += 1) {
      let pivot = c;
      for (let r2 = c + 1; r2 < 3; r2 += 1) if (Math.abs(a[r2][c]) > Math.abs(a[pivot][c])) pivot = r2;
      if (Math.abs(a[pivot][c]) < 1e-12) return null;
      [a[c], a[pivot]] = [a[pivot], a[c]];
      for (let r2 = 0; r2 < 3; r2 += 1) {
        if (r2 === c) continue;
        const f = a[r2][c] / a[c][c];
        for (let k = c; k < 4; k += 1) a[r2][k] -= f * a[c][k];
      }
    }
    return [a[0][3] / a[0][0], a[1][3] / a[1][1], a[2][3] / a[2][2]];
  };
  const sol = solve(A, b);
  if (!sol || !(sol[0] > 0.2)) return { a1: 0, a2: 0, c0: 1, n: rows.length };
  return { c0: sol[0], a1: sol[1], a2: sol[2], n: rows.length };
}

/** Volatility forecast used as the sigma level: 20d + 60d + EWMA(0.94) blend. */
function volForecastSeries(closes) {
  const out = new Array(closes.length).fill(null);
  const rets = [null];
  for (let i = 1; i < closes.length; i += 1) rets.push(Math.log(closes[i] / closes[i - 1]));
  let ewmaVar = null;
  const seedWindow = 60;
  let seedSum = 0;
  let seedSumSq = 0;
  let seedN = 0;
  for (let i = 1; i < closes.length; i += 1) {
    const r = rets[i];
    if (i <= seedWindow) {
      seedSum += r;
      seedSumSq += r * r;
      seedN += 1;
      if (seedN >= 3) {
        const mean = seedSum / seedN;
        ewmaVar = Math.max(1e-8, seedSumSq / seedN - mean * mean);
      }
    } else {
      ewmaVar = 0.94 * ewmaVar + 0.06 * r * r;
    }
    const rv20 = realizedVol(closes.slice(0, i + 1), 20);
    const rv60 = realizedVol(closes.slice(0, i + 1), 60);
    const ew = ewmaVar ? Math.sqrt(ewmaVar * TD_PER_YEAR) : null;
    const parts = [rv20, rv60, ew].filter((v) => v !== null && Number.isFinite(v));
    out[i] = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length / 100 : null;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Strike grid and expiry calendar
// ---------------------------------------------------------------------------

/**
 * SSE ETF option strike spacing, per the exchange contract terms:
 *   <=3.00 -> 0.05, (3,5] -> 0.10, (5,10] -> 0.25, >10 -> 0.50
 * Historical strikes are not published as a panel, so the ladder is rebuilt from this
 * rule around the observed price. It is the same rule the live board follows, so the
 * modelled strike is always a strike that existed.
 */
function strikeStep(spot) {
  if (spot <= 3) return 0.05;
  if (spot <= 5) return 0.1;
  if (spot <= 10) return 0.25;
  return 0.5;
}

function strikeLadder(spot) {
  const step = strikeStep(spot);
  const lo = Math.floor((spot * 0.7) / step) * step;
  const hi = Math.ceil((spot * 1.4) / step) * step;
  const out = [];
  for (let k = lo; k <= hi + 1e-9; k += step) out.push(Math.round(k * 100) / 100);
  return out;
}

/** Nearest listed strike at or below / at or above a target price. */
function strikeAtOrBelow(spot, target) {
  const ladder = strikeLadder(spot);
  const hit = [...ladder].reverse().find((k) => k <= target + 1e-9);
  return hit ?? ladder[0];
}

function strikeAtOrAbove(spot, target) {
  const ladder = strikeLadder(spot);
  return ladder.find((k) => k >= target - 1e-9) ?? ladder[ladder.length - 1];
}

/** 4th Wednesday of the month, rolled forward to the next actual session. */
function fourthWednesday(year, month, tradingDays) {
  let count = 0;
  for (let day = 1; day <= 31; day += 1) {
    const d = new Date(Date.UTC(year, month - 1, day));
    if (d.getUTCMonth() !== month - 1) break;
    if (d.getUTCDay() !== 3) continue;
    count += 1;
    if (count !== 4) continue;
    let iso = d.toISOString().slice(0, 10);
    for (let i = 0; i < 10 && !tradingDays.has(iso); i += 1) {
      iso = new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    }
    return iso;
  }
  return null;
}

/**
 * Expiries actually listed at a point in time: current month, next month, and the next
 * two quarterlies -- the four standard SSE tenors. Never hardcoded to specific dates, so a
 * new June quarterly simply becomes eligible.
 */
function listedExpiries(asOf, tradingDays) {
  const cached = LISTED_CACHE.get(asOf);
  if (cached) return cached;
  const year = Number(asOf.slice(0, 4));
  const month = Number(asOf.slice(5, 7));
  const out = [];
  for (let i = 0; i <= 14 && out.length < 12; i += 1) {
    const m = month + i;
    const y = year + Math.floor((m - 1) / 12);
    const mm = ((m - 1) % 12) + 1;
    const d = fourthWednesday(y, mm, tradingDays);
    if (d && d > asOf) out.push({ expiry: d, isQuarterly: QUARTER_MONTHS.has(mm), monthOffset: i });
  }
  // Two nearest future months plus the next two quarterlies. Taking `slice` of the future
  // list (rather than a fixed month offset) keeps the front month listed on the expiry
  // day itself, when that month has just dropped out of the window.
  const near = out.slice(0, 2);
  const quarterlies = out.filter((e) => e.isQuarterly).slice(0, 2);
  const set = new Map();
  for (const e of [...near, ...quarterlies]) set.set(e.expiry, e);
  const sorted = [...set.values()].sort((a, b) => a.expiry.localeCompare(b.expiry));
  LISTED_CACHE.set(asOf, sorted);
  return sorted;
}

const LISTED_CACHE = new Map();

/**
 * Pick the expiry for a tenor rule: nearest listed expiry at least `minCalendarDays` away.
 *
 * The threshold is in *calendar* days on purpose. Expressing it in trading days silently
 * shifts every tenor by ~1.5x (21 trading days is a month and a half), which turns the
 * "front month" rule into a 2-month rule; it also makes the choice flip between the front
 * month and the next quarterly depending on where in the month you happen to roll.
 */
function pickExpiry(asOf, minCalendarDays, tradingDays, index) {
  const cands = listedExpiries(asOf, tradingDays).filter((e) => {
    const i = index.get(e.expiry);
    return i !== undefined && i > index.get(asOf);
  });
  for (const e of cands) {
    if (calendarDays(asOf, e.expiry) >= minCalendarDays) {
      return { ...e, td: index.get(e.expiry) - index.get(asOf) };
    }
  }
  const last = cands[cands.length - 1];
  return last ? { ...last, td: index.get(last.expiry) - index.get(asOf) } : null;
}

function calendarDays(fromIso, toIso) {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

function makeEngine({ r, smile, carry }) {
  const shape = (m) => {
    const x = Math.max(-0.16, Math.min(0.16, m));
    const rel = (smile.c0 + smile.a1 * x + smile.a2 * x * x) / smile.c0;
    return Math.max(0.55, Math.min(2.2, rel));
  };
  const carryOf = (divYield) => (carry === "market" ? MARKET_CARRY_Q : divYield);
  return {
    /** Forward price used for pricing and for moneyness: F = S·e^(r−q)T. */
    forward(spot, td, divYield) {
      return spot * Math.exp((r - carryOf(divYield)) * (td / TD_PER_YEAR));
    },
    /**
     * @param spot unadjusted ETF close
     * @param strike strike
     * @param td trading days to expiry
     * @param sigmaAtm annualized ATM vol as a decimal (already blended+scaled)
     * @param type "call" | "put"
     * @param divYield annualized dividend yield used for the forward
     */
    price(spot, strike, td, sigmaAtm, type, divYield) {
      if (!(td > 0) || !(spot > 0) || !(strike > 0)) return 0;
      const T = td / TD_PER_YEAR;
      const forward = spot * Math.exp((r - carryOf(divYield)) * T);
      const df = Math.exp(-r * T);
      const sigma = Math.max(0.03, Math.min(1.2, sigmaAtm * shape(Math.log(strike / forward))));
      return bsForwardPrice(forward, strike, T, sigma, type, df);
    },
  };
}

// Market-implied carry on this board, measured from put-call parity across the four listed
// tenors (-5.5%/yr total basis). Used only as a sensitivity, never as the default.
const MARKET_CARRY_Q = 0.07;

/**
 * Round-trip execution cost as a fraction of the mid price.
 * Calibrated on the live board's own bid/ask: ATM 3.5-4.1% for <=60d and 7-8% beyond 120d,
 * plus roughly +5.5 percentage points per 10% of moneyness away from the forward.
 * Sellers receive mid*(1 - cost/2), buyers pay mid*(1 + cost/2).
 */
function roundTripCost(td, moneyness) {
  const T = td / TD_PER_YEAR;
  return Math.min(0.30, 0.03 + 0.10 * T + 0.55 * Math.abs(moneyness));
}

function netSellerPrice(mid, td, moneyness) {
  if (!(mid > 0)) return 0;
  const cost = roundTripCost(td, moneyness) / 2;
  const price = mid * (1 - cost) - FEE_PER_SIDE / UNIT;
  return Math.max(0, price);
}

// ---------------------------------------------------------------------------
// Simulator
// ---------------------------------------------------------------------------

/**
 * One contract unit of capital, fully cash secured, no leverage, no margin calls.
 * Capital is re-deployed each cycle so the position stays ~1x notional, which is what
 * makes the comparison against 100% ETF holding meaningful.
 */
function simulate(ctx, params) {
  const { dates, close, qfqClose, volFc, divYield, tradingSet, index, engine, r } = ctx;
  const startIdx = params.startIdx;
  const endIdx = Math.min(params.endIdx ?? close.length - 1, close.length - 1);
  const strategy = params.strategy;
  const nav = [];

  if (strategy === "hold") {
    const base = qfqClose[startIdx];
    for (let i = startIdx; i <= endIdx; i += 1) nav.push(qfqClose[i] / base);
    return { nav, cycles: [], daysInStock: 0, days: endIdx - startIdx + 1, dates: dates.slice(startIdx, endIdx + 1) };
  }

  let cash = close[startIdx] * UNIT;
  let shares = 0;
  let costBasis = 0;
  let position = null;
  let daysInStock = 0;
  const cycles = [];

  if (strategy === "covered") {
    // All cash goes into the underlying, fractionally, so the book is exactly 1x notional.
    shares = cash / close[startIdx];
    cash = 0;
    costBasis = close[startIdx];
  }

  for (let i = startIdx; i <= endIdx; i += 1) {
    const spot = close[i];
    if (shares > 0) daysInStock += 1;
    cash *= 1 + r / TD_PER_YEAR;

    // Dividend is received in cash and immediately reinvested, so cash is unchanged and the
    // share count grows by div/spot. This mirrors the dividend-adjusted ETF total-return series;
    // adding the cash *and* the shares would count the payout twice.
    const div = ctx.divOnDate.get(dates[i]);
    if (div && shares > 0) shares += (shares * div) / spot;

    // ---- settle an expiring leg at the expiry close ----
    if (position && i >= position.expiryIdx) {
      const { type, strike, contracts, premium } = position;
      let outcome = "expired";
      let pnl;
      if (type === "put") {
        if (spot < strike - 1e-9) {
          outcome = "assigned";
          cash -= strike * UNIT * contracts;
          const newShares = UNIT * contracts;
          pnl = (premium - (strike - spot)) * UNIT * contracts;
          if (strategy === "put") {
            // "Sell puts and never hold": dump the stock at the same close, so this variant
            // never carries equity risk past the expiry session.
            cash += newShares * spot;
            pnl = (premium - (strike - spot)) * UNIT * contracts;
          } else {
            costBasis = shares > 0 ? (costBasis * shares + strike * newShares) / (shares + newShares) : strike;
            shares += newShares;
          }
        } else {
          pnl = premium * UNIT * contracts;
        }
      } else {
        if (spot > strike + 1e-9) {
          outcome = "called";
          cash += strike * UNIT * contracts;
          shares -= UNIT * contracts;
          pnl = (premium - (spot - strike)) * UNIT * contracts;
          if (strategy === "covered") {
            // Buy-and-cover: re-purchase the underlying immediately after being called away,
            // reinvesting every yuan of cash so the book stays exactly 1x notional.
            shares = cash / spot;
            cash = 0;
            costBasis = spot;
          } else if (shares <= UNIT * 1e-6) {
            shares = 0;
            costBasis = 0;
          }
        } else {
          pnl = premium * UNIT * contracts;
        }
      }
      cycles.push({
        entryDate: position.entryDate,
        expiry: position.expiry,
        type,
        strike,
        spotEntry: position.spotEntry,
        sigmaPct: position.sigmaPct,
        premium,
        contracts,
        premiumYield: premium / position.spotEntry,
        exitSpot: spot,
        outcome,
        pnl,
      });
      position = null;
    }

    // ---- open the next leg ----
    if (!position && i < endIdx) {
      // Wheel: sell puts when flat, sell covered calls once assigned. Covered: always calls.
      // The "put" family never writes calls -- it exits the stock at assignment.
      const wantsCall =
        strategy === "covered" || (strategy === "wheel" && shares > UNIT * 1e-6);
      const tenor = params.tenorDays;
      const exp = pickExpiry(dates[i], tenor, tradingSet, index);
      if (exp && exp.td > 0) {
        const td = exp.td;
        if (wantsCall) {
          const target =
            params.callRule === "cost" && costBasis > 0 ? costBasis : spot * (1 + params.callOtm);
          const strike = params.callRule === "cost" && costBasis > 0
            ? strikeAtOrAbove(spot, Math.max(costBasis, target - 1e-9))
            : strikeAtOrAbove(spot, target);
          // shares/UNIT is exactly 1x notional for `covered` (all cash went into the stock) and
          // never exceeds the holding after assignments.
          const contracts = shares / UNIT;
          const sigma = sigmaAt(ctx, i);
          const mid = engine.price(spot, strike, td, sigma, "call", divYield[i]);
          const premium = netSellerPrice(mid, td, Math.log(strike / engine.forward(spot, td, divYield[i])));
          if (contracts > 1e-9 && premium > 0) {
            cash += premium * UNIT * contracts;
            position = {
              type: "call", strike, expiry: exp.expiry, expiryIdx: index.get(exp.expiry),
              entryDate: dates[i], spotEntry: spot, sigmaPct: sigma * 100, premium, contracts,
            };
          }
        } else {
          const strike = strikeAtOrBelow(spot, spot * (1 - params.putOtm));
          // Contract count is fractional on purpose, for the same reason the ETF benchmark uses
          // fractional shares: capital is deployed at ~1x notional and never sits idle. With whole
          // contracts the book drops to zero contracts whenever the underlying has risen faster
          // than premium income (fully cash-secured => strike notional > cash), and the strategy
          // silently stops trading for years.
          const contracts = cash / (strike * UNIT);
          const sigma = sigmaAt(ctx, i);
          const mid = engine.price(spot, strike, td, sigma, "put", divYield[i]);
          const premium = netSellerPrice(mid, td, Math.log(strike / engine.forward(spot, td, divYield[i])));
          if (contracts > 1e-9 && premium > 0) {
            cash += premium * UNIT * contracts;
            position = {
              type: "put", strike, expiry: exp.expiry, expiryIdx: index.get(exp.expiry),
              entryDate: dates[i], spotEntry: spot, sigmaPct: sigma * 100, premium, contracts,
            };
          }
        }
      }
    }

    // ---- mark to market ----
    let liability = 0;
    if (position) {
      const td = Math.max(0, position.expiryIdx - i);
      if (td > 0) {
        const sigma = sigmaAt(ctx, i);
        const mid = engine.price(spot, position.strike, td, sigma, position.type, divYield[i]);
        liability = mid * UNIT * position.contracts;
      } else {
        const intrinsic =
          position.type === "call"
            ? Math.max(0, spot - position.strike)
            : Math.max(0, position.strike - spot);
        liability = intrinsic * UNIT * position.contracts;
      }
    }
    nav.push((cash + shares * spot - liability) / (close[startIdx] * UNIT));
  }

  return { nav, cycles, daysInStock, days: endIdx - startIdx + 1, dates: dates.slice(startIdx, endIdx + 1) };
}

/**
 * ATM vol level at index i.
 *
 * Realized vol is a good *ranking* signal for implied vol but a poor *scaling* one:
 * fitting the repo's own 510050 IV history (2026-04..2026-11) against rv20/rv60/EWMA
 * gives IV = a + b·RV with b ≈ 0.34 and a ≈ 14 vol points, rmse ≈ 2.2 points.
 * The IV/RV ratio falls monotonically (2.3x when RV≈6%, 1.3x when RV≈14%), so a
 * multiplicative premium would explode in 2015-style regimes; an affine one does not.
 */
function sigmaAt(ctx, i) {
  const base = ctx.volFc[i];
  if (!(base > 0)) return 0.18;
  const iv = ctx.ivBase + ctx.ivSlope * base;
  return Math.max(ctx.ivFloor, Math.min(ctx.ivCap, iv));
}

/**
 * Sanity check on the vol model: compare the modelled ATM IV at each date with the
 * volatility the underlying actually realized over the following month. A premium-selling
 * backtest is only meaningful if implied slightly exceeds subsequently realized vol on
 * average; if it is far above, the model is gifting the seller free money.
 */
function vrpCheck(ctx, startIdx, endIdx) {
  const c = ctx.qfqClose;
  const h = 21;
  let sumIv = 0;
  let sumRv = 0;
  let n = 0;
  let ivHigher = 0;
  for (let i = startIdx; i + h <= endIdx; i += 1) {
    if (!(ctx.volFc[i] > 0)) continue;
    const rets = [];
    for (let k = i + 1; k <= i + h; k += 1) rets.push(Math.log(c[k] / c[k - 1]));
    const mu = rets.reduce((a, b) => a + b, 0) / rets.length;
    const rv = Math.sqrt((rets.reduce((a, b) => a + (b - mu) ** 2, 0) / (rets.length - 1)) * TD_PER_YEAR);
    const iv = sigmaAt(ctx, i);
    if (!(rv > 0)) continue;
    sumIv += iv;
    sumRv += rv;
    if (iv > rv) ivHigher += 1;
    n += 1;
  }
  if (!n) return { n: 0, ivMean: null, rvMean: null, ivHigherRate: null };
  return { n, ivMean: sumIv / n, rvMean: sumRv / n, ivHigherRate: ivHigher / n, horizonDays: h };
}

function mean(fallback, xs) {
  if (!xs.length) return fallback;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------
function summarize(series, horizon, years) {
  const out = [];
  for (let i = 0; i + horizon < series.length; i += 1) out.push(series[i + horizon] / series[i] - 1);
  const ann = out.map((x) => (1 + x) ** (1 / years) - 1);
  ann.sort((a, b) => a - b);
  return {
    n: ann.length,
    mean: ann.length ? ann.reduce((a, b) => a + b, 0) / ann.length : null,
    median: quantile(ann, 0.5),
    p05: quantile(ann, 0.05),
    p10: quantile(ann, 0.1),
    p90: quantile(ann, 0.9),
    p95: quantile(ann, 0.95),
    worst: ann[0] ?? null,
    best: ann[ann.length - 1] ?? null,
    winRate: ann.filter((x) => x > 0).length / Math.max(1, ann.length),
  };
}

function nonOverlapping(series, horizon, years) {
  const out = [];
  for (let i = 0; i + horizon < series.length; i += horizon) out.push(series[i + horizon] / series[i] - 1);
  const ann = out.map((x) => (1 + x) ** (1 / years) - 1).sort((a, b) => a - b);
  return { n: ann.length, mean: ann.length ? ann.reduce((a, b) => a + b, 0) / ann.length : null, median: quantile(ann, 0.5) };
}

/** Paired annualized comparison of strategy vs ETF on identical windows. */
function paired(strategySeries, etfSeries, horizon, years) {
  const diffs = [];
  let beat = 0;
  for (let i = 0; i + horizon < strategySeries.length; i += 1) {
    const s = (strategySeries[i + horizon] / strategySeries[i]) ** (1 / years) - 1;
    const e = (etfSeries[i + horizon] / etfSeries[i]) ** (1 / years) - 1;
    diffs.push(s - e);
    if (s > e) beat += 1;
  }
  diffs.sort((a, b) => a - b);
  return {
    n: diffs.length,
    mean: diffs.length ? diffs.reduce((a, b) => a + b, 0) / diffs.length : null,
    median: quantile(diffs, 0.5),
    p10: quantile(diffs, 0.1),
    p90: quantile(diffs, 0.9),
    beatRate: beat / Math.max(1, diffs.length),
  };
}

function drawdown(series) {
  let peak = series[0];
  let max = 0;
  for (const v of series) {
    peak = Math.max(peak, v);
    max = Math.max(max, 1 - v / peak);
  }
  return max;
}

function annVol(series) {
  const rets = [];
  for (let i = 1; i < series.length; i += 1) rets.push(Math.log(series[i] / series[i - 1]));
  if (rets.length < 3) return null;
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v = rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(v * TD_PER_YEAR);
}

function cagr(series) {
  const years = (series.length - 1) / TD_PER_YEAR;
  if (!(years > 0)) return null;
  return (series[series.length - 1] / series[0]) ** (1 / years) - 1;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const HORIZONS = [
  { years: 1, td: 243, label: "1年" },
  { years: 2, td: 486, label: "2年" },
  { years: 3, td: 729, label: "3年" },
];

const TENORS = [
  { label: "近月", days: MIN_DAYS_TO_EXPIRY },
  { label: "双月", days: 45 },
  { label: "季月", days: 80 },
];

const PUT_OFFSETS = [0, 0.03, 0.05, 0.08, 0.1];
const CALL_OFFSETS = [0, 0.02, 0.05, 0.08];

/** Canonical rule used for the strategy-family and sensitivity tables. */
const CANONICAL = { putOtm: 0.05, callOtm: 0.03, tenorDays: MIN_DAYS_TO_EXPIRY, callRule: "otm" };

function buildConfigs() {
  const list = [];
  for (const t of TENORS) {
    for (const p of PUT_OFFSETS) {
      list.push({
        id: `wheel_${t.label}_put${Math.round(p * 100)}`,
        strategy: "wheel",
        tenorDays: t.days,
        putOtm: p,
        callOtm: CANONICAL.callOtm,
        callRule: "otm",
        tenorLabel: t.label,
        group: "期限×行权价",
      });
    }
  }
  for (const c of CALL_OFFSETS) {
    list.push({
      id: `wheel_近月_put5_call${Math.round(c * 100)}`,
      strategy: "wheel",
      tenorDays: MIN_DAYS_TO_EXPIRY,
      putOtm: CANONICAL.putOtm,
      callOtm: c,
      callRule: "otm",
      tenorLabel: "近月",
      group: "卖出认购行权价",
    });
  }
  list.push({
    id: "wheel_近月_put5_call成本价",
    strategy: "wheel",
    tenorDays: MIN_DAYS_TO_EXPIRY,
    putOtm: CANONICAL.putOtm,
    callOtm: 0,
    callRule: "cost",
    tenorLabel: "近月",
    group: "卖出认购行权价",
  });
  for (const s of ["put", "covered"]) {
    list.push({
      id: s === "put" ? "对照_纯卖沽" : "对照_备兑",
      strategy: s,
      tenorDays: MIN_DAYS_TO_EXPIRY,
      putOtm: CANONICAL.putOtm,
      callOtm: CANONICAL.callOtm,
      callRule: "otm",
      tenorLabel: "近月",
      group: "策略族对照",
    });
  }
  list.push({
    id: "对照_持有ETF",
    strategy: "hold",
    tenorDays: MIN_DAYS_TO_EXPIRY,
    putOtm: 0,
    callOtm: 0,
    callRule: "otm",
    tenorLabel: "—",
    group: "策略族对照",
  });
  return list;
}

function buildContext(inputs, opts) {
  const { chain, klineNormal, klineQfq, ivHistory } = inputs;
  const dates = klineNormal.map((r) => r.date);
  const close = klineNormal.map((r) => r.close);
  const qfqClose = dates.map((d) => {
    const hit = klineQfq.get(d);
    return hit ?? null;
  });
  // Fall back to the unadjusted close when a date is missing from the adjusted series.
  for (let i = 0; i < qfqClose.length; i += 1) if (!(qfqClose[i] > 0)) qfqClose[i] = close[i];
  const index = tradingDayIndex(dates);
  const tradingSet = new Set(dates);
  const divs = dividendSeries(klineNormal, klineQfqSeriesArray(inputs));
  const divOnDate = new Map(divs.map((d) => [d.date, d.cash]));
  const volFc = volForecastSeries(qfqClose);
  const surface = forwardSurface(chain, close[close.length - 1], dates[dates.length - 1]);
  const smile = fitSmile(surface.smilePoints);

  // ATM IV level model, calibrated on this repo's own IV history (2026-04..2026-11 on 510050).
  // Affine, not multiplicative: see sigmaAt() for why.
  const volFcAtDate = new Map(dates.map((d, i) => [d, volFc[i]]));
  const calib = [];
  for (const o of ivHistory?.atm ?? []) {
    const v = volFcAtDate.get(o.date);
    if (!(v > 0)) continue;
    calib.push({ rv: v, iv: o.atmIvPct / 100 });
  }
  const fit = affineFit(calib);
  const ivBase = opts.ivBase ?? fit.base;
  const ivSlope = opts.ivSlope ?? fit.slope;

  // Trailing 12-month dividend yield, using only payouts already observed at that date.
  const divYield = new Array(dates.length).fill(0.02);
  const sortedDivs = divs.slice().sort((a, b) => a.date.localeCompare(b.date));
  for (let i = 0; i < dates.length; i += 1) {
    const cutoff = dates[i];
    const from = new Date(Date.parse(`${cutoff}T00:00:00Z`) - 365 * 86_400_000).toISOString().slice(0, 10);
    let sum = 0;
    for (const d of sortedDivs) {
      if (d.date > cutoff) break;
      if (d.date > from) sum += d.cash;
    }
    divYield[i] = Math.max(0.005, Math.min(0.08, sum / close[i]));
  }

  return {
    r: RISK_FREE_RATE,
    dates, close, qfqClose, index, tradingSet, divOnDate, divYield, volFc,
    surface, smile, divs,
    ivBase, ivSlope, ivFloor: IV_FLOOR, ivCap: IV_CAP,
    calibration: fit,
    engine: makeEngine({ r: RISK_FREE_RATE, smile, carry: opts.carry }),
  };
}

/** Ordinary least squares y = base + slope·x, plus rmse and sample counts. */
function affineFit(rows) {
  const pts = rows.filter((p) => p.rv > 0 && p.iv > 0);
  if (pts.length < 3) return { base: 0.14, slope: 0.34, rmse: null, n: pts.length, rvMin: null, rvMax: null };
  const n = pts.length;
  const sx = pts.reduce((s, p) => s + p.rv, 0);
  const sy = pts.reduce((s, p) => s + p.iv, 0);
  const sxx = pts.reduce((s, p) => s + p.rv * p.rv, 0);
  const sxy = pts.reduce((s, p) => s + p.rv * p.iv, 0);
  const den = n * sxx - sx * sx;
  const slope = den === 0 ? 0.34 : (n * sxy - sx * sy) / den;
  const base = (sy - slope * sx) / n;
  const resid = pts.map((p) => p.iv - (base + slope * p.rv));
  const rmse = Math.sqrt(resid.reduce((s, x) => s + x * x, 0) / n);
  const rvs = pts.map((p) => p.rv).sort((a, b) => a - b);
  return { base, slope, rmse, n, rvMin: rvs[0], rvMax: rvs[rvs.length - 1] };
}

function klineQfqSeriesArray(inputs) {
  return inputs.klineNormal.map((r) => ({ date: r.date, close: inputs.klineQfq.get(r.date) ?? r.close }));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("node scripts/backtest-option-wheel.mjs [--dir DIR] [--out DIR] [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--iv-base PCT] [--iv-slope N] [--carry dividend|market] [--scenarios base:slope,...]");
    return;
  }
  const dir = path.resolve(opts.dir);
  const outDir = path.resolve(opts.out ?? opts.dir);
  await mkdir(outDir, { recursive: true });

  const chain = await readJson(path.join(dir, "option-chain.json"));
  const klineNormalRaw = await readJson(path.join(dir, "kline-normal.json"));
  const klineQfqRaw = await readJson(path.join(dir, "kline-qfq.json"));
  const normalRows = klineNormalRaw.rows ?? klineNormalRaw;
  const qfqRows = klineQfqRaw.rows ?? klineQfqRaw;
  const ivHistory = await readJson(path.join(dir, "iv-history.json")).catch(() => null);

  const inputs = {
    chain: {
      calls: chain.calls,
      puts: chain.puts,
    },
    klineNormal: normalRows,
    klineQfq: new Map(qfqRows.map((r) => [r.date, r.close])),
    ivHistory,
  };

  const ctx = buildContext(inputs, { ivBase: opts.ivBase, ivSlope: opts.ivSlope, carry: opts.carry });

  const firstIdx = ctx.dates.findIndex((d) => d >= (opts.start ?? "2015-02-09"));
  let startIdx = Math.max(0, firstIdx);
  while (startIdx < ctx.dates.length && !(ctx.volFc[startIdx] > 0)) startIdx += 1;
  const endIdx = opts.end ? Math.max(startIdx, ctx.dates.findIndex((d) => d >= opts.end) - 1) : ctx.dates.length - 1;

  const etfSeries = ctx.qfqClose.slice(startIdx, endIdx + 1);
  const configs = buildConfigs();
  const results = [];

  for (const cfg of configs) {
    const run = simulate(ctx, { ...cfg, startIdx, endIdx });
    const windows = {};
    const pairedStats = {};
    for (const h of HORIZONS) {
      windows[h.label] = summarize(run.nav, h.td, h.years);
      windows[`${h.label}_nonoverlap`] = nonOverlapping(run.nav, h.td, h.years);
      pairedStats[h.label] = cfg.strategy === "hold" ? null : paired(run.nav, etfSeries, h.td, h.years);
    }
    const assignments = run.cycles.filter((c) => c.outcome === "assigned").length;
    const called = run.cycles.filter((c) => c.outcome === "called").length;
    results.push({
      ...cfg,
      nav: run.nav,
      navResult: run.nav[run.nav.length - 1] / run.nav[0],
      cycles: run.cycles,
      windows,
      paired: pairedStats,
      continuous: {
        cagr: cagr(run.nav),
        annVol: annVol(run.nav),
        maxDrawdown: drawdown(run.nav),
        sharpe: annVol(run.nav) ? (cagr(run.nav) - RISK_FREE_RATE) / annVol(run.nav) : null,
        startDate: ctx.dates[startIdx],
        endDate: ctx.dates[endIdx],
        years: (run.nav.length - 1) / TD_PER_YEAR,
      },
      cycleStats: {
        n: run.cycles.length,
        assignments,
        called,
        assignmentRate: run.cycles.length ? assignments / run.cycles.length : null,
        // Realized moneyness after snapping to the exchange strike ladder. With 0.05 spacing
        // around 3.00 that is ~1.7% of spot, so "5%" and "8%" often land on the same strike.
        putOtmMean: mean(0, run.cycles.filter((c) => c.type === "put").map((c) => 1 - c.strike / c.spotEntry)),
        callOtmMean: mean(0, run.cycles.filter((c) => c.type === "call").map((c) => c.strike / c.spotEntry - 1)),
        // Share of the sample spent holding the underlying. This is the single biggest driver of
        // the difference between the call rules: a rule that keeps the stock longer is partly
        // just a long-ETF position, and its "premium edge" must be read net of that exposure.
        exposure: run.days ? run.daysInStock / run.days : null,
        premiumYieldMean: run.cycles.length
          ? run.cycles.reduce((s, c) => s + c.premiumYield, 0) / run.cycles.length
          : null,
        winRate: run.cycles.length
          ? run.cycles.filter((c) => c.pnl > 0).length / run.cycles.length
          : null,
        byYear: (() => {
          const out = {};
          for (const c of run.cycles) {
            const y = c.entryDate.slice(0, 4);
            out[y] = out[y] ?? { pnl: 0, n: 0, premium: 0 };
            out[y].pnl += c.pnl;
            out[y].premium += c.premium * c.contracts * UNIT;
            out[y].n += 1;
          }
          return out;
        })(),
      },
    });
  }

  const etfSummary = { windows: {}, continuous: {} };
  for (const h of HORIZONS) {
    etfSummary.windows[h.label] = summarize(etfSeries, h.td, h.years);
    etfSummary.windows[`${h.label}_nonoverlap`] = nonOverlapping(etfSeries, h.td, h.years);
  }
  etfSummary.continuous = {
    cagr: cagr(etfSeries),
    annVol: annVol(etfSeries),
    maxDrawdown: drawdown(etfSeries),
    sharpe: annVol(etfSeries) ? (cagr(etfSeries) - RISK_FREE_RATE) / annVol(etfSeries) : null,
    navResult: etfSeries[etfSeries.length - 1] / etfSeries[0],
  };

  // Fresh-start samples: what an investor starting on that date would actually get,
  // rather than a slice of one continuous equity curve.
  const fresh = [];
  const freshIdxs = [];
  for (let i = startIdx; i + 243 < endIdx; i += opts.freshStep) freshIdxs.push(i);
  for (const cfg of configs.filter((c) => ["wheel", "put", "covered", "hold"].includes(c.strategy))) {
    const row = { id: cfg.id, years: {} };
    for (const h of HORIZONS) {
      const ann = [];
      for (const s of freshIdxs) {
        if (s + h.td > endIdx) continue;
        const run = simulate(ctx, { ...cfg, startIdx: s, endIdx: s + h.td });
        const total = run.nav[run.nav.length - 1] / run.nav[0];
        ann.push(total ** (1 / h.years) - 1);
      }
      ann.sort((a, b) => a - b);
      row.years[h.label] = {
        n: ann.length,
        mean: ann.length ? ann.reduce((a, b) => a + b, 0) / ann.length : null,
        median: quantile(ann, 0.5),
        p10: quantile(ann, 0.1),
        p90: quantile(ann, 0.9),
        worst: ann[0] ?? null,
      };
    }
    fresh.push(row);
  }

  // Sensitivity: IV level model and the carry assumption. Levels are (base, slope) pairs so
  // the table shows both a "no premium at all" floor and a much steeper vega-rich regime.
  const scenarios = opts.scenarios.length
    ? opts.scenarios
    : [
        { base: 0.12, slope: 0.0, label: "无溢价:IV=12%@全体" },
        { base: ctx.ivBase, slope: ctx.ivSlope, label: "标定值" },
        { base: 0.12, slope: 0.7, label: "强溢价:斜率 0.7" },
      ];
  const sensitivity = [];
  for (const s of scenarios) {
    for (const carry of ["dividend", "market"]) {
      const altCtx = {
        ...ctx,
        ivBase: s.base,
        ivSlope: s.slope,
        engine: makeEngine({ r: RISK_FREE_RATE, smile: ctx.smile, carry }),
      };
      const run = simulate(altCtx, { ...CANONICAL, strategy: "wheel", startIdx, endIdx });
      sensitivity.push({
        ivBase: s.base,
        ivSlope: s.slope,
        label: s.label ?? "",
        carry,
        cagr: cagr(run.nav),
        maxDrawdown: drawdown(run.nav),
        windows: Object.fromEntries(HORIZONS.map((h) => [h.label, summarize(run.nav, h.td, h.years)])),
        paired: Object.fromEntries(HORIZONS.map((h) => [h.label, paired(run.nav, etfSeries, h.td, h.years)])),
      });
    }
  }

  const result = {
    code: chain.code ?? "510050.SH",
    generatedAt: new Date().toISOString(),
    window: { start: ctx.dates[startIdx], end: ctx.dates[endIdx] },
    assumptions: {
      riskFreeRate: RISK_FREE_RATE,
      contractUnit: UNIT,
      tradingDaysPerYear: TD_PER_YEAR,
      feePerSide: FEE_PER_SIDE,
      minDaysToExpiry: MIN_DAYS_TO_EXPIRY,
      ivBase: ctx.ivBase,
      ivSlope: ctx.ivSlope,
      ivModel: `ATM IV = ${(ctx.ivBase * 100).toFixed(2)}% + ${ctx.ivSlope.toFixed(3)} × RV`,
      ivCalibration: ctx.calibration,
      ivFloor: ctx.ivFloor,
      ivCap: ctx.ivCap,
      carry: opts.carry,
      carryUsed: opts.carry === "market" ? MARKET_CARRY_Q : "trailing 12m ETF dividend",
      ivVsRealized: vrpCheck(ctx, startIdx, endIdx),
    },
    surface: { expiries: ctx.surface.expiries, smile: ctx.smile, atmIvPct: ctx.surface.atmIvPct },
    dividends: { count: ctx.divs.length, last: ctx.divs.slice(-5) },
    etf: etfSummary,
    configs: results.map((r) => ({
      id: r.id,
      strategy: r.strategy,
      group: r.group,
      tenorLabel: r.tenorLabel,
      tenorDays: r.tenorDays,
      putOtm: r.putOtm,
      callOtm: r.callOtm,
      callRule: r.callRule,
      windows: r.windows,
      paired: r.paired,
      navResult: r.navResult,
      continuous: r.continuous,
      cycleStats: r.cycleStats,
    })),
    fresh,
    sensitivity,
  };

  await writeFile(path.join(outDir, "wheel-backtest.json"), JSON.stringify(result, null, 1));
  const md = renderReport(result, results, ctx, { startIdx, endIdx, etfSeries });
  await writeFile(path.join(outDir, "wheel-backtest.md"), md);
  console.log(md);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const pct = (x, d = 1) => (x === null || x === undefined || Number.isNaN(x) ? "—" : `${(x * 100).toFixed(d)}%`);
const num = (x, d = 2) => (x === null || x === undefined || Number.isNaN(x) ? "—" : x.toFixed(d));

function renderReport(r, results, ctx, { startIdx, endIdx }) {
  const L = [];
  const push = (...x) => L.push(...x);
  const etf = results.find((x) => x.strategy === "hold");

  push(`# ${r.code} 卖方轮动（Wheel）回测：卖沽 → 被行权 → 卖认购`, "");
  push(`- 区间：**${r.window.start} → ${r.window.end}**（${(((endIdx - startIdx) / TD_PER_YEAR) || 0).toFixed(2)} 年）`);
  push(`- 标的：${r.code}（不复权价用于行权与结算，前复权价用于持有 ETF 的总收益基准）`);
  push(`- 合约单位 ${r.assumptions.contractUnit.toLocaleString()} 份/张，无风险利率 ${pct(r.assumptions.riskFreeRate, 2)}，每年 ${r.assumptions.tradingDaysPerYear} 个交易日`);
  push(`- ATM IV = **${num(r.assumptions.ivBase * 100, 2)}% + ${num(r.assumptions.ivSlope, 2)} × 已实现波动率**（由本仓库 ${r.assumptions.ivCalibration.n} 个 IV 观测标定，rmse ${num(r.assumptions.ivCalibration.rmse * 100, 1)} 个波动率点），微笑形状来自当日真实盘口`);
  push(`- 前向价按${r.assumptions.carry === "market" ? "盘口隐含基差" : "滚动 12 个月真实 ETF 分红"}推算；双边成本按盘口价差 + 每边 ${r.assumptions.feePerSide} 元/张`);
  push("");
  push("> **必读**：交易所行情源在合约摘牌后不再提供历史合约 K 线，仓库里没有可回溯的期权历史报价面板。");
  push("> 因此历史期权价格是**模型价**，不是成交价：价格路径真实、波动率水平由已实现波动率驱动、曲面形状与成本由当日真实盘口标定。");
  push("> 结论用于**比较不同规则的结构性差异**，不能当作可实现收益。", "");

  push("## 0. 结论速览", "");
  const wheelRows = results.filter((x) => x.strategy === "wheel");
  const best3 = [...wheelRows].sort((a, b) => (b.windows["3年"].median ?? -9) - (a.windows["3年"].median ?? -9))[0];
  const best1 = [...wheelRows].sort((a, b) => (b.windows["1年"].median ?? -9) - (a.windows["1年"].median ?? -9))[0];
  push(`- 3 年年化中位数最高的规则：**${best3.id}** → ${pct(best3.windows["3年"].median)}（持有 ETF 同期 ${pct(etf.windows["3年"].median)}）。`);
  push(`- 1 年年化中位数最高的规则：**${best1.id}** → ${pct(best1.windows["1年"].median)}（持有 ETF 同期 ${pct(etf.windows["1年"].median)}）。`);
  const canon = wheelRows.find((x) => x.id === `wheel_近月_put${Math.round(CANONICAL.putOtm * 100)}`);
  if (canon) {
    push(`- 基准规则（近月、卖虚值 5% 沽、卖虚值 3% 购）：1 年 ${pct(canon.windows["1年"].median)} / 2 年 ${pct(canon.windows["2年"].median)} / 3 年 ${pct(canon.windows["3年"].median)}，`);
    push(`  连续净值年化 ${pct(canon.continuous.cagr)}、最大回撤 ${pct(canon.continuous.maxDrawdown, 0)}，同期 ETF 年化 ${pct(etf.continuous.cagr)}、最大回撤 ${pct(etf.continuous.maxDrawdown, 0)}。`);
    push(`- 跑赢 ETF 的窗口占比：1 年 ${pct(canon.paired["1年"].beatRate, 0)}、2 年 ${pct(canon.paired["2年"].beatRate, 0)}、3 年 ${pct(canon.paired["3年"].beatRate, 0)}。`);
    push(`- 整段买入持有对比：基准规则累计 ${pct(canon.navResult - 1, 0)}、ETF 累计 ${pct(etf.navResult - 1, 0)}。`);
  }
  push("");
  push(`> **先看这一条**：滚动窗口中位数（${pct(canon?.windows["3年"].median)}）明显高于整段连续持有的年化（${pct(canon?.continuous.cagr)}），两者不矛盾也不冲突，而是回答了不同的问题。`);
  push(`> 中位数是「随便哪一天开始、持满 3 年」的典型值，它把 2015 年股灾前建仓的那些窗口也算了进去；连续净值只有**一条**路径，它的收益被起点和终点的位置决定。`);
  push(`> 本段里连续净值偏低，很大程度上是因为它从 2015-02 的高位起算、且终点刚好在相对低位。**不要只用任一个数字下结论**：中位数偏乐观（窗口高度重叠），连续净值偏单一路径（只反映一次运气）。`, "");

  push("## 1. 市场校准（来自当日真实盘口）", "");
  push("| 到期日 | 剩余天数 | 平价隐含远期 | 基差 | ATM IV |", "|---|---:|---:|---:|---:|");
  for (const e of r.surface.expiries) {
    push(`| ${e.expiry} | ${e.days} | ${num(e.forward, 4)} | ${pct(e.basisPct / 100, 2)} | ${num(e.atmIvPct, 1)}% |`);
  }
  push("");
  push(`- 波动率微笑拟合（相对 ATM）：σ(m)/σ(ATM) = 1 + ${num(r.surface.smile.a1 / r.surface.smile.c0, 2)}·m + ${num(r.surface.smile.a2 / r.surface.smile.c0, 2)}·m²，m = ln(K/F)，样本 ${r.surface.smile.n} 个。`);
  push(`  m² 系数为正说明两侧都贵（标准微笑），所以虚值越远、卖方收的权利金越厚，但尾部风险也越集中。`);
  push(`- 股息：从复权/不复权价差还原出 ${r.dividends.count} 次现金分红，最近几次 ${r.dividends.last.map((d) => `${d.date} ${d.cash.toFixed(4)}`).join("、")}。`);
  push(`- 关键：用**远期**而不是「现货 + 无风险利率」定价。忽略分红时同一行权价上会出现「call 13% / put 20%」的假偏斜，那是分红基差被错误地算进了 put 的波动率。`, "");

  push("## 2. 1 / 2 / 3 年收益（全部规则）", "");
  push("窗口为逐日滚动的重叠窗口，年化后统计分布。这些窗口高度重叠、彼此自相关，**不能**当作独立样本；它们的用途是看「在任何一天开始、持有 N 年」的分布形状，而不是统计显著性。", "");
  push(`同期持有 ETF 的中位数：1 年 ${pct(etf.windows["1年"].median)} / 2 年 ${pct(etf.windows["2年"].median)} / 3 年 ${pct(etf.windows["3年"].median)}；整段买入持有年化 ${pct(etf.continuous.cagr)}。`, "");
  push("| 规则 | 卖方方向 | 1年 中位 | 2年 中位 | 3年 中位 | 3年 P10 | 3年 最差 | 3年 胜率 | 连续年化 | 最大回撤 | 跑赢ETF(3年) |");
  push("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const x of results.filter((y) => y.strategy !== "hold")) {
    const desc = x.strategy === "wheel"
      ? `卖沽${(x.putOtm * 100).toFixed(0)}% / 卖购${x.callRule === "cost" ? "成本价" : (x.callOtm * 100).toFixed(0) + "%"}`
      : x.strategy === "put" ? "只卖沽（行权即卖出）" : "备兑（长期持有 + 卖购）";
    push(
      `| ${x.id} | ${desc} | ${pct(x.windows["1年"].median)} | ${pct(x.windows["2年"].median)} | ${pct(x.windows["3年"].median)} | ` +
      `${pct(x.windows["3年"].p10)} | ${pct(x.windows["3年"].worst)} | ${pct(x.windows["3年"].winRate, 0)} | ` +
      `${pct(x.continuous.cagr)} | ${pct(x.continuous.maxDrawdown, 0)} | ${x.paired["3年"] ? pct(x.paired["3年"].beatRate, 0) : "—"} |`
    );
  }
  push(
    `| **持有 ETF** | 满仓多头 | ${pct(etf.windows["1年"].median)} | ${pct(etf.windows["2年"].median)} | ${pct(etf.windows["3年"].median)} | ` +
    `${pct(etf.windows["3年"].p10)} | ${pct(etf.windows["3年"].worst)} | ${pct(etf.windows["3年"].winRate, 0)} | ` +
    `${pct(etf.continuous.cagr)} | ${pct(etf.continuous.maxDrawdown, 0)} | — |`
  );
  push("");

  push("## 3. 收益率分布（完整分位）", "");
  for (const h of HORIZONS) {
    push(`### ${h.label}`, "");
    push("| 规则 | 均值 | 中位 | P05 | P10 | P90 | P95 | 最好 | 最差 | 胜率 | 不重叠均值 |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
    for (const x of results) {
      const w = x.windows[h.label];
      const no = x.windows[`${h.label}_nonoverlap`];
      push(`| ${x.id} | ${pct(w.mean)} | ${pct(w.median)} | ${pct(w.p05)} | ${pct(w.p10)} | ${pct(w.p90)} | ${pct(w.p95)} | ${pct(w.best)} | ${pct(w.worst)} | ${pct(w.winRate, 0)} | ${pct(no.mean)} (n=${no.n}) |`);
    }
    push("");
  }

  push("## 4. 与持有 ETF 的配对比较", "");
  push("同一窗口、同一资金、同一路径下的年化差（策略 − ETF），正值代表跑赢。", "");
  push("| 规则 | 1年 均值 | 1年 中位 | 1年 胜率 | 2年 中位 | 2年 胜率 | 3年 中位 | 3年 胜率 | 3年 P10 |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const x of results.filter((y) => y.strategy !== "hold")) {
    const p = x.paired;
    push(`| ${x.id} | ${pct(p["1年"].mean)} | ${pct(p["1年"].median)} | ${pct(p["1年"].beatRate, 0)} | ${pct(p["2年"].median)} | ${pct(p["2年"].beatRate, 0)} | ${pct(p["3年"].median)} | ${pct(p["3年"].beatRate, 0)} | ${pct(p["3年"].p10)} |`);
  }
  push("");
  push("> 胜率低于 100% 是必然的：卖方策略牺牲右尾。真正的问题不是「能不能每年赢」，而是「赢的时候赢多少、输的时候输多少」。", "");

  push("## 5. 轮动过程统计", "");
  push("「实际虚值」是把目标虚值吸附到交易所行权价档位后的真实值：上证50ETF 在 3.00 元附近每 0.05 一档（约 1.7%），所以目标 5% 和 8% 经常落在同一个行权价上，这两行的差异可能只是抽样噪声。", "");
  push("| 规则 | 轮次 | 持股时间占比 | 实际卖沽虚值 | 实际卖购虚值 | 被行权次数 | 被行权率 | 被叫走次数 | 单轮胜率 | 单轮权利金/名义 |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const x of results.filter((y) => y.strategy !== "hold")) {
    const c = x.cycleStats;
    const putOtm = x.strategy === "covered" ? "—" : pct(c.putOtmMean, 1);
    const callOtm = x.strategy === "put" ? "—" : pct(c.callOtmMean, 1);
    push(`| ${x.id} | ${c.n} | ${pct(c.exposure, 0)} | ${putOtm} | ${callOtm} | ${c.assignments} | ${pct(c.assignmentRate, 0)} | ${c.called} | ${pct(c.winRate, 0)} | ${pct(c.premiumYieldMean, 2)} |`);
  }
  push("");
  push("> **持股时间占比**必须和第 2 节一起读。它高说明这条规则大部分时间其实就是「持有 ETF + 卖认购」，收益里含大量股票 beta；它低才是纯粹的期权卖方收益。把「卖购成本价」的 8% 直接当成「期权溢价」，等于把 2015 年之后的结构性上涨算成了卖权的功劳。", "");

  push("## 6. 每年已实现盈亏（基准规则，元）", "");
  if (canon) {
    push("| 年份 | 轮次 | 权利金收入 | 已实现盈亏 |", "|---|---:|---:|---:|");
    for (const [y, v] of Object.entries(canon.cycleStats.byYear)) {
      push(`| ${y} | ${v.n} | ${v.premium.toFixed(0)} | ${v.pnl.toFixed(0)} |`);
    }
  }
  push("");

  push("## 7. 新鲜起点（每个起点都从「卖沽」重新开始）", "");
  push("上面第 2 节是连续净值切片，起点状态可能已经在持股。这里每个起点都重新空仓开局，更接近「今天开始做」的真实体验。", "");
  push("| 规则 | 1年 中位 | 1年 P10 | 1年 最差 | 2年 中位 | 3年 中位 |", "|---|---:|---:|---:|---:|---:|");
  for (const f of r.fresh) {
    push(`| ${f.id} | ${pct(f.years["1年"].median)} | ${pct(f.years["1年"].p10)} | ${pct(f.years["1年"].worst)} | ${pct(f.years["2年"].median)} | ${pct(f.years["3年"].median)} |`);
  }
  push("");

  push("## 8. 假设敏感性", "");
  push("两个最大的主观假设是**波动率水平模型**和**远期基差口径**，单独看它们的边际影响。下面用基准规则（近月 / 卖沽 5% / 卖购 3%）重跑。", "");
  push("| IV 水平模型 | 基差口径 | 连续年化 | 最大回撤 | 1年 中位 | 3年 中位 | 3年 跑赢ETF |", "|---|---|---:|---:|---:|---:|---:|");
  for (const s of r.sensitivity) {
    const model = s.ivSlope === 0
      ? `固定 ${num(s.ivBase * 100, 0)}%`
      : `${num(s.ivBase * 100, 0)}% + ${num(s.ivSlope, 2)}×RV`;
    push(`| ${model} | ${s.carry === "market" ? "盘口隐含" : "实际分红"} | ${pct(s.cagr)} | ${pct(s.maxDrawdown, 0)} | ${pct(s.windows["1年"].median)} | ${pct(s.windows["3年"].median)} | ${pct(s.paired["3年"].beatRate, 0)} |`);
  }
  push("");
  const flat = r.sensitivity.find((s) => s.ivSlope === 0 && s.carry === "dividend");
  const calibrated = r.sensitivity.find(
    (s) => s.carry === "dividend"
      && Math.abs(s.ivBase - r.assumptions.ivBase) < 1e-9
      && Math.abs(s.ivSlope - r.assumptions.ivSlope) < 1e-9
  );
  if (flat) {
    push(`> 「固定 ${num(flat.ivBase * 100, 0)}%」表示完全不承认波动率随行情变化，是最悲观的下限（平静年份卖方被低估，恐慌年份反而被高估）。`);
  }
  if (calibrated) {
    const fromFit =
      Math.abs(calibrated.ivBase - r.assumptions.ivCalibration.base) < 5e-4
      && Math.abs(calibrated.ivSlope - r.assumptions.ivCalibration.slope) < 5e-3;
    if (fromFit) {
      push(`> 标定行（${num(calibrated.ivBase * 100, 1)}% + ${num(calibrated.ivSlope, 2)}×RV）来自 510050 在 ${r.assumptions.ivCalibration.n} 个交易日上的真实 ATM IV，RV 取值区间仅 ${num(r.assumptions.ivCalibration.rvMin * 100, 1)}%~${num(r.assumptions.ivCalibration.rvMax * 100, 1)}%，属于外推，斜率的不确定性是最大的误差来源。`);
    } else {
      push(`> 当前使用的 IV 模型（${num(calibrated.ivBase * 100, 1)}% + ${num(calibrated.ivSlope, 2)}×RV）是**命令行指定的**，不是标定值；数据本身的标定结果是 ${num(r.assumptions.ivCalibration.base * 100, 1)}% + ${num(r.assumptions.ivCalibration.slope, 2)}×RV（n=${r.assumptions.ivCalibration.n}，rmse ${num(r.assumptions.ivCalibration.rmse * 100, 1)} 个波动率点）。`);
    }
  }
  push("");

  push("## 9. 通用规则（可直接落地）", "");
  const tenorMed = {};
  for (const x of wheelRows.filter((y) => /^wheel_(近月|双月|季月)_put\d+$/.test(y.id))) {
    (tenorMed[x.tenorLabel] ??= []).push(x.windows["3年"].median);
  }
  for (const k of Object.keys(tenorMed)) tenorMed[k] = mean(0, tenorMed[k]);
  const tenorP10 = {};
  for (const x of wheelRows.filter((y) => /^wheel_(近月|双月|季月)_put\d+$/.test(y.id))) {
    (tenorP10[x.tenorLabel] ??= []).push(x.windows["3年"].p10);
  }
  for (const k of Object.keys(tenorP10)) tenorP10[k] = mean(0, tenorP10[k]);
  const tenorRank = Object.entries(tenorMed).sort((a, b) => b[1] - a[1]);
  const bestTenor = tenorRank[0];
  const rowOf = (id) => wheelRows.find((x) => x.id === id);
  const p0 = rowOf("wheel_近月_put0");
  const p10 = rowOf("wheel_近月_put10");
  push(`1. **期限的选择是「中位数」和「左尾」之间的取舍，不是简单的越长越好。** 各期限 3 年中位数的规则均值：${Object.entries(tenorMed).map(([k, v]) => `${k} ${pct(v)}`).join(" / ")}；3 年 P10 均值：${Object.entries(tenorP10).map(([k, v]) => `${k} ${pct(v)}`).join(" / ")}。中位数最高的是${bestTenor[0]}，左尾最厚的是${Object.entries(tenorP10).sort((a, b) => b[1] - a[1])[0][0]}。近月一年要滚十几次、每次跨一次盘口，滚仓成本最重；季月单轮权利金厚，但方向敞口暴露更久。这组数据里没有哪条期限在所有指标上占优，按你能承受的左尾来选，别只看中位数。`);
  push(`2. **不要卖平值。** 平值（0%）单轮权利金最厚，但 3 年 P10 是 ${pct(p0?.windows["3年"].p10)}、最差 ${pct(p0?.windows["3年"].worst)}；虚值 10% 的 3 年 P10 是 ${pct(p10?.windows["3年"].p10)}、最差 ${pct(p10?.windows["3年"].worst)}。卖平值是用确定的尾部风险换不确定的权利金，而虚值 5%~10% 把同样的钱换成了更瘦的左尾。`);
  push(`3. **卖认购的行权价决定你是「卖方」还是「多头」。** 卖购 0%~2% 频繁被叫走，策略长期空仓等下一次卖沽，收益反而最低（见第 5 节「持股时间占比」）；卖在成本价上方会长期捂股，年化看起来最高，但本质接近「持有 ETF + 收一点权利金」，它的收益主要来自股票 beta 而不是卖权。**先决定你要的敞口，再选卖购行权价**，不要只看年化排名。`);
  push(`4. **被行权后不要在成本价下方卖认购。** 那等于把浮亏锁成实亏，而且卖掉的正是反弹时最值钱的右尾。要么在成本价上方等，要么直接认赔换标的。`);
  push(`5. **仓位用「行权价 × 10,000」的现金全额担保，不要用保证金口径。** 交易所最低保证金约为标的市值的 7%~12%，同样的钱能开到 8~14 倍名义敞口；回撤会按同一倍数放大，那不是「更有效率的 wheel」，是另一笔交易。`);
  push(`6. **分红必须进定价。** ETF 每年 11-12 月除息，除息日前后远期价格整体下移，卖沽在除息前看起来权利金更厚，实质是替买方承担了分红。用远期（F = S·e^(r−q)T）而不是「现货 + 无风险利率」，才不会把分红算成免费收益，也不会推出假偏斜。`);
  push(`7. **成本按盘口算，别按中间价。** 卖方收买一价、买方付卖一价。近月平值往返约 3%~4%，±10% 虚值约 7%~10%，远月 7%~9%。按中间价估算会系统性高估卖方收益，这也是近月规则最容易失真的地方。`);
  push(`8. **接受「多数时候小幅跑赢、少数时候大幅跑输」。** 基准规则只有约一半的 3 年窗口跑赢 ETF，赢几个点、输可能输十几个点。这是卖方策略的定义性特征，不是可以优化掉的缺陷。`, "");

  const vrp = r.assumptions.ivVsRealized;
  const sens = r.sensitivity;
  const sensLo = Math.min(...sens.map((s) => s.cagr).filter((x) => x !== null));
  const sensHi = Math.max(...sens.map((s) => s.cagr).filter((x) => x !== null));
  push("## 10. 已知局限", "");
  push("1. **历史期权价是模型价**：交易所不再提供摘牌合约 K 线，无法回放真实历史报价。模型价对「结构比较」有效，对「绝对收益」无效。");
  push(`2. **IV 水平模型是最大的误差来源。** 标定只在 ${r.assumptions.ivCalibration.n} 个交易日、RV ${pct(r.assumptions.ivCalibration.rvMin)}~${pct(r.assumptions.ivCalibration.rvMax)} 的区间内做过，2015 年那种行情属于外推。第 8 节显示换一组（截距，斜率）就能把连续年化从 ${pct(sensLo)} 挪到 ${pct(sensHi)}——不要把点估计当成结论。`);
  push(`3. **模型的 IV 与随后实现的波动率基本打平**：全样本 ${vrp.n} 个观测，平均建模 IV ${pct(vrp.ivMean)}、随后 ${vrp.horizonDays} 个交易日的实际波动率 ${pct(vrp.rvMean)}，IV 高于 RV 的时点占 ${pct(vrp.ivHigherRate, 0)}。这是刻意选择的保守设定——卖方没有白拿溢价，但也没有被系统性地亏待。如果历史真实 IV 一贯更高，本文会低估卖方；反之则高估。`);
  push("4. **未建模盘中行权与提前了结**：上证 ETF 期权是欧式、到期实物交割，模型按到期收盘结算，不模拟盘中滚动或提前平仓。真实卖方常在权利金衰减 50%~70% 时提前买回，这会改变成本与收益分布。");
  push("5. **未建模流动性约束**：极端虚值档位可能有价无市，模型假设总能按盘口成交；深虚值合约的实际成交滑点远大于模型成本。模型用分数张合约以保持约 1 倍名义敞口，实盘必须取整，小资金会被整张约束明显扭曲。");
  const lastExpiry = r.surface.expiries[r.surface.expiries.length - 1];
  const annualBasis = lastExpiry.basisPct / 100 * (365 / lastExpiry.days);
  const annDiv = mean(0, Array.from({ length: endIdx - startIdx + 1 }, (_, k) => ctx.divYield[startIdx + k]));
  push(`6. **分红与基差**：前向价用滚动 12 个月实际派息推算，除息金额在公告前未知，约有 1 个季度时滞。当日盘口用平价关系反推出的基差在最长端（${lastExpiry.days} 天）是 ${pct(lastExpiry.basisPct / 100, 2)}，年化约 ${pct(annualBasis, 1)}；而样本期实际分红率的均值只有 ${pct(annDiv, 1)}。这个 ${pct(annualBasis - annDiv, 1)} 的缺口没有历史数据可以解释（可能包含借券成本、税费与流动性溢价），本文默认不做假设，只把它列进第 8 节的敏感性。`);
  push("7. **单标的、单一路径**：只对 510050 做了完整回测；跨标的（300ETF、500ETF、科创50）需要各自重跑，波动率和偏斜结构不同，结论不能直接移植。");
  push("8. **窗口高度重叠**：第 2 节的中位数来自彼此自相关的滚动窗口，不构成独立样本，不能用来做显著性检验或构造置信区间。", "");
  return L.join("\n");
}

main().catch((e) => {
  console.error(`wheel backtest failed: ${e.message}`);
  process.exitCode = 1;
});
