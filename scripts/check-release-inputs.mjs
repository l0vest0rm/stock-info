#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, relative } from "node:path";

const root = resolve(import.meta.dirname, "..");
const lockPath = resolve(root, "config/release-inputs.lock.json");
const dependencies = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).dependencies;
const packages = Object.entries(dependencies).filter(([, value]) => value.startsWith("file:")).map(([name, specifier]) => {
  const path = resolve(root, specifier.slice(5));
  const manifest = JSON.parse(readFileSync(resolve(path, "package.json"), "utf8"));
  const files = ["package.json", ...walk(resolve(path, "dist")).map((file) => relative(path, file))].sort();
  const hash = createHash("sha256");
  for (const file of files) hash.update(file).update("\0").update(readFileSync(resolve(path, file))).update("\0");
  return { name, specifier, version: manifest.version, revision: execFileSync("git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), sha256: hash.digest("hex") };
}).sort((a, b) => a.name.localeCompare(b.name));
const actual = { schemaVersion: 1, packages };
if (process.argv.includes("--update")) {
  writeFileSync(lockPath, JSON.stringify(actual, null, 2) + "\n");
  console.log("Recorded package revisions and hashes in config/release-inputs.lock.json; review this file before release.");
} else {
  const expected = JSON.parse(readFileSync(lockPath, "utf8"));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Local package release inputs changed. Review shared-ts revisions and rebuild its packages, then explicitly update config/release-inputs.lock.json.");
  console.log("Release package revisions and contents match the reviewed lock.");
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Release input must not be a symlink: ${path}`);
    return entry.isDirectory() ? walk(path) : [path];
  });
}
