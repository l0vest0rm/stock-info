#!/usr/bin/env node

import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";

const args = parseArgs(process.argv.slice(2));
const host = args.host || "127.0.0.1";
const port = Number(args.port || process.env.KNOWLEDGE_CONTENT_LOCAL_PORT || 8788);
const contentDir = resolve(args.dir || process.env.KNOWLEDGE_CONTENT_LOCAL_DIR || "/Users/terry/git/data/stock-info/knowledge/content-cache");

const server = createServer((req, res) => {
  const method = String(req.method || "GET").toUpperCase();
  if (req.url === "/__health") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    res.writeHead(405, { "access-control-allow-origin": "*" });
    res.end("method not allowed");
    return;
  }
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,HEAD,OPTIONS",
      "access-control-allow-headers": "*",
    });
    res.end();
    return;
  }
  const path = safeRelativePath(String(req.url || ""));
  if (!path) {
    res.writeHead(404, { "access-control-allow-origin": "*" });
    res.end("not found");
    return;
  }
  const file = join(contentDir, path);
  try {
    const stat = statSync(file);
    const headers = {
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=31536000, immutable",
      "content-length": String(stat.size),
      "content-type": "text/markdown; charset=utf-8",
    };
    if (file.endsWith(".md.br")) {
      headers["content-encoding"] = "br";
    } else if (file.endsWith(".md.gz")) {
      headers["content-encoding"] = "gzip";
    }
    res.writeHead(200, headers);
    if (method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { "access-control-allow-origin": "*" });
    res.end("not found");
  }
});

server.listen(port, host, () => {
  console.log(JSON.stringify({ host, port, contentDir }, null, 2));
});

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host") {
      parsed.host = requireValue(argv, ++index, arg);
    } else if (arg === "--port") {
      parsed.port = requireValue(argv, ++index, arg);
    } else if (arg === "--dir") {
      parsed.dir = requireValue(argv, ++index, arg);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value) throw new Error(`missing value for ${flag}`);
  return value;
}

function safeRelativePath(urlValue) {
  const url = new URL(urlValue, "http://127.0.0.1");
  const pathname = decodeURIComponent(url.pathname || "");
  if (!pathname.startsWith("/knowledge-content/")) {
    return "";
  }
  const relativePath = pathname.slice("/knowledge-content/".length);
  if (!relativePath || relativePath.split("/").some((part) => !part || part === "." || part === "..")) {
    return "";
  }
  return relativePath;
}
