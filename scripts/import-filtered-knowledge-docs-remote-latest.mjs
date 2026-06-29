#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { loadKnowledgeDefaults, findLatestWorkFile } from "./knowledge-defaults.mjs";

if (process.argv.length > 2) {
  throw new Error("import-filtered-knowledge-docs-remote-latest.mjs does not accept arguments");
}

const defaults = loadKnowledgeDefaults();
const latest = findLatestWorkFile(defaults.workDir, "knowledge-filtered-");
const stamp = latest.basename.replace(/^knowledge-filtered-/, "").replace(/\.jsonl$/, "");
const resultFile = join(defaults.workDir, `knowledge-filtered-result-${stamp}.json`);

execFileSync(
  process.execPath,
  [
    new URL("./import-filtered-knowledge-docs-remote.mjs", import.meta.url).pathname,
    "--file",
    latest.file,
    "--result-file",
    resultFile,
    "--sync-file",
    defaults.importSyncFile,
    "--database",
    defaults.database,
  ],
  { stdio: "inherit" }
);
