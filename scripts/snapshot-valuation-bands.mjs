#!/usr/bin/env node
/**
 * Capture a valuation-band snapshot and diff it against the previous one.
 *
 * This is the P3-1 step: make "the band moved" a first-class, attributable
 * event rather than an observation someone re-derives by hand each morning.
 *
 * Read-only with respect to the universe.  It never writes a price, and the
 * snapshot it stores contains multiples and statement anchors only.
 *
 * Usage:
 *   node scripts/snapshot-valuation-bands.mjs                    # capture + diff
 *   node scripts/snapshot-valuation-bands.mjs --dry-run          # diff without writing
 *   node scripts/snapshot-valuation-bands.mjs --codes=300308.SZ,NVDA.US
 *   node scripts/snapshot-valuation-bands.mjs --base-url http://127.0.0.1:8000
 *
 * Snapshots live under `reports/valuation-bands/` (git-ignored), because they are
 * observations over time rather than source data.  The diff summary is what a
 * daily review quotes.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffBandSnapshots, snapshotFromReadModel } from '../src/modules/research/domain/valuation-band-review.ts';

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
  console.log('Usage: node scripts/snapshot-valuation-bands.mjs [--dry-run] [--codes=A,B] [--base-url URL] [--only-changed]');
  process.exit(0);
}

const baseUrl = option('--base-url', 'http://127.0.0.1:8000').replace(/\/+$/, '');
const dryRun = flag('--dry-run');
const snapshotDir = resolve(root, 'reports/valuation-bands');
const concurrency = Number(option('--concurrency', 4));

const universe = JSON.parse(readFileSync(resolve(root, 'config/investment-universe.json'), 'utf8'));
const onlyCodes = option('--codes', '')
  .split(',')
  .map((item) => item.trim().toUpperCase())
  .filter(Boolean);
const only = onlyCodes.length ? new Set(onlyCodes) : null;

/**
 * The band endpoint takes a normalized code; the watchlist stores US symbols
 * bare.  Both spellings name one listing, so normalize once here rather than
 * letting 15 US companies silently drop out of the snapshot.
 */
const apiCodeFor = (security) => {
  if (security.market === 'US') return security.ticker.endsWith('.US') ? security.ticker : `${security.ticker}.US`;
  return security.ticker;
};

const targets = universe.companies
  .filter((company) => company.classificationStatus === 'verified')
  .map((company) => {
    const security = company.securities.find((item) => item.ticker === company.preferredTicker) ?? company.securities[0];
    return { companyId: company.id, name: company.displayName, code: apiCodeFor(security), ticker: security.ticker, market: security.market };
  })
  .filter((target) => !only || only.has(target.code.toUpperCase()) || only.has(target.ticker.toUpperCase()));

if (targets.length === 0) {
  console.error('No verified companies matched; nothing to snapshot.');
  process.exit(1);
}

const failures = [];
let cursor = 0;
async function worker() {
  while (cursor < targets.length) {
    const target = targets[cursor++];
    try {
      const response = await fetch(`${baseUrl}/api/finance/valuation-bands?code=${encodeURIComponent(target.code)}`, {
        signal: AbortSignal.timeout(180000),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.code !== 200 || !body?.data) {
        failures.push({ code: target.code, reason: body?.msg || `HTTP ${response.status}` });
        continue;
      }
      target.readModel = body.data;
    } catch (error) {
      failures.push({ code: target.code, reason: error instanceof Error ? error.message : String(error) });
    }
  }
}
await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, targets.length)) }, worker));

const captured = targets
  .filter((target) => target.readModel)
  .map((target) => snapshotFromReadModel(target.readModel, target.companyId));

const today = new Date().toISOString().slice(0, 10);
const snapshot = { asOf: today, capturedAt: new Date().toISOString(), companies: captured };

function previousSnapshot() {
  if (!existsSync(snapshotDir)) return null;
  const files = readdirSync(snapshotDir).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort();
  // Today's own capture is not a comparison point; look strictly earlier.
  const earlier = files.filter((name) => name.slice(0, 10) < today);
  if (earlier.length === 0) return null;
  return JSON.parse(readFileSync(resolve(snapshotDir, earlier.at(-1)), 'utf8'));
}

const previous = previousSnapshot();
const diff = previous ? diffBandSnapshots(previous, snapshot) : null;

const report = {
  mode: dryRun ? 'dry-run' : 'write',
  asOf: today,
  comparedAgainst: previous?.asOf ?? null,
  capturedCompanies: captured.length,
  unavailableBands: captured
    .map((company) => {
      const available = company.bands.filter((band) => band.status === 'available').map((band) => band.key);
      const blocked = company.bands.filter((band) => band.status === 'insufficient_data');
      return {
        companyId: company.companyId,
        code: company.code,
        archetype: company.archetype,
        available,
        forbidden: company.bands.filter((band) => band.status === 'forbidden_for_archetype').map((band) => band.key),
        // Why the bands are empty, not just that they are.  `分母` means the
        // statements are missing; `市值` alone means only the quote is missing,
        // which is a provider problem and must not read as "no valuation".
        blocking: [...new Set(blocked.flatMap((band) => band.missingInputs))].slice(0, 6),
        statementMissing: blocked.some((band) => band.missingInputs.some((item) => item.includes('分母'))),
      };
    })
    .filter((company) => company.available.length === 0),
  diff: diff ? {
    from: diff.from,
    to: diff.to,
    compared: diff.compared,
    unchanged: diff.unchanged.length,
    added: diff.added,
    removed: diff.removed,
    byAttribution: diff.changes.reduce((acc, change) => {
      acc[change.attribution] = (acc[change.attribution] ?? 0) + 1;
      return acc;
    }, {}),
    byKind: diff.changes.reduce((acc, change) => {
      acc[change.kind] = (acc[change.kind] ?? 0) + 1;
      return acc;
    }, {}),
    // Attribution is the point of the diff: a `model` change is our edit, a
    // `filing` change is the company's.  Printing them in one list invites the
    // reader to treat our parameter tweak as news.
    changes: diff.changes,
  } : null,
  failures,
};

if (!dryRun) {
  mkdirSync(snapshotDir, { recursive: true });
  writeFileSync(resolve(snapshotDir, `${today}.json`), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
}

if (flag('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const lines = [
    `Valuation band snapshot (${report.mode}): ${today}`,
    previous ? `Compared against ${report.comparedAgainst}: ${diff.compared} companies, ${diff.unchanged.length} unchanged, ${diff.changes.length} band changes` : 'No earlier snapshot: baseline captured, nothing to compare',
    `Captured ${captured.length} companies; ${failures.length} failed`,
  ];
  if (diff && diff.changes.length) {
    lines.push('', 'Changes by attribution:');
    for (const [attribution, count] of Object.entries(report.diff.byAttribution)) {
      lines.push(`  ${attribution.padEnd(14)} ${count}`);
    }
    lines.push('', 'Details:');
    for (const change of diff.changes.slice(0, 40)) {
      lines.push(`  [${change.attribution}] ${change.code} ${change.band}: ${change.from} → ${change.to}`);
      lines.push(`      ${change.note}`);
    }
    if (diff.changes.length > 40) lines.push(`  ... ${diff.changes.length - 40} more`);
  }
  if (report.unavailableBands.length) {
    const statementsMissing = report.unavailableBands.filter((company) => company.statementMissing);
    const quoteOnly = report.unavailableBands.filter((company) => !company.statementMissing);
    lines.push('', `No available band (${report.unavailableBands.length}): ${statementsMissing.length} missing statements, ${quoteOnly.length} missing quote only`);
    for (const company of report.unavailableBands.slice(0, 20)) {
      lines.push(`  ${company.code} (${company.archetype}) ${company.statementMissing ? '缺财报' : '仅缺行情'}: ${company.blocking.join('、')}`);
    }
    if (report.unavailableBands.length > 20) lines.push(`  ... ${report.unavailableBands.length - 20} more`);
  }
  if (failures.length) {
    lines.push('', 'Failed:');
    for (const failure of failures.slice(0, 20)) lines.push(`  ${failure.code}: ${failure.reason}`);
    if (failures.length > 20) lines.push(`  ... ${failures.length - 20} more`);
  }
  console.log(lines.join('\n'));
}
