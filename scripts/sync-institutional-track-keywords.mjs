#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const snapshotPath = resolve(root, "web/src/config/institutional-track-snapshot.json");
const defaultGroupsPath = "/Users/terry/git/mitmproxy/config/capture-title-keyword-filters/shared-groups.json";
const args = new Set(process.argv.slice(2));
const groupsPath = readOption("--groups-file") || defaultGroupsPath;
const checkOnly = args.has("--check");

const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
const names = top300Names(snapshot);
const groupsPayload = JSON.parse(await readFile(groupsPath, "utf8"));
if (!groupsPayload.groups || typeof groupsPayload.groups !== "object" || Array.isArray(groupsPayload.groups)) {
  throw new Error(`invalid keyword groups payload: ${groupsPath}`);
}

const existing = Array.isArray(groupsPayload.groups.institutionalTop300)
  ? groupsPayload.groups.institutionalTop300.map(String)
  : [];
const missing = names.filter((name) => !existing.includes(name));
const extra = existing.filter((name) => !names.includes(name));
const ordered = existing.length === names.length && missing.length === 0 && extra.length === 0
  && existing.every((name, index) => name === names[index]);

if (checkOnly) {
  if (!ordered) {
    throw new Error(`institutionalTop300 is out of sync: missing=${missing.length}, extra=${extra.length}`);
  }
  console.log(JSON.stringify({ groupsPath, keywords: names.length, inSync: true }, null, 2));
} else {
  groupsPayload.groups.institutionalTop300 = names;
  await writeFile(groupsPath, `${JSON.stringify(groupsPayload, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ groupsPath, keywords: names.length, added: missing.length, removed: extra.length }, null, 2));
}

function top300Names(payload) {
  if (!Array.isArray(payload.rows) || payload.rows.length !== 300) {
    throw new Error(`expected institutional snapshot to contain exactly 300 rows, received ${Array.isArray(payload.rows) ? payload.rows.length : 0}`);
  }
  const names = payload.rows.map((row) => String(row?.name || "").trim());
  if (names.some((name) => !name)) throw new Error("institutional snapshot contains an empty company name");
  if (new Set(names).size !== names.length) throw new Error("institutional snapshot contains duplicate company names");
  return names;
}

function readOption(option) {
  const index = process.argv.indexOf(option);
  if (index < 0) return "";
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a file path`);
  return resolve(value);
}
