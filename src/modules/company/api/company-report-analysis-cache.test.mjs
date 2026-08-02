import assert from "node:assert/strict";
import test from "node:test";

import { parseCompanyNewsReportAnalysis, parseCompanyReportForecasts } from "./company.routes.ts";
import { isReusableReportAnalysisCache } from "../application/report-analysis-cache.ts";

test("retries legacy empty analysis caches while preserving successful caches", () => {
  assert.equal(isReusableReportAnalysisCache({
    analysisCalled: true,
    forecasts: [],
    updatedAt: 1,
  }), false);
  assert.equal(isReusableReportAnalysisCache({
    analysisCalled: true,
    analysisSucceeded: true,
    forecasts: [],
    updatedAt: 1,
  }), true);
  assert.equal(isReusableReportAnalysisCache({
    analysisCalled: true,
    forecasts: [{ year: 2026, netProfit: 1 }],
    updatedAt: 1,
  }), true);
});

test("accepts an explicit successful response with no annual forecasts", () => {
  assert.deepEqual(parseCompanyReportForecasts('{"forecasts":[]}'), []);
});

test("rejects malformed model output instead of turning it into a successful empty result", () => {
  assert.throws(
    () => parseCompanyReportForecasts("模型没有返回 JSON"),
    /did not contain a forecasts array/,
  );
  assert.throws(
    () => parseCompanyReportForecasts('{"result":[]}'),
    /did not contain a forecasts array/,
  );
});

test("keeps explicit valuation evidence from a news report while rejecting ordinary news", () => {
  assert.deepEqual(
    parseCompanyNewsReportAnalysis(JSON.stringify({
      isCompanyReport: true,
      forecasts: [{ year: 2026, netProfit: 123.4, pe: 18 }],
      valuation: {
        rating: "买入",
        targetPrice: 51.51,
        targetPriceCurrency: "人民币",
        targetPe: 20,
        valuationMethod: "PE",
      },
    })),
    {
      isCompanyReport: true,
      forecasts: [{ year: 2026, netProfit: 123.4, pe: 18 }],
      valuation: {
        rating: "买入",
        targetPrice: 51.51,
        targetPriceCurrency: "人民币",
        targetPe: 20,
        valuationMethod: "PE",
      },
    },
  );
  assert.deepEqual(
    parseCompanyNewsReportAnalysis('{"isCompanyReport":false,"forecasts":[{"year":2026,"netProfit":99}],"valuation":{"rating":"买入"}}'),
    { isCompanyReport: false, forecasts: [], valuation: {} },
  );
});
