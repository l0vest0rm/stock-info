/** The storage surface used by business code. Cloudflare bindings satisfy it
 * structurally; local adapters implement it without claiming the full SDK. */
export interface PreparedStatement {
  bind(...values: unknown[]): PreparedStatement;
  first<T = unknown>(column?: string): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run<T = unknown>(): Promise<D1Result<T>>;
  raw<T = unknown>(options?: { columnNames?: boolean }): Promise<T[][]>;
}

export interface Database {
  prepare(sql: string): PreparedStatement;
  batch<T = unknown>(statements: PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(sql: string): Promise<D1ExecResult>;
}

export interface ObjectInfo {
  key: string;
  size: number;
  etag: string;
  httpEtag: string;
  uploaded: Date;
  httpMetadata?: R2HTTPMetadata;
}

export interface ObjectBody extends ObjectInfo {
  readonly body: ReadableStream<Uint8Array>;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  arrayBuffer(): Promise<ArrayBuffer>;
  blob(): Promise<Blob>;
}

export interface ObjectBucket {
  get(key: string): Promise<ObjectBody | null>;
  put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob,
    options?: { httpMetadata?: R2HTTPMetadata }): Promise<ObjectInfo | null>;
}

export interface Assets {
  fetch(request: Request): Promise<Response>;
}

// Checked by the Worker typecheck: an SDK update cannot silently break these ports.
type Assert<T extends true> = T;
type CloudflareDatabaseContract = Assert<D1Database extends Database ? true : false>;
type CloudflareBucketContract = Assert<R2Bucket extends ObjectBucket ? true : false>;
type CloudflareAssetsContract = Assert<Fetcher extends Assets ? true : false>;
