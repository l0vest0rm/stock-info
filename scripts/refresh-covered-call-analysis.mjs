#!/usr/bin/env node
/**
 * One-command refresh for the covered-call research dataset.
 *
 * Runs the whole programmatic pipeline so the analysis can be regenerated on any
 * later date without remembering the ordering or the flags:
 *
 *   1. fetch-etf-option-chain.mjs   option chain + underlying K-lines
 *   2. fetch-option-iv-history.mjs  per-contract K-lines -> IV surface history
 *   3. fetch-option-quotes.mjs      live bid/ask (a seller receives the bid)
 *   4. option-covered-call-analysis.mjs  metrics + report.md
 *
 * It then verifies that every layer reports the SAME trade date. A silent date
 * mismatch is the main failure mode here (e.g. a weekend run where the option
 * chain still shows Friday but the quote snapshot failed), and a report built on
 * mismatched dates is worse than no report.
 *
 * Usage:
 *   node scripts/refresh-covered-call-analysis.mjs
 *   node scripts/refresh-covered-call-analysis.mjs --code 588000.SH --out data/research/covered-call-588000
 *   node scripts/refresh-covered-call-analysis.mjs --skip-iv-history   # faster, keeps stale IV surface
 *   node scripts/refresh-covered-call-analysis.mjs --check-only        # verify freshness, fetch nothing
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

const DEFAULTS = {
  code: "588000.SH",
  out: "data/research/covered-call-588000",
  apiBase: "http://127.0.0.1:8000",
  skipIvHistory: false,
  checkOnly: false,
};

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--code") options.code = next();
    else if (arg === "--out") options.out = next();
    else if (arg === "--api-base") options.apiBase = next();
    else if (arg === "--skip-iv-history") options.skipIvHistory = true;
    else if (arg === "--check-only") options.checkOnly = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function runStep(label, args) {
  return new Promise((resolve, reject) => {
    console.log(`\n=== ${label} ===`);
    const child = spawn(process.execPath, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} exited with code ${code}`));
    });
  });
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

/**
 * Fail early with an actionable message if the local Node runtime is not up.
 * The underlying K-line comes from GET /api/kline (Xueqiu-backed), so a missing
 * runtime would otherwise surface as a confusing fetch error midway through.
 */
async function assertLocalApi(apiBase) {
  const url = new URL("/api/health", apiBase).toString();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    throw new Error(
      `本地 API 不可用 (${url})：${error instanceof Error ? error.message : String(error)}\n`
        + "请先运行 ./start-local.sh，确认 GET /api/health 返回 200 后再执行本脚本。"
    );
  }
}

/**
 * Collect the trade date each layer believes it is describing.
 * Eastmoney/Sina quotes for a closed market keep returning the last session,
 * so this is what we must reconcile against the underlying K-line date.
 */
async function collectLayerDates(dir) {
  const out = { underlyingKline: null, chain: null, quotes: null, ivHistory: null };
  try {
    const kline = await readJson(path.join(dir, "kline-qfq.json"));
    out.underlyingKline = kline.rows?.at(-1)?.date ?? null;
  } catch {}
  try {
    const chain = await readJson(path.join(dir, "option-chain.json"));
    out.chain = chain.tradeDate ?? null;
  } catch {}
  try {
    const quotes = await readJson(path.join(dir, "quotes-snapshot.json"));
    const first = Object.values(quotes.quotes ?? {})[0];
    out.quotes = first?.quoteTime?.slice(0, 10) ?? null;
  } catch {}
  try {
    const iv = await readJson(path.join(dir, "iv-history.json"));
    out.ivHistory = iv.atm?.at(-1)?.date ?? null;
  } catch {}
  return out;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("node scripts/refresh-covered-call-analysis.mjs [--code 588000.SH] [--out DIR] [--skip-iv-history] [--check-only]");
    return;
  }
  const dir = path.resolve(options.out);
  const scriptsDir = path.resolve(path.dirname(new URL(import.meta.url).pathname));
  const degraded = [];

  if (!options.checkOnly) {
    await assertLocalApi(options.apiBase);
    await runStep("1/4 抓期权链 + 标的K线", [
      path.join(scriptsDir, "fetch-etf-option-chain.mjs"),
      "--code",
      options.code,
      "--out",
      dir,
      "--api-base",
      options.apiBase,
    ]);
    if (options.skipIvHistory) {
      console.log("\n[skip] 期权合约历史（IV 曲面）按参数跳过");
    } else {
      // The per-contract history source (Eastmoney push2his) is third-party and can be
      // blocked outright. The IV surface is a "is today's vol rich" input, not a
      // prerequisite for the chain/strike/premium analysis, so a failure here must
      // degrade gracefully instead of aborting the refresh.
      try {
        await runStep("2/4 抓合约历史并反解 IV 曲面", [path.join(scriptsDir, "fetch-option-iv-history.mjs"), "--dir", dir]);
      } catch (error) {
        console.warn(`\n[warn] IV 曲面更新失败，继续用已有缓存：${error instanceof Error ? error.message : String(error)}`);
        console.warn("[warn] 若 iv-history.json 缺失或过旧，报告的 IV 分位与远期波动率部分会标注为不可用。");
        degraded.push("iv-history");
      }
    }
    await runStep("3/4 抓最新买卖盘口", [path.join(scriptsDir, "fetch-option-quotes.mjs"), "--dir", dir]);
    await runStep("4/4 生成指标与报告", [path.join(scriptsDir, "option-covered-call-analysis.mjs"), "--dir", dir]);
  }

  const dates = await collectLayerDates(dir);
  const target = dates.underlyingKline;
  const problems = [];

  if (!target) problems.push("标的 K 线缺失，无法确定基准日");
  for (const [layer, value] of Object.entries(dates)) {
    if (layer === "underlyingKline") continue;
    if (!value) {
      problems.push(`${layer} 缺失`);
      continue;
    }
    if (target && value !== target) problems.push(`${layer}=${value} 与标的K线基准日 ${target} 不一致`);
  }

  let analysisAsOf = null;
  try {
    const analysis = await readJson(path.join(dir, "analysis.json"));
    analysisAsOf = analysis.asOf ?? null;
    if (target && analysisAsOf !== target) {
      problems.push(`analysis.json asOf=${analysisAsOf} 与标的K线基准日 ${target} 不一致`);
    }
  } catch {
    problems.push("analysis.json 缺失");
  }

  console.log("\n=== 数据一致性检查 ===");
  for (const [layer, value] of Object.entries(dates)) {
    console.log(`  ${layer.padEnd(16)} ${value ?? "(缺失)"}`);
  }
  console.log(`  ${"analysis.asOf".padEnd(16)} ${analysisAsOf ?? "(缺失)"}`);

  if (problems.length > 0) {
    console.error("\n数据不一致：");
    for (const p of problems) console.error(`  - ${p}`);
    console.error("\n基准日不一致时不要使用这份报告。常见原因：非交易日运行、盘口抓取失败、或本地 API 未返回最新K线。");
    process.exitCode = 1;
    return;
  }

  // Staleness against the real clock: how many calendar days behind is the data?
  const today = new Date().toISOString().slice(0, 10);
  const lagDays = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${target}T00:00:00Z`)) / 86_400_000);
  console.log(`\n全部数据层基准日一致：${target}`);
  console.log(`距当前日期 ${today} 已过 ${lagDays} 个自然日（非交易日运行会显示为上一交易日，属正常）。`);
  if (lagDays > 10) {
    console.warn(`\n警告：数据已滞后 ${lagDays} 天，期权权利金和 IV 分位大概率不可用，请在下单前重新刷新。`);
  }
}

main().catch((error) => {
  console.error(`refresh failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
