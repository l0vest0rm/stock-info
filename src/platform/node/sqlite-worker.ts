import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

const db = new DatabaseSync(workerData.file);
db.exec("pragma busy_timeout=30000; pragma foreign_keys=ON;");
// WAL is a database-wide setting. A second local worker may open while the
// first one is switching modes; it must keep serving instead of crashing its
// own HTTP process. The first successful opener establishes the shared mode.
try {
  db.exec("pragma journal_mode=WAL;");
} catch (error) {
  if (!(error && typeof error === "object" && "code" in error && error.code === "ERR_SQLITE_ERROR")) throw error;
  console.warn(JSON.stringify({ event: "local_sqlite_wal_mode_deferred", reason: "database_locked" }));
}
type Query = { sql: string; values: SQLInputValue[] };
type Command = { id: number; kind: "first" | "all" | "run" | "raw" | "batch" | "exec"; query?: Query; queries?: Query[]; column?: string; columnNames?: boolean };

function execute(query: Query, kind: string, column?: string, columnNames = false): unknown {
  const started = performance.now();
  const statement = db.prepare(query.sql);
  if (kind === "first") {
    const row = statement.get(...query.values);
    return row ? (column ? row[column] ?? null : { ...row }) : null;
  }
  if (kind === "raw") {
    const columns = statement.columns().map((item) => item.name);
    const rows = statement.all(...query.values).map((row) => columns.map((name) => row[name]));
    return columnNames ? [columns, ...rows] : rows;
  }
  const results = kind === "all" ? statement.all(...query.values).map((row) => ({ ...row })) : [];
  const changed = kind === "run" ? statement.run(...query.values) : null;
  return { success: true, results, meta: {
    served_by: "local-node-sqlite", duration: performance.now() - started,
    changes: Number(changed?.changes ?? 0), last_row_id: Number(changed?.lastInsertRowid ?? 0),
    changed_db: Boolean(changed?.changes), size_after: 0, rows_read: results.length,
    rows_written: Number(changed?.changes ?? 0),
  } };
}

parentPort!.on("message", (command: Command) => {
  const started = performance.now();
  try {
    let value: unknown;
    if (command.kind === "batch") {
      db.exec("begin immediate");
      try {
        value = command.queries!.map((query) => execute(query, db.prepare(query.sql).columns().length ? "all" : "run"));
        db.exec("commit");
      } catch (error) { db.exec("rollback"); throw error; }
    } else if (command.kind === "exec") {
      db.exec(command.query!.sql);
      value = { count: 0, duration: performance.now() - started };
    } else {
      value = execute(command.query!, command.kind, command.column, command.columnNames);
    }
    parentPort!.postMessage({ id: command.id, value });
  } catch (error) {
    parentPort!.postMessage({ id: command.id, error: error instanceof Error ? error.message : String(error) });
  } finally {
    const durationMs = performance.now() - started;
    if (durationMs >= 100) console.warn(JSON.stringify({ event: "local_sqlite_slow_operation", operation: command.kind, durationMs: Math.round(durationMs), execution: "worker-thread" }));
  }
});
