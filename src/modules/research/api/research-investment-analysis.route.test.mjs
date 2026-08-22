import assert from "node:assert/strict";
import test from "node:test";

import { researchRoutes } from "./research.routes.ts";

test("investment-analysis resume remains unavailable outside the local LLM runtime", async () => {
  const response = await researchRoutes.request(
    "http://example.test/research/company/300308.SZ/investment-analysis/resume",
    { method: "POST" },
    { LLM_RUNTIME: "production" },
  );
  const body = await response.json();
  assert.equal(response.status, 404);
  assert.match(body.msg, /resume is only available in local research runtime/);
});
