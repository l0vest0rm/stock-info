import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile, rename } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { createHash, randomUUID } from "node:crypto";
import type { Database, PreparedStatement, ObjectBucket, ObjectBody, ObjectInfo, Assets } from "../contracts";
import type { Bindings } from "../../types";

type SqlValue = string | number | null | Uint8Array;

/** SQLite owns a dedicated thread. A 30-second busy wait must not stall HTTP. */
export class LocalD1Database implements Database {
  private readonly worker: Worker;
  private sequence = 0;
  private failure: Error | null = null;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  constructor(file: string) {
    this.worker = new Worker(resolve(process.env.LOCAL_SQLITE_WORKER_PATH || "data/local/runtime/sqlite-worker.mjs"), { workerData: { file } });
    this.worker.on("message", (reply: { id: number; value?: unknown; error?: string }) => {
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      this.pending.delete(reply.id);
      if (this.pending.size === 0) this.worker.unref();
      if (reply.error) pending.reject(new Error(reply.error));
      else pending.resolve(reply.value);
    });
    const fail = (error: Error) => {
      this.failure = error;
      for (const item of this.pending.values()) item.reject(error);
      this.pending.clear();
      this.worker.unref();
    };
    this.worker.on("error", fail);
    this.worker.on("exit", (code) => fail(new Error(`SQLite worker exited: ${code}`)));
    this.worker.unref();
  }

  prepare(sql: string): LocalD1PreparedStatement { return new LocalD1PreparedStatement(this, sql); }

  async batch<T = unknown>(statements: PreparedStatement[]): Promise<D1Result<T>[]> {
    const queries = statements.map((statement) => {
      if (!(statement instanceof LocalD1PreparedStatement) || statement.database !== this) throw new Error("batch statements must belong to this database");
      return { sql: statement.sql, values: statement.values };
    });
    return this.request({ kind: "batch", queries });
  }

  async exec(sql: string): Promise<D1ExecResult> { return this.request({ kind: "exec", query: { sql, values: [] } }); }
  async close(): Promise<void> { await this.worker.terminate(); }

  request<T>(command: Record<string, unknown>): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<T>((resolveRequest, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { resolve: (value) => resolveRequest(value as T), reject });
      this.worker.ref();
      try { this.worker.postMessage({ ...command, id }); }
      catch (error) {
        this.pending.delete(id);
        if (!this.pending.size) this.worker.unref();
        reject(error);
      }
    });
  }
}

export class LocalD1PreparedStatement implements PreparedStatement {
  constructor(readonly database: LocalD1Database, readonly sql: string, readonly values: SqlValue[] = []) {}
  bind(...values: unknown[]): LocalD1PreparedStatement {
    return new LocalD1PreparedStatement(this.database, this.sql, values.map((value) => {
      if (value === null || typeof value === "string" || typeof value === "number") return value;
      if (value instanceof ArrayBuffer) return new Uint8Array(value);
      if (ArrayBuffer.isView(value)) return Uint8Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      throw new TypeError("Unsupported SQL binding type");
    }));
  }
  private query<T>(kind: string, options: Record<string, unknown> = {}): Promise<T> {
    return this.database.request({ kind, query: { sql: this.sql, values: this.values }, ...options });
  }
  first<T = unknown>(column?: string): Promise<T | null> { return this.query("first", { column }); }
  all<T = unknown>(): Promise<D1Result<T>> { return this.query("all"); }
  run<T = unknown>(): Promise<D1Result<T>> { return this.query("run"); }
  raw<T = unknown>(options?: { columnNames?: boolean }): Promise<T[][]> { return this.query("raw", options); }
}

export class LocalR2Bucket implements ObjectBucket {
  constructor(private readonly root: string) {}

  async get(key: string): Promise<ObjectBody | null> {
    const path = localObjectPath(this.root, key);
    try {
      const bytes = await readFile(path);
      const file = await stat(path);
      let metadata: R2HTTPMetadata | undefined;
      try { metadata = JSON.parse(await readFile(this.metadataPath(key), "utf8")); }
      catch (error) { if (!isNotFound(error)) throw error; }
      return new LocalR2Object(key, bytes, file.mtime, metadata);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  private metadataPath(key: string): string {
    return join(this.root, ".object-metadata", createHash("sha256").update(key).digest("hex") + ".json");
  }

  async put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob, options?: { httpMetadata?: R2HTTPMetadata }): Promise<ObjectInfo> {
    const path = localObjectPath(this.root, key);
    const bytes = await objectBytes(value);
    await mkdir(dirname(path), { recursive: true });
    await atomicWrite(path, bytes);
    const metadata = this.metadataPath(key);
    await mkdir(dirname(metadata), { recursive: true });
    await atomicWrite(metadata, JSON.stringify(options?.httpMetadata || {}));
    const file = await stat(path);
    return new LocalR2Object(key, bytes, file.mtime, options?.httpMetadata);
  }
}

class LocalR2Object implements ObjectBody {
  readonly size: number;
  readonly etag: string;
  readonly httpEtag: string;

  constructor(readonly key: string, private readonly bytes: Uint8Array<ArrayBuffer>, readonly uploaded: Date, readonly httpMetadata?: R2HTTPMetadata) {
    this.size = bytes.byteLength;
    this.etag = createHash("md5").update(bytes).digest("hex");
    this.httpEtag = `"${this.etag}"`;
  }
  get body(): ReadableStream<Uint8Array> { return new Blob([this.bytes]).stream(); }
  async text(): Promise<string> { return new TextDecoder().decode(this.bytes); }
  async json<T = unknown>(): Promise<T> { return JSON.parse(await this.text()) as T; }
  async arrayBuffer(): Promise<ArrayBuffer> { return this.bytes.slice().buffer; }
  async blob(): Promise<Blob> { return new Blob([this.bytes]); }
}

async function atomicWrite(path: string, value: Uint8Array | string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, value);
  await rename(temporary, path);
}

export class LocalAssets implements Assets {
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
  const bindings: Bindings = {
    ...process.env,
    APP_RUNTIME: "node",
    APP_VERSION: process.env.APP_VERSION || "local-node",
    LLM_RUNTIME: "local",
    DB: new LocalD1Database(databaseFile),
    MARKET_DATA_BUCKET: new LocalR2Bucket(resolve(process.env.LOCAL_MARKET_DATA_DIR || join(dataRoot, "market-data"))),
    RAW_BUCKET: new LocalR2Bucket(resolve(process.env.LOCAL_RAW_DATA_DIR || join(dataRoot, "raw"))),
    KNOWLEDGE_CONTENT_BUCKET: new LocalR2Bucket(knowledgeRoot),
    ASSETS: new LocalAssets(resolve(process.env.LOCAL_ASSETS_DIR || join(root, "web/dist"))),
  };
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

function localObjectPath(root: string, key: string): string {
  const candidate = resolve(root, key.replace(/^\/+/, ""));
  if (relative(root, candidate).startsWith("..")) throw new Error(`invalid local object key: ${key}`);
  return candidate;
}

async function objectBytes(value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof value === "string") return Uint8Array.from(new TextEncoder().encode(value));
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return Uint8Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  return new Uint8Array(await new Response(value).arrayBuffer());
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function contentType(path: string): string {
  return ({ ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2" } as Record<string, string>)[extname(path).toLowerCase()] || "application/octet-stream";
}
