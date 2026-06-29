#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { loadKnowledgeDefaults } from "./knowledge-defaults.mjs";

if (process.argv.length > 2) {
  throw new Error("process-knowledge-local-full.mjs does not accept arguments");
}

const defaults = loadKnowledgeDefaults();

execFileSync(
  process.execPath,
  [
    new URL("./process-knowledge-once.mjs", import.meta.url).pathname,
    "--local",
    "--full-rescan",
    "--no-age-limit",
    "--extra-input",
    defaults.processedDir,
  ],
  { stdio: "inherit" }
);
