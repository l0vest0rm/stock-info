#!/usr/bin/env node
// Materialize the derived valuation archetype and factor exposures into the
// watchlist JSON and its page build copy. Idempotent: safe to re-run.
// Usage: node scripts/sync-investment-universe-valuation.mjs [--check|--write]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildValuationCoverage } from '../src/modules/research/domain/valuation-coverage.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
for (const arg of args) {
  if (!['--check', '--write', '--json', '--help'].includes(arg)) throw new Error('Unknown option: ' + arg);
}
if (args.has('--help')) {
  console.log('Usage: node scripts/sync-investment-universe-valuation.mjs [--check|--write] [--json]');
  process.exit(0);
}
const write = args.has('--write');
// The watchlist exists once.  `web/src/config/investment-universe.json` is the
// page's own config (title, canonical path), not a copy of the companies.
const paths = [resolve(root, 'config/investment-universe.json')];

const coverage = buildValuationCoverage();
const byId = new Map(coverage.companies.map((company) => [company.companyId, company]));
const drift = [];

for (const path of paths) {
  const raw = readFileSync(path, 'utf8');
  const data = JSON.parse(raw);
  let changed = false;
  for (const company of data.companies ?? []) {
    const derived = byId.get(company.id);
    if (!derived) {
      drift.push(`${company.id}: 缺少估值覆盖`);
      continue;
    }
    // Exposures carry weight and direction, not just a factor name: a bare
    // `interest_rate` tag cannot say whether earnings rise or fall with rates,
    // and the pool's rate bucket is precisely where that distinction matters.
    const factors = derived.factors
      .map((item) => ({ factor: item.factor, weight: item.weight, direction: item.direction }))
      .sort((left, right) => left.factor.localeCompare(right.factor));
    const archetype = derived.valuationProfile.archetype;
    const tags = [...new Set([...derived.factors.map((item) => item.label), ...company.themeTags])].sort();
    if (JSON.stringify(company.factorExposures) !== JSON.stringify(factors)) {
      drift.push(`${path.endsWith('web/src/config/investment-universe.json') ? 'web ' : ''}${company.id}.factorExposures`);
      company.factorExposures = factors;
      changed = true;
    }
    if (company.valuationArchetype !== archetype) {
      drift.push(`${path.endsWith('web/src/config/investment-universe.json') ? 'web ' : ''}${company.id}.valuationArchetype`);
      company.valuationArchetype = archetype;
      changed = true;
    }
    // Research tier is derived from archetype difficulty, factor concentration
    // and evidence readiness.  It used to be computed only in the page, which is
    // why the file carried one uniform `L1`/`research` for all 98 companies —
    // identical values are indistinguishable from no tiering at all.
    if (company.researchPriority !== derived.researchTier.priority) {
      drift.push(`${path.endsWith('web/src/config/investment-universe.json') ? 'web ' : ''}${company.id}.researchPriority`);
      company.researchPriority = derived.researchTier.priority;
      changed = true;
    }
    if (company.watchStatus !== derived.researchTier.watchStatus) {
      drift.push(`${path.endsWith('web/src/config/investment-universe.json') ? 'web ' : ''}${company.id}.watchStatus`);
      company.watchStatus = derived.researchTier.watchStatus;
      changed = true;
    }
    if (JSON.stringify(company.researchBasis) !== JSON.stringify(derived.researchTier.basis)) {
      company.researchBasis = derived.researchTier.basis;
      changed = true;
    }
    if (JSON.stringify(company.themeTags) !== JSON.stringify(tags)) {
      company.themeTags = tags;
      changed = true;
    }
    // `lastEvidenceDate` is derived, never typed: it is the newest date among
    // the structured evidence records. Keeping it in sync here is what stops the
    // date from drifting away from the documents that justify it.
    const records = Array.isArray(company.evidenceRefs) ? company.evidenceRefs : [];
    const latestEvidence = records
      .filter((record) => record && record.kind === 'primary' && /^\d{4}-\d{2}-\d{2}$/.test(String(record.publishedAt)))
      .map((record) => record.publishedAt)
      .sort()
      .at(-1) ?? null;
    if (company.lastEvidenceDate !== latestEvidence) {
      drift.push(`${path.endsWith('web/src/config/investment-universe.json') ? 'web ' : ''}${company.id}.lastEvidenceDate`);
      company.lastEvidenceDate = latestEvidence;
      changed = true;
    }
  }
  if (changed && write) {
    writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  }
}

const summary = {
  companies: coverage.companyCount,
  archetypeCounts: coverage.archetypeCounts,
  topFactors: coverage.topFactors.slice(0, 6),
  rateChannels: coverage.rateSensitivity.channels.map((channel) => ({ channel: channel.channel, direction: channel.direction, companies: channel.companies.length })),
  rateUnresolved: coverage.rateSensitivity.unresolved,
  driftItems: new Set(drift).size,
  mode: write ? 'write' : 'check',
};
if (args.has('--json')) {
  console.log(JSON.stringify(summary));
} else {
  console.log(`Valuation coverage sync (${summary.mode}): ${summary.companies} companies, ${summary.driftItems} drifted fields.`);
  console.log('Archetypes: ' + JSON.stringify(summary.archetypeCounts));
  console.log('Top factors: ' + summary.topFactors.map((item) => `${item.label}=${item.companies}`).join(', '));
  console.log('Rate channels: ' + summary.rateChannels.map((item) => `${item.channel}(${item.direction})=${item.companies}`).join(', '));
  if (summary.rateUnresolved.length > 0) console.log('Rate exposure without a channel: ' + summary.rateUnresolved.join(', '));
}
if (!write && drift.length > 0) {
  console.error('Drift detected. Run: npm run sync:investment-universe:valuation');
  process.exit(1);
}
