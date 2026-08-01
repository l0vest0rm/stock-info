#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { classifyInstitutionalTrackSnapshot } from "./lib/institutional-track-classification.mjs";

const snapshotPath = new URL("../web/src/config/institutional-track-snapshot.json", import.meta.url);
const taxonomyPath = new URL("../web/src/config/institutional-track-taxonomy.json", import.meta.url);
const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
const taxonomy = JSON.parse(await readFile(taxonomyPath, "utf8"));
const classified = classifyInstitutionalTrackSnapshot(snapshot, taxonomy);

await writeFile(snapshotPath, `${JSON.stringify(classified, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  snapshotPath: snapshotPath.pathname,
  classificationVersion: classified.classificationVersion,
  rows: classified.rows.length,
}, null, 2));
