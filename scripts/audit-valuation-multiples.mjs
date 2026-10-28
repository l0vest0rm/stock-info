#!/usr/bin/env node
/**
 * Record which watchlist companies currently have a computable valuation
 * multiple, and why the others do not.
 *
 * Read-only.  Requires a running API (`./start-local.sh`).
 *
 * Usage:
 *   node scripts/audit-valuation-multiples.mjs --base-url http://127.0.0.1:8000
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const baseUrl = option("--base-url", "http://127.0.0.1:8000").replace(/\/$/, "");
const concurrency = Number(option("--concurrency", "4"));

const universe = JSON.parse(await readFile(path.join(repositoryRoot, "config/investment-universe.json"), "utf8"));
const targets = universe.companies
  .filter((company) => typeof company.preferredTicker === "string")
  .map((company) => ({
    id: company.id,
    name: company.displayName,
    code: company.preferredTicker,
    archetype: company.valuationArchetype ?? null,
  }));

const results = [];
let cursor = 0;

async function worker() {
  while (cursor < targets.length) {
    const target = targets[cursor++];
    const record = { ...target, peTtm: null, psTtm: null, pb: null, pcfTtm: null, marketCapYi: null, status: "ok", reason: null };
    try {
      const response = await fetch(`${baseUrl}/api/company/overview?code=${encodeURIComponent(target.code)}`);
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body?.data) {
        record.status = "error";
        record.reason = typeof body?.msg === "string" ? body.msg : `HTTP ${response.status}`;
        results.push(record);
        continue;
      }
      const data = body.data;
      record.peTtm = finite(data.peTtm);
      record.psTtm = finite(data.psTtm);
      record.pb = finite(data.pb);
      record.pcfTtm = finite(data.pcfTtm);
      record.marketCapYi = finite(data.marketCapYi);
      if (record.marketCapYi === null) {
        record.status = "missing_price";
        record.reason = "无价格/市值，无法计算倍数";
      } else if (record.peTtm === null) {
        record.status = "missing_earnings";
        record.reason = "有市值但 PE(TTM) 为空（TTM 净利缺失或为负）";
      }
    } catch (error) {
      record.status = "error";
      record.reason = error instanceof Error ? error.message : String(error);
    }
    results.push(record);
  }
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));

const summary = {
  baseUrl,
  checked: results.length,
  withPe: results.filter((item) => item.peTtm !== null).length,
  withPb: results.filter((item) => item.pb !== null).length,
  withPrice: results.filter((item) => item.marketCapYi !== null).length,
  missingPrice: results.filter((item) => item.status === "missing_price").map((item) => item.code),
  missingEarnings: results.filter((item) => item.status === "missing_earnings").map((item) => item.code),
  errors: results.filter((item) => item.status === "error").map((item) => ({ code: item.code, reason: item.reason })),
  valuation: results
    .filter((item) => item.peTtm !== null || item.pb !== null)
    .map((item) => ({ code: item.code, name: item.name, archetype: item.archetype, peTtm: item.peTtm, psTtm: item.psTtm, pb: item.pb })),
};

console.log(JSON.stringify(summary, null, 2));
