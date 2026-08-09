import assert from "node:assert/strict";
import test from "node:test";
import { isLocalDevelopmentRuntime } from "./request";

test("only the explicit Node runtime binding enables local-only routes", () => {
  assert.equal(isLocalDevelopmentRuntime({ APP_RUNTIME: "node" }), true);
  assert.equal(isLocalDevelopmentRuntime({ APP_RUNTIME: "cloudflare" }), false);
  // Cloudflare's nodejs_compat flag must never be treated as local Node.
  assert.equal(isLocalDevelopmentRuntime({}), false);
});
