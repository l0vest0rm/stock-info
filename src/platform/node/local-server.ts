import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { createRouter } from "../../app/router";
import { createLocalBindings } from "./local-bindings";

const { createKnowledgeContentServer } = await import(pathToFileURL(resolve(process.cwd(), "scripts/local-knowledge-content-server.mjs")).href);

const host = process.env.HOST || "127.0.0.1";
const port = positivePort(process.env.PORT || "8000");
const contentPort = positivePort(process.env.KNOWLEDGE_CONTENT_LOCAL_PORT || "8788");
const bindings = createLocalBindings();
const app = createRouter();

function localRuntimeLog(event: string, details: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({
    time: new Date().toISOString(), role: "local-http", pid: process.pid,
    run_id: process.env.LOCAL_SUPERVISOR_RUN_ID || `standalone-${process.pid}`,
    job_id: null, attempt: null, duration_ms: null, error: null, ...details, event,
  })}\n`);
}

function localRuntimeError(event: string, error: unknown, details: Record<string, unknown> = {}): void {
  localRuntimeLog(event, { ...details, error: error instanceof Error ? error.message : String(error) });
}

const server = createServer((request, response) => {
  void handle(request, response).catch((error) => {
    localRuntimeError("request_failed", error);
    if (!response.headersSent) response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ code: 500, msg: error instanceof Error ? error.message : String(error), data: null }));
  });
});

server.listen(port, host, () => localRuntimeLog("ready", { http_url: `http://${host}:${port}` }));
const contentServer = createKnowledgeContentServer();
contentServer.listen(contentPort, host, () => localRuntimeLog("content_ready", { content_url: `http://${host}:${contentPort}` }));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => closeServers());
}

function closeServers(): void {
  let remaining = 2;
  const closed = () => {
    remaining -= 1;
    if (remaining === 0) process.exit(0);
  };
  server.close(closed);
  contentServer.close(closed);
}

async function handle(incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
  const request = toWebRequest(incoming);
  const context = { waitUntil(promise: Promise<unknown>) { void promise.catch((error) => localRuntimeError("wait_until_failed", error)); }, passThroughOnException() {} } as unknown as ExecutionContext;
  const response = await app.fetch(request, bindings, context);
  outgoing.statusCode = response.status;
  for (const [name, value] of response.headers) outgoing.setHeader(name, value);
  if (!response.body) return void outgoing.end();
  Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream).pipe(outgoing);
}

function toWebRequest(request: IncomingMessage): Request {
  const url = new URL(request.url || "/", `http://${request.headers.host || `${host}:${port}`}`);
  const method = request.method || "GET";
  return new Request(url, { method, headers: request.headers as HeadersInit, body: method === "GET" || method === "HEAD" ? undefined : Readable.toWeb(request) as unknown as ReadableStream, duplex: "half" } as any);
}

function positivePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid PORT: ${value}`);
  return port;
}
