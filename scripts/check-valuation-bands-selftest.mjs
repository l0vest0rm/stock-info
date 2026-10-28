/**
 * Deterministic check for the conservative valuation bands.
 * Run: node scripts/check-valuation-bands-selftest.mjs
 *
 * The bands are research input, never advice.  The invariants that matter:
 * - no band is produced without a disclosed denominator
 * - archetype-forbidden methods are marked, not silently omitted
 * - a high depreciation/EBIT ratio demotes EV/EBITDA instead of trusting it
 * - a missing quote only removes the implied column, it does not break anchors
 */
import assert from "node:assert/strict";
import { buildValuationBands } from "../src/modules/finance/domain/valuation-bands.ts";

const YI = 100_000_000;
const base = {
  asOf: { income: "2026-06-30", balance: "2026-06-30", cashflow: "2026-06-30" },
  ttm: {},
  balance: {},
  marketCap: 1000 * YI,
};
const band = (model, key) => model.bands.find((item) => item.key === key);

// 1. Ordinary manufacturer with a price: PE/EV bands are available.
const manufacturer = buildValuationBands({
  ...base,
  code: "TEST.SH",
  archetype: "growth_manufacturing",
  ttm: { netProfit: 50 * YI, revenue: 400 * YI, ebit: 80 * YI, ebitda: 100 * YI, operatingCashFlow: 90 * YI, freeCashFlow: 40 * YI },
  balance: { parentEquity: 200 * YI, grossDebt: 100 * YI, cash: 60 * YI, debtIncomplete: false },
});
assert.equal(band(manufacturer, "pe_ttm").status, "available");
assert.ok(Math.abs(band(manufacturer, "pe_ttm").denominator.value - 50 * YI) < 1, "PE denominator is TTM net profit");
assert.deepEqual(band(manufacturer, "pe_ttm").implied.low, 400 * YI);
assert.deepEqual(band(manufacturer, "pe_ttm").implied.high, 900 * YI);
assert.equal(manufacturer.disclaimer.includes("不是目标价"), true, "disclaimer is explicit");

// EV bands carry the debt/cash rule, and refuse to guess when debt is partial.
assert.equal(band(manufacturer, "ev_ebit").status, "available");
assert.ok(band(manufacturer, "ev_ebit").assumptions.some((text) => text.includes("有息负债缺失时不计算 EV")));

// 2. High depreciation/EBIT demotes EV/EBITDA to auxiliary and warns.
const heavy = buildValuationBands({
  ...base,
  code: "HEAVY.SH",
  archetype: "growth_manufacturing",
  ttm: { netProfit: 10 * YI, ebit: 15 * YI, ebitda: 100 * YI },
  balance: { grossDebt: 200 * YI, cash: 50 * YI, debtIncomplete: false },
  capitalIntensity: { depreciationToEbit: 5.6 },
});
assert.equal(band(heavy, "ev_ebitda").role, "auxiliary", "EV/EBITDA is demoted when D&A dwarfs EBIT");
assert.ok(heavy.warnings.some((text) => text.includes("不能与轻资产公司直接比较")), "capital-intensity warning is present");

// 3. Banks: EV methods are marked forbidden, PB stays primary, no EV denominator.
const bank = buildValuationBands({
  ...base,
  code: "600036.SH",
  archetype: "bank",
  ttm: { netProfit: 1500 * YI, revenue: 3400 * YI, ebit: 2000 * YI, ebitda: 2100 * YI },
  balance: { parentEquity: 12000 * YI, grossDebt: 0, cash: 0, debtIncomplete: false },
});
assert.equal(band(bank, "ev_ebit").status, "forbidden_for_archetype");
assert.equal(band(bank, "ev_ebitda").status, "forbidden_for_archetype");
assert.equal(band(bank, "ev_revenue").status, "forbidden_for_archetype");
assert.equal(band(bank, "pb").status, "available");
assert.equal(band(bank, "pb").denominator.basis, "book_equity");

// 4. Insurers: unadjusted PB is forbidden too.
const insurer = buildValuationBands({ ...base, code: "601318.SH", archetype: "insurer", ttm: { netProfit: 1300 * YI }, balance: { parentEquity: 9000 * YI } });
assert.equal(band(insurer, "pb").status, "forbidden_for_archetype");
assert.ok(band(insurer, "pb").reasons.some((text) => text.includes("内含价值")));

// 5. Pre-profit milestone: PE forbidden, EV/Revenue becomes primary.
const preprofit = buildValuationBands({ ...base, code: "MILESTONE.SH", archetype: "pre_profit_milestone", ttm: { netProfit: -5 * YI, revenue: 20 * YI }, balance: { grossDebt: 10 * YI, cash: 30 * YI, debtIncomplete: false } });
assert.equal(band(preprofit, "pe_ttm").status, "forbidden_for_archetype");
assert.equal(band(preprofit, "ev_revenue").status, "available");
assert.equal(band(preprofit, "ev_revenue").role, "primary");

// 6. No quote: anchors still compute, the implied column is simply absent.
const noQuote = buildValuationBands({ ...base, code: "NOPRICE.SH", archetype: "stable_cash_dividend", marketCap: null, ttm: { netProfit: 30 * YI, freeCashFlow: 25 * YI }, balance: { parentEquity: 100 * YI } });
assert.equal(band(noQuote, "pe_ttm").status, "available", "anchor survives a missing quote");
assert.equal(band(noQuote, "pe_ttm").implied, null);
assert.equal(band(noQuote, "fcf_yield").status, "insufficient_data", "yield needs a market cap");
assert.ok(noQuote.warnings.some((text) => text.includes("未提供市值")));

// 7. Negative earnings never become a positive denominator.
const loss = buildValuationBands({ ...base, code: "LOSS.SH", archetype: "growth_manufacturing", ttm: { netProfit: -8 * YI, revenue: 50 * YI, ebit: -3 * YI }, balance: { grossDebt: 5 * YI, cash: 5 * YI, debtIncomplete: false } });
assert.equal(band(loss, "pe_ttm").status, "insufficient_data");
assert.equal(band(loss, "pe_ttm").range, null);
assert.ok(band(loss, "pe_ttm").missingInputs.some((text) => text.includes("净利润为正")));

// 8. Partial debt blocks the EV computation rather than understating it.
const partialDebt = buildValuationBands({ ...base, code: "PARTIAL.SH", archetype: "growth_manufacturing", ttm: { ebit: 40 * YI }, balance: { grossDebt: 10 * YI, cash: 5 * YI, debtIncomplete: true } });
assert.equal(band(partialDebt, "ev_ebit").implied, null);
assert.ok(partialDebt.warnings.some((text) => text.includes("部分披露科目")));

// 9. Everything missing: no band is available and the warning says so.
const empty = buildValuationBands({ code: "EMPTY.SH", archetype: "growth_manufacturing", asOf: { income: null, balance: null, cashflow: null }, ttm: {}, balance: {}, marketCap: null });
assert.equal(empty.bands.every((item) => item.status !== "available"), true);
assert.ok(empty.warnings.some((text) => text.includes("不应据此形成任何判断")));

// 10. Cyclicals: TTM PE is demoted, the through-cycle median carries primary.
const cyclical = buildValuationBands({
  ...base,
  code: "601919.SH",
  archetype: "cyclical_commodity",
  ttm: { netProfit: 300 * YI, ebit: 350 * YI, ebitda: 400 * YI },
  balance: { grossDebt: 100 * YI, cash: 200 * YI, debtIncomplete: false },
  midCycle: { status: "available", mean: 313 * YI, median: 169 * YI, window: "2016..2025", years: [{ fiscalYear: 2025, value: 169 * YI, reportDate: "2025-12-31" }], notes: ["窗口内有 1 个亏损年度"] },
});
assert.equal(band(cyclical, "pe_ttm").role, "auxiliary", "TTM PE is demoted for a cyclical");
assert.equal(band(cyclical, "pe_mid_cycle").status, "available");
assert.equal(band(cyclical, "pe_mid_cycle").role, "primary");
assert.equal(band(cyclical, "pe_mid_cycle").denominator.basis, "net_income_mid_cycle");
assert.equal(band(cyclical, "pe_mid_cycle").denominator.value, 169 * YI, "the median, not the mean, is the denominator");
assert.ok(cyclical.warnings.some((text) => text.includes("周期的偏高")), "TTM <-> mid-cycle divergence is warned");

// 11. A cyclical without a long enough history never falls back to TTM.
const shortHistory = buildValuationBands({
  ...base,
  code: "NEWCYC.SH",
  archetype: "cyclical_commodity",
  ttm: { netProfit: 20 * YI },
  balance: {},
  midCycle: { status: "insufficient_data", mean: null, median: null, window: "2021..2025" },
});
assert.equal(band(shortHistory, "pe_mid_cycle").status, "insufficient_data");
assert.ok(band(shortHistory, "pe_mid_cycle").missingInputs.some((text) => text.includes("足够长的年报历史")));
assert.ok(shortHistory.warnings.some((text) => text.includes("不要退回 TTM")), "no silent TTM fallback");

// 11b. The mid-cycle anchor must be a real annual report date, never the
//      window label.  `window` is `2016..2025`, and using it as `reportDate`
//      made the band undateable: every cyclical then failed a staleness check
//      and could not be screened at all, while the band looked available.
const anchorIsDate = band(cyclical, "pe_mid_cycle").denominator.reportDate;
assert.equal(anchorIsDate, "2025-12-31", "the anchor is the newest annual report in the window");
assert.match(anchorIsDate, /^\d{4}-\d{2}-\d{2}$/, "an anchor must parse as a date");
assert.ok(!anchorIsDate.includes(".."), "the window label must never be used as a date");
// The window itself is still disclosed, as an assumption rather than a date.
assert.ok(band(cyclical, "pe_mid_cycle").assumptions.some((text) => text.includes("2016..2025")), "the window is still stated");

// A mid-cycle centre with no dated observations cannot be anchored, so it is
// unavailable rather than silently dated by its window label.
const undatableCentre = buildValuationBands({
  ...base,
  code: "NODATE.SH",
  archetype: "cyclical_commodity",
  ttm: { netProfit: 50 * YI },
  balance: {},
  midCycle: { status: "available", mean: 50 * YI, median: 50 * YI, window: "2016..2025" },
});
assert.equal(band(undatableCentre, "pe_mid_cycle").status, "insufficient_data");
assert.ok(band(undatableCentre, "pe_mid_cycle").missingInputs.some((text) => text.includes("没有可用的年报报告期")));
assert.equal(band(undatableCentre, "pe_mid_cycle").denominator, null);

// 12. Non-cyclicals declare the mid-cycle method forbidden instead of omitting it.
assert.equal(band(manufacturer, "pe_mid_cycle").status, "forbidden_for_archetype");
assert.ok(band(manufacturer, "pe_mid_cycle").reasons.some((text) => text.includes("抹掉成长")));

// 13. The median is used when the mean is inflated by one boom year.
const boom = buildValuationBands({
  ...base,
  code: "BOOM.SH",
  archetype: "cyclical_commodity",
  ttm: { netProfit: 1097 * YI },
  balance: {},
  midCycle: { status: "available", mean: 313 * YI, median: 169 * YI, window: "2016..2025", years: [{ fiscalYear: 2025, value: 169 * YI, reportDate: "2025-12-31" }] },
});
assert.ok(band(boom, "pe_mid_cycle").implied.low < band(boom, "pe_ttm").implied.low, "mid-cycle band sits far below the TTM band at a peak");

// 14. EV/EBITDA range depends on capital intensity: same denominator, different
//     credible multiple.  This is the P1-3 finding turned into a rule.
const lightAsset = buildValuationBands({ ...base, code: "LIGHT.SH", archetype: "growth_manufacturing", ttm: { ebit: 100 * YI, ebitda: 107 * YI }, balance: { grossDebt: 0, cash: 0, debtIncomplete: false }, capitalIntensity: { depreciationToEbit: 0.07 } });
const heavyAsset = buildValuationBands({ ...base, code: "HEAVY.SH", archetype: "growth_manufacturing", ttm: { ebit: 100 * YI, ebitda: 660 * YI }, balance: { grossDebt: 0, cash: 0, debtIncomplete: false }, capitalIntensity: { depreciationToEbit: 5.6 } });
assert.deepEqual(band(lightAsset, "ev_ebitda").range, { low: 14, high: 28 }, "light-asset range");
assert.deepEqual(band(heavyAsset, "ev_ebitda").range, { low: 5, high: 11 }, "heavy-asset range");
assert.ok(band(lightAsset, "ev_ebitda").assumptions[0].includes("轻资本"), "the class is stated in the assumptions");
assert.ok(band(heavyAsset, "ev_ebitda").assumptions[0].includes("重资本"));
assert.deepEqual(band(lightAsset, "ev_ebit").range, band(heavyAsset, "ev_ebit").range, "EV/EBIT stays capital-neutral");

// 15. Unknown capital intensity falls back to the plain EV/EBITDA range and says so.
const noIntensity = buildValuationBands({ ...base, code: "NOKIND.SH", archetype: "growth_manufacturing", ttm: { ebit: 100 * YI, ebitda: 120 * YI }, balance: { grossDebt: 0, cash: 0, debtIncomplete: false } });
assert.deepEqual(band(noIntensity, "ev_ebitda").range, { low: 5, high: 11 });

console.log("valuation-bands self-test: ok", {
  manufacturer: manufacturer.bands.filter((item) => item.status === "available").map((item) => item.key),
  bank: bank.bands.filter((item) => item.status === "forbidden_for_archetype").map((item) => item.key),
  cyclical: cyclical.bands.filter((item) => item.status === "available").map((item) => `${item.key}:${item.role}`),
  heavyWarning: heavy.warnings.length,
});
