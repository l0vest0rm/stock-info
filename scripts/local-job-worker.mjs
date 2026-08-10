#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { startGenericLlmDispatcher } from "./generic-llm-dispatcher.mjs";
import { localRuntimeLog } from "./lib/local-runtime-log.mjs";

/** One process owns the universal local LLM dispatcher; DB leases fence every job. */
export function startLocalJobWorker() {
  const controllers = [startGenericLlmDispatcher()];
  return {
    async stop({ gracefulTimeoutMs = 30_000 } = {}) {
      await Promise.allSettled(controllers.map((controller) => controller.stop({ gracefulTimeoutMs })));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = startLocalJobWorker();
  localRuntimeLog("local-job-worker", "ready");
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void controller.stop().finally(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
