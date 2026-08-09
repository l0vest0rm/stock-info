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
database.exec(`${LOCAL_SQLITE_CONNECTION_PRAGMAS.join("\n")}\ncreate table if not exists _local_migrations (filename text primary key, applied_at integer not null);`);
const known = new Set(database.prepare("select filename from _local_migrations").all().map((row) => row.filename));
const migrations = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
let applied = 0;
for (const filename of migrations) {
  if (known.has(filename)) continue;
  const sql = await readFile(join(migrationsDir, filename), "utf8");
  database.exec("begin immediate");
  try {
    database.exec(sql);
    database.prepare("insert into _local_migrations (filename, applied_at) values (?, ?)").run(filename, Date.now());
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
