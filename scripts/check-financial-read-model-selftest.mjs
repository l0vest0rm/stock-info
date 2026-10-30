// Retained assertion coverage; all domain computations execute in native Rust.
import { callRustSelftest } from './lib/rust-analysis.mjs';
const buildFinancialStatementReadModel = (...args) => callRustSelftest('buildFinancialStatementReadModel', ...args);
/**
 * Deterministic check for the read-model warning contract.
 * Run: node scripts/check-financial-read-model-selftest.mjs
 *
 * `buildFinancialStatementReadModel` is the shared read boundary for every
 * API and research consumer.  When an A-share income snapshot loses one of the
 * two Eastmoney families the row count still looks healthy, so the model must
 * say so explicitly instead of degrading valuation silently.
 *
 * The native bridge runs the production read-model implementation.
 */
import assert from "node:assert/strict";




const row = (reportDate, contract, revenue) => ({
  code: "600036.SH",
  statementType: "income",
  reportDate,
  fiscalPeriod: null,
  payload: {
    dataSource: "financial_report",
    FINANCIAL_SOURCE_CONTRACT: contract,
    OPERATE_INCOME: revenue,
  },
  source: "eastmoney",
  rawR2Key: null,
  updatedAt: 1_700_000_000_000,
});

const build = (rows, { code = "600036.SH", statementType = "income" } = {}) => buildFinancialStatementReadModel({
  code,
  statementType,
  source: "r2",
  rows,
  fresh: true,
});

// Healthy: both families present and the annual statement is explicit.
const healthy = build([
  row("2026-06-30", "eastmoney_f10_income.v1", 178_181_000_000),
  row("2026-06-30", "eastmoney_f10_incomeqc.v1", 91_241_000_000),
  row("2025-12-31", "eastmoney_f10_annual_income.v1", 337_532_000_000),
]);
assert.deepEqual(healthy.warnings, [], "complete snapshot has no warnings");

// Missing cumulative family: the pre-fix cache shape.  TTM becomes
// impossible, so this must be reported rather than silently accepted.
const quarterOnly = build([
  row("2026-06-30", "eastmoney_f10_incomeqc.v1", 91_241_000_000),
  row("2026-03-31", "eastmoney_f10_incomeqc.v1", 86_940_000_000),
]);
const codes = quarterOnly.warnings.map((warning) => warning.code);
assert.ok(codes.includes("missing_cumulative_income_family"), "quarter-only snapshot is flagged");
assert.ok(codes.includes("missing_annual_income_statement"), "no annual row is flagged");
const cumulativeWarning = quarterOnly.warnings.find((warning) => warning.code === "missing_cumulative_income_family");
assert.deepEqual(cumulativeWarning.families, { cumulative: false, annual: false, quarterized: true });
assert.match(cumulativeWarning.message, /\*INCOMEQC/);

// Cumulative present but the fiscal-year-end statement missing: the quarterly
// roll-up exists, yet TTM has no base — still a warning, but a different one.
const noAnnual = build([
  row("2026-06-30", "eastmoney_f10_income.v1", 178_181_000_000),
  row("2026-06-30", "eastmoney_f10_incomeqc.v1", 91_241_000_000),
]);
assert.deepEqual(noAnnual.warnings.map((warning) => warning.code), ["missing_annual_income_statement"]);

// Empty rows: "no data" is reported by sourceHealth, not by family warnings.
const empty = build([]);
assert.deepEqual(empty.warnings, []);
assert.equal(empty.sourceHealth.reason, "no_primary_data");

// Scoping: warnings describe the A-share income contract only.
assert.deepEqual(build([row("2026-06-30", "eastmoney_f10_incomeqc.v1", 1)], { code: "00700.HK" }).warnings, []);
assert.deepEqual(build([row("2026-06-30", "eastmoney_f10_incomeqc.v1", 1)], { statementType: "balance" }).warnings, []);

console.log("financial-read-model self-test: ok", JSON.stringify({
  healthy: healthy.warnings.length,
  quarterOnly: quarterOnly.warnings.map((warning) => warning.code),
}));
