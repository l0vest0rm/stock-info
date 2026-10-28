#!/usr/bin/env node
// Collect primary evidence for the whole watchlist and write it into
// config/investment-universe.json.
//
// Usage (local Node API must be running):
//   node scripts/collect-universe-evidence.mjs [--dry-run] [--only=600036.SH,00981.HK]
//
// What it writes, per company:
//   evidenceRefs      structured primary records, one per periodic filing found
//   lastEvidenceDate  newest record date (also derived by the valuation sync)
//   securities[].identityVerified  true only when that security has its own
//                     primary filing; an A-share filing never verifies the
//                     H-share line.
//
// What it refuses to do:
//   - invent a record when a registry returns nothing (the security stays
//     unverified and the failure code is printed);
//   - mark a company verified because a sibling listing was verified;
//   - keep stale records that the registry no longer returns.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const onlyArg = args.find((arg) => arg.startsWith('--only='));
const only = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',').map((item) => item.trim().toUpperCase()).filter(Boolean)) : null;
const baseUrl = String(process.env.API_BASE_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '');
// CNINFO rate-limits per interface, so a wide fan-out fails most of the pool
// with 403 rather than collecting it.  One at a time is slow but converges; the
// server caches each answer for 30 minutes, so a re-run is cheap.
const concurrency = Number(process.env.EVIDENCE_CONCURRENCY || 1);

// The watchlist exists once.  `web/src/config/investment-universe.json` is the
// page's own config (title, canonical path), not a copy of the companies.
const paths = [resolve(root, 'config/investment-universe.json')];

async function fetchEvidence(ticker, attempt = 1) {
  const response = await fetch(`${baseUrl}/api/research/evidence/${encodeURIComponent(ticker)}`, {
    signal: AbortSignal.timeout(180000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.code !== 200) {
    return { security: ticker, status: 'request_failed', failure: body?.msg || `HTTP ${response.status}`, records: [], identityVerified: false };
  }
  // CNINFO answers 403 intermittently under load and that is not a property of
  // the security, so a rejected upstream read is retried with backoff instead of
  // being recorded as "this company has no filings".
  const rejected = body.data?.status === 'source_failed' && /status=403/.test(String(body.data?.failure ?? ''));
  if (rejected && attempt < 4) {
    await new Promise((resolve) => setTimeout(resolve, 5000 * attempt));
    return fetchEvidence(ticker, attempt + 1);
  }
  return body.data;
}

/** Security codes the evidence endpoint can answer for. */
function evidenceCodeFor(security) {
  if (security.market === 'US') return security.ticker.endsWith('.US') ? security.ticker : `${security.ticker}.US`;
  if (security.market === 'CN' || security.market === 'HK') return security.ticker;
  return null; // KR has no integrated primary registry; stays unverified.
}

const universe = JSON.parse(readFileSync(paths[0], 'utf8'));
const queue = [];
for (const company of universe.companies) {
  for (const security of company.securities) {
    const code = evidenceCodeFor(security);
    if (!code) continue;
    if (only && !only.has(code) && !only.has(security.ticker)) continue;
    queue.push({ companyId: company.id, ticker: security.ticker, code });
  }
}

const results = new Map();
let cursor = 0;
async function worker() {
  while (cursor < queue.length) {
    const item = queue[cursor++];
    try {
      results.set(item.code, await fetchEvidence(item.code));
    } catch (error) {
      results.set(item.code, { security: item.code, status: 'request_failed', failure: String(error).slice(0, 160), records: [], identityVerified: false });
    }
  }
}
await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker));

const stats = { collected: 0, no_documents: 0, unsupported: 0, source_failed: 0, request_failed: 0, records: 0, verifiedSecurities: 0, companiesVerified: 0 };
const failures = [];

for (const [pathIndex, universePath] of paths.entries()) {
  const data = JSON.parse(readFileSync(universePath, 'utf8'));
  for (const company of data.companies) {
    const records = [];
    for (const security of company.securities) {
      const code = evidenceCodeFor(security);
      const result = code ? results.get(code) : null;
      if (!result) {
        security.identityVerified = false;
        continue;
      }
      if (pathIndex === 0) {
        // Only count once, from the canonical file.
        stats[result.status] = (stats[result.status] ?? 0) + 1;
        if (result.status !== 'collected') failures.push(`${security.ticker} ${result.status}${result.failure ? ` (${result.failure})` : ''}`);
      }
      // The record must name the security the universe lists.  The endpoint
      // answers in normalized codes (`NVDA.US`), while the universe stores the
      // exchange-native symbol (`NVDA`) and its validator rejects the suffixed
      // form, so the record is re-bound to the listed symbol before it is kept.
      const valid = (result.records || [])
        .filter((record) => record.security === code || record.security === security.ticker)
        .map((record) => ({ ...record, security: security.ticker }));
      records.push(...valid);
      const verified = valid.length > 0 && result.identityVerified === true;
      security.identityVerified = verified;
      if (pathIndex === 0 && verified) stats.verifiedSecurities += 1;
    }
    // Newest first, de-duplicated by (source, security, documentId).
    const seen = new Set();
    company.evidenceRefs = records
      .filter((record) => {
        const key = `${record.source}|${record.security}|${record.documentId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt))
      // Keep the minimum defensible set: the latest periodic report per listed
      // security.  The registry answers each report category with its whole
      // history, so keeping every page would store thousands of documents per
      // company to support the same single claim.
      .filter((record, index, all) => all.findIndex((other) => other.security === record.security) === index);
    company.lastEvidenceDate = company.evidenceRefs.map((record) => record.publishedAt).sort().at(-1) ?? null;
    // A company is only "verified" when every listed security has its own
    // primary filing; one blank H-share line keeps it `proposed`.
    const allVerified = company.securities.every((security) => security.identityVerified);
    company.classificationStatus = allVerified ? 'verified' : 'proposed';
    if (pathIndex === 0) {
      stats.records += company.evidenceRefs.length;
      if (allVerified) stats.companiesVerified += 1;
    }
  }
  if (!dryRun) writeFileSync(universePath, JSON.stringify(data, null, 2) + '\n');
}

console.log(JSON.stringify({
  mode: dryRun ? 'dry-run' : 'write',
  securitiesChecked: queue.length,
  ...stats,
  failures: failures.slice(0, 40),
}, null, 2));
