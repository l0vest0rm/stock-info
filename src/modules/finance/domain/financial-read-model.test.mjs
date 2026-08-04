import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFinancialStatementReadModel,
  failedFinancialStatementReadModel,
  financialStatementSourcePolicy,
} from "./financial-read-model.ts";

function row(overrides = {}) {
  return {
    code: "BABA.US", statementType: "income", reportDate: "2025-03-31", fiscalPeriod: "12M",
    payload: { FINANCIAL_SOURCE_CONTRACT: "yahoo_finance_timeseries.v2", REPORTING_CURRENCY: "CNY" },
    source: "yahoo", rawR2Key: null, updatedAt: 123,
    ...overrides,
  };
}

test("financial read model preserves provider origin separately from R2 cache delivery", () => {
  const model = buildFinancialStatementReadModel({ code: "BABA.US", statementType: "income", source: "r2", rows: [row()], fresh: true });
  assert.deepEqual(model.sourcePolicy, {
    market: "us_share", primaryProvider: "yahoo", statutoryVerifier: "sec", automaticFallback: false,
    usTransport: "local_proxy_or_production_direct",
  });
  assert.deepEqual(model.delivery, { cache: "r2", originProviders: ["yahoo"], updatedAt: 123, freshness: "fresh" });
  assert.deepEqual(model.reportingCurrencies, ["CNY"]);
  assert.equal(model.dataAsOf, "2025-03-31");
  assert.deepEqual(model.periods, [{ reportDate: "2025-03-31", fiscalPeriod: "12M" }]);
  assert.deepEqual(model.fieldAvailability, { rows: 1, nonEmptyPayloadRows: 1, status: "available" });
  assert.deepEqual(model.sourceHealth, { status: "healthy", reason: null, message: null });
});

test("financial read model makes provider failures and no-data states machine readable", () => {
  const timeout = failedFinancialStatementReadModel("300308.SZ", "cashflow", new Error("external request timed out: host=example"));
  assert.equal(timeout.sourceHealth.status, "failed");
  assert.equal(timeout.sourceHealth.reason, "provider_timeout");
  const empty = buildFinancialStatementReadModel({ code: "00700.HK", statementType: "balance", source: "eastmoney", rows: [], fresh: false });
  assert.equal(empty.sourceHealth.status, "degraded");
  assert.equal(empty.sourceHealth.reason, "no_primary_data");
});

test("source policy never makes a statutory verifier an automatic fallback", () => {
  for (const code of ["300308.SZ", "00700.HK", "JPM.US"]) {
    assert.equal(financialStatementSourcePolicy(code).automaticFallback, false);
  }
  assert.equal(financialStatementSourcePolicy("000001.OF").market, "unsupported");
});
