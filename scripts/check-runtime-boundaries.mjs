#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const config = JSON.parse(readFileSync(resolve(root, "config/app/local-runtime.json"), "utf8"));
const pages = JSON.parse(readFileSync(resolve(root, "config/app/page-manifest.json"), "utf8"));
if (config.runtime !== "local" || config.host !== "127.0.0.1" || config.timezone !== "UTC") throw new Error("Local runtime identity is invalid");
if (!Array.isArray(config.triggers?.crons) || !config.triggers.crons.length) throw new Error("Local cron configuration is missing");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
if (Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).some(name => /^(?:@cloudflare\/|wrangler$|hono$|croner$)/.test(name)) || Object.values(pkg.scripts).some(command => /(?:^|\s)(?:npx\s+)?wrangler(?:\s|$)|deploy-cloudflare|rollback-cloudflare|--remote|upload-content-remote|write-wrangler-vars/.test(command))) throw new Error("Package commands must not deploy or write remote Cloudflare resources");
if (Object.keys(config).some(key => /cookie|token|secret/i.test(key))) throw new Error("Credentials must not be versioned runtime config");
const launcher = readFileSync(resolve(root, "start-local.sh"), "utf8");
const native = readFileSync(resolve(root, "start-rust.sh"), "utf8");
if (!/exec .*start-rust\.sh/.test(launcher) || /local-server|local-supervisor|tsx/.test(launcher)) throw new Error("Default runtime must exec the Rust launcher, not the retired Node backend");
if (!/exec .*stock-info-local/.test(native) || /local-server|local-supervisor|tsx/.test(native)) throw new Error("Rust launcher must exec the native backend");
for (const file of ["process-knowledge.sh", "process-knowledge-local-full.sh", "process-information-feed-local.sh", "cleanup-knowledge-local.sh", "prepare-featured-report.sh", "publish-featured-report.sh"]) {
  const source = readFileSync(resolve(root, file), "utf8");
  if (!source.includes("./start-rust.sh") || /exec\s+node\s/.test(source)) throw new Error(`Supported workflow must use the native backend: ${file}`);
}
for (const name of ["serve:local", "serve:local:http", "dev:cron", "dev:cron:once", "db:migrate:local"]) {
  if (!pkg.scripts[name]?.startsWith("./start-rust.sh")) throw new Error(`Runtime command is not native: ${name}`);
}
const scheduler = readFileSync(resolve(root, "backend/src/scheduler.rs"), "utf8");
if (!scheduler.includes("config/app/local-runtime.json") || /wrangler\.jsonc|publishCompletedReportsToProduction/.test(scheduler)) throw new Error("Native scheduler must use local configuration without cloud publication");
if (existsSync(resolve(root, "src"))) throw new Error("Retired TypeScript backend source tree must not be restored");
for (const file of ["wrangler.json", "wrangler.jsonc", "wrangler.toml", "deploy-cloudflare.sh", "rollback-cloudflare.sh"]) {
  if (existsSync(resolve(root, file))) throw new Error(`Retired cloud deployment file must not be restored: ${file}`);
}
for (const file of walk(resolve(root, "backend"))) {
  if (/\.(?:[cm]?js|[cm]?ts|tsx|jsx)$/.test(file)) throw new Error(`Rust backend must not retain JavaScript or TypeScript implementations: ${file}`);
  if (file.endsWith(".rs") && /Command::new\(\s*["'](?:node|nodejs|tsx|deno|bun)["']/.test(readFileSync(file, "utf8"))) throw new Error(`Native backend must not spawn a JavaScript runtime: ${file}`);
}
const paths = new Set();
for (const page of pages) {
  if (paths.has(page.path) || !["local", "all"].includes(page.runtime)) throw new Error(`Invalid page policy: ${page.path}`);
  paths.add(page.path);
}
console.log("Local-only native runtime, retired backend/cloud sources, no remote publication and page policy passed.");
function walk(path) {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    if (entry.isSymbolicLink() || ["target", "node_modules", ".git"].includes(entry.name)) return [];
    return entry.isDirectory() ? walk(resolve(path, entry.name)) : entry.isFile() ? [resolve(path, entry.name)] : [];
  });
}

const browserRuntime = readFileSync(resolve(root, "backend/src/web_workflow.rs"), "utf8");
if (!browserRuntime.includes("local_web_workflow_runs_v1") || existsSync(resolve(root,"backend/src/research/taskd.rs")) || /TASKD_BASE_URL|TASKD_NAMESPACE|TASKD_CALLER_TOKEN/.test(native)) throw new Error("Browser research must use the local CEA SDK, not taskd");
for (const file of walk(resolve(root,"backend/src"))) {
  if (file.endsWith(".rs") && /TASKD_BASE_URL|TASKD_CALLER_TOKEN|STOCK_INFO_TASKD_CALLER_TOKEN/.test(readFileSync(file,"utf8"))) throw new Error(`Retired taskd transport restored: ${file}`);
}
