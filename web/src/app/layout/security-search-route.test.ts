import assert from "node:assert/strict";
import test from "node:test";
import { routeForSecuritySearch } from "./security-search-route";

const company = { code: "300502.SZ", market: "cn-sz", type: "stock", name: "新易盛" };
const fund = { code: "005827.OF", market: "fund", type: "fund", name: "易方达蓝筹精选" };

test("keeps the current company detail page and only changes code", () => {
  assert.equal(
    routeForSecuritySearch(company, "http://127.0.0.1:8000/company-finance.html?code=300308.SZ&period=year#income"),
    "/company-finance.html?code=300502.SZ&period=year#income",
  );
});

test("keeps the current fund detail page and only changes code", () => {
  assert.equal(
    routeForSecuritySearch(fund, "http://127.0.0.1:8000/fund-notice.html?code=513100.OF&page=2"),
    "/fund-notice.html?code=005827.OF&page=2",
  );
});

test("uses the matching detail homepage when the current page cannot accept the result", () => {
  assert.equal(
    routeForSecuritySearch(fund, "http://127.0.0.1:8000/company-report.html?code=300308.SZ"),
    "fund.html?code=005827.OF",
  );
  assert.equal(
    routeForSecuritySearch(company, "http://127.0.0.1:8000/funds.html"),
    "company.html?code=300502.SZ",
  );
});
