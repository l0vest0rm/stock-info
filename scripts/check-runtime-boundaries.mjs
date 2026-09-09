#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "jsonc-parser";
const root = resolve(import.meta.dirname, "..");
const config = parse(readFileSync(resolve(root, "wrangler.jsonc"), "utf8"));
const pages = JSON.parse(readFileSync(resolve(root, "config/page-manifest.json"), "utf8"));
if (config.vars.APP_RUNTIME !== "cloudflare" || config.vars.LLM_RUNTIME !== "production") throw new Error("Production runtime identity is invalid");
if ("XUEQIU_COOKIE" in config.vars) throw new Error("XUEQIU_COOKIE must be a Worker secret, never a versioned var");
if (!config.assets.run_worker_first.includes("/*.html") && !config.assets.run_worker_first.includes("/*")) throw new Error("All HTML pages must pass the page policy in the Worker");
const paths = new Set();
for (const page of pages) {
  if (paths.has(page.path) || !["local", "all"].includes(page.runtime)) throw new Error(`Invalid page policy: ${page.path}`);
  paths.add(page.path);
}
for (const file of walk(resolve(root, "src/modules"))) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g)) {
    if (match[1].includes("/api/") && !file.includes("/api/")) throw new Error(`Business code imports an HTTP layer: ${file}`);
    if (/\.\.\/\.\.\/[^/]+\/api\//.test(match[1])) throw new Error(`Cross-module API dependency: ${file}`);
    if (match[1].startsWith("node:")) throw new Error(`Shared business code imports Node: ${file}`);
  }
}
console.log("Runtime identity, page policy, credential and module boundaries passed.");
function walk(path) { return readdirSync(path, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(resolve(path, entry.name)) : entry.name.endsWith(".ts") && !entry.name.includes(".test.") ? [resolve(path, entry.name)] : []); }
