#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const outdir = resolve(root, "data/local/runtime");
mkdirSync(outdir, { recursive: true });
const esbuild = resolve(root, "node_modules/esbuild/bin/esbuild");
for (const [source, output, format] of [["src/platform/node/local-server.ts", "server.mjs", "esm"], ["src/platform/node/local-cron.ts", "cron.cjs", "cjs"], ["src/platform/node/local-bindings.ts", "bindings.mjs", "esm"]]) {
  execFileSync(esbuild, [source, "--bundle", "--platform=node", `--format=${format}`, "--target=node22", `--outfile=${resolve(outdir, output)}`], { cwd: root, stdio: "inherit" });
}
