#!/usr/bin/env node
// Validate the investment research universe: schema, identity, references, counts.
// This does not validate fundamentals, listings, valuation, or monitoring status.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
for (const arg of args) assert(['--check-source', '--json', '--help'].includes(arg), 'Unknown option: ' + arg);
if (args.has('--help')) {
  console.log('Usage: node scripts/validate-investment-universe.mjs [--check-source] [--json]');
  process.exit(0);
}
const data = JSON.parse(readFileSync(resolve(root, 'config/investment-universe.json'), 'utf8'));
const nonempty = (x, label) => assert(typeof x === 'string' && x.trim(), 'Missing ' + label);
const list = (x, label) => assert(Array.isArray(x), 'Expected array: ' + label);
const unique = (x, label) => assert.equal(new Set(x).size, x.length, 'Duplicate ' + label);
const dateOrNull = (x, label) => assert(x === null || (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x)), 'Bad date: ' + label);

assert.equal(data.schemaVersion, 1);
nonempty(data.universeId, 'universeId');
nonempty(data.sourceDocument, 'sourceDocument');
dateOrNull(data.asOf, 'asOf');
assert.equal(data.scope.companyIdentity, 'operating_company_not_security');
assert.equal(data.scope.automaticMonitoringEnabled, false, 'Static watchlist must not claim automatic monitoring');
assert.equal(data.scope.privateHoldingsIncluded, false, 'Personal holdings must not be mixed into the research universe');
assert(Number.isInteger(data.scope.watchlistLimit) && data.scope.watchlistLimit > 0 && data.scope.watchlistLimit <= 100);
for (const key of ['sectors', 'tracks', 'companies']) list(data[key], key);
assert(data.companies.length <= data.scope.watchlistLimit, 'Watchlist limit exceeded');
unique(data.sectors.map(s => s.id), 'sector IDs');
unique(data.tracks.map(t => t.id), 'track IDs');
unique(data.companies.map(c => c.id), 'company IDs');
unique(data.companies.map(c => c.displayName), 'company names');

const sectors = new Map(data.sectors.map(s => [s.id, s]));
const tracks = new Map(data.tracks.map(t => [t.id, t]));
let seats = 0, weight = 0;
for (const s of data.sectors) {
  assert(/^[A-Z]{2,5}$/.test(s.id), 'Invalid sector ID: ' + s.id);
  nonempty(s.name, 'sector name');
  nonempty(s.description, 'sector description');
  assert(s.portfolioIllustration, 'Missing allocation: ' + s.id);
  const alloc = s.portfolioIllustration;
  assert(Number.isInteger(alloc.targetSlots) && alloc.targetSlots >= 0, 'Bad slots: ' + s.id);
  assert(typeof alloc.targetEquityWeightPct === 'number' && alloc.targetEquityWeightPct >= 0 && alloc.targetEquityWeightPct <= 100, 'Bad weight: ' + s.id);
  nonempty(alloc.selectionNote, 'selection note');
  seats += alloc.targetSlots;
  weight += alloc.targetEquityWeightPct;
}
assert.equal(seats, data.scope.targetHoldings.illustrative, 'Seat allocation mismatch');
assert.equal(weight, 100, 'Equity weights must total 100%');
assert(Number.isInteger(data.scope.targetHoldings.min) && Number.isInteger(data.scope.targetHoldings.max));
assert(data.scope.targetHoldings.min <= seats && seats <= data.scope.targetHoldings.max);
for (const t of data.tracks) {
  assert(/^[A-Z]{2,5}-\d{2}$/.test(t.id), 'Invalid track ID: ' + t.id);
  assert(sectors.has(t.sectorId), 'Missing sector for ' + t.id);
  assert(t.id.startsWith(t.sectorId + '-'), 'Track prefix mismatch: ' + t.id);
  nonempty(t.name, 'track name');
  nonempty(t.researchFocus, 'track researchFocus');
  nonempty(t.risksToReview, 'track risksToReview');
}

const symbols = [];
for (const c of data.companies) {
  assert(/^co-\d{4,}$/.test(c.id), 'Invalid company ID: ' + c.id);
  nonempty(c.displayName, 'displayName');
  const track = tracks.get(c.primaryTrackId);
  assert(track, 'Missing track for ' + c.id);
  assert.equal(c.primarySectorId, track.sectorId, 'Industry mismatch for ' + c.id);
  nonempty(c.positioning, 'positioning');
  assert(['proposed','verified'].includes(c.classificationStatus), 'Unknown classification status for ' + c.id);
  assert(['research','priority','paused','excluded'].includes(c.watchStatus), 'Unknown watch status for ' + c.id);
  assert(['L0','L1','L2','L3'].includes(c.researchPriority), 'Unknown research priority for ' + c.id);
  for (const key of ['securities','themeTags','factorExposures','evidenceRefs']) {
    list(c[key], c.id + '.' + key);
    if (key !== 'securities') {
      unique(c[key], c.id + '.' + key);
      for (const value of c[key]) nonempty(value, c.id + '.' + key);
    }
  }
  assert(c.securities.length >= 1, 'No listed securities: ' + c.id);
  assert(['CN','US','HK'].includes(c.preferredMarket), 'Preferred market missing: ' + c.id);
  nonempty(c.preferredTicker, 'preferredTicker for ' + c.id);
  assert(c.securities.some(sec => sec.ticker === c.preferredTicker && sec.market === c.preferredMarket), 'Preferred ticker not listed on ' + c.id);
  if (c.securities.some(sec => sec.market === 'CN')) assert.equal(c.preferredMarket, 'CN', 'A-share company must be A-share first: ' + c.id);
  dateOrNull(c.lastEvidenceDate, c.id + '.lastEvidenceDate');
  dateOrNull(c.valuationAsOf, c.id + '.valuationAsOf');
  if (c.classificationStatus === 'verified') assert(c.evidenceRefs.length > 0 && c.lastEvidenceDate, 'Evidence required: ' + c.id);
  for (const sec of c.securities) {
    nonempty(sec.ticker, c.id + ' ticker');
    nonempty(sec.sourceCode, c.id + ' source code');
    assert(['CN','HK','US','KR'].includes(sec.market), 'Market unknown: ' + sec.ticker);
    assert(['A_share','ADR','unverified'].includes(sec.securityType), 'Security type unknown: ' + sec.ticker);
    assert.equal(typeof sec.identityVerified, 'boolean', 'Identity status missing: ' + sec.ticker);
    if (sec.market === 'CN') {
      assert(/^\d{6}\.(SH|SZ)$/.test(sec.ticker), 'Bad Chinese symbol: ' + sec.ticker);
      assert.equal(sec.exchange, sec.ticker.endsWith('.SH') ? 'SSE' : 'SZSE');
      assert.equal(sec.securityType, 'A_share');
    } else if (sec.market === 'HK') {
      assert(/^\d{5}\.HK$/.test(sec.ticker), 'Bad HK symbol: ' + sec.ticker);
      assert.equal(sec.exchange, 'HKEX');
    } else if (sec.market === 'KR') {
      assert(/^\d{6}\.KS$/.test(sec.ticker), 'Bad Korean symbol: ' + sec.ticker);
      assert.equal(sec.exchange, 'KRX');
    } else {
      assert(/^[A-Z]{1,8}$/.test(sec.ticker), 'Bad US symbol: ' + sec.ticker);
    }
    symbols.push(sec.market + ':' + sec.ticker);
  }
}
unique(symbols, 'security symbols');
for (const t of data.tracks) assert(data.companies.some(c => c.primaryTrackId === t.id), 'Empty track: ' + t.id);
const counts = {sectors: data.sectors.length, tracks: data.tracks.length, companies: data.companies.length, securities: symbols.length};
assert.deepEqual(counts, data.scope.baselineCounts, 'Counts changed: review and update baselineCounts');
const guardrails = data.strategyPreferences?.universeGuardrails;
assert.equal(data.strategyPreferences?.universeFocus, 'A_share_first');
assert.equal(data.strategyPreferences?.noAutomaticTrading, true);
assert(guardrails && typeof guardrails === 'object','Missing market guardrails');
const marketCounts = Object.fromEntries(['CN','US','HK'].map(m => [m, data.companies.filter(c => c.preferredMarket === m).length]));
assert(marketCounts.CN >= guardrails.minimumAshareCompanies, 'A-share majority too small');
assert(marketCounts.US <= guardrails.maximumUSPreferredCompanies, 'Too many US-only preferred companies');
assert(marketCounts.HK <= guardrails.maximumHKPreferredCompanies, 'Too many HK-only preferred companies');
assert(counts.companies <= guardrails.maximumObservedCompanies, 'Too many watched companies');
const allocation = data.strategyPreferences.illustrative25HoldingSlots;
assert.equal(allocation.CN + allocation.US + allocation.HK, data.scope.targetHoldings.illustrative, 'Preferred holding slots do not add up');
const equityAlloc = data.strategyPreferences.illustrativeEquityAllocationPct;
assert.equal(equityAlloc.CN + equityAlloc.US + equityAlloc.HK, 100, 'Preferred equity weights do not add up');
const retired = JSON.parse(readFileSync(resolve(root, 'docs/archive/investment-universe-deferred-2026-10-27.json'), 'utf8'));
assert.equal(retired.notPartOfDailyCoverage, true);
const retiredIds = retired.retiredCandidates.map(c => c.id);
unique(retiredIds, 'archived company IDs');
for (const id of retiredIds) assert(!data.companies.some(c => c.id === id), 'Retired company ID reused: ' + id);

const checkHistoricalSource = args.has('--check-source') && data.scope.sourceSnapshotMatchExpected !== false;
if (checkHistoricalSource) {
  // Migration-only check. The Markdown is the frozen initial snapshot.
  const md = readFileSync(resolve(root, data.sourceDocument), 'utf8');
  const rows = md.split('\n').filter(line => /^\| (IT|COM|CD|CS|HC|FIN|IND|MAT|EN|UTIL|RE)-\d+ \|/.test(line));
  assert.equal(rows.length, data.tracks.length, 'Track count differs from Markdown');
  const byName = new Map(data.companies.map(c => [c.displayName, c]));
  let sourced = 0;
  for (const row of rows) {
    const [id, label, field, focus, risk] = row.split('|').slice(1,-1).map(s => s.trim());
    const t = tracks.get(id);
    assert(t, 'Track absent: ' + id);
    assert.equal(t.name, label.replace(/^\*\*|\*\*$/g, ''));
    assert.equal(t.researchFocus, focus);
    assert.equal(t.risksToReview, risk);
    for (const item of field.split('；')) {
      const parts = item.split(String.fromCharCode(96));
      assert.equal(parts.length, 3, 'Cannot parse company in Markdown: ' + item);
      const name = parts[0].trim().replace(/^\*\*|\*\*$/g, '');
      const codes = parts[1].split(' / ');
      const positioning = parts[2].trim().replace(/^（|）$/g, '');
      const c = byName.get(name);
      assert(c, 'Company absent: ' + name);
      assert.equal(c.primaryTrackId, id, 'Company track mismatch: ' + name);
      assert.equal(c.positioning, positioning, 'Company positioning mismatch: ' + name);
      assert.deepEqual(c.securities.map(s => s.sourceCode), codes, 'Company securities mismatch: ' + name);
      sourced++;
    }
  }
  assert.equal(sourced, data.companies.length, 'Company count differs from snapshot');
}
const output = {valid:true, universeId:data.universeId, counts, marketCounts, watchlistLimit:data.scope.watchlistLimit, sourceChecked:checkHistoricalSource, sourceCheckSkipped:args.has('--check-source') && !checkHistoricalSource};
console.log(args.has('--json')
  ? JSON.stringify(output, null, 2)
  : 'VALID: ' + counts.sectors + ' sectors, ' + counts.tracks + ' tracks, ' + counts.companies + ' companies, ' + counts.securities + ' securities. A-share-first: ' + JSON.stringify(marketCounts) + (checkHistoricalSource ? ' Original Markdown matches.' : args.has('--check-source') ? ' Historical source mismatch expected; source check skipped.' : ''));
