/**
 * Black-Scholes pricing helpers for exchange-traded ETF options research.
 *
 * Scope: research/analysis only. Used by scripts/option-covered-call-analysis.mjs.
 * Conventions: T in years, sigma as decimal (0.35 = 35%), r as decimal.
 */

export function normPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/** Standard normal CDF (Abramowitz & Stegun 26.2.17, |err| < 7.5e-8). */
export function normCdf(x) {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}

export function bsD1D2(S, K, T, r, sigma) {
  const st = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / st;
  return { d1, d2: d1 - st };
}

export function bsPrice(S, K, T, r, sigma, type = "call") {
  if (T <= 0) return Math.max(0, type === "call" ? S - K : K - S);
  const { d1, d2 } = bsD1D2(S, K, T, r, sigma);
  const df = Math.exp(-r * T);
  if (type === "call") return S * normCdf(d1) - K * df * normCdf(d2);
  return K * df * normCdf(-d2) - S * normCdf(-d1);
}

export function bsGreeks(S, K, T, r, sigma, type = "call") {
  const { d1, d2 } = bsD1D2(S, K, T, r, sigma);
  const sqrtT = Math.sqrt(T);
  const df = Math.exp(-r * T);
  const gamma = normPdf(d1) / (S * sigma * sqrtT);
  const vega = (S * normPdf(d1) * sqrtT) / 100; // per 1 vol point
  if (type === "call") {
    return {
      delta: normCdf(d1),
      gamma,
      vega,
      theta: (-(S * normPdf(d1) * sigma) / (2 * sqrtT) - r * K * df * normCdf(d2)) / 365,
    };
  }
  return {
    delta: normCdf(d1) - 1,
    gamma,
    vega,
    theta: (-(S * normPdf(d1) * sigma) / (2 * sqrtT) + r * K * df * normCdf(-d2)) / 365,
  };
}

/** Bisection implied vol; returns null when the price is outside no-arbitrage bounds. */
export function impliedVol(price, S, K, T, r, type = "call") {
  if (!(T > 0) || !(price > 0)) return null;
  const intrinsic = Math.max(0, type === "call" ? S - K * Math.exp(-r * T) : K * Math.exp(-r * T) - S);
  if (price <= intrinsic + 1e-9) return null;
  let lo = 0.01;
  let hi = 4;
  if (bsPrice(S, K, T, r, hi, type) < price) return null;
  for (let i = 0; i < 120; i += 1) {
    const mid = (lo + hi) / 2;
    if (bsPrice(S, K, T, r, mid, type) < price) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Realized volatility in percent from a close series (log returns, annualized by trading days). */
export function realizedVol(closes, window, tradingDays = 243) {
  const slice = closes.slice(-(window + 1));
  const rets = [];
  for (let i = 1; i < slice.length; i += 1) rets.push(Math.log(slice[i] / slice[i - 1]));
  if (rets.length < 2) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance * tradingDays) * 100;
}

/** Overlapping-window log returns of horizon `days` trading days. */
export function forwardReturns(closes, days) {
  const out = [];
  for (let i = 0; i + days < closes.length; i += 1) {
    out.push({ index: i, logReturn: Math.log(closes[i + days] / closes[i]) });
  }
  return out;
}

/** Non-overlapping windows, to reduce autocorrelation bias in hit-rate statistics. */
export function nonOverlappingForwardReturns(closes, days) {
  const out = [];
  for (let i = 0; i + days < closes.length; i += days) {
    out.push({ index: i, logReturn: Math.log(closes[i + days] / closes[i]) });
  }
  return out;
}

export function quantile(sortedValues, q) {
  if (sortedValues.length === 0) return null;
  const pos = (sortedValues.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (base + 1 < sortedValues.length) {
    return sortedValues[base] + rest * (sortedValues[base + 1] - sortedValues[base]);
  }
  return sortedValues[base];
}
