import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

export function executeLocalD1SqlFile(sqlFile, options = {}) {
  const databaseFile = resolveLocalD1Database(options);
  const sql = readFileSync(sqlFile, "utf8");
  const transaction = [
    "PRAGMA foreign_keys=ON;",
    "PRAGMA busy_timeout=30000;",
    "BEGIN IMMEDIATE;",
    sql,
    "COMMIT;",
    "",
  ].join("\n");
  try {
    execFileSync(
      "sqlite3",
      ["-bail", databaseFile],
      {
        input: transaction,
        stdio: ["pipe", "ignore", "pipe"],
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      }
    );
  } catch (error) {
    if (error.stderr) process.stderr.write(error.stderr);
    throw error;
  }
  return databaseFile;
}

export function resolveLocalD1Database(options = {}) {
  const requiredTable = text(options.requiredTable);
  if (!requiredTable) {
    throw new Error("requiredTable is required to resolve the local D1 database");
  }
  const configured = text(process.env.KNOWLEDGE_IMPORT_LOCAL_D1_FILE);
  if (configured) {
    const file = resolve(configured);
    assertDatabase(file, requiredTable);
    return file;
  }
  const stateDir = resolve(
    options.root || process.cwd(),
    text(process.env.WRANGLER_PERSIST_TO) || ".wrangler/state/v3",
    "d1/miniflare-D1DatabaseObject"
  );
  if (!existsSync(stateDir)) {
    throw new Error(`local Wrangler D1 state directory does not exist: ${stateDir}; run local migrations first`);
  }
  const candidates = readdirSync(stateDir)
    .filter((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite")
    .map((name) => resolve(stateDir, name))
    .filter((file) => statSync(file).isFile())
    .filter((file) => hasTable(file, requiredTable));
  if (candidates.length !== 1) {
    throw new Error(
      `expected one local D1 database containing ${requiredTable}, found ${candidates.length} in ${stateDir}; `
      + "set KNOWLEDGE_IMPORT_LOCAL_D1_FILE explicitly"
    );
  }
  return candidates[0];
}

function assertDatabase(file, requiredTable) {
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new Error(`configured local D1 database does not exist: ${file}`);
  }
  if (!hasTable(file, requiredTable)) {
    throw new Error(`configured local D1 database is missing table ${requiredTable}: ${file}`);
  }
}

function hasTable(file, table) {
  const sql = `select count(*) from sqlite_master where type='table' and name=${q(table)};`;
  try {
    return execFileSync("sqlite3", ["-batch", file, sql], { encoding: "utf8" }).trim() === "1";
  } catch {
    return false;
  }
}

function q(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function text(value) {
  return String(value ?? "").trim();
}
