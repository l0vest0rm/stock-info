#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const base = process.env.SMOKE_BASE_URL || "https://tinfo.cc";
const pages = JSON.parse(readFileSync(resolve(import.meta.dirname, "../config/page-manifest.json"), "utf8"));
const healthResponse = await fetch(new URL("/api/health", base), { signal: AbortSignal.timeout(20_000) });
if (!healthResponse.ok) throw new Error(`Health HTTP ${healthResponse.status}`);
const health = await healthResponse.json();
if (health.code !== 200 || health.data?.d1 !== true) throw new Error("Production database health failed");
if (process.env.EXPECTED_APP_VERSION && health.data.version !== process.env.EXPECTED_APP_VERSION) throw new Error(`Unexpected deployed version: ${health.data.version}`);
for (const page of pages) {
  const path = page.path === "/home.html" ? "/" : page.path;
  const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(20_000) });
  const expected = page.runtime === "local" ? 404 : 200;
  if (response.status !== expected) throw new Error(`${path}: expected ${expected}, received ${response.status}`);
  if (expected === 200 && !(await response.text()).includes("<!doctype html>")) throw new Error(`Expected HTML: ${path}`);
}
console.log("Production version, D1 health and all page runtime policies passed.");
