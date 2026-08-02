import assert from "node:assert/strict";
import test from "node:test";

import { formatCompanyReportTextForLlm } from "./company.routes.ts";

test("formats PDF spacing artifacts without extracting forecast fields", () => {
  assert.equal(
    formatCompanyReportTextForLlm("附一： 合 并 损 益 表 百 万 元 202 6 F\n营 业 收 入   25619"),
    "附一： 合并损益表百万元 2026 F\n营业收入   25619",
  );
});
