import assert from "node:assert/strict";
import test from "node:test";

import { cashDividends } from "./dividend-yield.ts";

test("trailing dividend inputs ignore zero-cash future disclosures", () => {
  const decisions = cashDividends([
    { reportDate: "2025-06-30", cashPerShare: 1.013 },
    { reportDate: "2025-12-31", cashPerShare: 1.003 },
    { reportDate: "2026-06-30", cashPerShare: 0 },
  ]);

  assert.deepEqual(decisions.map((decision) => decision.reportDate), ["2025-06-30", "2025-12-31"]);
  assert.equal(decisions.reduce((total, decision) => total + decision.cashPerShare, 0), 2.016);
});
