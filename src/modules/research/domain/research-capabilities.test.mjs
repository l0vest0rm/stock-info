import assert from "node:assert/strict";
import test from "node:test";
import { canWriteResearchLocally, researchCapabilities } from "./research-capabilities.ts";

test("research capability read model only enables local research runtime", () => {
  const local = researchCapabilities({ LLM_RUNTIME: "local" });
  assert.deepEqual(local, {
    version: "research-capabilities.v1",
    canWriteLocally: true,
    canReviewLocally: true,
    canGenerateSynthesisLocally: true,
    productionLlmEnabled: false,
  });
  assert.equal(canWriteResearchLocally({ LLM_RUNTIME: "local" }), true);

  for (const runtime of [undefined, "production", "staging", "LOCAL"]) {
    const capabilities = researchCapabilities({ LLM_RUNTIME: runtime });
    assert.equal(capabilities.canWriteLocally, false, `${runtime ?? "missing"} runtime must be read-only`);
    assert.equal(capabilities.canReviewLocally, false);
    assert.equal(capabilities.canGenerateSynthesisLocally, false);
    assert.equal(capabilities.productionLlmEnabled, false);
    assert.equal(canWriteResearchLocally({ LLM_RUNTIME: runtime }), false);
  }
});
