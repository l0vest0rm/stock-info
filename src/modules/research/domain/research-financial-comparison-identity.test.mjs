import assert from "node:assert/strict";
import test from "node:test";

import { canonicalFinancialComparisonKey } from "./research-financial-comparison-identity.ts";
import { loadStatutoryGate, normalizeStatementRows } from "../application/research-financials.ts";

const basis = { id: "CNY:CAS:consolidated:reported", currency: "CNY", accountingStandard: "CAS", scope: "consolidated", revision: "reported" };

test("canonical financial comparison key ignores Eastmoney fiscalPeriod display labels and row positions", () => {
  const first = canonicalFinancialComparisonKey({
    source: "eastmoney", securityCode: "300308.SZ", statementType: "income", metric: "revenue", basis,
    period: { kind: "annual", startDate: "2024-01-01", endDate: "2024-12-31", fiscalYear: 2024 },
  });
  // The adapter may see REPORT_TYPE as `ANNUAL`, `年报`, or null and rows may
  // arrive in a different array order. Neither is an accounting identity.
  const reloadedWithDifferentDisplayPeriod = canonicalFinancialComparisonKey({
    source: "eastmoney", securityCode: "300308.SZ", statementType: "income", metric: "revenue", basis,
    period: { kind: "annual", startDate: "2024-01-01", endDate: "2024-12-31", fiscalYear: 2024 },
  });
  assert.equal(first, reloadedWithDifferentDisplayPeriod);
  assert.notEqual(first, canonicalFinancialComparisonKey({
    source: "eastmoney", securityCode: "300308.SZ", statementType: "income", metric: "revenue", basis: { ...basis, revision: "restated" },
    period: { kind: "annual", startDate: "2024-01-01", endDate: "2024-12-31", fiscalYear: 2024 },
  }));
});

test("300308 primary normalizer retains the same comparison identity when Eastmoney adds a fiscalPeriod label", () => {
  const statement = (fiscalPeriod) => ({
    code: "300308.SZ", source: "eastmoney", reportDate: "2026-03-31", fiscalPeriod,
    payload: { REPORT_DATE: "2026-03-31", TOTAL_OPERATE_INCOME: 123 },
  });
  const before = normalizeStatementRows("income", [statement(null)]).find((fact) => fact.metric === "revenue");
  const after = normalizeStatementRows("income", [statement("一季度")]).find((fact) => fact.metric === "revenue");
  assert.ok(before && after);
  assert.notEqual(before.id, after.id);
  assert.equal(before.canonicalComparisonKey, after.canonicalComparisonKey);
  assert.equal(before.id, "eastmoney:300308.SZ:income:2026-03-31:unknown:0:revenue");
  assert.equal(after.id, "eastmoney:300308.SZ:income:2026-03-31:一季度:0:revenue");
});

test("Eastmoney A-share separates the explicit FY income source from the 12-31 Q4 series", () => {
  const annual = normalizeStatementRows("income", [{
    code: "002330.SZ", source: "eastmoney", reportDate: "2025-12-31", fiscalPeriod: "12M",
    payload: {
      REPORT_DATE: "2025-12-31 00:00:00", REPORT_TYPE: "年报", FISCAL_PERIOD: "12M",
      FINANCIAL_SOURCE_CONTRACT: "eastmoney_f10_annual_income.v1", TOTAL_OPERATE_INCOME: 3147334762.78,
    },
  }]).find((item) => item.metric === "revenue");
  assert.deepEqual(annual?.period, { kind: "annual", startDate: "2025-01-01", endDate: "2025-12-31", fiscalYear: 2025 });

  const q4 = normalizeStatementRows("income", [{
    code: "002330.SZ", source: "eastmoney", reportDate: "2025-12-31", fiscalPeriod: "四季度",
    payload: { REPORT_DATE: "2025-12-31 00:00:00", REPORT_TYPE: "四季度", TOTAL_OPERATE_INCOME: 754447782.11 },
  }]).find((item) => item.metric === "revenue");
  assert.deepEqual(q4?.period, { kind: "quarter", startDate: "2025-10-01", endDate: "2025-12-31", fiscalYear: 2025, fiscalQuarter: 4 });
});

test("a non-Eastmoney December report remains quarterly without an authoritative annual period", () => {
  const fact = normalizeStatementRows("income", [{
    code: "TEST.US", source: "yahoo", reportDate: "2025-12-31", fiscalPeriod: "四季度",
    payload: {
      REPORT_DATE: "2025-12-31", REPORT_TYPE: "四季度", FISCAL_PERIOD: "3M",
      FINANCIAL_SOURCE_CONTRACT: "yahoo_finance_timeseries.v2", REPORTING_CURRENCY: "USD",
      TOTAL_OPERATE_INCOME: 100,
    },
  }]).find((item) => item.metric === "revenue");
  assert.equal(fact?.period.kind, "quarter");
  assert.equal(fact?.period.fiscalQuarter, 4);
});

test("financial statement share fields never infer diluted shares from issued/common capital", () => {
  const rows = normalizeStatementRows("income", [{
    code: "300308.SZ", source: "eastmoney", reportDate: "2026-03-31", fiscalPeriod: "一季度",
    payload: {
      REPORT_DATE: "2026-03-31",
      ISSUED_COMMON_SHARES: 1_000,
      HK_COMMON_SHARES: 900,
      DILUTED_AVERAGE_SHARES: 950,
    },
  }]);
  assert.equal(rows.find((item) => item.metric === "diluted_weighted_average_shares")?.value, 950);
  assert.equal(rows.some((item) => item.metric === "diluted_shares"), false);
});

test("coverage gate joins a reloaded 300308 fact by canonical key, never its display-derived source id", async () => {
  const statements = [];
  const db = {
    prepare(sql) {
      statements.push(sql);
      return { bind(...values) { return { first: async () => ({ matched: values.includes("financial-comparison:300308:2026Q1") ? 1 : 0 }) }; } };
    },
  };
  const facts = ["revenue", "net_profit", "operating_cash_flow", "total_equity", "diluted_shares"].map((metric) => ({
    id: `eastmoney:300308.SZ:income:2026-03-31:一季度:0:${metric}`,
    canonicalComparisonKey: "financial-comparison:300308:2026Q1",
    metric,
    value: 1,
    period: { kind: "quarter", startDate: "2026-01-01", endDate: "2026-03-31", fiscalYear: 2026, fiscalQuarter: 1 },
    basis,
    provenance: { sourceId: "eastmoney:300308.SZ:income:2026-03-31:一季度:0", sourceType: "eastmoney" },
  }));
  const gate = await loadStatutoryGate(db, "a_share", facts);
  assert.equal(gate.status, "verified");
  assert.ok(statements.every((sql) => sql.includes("canonical_comparison_key")));
  assert.ok(statements.every((sql) => !sql.includes("normalized_fact_id in")));
});
