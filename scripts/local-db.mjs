#!/usr/bin/env node

import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LOCAL_SQLITE_CONNECTION_PRAGMAS, prepareLocalD1DatabasePath } from "./lib/local-d1-sqlite.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("Usage: npm run db:migrate:local\n\nApplies migrations to the local Node SQLite database. Set LOCAL_DB_PATH to override data/local/stock-info.sqlite.");
  process.exit(0);
}
const databaseFile = prepareLocalD1DatabasePath({ root });
const migrationsDir = resolve(root, "migrations");
const database = new DatabaseSync(databaseFile);
database.exec(LOCAL_SQLITE_CONNECTION_PRAGMAS.join("\n"));
const migrations = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
const currentUserVersion = getUserVersion(database);
if (currentUserVersion > migrations.length) {
  throw new Error(`Local migration state exceeds available files: version=${currentUserVersion}, files=${migrations.length}`);
}
let applied = 0;
for (let index = currentUserVersion; index < migrations.length; index += 1) {
  const filename = migrations[index];
  const sql = await readFile(join(migrationsDir, filename), "utf8");
  database.exec("begin immediate");
  try {
    database.exec(sql);
    setUserVersion(database, index + 1);
    database.exec("commit");
    applied += 1;
    console.log(`Applied local migration: ${filename}`);
  } catch (error) {
    database.exec("rollback");
    throw new Error(`Local migration failed: ${filename}`, { cause: error });
  }
}
database.close();
console.log(`Local database ready: ${databaseFile} (${applied} migration${applied === 1 ? "" : "s"} applied)`);

function getUserVersion(databaseHandle) {
  return Number(databaseHandle.prepare("pragma user_version").get()?.user_version ?? 0);
}

function setUserVersion(databaseHandle, version) {
  databaseHandle.exec(`pragma user_version = ${Math.max(0, Number(version) || 0)}`);
}
