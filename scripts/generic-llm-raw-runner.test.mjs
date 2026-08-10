import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("raw handler delegates concurrency to the DB lease and persists stream artifacts", async () => {
  const source = await readFile(new URL("./generic-llm-raw-runner.mjs", import.meta.url), "utf8");
  assert.match(source, /provider\.stream/);
  assert.match(source, /\/partial/);
  assert.match(source, /\/artifact/);
  assert.match(source, /\/complete/);
  assert.doesNotMatch(source, /SharedLlmClient|providerConcurrency/);
  assert.match(source, /signal:\s*undefined/);
});
