#!/usr/bin/env node
// Offline check of the watchlist evidence rules in scripts/validate-investment-universe.mjs.
//
// The validator only ever sees a file that already passed, so a rule that is
// silently impossible to violate looks exactly like a rule that works. This
// writes a mutated copy of the real universe, runs the validator, and asserts
// the mutation is rejected (or accepted, for the control case).
//
// The validator reads `config/investment-universe.json`, so the real file is
// swapped out and restored in a `finally` block.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'config/investment-universe.json');
const validator = join(root, 'scripts/validate-investment-universe.mjs');
const original = readFileSync(source, 'utf8');
const baseline = JSON.parse(original);

function run(mutate) {
  const data = structuredClone(baseline);
  mutate(data);
  writeFileSync(source, JSON.stringify(data, null, 2) + '\n');
  try {
    execFileSync(process.execPath, [validator], { cwd: root, stdio: 'pipe' });
    return { accepted: true, message: '' };
  } catch (error) {
    const text = String(error.stderr || error.stdout || '');
    return { accepted: false, message: text.split('\n').find((line) => /Error/.test(line)) ?? '' };
  } finally {
    writeFileSync(source, original);
  }
}

const filing = (security, overrides = {}) => ({
  source: 'cninfo_filing',
  kind: 'primary',
  security,
  documentId: '1225530237',
  title: '招商银行 2026 年半年度报告',
  publishedAt: '2026-08-29',
  url: 'https://static.cninfo.com.cn/finalpage/2026-08-29/1225530237.PDF',
  ...overrides,
});
const singleAShare = (data) => data.companies.find((c) => c.securities.length === 1 && c.securities[0].market === 'CN');
const aPlusH = (data) => data.companies.find((c) => c.securities.some((s) => s.market === 'CN') && c.securities.some((s) => s.market === 'HK'));

const cases = [
  ['control: valid filing on its own security', true, (data) => {
    const company = singleAShare(data);
    company.evidenceRefs = [filing(company.securities[0].ticker)];
    company.lastEvidenceDate = '2026-08-29';
  }],
  ['secondary (news) source refused', false, (data) => {
    const company = singleAShare(data);
    company.evidenceRefs = [filing(company.securities[0].ticker, { source: 'issuer_ir', kind: 'secondary' })];
    company.lastEvidenceDate = '2026-08-29';
  }],
  ['lastEvidenceDate must equal newest record', false, (data) => {
    const company = singleAShare(data);
    company.evidenceRefs = [filing(company.securities[0].ticker)];
    company.lastEvidenceDate = '2026-10-01';
  }],
  ['record naming an unlisted ticker refused', false, (data) => {
    const company = singleAShare(data);
    company.evidenceRefs = [filing('600000.SH')];
    company.lastEvidenceDate = '2026-08-29';
  }],
  ['A-share filing does not verify the H-share line', false, (data) => {
    const company = aPlusH(data);
    const aShare = company.securities.find((s) => s.market === 'CN');
    company.securities.forEach((security) => { security.identityVerified = true; });
    company.classificationStatus = 'verified';
    company.evidenceRefs = [filing(aShare.ticker)];
    company.lastEvidenceDate = '2026-08-29';
  }],
  ['URL host must match the source registry', false, (data) => {
    const company = singleAShare(data);
    company.evidenceRefs = [filing(company.securities[0].ticker, { url: 'https://example.com/fake.pdf' })];
    company.lastEvidenceDate = '2026-08-29';
  }],
];

let failed = 0;
for (const [name, expected, mutate] of cases) {
  const result = run(mutate);
  if (result.accepted !== expected) {
    failed += 1;
    console.error(`FAIL ${name}: expected ${expected ? 'accepted' : 'rejected'}, got ${result.accepted ? 'accepted' : 'rejected'} ${result.message}`);
  } else {
    console.log(`ok   ${name} -> ${expected ? 'accepted' : 'rejected'}`);
  }
}
assert.equal(failed, 0, `${failed} evidence validator cases failed`);
console.log('universe evidence validator: ok');
