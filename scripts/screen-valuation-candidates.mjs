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
import { screenValuationCandidate } from '../src/modules/research/domain/valuation-screen.ts';

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
async function reportingCurrency(code) {
  const rows = await getJson(`/api/finance/income?code=${encodeURIComponent(code)}`);
  const first = Array.isArray(rows) ? rows[0] : null;
  return first?.REPORTING_CURRENCY ?? first?.CURRENCY ?? null;
}

/** Trading currency of the security. */
function tradingCurrency(targetMarket) {
  return targetMarket === 'CN' ? 'CNY' : targetMarket === 'HK' ? 'HKD' : targetMarket === 'US' ? 'USD' : null;
}

const results = [];
let cursor = 0;
async function worker() {
  while (cursor < targets.length) {
    const target = targets[cursor++];
    try {
      const [bands, overview, bandCurrency] = await Promise.all([
        getJson(`/api/finance/valuation-bands?code=${encodeURIComponent(target.code)}`),
        getJson(`/api/company/overview?code=${encodeURIComponent(target.code)}`),
        reportingCurrency(target.code),
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
}
