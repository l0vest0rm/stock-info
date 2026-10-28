#!/usr/bin/env node
/**
 * One-shot local maintenance: drop A-share income snapshots that predate the
 * cumulative `*INCOME` family.
 *
 * Why this exists
 * ---------------
 * `fetchEastmoneyFinance` used to keep only the annual `*INCOME` row and
 * discard 一季报/中报/三季报, so caches written before that fix hold only
 * `*INCOMEQC` single-quarter rows.  The loader now refreshes those on demand,
 * but every refresh costs a provider round-trip; scanning once is cheaper and
 * makes the local cache honest.
 *
 * Only `income` snapshots are touched.  Balance and cash-flow snapshots are
 * left alone because their contract did not change.
 *
 * Usage:
 *   node scripts/repair-income-snapshots.mjs            # dry run, prints counts
 *   node scripts/repair-income-snapshots.mjs --delete    # actually remove files
 *   node scripts/repair-income-snapshots.mjs --delete --dir <path>
 */
import { readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CUMULATIVE_CONTRACTS = new Set(["eastmoney_f10_income.v1", "eastmoney_f10_annual_income.v1"]);

const args = process.argv.slice(2);
const deleteEnabled = args.includes("--delete");
const dirArgIndex = args.indexOf("--dir");
const incomeDir = path.resolve(
  dirArgIndex >= 0 && args[dirArgIndex + 1]
    ? args[dirArgIndex + 1]
    : path.join(repositoryRoot, "data/local/market-data/financial-statements/income"),
);

const report = {
  directory: incomeDir,
  mode: deleteEnabled ? "delete" : "dry_run",
  scanned: 0,
  isCnAware: 0,
  hasCumulative: 0,
  missingCumulative: 0,
  missingAnnual: 0,
  unreadable: 0,
  deleted: 0,
  removedCodes: [],
  unreadableFiles: [],
  skippedNonCn: [],
};

let entries;
try {
  entries = await readdir(incomeDir);
} catch (error) {
  console.error(`income 快照目录不可读：${incomeDir}（${error instanceof Error ? error.message : String(error)}）`);
  process.exit(1);
}

for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
  report.scanned += 1;
  const file = path.join(incomeDir, entry);
  const code = entry.slice(0, -".json".length);
  if (!/\.(SH|SZ|BJ)$/.test(code)) {
    report.skippedNonCn.push(code);
    continue;
  }
  report.isCnAware += 1;
  let snapshot;
  try {
    snapshot = JSON.parse(await readFile(file, "utf8"));
  } catch {
    report.unreadable += 1;
    report.unreadableFiles.push(entry);
    continue;
  }
  const rows = Array.isArray(snapshot?.rows) ? snapshot.rows : [];
  const contracts = new Set(rows.map((row) => (row?.payload && typeof row.payload === "object" ? row.payload.FINANCIAL_SOURCE_CONTRACT : undefined)));
  const hasCumulative = [...contracts].some((contract) => CUMULATIVE_CONTRACTS.has(contract));
  const hasAnnual = contracts.has("eastmoney_f10_annual_income.v1");
  if (hasCumulative) report.hasCumulative += 1;
  else report.missingCumulative += 1;
  if (!hasAnnual) report.missingAnnual += 1;
  if (hasCumulative) continue;
  if (deleteEnabled) {
    await unlink(file);
    report.deleted += 1;
  }
  if (report.removedCodes.length < 20) report.removedCodes.push(code);
}

console.log(JSON.stringify({
  ...report,
  note: deleteEnabled
    ? "已删除缺累计家族的 A 股 income 快照；下次请求会从东财重新拉取累计 + 单季度两个家族。"
    : "仅统计，未删除任何文件；加 --delete 才真正清理。",
}, null, 2));
