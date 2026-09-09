#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const pages = JSON.parse(readFileSync(resolve(root, "config/page-manifest.json"), "utf8"));
const production = process.argv.includes("--production");
for (const page of pages) {
  const path = resolve(root, "web/dist", page.path.slice(1));
  if (production && page.runtime === "local") {
    if (existsSync(path)) throw new Error(`Local page shipped to production: ${page.path}`);
    continue;
  }
  if (!existsSync(path)) throw new Error(`Missing built page: ${page.path}`);
  const html = readFileSync(path, "utf8");
  for (const script of html.matchAll(/<script\b([^>]*?)src=["']([^"']+)["'][^>]*>/gi)) {
    if (/^(?:https?:)?\/\//.test(script[2])) continue;
    if (!existsSync(resolve(root, "web/dist", script[2].replace(/^\//, "")))) throw new Error(`Missing script for ${page.path}: ${script[2]}`);
    if (script[2].startsWith("js/") && !/type=["']module["']/.test(script[0])) throw new Error(`ESM script is not marked module: ${page.path} ${script[2]}`);
  }
}
console.log(`Page artifacts verified for ${production ? "production" : "local"} runtime.`);
