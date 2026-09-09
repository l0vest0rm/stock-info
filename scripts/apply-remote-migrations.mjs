#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const database = process.argv[2] || process.env.CF_D1_DATABASE || "stock_info";
const wrangler = resolve(root, "node_modules/wrangler/bin/wrangler.js");
// D1 owns its migration ledger. Writing `d1_migrations` through `d1 execute`
// is rejected by the service, so all remote changes must travel through the
// Wrangler migration API, which records an atomic migration and backup.
const result = spawnSync(process.execPath, [wrangler, "d1", "migrations", "apply", database, "--remote"], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});

if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = result.status ?? 1;
