import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { loadKnowledgeIngestConfig, startKnowledgeIngestScheduler } from "./knowledge-ingest-scheduler.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const configPath = resolve(root, "config/knowledge-processing.json");

test("default local knowledge ingest automation is disabled", async () => {
  const config = loadKnowledgeIngestConfig(configPath);
  assert.equal(config.enabled, false);
  assert.equal(config.runOnStart, false);

  const events = [];
  const scheduler = startKnowledgeIngestScheduler({
    configPath,
    runChild: async () => assert.fail("disabled scheduler must not spawn knowledge processing"),
    onEvent: (event) => events.push(event),
  });
  assert.deepEqual(events, ["disabled"]);
  assert.equal(await scheduler.runNow("test"), false);
  scheduler.stop();
});
