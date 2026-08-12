import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateCurrentForecastNetProfit,
  calculateCurrentForecastPe,
  isLikelyCompanyNewsReport,
  parseCompanyReportAnalysis,
  parseCompanyReportForecasts,
  parseCompanyReportTargetPrice,
} from "./company.routes.ts";
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

test("parses one optional numeric target price without adding valuation fields", () => {
  assert.deepEqual(parseCompanyReportAnalysis('{"forecasts":[],"targetPrice":"1,650"}'), {
    forecasts: [],
    targetPrice: 1650,
  });
  assert.equal(parseCompanyReportTargetPrice(null), null);
  assert.equal(parseCompanyReportTargetPrice("1,650元"), null);
});

test("calculates current forecast PE from market cap before falling back to price and EPS", () => {
  assert.equal(
    calculateCurrentForecastPe({ year: 2026, netProfit: 32.75, eps: 3 }, { marketCapYi: 1865.42, latestPrice: 171.01 }),
    56.96,
  );
  assert.equal(
    calculateCurrentForecastPe({ year: 2026, eps: 3.56 }, { marketCapYi: null, latestPrice: 171.01 }),
    48.04,
  );
  assert.equal(
    calculateCurrentForecastPe({ year: 2026, pe: 18 }, { marketCapYi: 1865.42, latestPrice: 171.01 }),
    undefined,
  );
});

test("calculates a clearly separate current-share-capital profit estimate from EPS", () => {
  assert.equal(
    calculateCurrentForecastNetProfit({ year: 2026, eps: 0.97 }, { marketCapYi: 1942.058350868, latestPrice: 4.7 }),
    400.81,
  );
  assert.equal(
    calculateCurrentForecastNetProfit({ year: 2026, eps: 0.97 }, { marketCapYi: null, latestPrice: 4.7 }),
    undefined,
  );
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

test("matches likely news report articles using configured valuation and rating keywords", () => {
  assert.equal(
    isLikelyCompanyNewsReport("券商首次覆盖并给出目标价", "机构称公司 2026 年 EPS 与 PE 具备上修空间"),
    true,
  );
  assert.equal(
    isLikelyCompanyNewsReport("公司发布新品", "文章只介绍产品发布、产能进展和客户签约，没有券商观点"),
    false,
  );
});
