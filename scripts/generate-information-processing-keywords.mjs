#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const snapshotPath = resolve(root, "web/src/config/institutional-track-snapshot.json");
const outputPath = resolve(root, readOption("--output") || "config/information-processing-institutional-top300.json");
const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));

if (!Array.isArray(snapshot.rows) || snapshot.rows.length !== 300) {
  throw new Error(`expected the institutional snapshot to contain exactly 300 rows, received ${Array.isArray(snapshot.rows) ? snapshot.rows.length : 0}`);
}

const keywords = snapshot.rows.map((row, index) => {
  const rank = Number(row?.rank);
  const name = String(row?.name || "").trim();
  if (!Number.isInteger(rank) || rank !== index + 1 || !name) {
    throw new Error(`invalid Top300 row at position ${index + 1}`);
  }
  return name;
});

if (new Set(keywords).size !== keywords.length) {
  throw new Error("institutional snapshot contains duplicate company names");
}

await writeFile(outputPath, `${JSON.stringify(keywords, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ outputPath, keywords: keywords.length, dataDate: snapshot.dataDate || "" }, null, 2));

function readOption(option) {
  const index = process.argv.indexOf(option);
  if (index < 0) return "";
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a file path`);
  return value;
}
