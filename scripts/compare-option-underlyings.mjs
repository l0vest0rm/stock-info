#!/usr/bin/env node
/**
 * Compare every A-share listed ETF option underlying on the axes that matter for
 * choosing where to trade options: realized volatility, chain liquidity, IV level,
 * skew shape, and downside tail behavior.
 *
 * Data sources (Eastmoney first, per repo policy):
 *   - Underlying daily K-line : local GET /api/kline (Xueqiu) — Eastmoney is not used
 *     for K-lines in this repo (AGENTS.md market-data boundary)
 *   - Option chain / quotes   : push2.eastmoney.com  (slist/get, stock/get)
 *   - Expiry dates            : derived from the Eastmoney contract name + the SSE/SZSE
 *                               rule "4th Wednesday of the expiry month", then validated
 *                               against vendor day counts (f162)
 *
 * Usage:
 *   node scripts/compare-option-underlyings.mjs
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { impliedVol, realizedVol, quantile } from "./lib/option-pricing.mjs";
import { expiryFromContractName, tradingDaysBetween } from "./lib/market-calendar.mjs";

const UT = "fa5fd1943c7b386f172d6893dbfba10b";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const RISK_FREE_RATE = 0.015;
const TRADING_DAYS = 243;

/** The 9 SSE/SZSE ETF option underlyings currently listed (2026-10). */
const UNDERLYINGS = [
  { code: "510050.SH", name: "上证50ETF", exchange: "SSE", secid: "1.510050", group: "大盘蓝筹" },
  { code: "510300.SH", name: "沪深300ETF(华泰柏瑞)", exchange: "SSE", secid: "1.510300", group: "大盘宽基" },
  { code: "510500.SH", name: "中证500ETF(南方)", exchange: "SSE", secid: "1.510500", group: "中盘" },
  { code: "588000.SH", name: "科创50ETF(华夏)", exchange: "SSE", secid: "1.588000", group: "科创成长" },
  { code: "588080.SH", name: "科创50ETF(易方达)", exchange: "SSE", secid: "1.588080", group: "科创成长" },
  { code: "159919.SZ", name: "沪深300ETF(嘉实)", exchange: "SZSE", secid: "0.159919", group: "大盘宽基" },
  { code: "159922.SZ", name: "中证500ETF(嘉实)", exchange: "SZSE", secid: "0.159922", group: "中盘" },
  { code: "159915.SZ", name: "创业板ETF", exchange: "SZSE", secid: "0.159915", group: "创业板成长" },
  { code: "159901.SZ", name: "深证100ETF", exchange: "SZSE", secid: "0.159901", group: "深市大盘" },
];

// Expiry derivation and trading-day counting live in scripts/lib/market-calendar.mjs
// so the holiday table and the "4th Wednesday" rule exist in exactly one place.

async function fetchKline(code) {
  const url = new URL("/api/kline", "http://127.0.0.1:8000");
  url.searchParams.set("code", code);
  url.searchParams.set("period", "day");
  url.searchParams.set("fq", "qfq");
  url.searchParams.set("from", "2015-01-01");
  url.searchParams.set("format", "structured");
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`kline HTTP ${response.status} for ${code}`);
  const body = await response.json();
  if (body?.code !== 200 || !Array.isArray(body.data)) throw new Error(`invalid kline for ${code}: ${body?.msg}`);
  return body.data;
}

async function fetchChain(secid) {
  const url =
    `https://push2.eastmoney.com/api/qt/slist/get?spt=8&fltt=2&invt=2&ut=${UT}&secid=${secid}` +
    `&fields=f12,f14,f2,f3,f108,f161,f162,f210&pn=1&pz=500`;
  const response = await fetch(url, { headers: { "User-Agent": UA, Referer: "https://quote.eastmoney.com/" }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`chain HTTP ${response.status}`);
  const body = await response.json();
  if (body?.rc !== 0) throw new Error(`chain rc=${body?.rc}`);
  const rows = Object.values(body?.data?.diff ?? {});
  const isCall = (r) => String(r.f14 ?? "").includes("购") && !String(r.f14 ?? "").includes("沽");
  const isPut = (r) => String(r.f14 ?? "").includes("沽") && !String(r.f14 ?? "").includes("购");
  const marketId = Number(rows[0]?.f13 ?? 10);
  return { calls: rows.filter(isCall), puts: rows.filter(isPut), total: body?.data?.total ?? rows.length, marketId };
}

/**
 * Eastmoney per-contract snapshot.
 *
 * The market prefix is NOT constant across exchanges: SSE ETF options live under
 * market 10, while SZSE ETF options live under market 12 (slist exposes this as
 * f13). Hardcoding 10 silently returns rc=100 with no data for every SZSE contract.
 */
async function fetchContractDetail(code, marketId) {
  const fields = "f43,f60,f71,f130,f131,f170,f171,f172,f191";
  const url = `https://push2.eastmoney.com/api/qt/stock/get?ut=${UT}&fltt=2&invt=2&secid=${marketId}.${code}&fields=${fields}`;
  try {
    const response = await fetch(url, { headers: { "User-Agent": UA, Referer: "https://quote.eastmoney.com/" }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) return null;
    const body = await response.json();
    if (body?.rc !== 0 || !body?.data) return null;
    const d = body.data;
    const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    return { last: num(d.f43), bid1: num(d.f131), amplitudePct: num(d.f171) };
  } catch {
    return null;
  }
}

/**
 * Sina supplement. Eastmoney's option endpoints expose bid1 (f131) but NOT ask1, and
 * a seller/buyer spread cannot be measured from one side. Sina is used here only for
 * that missing ask price. Everything else (chain, strikes, OI, volume, last, IV) is Eastmoney.
 */
async function fetchSinaSpreads(codes) {
  const out = new Map();
  for (let i = 0; i < codes.length; i += 40) {
    const batch = codes.slice(i, i + 40);
    const url = `https://hq.sinajs.cn/list=${batch.map((c) => `CON_OP_${c}`).join(",")}`;
    try {
      const response = await fetch(url, { headers: { "User-Agent": UA, Referer: "https://finance.sina.com.cn" }, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) continue;
      const text = new TextDecoder("gbk").decode(new Uint8Array(await response.arrayBuffer()));
      for (const line of text.split("\n")) {
        const m = /hq_str_CON_OP_(\d+)="([^"]*)"/.exec(line);
        if (!m || !m[2]) continue;
        const p = m[2].split(",");
        const bid = Number(p[22]);
        const ask = Number(p[12]);
        if (bid > 0 && ask > 0) {
          const mid = (bid + ask) / 2;
          out.set(m[1], { bid, ask, spreadPct: mid > 0 ? ((ask - bid) / mid) * 100 : null });
        }
      }
    } catch {
      // optional supplement; ignore failures
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return out;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** EWMA + 20d + 60d blend, used as the "expected future vol" yardstick. */
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

function atmIv(calls, spot, T) {
  const points = [];
  for (const c of calls) {
    const price = Number(c.f2);
    const strike = Number(c.f161);
    if (!(price > 0) || !(strike > 0)) continue;
    const iv = impliedVol(price, spot, strike, T, RISK_FREE_RATE, "call");
    if (iv && iv > 0.02 && iv < 3) points.push({ strike, ivPct: iv * 100 });
  }
  if (points.length < 3) return null;
  points.sort((a, b) => a.strike - b.strike);
  let lo = null, hi = null;
  for (const p of points) { if (p.strike <= spot) lo = p; if (p.strike >= spot && !hi) hi = p; }
  if (lo && hi && lo.strike !== hi.strike) {
    const w = (spot - lo.strike) / (hi.strike - lo.strike);
    return { atm: lo.ivPct * (1 - w) + hi.ivPct * w, points, used: points.length };
  }
  return lo || hi ? { atm: (lo ?? hi).ivPct, points, used: points.length } : null;
}

function tailStats(closes) {
  let peak = closes[0], mdd = 0;
  for (const c of closes) { peak = Math.max(peak, c); mdd = Math.min(mdd, c / peak - 1); }
  let worstDay = 0, bestDay = 0;
  for (let i = 1; i < closes.length; i += 1) {
    const r = closes[i] / closes[i - 1] - 1;
    worstDay = Math.min(worstDay, r);
    bestDay = Math.max(bestDay, r);
  }
  return { maxDrawdownPct: mdd * 100, worstDayPct: worstDay * 100, bestDayPct: bestDay * 100 };
}

function forwardStats(closes, horizon) {
  const rets = [];
  for (let i = 0; i + horizon < closes.length; i += 1) rets.push(closes[i + horizon] / closes[i] - 1);
  rets.sort((a, b) => a - b);
  return {
    n: rets.length,
    median: quantile(rets, 0.5),
    p05: quantile(rets, 0.05),
    p95: quantile(rets, 0.95),
    probUp10: rets.filter((r) => r > 0.1).length / rets.length,
    probUp15: rets.filter((r) => r > 0.15).length / rets.length,
    probDown15: rets.filter((r) => r < -0.15).length / rets.length,
  };
}

async function main() {
  const outDir = path.resolve("data/research/option-underlying-selection");
  await mkdir(outDir, { recursive: true });

  const rows = [];
  for (const u of UNDERLYINGS) {
    process.stderr.write(`fetching ${u.code} ${u.name}... `);
    const [kline, chain] = await Promise.all([fetchKline(u.code), fetchChain(u.secid)]);
    const closes = kline.map((r) => r.close);
    const dates = kline.map((r) => r.date);
    const spot = closes.at(-1);
    const asOf = dates.at(-1);
    // Option market id from the chain itself (SSE=10, SZSE=12) instead of assuming.
    const marketId = Number(chain.marketId ?? 10);

    // Group calls by derived expiry.
    const byExpiry = new Map();
    for (const c of chain.calls) {
      const expiry = expiryFromContractName(c.f14, asOf, Number(c.f162));
      if (!expiry) continue;
      if (!byExpiry.has(expiry)) byExpiry.set(expiry, []);
      byExpiry.get(expiry).push(c);
    }
    const expiryList = [...byExpiry.keys()].sort();
    const asOfMs = Date.parse(`${asOf}T00:00:00Z`);
    // Nearest expiry at least 15 calendar days out: the front week is gamma-dominated
    // and not representative of the IV level a position would actually face.
    const targetExpiry = expiryList.find((e) => (Date.parse(`${e}T00:00:00Z`) - asOfMs) / 86_400_000 >= 15) ?? expiryList[0] ?? null;
    const nearCalls = targetExpiry ? byExpiry.get(targetExpiry) : chain.calls;
    const td = targetExpiry ? tradingDaysBetween(asOf, targetExpiry) : 0;
    const atm = targetExpiry && td > 0 ? atmIv(nearCalls, spot, td / TRADING_DAYS) : null;

    const vol60 = realizedVol(closes, 60);
    const forecast = blendedVol(closes);
    const tails = tailStats(closes);
    const fwd21 = forwardStats(closes, 21);
    const fwd63 = forwardStats(closes, 63);

    const nearOi = nearCalls.reduce((a, c) => a + (Number(c.f210) || 0), 0);
    const nearVol = nearCalls.reduce((a, c) => a + (Number(c.f108) || 0), 0);
    const strikes = nearCalls.map((c) => Number(c.f161)).filter((v) => v > 0);
    const usableStrikes = strikes.filter((k) => k >= spot * 0.9 && k <= spot * 1.1).length;

    // Per-contract detail (Eastmoney only): bid presence and intraday amplitude are the
    // liquidity proxies available without pulling a second vendor.
    // Eastmoney throttles this endpoint hard, so keep concurrency low and space calls out.
    const detailCodes = nearCalls.filter((c) => Number(c.f2) > 0).map((c) => String(c.f12));
    const details = [];
    for (let i = 0; i < detailCodes.length; i += 1) {
      details.push(await fetchContractDetail(detailCodes[i], marketId));
      if (i % 5 === 4) await new Promise((r) => setTimeout(r, 350));
    }
    const withBid = details.filter((d) => d && d.bid1 !== null && d.bid1 > 0).length;
    const amplitudes = details.map((d) => d?.amplitudePct).filter((v) => typeof v === "number" && v > 0).sort((a, b) => a - b);
    const medianAmplitude = quantile(amplitudes, 0.5);

    // Spread needs both sides; Eastmoney only publishes bid, so ask comes from Sina.
    let sinaSpreads = new Map();
    try { sinaSpreads = await fetchSinaSpreads(detailCodes); } catch { sinaSpreads = new Map(); }
    const spreads = [...sinaSpreads.values()].map((v) => v.spreadPct).filter((v) => typeof v === "number" && v > 0).sort((a, b) => a - b);
    const medianSpread = quantile(spreads, 0.5);

    let otmCallIv = null;
    if (atm?.points?.length) {
      const target = spot * 1.1;
      const nearest = atm.points.reduce((b, p) => Math.abs(p.strike - target) < Math.abs(b.strike - target) ? p : b);
      otmCallIv = nearest.ivPct;
    }

    rows.push({
      ...u,
      asOf,
      spot,
      historyDays: closes.length,
      historyStart: dates[0],
      hv20: realizedVol(closes, 20),
      hv60: vol60,
      hv250: realizedVol(closes, 250),
      volForecast: forecast,
      atmIvPct: atm?.atm ?? null,
      ivMinusForecastPct: atm && forecast !== null ? atm.atm - forecast : null,
      ivPoints: atm?.used ?? 0,
      otm10CallIvPct: otmCallIv,
      callSkewPct: otmCallIv !== null && atm ? otmCallIv - atm.atm : null,
      nearExpiry: targetExpiry,
      nearExpiryTradingDays: td,
      expiryCount: expiryList.length,
      contracts: chain.total,
      strikesNear: strikes.length,
      usableStrikes,
      nearOpenInterest: nearOi,
      nearVolume: nearVol,
      bidCoveragePct: detailCodes.length ? (withBid / detailCodes.length) * 100 : null,
      medianAmplitudePct: medianAmplitude,
      medianSpreadPct: medianSpread,
      spreadSamples: spreads.length,
      ...tails,
      probUp10_21d: fwd21.probUp10,
      probUp15_21d: fwd21.probUp15,
      probDown15_21d: fwd21.probDown15,
      probUp10_63d: fwd63.probUp10,
      probUp15_63d: fwd63.probUp15,
      p95_21d: fwd21.p95,
      p05_21d: fwd21.p05,
      p95_63d: fwd63.p95,
      p05_63d: fwd63.p05,
      median21d: fwd21.median,
      median63d: fwd63.median,
      closeSeriesTail: closes.slice(-5),
    });
    process.stderr.write("ok\n");
  }

  await writeFile(
    path.join(outDir, "underlying-comparison.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), asOf: rows[0]?.asOf ?? null, rows }, null, 1)
  );
  const md = renderMarkdown(scoreRows(rows));
  await writeFile(path.join(outDir, "underlying-comparison.md"), md);
  console.log(md);
}

/**
 * Rank underlyings for a "high risk / high return" options mandate.
 *
 * Two separate scores, because "high risk high return" means opposite things for a
 * buyer (needs big moves) and a seller (needs high IV relative to realized):
 *   - opportunity: how large the realistic move is (tail width) — matters for buyers
 *   - premiumEdge: IV minus forecast + liquidity — matters for sellers
 * Both are shown so the choice can be made at the strategy step rather than baked in.
 */
function scoreRows(rows) {
  const norm = (v, lo, hi) => (v === null || v === undefined || hi === lo ? 0 : Math.max(0, Math.min(1, (v - lo) / (hi - lo))));
  for (const r of rows) {
    // Move potential: 21d P95 upside + 63d probability of a >15% move.
    const upside = (r.p95_21d ?? 0) * 100;
    const move = norm(upside, 8, 20);
    const bigMove = norm((r.probUp15_63d ?? 0) * 100, 5, 19);
    const vol = norm(r.volForecast, 11, 38);
    r.opportunityScore = (move * 0.4 + bigMove * 0.3 + vol * 0.3) * 100;

    // Premium edge for a seller: IV above forecast, plus tradability.
    const edge = norm((r.ivMinusForecastPct ?? 0) * 100, -100, 400);
    const liq = norm(r.nearOpenInterest, 5000, 300000);
    const spread = norm(-(r.medianSpreadPct ?? 10), -7, -3);
    const strikes = norm(r.usableStrikes, 5, 12);
    r.premiumEdgeScore = (edge * 0.35 + liq * 0.25 + spread * 0.2 + strikes * 0.2) * 100;
  }
  return rows;
}

function f(x, d = 1) { return x === null || x === undefined || Number.isNaN(x) ? "—" : x.toFixed(d); }
function signed(x, d = 1) { if (x === null || x === undefined) return "—"; return `${x > 0 ? "+" : ""}${x.toFixed(d)}`; }

function renderMarkdown(rows) {
  const lines = [];
  const push = (...x) => lines.push(...x);
  push("## A股期权标的横向对比", "");
  push("### 1. 波动率与定价", "");
  push("| 标的 | 代码 | 分组 | 现价 | 20日HV | 60日HV | 250日HV | 波动率预测 | ATM IV | IV-预测 | 偏斜(10%虚值) |", "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const r of rows) {
    push(`| ${r.name} | ${r.code} | ${r.group} | ${f(r.spot, 3)} | ${f(r.hv20)}% | ${f(r.hv60)}% | ${f(r.hv250)}% | ${f(r.volForecast)}% | ${f(r.atmIvPct)}% | ${signed(r.ivMinusForecastPct)}pt | ${signed(r.callSkewPct)}pt |`);
  }
  push("");
  push("### 2. 流动性与合约结构", "");
  push("| 标的 | 近月到期 | 剩余交易日 | 到期月份数 | 合约数 | 档位数 | 有效档位(±10%) | 近月持仓 | 近月成交 | 有买价比例 | 中位价差 | 中位振幅 |", "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const r of rows) {
    push(`| ${r.name} | ${r.nearExpiry ?? "—"} | ${f(r.nearExpiryTradingDays, 0)} | ${r.expiryCount} | ${r.contracts} | ${r.strikesNear} | ${r.usableStrikes} | ${r.nearOpenInterest.toLocaleString()} | ${r.nearVolume.toLocaleString()} | ${f(r.bidCoveragePct, 0)}% | ${f(r.medianSpreadPct, 2)}% | ${f(r.medianAmplitudePct)}% |`);
  }
  push("");
  push("### 3. 尾部与收益分布（高收益/高风险的核心指标）", "");
  push("| 标的 | 历史最大回撤 | 单日最差 | 单日最好 | 21日涨超10% | 21日涨超15% | 63日涨超15% | 21日跌超15% | 21日P95 | 21日P05 |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const r of rows) {
    push(`| ${r.name} | ${f(r.maxDrawdownPct)}% | ${f(r.worstDayPct)}% | ${signed(r.bestDayPct)}% | ${f(r.probUp10_21d * 100)}% | ${f(r.probUp15_21d * 100)}% | ${f(r.probUp15_63d * 100)}% | ${f(r.probDown15_21d * 100)}% | ${signed(r.p95_21d * 100)}% | ${signed(r.p05_21d * 100)}% |`);
  }
  push("");
  push("### 4. 综合评分（两种口径，供第 2 步选策略）", "");
  push("| 标的 | 波动机会分（买方） | 权利金优势分（卖方） | IV-预测 | 近月持仓 | 有效档位 | 中位价差 |", "|---|---:|---:|---:|---:|---:|---:|");
  for (const r of [...rows].sort((a, b) => b.premiumEdgeScore - a.premiumEdgeScore)) {
    push(`| ${r.name} | ${f(r.opportunityScore, 0)} | ${f(r.premiumEdgeScore, 0)} | ${signed(r.ivMinusForecastPct)}pt | ${r.nearOpenInterest.toLocaleString()} | ${r.usableStrikes} | ${f(r.medianSpreadPct, 2)}% |`);
  }
  push("");
  push("> 波动机会分：21日P95涨幅、63日出现>15%波动概率、波动率预测的加权，衡量「标的值不值得买方博弈」。");
  push("> 权利金优势分：IV高于预测的幅度、近月持仓、价差、可用档位的加权，衡量「卖方能否稳定收租」。");
  push("> 两者结论不同是正常的——同一标的很难同时最适合买和最适合卖。");
  push("");
  return lines.join("\n");
}

main().catch((e) => { console.error(`compare failed: ${e.message}`); process.exitCode = 1; });
