#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log("Usage: node scripts/check-no-wrangler-local.mjs [--root PATH]\n\nRejects executable local project paths that invoke Wrangler with --local. Wrangler remains permitted for remote, dry-run, and deploy commands.");
  process.exit(0);
}

const scanRoot = resolve(root, args.root || ".");
const files = executableFiles(scanRoot);
const violations = files.flatMap((file) => findViolations(file, scanRoot));
if (violations.length > 0) {
  console.error("Wrangler --local is forbidden in executable local paths. Use Node SQLite via LOCAL_DB_PATH instead:");
  for (const violation of violations) console.error(`- ${violation.file}:${violation.line}: ${violation.text}`);
  process.exitCode = 1;
} else {
  console.log(`No Wrangler --local invocation found in ${files.length} executable local files.`);
}

function parseArgs(argv) {
  const parsed = { root: "", help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") parsed.root = requiredValue(argv, ++index, arg);
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return parsed;
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value) throw new Error(`missing value for ${flag}`);
  return value;
}

function executableFiles(scanRoot) {
  const include = new Set([".mjs", ".cjs", ".js", ".sh", ".json"]);
  const excludedDirectories = new Set([".git", ".wrangler", "node_modules", "web", "data"]);
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name)) visit(resolve(directory, entry.name));
        continue;
      }
      if (!entry.isFile() || entry.name.endsWith(".test.mjs") || entry.name === "check-no-wrangler-local.mjs") continue;
      const file = resolve(directory, entry.name);
      if (include.has(extension(entry.name)) || entry.name === "start-local.sh") files.push(file);
    }
  };
  visit(scanRoot);
  return files.sort();
}

function findViolations(file, scanRoot) {
  const source = readFileSync(file, "utf8");
  const violations = [];
  const commandPatterns = [
    /\[\s*["']wrangler["']([\s\S]{0,480}?)\]/g,
    /(?:execFile|spawn)(?:Sync)?\(\s*["']wrangler["']\s*,\s*\[([\s\S]{0,480}?)\]\s*[,)]/g,
  ];
  for (const pattern of commandPatterns) {
    for (const match of source.matchAll(pattern)) {
      if (!String(match[0]).includes("--local")) continue;
      violations.push(describeViolation(file, scanRoot, source, match.index || 0));
    }
  }
  for (const [lineIndex, line] of source.split("\n").entries()) {
    if (/\b(?:npx\s+)?wrangler\b[^\n]*--local\b/.test(line)) {
      violations.push({ file: relative(scanRoot, file) || file, line: lineIndex + 1, text: line.trim() });
    }
  }
  return violations;
}

function describeViolation(file, scanRoot, source, index) {
  const line = source.slice(0, index).split("\n").length;
  const end = source.indexOf("\n", index);
  return {
    file: relative(scanRoot, file) || file,
    line,
    text: source.slice(index, end === -1 ? source.length : end).trim(),
  };
}

function extension(name) {
  const index = name.lastIndexOf(".");
  return index === -1 ? "" : name.slice(index);
}
