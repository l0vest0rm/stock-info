#!/usr/bin/env node

import http from "node:http";

const host = "127.0.0.1";
const port = positiveInteger(process.env.MACRO_FETCH_RELAY_PORT) ?? 8791;
const allowedHosts = new Set([
  "api.bls.gov",
  "api.stlouisfed.org",
  "fred.stlouisfed.org",
]);

const server = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/__health") {
    send(response, 200, "application/json", JSON.stringify({ ok: true }));
    return;
  }
  if (request.method !== "POST" || request.url !== "/fetch") {
    send(response, 404, "text/plain; charset=utf-8", "not found");
    return;
  }
  try {
    const payload = JSON.parse(await readBody(request, 256_000));
    const target = new URL(String(payload.url ?? ""));
    if (target.protocol !== "https:" || !allowedHosts.has(target.hostname.toLowerCase())) {
      send(response, 403, "text/plain; charset=utf-8", "target host is not allowed");
      return;
    }
    const method = String(payload.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "POST") {
      send(response, 405, "text/plain; charset=utf-8", "method is not allowed");
      return;
    }
    const headers = sanitizeHeaders(payload.headers);
    const upstream = await fetch(target, {
      method,
      headers,
      body: method === "POST" && typeof payload.body === "string" ? payload.body : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    response.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
      "Content-Length": String(body.length),
      "Cache-Control": "no-store",
    });
    response.end(body);
  } catch (error) {
    send(response, 502, "text/plain; charset=utf-8", error instanceof Error ? error.message : String(error));
  }
});

server.listen(port, host, () => {
  console.log(`Local macro fetch relay listening on http://${host}:${port}`);
});

function sanitizeHeaders(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const allowed = new Set(["accept", "accept-language", "content-type", "user-agent"]);
  return Object.fromEntries(Object.entries(value)
    .filter(([key, item]) => allowed.has(key.toLowerCase()) && typeof item === "string")
    .map(([key, item]) => [key, item]));
}

async function readBody(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("request body is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(response, status, contentType, body) {
  response.writeHead(status, { "Content-Type": contentType, "Content-Length": String(Buffer.byteLength(body)) });
  response.end(body);
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
