import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { Bindings } from "../../types";

type SqlValue = string | number | null | ArrayBuffer | ArrayBufferView;

type LocalD1Meta = {
  served_by: "local-node-sqlite";
  duration: number;
  changes: number;
  last_row_id: number;
  changed_db: true;
  size_after: number;
  rows_read: number;
  rows_written: number;
};

export class LocalD1Database {
  private readonly database: DatabaseSync;

  constructor(file: string) {
    this.database = new DatabaseSync(file);
    this.database.exec("pragma journal_mode = WAL; pragma foreign_keys = on; pragma busy_timeout = 30000;");
  }

  prepare(query: string): LocalD1PreparedStatement {
    return new LocalD1PreparedStatement(this.database.prepare(query));
  }

  async batch<T = unknown>(statements: LocalD1PreparedStatement[]): Promise<D1Result<T>[]> {
    const lockStartedAt = performance.now();
    this.database.exec("begin immediate");
    const lockWaitMs = performance.now() - lockStartedAt;
    if (lockWaitMs >= 100) {
      console.warn(JSON.stringify({
        event: "local_sqlite_write_lock_wait",
        lockWaitMs: Math.round(lockWaitMs),
        statements: statements.length,
      }));
    }
    try {
      const results = await Promise.all(statements.map((statement) => statement.run<T>()));
      this.database.exec("commit");
      return results;
    } catch (error) {
      this.database.exec("rollback");
      throw error;
    }
  }

  async exec(query: string): Promise<D1ExecResult> {
    const startedAt = performance.now();
    this.database.exec(query);
    return { count: 0, duration: performance.now() - startedAt };
  }
}

export class LocalD1PreparedStatement {
  private readonly values: SqlValue[];

  constructor(private readonly statement: StatementSync, values: SqlValue[] = []) {
    this.values = values;
  }

  bind(...values: SqlValue[]): LocalD1PreparedStatement {
    return new LocalD1PreparedStatement(this.statement, values);
  }

  async first<T = unknown>(column?: string): Promise<T | null> {
    const row = this.statement.get(...this.values as any[]) as Record<string, T> | undefined;
    if (!row) return null;
    const normalized = normalizeRow(row);
    return column ? normalized[column] ?? null : normalized as T;
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    const startedAt = performance.now();
    const results = (this.statement.all(...this.values as any[]) as Record<string, unknown>[]).map(normalizeRow) as T[];
    return { success: true, results, meta: localMeta(performance.now() - startedAt, 0, 0, results.length, 0) };
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    const startedAt = performance.now();
    const result = this.statement.run(...this.values as any[]);
    return {
      success: true,
      results: [],
      meta: localMeta(performance.now() - startedAt, Number(result.changes), Number(result.lastInsertRowid), 0, Number(result.changes)),
    };
  }

  async raw<T = unknown>(options?: { columnNames?: boolean }): Promise<T[][]> {
    const rows = this.statement.all(...this.values as any[]) as Record<string, T>[];
    if (rows.length === 0) return [];
    const columns = Object.keys(rows[0]);
    const values = rows.map((row) => columns.map((column) => row[column]));
    return options?.columnNames ? [columns as T[], ...values] : values;
  }
}

export class LocalR2Bucket {
  constructor(private readonly root: string) {}

  async get(key: string): Promise<R2ObjectBody | null> {
    const path = localObjectPath(this.root, key);
    try {
      const bytes = await readFile(path);
      return new LocalR2Object(key, bytes) as unknown as R2ObjectBody;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob): Promise<R2Object> {
    const path = localObjectPath(this.root, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, await objectBytes(value));
    const file = await stat(path);
    return { key, size: file.size, etag: "local", httpEtag: "\"local\"", uploaded: new Date() } as R2Object;
  }
}

class LocalR2Object {
  readonly size: number;
  readonly etag = "local";
  readonly httpEtag = "\"local\"";
  readonly uploaded = new Date();

  constructor(readonly key: string, private readonly bytes: Uint8Array) {
    this.size = bytes.byteLength;
  }

  get body(): ReadableStream<Uint8Array> {
    return new Blob([this.bytes]).stream();
  }

  async text(): Promise<string> { return new TextDecoder().decode(this.bytes); }
  async json<T = unknown>(): Promise<T> { return JSON.parse(await this.text()) as T; }
  async arrayBuffer(): Promise<ArrayBuffer> { return this.bytes.buffer.slice(this.bytes.byteOffset, this.bytes.byteOffset + this.bytes.byteLength) as ArrayBuffer; }
  async blob(): Promise<Blob> { return new Blob([this.bytes]); }
}

export class LocalAssets {
  constructor(private readonly root: string) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const requested = url.pathname === "/" ? "home.html" : url.pathname.replace(/^\/+/, "");
    const path = localObjectPath(this.root, requested);
    try {
      const content = await readFile(path);
      return new Response(content, { headers: { "content-type": contentType(path) } });
    } catch (error) {
      if (!isNotFound(error)) throw error;
      return new Response("not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
  }
}

export function createLocalBindings(root = process.cwd()): Bindings {
  loadLocalDevVars(resolve(root, ".dev.vars"));
  const dataRoot = resolve(root, process.env.LOCAL_DATA_DIR || "data/local");
  const databaseFile = process.env.LOCAL_DB_PATH
    ? resolve(root, process.env.LOCAL_DB_PATH)
    : join(dataRoot, "stock-info.sqlite");
  const knowledgeRoot = resolve(process.env.KNOWLEDGE_CONTENT_LOCAL_DIR || join(dataRoot, "knowledge-content"));
  const credentialStore = resolve(process.env.LOCAL_XUEQIU_CREDENTIAL_STORE || join(dataRoot, "runtime/xueqiu-credential.json"));
  const bindings = {
    ...process.env,
    APP_RUNTIME: "node",
    APP_VERSION: process.env.APP_VERSION || "local-node",
    LLM_RUNTIME: "local",
    DB: new LocalD1Database(databaseFile) as unknown as D1Database,
    MARKET_DATA_BUCKET: new LocalR2Bucket(resolve(process.env.LOCAL_MARKET_DATA_DIR || join(dataRoot, "market-data"))) as unknown as R2Bucket,
    RAW_BUCKET: new LocalR2Bucket(resolve(process.env.LOCAL_RAW_DATA_DIR || join(dataRoot, "raw"))) as unknown as R2Bucket,
    KNOWLEDGE_CONTENT_BUCKET: new LocalR2Bucket(knowledgeRoot) as unknown as R2Bucket,
    ASSETS: new LocalAssets(resolve(process.env.LOCAL_ASSETS_DIR || join(root, "web/dist"))) as unknown as Fetcher,
  } as Bindings;
  Object.defineProperty(bindings, "XUEQIU_COOKIE", {
    enumerable: true,
    get: () => localXueqiuCookie(credentialStore, process.env.XUEQIU_COOKIE || ""),
  });
  return bindings;
}

function localXueqiuCookie(store: string, fallback: string): string {
  try {
    const parsed = JSON.parse(readFileSync(store, "utf8"));
    return typeof parsed?.cookie === "string" && parsed.cookie.trim() ? parsed.cookie.trim() : fallback;
  } catch (error) {
    if (isNotFound(error)) return fallback;
    console.error(`could not read local Xueqiu credential store ${store}`, error);
    return fallback;
  }
}

function loadLocalDevVars(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match || process.env[match[1]] !== undefined) continue;
    const raw = match[2].trim();
    try { process.env[match[1]] = JSON.parse(raw); } catch { process.env[match[1]] = raw; }
  }
}

function localMeta(duration: number, changes: number, lastRowId: number, rowsRead: number, rowsWritten: number): LocalD1Meta {
  return { served_by: "local-node-sqlite", duration, changes, last_row_id: lastRowId, changed_db: true, size_after: 0, rows_read: rowsRead, rows_written: rowsWritten };
}

function normalizeRow<T extends Record<string, unknown>>(row: T): T {
  return Object.fromEntries(Object.entries(row)) as T;
}

function localObjectPath(root: string, key: string): string {
  const candidate = resolve(root, key.replace(/^\/+/, ""));
  if (relative(root, candidate).startsWith("..")) throw new Error(`invalid local object key: ${key}`);
  return candidate;
}

async function objectBytes(value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob): Promise<Uint8Array> {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new Uint8Array(await new Response(value).arrayBuffer());
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function contentType(path: string): string {
  return ({ ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2" } as Record<string, string>)[extname(path).toLowerCase()] || "application/octet-stream";
}
