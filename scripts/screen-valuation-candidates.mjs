#!/usr/bin/env node
/**
 * Screen the watchlist for research candidates (P3-2).
 *
 * Read-only. It fetches each company's valuation bands and dated quote, feeds
 * both into `domain/valuation-screen.ts`, and prints what the rule could and
 * could not decide — naming the blocking reason rather than guessing around it.
 *
 * What this deliberately does not do:
 * - it does not print an action. The vocabulary is `research_candidate` /
 *   `watch` / `blocked`; `consider_buy` needs the owner's account, which no
 *   script can see;
 * - it does not convert currencies. A CNY-reporting company quoted in HKD is
 *   `currency_mismatch`, not "about 7.8x cheaper".
 *
 * Usage:
 *   node scripts/screen-valuation-candidates.mjs
 *   node scripts/screen-valuation-candidates.mjs --market=CN --limit=20
 *   node scripts/screen-valuation-candidates.mjs --json
 *   node scripts/screen-valuation-candidates.mjs --verdict=research_candidate
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { screenValuationCandidate } from './lib/rust-analysis.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const inline = args.find((item) => item.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const flag = (name) => args.includes(name);
if (flag('--help')) {
  console.log('Usage: node scripts/screen-valuation-candidates.mjs [--market=CN|HK|US] [--limit=N] [--verdict=research_candidate] [--json] [--base-url URL] [--concurrency=N]');
  process.exit(0);
}

const baseUrl = option('--base-url', 'http://127.0.0.1:8000').replace(/\/+$/, '');
const market = option('--market', '');
const verdictFilter = option('--verdict', '');
const limit = Number(option('--limit', '0')) || 0;
const asJson = flag('--json');
const concurrency = Number(option('--concurrency', '4'));

const universe = JSON.parse(readFileSync(resolve(root, 'config/investment-universe.json'), 'utf8'));
const apiCodeFor = (security) => (security.market === 'US' && !security.ticker.endsWith('.US')
  ? `${security.ticker}.US`
  : security.ticker);

let targets = universe.companies
  .filter((company) => company.classificationStatus === 'verified')
  .filter((company) => !market || company.preferredMarket === market)
  .map((company) => {
    const security = company.securities.find((item) => item.ticker === company.preferredTicker) ?? company.securities[0];
    return { companyId: company.id, name: company.displayName, code: apiCodeFor(security), market: security.market };
  });
if (limit > 0) targets = targets.slice(0, limit);

async function getJson(path) {
  // A single transient 500 must not be reported as "this company cannot be
  // screened".  The quote path is rate-limited (雪球), and during the first
  // full-pool run 贵州茅台 and 五粮液 both came back empty on the first try and
  // populated on a retry — reporting that as `quote_missing` would blame the
  // company for a provider hiccup.  Retries are bounded and still fail loudly.
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(180000) });
      const body = await response.json().catch(() => null);
      if (response.ok && body?.code === 200) return body.data;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1500 * (attempt + 1)));
  }
  void lastError;
  return null;
}

/**
 * Reporting currency of the latest income statement, as the provider spells it
 * (Chinese for HK, ISO for A-shares). `valuation-screen` normalises it.
 */
/**
 * Reporting currency of the newest *formal* statement.
 *
 * Not `rows[0]`: a 业绩预告 / 业绩快报 row carries no `CURRENCY` field, so taking
 * the newest row blindly returns null for any company that has a forecast, and
 * the screen then blocks it as a currency problem.  生益科技 is the live case —
 * an A-share reporting in CNY was blocked because its newest row was a forecast.
 * Scanning forward for the first row that actually declares a currency fixes the
 * cause rather than the symptom.
 */
async function reportingCurrency(code) {
  const rows = await getJson(`/api/finance/income?code=${encodeURIComponent(code)}`);
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    const currency = row?.REPORTING_CURRENCY ?? row?.CURRENCY;
    if (typeof currency === 'string' && currency.trim()) return currency.trim();
  }
  return null;
}

/** Trading currency of the security. */
function tradingCurrency(targetMarket) {
  return targetMarket === 'CN' ? 'CNY' : targetMarket === 'HK' ? 'HKD' : targetMarket === 'US' ? 'USD' : null;
}

/**
 * Trailing net-profit growth from the newest quarterly/interim period.
 *
 * Never from an annual report: a December annual quoted in October is a year
 * stale, and the whole point of the reading is whether earnings are shrinking
 * *now*.  The year-ago period is matched by date rather than array position,
 * because US filers interleave 12M and 3M rows.
 *
 * Returns null rather than a guess when either TTM figure is missing — absent
 * growth must not become a verdict about the company.
 */
function ttmGrowth(points) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const latest = points[0];
  const latestDate = Date.parse(`${latest?.reportDate}T00:00:00Z`);
  if (!Number.isFinite(latestDate)) return null;
  let best = null;
  let bestDistance = Infinity;
  for (const point of points.slice(1)) {
    const time = Date.parse(`${point?.reportDate}T00:00:00Z`);
    if (!Number.isFinite(time)) continue;
    const distance = Math.abs(time - (latestDate - 365 * 86_400_000));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = point;
    }
  }
  if (!best || bestDistance > 45 * 86_400_000) return null;
  const now = latest?.ttmNetProfit;
  const then = best?.ttmNetProfit;
  if (typeof now !== 'number' || typeof then !== 'number' || then <= 0 || now <= 0) return null;
  return {
    ttmGrowth: now / then - 1,
    reportDate: latest.reportDate,
    provisional: latest.provisional === true,
  };
}

async function growthReading(code) {
  const data = await getJson(`/api/finance/income/quarterly-series?code=${encodeURIComponent(code)}&limit=8`);
  return ttmGrowth(data?.points ?? []);
}

const results = [];
let cursor = 0;
async function worker() {
  while (cursor < targets.length) {
    const target = targets[cursor++];
    try {
      const [bands, overview, bandCurrency, growth] = await Promise.all([
        getJson(`/api/finance/valuation-bands?code=${encodeURIComponent(target.code)}`),
        getJson(`/api/company/overview?code=${encodeURIComponent(target.code)}`),
        reportingCurrency(target.code),
        growthReading(target.code),
      ]);
      if (!bands) {
        results.push({ code: target.code, name: target.name, market: target.market, verdict: 'blocked', blockReasons: ['bands_unavailable'], note: '区间接口未返回数据（取数失败，不等于估值不可计算）' });
        continue;
      }
      // `overview === null` means the quote endpoint failed outright; that is a
      // fetch failure and must not be reported as a company with no market cap.
      if (!overview) {
        results.push({ code: target.code, name: target.name, market: target.market, verdict: 'blocked', blockReasons: ['quote_fetch_failed'], note: '行情接口连续三次未返回（取数失败，不等于没有市值）' });
        continue;
      }
      const result = screenValuationCandidate({
        code: target.code,
        archetype: bands.archetype,
        bands: bands.bands,
        bandCurrency,
        quote: {
          currency: tradingCurrency(target.market),
          // The quote date is the market session the price belongs to.
          priceAsOf: overview.marketDate ?? null,
          marketCap: overview.marketCapYi === null || overview.marketCapYi === undefined
            ? null
            : overview.marketCapYi * 100_000_000,
        },
        growth,
      });
      results.push({ ...result, name: target.name, market: target.market, bandCurrency });
    } catch (error) {
      results.push({ code: target.code, name: target.name, market: target.market, verdict: 'blocked', blockReasons: ['request_failed'], note: error instanceof Error ? error.message : String(error) });
    }
  }
}
await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, targets.length)) }, worker));

const shown = verdictFilter ? results.filter((item) => item.verdict === verdictFilter) : results;

if (asJson) {
  const byVerdict = results.reduce((acc, item) => { acc[item.verdict] = (acc[item.verdict] ?? 0) + 1; return acc; }, {});
  const blockedDetail = results
    .filter((item) => item.verdict === 'blocked')
    .reduce((acc, item) => { for (const reason of item.blockReasons) acc[reason] = (acc[reason] ?? 0) + 1; return acc; }, {});
  console.log(JSON.stringify({ screened: results.length, byVerdict, blockedDetail, results: shown }, null, 2));
} else {
  const byVerdict = results.reduce((acc, item) => { acc[item.verdict] = (acc[item.verdict] ?? 0) + 1; return acc; }, {});
  console.log(`Screened ${results.length} companies: ${JSON.stringify(byVerdict)}`);

  const blockedDetail = results
    .filter((item) => item.verdict === 'blocked')
    .reduce((acc, item) => { for (const reason of item.blockReasons) acc[reason] = (acc[reason] ?? 0) + 1; return acc; }, {});
  if (Object.keys(blockedDetail).length) {
    console.log('');
    console.log('Blocked, by reason (a block is information, not a failure):');
    for (const [reason, count] of Object.entries(blockedDetail).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${reason.padEnd(22)} ${count}`);
    }
  }

  const candidates = shown
    .filter((item) => item.verdict === 'research_candidate')
    .sort((a, b) => b.position.marginOfSafety - a.position.marginOfSafety);
  if (candidates.length) {
    console.log('');
    console.log('Research candidates (study first; not a trading instruction):');
    for (const item of candidates) {
      console.log(
        `  ${item.code.padEnd(11)} ${String(item.name).padEnd(8)} ${item.basis.key.padEnd(10)}`
        + ` 边际 ${(item.position.marginOfSafety * 100).toFixed(1)}%`
        + `  锚点 ${item.basis.reportDate}`,
      );
    }
  }

  const watched = shown.filter((item) => item.verdict === 'watch');
  if (watched.length) {
    console.log('');
    console.log(`Watch (${watched.length}): 区间内但折扣不足，或高于区间上限。`);
    for (const item of watched.slice(0, 10)) {
      console.log(`  ${item.code.padEnd(11)} ${String(item.name).padEnd(8)} ${item.note}`);
    }
    if (watched.length > 10) console.log(`  …另有 ${watched.length - 10} 家`);
  }

  // The growth reading is reported even when it changed nothing, because "no veto
  // fired" and "no veto was available" are different facts and only one of them is
  // reassuring.  `unknown` means the data was missing; `not_meaningful` means it
  // was too extreme to use as evidence in either direction.
  const growthDetail = results.reduce((acc, item) => {
    const verdict = item.growth?.verdict ?? 'unknown';
    acc[verdict] = (acc[verdict] ?? 0) + 1;
    return acc;
  }, {});
  console.log('');
  console.log(`Growth reading: ${JSON.stringify(growthDetail)}`);

  const vetoed = results.filter((item) => item.growth?.verdict === 'vetoes');
  if (vetoed.length) {
    console.log(`Growth veto (${vetoed.length}): TTM 利润同比 ≤ −15%，低倍数不是折价。只对净利润口径区间生效。`);
    for (const item of vetoed.slice(0, 12)) {
      const growth = item.growth.ttmGrowth;
      console.log(
        `  ${item.code.padEnd(11)} ${String(item.name).padEnd(8)} ${item.verdict.padEnd(19)}`
        + ` 增速 ${(growth * 100).toFixed(1)}%  截至 ${item.growth.reportDate}`,
      );
    }
    if (vetoed.length > 12) console.log(`  …另有 ${vetoed.length - 12} 家`);
  }
}
