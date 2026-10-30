#!/usr/bin/env node
/**
 * Compare the hand-set valuation bands against where these businesses actually
 * traded.
 *
 * `DEFAULT_RANGES` in `finance/domain/valuation-bands.ts` are round numbers
 * chosen by judgement: PE 8–18x for anything that reports earnings, PB 0.8–2.5x
 * for banks.  They are honest defaults, but they are not evidence — and the
 * screen turns them into verdicts.  Xueqiu's K-line already carries a `pe`/`pb`/
 * `ps` column for every trading day back to 2016, so the distribution is
 * measurable without adding a data source.
 *
 * The output answers two questions per archetype and multiple:
 *   1. what did it actually trade at (p10/p25/median/p75/p90);
 *   2. what share of that history does the current band cover, and which way is
 *      it displaced?
 *
 * Question 2 is the one that matters.  A band covering 0% of a group's history
 * is not a conservative assumption about that group, it is a different claim.
 * Where the band sits *below* history the group can never produce a research
 * candidate; where it sits *above* history (banks) the group looks permanently
 * cheap.
 *
 * This script does NOT rewrite DEFAULT_RANGES.  Choosing bands is a strategy
 * decision — a distribution median contains bubbles and crises, and a low
 * median can mean a permanently de-rated business rather than value — so it is
 * the owner's call.  This prints the evidence and stops.
 *
 * Usage:
 *   node scripts/calibrate-valuation-multiples.mjs
 *   node scripts/calibrate-valuation-multiples.mjs --market=CN
 *   node scripts/calibrate-valuation-multiples.mjs --from=2018-01-01
 *   node scripts/calibrate-valuation-multiples.mjs --json
 *
 * Read-only.  Never writes config, never changes a band, never emits an action.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BAND_MULTIPLE_FIELDS,
  MIN_MEANINGFUL_COVERAGE,
  measureBandCoverage,
  sortedUsableValues,
} from './lib/rust-analysis.mjs';

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
  console.log('Usage: node scripts/calibrate-valuation-multiples.mjs [--market=CN|HK|US] [--from=YYYY-MM-DD] [--json] [--concurrency=N]');
  console.log('');
  console.log('Prints the observed PE/PB/PS distribution per archetype and how much of that');
  console.log('history the current hand-set band covers. Read-only; changes nothing.');
  process.exit(0);
}

const baseUrl = option('--base-url', 'http://127.0.0.1:8000').replace(/\/+$/, '');
const market = option('--market', '');
const from = option('--from', '2016-01-01');
const asJson = flag('--json');
const concurrency = Math.max(1, Number(option('--concurrency', '4')) || 4);

/**
 * The hand-set ranges currently in force, mirrored for comparison only.
 * Kept in sync with DEFAULT_RANGES in `finance/domain/valuation-bands.ts`.
 */
const CURRENT_DEFAULTS = {
  pe_ttm: { low: 8, high: 18 },
  pb: { low: 0.8, high: 2.5 },
  ps_ttm: { low: 1, high: 5 },
};

const universe = JSON.parse(readFileSync(resolve(root, 'config/investment-universe.json'), 'utf8'));
const apiCodeFor = (security) => (security.market === 'US' && !security.ticker.endsWith('.US')
  ? `${security.ticker}.US`
  : security.ticker);

const targets = universe.companies
  .filter((company) => company.classificationStatus === 'verified')
  .filter((company) => !market || company.preferredMarket === market)
  .map((company) => {
    const security = company.securities.find((item) => item.ticker === company.preferredTicker) ?? company.securities[0];
    return {
      name: company.displayName,
      code: apiCodeFor(security),
      market: security.market,
      archetype: company.valuationArchetype ?? 'other',
    };
  });

/** Fetch one code's multiple series, retrying the flaky Xueqiu path. */
async function fetchRows(code) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const url = `${baseUrl}/api/kline?code=${encodeURIComponent(code)}&period=day&format=structured&from=${from}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
      const body = await response.json();
      if (body.code === 200 && Array.isArray(body.data)) return body.data;
      lastError = new Error(body.msg || `HTTP ${response.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((done) => setTimeout(done, 1200 * attempt));
  }
  throw lastError ?? new Error('unknown');
}

// ---- fetch, then pool every trading day of every member of an archetype ----
const pooled = new Map(); // archetype → band → values
const perCompany = [];
const failures = [];
let cursor = 0;

async function worker() {
  for (;;) {
    const index = cursor++;
    if (index >= targets.length) return;
    const target = targets[index];
    try {
      const rows = await fetchRows(target.code);
      const companyStats = { code: target.code, name: target.name, archetype: target.archetype, observations: rows.length, bands: {} };
      if (!pooled.has(target.archetype)) pooled.set(target.archetype, new Map());
      const bucket = pooled.get(target.archetype);
      for (const [band, field] of Object.entries(BAND_MULTIPLE_FIELDS)) {
        const values = rows.map((row) => row[field.seriesKey]);
        companyStats.bands[band] = {
          observations: sortedUsableValues(values, field.seriesKey).length,
        };
        if (!bucket.has(band)) bucket.set(band, []);
        bucket.get(band).push(...values);
      }
      perCompany.push(companyStats);
    } catch (err) {
      failures.push({ code: target.code, name: target.name, reason: err instanceof Error ? err.message : String(err) });
    }
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));

const report = [...pooled.entries()]
  .sort((left, right) => left[0].localeCompare(right[0]))
  .map(([archetype, byBand]) => {
    const bands = {};
    for (const [band, values] of byBand.entries()) {
      const field = BAND_MULTIPLE_FIELDS[band];
      const coverage = measureBandCoverage(band, CURRENT_DEFAULTS[band], sortedUsableValues(values, field.seriesKey));
      if (coverage) bands[band] = coverage;
    }
    return {
      archetype,
      // Count only companies that contributed data, so "n" matches the arithmetic.
      companies: new Set(perCompany.filter((item) => item.archetype === archetype).map((item) => item.code)).size,
      bands,
    };
  });

if (asJson) {
  console.log(JSON.stringify({
    asOf: new Date().toISOString().slice(0, 10),
    window: { from, to: 'today' },
    companies: perCompany.length,
    failed: failures.length,
    report,
    perCompany,
    failures,
  }, null, 2));
  process.exit(0);
}

const pct = (value) => (typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '—');
const num = (value, digits = 2) => (typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—');

console.log(`Valuation band calibration (observed ${from} → today)`);
console.log(`Companies with data: ${perCompany.length}/${targets.length}   failed: ${failures.length}`);
console.log('');
console.log('Evidence only. DEFAULT_RANGES in valuation-bands.ts are unchanged by this script.');
console.log(`A band covering under ${pct(MIN_MEANINGFUL_COVERAGE)} of a group's history is flagged ⚠.`);
console.log('');

for (const item of report) {
  const pe = item.bands.pe_ttm;
  if (!pe) continue;
  console.log(`${item.archetype}  (${item.companies} companies)`);
  console.log('  metric    n(obs)     p10     p25  median     p75     p90   band     covers   read');
  for (const [band, stats] of Object.entries(item.bands)) {
    const label = BAND_MULTIPLE_FIELDS[band]?.label ?? band;
    const def = `${stats.currentDefault.low}–${stats.currentDefault.high}`;
    const read = stats.displacement === 'band_below_history'
      ? 'band below history'
      : stats.displacement === 'band_above_history'
        ? 'band above history'
        : 'straddles';
    const warn = stats.underCoversHistory ? ' ⚠' : '';
    console.log(
      `  ${label.padEnd(9)} ${String(stats.observed.samples).padStart(6)}  ${num(stats.observed.p10).padStart(6)}  ${num(stats.observed.p25).padStart(6)}  ${num(stats.observed.median).padStart(6)}  ${num(stats.observed.p75).padStart(6)}  ${num(stats.observed.p90).padStart(6)}   ${def.padEnd(8)} ${pct(stats.shareInsideBand).padStart(7)}   ${read}${warn}`,
    );
  }
  console.log('');
}

const below = report.filter((item) => item.bands.pe_ttm?.displacement === 'band_below_history');
const above = report.filter((item) => item.bands.pe_ttm?.displacement === 'band_above_history');
const straddles = report.filter((item) => item.bands.pe_ttm?.displacement === 'straddles_history');
const names = (list) => list.map((item) => `${item.archetype}(${item.companies})`).join(', ') || '—';

console.log('Where the PE band sits, and what it implies for the screen:');
console.log(`  below history → cannot nominate a member at its normal level: ${names(below)}`);
console.log(`  above history → nominates on a mis-measure (looks cheap):      ${names(above)}`);
console.log(`  straddles     → roughly describes the group:                  ${names(straddles)}`);
console.log('');

if (failures.length > 0) {
  console.log(`Fetch failures (${failures.length}):`);
  for (const failure of failures) {
    console.log(`  ${failure.code.padEnd(11)} ${failure.name}  ${failure.reason.slice(0, 60)}`);
  }
  console.log('');
}

console.log('Caveat: pooling every trading day across a group measures where the group has');
console.log('traded, which includes bubbles and crises. It is a sanity check on the defaults,');
console.log('not a valuation model, and it cannot distinguish a permanently re-rated business');
console.log('from a temporarily depressed one.');
