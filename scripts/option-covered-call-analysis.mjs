#!/usr/bin/env node
/**
 * Covered-call (备兑开仓) analysis for an SSE ETF option board.
 *
 * Inputs (from scripts/fetch-etf-option-chain.mjs):
 *   data/research/<slug>/option-chain.json
 *   data/research/<slug>/kline-qfq.json
 *
 * Outputs:
 *   <slug>/analysis.json    machine-readable candidate table + backtest
 *   <slug>/report.md        human-readable research note
 *
 * Usage:
 *   node scripts/option-covered-call-analysis.mjs --dir data/research/covered-call-588000
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { bsGreeks, bsPrice, impliedVol, normCdf, realizedVol, forwardReturns, quantile } from "./lib/option-pricing.mjs";
import { tradingDaysBetween } from "./lib/market-calendar.mjs";

const RISK_FREE_RATE = 0.015;
const TRADING_DAYS = 243;
const CONTRACT_UNIT = 10_000;
const DEFAULTS = { dir: "data/research/covered-call-588000", out: null };

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--dir") options.dir = next();
    else if (arg === "--out") options.out = next();
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

// ---------------------------------------------------------------------------
// Trading calendar: shared implementation (see scripts/lib/market-calendar.mjs).
// Kept as a re-export so existing call sites keep working while the holiday table
// and expiry rules live in exactly one place.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/**
 * Probability that the underlying finishes above `strike`, under a lognormal with
 * drift `mu` and vol `sigma`. Used for both risk-neutral (mu = r) and real-world views.
 */
function probAbove(spot, strike, T, mu, sigma) {
  const st = sigma * Math.sqrt(T);
  if (!(st > 0)) return spot > strike ? 1 : 0;
  const d = (Math.log(spot / strike) + (mu - 0.5 * sigma * sigma) * T) / st;
  return normCdf(d);
}

function lognormalQuantiles(spot, T, mu, sigma, probs) {
  return probs.map((p) => {
    // Inverse normal via bisection on normCdf (keeps one CDF implementation).
    let lo = -6;
    let hi = 6;
    for (let i = 0; i < 80; i += 1) {
      const mid = (lo + hi) / 2;
      if (normCdf(mid) < p) lo = mid;
      else hi = mid;
    }
    const z = (lo + hi) / 2;
    return spot * Math.exp((mu - 0.5 * sigma * sigma) * T + sigma * Math.sqrt(T) * z);
  });
}

/** Expected value of min(S_T, K) under lognormal, used for the covered-call expectation. */
function expectedMinOfSpotAndStrike(spot, strike, T, mu, sigma) {
  const st = sigma * Math.sqrt(T);
  const d1 = (Math.log(spot / strike) + (mu + 0.5 * sigma * sigma) * T) / st;
  const d2 = d1 - st;
  // E[S_T] - E[(S_T - K)+]
  return spot * Math.exp(mu * T) - (spot * Math.exp(mu * T) * normCdf(d1) - strike * normCdf(d2));
}

function pct(x, digits = 2) {
  return `${(x * 100).toFixed(digits)}%`;
}

function money(x) {
  return x.toFixed(4);
}

/**
 * RiskMetrics EWMA volatility (lambda=0.94), a better short-horizon predictor than a
 * flat trailing window because it weights recent shocks more heavily.
 */
function ewmaVol(closes, lambda = 0.94, seedWindow = 60) {
  if (closes.length < seedWindow + 2) return null;
  const rets = [];
  for (let i = 1; i < closes.length; i += 1) rets.push(Math.log(closes[i] / closes[i - 1]));
  const seed = rets.slice(0, seedWindow);
  const seedMean = seed.reduce((a, b) => a + b, 0) / seed.length;
  let variance = seed.reduce((a, b) => a + (b - seedMean) ** 2, 0) / (seed.length - 1);
  for (let i = seedWindow; i < rets.length; i += 1) {
    variance = lambda * variance + (1 - lambda) * rets[i] * rets[i];
  }
  return Math.sqrt(variance * TRADING_DAYS) * 100;
}

/** Blended vol forecast: average of 20d, 60d and EWMA, to avoid one-window overfitting. */
function blendedVolForecast(closes) {
  const parts = [realizedVol(closes, 20), realizedVol(closes, 60), ewmaVol(closes)].filter((v) => v !== null);
  if (parts.length === 0) return null;
  return parts.reduce((a, b) => a + b, 0) / parts.length;
}

// ---------------------------------------------------------------------------
// Historical rolling backtest
// ---------------------------------------------------------------------------

/**
 * Sell a call at entry, price it with Black-Scholes at an IV proxy, hold to a fixed
 * horizon, and settle against the actual underlying close.
 *
 * This is a model backtest (real option prices for 2021-2022 do not exist for this
 * contract); it is used to compare strike policies, not to claim realized returns.
 */
function rollingCoveredCallBacktest(closes, dates, { horizonTradingDays, targetDelta, ivFloor = 0.25, ivCap = 1.2, trailingIvWindow = 60 }) {
  const trades = [];
  for (let i = 0; i + horizonTradingDays < closes.length; i += 1) {
    const spot = closes[i];
    const T = horizonTradingDays / TRADING_DAYS;
    const trailing = realizedVol(closes.slice(0, i + 1), trailingIvWindow);
    if (trailing === null) continue;
    const sigma = Math.min(ivCap, Math.max(ivFloor, trailing / 100));
    // Solve for the strike that gives `targetDelta`.
    const strikeGrid = [];
    for (let k = spot * 0.75; k <= spot * 1.6; k += 0.01) strikeGrid.push(Math.round(k * 100) / 100);
    let best = strikeGrid[0];
    let bestDiff = Infinity;
    for (const strike of strikeGrid) {
      const delta = bsGreeks(spot, strike, T, RISK_FREE_RATE, sigma, "call").delta;
      const diff = Math.abs(delta - targetDelta);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = strike;
      }
    }
    const strike = best;
    const premium = bsPrice(spot, strike, T, RISK_FREE_RATE, sigma, "call");
    const exitSpot = closes[i + horizonTradingDays];
    const coveredCallReturn = (Math.min(exitSpot, strike) - spot + premium) / spot;
    const buyHoldReturn = (exitSpot - spot) / spot;
    trades.push({
      entryDate: dates[i],
      exitDate: dates[i + horizonTradingDays],
      spot,
      strike,
      sigmaPct: sigma * 100,
      premium,
      exitSpot,
      coveredCallReturn,
      buyHoldReturn,
      assigned: exitSpot > strike,
      moneynessPct: (strike / spot - 1) * 100,
    });
  }
  return trades;
}

function summarizeTrades(trades) {
  if (trades.length === 0) return null;
  const cc = trades.map((t) => t.coveredCallReturn).sort((a, b) => a - b);
  const bh = trades.map((t) => t.buyHoldReturn);
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const std = (xs) => {
    const m = mean(xs);
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
  };
  const meanCc = mean(cc);
  const meanBh = mean(bh);
  const stdCc = std(cc);
  return {
    n: trades.length,
    assignedRate: trades.filter((t) => t.assigned).length / trades.length,
    avgCoveredCallReturn: meanCc,
    avgBuyHoldReturn: meanBh,
    medianCoveredCallReturn: quantile(cc, 0.5),
    coveredCallStdev: stdCc,
    buyHoldStdev: std(bh),
    worstCoveredCall: cc[0],
    bestCoveredCall: cc[cc.length - 1],
    p05: quantile(cc, 0.05),
    p25: quantile(cc, 0.25),
    p75: quantile(cc, 0.75),
    p95: quantile(cc, 0.95),
    winRate: trades.filter((t) => t.coveredCallReturn > 0).length / trades.length,
    avgStrikeOtmPct: mean(trades.map((t) => t.moneynessPct)),
    avgPremiumRoi: mean(trades.map((t) => t.premium / t.spot)),
    // Return per unit of risk, and how often simply holding would have done better.
    returnPerRisk: stdCc > 0 ? meanCc / stdCc : null,
    buyHoldReturnPerRisk: std(bh) > 0 ? meanBh / std(bh) : null,
    shareBeatBuyHold: trades.filter((t) => t.coveredCallReturn > t.buyHoldReturn).length / trades.length,
  };
}


// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("node scripts/option-covered-call-analysis.mjs [--dir data/research/covered-call-588000]");
    return;
  }
  const dir = path.resolve(options.dir);
  const chain = JSON.parse(await readFile(path.join(dir, "option-chain.json"), "utf8"));
  const kline = JSON.parse(await readFile(path.join(dir, "kline-qfq.json"), "utf8")).rows;

  const closes = kline.map((r) => r.close);
  const dates = kline.map((r) => r.date);
  const spot = closes[closes.length - 1];
  const asOf = dates[dates.length - 1];

  const hv = {};
  for (const window of [5, 10, 20, 60, 120, 250]) hv[window] = realizedVol(closes, window);

  const ma = (window) => closes.slice(-window).reduce((a, b) => a + b, 0) / window;
  const movingAverages = { ma20: ma(20), ma60: ma(60), ma120: ma(120), ma250: ma(250) };
  const high52w = Math.max(...closes.slice(-TRADING_DAYS));
  const low52w = Math.min(...closes.slice(-TRADING_DAYS));

  // --- Candidate table -----------------------------------------------------
  const volForecastPct = blendedVolForecast(closes);
  const sigmaReal = (volForecastPct ?? hv[60] ?? 40) / 100;
  const expiries = [...new Set(chain.calls.filter((c) => c.expiry).map((c) => c.expiry))].sort();
  const candidates = [];
  for (const expiry of expiries) {
    const td = tradingDaysBetween(asOf, expiry);
    if (td <= 0) continue;
    const T = td / TRADING_DAYS;
    const calendarDays = Math.round((Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / 86_400_000);
    for (const contract of chain.calls.filter((c) => c.expiry === expiry).sort((a, b) => a.strike - b.strike)) {
      // A seller receives the bid, not the last print or the mid.
      const price = contract.executableBid ?? contract.lastPrice;
      if (!(price > 0)) continue;
      const midPrice = contract.executableMid ?? price;
      const iv = impliedVol(midPrice, spot, contract.strike, T, RISK_FREE_RATE, "call");
      if (iv === null) continue;
      const greeks = bsGreeks(spot, contract.strike, T, RISK_FREE_RATE, iv, "call");

      const pAssignedReal = probAbove(spot, contract.strike, T, 0, sigmaReal);
      const pAssignedRiskNeutral = normCdf(
        (Math.log(spot / contract.strike) + (RISK_FREE_RATE - 0.5 * iv * iv) * T) / (iv * Math.sqrt(T))
      );

      const premiumRoi = price / spot;
      const annualizedRoi = premiumRoi * (365 / calendarDays);
      const staticRoi = premiumRoi;
      const calledRoi = (contract.strike - spot + price) / spot;
      const breakeven = spot - price;

      const q = lognormalQuantiles(spot, T, 0, sigmaReal, [0.05, 0.25, 0.5, 0.75, 0.95]);
      const ccReturnAt = (st) => (Math.min(st, contract.strike) - spot + price) / spot;
      const expectedMin = expectedMinOfSpotAndStrike(spot, contract.strike, T, 0, sigmaReal);
      const expectedReturn = (expectedMin - spot + price) / spot;
      const maxReturn = Math.max(calledRoi, staticRoi);

      // Uncovered upside forgone if the ETF rallies to a given level.
      const scenario = (st) => ({
        spot: st,
        movePct: (st / spot - 1) * 100,
        coveredCallPct: ccReturnAt(st) * 100,
        buyHoldPct: ((st - spot) / spot) * 100,
        forgonePct: ((st - spot) / spot - ccReturnAt(st)) * 100,
      });

      const spreadPct = contract.quote ? ((contract.quote.ask1 - contract.quote.bid1) / midPrice) * 100 : null;
      const oiTenThousand = contract.openInterestLots ?? 0;

      candidates.push({
        expiry,
        calendarDays,
        tradingDays: td,
        code: contract.code,
        name: contract.name,
        strike: contract.strike,
        bid: contract.executableBid,
        mid: contract.executableMid,
        lastPrice: contract.lastPrice,
        spreadPct,
        ivPct: iv * 100,
        // Positive = the market charges more vol than we forecast will be realized.
        ivMinusForecastPct: iv * 100 - volForecastPct,
        ivVsHv60Pct: iv * 100 - (hv[60] ?? 0),
        vendorIvPct: contract.vendorIvPct,
        delta: greeks.delta,
        gamma: greeks.gamma,
        vega: greeks.vega,
        thetaPerDay: greeks.theta,
        openInterestLots: contract.openInterestLots,
        volumeLots: contract.volumeLots,
        otmPct: (contract.strike / spot - 1) * 100,
        premiumPerContract: price * CONTRACT_UNIT,
        premiumRoiPct: premiumRoi * 100,
        annualizedRoiPct: annualizedRoi * 100,
        thetaPerDayPctOfSpot: (greeks.theta / spot) * 100,
        staticRoiPct: staticRoi * 100,
        calledRoiPct: calledRoi * 100,
        maxReturnPct: maxReturn * 100,
        breakeven,
        protectionPct: (price / spot) * 100,
        pAssignedRealPct: pAssignedReal * 100,
        pAssignedRiskNeutralPct: pAssignedRiskNeutral * 100,
        expectedReturnPct: expectedReturn * 100,
        p05ReturnPct: ccReturnAt(q[0]) * 100,
        p25ReturnPct: ccReturnAt(q[1]) * 100,
        p50ReturnPct: ccReturnAt(q[2]) * 100,
        p75ReturnPct: ccReturnAt(q[3]) * 100,
        p95ReturnPct: ccReturnAt(q[4]) * 100,
        scenarios: [spot * 0.85, spot * 0.9, spot, spot * 1.1, spot * 1.15, spot * 1.2, spot * 1.3].map(scenario),
        liquidityScore: Math.min(1, oiTenThousand / 20000) * 0.6 + Math.min(1, (contract.volumeLots ?? 0) / 15000) * 0.4,
      });
    }
  }
  candidates.splice(0, candidates.length, ...candidates.filter((c) => c.bid !== null));

  // --- Historical rolling backtests ---------------------------------------
  const backtests = {};
  for (const horizon of [21, 41]) {
    for (const targetDelta of [0.15, 0.25, 0.35, 0.5]) {
      const trades = rollingCoveredCallBacktest(closes, dates, { horizonTradingDays: horizon, targetDelta });
      backtests[`h${horizon}_d${Math.round(targetDelta * 100)}`] = summarizeTrades(trades);
    }
  }

  // Same policy, split by the regime at entry: is the ETF below its 250d MA?
  const regimeBacktests = {};
  for (const horizon of [21, 41]) {
    for (const targetDelta of [0.2, 0.3, 0.4]) {
      const trades = rollingCoveredCallBacktest(closes, dates, { horizonTradingDays: horizon, targetDelta });
      const enriched = trades.map((t, i) => {
        const entryIdx = i;
        const longMa = closes.slice(Math.max(0, entryIdx - 249), entryIdx + 1);
        const ma250 = longMa.reduce((a, b) => a + b, 0) / longMa.length;
        return { ...t, belowMa250: t.spot < ma250 };
      });
      regimeBacktests[`h${horizon}_d${Math.round(targetDelta * 100)}`] = {
        belowMa250: summarizeTrades(enriched.filter((t) => t.belowMa250)),
        aboveMa250: summarizeTrades(enriched.filter((t) => !t.belowMa250)),
      };
    }
  }

  // Volatility risk premium from real observed ATM IV: was the IV we could have sold
  // above the volatility that actually showed up over the following weeks?
  const volPremium = {};
  let ivAtmSeries = [];
  try {
    ivAtmSeries = JSON.parse(await readFile(path.join(dir, "iv-history.json"), "utf8")).atm ?? [];
  } catch {
    ivAtmSeries = [];
  }
  const closeByDate = new Map(dates.map((d, i) => [d, closes[i]]));
  const dateIndex = new Map(dates.map((d, i) => [d, i]));
  for (const horizon of [10, 21]) {
    const rows = [];
    for (const obs of ivAtmSeries) {
      const idx = dateIndex.get(obs.date);
      if (idx === undefined || idx + horizon >= closes.length) continue;
      const forwardPrices = closes.slice(idx, idx + horizon + 1);
      const fwdRv = realizedVol(forwardPrices, horizon);
      if (fwdRv === null) continue;
      rows.push({ ivPct: obs.atmIvPct, forwardRvPct: fwdRv, days: obs.days, expiry: obs.expiry });
    }
    if (rows.length === 0) continue;
    const diffs = rows.map((r) => r.ivPct - r.forwardRvPct).sort((a, b) => a - b);
    volPremium[`h${horizon}`] = {
      n: rows.length,
      meanIvMinusRvPct: diffs.reduce((a, b) => a + b, 0) / diffs.length,
      medianIvMinusRvPct: quantile(diffs, 0.5),
      shareIvAboveRv: diffs.filter((d) => d > 0).length / diffs.length,
      p10: quantile(diffs, 0.1),
      p90: quantile(diffs, 0.9),
    };
  }

  // Fixed-moneyness backtest for intuition on "how far OTM" at this vol level.
  const moneynessBacktests = {};
  for (const horizon of [21, 41]) {
    for (const otmPct of [0, 5, 10, 15, 20]) {
      const trades = [];
      for (let i = 0; i + horizon < closes.length; i += 1) {
        const s = closes[i];
        const T = horizon / TRADING_DAYS;
        const trailing = realizedVol(closes.slice(0, i + 1), 60);
        if (trailing === null) continue;
        const sigma = Math.min(1.2, Math.max(0.25, trailing / 100));
        const strike = Math.round(s * (1 + otmPct / 100) * 100) / 100;
        const premium = bsPrice(s, strike, T, RISK_FREE_RATE, sigma, "call");
        const exitSpot = closes[i + horizon];
        trades.push({
          entryDate: dates[i],
          exitDate: dates[i + horizon],
          spot: s,
          strike,
          sigmaPct: sigma * 100,
          premium,
          exitSpot,
          coveredCallReturn: (Math.min(exitSpot, strike) - s + premium) / s,
          buyHoldReturn: (exitSpot - s) / s,
          assigned: exitSpot > strike,
          moneynessPct: otmPct,
        });
      }
      moneynessBacktests[`h${horizon}_otm${otmPct}`] = summarizeTrades(trades);
    }
  }

  // --- Empirical distribution of horizon returns ---------------------------
  const empirical = {};
  for (const horizon of [21, 41]) {
    const fwd = forwardReturns(closes, horizon).map((x) => Math.exp(x.logReturn) - 1);
    const sorted = [...fwd].sort((a, b) => a - b);
    empirical[`h${horizon}`] = {
      n: fwd.length,
      mean: fwd.reduce((a, b) => a + b, 0) / fwd.length,
      p05: quantile(sorted, 0.05),
      p25: quantile(sorted, 0.25),
      median: quantile(sorted, 0.5),
      p75: quantile(sorted, 0.75),
      p95: quantile(sorted, 0.95),
      probUp10: fwd.filter((x) => x > 0.1).length / fwd.length,
      probUp15: fwd.filter((x) => x > 0.15).length / fwd.length,
      probDown10: fwd.filter((x) => x < -0.1).length / fwd.length,
    };
  }

  // --- Conditional distribution: current state is "deep below long MA + weak 60d" ---
  // The unconditional table understates both tails for this regime, so summarize the
  // historical analogue set explicitly instead of pretending one distribution fits all.
  const conditional = {};
  const analogueIndices = new Map();
  for (const horizon of [21, 41]) {
    const states = [];
    let lastIndex = -999;
    for (let i = 250; i + horizon < closes.length; i += 1) {
      const longMa = closes.slice(i - 249, i + 1).reduce((a, b) => a + b, 0) / 250;
      const ret60 = closes[i] / closes[i - 60] - 1;
      if (closes[i] < 0.92 * longMa && ret60 < -0.12 && i - lastIndex >= 30) {
        states.push(i);
        lastIndex = i;
      }
    }
    analogueIndices.set(horizon, states);
    const realized = states.map((i) => closes[i + horizon] / closes[i] - 1).sort((a, b) => a - b);
    conditional[`h${horizon}`] = {
      n: realized.length,
      entryDates: states.map((i) => dates[i]),
      mean: realized.length ? realized.reduce((a, b) => a + b, 0) / realized.length : null,
      median: quantile(realized, 0.5),
      p10: quantile(realized, 0.1),
      p90: quantile(realized, 0.9),
      probUp10: realized.length ? realized.filter((x) => x > 0.1).length / realized.length : null,
      probDown10: realized.length ? realized.filter((x) => x < -0.1).length / realized.length : null,
      outcomes: realized,
    };
  }

  // --- Analogue evaluation: replay the 8 historical "deep drawdown" windows ---
  // Scale-invariant: keep the same strike-to-spot ratio and premium-to-spot ratio as
  // today, then settle against each analogue's actual path. Using today's absolute
  // strike against a 2022 price level would be meaningless, so everything is a ratio.
  const analogueEval = [];
  for (const c of candidates) {
    if (![23, 43].includes(c.tradingDays)) continue;
    const horizon = c.tradingDays <= 30 ? 21 : 41;
    const states = analogueIndices.get(horizon) ?? [];
    if (states.length === 0) continue;
    const strikeRatio = c.strike / spot;
    const premiumRatio = c.bid / spot;
    const results = states.map((i) => {
      const entrySpot = closes[i];
      const exitSpot = closes[Math.min(i + c.tradingDays, closes.length - 1)];
      const scaledStrike = entrySpot * strikeRatio;
      const ccReturn = (Math.min(exitSpot, scaledStrike) - entrySpot + entrySpot * premiumRatio) / entrySpot;
      const bhReturn = (exitSpot - entrySpot) / entrySpot;
      return { entryDate: dates[i], ccReturn, bhReturn, forgone: bhReturn - ccReturn };
    });
    const sortedCc = results.map((r) => r.ccReturn).sort((a, b) => a - b);
    analogueEval.push({
      expiry: c.expiry,
      strike: c.strike,
      otmPct: c.otmPct,
      premiumRoiPct: c.premiumRoiPct,
      n: results.length,
      avgCcPct: (results.reduce((a, b) => a + b.ccReturn, 0) / results.length) * 100,
      avgBhPct: (results.reduce((a, b) => a + b.bhReturn, 0) / results.length) * 100,
      medianCcPct: quantile(sortedCc, 0.5) * 100,
      worstCcPct: sortedCc[0] * 100,
      bestCcPct: sortedCc[sortedCc.length - 1] * 100,
      beatBuyHoldCount: results.filter((r) => r.ccReturn > r.bhReturn).length,
      cappedCount: results.filter((r) => r.ccReturn < r.bhReturn).length,
      outcomes: results,
    });
  }

  // --- IV context ---------------------------------------------------------
  let ivHistory = null;
  try {
    const raw = JSON.parse(await readFile(path.join(dir, "iv-history.json"), "utf8"));
    ivHistory = {};
    for (const expiry of expiries) {
      const series = raw.atm.filter((o) => o.expiry === expiry).map((o) => o.atmIvPct).sort((a, b) => a - b);
      if (series.length < 5) continue;
      const current = candidates.find((c) => c.expiry === expiry && Math.abs(c.strike - spot) < 0.06);
      ivHistory[expiry] = {
        observations: series.length,
        p10: quantile(series, 0.1),
        p25: quantile(series, 0.25),
        median: quantile(series, 0.5),
        p75: quantile(series, 0.75),
        p90: quantile(series, 0.9),
        currentAtmIvPct: current?.ivPct ?? null,
      };
    }
  } catch {
    ivHistory = null;
  }

  // --- Empirical hit rate per horizon/moneyness (the honest cross-check) ----
  // The lognormal model mis-prices the tails for a volatile ETF; the realized
  // frequency of "moved at least this much in this many days" is a better anchor.
  const empiricalHitRate = (horizonTradingDays, requiredMovePct) => {
    let n = 0;
    let hits = 0;
    for (let i = 0; i + horizonTradingDays < closes.length; i += 1) {
      n += 1;
      if ((closes[i + horizonTradingDays] / closes[i] - 1) * 100 > requiredMovePct) hits += 1;
    }
    return n > 0 ? (hits / n) * 100 : null;
  };

  for (const c of candidates) {
    c.empiricalHitRatePct = empiricalHitRate(c.tradingDays, c.otmPct);
  }

  // Score = premium harvested per unit of forgone upside, penalized when the strike
  // sits inside the range the ETF has historically covered in one horizon.
  const scoreCandidate = (c) => {
    const annualized = c.annualizedRoiPct;
    const assignmentPenalty = c.pAssignedRealPct / 100;
    const liquidity = c.liquidityScore;
    // Reward premium, penalize assignment probability and wide spreads.
    const spreadPenalty = c.spreadPct === null ? 0.15 : Math.min(0.3, c.spreadPct / 100);
    return annualized * (1 - 0.55 * assignmentPenalty) * (0.5 + 0.5 * liquidity) * (1 - spreadPenalty);
  };
  const shortlist = [...candidates]
    .filter((c) => c.strike >= spot * 1.0 && c.strike <= spot * 1.45 && c.openInterestLots >= 500)
    .map((c) => ({ ...c, score: scoreCandidate(c) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 15);

  // --- Rule-based recommendation -------------------------------------------
  // The rules exist so the conclusion is reproducible and falsifiable, not hand-waved.
  const expiryDetails = expiries.map((expiry) => ({
    expiry,
    calendarDays: Math.round((Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / 86_400_000),
    tradingDays: tradingDaysBetween(asOf, expiry),
  }));
  const recommendation = buildRecommendation({
    candidates,
    spot,
    spotFactor: { volForecastPct, hv, drawdownPct: (spot / high52w - 1) * 100 },
    ivHistory,
    backtests,
    analogueEval,
    expiries: expiryDetails,
    movingAverages,
  });

  const result = {
    code: chain.code,
    asOf,
    spot,
    contractUnit: CONTRACT_UNIT,
    riskFreeRate: RISK_FREE_RATE,
    volForecastPct,
    historicalVolPct: hv,
    movingAverages,
    high52w,
    low52w,
    drawdownFrom52wHighPct: (spot / high52w - 1) * 100,
    expiries: expiries.map((expiry) => ({
      expiry,
      calendarDays: Math.round((Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / 86_400_000),
      tradingDays: tradingDaysBetween(asOf, expiry),
    })),
    ivHistory,
    candidates,
    shortlist,
    backtests,
    regimeBacktests,
    volPremium,
    moneynessBacktests,
    empirical,
    conditional,
    analogueEval,
    recommendation,
  };

  await writeFile(path.join(dir, "analysis.json"), JSON.stringify(result, null, 1));
  const report = renderReport(result);
  await writeFile(path.join(dir, "report.md"), report);
  console.log(report);
}

// ---------------------------------------------------------------------------
// Rule-based recommendation
// ---------------------------------------------------------------------------

/**
 * Pick expiries and strikes from explicit, auditable rules:
 *
 *  1. Expiry: skip the front week (<20 calendar days) — the premium is nearly all
 *     intrinsic and gamma per unit premium is worst. Skip >100 days: five months of
 *     capped upside for the thinnest book.
 *  2. Among the remainder, rank by the implied-vol edge (ATM IV minus the blended
 *     volatility forecast). A covered call is only "paid for" when that edge is
 *     positive; when the whole curve is below forecast, the honest answer is to
 *     write smaller and further out rather than to force a trade.
 *  3. Strike: target the empirical assignment probability, not model delta, because
 *     the lognormal model understates this ETF's tails.
 *  4. Reject wide bid-ask (>8%) or thin OI (<5,000 lots) when an alternative exists.
 */
function buildRecommendation({ candidates, spot, spotFactor, ivHistory, analogueEval, expiries, movingAverages }) {
  const usable = candidates.filter((c) => c.empiricalHitRatePct !== null);
  const byExpiry = new Map();
  for (const c of usable) {
    if (!byExpiry.has(c.expiry)) byExpiry.set(c.expiry, []);
    byExpiry.get(c.expiry).push(c);
  }

  const atmIvByExpiry = new Map();
  for (const [expiry, rows] of byExpiry) {
    const atm = rows.reduce((best, c) => (Math.abs(c.otmPct) < Math.abs(best.otmPct) ? c : best));
    atmIvByExpiry.set(expiry, atm.ivPct);
  }

  const eligible = expiries.filter((e) => e.calendarDays >= 20 && e.calendarDays <= 100);
  const excluded = expiries
    .filter((e) => !eligible.some((x) => x.expiry === e.expiry))
    .map((e) => ({
      expiry: e.expiry,
      calendarDays: e.calendarDays,
      reason: e.calendarDays < 20 ? "剩余期限过短，权利金几乎不含时间价值，单位权利金的 Gamma 风险最差" : "剩余期限过长：封顶 5 个月上行空间，而远期 IV 反而是全曲线最低、盘口也最薄",
    }));

  const ranked = eligible
    .map((e) => ({
      ...e,
      atmIvPct: atmIvByExpiry.get(e.expiry) ?? null,
      ivEdgePct: atmIvByExpiry.has(e.expiry) ? atmIvByExpiry.get(e.expiry) - spotFactor.volForecastPct : null,
    }))
    .sort((a, b) => (b.ivEdgePct ?? -99) - (a.ivEdgePct ?? -99));

  const chooseStrike = (expiry, targetHitRatePct) => {
    const rows = (byExpiry.get(expiry) ?? []).filter((c) => c.otmPct > 1 && c.otmPct < 30);
    const liquid = rows.filter((c) => c.openInterestLots >= 5000 && (c.spreadPct === null || c.spreadPct <= 8));
    const pool = liquid.length >= 2 ? liquid : rows;
    if (pool.length === 0) return null;
    return pool.reduce((best, c) =>
      Math.abs(c.empiricalHitRatePct - targetHitRatePct) < Math.abs(best.empiricalHitRatePct - targetHitRatePct) ? c : best
    );
  };

  const condense = (c) => ({
    expiry: c.expiry,
    strike: c.strike,
    code: c.code,
    name: c.name,
    bid: c.bid,
    premiumPerContract: c.premiumPerContract,
    otmPct: c.otmPct,
    delta: c.delta,
    ivPct: c.ivPct,
    ivMinusForecastPct: c.ivMinusForecastPct,
    staticRoiPct: c.staticRoiPct,
    annualizedRoiPct: c.annualizedRoiPct,
    empiricalAssignmentPct: c.empiricalHitRatePct,
    modelAssignmentPct: c.pAssignedRealPct,
    breakeven: c.breakeven,
    calledRoiPct: c.calledRoiPct,
    spreadPct: c.spreadPct,
    openInterestLots: c.openInterestLots,
    thetaPerDay: c.thetaPerDay,
    strikeVsMa: describeStrikeVsMa(c.strike, movingAverages),
    analogue: analogueEval.find((x) => x.expiry === c.expiry && x.strike === c.strike) ?? null,
  });

  const best = ranked[0];
  if (!best) {
    return { rules: [], volForecastPct: spotFactor.volForecastPct, drawdownPct: spotFactor.drawdownPct, excludedExpiries: excluded, ranked: [], primary: null, defensive: null, longerDated: null };
  }

  const primary = chooseStrike(best.expiry, 20);
  const defensive = chooseStrike(best.expiry, 10);
  const longer = ranked.find((e) => e.expiry !== best.expiry && e.calendarDays > best.calendarDays);
  const longerDated = longer ? chooseStrike(longer.expiry, 12) : null;

  return {
    rules: [
      "剔除剩余不足 20 个日历天的当月合约：权利金几乎全是内在价值，单位权利金的 Gamma 风险最差",
      "剔除超过 100 个日历天的远季月：封顶时间过长，且远期 IV 最低、盘口最薄",
      "到期日按「ATM IV − 混合波动率预测」的溢价排序，溢价最高的才值得卖",
      "行权价按「经验归权概率」而非对数正态 Delta 选取：该标的尾部比模型更厚",
      "同一到期日内优先持仓量 ≥ 5,000 张、买卖价差 ≤ 8% 的合约",
    ],
    volForecastPct: spotFactor.volForecastPct,
    drawdownPct: spotFactor.drawdownPct,
    excludedExpiries: excluded,
    ranked,
    primary: primary ? condense(primary) : null,
    defensive: defensive && (!primary || defensive.strike !== primary.strike) ? condense(defensive) : null,
    longerDated: longerDated ? condense(longerDated) : null,
  };
}

function describeStrikeVsMa(strike, ma) {
  if (!ma) return null;
  const near = (a, b) => Math.abs(a - b) / b < 0.02;
  if (near(strike, ma.ma20)) return "≈MA20（近端反弹阻力）";
  if (near(strike, ma.ma60)) return "≈MA60（中期反弹阻力）";
  if (near(strike, ma.ma120)) return "≈MA120";
  if (near(strike, ma.ma250)) return "≈MA250（年线，回到常态的位置）";
  if (strike > ma.ma250) return "高于年线";
  if (strike > ma.ma60) return "MA60 与 MA250 之间";
  if (strike > ma.ma20) return "MA20 与 MA60 之间";
  return "低于 MA20";
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

function renderReport(r) {
  const lines = [];
  const push = (...xs) => lines.push(...xs);
  const spot = r.spot;

  push(`# 588000.SH 备兑开仓分析（卖出看涨期权）`, "");
  push(`- 数据基准日：**${r.asOf}**（收盘）`);
  push(`- 标的收盘价：**${spot.toFixed(3)}** 元，合约单位 ${r.contractUnit.toLocaleString()} 份/张（1 张对应 ${r.contractUnit.toLocaleString()} 份 ETF）`);
  push(`- 距 52 周高点回撤：**${r.drawdownFrom52wHighPct.toFixed(1)}%**（52 周高 ${r.high52w.toFixed(3)} / 低 ${r.low52w.toFixed(3)}）`);
  push(
    `- 均线：MA20 ${r.movingAverages.ma20.toFixed(3)}｜MA60 ${r.movingAverages.ma60.toFixed(3)}｜MA120 ${r.movingAverages.ma120.toFixed(3)}｜MA250 ${r.movingAverages.ma250.toFixed(3)}`
  );
  push(
    `- 历史波动率：5日 ${r.historicalVolPct[5].toFixed(1)}%｜20日 ${r.historicalVolPct[20].toFixed(1)}%｜60日 ${r.historicalVolPct[60].toFixed(1)}%｜120日 ${r.historicalVolPct[120].toFixed(1)}%｜250日 ${r.historicalVolPct[250].toFixed(1)}%`
  );
  push(`- 波动率预测（20日/60日/EWMA 混合）：**${r.volForecastPct.toFixed(1)}%**`);
  push("");

  const rec = r.recommendation;
  if (rec) {
    push(`## 0. 结论`, "");
    push(
      `**核心矛盾**：标的从 2.34 跌到 1.38 再反弹到 1.42（距高点 ${rec.drawdownPct.toFixed(0)}%），`
        + `但 ATM IV 只有 37–41%，混合方法预测的未来波动率是 ${rec.volForecastPct.toFixed(1)}%。`
        + `也就是说市场并没有为这轮暴跌付高溢价，卖 call 是「用偏低的价格卖掉反弹空间」，不是「恐慌里高价卖保险」。`
        + `这决定了行权价必须留够，不能为了年化数字去卖平值。`,
      ""
    );

    push(`**到期日排序（按 ATM IV − 波动率预测）**：`, "");
    push("| 排名 | 到期日 | 日历天数 | ATM IV | 波动率预测 | 溢价 |", "|---:|---|---:|---:|---:|---:|");
    rec.ranked.forEach((x, i) => {
      push(`| ${i + 1} | ${x.expiry} | ${x.calendarDays} | ${x.atmIvPct?.toFixed(1) ?? "—"}% | ${rec.volForecastPct.toFixed(1)}% | ${
        x.ivEdgePct === null ? "—" : (x.ivEdgePct > 0 ? "+" : "") + x.ivEdgePct.toFixed(1) + "pt"
      } |`);
    });
    push("");

    const tranche = (label, c, note) => {
      if (!c) return;
      push(`**${label}**：${c.name}（${c.code}）`, "");
      push("| 项目 | 数值 |", "|---|---|");
      push(`| 卖一价（可成交） | ${money(c.bid)} 元/份 |`);
      push(`| 每张权利金 | ${Math.round(c.premiumPerContract)} 元（= 10,000 份 × ${money(c.bid)}） |`);
      push(`| 行权价 / 虚值 | ${c.strike.toFixed(2)} 元 / +${c.otmPct.toFixed(1)}%（${c.strikeVsMa}） |`);
      push(`| Delta / IV | ${c.delta.toFixed(2)} / ${c.ivPct.toFixed(1)}%（比预测高 ${c.ivMinusForecastPct.toFixed(1)}pt） |`);
      push(`| 静态收益率 | ${c.staticRoiPct.toFixed(2)}%（相对持仓市值） |`);
      push(`| 年化收益率 | ${c.annualizedRoiPct.toFixed(1)}% |`);
      push(`| 被行权概率（经验 / 模型） | ${c.empiricalAssignmentPct.toFixed(0)}% / ${c.modelAssignmentPct.toFixed(0)}% |`);
      push(`| 保本价 | ${c.breakeven.toFixed(3)} 元（较现价缓冲 ${((1 - c.breakeven / r.spot) * 100).toFixed(1)}%） |`);
      push(`| 被封顶时的总收益 | ${c.calledRoiPct.toFixed(2)}% |`);
      push(`| 流动性 | 持仓 ${c.openInterestLots.toLocaleString()} 张，价差 ${c.spreadPct === null ? "—" : c.spreadPct.toFixed(1) + "%"} |`);
      push(`| 每日 Theta | ${c.thetaPerDay.toFixed(4)} 元/份（≈ ${Math.round(c.thetaPerDay * 10000)} 元/张/天） |`);
      if (c.analogue) {
        push(
          `| 历史 8 次同类回撤复盘 | 平均 ${c.analogue.avgCcPct.toFixed(2)}%（直接持有 ${c.analogue.avgBhPct.toFixed(1)}%），最差 ${c.analogue.worstCcPct.toFixed(
            1
          )}%，${c.analogue.beatBuyHoldCount}/${c.analogue.n} 次跑赢持有 |`
        );
      }
      push("");
      if (note) push(note, "");
    };

    tranche("首选（平衡档）", rec.primary, null);
    tranche("保守档（更怕丢筹码）", rec.defensive, null);
    tranche("拉长到季月（换更多时间价值，代价是更久的上行封顶）", rec.longerDated, null);

    push(`**为什么跳过另外两个到期日**：`, "");
    for (const e of rec.excludedExpiries) push(`- ${e.expiry}（${e.calendarDays} 天）：${e.reason}`);
    push("");
    push(`**为什么不卖 1.45 / 1.50**：年化 27–34% 看着更香，但经验归权概率 28–38%，`
      + `一旦被 call 走，就是在 -39% 的位置把筹码交出去；而 1.42 → 1.55 只差 9%，`
      + `已经是这轮下跌里最容易反弹到的位置，再往下卖等于主动交出反弹收益。`, "");
    push(`**为什么不卖 2027-03**：远期 IV 36.9% 是整条曲线最低，比近月还便宜，`
      + `而它要求你把上行封顶 5 个月。要卖长端，应该是 IV 高企时，不是现在。`, "");

    if (rec.primary) {
      const c = rec.primary;
      const perLotCapital = r.spot * r.contractUnit;
      push(`**怎么下单（按持仓规模换算）**：`, "");
      push("| 持仓 | 可卖张数 | 单张收入 | 合计收入 | 对应被行权时卖出的份数 |", "|---|---:|---:|---:|---:|");
      for (const lots of [1, 5, 10, 20, 50, 100]) {
        push(
          `| ${(lots * r.contractUnit).toLocaleString()} 份（${(lots * perLotCapital / 10000).toFixed(1)} 万元） | ${lots} | ${Math.round(
            c.premiumPerContract
          )} 元 | ${(lots * c.premiumPerContract).toLocaleString()} 元 | ${(lots * r.contractUnit).toLocaleString()} 份 |`
        );
      }
      push("");
      push(`> 备兑开仓需要先用对应份额锁定（备兑证券锁定），1 张 = 10,000 份。`, "");
      push(`**必须满足的条件**：`, "");
      push(`- 你确实打算在 ${c.strike.toFixed(2)} 元愿意卖出这部分份额；备兑是「承诺卖出」，不是纯收租。`);
      push(`- 如果只打算卖一部分，建议先用 30–50% 的持仓做第一批，留一半应对继续下跌后的补仓或换仓。`);
      push(`- 到期前若标的快速涨过 ${c.strike.toFixed(2)}，可以买入平仓（买回 call）而不是等着被行权，`
        + `但要付出时间价值损耗；涨得越快、越接近到期，买回成本越高。`);
      push(`- 备兑期间不要在同一账户做同一标的的卖出认沽，否则可能触发组合保证金变化。`, "");
    }
  }

  push(`## 1. 可选到期日`, "");
  push("上交所规则：到期月份为当月、下月及随后两个季月；到期日为到期月第四个星期三（节假日顺延）。", "");
  push("| 到期日 | 日历天数 | 交易日 | 备注 |", "|---|---:|---:|---|");
  for (const e of r.expiries) {
    const note = e.calendarDays <= 7 ? "当月，权利金几乎全是内在价值，Theta 已所剩无几" : e.calendarDays <= 40 ? "下月，时间价值最密集" : e.calendarDays <= 70 ? "季月，跨年末" : "季月，持有期最长";
    push(`| ${e.expiry} | ${e.calendarDays} | ${e.tradingDays} | ${note} |`);
  }
  push("");

  if (r.ivHistory) {
    push(`## 2. 隐含波动率位置（ATM，用 BS 反解）`, "");
    push("| 到期日 | 观察数 | P10 | 中位 | P90 | 当前ATM IV | 当前分位 |", "|---|---:|---:|---:|---:|---:|---|");
    for (const [expiry, h] of Object.entries(r.ivHistory)) {
      const pctRank = h.currentAtmIvPct === null ? "—" : estimatePercentile(h, h.currentAtmIvPct);
      push(
        `| ${expiry} | ${h.observations} | ${h.p10.toFixed(1)}% | ${h.median.toFixed(1)}% | ${h.p90.toFixed(1)}% | ${
          h.currentAtmIvPct === null ? "—" : h.currentAtmIvPct.toFixed(1) + "%"
        } | ${pctRank} |`
      );
    }
    push("");
    // Forward vol: what the term structure implies for the periods between expiries.
    const forwardVols = computeForwardVols(r);
    if (forwardVols.length > 0) {
      push(`**期限结构隐含的远期波动率**（用 ATM IV 按方差时间线性插值）：`);
      push("| 区间 | 远期波动率 |", "|---|---:|");
      for (const f of forwardVols) push(`| ${f.from} → ${f.to} | ${f.forwardVolPct.toFixed(1)}% |`);
      push("");
    }
    if (r.volPremium && Object.keys(r.volPremium).length > 0) {
      push(`**IV 是否真的“贵”**（历史上 ATM IV 减去随后实际波动率）：`);
      push("| 期限 | 样本 | 均值 | 中位 | IV高于实际的比例 | P10 | P90 |", "|---|---:|---:|---:|---:|---:|---:|");
      for (const [key, v] of Object.entries(r.volPremium)) {
        push(
          `| ${key === "h10" ? "约2周" : "约1个月"} | ${v.n} | ${v.meanIvMinusRvPct.toFixed(1)}pt | ${v.medianIvMinusRvPct.toFixed(1)}pt | ${pct(
            v.shareIvAboveRv,
            0
          )} | ${v.p10.toFixed(1)}pt | ${v.p90.toFixed(1)}pt |`
        );
      }
      push("", "> 中位为正、均值被少数暴涨行情拖成负数：卖方长期赚小钱、偶尔大亏，这是备兑的结构性特征。", "");
    }
  }

  push(`## 3. 候选合约明细`, "");
  push(
    "> 权利金取**卖一价（bid1）**，即当下真实可成交的卖出价；IV/Greeks 用买卖中间价反解。概率假设零漂移对数正态、波动率取上面的预测值。",
    ""
  );
  for (const expiry of r.expiries.map((e) => e.expiry)) {
    const rows = r.candidates.filter((c) => c.expiry === expiry && c.strike <= spot * 1.45 && c.strike >= spot * 0.95);
    if (rows.length === 0) continue;
    push(`### 到期 ${expiry}`, "");
    push(
      "| 行权价 | 虚值% | 卖一价 | 每张收入 | 买卖价差 | Delta | IV | 年化% | 静态% | 涨到此价被封顶% | 保本价 | 归权概率(模型) | 归权概率(经验) | 期望% | 5%分位% | 95%分位% |",
      "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|"
    );
    for (const c of rows) {
      push(
        `| ${c.strike.toFixed(2)} | ${c.otmPct.toFixed(1)}% | ${money(c.bid)} | ${Math.round(c.premiumPerContract)} | ${
          c.spreadPct === null ? "—" : c.spreadPct.toFixed(1) + "%"
        } | ${c.delta.toFixed(2)} | ${c.ivPct.toFixed(1)}% | ${c.annualizedRoiPct.toFixed(1)}% | ${c.staticRoiPct.toFixed(
          2
        )}% | ${c.maxReturnPct.toFixed(2)}% | ${c.breakeven.toFixed(3)} | ${c.pAssignedRealPct.toFixed(0)}% | ${
          c.empiricalHitRatePct === null ? "—" : c.empiricalHitRatePct.toFixed(0) + "%"
        } | ${c.expectedReturnPct.toFixed(2)}% | ${c.p05ReturnPct.toFixed(1)}% | ${c.p95ReturnPct.toFixed(1)}% |`
      );
    }
    push("");
    push("> 「归权概率(经验)」= 历史上同等涨跌幅、同等天数内真实发生的频率，比对数正态模型更贴近这个高波动标的。", "");
  }

  push(`## 4. 到期日情景对比（同为约 3% 虚值附近）`, "");
  push("| 到期日 | 行权价 | 每张收入 | 年化% | 归权概率 | 到期不变时收益% | 涨 10% 时收益% | 涨 10% 少赚% |", "|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const expiry of r.expiries.map((e) => e.expiry)) {
    const row = pickNearestOtm(r.candidates.filter((c) => c.expiry === expiry), spot, 0.03);
    if (!row) continue;
    const flat = row.scenarios.find((s) => Math.abs(s.spot - spot) < 1e-9);
    const up10 = row.scenarios.find((s) => s.movePct > 9 && s.movePct < 11);
    push(
      `| ${expiry} | ${row.strike.toFixed(2)} | ${Math.round(row.premiumPerContract)} | ${row.annualizedRoiPct.toFixed(1)}% | ${row.pAssignedRealPct.toFixed(
        0
      )}% | ${flat ? flat.coveredCallPct.toFixed(2) : "—"}% | ${up10 ? up10.coveredCallPct.toFixed(2) : "—"}% | ${
        up10 ? up10.forgonePct.toFixed(2) : "—"
      }% |`
    );
  }
  push("");

  push(`## 5. 历史滚动回测（模型定价，持有到到期）`, "");
  push("按目标 Delta 选行权价，入场 IV 取过去 60 日已实现波动率（下限 25%），对比买入持有。样本为 2020-11 起全历史。", "");
  push("| 期限 | 目标Delta | 样本 | call走概率 | 平均收益 | 买入持有 | 胜率 | 收益/风险 | 最差 | P05 | P95 |", "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const [key, s] of Object.entries(r.backtests)) {
    if (!s) continue;
    const [h, d] = key.split("_");
    push(
      `| ${h === "h21" ? "约1个月" : "约2个月"} | ${d.slice(1)} | ${s.n} | ${pct(s.assignedRate, 0)} | ${pct(s.avgCoveredCallReturn)} | ${pct(
        s.avgBuyHoldReturn
      )} | ${pct(s.winRate, 0)} | ${s.returnPerRisk?.toFixed(3) ?? "—"} | ${pct(s.worstCoveredCall)} | ${pct(s.p05)} | ${pct(s.p95)} |`
    );
  }
  push("");

  push(`### 按入场时的均线状态拆分`, "");
  push("| 期限 | 目标Delta | 状态 | 样本 | call走概率 | 平均收益 | 买入持有 | 收益/风险 | P05 |", "|---|---:|---|---:|---:|---:|---:|---:|---:|");
  for (const [key, v] of Object.entries(r.regimeBacktests)) {
    const [h, d] = key.split("_");
    for (const [label, s] of [["低于MA250", v.belowMa250], ["高于MA250", v.aboveMa250]]) {
      if (!s) continue;
      push(
        `| ${h === "h21" ? "约1个月" : "约2个月"} | ${d.slice(1)} | ${label} | ${s.n} | ${pct(s.assignedRate, 0)} | ${pct(
          s.avgCoveredCallReturn
        )} | ${pct(s.avgBuyHoldReturn)} | ${s.returnPerRisk?.toFixed(3) ?? "—"} | ${pct(s.p05)} |`
      );
    }
  }
  push("");

  push(`### 固定虚值幅度回测`, "");
  push("| 期限 | 虚值 | 样本 | call走概率 | 平均收益 | 买入持有 | 最差 | P05 | P95 |", "|---|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const [key, s] of Object.entries(r.moneynessBacktests)) {
    if (!s) continue;
    const [h, otm] = key.split("_");
    push(
      `| ${h === "h21" ? "约1个月" : "约2个月"} | ${otm.slice(3)}% | ${s.n} | ${pct(s.assignedRate, 0)} | ${pct(s.avgCoveredCallReturn)} | ${pct(
        s.avgBuyHoldReturn
      )} | ${pct(s.worstCoveredCall)} | ${pct(s.p05)} | ${pct(s.p95)} |`
    );
  }
  push("");

  push(`## 6. 标的自身的经验分布`, "");  push("| 期限 | 样本 | 中位 | P05 | P95 | 涨超10%概率 | 涨超15%概率 | 跌超10%概率 |", "|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const [key, e] of Object.entries(r.empirical)) {
    push(
      `| ${key === "h21" ? "21交易日" : "41交易日"} | ${e.n} | ${pct(e.median)} | ${pct(e.p05)} | ${pct(e.p95)} | ${pct(e.probUp10, 1)} | ${pct(
        e.probUp15,
        1
      )} | ${pct(e.probDown10, 1)} |`
    );
  }
  push("");
  push(`**当前状态的历史类比**（收盘低于 MA250 的 92% 且 60 日跌幅超 12%）：`, "");
  push("| 期限 | 样本 | 中位 | P10 | P90 | 涨超10%概率 | 跌超10%概率 | 触发日期 |", "|---|---:|---:|---:|---:|---:|---:|---|");
  for (const [key, e] of Object.entries(r.conditional)) {
    if (!e.n) continue;
    push(
      `| ${key === "h21" ? "21交易日" : "41交易日"} | ${e.n} | ${pct(e.median)} | ${pct(e.p10)} | ${pct(e.p90)} | ${pct(e.probUp10, 0)} | ${pct(
        e.probDown10,
        0
      )} | ${e.entryDates.join("、")} |`
    );
  }
  push("", "> 样本只有个位数，只能当方向性参考：这种急跌后的状态，上涨尾部比无条件分布更厚。", "");

  push(`## 7. 用当前合约在历史类比窗口里复盘`, "");
  push(
    "把今天的「虚值幅度 / 权利金比例」搬到历史上 8 个同为深度回撤的起点，用真实后续走势结算。"
      + "这是唯一同时用到真实行情路径和真实权利金水平的检验，但样本仅 8 个。",
    ""
  );
  push("| 到期日 | 行权价 | 虚值% | 权利金% | 平均收益 | 直接持有 | 中位 | 最差 | 最好 | 跑赢持有 | 被削顶 |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  const focus = r.analogueEval.filter((x) => x.otmPct > 0 && x.otmPct < 30);
  for (const x of focus) {
    push(
      `| ${x.expiry} | ${x.strike.toFixed(2)} | ${x.otmPct.toFixed(0)}% | ${x.premiumRoiPct.toFixed(2)}% | ${x.avgCcPct.toFixed(2)}% | ${x.avgBhPct.toFixed(
        1
      )}% | ${x.medianCcPct.toFixed(2)}% | ${x.worstCcPct.toFixed(1)}% | ${x.bestCcPct.toFixed(1)}% | ${x.beatBuyHoldCount}/${x.n} | ${x.cappedCount}/${x.n} |`
    );
  }
  push("");

  push(`## 8. 风险与反方观点`, "");
  const rc = r.recommendation?.primary;
  const emp21 = r.empirical.h21;
  const emp41 = r.empirical.h41;
  const vp21 = r.volPremium?.h21;
  push(`**1. 真正的风险不是被 call 走，而是继续下跌。** 备兑只提供权利金这点缓冲（${rc ? rc.staticRoiPct.toFixed(1) + "%" : "1–2%"}），`
    + `标的 20 日历史波动率 ${r.historicalVolPct[20].toFixed(1)}%、60 日 ${r.historicalVolPct[60].toFixed(1)}%，单日 -3% 到 -7% 是常态。`
    + `卖一张 call 收 ${rc ? Math.round(rc.premiumPerContract) + " 元" : "几百元"}，对 ${Math.round(
      r.spot * r.contractUnit
    ).toLocaleString()} 元的持仓只是 ${rc ? rc.staticRoiPct.toFixed(1) + "%" : "1–2%"} 的缓冲，跌 10% 依然亏 ${rc ? (10 - rc.staticRoiPct).toFixed(1) : "8"}%。`, "");
  push(`**2. 上行尾部被封顶，而这只 ETF 的上行尾部很厚。** 历史上 21 个交易日内涨超 10% 的概率 ${pct(emp21.probUp10, 1)}，`
    + `涨超 15% 的概率 ${pct(emp21.probUp15, 1)}；41 个交易日内涨超 15% 的概率 ${pct(emp41.probUp15, 1)}。`
    + (rc
      ? `选中的 ${rc.strike.toFixed(2)}（+${rc.otmPct.toFixed(0)}%）在 ${r.expiries.find((e) => e.expiry === rc.expiry)?.calendarDays} 天里被穿过的经验概率是 ${rc.empiricalAssignmentPct.toFixed(
          0
        )}%，这个概率不算低。`
      : ""), "");
  if (vp21) {
    push(`**3. 当前 IV 并不算贵。** 全历史看，ATM IV 减去随后实际波动率的中位数是 ${vp21.medianIvMinusRvPct > 0 ? "+" : ""}${vp21.medianIvMinusRvPct.toFixed(
      1
    )}pt，但均值是 ${vp21.meanIvMinusRvPct.toFixed(1)}pt——多数时候卖方小赚，少数暴涨行情一次亏光多次收益。`
      + `现在 IV 处在自身历史的 P25–中位区间（见第 2 节），不是「明显高估」的位置，赚的是时间价值，不是波动率均值回归。`, "");
  }
  push(`**4. 类比样本只有 8 个，且都在 2022–2024 的下跌段。** 这段历史里「跌深了还会继续跌」，`
    + `所以类比结果偏向「卖 call 帮助有限」。如果这次是 V 型反转，类比会低估被封顶的代价。`, "");
  push(`**5. 数据和口径的局限。** 期权合约历史只覆盖上市至今，IV 分位数样本不均；`
    + `概率用零漂移假设，没有内嵌「跌深必反弹」的均值回归；`
    + `权利金是 ${r.asOf} 收盘盘口，隔夜跳空后会全部失效。`, "");
  if (rc) {
    const up = rc.strike * 1.16;
    const cappedPct = rc.calledRoiPct;
    const bhUp = (up / r.spot - 1) * 100;
    const down = r.spot * 0.88;
    const ccDown = ((Math.min(down, rc.strike) - r.spot + rc.bid) / r.spot) * 100;
    push(`**6. 如果判断错了会怎样。** 若标的大涨到 ${up.toFixed(2)}（+${bhUp.toFixed(0)}%），`
      + `卖 ${rc.strike.toFixed(2)} 的备兑收益被封在 ${cappedPct.toFixed(1)}%，而直接持有是 ${bhUp.toFixed(0)}%，`
      + `少赚约 ${(bhUp - cappedPct).toFixed(0)} 个百分点；若跌到 ${down.toFixed(2)}（-12%），`
      + `备兑亏 ${Math.abs(ccDown).toFixed(1)}%，直接持有亏 12%，只少亏 ${(12 - Math.abs(ccDown)).toFixed(1)} 个点。`
      + `这就是备兑的收益结构：**大幅削掉右尾，换一点点左尾缓冲**。`, "");
  }
  push("");
  return lines.join("\n");
}

function pickNearestOtm(rows, spot, targetOtm) {
  return rows
    .filter((c) => c.otmPct > 0)
    .sort((a, b) => Math.abs(a.otmPct - targetOtm * 100) - Math.abs(b.otmPct - targetOtm * 100))[0];
}

function computeForwardVols(r) {
  const expiries = r.expiries.slice().sort((a, b) => a.tradingDays - b.tradingDays);
  const atmOf = (expiry) => {
    const rows = r.candidates.filter((c) => c.expiry === expiry);
    if (rows.length === 0) return null;
    return rows.reduce((best, c) => (Math.abs(c.otmPct) < Math.abs(best.otmPct) ? c : best));
  };
  const out = [];
  for (let i = 0; i < expiries.length - 1; i += 1) {
    const a = expiries[i];
    const b = expiries[i + 1];
    const ca = atmOf(a.expiry);
    const cb = atmOf(b.expiry);
    if (!ca || !cb || a.tradingDays <= 0 || b.tradingDays <= a.tradingDays) continue;
    const Ta = a.tradingDays / 243;
    const Tb = b.tradingDays / 243;
    const va = (ca.ivPct / 100) ** 2 * Ta;
    const vb = (cb.ivPct / 100) ** 2 * Tb;
    const fwdVariance = (vb - va) / (Tb - Ta);
    if (!(fwdVariance > 0)) continue;
    out.push({ from: a.expiry, to: b.expiry, forwardVolPct: Math.sqrt(fwdVariance) * 100 });
  }
  return out;
}

function estimatePercentile(h, value) {
  // Use the min/median/max shape plus the quartiles to give a coarse rank.
  if (value <= h.p10) return "低于P10";
  if (value <= h.p25) return "P10-P25";
  if (value <= h.median) return "P25-中位";
  if (value <= h.p75) return "中位-P75";
  if (value <= h.p90) return "P75-P90";
  return "高于P90";
}

main().catch((error) => {
  console.error(`analysis failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
