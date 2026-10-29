#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const config = JSON.parse(readFileSync(resolve(root, "config/app/local-runtime.json"), "utf8"));
const pages = JSON.parse(readFileSync(resolve(root, "config/app/page-manifest.json"), "utf8"));
if (config.runtime !== "local" || config.host !== "127.0.0.1" || config.timezone !== "UTC") throw new Error("Local runtime identity is invalid");
if (!Array.isArray(config.triggers?.crons) || !config.triggers.crons.length) throw new Error("Local cron configuration is missing");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
if (pkg.devDependencies?.wrangler || Object.values(pkg.scripts).some(command => /(?:^|\s)(?:npx\s+)?wrangler(?:\s|$)|deploy-cloudflare|rollback-cloudflare|--remote|upload-content-remote|write-wrangler-vars/.test(command))) throw new Error("Package commands must not deploy or write remote Cloudflare resources");
if (Object.keys(config).some(key => /cookie|token|secret/i.test(key))) throw new Error("Credentials must not be versioned runtime config");
const cron = readFileSync(resolve(root, "src/platform/node/local-cron.ts"), "utf8");
if (/publishCompletedReportsToProduction|wrangler\.jsonc/.test(cron)) throw new Error("Local scheduler must not depend on deployment config or publish to production");
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
console.log("Local-only runtime, no remote publication, page policy and module boundaries passed.");
function walk(path) { return readdirSync(path, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(resolve(path, entry.name)) : entry.name.endsWith(".ts") && !entry.name.includes(".test.") ? [resolve(path, entry.name)] : []); }
