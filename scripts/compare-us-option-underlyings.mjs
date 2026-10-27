#!/usr/bin/env node
/**
 * Cross-ticker comparison for US option underlyings.
 *
 * Reads the per-ticker caches written by fetch-us-option-chain.mjs and
 * analyze-us-option-strategies.mjs, then ranks the underlyings on the axes that
 * decide WHERE to trade options:
 *
 *   1. IV edge    — ATM IV minus a blended realized-vol forecast. Positive means the
 *                   market pays more volatility than the stock has been delivering,
 *                   which is what a premium seller needs.
 *   2. Move power — tail width of the underlying's own distribution. This is what a
 *                   buyer needs.
 *   3. Tradability — open interest and spread at the strike you would actually trade.
 *
 * Deliberately prints BOTH scores: "high risk high return" means opposite things to a
 * buyer and a seller, so collapsing them into one number would hide the trade-off.
 *
 * Usage:
 *   node scripts/compare-us-option-underlyings.mjs
 *   node scripts/compare-us-option-underlyings.mjs --symbols NVDA,MU,SNDK,SKHY --expiry-days 27
 */

import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";

const ROOT = "data/research/us-options";

function parseArgs(argv) {
  const options = { symbols: null, dir: ROOT, expiryDays: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--symbols") options.symbols = next().split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    else if (a === "--dir") options.dir = next();
    else if (a === "--expiry-days") options.expiryDays = Number(next());
    else if (a === "--out") options.out = next();
    else if (a === "--help" || a === "-h") options.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return options;
}

async function discoverSymbols(dir) {
  const entries = await readdir(path.resolve(dir), { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

/**
 * Choose the expiry to compare on. Default: the expiry closest to a 25-30 day
 * horizon, because that is where both weekly and monthly chains are liquid and
 * where IV is not distorted by an imminent earnings event.
 */
function pickExpiry(analysis, targetDays) {
  const list = analysis.expiryAnalysis ?? [];
  if (list.length === 0) return null;
  const withDays = list.filter((e) => e.tradingDays > 0);
  if (withDays.length === 0) return null;
  if (targetDays === null || targetDays === undefined) {
    return withDays.reduce((best, e) =>
      Math.abs(e.calendarDays - 27) < Math.abs(best.calendarDays - 27) ? e : best
    );
  }
  return withDays.reduce((best, e) =>
    Math.abs(e.calendarDays - targetDays) < Math.abs(best.calendarDays - targetDays) ? e : best
  );
}

/**
 * Liquidity at the strike a directional buyer would actually use (~+10% OTM).
 *
 * Only strikes with meaningful open interest are counted: an illiquid strike can show
 * a 60% spread purely because nobody quotes it, which would wrongly condemn an
 * otherwise liquid chain. The median is taken over the tradeable subset.
 */
function tradeability(chain, spot) {
  const all = [...(chain.calls ?? []), ...(chain.puts ?? [])];
  if (all.length === 0) return null;
  const target = spot * 1.1;
  const candidates = all
    .filter((c) => Math.abs(c.strike - target) / target < 0.05)
    .filter((c) => (c.openInterest ?? 0) >= 100) // tradeable book only
    .sort((a, b) => Math.abs(a.strike - target) - Math.abs(b.strike - target))
    .slice(0, 4);
  if (candidates.length === 0) return null;
  const spreads = candidates
    .map((c) => (c.executableAsk && c.executableBid && c.executableBid > 0
      ? ((c.executableAsk - c.executableBid) / ((c.executableAsk + c.executableBid) / 2)) * 100
      : null))
    .filter((v) => v !== null && v >= 0)
    .sort((a, b) => a - b);
  const oi = candidates.reduce((a, c) => a + (c.openInterest ?? 0), 0);
  return {
    medianSpreadPct: spreads.length ? spreads[Math.floor(spreads.length / 2)] : null,
    nearbyOi: oi,
    strikesNearby: candidates.length,
  };
}

/** Normalize a value into 0..1 across the observed cohort. */
function normalize(value, lo, hi) {
  if (value === null || value === undefined || !Number.isFinite(value) || hi === lo) return 0;
  return Math.max(0, Math.min(1, (value - lo) / (hi - lo)));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("node scripts/compare-us-option-underlyings.mjs [--symbols NVDA,MU] [--expiry-days 27]");
    return;
  }
  const dir = path.resolve(options.dir);
  const symbols = options.symbols ?? (await discoverSymbols(dir));

  const rows = [];
  for (const symbol of symbols) {
    const base = path.join(dir, symbol);
    try {
      const analysis = JSON.parse(await readFile(path.join(base, "strategy-analysis.json"), "utf8"));
      const chain = JSON.parse(await readFile(path.join(base, "option-chain.json"), "utf8"));
      const expiry = pickExpiry(analysis, options.expiryDays);
      if (!expiry) { console.warn(`  skip ${symbol}: no usable expiry`); continue; }
      const chainForExpiry = (chain.chains ?? []).find((c) => c.expiry === expiry.expiry);
      const liq = chainForExpiry ? tradeability(chainForExpiry, analysis.spot) : null;

      rows.push({
        symbol,
        asOf: analysis.asOf,
        spot: analysis.spot,
        historyBars: analysis.historyBars ?? analysis.tailWindow?.bars ?? null,
        // IV / vol context
        volForecastPct: analysis.volForecastPct,
        hv20: analysis.hv20,
        hv60: analysis.hv60,
        expiry: expiry.expiry,
        calendarDays: expiry.calendarDays,
        atmIvPct: expiry.atmIvPct,
        ivMinusForecastPct: expiry.atmIvPct !== null && analysis.volForecastPct !== null
          ? expiry.atmIvPct - analysis.volForecastPct
          : null,
        // Move potential
        p95_21d: analysis.p95_21d,
        p05_21d: analysis.p05_21d,
        probUp10_21d: analysis.probUp10_21d,
        probUp20_21d: analysis.probUp20_21d,
        maxDrawdownPct: analysis.maxDrawdownPct,
        // Tradability
        nearbyOi: liq?.nearbyOi ?? null,
        medianSpreadPct: liq?.medianSpreadPct ?? null,
        listedStrikes: expiry.listedStrikes,
        // Data-quality flags so a 3-month-old IPO is never compared as if equal.
        listingGap: analysis.tailWindow?.listingGap ?? null,
        sampleCaveat: (analysis.replayRows ?? []).length > 0
          ? Math.min(...analysis.replayRows.map((r) => r.n))
          : null,
      });
    } catch (error) {
      console.warn(`  skip ${symbol}: ${error.message}`);
    }
  }
  if (rows.length === 0) throw new Error("no cached analyses found; run fetch + analyze first");

  // --- Scoring -------------------------------------------------------------
  const ivEdges = rows.map((r) => r.ivMinusForecastPct).filter((v) => v !== null);
  const movePowers = rows.map((r) => r.p95_21d).filter((v) => v !== null);
  const spreads = rows.map((r) => r.medianSpreadPct).filter((v) => v !== null);
  const ois = rows.map((r) => r.nearbyOi).filter((v) => v !== null);

  const ivLo = Math.min(...ivEdges), ivHi = Math.max(...ivEdges);
  const moveLo = Math.min(...movePowers), moveHi = Math.max(...movePowers);
  const spreadLo = Math.min(...spreads), spreadHi = Math.max(...spreads);
  const oiLo = Math.min(...ois), oiHi = Math.max(...ois);

  for (const r of rows) {
    // Seller score: rich IV + tight spread + deep book. A rich IV with a bad book is
    // not tradeable, so liquidity is weighted meaningfully.
    const ivScore = normalize(r.ivMinusForecastPct, ivLo, ivHi);
    const spreadScore = r.medianSpreadPct === null ? 0 : 1 - normalize(r.medianSpreadPct, spreadLo, spreadHi);
    const oiScore = normalize(r.nearbyOi, oiLo, oiHi);
    r.sellerScore = (ivScore * 0.5 + spreadScore * 0.25 + oiScore * 0.25) * 100;

    // Buyer score: how big the moves actually get.
    const moveScore = normalize(r.p95_21d, moveLo, moveHi);
    const upScore = normalize(r.probUp20_21d, 0, 0.35);
    r.buyerScore = (moveScore * 0.6 + upScore * 0.4) * 100;
  }

  const result = {
    generatedAt: new Date().toISOString(),
    comparedExpiryMode: options.expiryDays ?? "closest to 27 calendar days",
    rows,
  };

  const outDir = options.out ? path.resolve(options.out) : dir;
  await writeFile(path.join(outDir, "underlying-comparison.json"), JSON.stringify(result, null, 1));
  const md = render(result);
  await writeFile(path.join(outDir, "underlying-comparison.md"), md);
  console.log(md);
}

function fx(x, d = 1) { return x === null || x === undefined || Number.isNaN(x) ? "—" : x.toFixed(d); }
function pct(x, d = 1) { return x === null || x === undefined || Number.isNaN(x) ? "—" : `${(x * 100).toFixed(d)}%`; }

function render(r) {
  const L = [];
  const p = (...x) => L.push(...x);
  p("# 美股期权标的横向对比", "");
  p(`对比到期日口径：${r.comparedExpiryMode}`, "");

  p("## 1. IV 与波动率（卖方视角的核心）", "");
  p("| 标的 | 现价 | 20日HV | 60日HV | 波动率预测 | ATM IV | **IV−预测** | 到期日 | 剩余天数 |", "|---|---:|---:|---:|---:|---:|---:|---|---:|");
  for (const x of [...r.rows].sort((a, b) => (b.ivMinusForecastPct ?? -99) - (a.ivMinusForecastPct ?? -99))) {
    const edge = x.ivMinusForecastPct;
    p(`| ${x.symbol} | ${fx(x.spot, 2)} | ${fx(x.hv20)}% | ${fx(x.hv60)}% | ${fx(x.volForecastPct)}% | ${fx(x.atmIvPct)}% | **${edge === null ? "—" : (edge > 0 ? "+" : "") + fx(edge)}pt** | ${x.expiry} | ${x.calendarDays} |`);
  }
  p("");

  p("## 2. 波动弹性（买方视角的核心）", "");
  p("| 标的 | 21日P95 | 21日P05 | 涨超10%概率 | 涨超20%概率 | 历史最大回撤 |", "|---|---:|---:|---:|---:|---:|");
  for (const x of [...r.rows].sort((a, b) => (b.p95_21d ?? -99) - (a.p95_21d ?? -99))) {
    p(`| ${x.symbol} | ${pct(x.p95_21d)} | ${pct(x.p05_21d)} | ${pct(x.probUp10_21d)} | ${pct(x.probUp20_21d)} | ${fx(x.maxDrawdownPct)}% |`);
  }
  p("");

  p("## 3. 可交易性", "");
  p("| 标的 | ±10%虚值持仓 | 中位价差 | 档位数 | 历史K线数 | 最小回放样本 | 数据提示 |", "|---|---:|---:|---:|---:|---:|---|");
  for (const x of r.rows) {
    const notes = [];
    if (x.listingGap) notes.push(`上市断层 ${x.listingGap.gapDays}天`);
    if (x.sampleCaveat !== null && x.sampleCaveat < 30) notes.push("回放样本不足");
    if (x.historyBars !== null && x.historyBars < 250) notes.push(`仅${x.historyBars}根K线`);
    p(`| ${x.symbol} | ${(x.nearbyOi ?? 0).toLocaleString()} | ${fx(x.medianSpreadPct, 2)}% | ${x.listedStrikes} | ${x.historyBars ?? "—"} | ${x.sampleCaveat ?? "—"} | ${notes.length ? notes.join("；") : "—"} |`);
  }
  p("");

  p("## 4. 综合评分", "");
  p("| 标的 | 卖方分(IV溢价+流动性) | 买方分(波幅+上行概率) | IV−预测 | 21日P95 |", "|---|---:|---:|---:|---:|");
  for (const x of [...r.rows].sort((a, b) => b.sellerScore - a.sellerScore)) {
    p(`| ${x.symbol} | **${fx(x.sellerScore, 0)}** | ${fx(x.buyerScore, 0)} | ${x.ivMinusForecastPct === null ? "—" : (x.ivMinusForecastPct > 0 ? "+" : "") + fx(x.ivMinusForecastPct)}pt | ${pct(x.p95_21d)} |`);
  }
  p("");
  p("> 卖方分：IV 溢价权重 50%、价差 25%、盘口深度 25%。溢价很高但盘口太薄的标的会因此被降分。");
  p("> 买方分：21日 P95 波幅权重 60%、涨超20%概率 40%。");
  p("> **两个分数天然难以兼得**：IV 被高估的标的通常波动已被市场定价，反之亦然。", "");
  return L.join("\n");
}

main().catch((e) => { console.error(`compare failed: ${e.message}`); process.exitCode = 1; });
