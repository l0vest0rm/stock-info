#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDirectory, "..");
const defaultAllowlistPath = resolve(scriptDirectory, "check-no-new-tables-allowlist.json");
const createTablePattern =
  /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_]*))/gi;

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(
    "Usage: node scripts/check-no-new-tables.mjs [--root PATH] [--allowlist FILE]\n\nRejects migrations that introduce CREATE TABLE statements for table names outside the approved allowlist."
  );
  process.exit(0);
}

const scanRoot = resolve(root, args.root || ".");
const migrationsDirectory = resolve(scanRoot, "migrations");
const allowlistPath = resolve(scanRoot, args.allowlist || relative(scanRoot, defaultAllowlistPath));
const allowlist = new Set(JSON.parse(readFileSync(allowlistPath, "utf8")));
const violations = findViolations(migrationsDirectory, allowlist, scanRoot);

if (violations.length > 0) {
  console.error("New database tables require explicit user approval first. Update the allowlist only after approval:");
  for (const violation of violations) {
    console.error(`- ${violation.file}:${violation.line}: ${violation.table}`);
  }
  process.exitCode = 1;
} else {
  console.log(`No unapproved CREATE TABLE statements found in ${countSqlFiles(migrationsDirectory)} migration files.`);
}

function parseArgs(argv) {
  const parsed = { root: "", allowlist: "", help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") parsed.root = requiredValue(argv, ++index, arg);
    else if (arg === "--allowlist") parsed.allowlist = requiredValue(argv, ++index, arg);
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

function findViolations(migrationsDirectory, allowlist, scanRoot) {
  const files = readdirSync(migrationsDirectory)
    .filter((entry) => entry.endsWith(".sql"))
    .sort();
  const violations = [];
  for (const file of files) {
    const absoluteFile = resolve(migrationsDirectory, file);
    const source = readFileSync(absoluteFile, "utf8");
    for (const match of source.matchAll(createTablePattern)) {
      const table = normalizeIdentifier(match[1] || match[2] || match[3] || match[4] || "");
      if (!table || allowlist.has(table)) continue;
      const index = match.index ?? 0;
      violations.push({
        file: relative(scanRoot, absoluteFile) || absoluteFile,
        line: source.slice(0, index).split("\n").length,
        table,
      });
    }
  }
  return violations;
}

function normalizeIdentifier(name) {
  return name.trim();
}

function countSqlFiles(migrationsDirectory) {
  return readdirSync(migrationsDirectory).filter((entry) => entry.endsWith(".sql")).length;
}
