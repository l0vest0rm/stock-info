// Retained assertion coverage; all domain computations execute in native Rust.
import { callRustSelftest } from './lib/rust-analysis.mjs';
const buildValuationInputs = (...args) => callRustSelftest('buildValuationInputs', ...args);
/**
 * Deterministic check for the per-industry valuation-input arithmetic.
 * Run: node scripts/check-valuation-inputs-selftest.mjs (requires a prior
 * `npm run build:rust`; domain arithmetic executes in the native binary).
 */
import assert from "node:assert/strict";


const row = (statementType, reportDate, payload) => ({
  code: "TEST",
  statementType,
  reportDate,
  fiscalPeriod: null,
  payload,
  source: "test",
  rawR2Key: null,
  updatedAt: 0,
});
const none = { latest: null, priorYearSamePeriod: null };

// Depreciation lives in the cash-flow supplement block, not the income
// statement.  FA_IR_DEPR and OILGAS_BIOLOGY_DEPR carry the same figure and must
// not be summed; the amortization lines are additive.
const supplement = (depreciation, ia = 0, lpe = 0, useright = 0) => ({
  FA_IR_DEPR: depreciation,
  OILGAS_BIOLOGY_DEPR: depreciation,
  IA_AMORTIZE: ia,
  LPE_AMORTIZE: lpe,
  USERIGHT_ASSET_AMORTIZE: useright,
});

// 1. Ordinary manufacturer: EBIT strips invest/fair-value income, EBITDA adds D&A.
const manufacturer = buildValuationInputs({
  code: "TEST.SH",
  income: {
    latest: row("income", "2025-12-31", { OPERATE_PROFIT: 100, INVEST_INCOME: 10, FAIRVALUE_CHANGE_INCOME: 5, TOTAL_OPERATE_INCOME: 1000, PARENT_NETPROFIT: 70 }),
    priorYearSamePeriod: row("income", "2024-12-31", { TOTAL_OPERATE_INCOME: 900 }),
  },
  balance: { latest: row("balance", "2025-12-31", { TOTAL_PARENT_EQUITY: 500, SHORT_LOAN: 50, LONG_LOAN: 150, MONETARYFUNDS: 80 }), priorYearSamePeriod: null },
  cashflow: {
    latest: row("cashflow", "2025-12-31", { NETCASH_OPERATE: 120, ...supplement(16, 4) }),
    priorYearSamePeriod: null,
  },
});
const value = (model, key) => model.lines.find((item) => item.key === key)?.value;
assert.equal(value(manufacturer, "ebit"), 85);
assert.equal(value(manufacturer, "ebitda"), 105);
assert.equal(value(manufacturer, "grossDebtDisclosed"), 200);
assert.equal(value(manufacturer, "cashDisclosed"), 80);
assert.equal(manufacturer.enterpriseValueApplicable, true);
assert.equal(manufacturer.evRevenueApplicable, true);
// An absent key means "the issuer has no such line"; only an explicit null is a
// data gap.  Neither is ever treated as zero.
assert.equal(manufacturer.gaps.some((gap) => gap.key === "bondPayable"), false, "absent key is not a gap");
const unsupplied = buildValuationInputs({
  code: "TEST.SH",
  income: { latest: row("income", "2025-12-31", { OPERATE_PROFIT: 100 }), priorYearSamePeriod: null },
  balance: { latest: row("balance", "2025-12-31", { SHORT_LOAN: 50, BOND_PAYABLE: null }), priorYearSamePeriod: null },
  cashflow: none,
});
assert.ok(unsupplied.gaps.some((gap) => gap.key === "bondPayable"), "explicit null is reported as a gap");
assert.equal(value(unsupplied, "grossDebtDisclosed"), 50, "a null line is not counted as debt");
assert.ok(manufacturer.periods.some((item) => item.role === "prior_year_same_period" && item.reportDate === "2024-12-31"));
// 16 固定资产折旧 + 4 无形资产摊销 = 20; OILGAS duplicate is ignored.
assert.equal(value(manufacturer, "depreciationAmortization"), 20);
assert.ok(manufacturer.limitations.some((text) => text.includes("年报补充资料")), "annual basis is stated");

// 2. A bank must never expose EBIT/EBITDA/EV-revenue even if the fields exist.
const bank = buildValuationInputs({
  code: "600036.SH",
  income: { latest: row("income", "2025-12-31", { OPERATE_PROFIT: 100 }), priorYearSamePeriod: null },
  balance: none,
  cashflow: none,
  balanceSheetArchetype: "bank",
});
assert.equal(bank.enterpriseValueApplicable, false);
assert.equal(bank.evRevenueApplicable, false);
assert.equal(bank.revenueArchetype, "bank_net_interest_plus_fee");
assert.equal(value(bank, "ebit"), undefined);
assert.ok(bank.limitations.some((text) => text.includes("资产负债表驱动")));

// 3. Missing statements degrade to gaps instead of throwing.
const empty = buildValuationInputs({ code: "TEST.HK", income: none, balance: none, cashflow: none });
assert.equal(empty.incomeReportDate, null);
assert.ok(empty.gaps.some((gap) => gap.key === "grossDebtDisclosed"));
assert.equal(value(empty, "grossDebtDisclosed"), undefined);

// 4. Missing D&A blocks EBITDA instead of substituting capex.
const noDa = buildValuationInputs({
  code: "TEST.SH",
  income: { latest: row("income", "2025-12-31", { OPERATE_PROFIT: 100 }), priorYearSamePeriod: null },
  balance: none,
  cashflow: none,
});
assert.equal(value(noDa, "ebit"), 100);
assert.equal(value(noDa, "ebitda"), undefined);
assert.ok(noDa.gaps.some((gap) => gap.key === "ebitda"));

// 4. Half-year report: TTM D&A = prior FY + current H1 − prior-year H1.
const halfYear = buildValuationInputs({
  code: "TEST.SH",
  income: { latest: row("income", "2026-06-30", { OPERATE_PROFIT: 100, TOTAL_OPERATE_INCOME: 500 }), priorYearSamePeriod: null },
  balance: none,
  cashflow: {
    latest: row("cashflow", "2026-06-30", { NETCASH_OPERATE: 60, ...supplement(30) }),
    priorYearSamePeriod: row("cashflow", "2025-06-30", { NETCASH_OPERATE: 50, ...supplement(25) }),
    priorFiscalYear: row("cashflow", "2025-12-31", { NETCASH_OPERATE: 100, ...supplement(60) }),
    currentFiscalYearSamePeriod: row("cashflow", "2025-06-30", { NETCASH_OPERATE: 50, ...supplement(25) }),
  },
});
// 60 + 30 − 25 = 65
assert.equal(value(halfYear, "depreciationAmortization"), 65);
assert.equal(value(halfYear, "ebitda"), 100 + 65, "EBITDA = EBIT + TTM D&A");
assert.ok(halfYear.limitations.some((text) => text.includes("上年报 + 本期")), "rolling basis is stated");

// 5. Q3 report: the provider publishes no supplement block, so the prior year
//    end is used AND labelled — never reported as a zero.
const q3 = buildValuationInputs({
  code: "TEST.SH",
  income: { latest: row("income", "2026-09-30", { OPERATE_PROFIT: 100 }), priorYearSamePeriod: null },
  balance: none,
  cashflow: {
    latest: row("cashflow", "2026-09-30", { NETCASH_OPERATE: 90, FA_IR_DEPR: 0, IA_AMORTIZE: 0 }),
    priorYearSamePeriod: row("cashflow", "2025-09-30", { NETCASH_OPERATE: 80 }),
    priorFiscalYear: row("cashflow", "2025-12-31", { NETCASH_OPERATE: 100, ...supplement(60) }),
    currentFiscalYearSamePeriod: row("cashflow", "2025-09-30", { NETCASH_OPERATE: 80 }),
  },
});
assert.equal(value(q3, "depreciationAmortization"), 60, "Q3 falls back to the annual figure");
assert.ok(q3.limitations.some((text) => text.includes("无补充资料")), "fallback is labelled");

// 6. No supplement anywhere: EBITDA stays unavailable rather than zero.
const noDepreciation = buildValuationInputs({
  code: "TEST.SH",
  income: { latest: row("income", "2026-09-30", { OPERATE_PROFIT: 100 }), priorYearSamePeriod: null },
  balance: none,
  cashflow: { latest: row("cashflow", "2026-09-30", { NETCASH_OPERATE: 90 }), priorYearSamePeriod: null },
});
assert.equal(value(noDepreciation, "ebitda"), undefined);
assert.ok(noDepreciation.gaps.some((gap) => gap.key === "ebitda"));
assert.equal(value(noDepreciation, "depreciationAmortization"), undefined);


console.log("valuation-inputs self-test: ok");
