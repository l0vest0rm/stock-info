import assert from "node:assert/strict";
import test from "node:test";
import { createMacroValueFormatter, formatMacroValue } from "./macro-value-format.ts";

const definition = (unit, regionCode = "US", unitFormat = "decimal_1") => ({ unit, regionCode, unitFormat });

test("turns WEO billions in local currency into a readable Chinese currency unit", () => {
  assert.equal(formatMacroValue(23_305, definition("十亿本币")), "23.305 万亿美元");
  assert.equal(formatMacroValue(134_908, definition("十亿本币", "CN")), "134.908 万亿元");
});

test("normalizes known monetary and population source units without guessing unknown units", () => {
  assert.equal(formatMacroValue(23_305, definition("billions of chained 2017 dollars")), "23.305 万亿美元（2017年不变价）");
  assert.equal(formatMacroValue(21_900, definition("millions of dollars", "US", "decimal_0")), "219 亿美元");
  assert.equal(formatMacroValue(7_500, definition("thousands of persons", "US", "decimal_0")), "750 万人");
  assert.equal(formatMacroValue(108.26, definition("index 2017=100")), "108.26 index 2017=100");
});

test("uses one unit for every point in a detail chart", () => {
  const formatter = createMacroValueFormatter(definition("billions of dollars"), [900, 1_100]);
  assert.equal(formatter.unit, "万亿美元");
  assert.equal(formatter.format(900), "0.9 万亿美元");
  assert.equal(formatter.format(1_100), "1.1 万亿美元");
});
