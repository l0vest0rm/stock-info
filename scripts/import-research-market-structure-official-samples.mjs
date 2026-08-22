#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const samples = JSON.parse(await readFile(resolve(root, "config/research-market-structure-official-samples.json"), "utf8"));
const baseUrl = new URL(process.env.RESEARCH_SAMPLE_BASE_URL || "http://127.0.0.1:8000");

// These are deliberate local research-ledger samples.  Do not turn this into a
// deployment/production seeder: production remains read-only by contract.
if (!new Set(["127.0.0.1", "localhost", "::1"]).has(baseUrl.hostname)) {
  throw new Error("RESEARCH_SAMPLE_BASE_URL must be a loopback local research runtime");
}

async function request(path, init = {}) {
  const response = await fetch(new URL(path, baseUrl), init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.code !== 200) throw new Error(`${init.method || "GET"} ${path}: ${body.msg || response.status}`);
  return body.data;
}

function alreadyMatchesIdentity(identity, sample) {
  const primary = identity.relationships?.some((item) => item.companyId === sample.companyId && item.relationshipStatus === "confirmed");
  return identity.listedSecurity?.mappingStatus === "confirmed"
    && identity.operatingCompany?.companyId === sample.companyId
    && primary;
}

for (const sample of samples.identities) {
  const identity = await request(`/api/research/company/${encodeURIComponent(sample.code)}/identity`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sample.request),
  });
  if (!alreadyMatchesIdentity(identity, sample)) throw new Error(`${sample.code} identity did not persist as confirmed`);
  console.log(`identity imported/reused: ${sample.code}`);
}

for (const fact of samples.facts) {
  const current = await request(`/api/research/company/${encodeURIComponent(fact.securityCode)}/market-structure`);
  // `latestFacts` is a read-model projection and may deliberately hide a
  // weighted-average EPS denominator behind a qualifying period-end share
  // count.  Idempotent import must inspect the full audit ledger instead.
  const duplicate = current.auditableFacts?.find((item) => item.marketStructureFactId === fact.marketStructureFactId);
  if (duplicate) {
    if (duplicate.sourceUrl !== fact.sourceUrl || duplicate.factKey !== fact.factKey || duplicate.asOf !== fact.asOf || (duplicate.measurementBasis ?? null) !== (fact.measurementBasis ?? null)) {
      throw new Error(`${fact.marketStructureFactId} already exists with different material evidence; inspect it manually rather than overwriting it`);
    }
    console.log(`fact unchanged: ${fact.marketStructureFactId}`);
    continue;
  }
  await request(`/api/research/company/${encodeURIComponent(fact.securityCode)}/market-structure/facts`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(fact),
  });
  console.log(`fact imported: ${fact.marketStructureFactId}`);
}

console.log(`Imported/reused ${samples.identities.length} official identity samples and ${samples.facts.length} official market-structure facts.`);
