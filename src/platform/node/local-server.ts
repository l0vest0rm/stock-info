import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { createRouter } from "../../app/router";
import { createLocalBindings } from "./local-bindings";

const { createKnowledgeContentServer } = await import(pathToFileURL(resolve(process.cwd(), "scripts/local-knowledge-content-server.mjs")).href);

// @ts-expect-error Node-only review adapter is bundled from JavaScript.
import { createLocalReportHandler } from "../../../scripts/lib/featured-report-local.mjs";
// @ts-expect-error Node-only local audit adapter is JavaScript.
import { readRejectedFeed } from "../../../scripts/lib/information-feed-rejection-audit.mjs";
// @ts-expect-error Node-only Sub2Me callback adapter is JavaScript.
import { createSub2meCallbackHandler, registerSub2meSubscription } from "../../../scripts/lib/sub2me-callback.mjs";

const host = process.env.HOST || "127.0.0.1";
const port = positivePort(process.env.PORT || "8000");
const contentPort = positivePort(process.env.KNOWLEDGE_CONTENT_LOCAL_PORT || "8788");
const localReportHandler = createLocalReportHandler(port);
const bindings = createLocalBindings();
const app = createRouter();
const sub2meTask = bindings.SUB2ME_TASK || "cls-telegraph";
const sub2meCallback = createSub2meCallbackHandler({ token: bindings.SUB2ME_CALLBACK_TOKEN, task: sub2meTask,
  inputDir: process.env.INFORMATION_FEED_INPUT_DIR });
let sub2meTimer: ReturnType<typeof setInterval> | null = null;
let sub2meRegistering = false;

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

server.listen(port, host, () => {
  localRuntimeLog("ready", { http_url: `http://${host}:${port}` });
  if (bindings.SUB2ME_BASE_URL && bindings.SUB2ME_CALLBACK_TOKEN) {
    void registerSubscription();
    sub2meTimer = setInterval(() => { void registerSubscription(); }, 60_000);
  } else localRuntimeLog("sub2me_subscription_disabled", { reason: "SUB2ME_BASE_URL or SUB2ME_CALLBACK_TOKEN missing" });
});
const contentServer = createKnowledgeContentServer();
contentServer.listen(contentPort, host, () => localRuntimeLog("content_ready", { content_url: `http://${host}:${contentPort}` }));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => closeServers());
}

function closeServers(): void {
  if (sub2meTimer) clearInterval(sub2meTimer);
  let remaining = 2;
  const closed = () => {
    remaining -= 1;
    if (remaining === 0) process.exit(0);
  };
  server.close(closed);
  contentServer.close(closed);
}

async function handle(incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
  const url = new URL(incoming.url || "/", `http://${incoming.headers.host || `${host}:${port}`}`);
  if (await sub2meCallback.handle(incoming, outgoing)) return;
  if (url.pathname === "/api/local/information-feed/rejected") {
    if (incoming.method !== "GET") {
      outgoing.writeHead(405, { "content-type": "application/json; charset=utf-8" });
      outgoing.end(JSON.stringify({ code: 405, msg: "method not allowed", data: null }));
      return;
    }
    outgoing.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    outgoing.end(JSON.stringify({ code: 200, msg: "OK", data: readRejectedFeed(Object.fromEntries(url.searchParams)) }));
    return;
  }
  if (await localReportHandler(incoming, outgoing)) return;
  const request = toWebRequest(incoming);
  const context = { waitUntil(promise: Promise<unknown>) { void promise.catch((error) => localRuntimeError("wait_until_failed", error)); }, passThroughOnException() {} } as unknown as ExecutionContext;
  const response = await app.fetch(request, bindings, context);
  outgoing.statusCode = response.status;
  for (const [name, value] of response.headers) outgoing.setHeader(name, value);
  if (!response.body) return void outgoing.end();
  Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream).pipe(outgoing);
}

async function registerSubscription(): Promise<void> {
  if (sub2meRegistering) return;
  sub2meRegistering = true;
  try {
    const result = await registerSub2meSubscription({
      baseUrl: bindings.SUB2ME_BASE_URL,
      callbackUrl: bindings.SUB2ME_CALLBACK_URL || `http://127.0.0.1:${port}/api/local/sub2me/callback`,
      token: bindings.SUB2ME_CALLBACK_TOKEN,
      task: sub2meTask,
      onRecord: sub2meCallback.storeRecord,
    });
    localRuntimeLog("sub2me_subscribed", { subscription_id: result.id, task: sub2meTask, backfilled: result.stored });
  } catch (error) { localRuntimeError("sub2me_subscription_failed", error); }
  finally { sub2meRegistering = false; }
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
