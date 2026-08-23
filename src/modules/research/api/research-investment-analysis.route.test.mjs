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

test("retired research workbench routes are not registered", async () => {
  for (const [path, init] of [
    ["/research/company/300308.SZ/forecasts", {}],
    ["/research/company/300308.SZ/market-structure", {}],
    ["/research/company/300308.SZ/industry-kpi-driver-binding-context", {}],
    ["/research/company/300308.SZ/risk-pressure-scenarios/pressure:1/stress", {}],
    ["/research/company/300308.SZ/valuation-models/dcf", { method: "POST" }],
    ["/research/industry/tracks", { method: "POST" }],
  ]) {
    const response = await researchRoutes.request(`http://example.test${path}`, init);
    assert.equal(response.status, 404, `${init.method || "GET"} ${path} must be absent`);
  }
});
