#!/usr/bin/env node
/**
 * Measure capital intensity (depreciation / EBIT) across the whole watchlist.
 *
 * Why this exists: the P1-3 finding is that EV/EBITDA means opposite things at
 * 0.07× and 5.6×.  A demo on three companies proves the rule exists; this audit
 * proves how many of the 98 it actually changes.  It is the evidence behind the
 * comparability gate, not a new data source.
 *
 * Usage: node scripts/audit-capital-intensity.mjs [--limit N] [--concurrency N]
 * Requires a running local API (./start-local.sh).
 */
import { readFileSync } from "node:fs";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (arg.startsWith("--")) args.set(arg.slice(2), process.argv[index + 1] ?? "");
}
const baseUrl = args.get("base") ?? process.env.STOCK_INFO_API ?? "http://127.0.0.1:8000";
const limit = Number(args.get("limit") ?? 0);
const concurrency = Math.max(1, Number(args.get("concurrency") ?? 4));

const universe = JSON.parse(readFileSync(new URL("../config/investment-universe.json", import.meta.url), "utf8"));
const companies = universe.companies
  .map((company) => ({
    code: company.preferredTicker,
    name: company.displayName,
    archetype: company.valuationArchetype ?? null,
  }))
  .filter((company) => /\.(SH|SZ|BJ)$/.test(company.code));
const targets = limit > 0 ? companies.slice(0, limit) : companies;

const results = [];
let cursor = 0;

async function worker() {
  while (cursor < targets.length) {
    const item = targets[cursor];
    cursor += 1;
    try {
      const response = await fetch(`${baseUrl}/api/finance/valuation-inputs?code=${item.code}`, { signal: AbortSignal.timeout(180_000) });
      const payload = await response.json();
      const lines = payload?.data?.lines ?? [];
      const value = (key) => lines.find((line) => line.key === key)?.value ?? null;
      const ebit = value("ebit");
      const ebitda = value("ebitda");
      const ratio = ebit !== null && ebit > 0 && ebitda !== null ? (ebitda - ebit) / ebit : null;
      const limitations = payload?.data?.limitations ?? [];
      results.push({
        ...item,
        ebit,
        ebitda,
        ratio,
        basis: limitations.find((text) => text.startsWith("折旧摊销口径")) ?? null,
        status: ratio === null ? "unavailable" : "measured",
      });
    } catch (error) {
      results.push({ ...item, ebit: null, ebitda: null, ratio: null, basis: null, status: "error", error: String(error?.message ?? error) });
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));

const classify = (ratio) => {
  if (ratio === null) return "unknown";
  if (ratio < 0.5) return "light";
  if (ratio <= 1) return "medium";
  return "heavy";
};

const byClass = { light: [], medium: [], heavy: [], unknown: [] };
for (const item of results) byClass[classify(item.ratio)].push(item);
for (const group of Object.values(byClass)) group.sort((left, right) => (left.ratio ?? Infinity) - (right.ratio ?? Infinity));

const summary = {
  checked: results.length,
  measured: results.filter((item) => item.status === "measured").length,
  unavailable: results.filter((item) => item.status === "unavailable").length,
  errors: results.filter((item) => item.status === "error").length,
  classes: Object.fromEntries(Object.entries(byClass).map(([key, group]) => [key, group.length])),
};
console.log(JSON.stringify({ summary, byClass }, null, 2));
