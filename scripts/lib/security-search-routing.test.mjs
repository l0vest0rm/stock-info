import assert from "node:assert/strict";
import test from "node:test";

import { eastmoneySecId, isSupportedSecurityCode, securityMarket } from "../../src/shared/codes.ts";

test("Korean Yahoo symbols survive supported-security filtering", () => {
  assert.equal(isSupportedSecurityCode("005930.KS"), true);
  assert.equal(isSupportedSecurityCode("247540.KQ"), true);
});

test("verified Eastmoney KOSPI benchmark mapping is supported without adding a fallback source", () => {
  assert.equal(isSupportedSecurityCode("KS11.UI"), true);
  assert.equal(securityMarket("KS11.UI"), "kr");
  assert.equal(eastmoneySecId("KS11.UI"), "100.KS11");
  assert.equal(isSupportedSecurityCode("HSI.HK"), true);
  assert.equal(eastmoneySecId("SPX.US"), "100.SPX");
  assert.equal(eastmoneySecId("HSI.HK"), "100.HSI");
});
