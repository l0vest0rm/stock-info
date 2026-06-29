#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const passthroughArgs = process.argv.slice(2);

execFileSync(
  process.execPath,
  [
    new URL("./import-filtered-knowledge-docs.mjs", import.meta.url).pathname,
    "--remote",
    "--upload-content-remote",
    ...passthroughArgs,
  ],
  { stdio: "inherit" }
);
