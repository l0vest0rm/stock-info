import assert from "node:assert/strict";
import test from "node:test";
import { hasUnsafeMarketConsensusClaim } from "./forecast-synthesis-policy";

test("allows explicit negative coverage disclaimers", () => {
  assert.equal(hasUnsafeMarketConsensusClaim("这不是市场一致预期，只是已纳入样本汇总。"), false);
  assert.equal(hasUnsafeMarketConsensusClaim("机会性来源不得称为市场共识。"), false);
});

test("rejects positive or ambiguous consensus claims", () => {
  assert.equal(hasUnsafeMarketConsensusClaim("市场一致预期为 120 亿元。"), true);
  assert.equal(hasUnsafeMarketConsensusClaim("这些样本可视为市场共识。"), true);
  assert.equal(hasUnsafeMarketConsensusClaim("不是市场共识，但可作为市场一致预期。"), true);
});
