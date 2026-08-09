import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const LOCAL_SQLITE_BUSY_TIMEOUT_MS = 30000;

// Keep command-line maintenance tools on the same locking contract as the Node
// HTTP runtime. A batch owns the write lock for exactly one SQL input file.
export const LOCAL_SQLITE_CONNECTION_PRAGMAS = [
  "PRAGMA journal_mode=WAL;",
  "PRAGMA foreign_keys=ON;",
  `PRAGMA busy_timeout=${LOCAL_SQLITE_BUSY_TIMEOUT_MS};`,
];

export function executeLocalD1SqlFile(sqlFile, options = {}) {
  const sql = readFileSync(sqlFile, "utf8");
  return executeLocalD1Sql(sql, options);
}

export function executeLocalD1Sql(sql, options = {}) {
  const databaseFile = resolveLocalD1Database(options);
  const transaction = [
    ...LOCAL_SQLITE_CONNECTION_PRAGMAS,
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

export function queryLocalD1Sql(sql, options = {}) {
  const databaseFile = resolveLocalD1Database(options);
  const output = execFileSync(
    "sqlite3",
    ["-json", "-readonly", databaseFile],
    {
      input: [`.timeout ${LOCAL_SQLITE_BUSY_TIMEOUT_MS}`, sql, ""].join("\n"),
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
      maxBuffer: options.maxBuffer || 50 * 1024 * 1024,
    }
  ).trim();
  return output ? JSON.parse(output) : [];
}

export function resolveLocalD1Path(options = {}) {
  const root = resolve(options.root || process.cwd());
  const env = options.env || process.env;
  const configured = text(options.path || env.LOCAL_DB_PATH);
  if (configured) return resolve(root, configured);
  const dataDir = text(env.LOCAL_DATA_DIR);
  return resolve(root, dataDir || "data/local", "stock-info.sqlite");
}

export function prepareLocalD1DatabasePath(options = {}) {
  const file = resolveLocalD1Path(options);
  mkdirSync(dirname(file), { recursive: true });
  return file;
}

export function resolveLocalD1Database(options = {}) {
  const requiredTable = text(options.requiredTable);
  if (!requiredTable) {
    throw new Error("requiredTable is required to resolve the local D1 database");
  }
  const file = resolveLocalD1Path(options);
  assertDatabase(file, requiredTable);
  return file;
}

function assertDatabase(file, requiredTable) {
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new Error(`configured local SQLite database does not exist: ${file}`);
  }
  if (!hasTable(file, requiredTable)) {
    throw new Error(`configured local SQLite database is missing table ${requiredTable}: ${file}`);
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
