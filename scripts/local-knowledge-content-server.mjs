#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { open, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  downloadPdfBytes,
  isPdfBytes,
} from "./lib/eastmoney-report-content.mjs";

const args = parseArgs(process.argv.slice(2));
const host = args.host || "127.0.0.1";
const port = Number(args.port || process.env.KNOWLEDGE_CONTENT_LOCAL_PORT || 8788);
const contentDir = resolve(args.dir || process.env.KNOWLEDGE_CONTENT_LOCAL_DIR || "/Users/terry/git/data/stock-info/knowledge/content-cache");
const reportWorkDir = resolve(process.env.KNOWLEDGE_REPORT_CONVERSION_WORK_DIR || "/Users/terry/git/data/stock-info/knowledge/work");
const reportPdfDir = join(reportWorkDir, "remote-pdf");
const reportMarkdownDir = join(reportWorkDir, "markdown-cache");
const reportConversionConcurrency = positiveInteger(process.env.KNOWLEDGE_REPORT_CONVERSION_CONCURRENCY, 2);
const reportConversionTimeoutMs = positiveInteger(process.env.KNOWLEDGE_REPORT_CONVERSION_TIMEOUT_MS, 120000);
const requiredReportConverterHosts = ["pdf.dfcfw.com", "static.cninfo.com.cn", "www1.hkexnews.hk"];
const secFilingHost = "www.sec.gov";
const reportConverterHosts = new Set(
  String(process.env.KNOWLEDGE_REPORT_CONVERTER_HOSTS || requiredReportConverterHosts.join(","))
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
);
const missingRequiredReportConverterHosts = requiredReportConverterHosts.filter((host) => !reportConverterHosts.has(host));
if (missingRequiredReportConverterHosts.length) {
  throw new Error(`KNOWLEDGE_REPORT_CONVERTER_HOSTS must include required official hosts: ${missingRequiredReportConverterHosts.join(", ")}`);
}
const reportConversionQueue = createTaskQueue(reportConversionConcurrency);
const reportConversionsInFlight = new Map();
const execFileAsync = promisify(execFile);

mkdirSync(reportPdfDir, { recursive: true });
mkdirSync(reportMarkdownDir, { recursive: true });

export function createKnowledgeContentServer() {
  return createServer((req, res) => {
    void handleRequest(req, res).catch((error) => {
      console.error("knowledge content request failed", error);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      }
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });
}

async function handleRequest(req, res) {
  const method = String(req.method || "GET").toUpperCase();
  if (req.url === "/__health") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
    res.end(JSON.stringify({
      ok: true,
      reportConversion: reportConversionQueue.status(),
    }));
    return;
  }
  if (req.url === "/__convert-report" && method === "POST") {
    const body = await readJsonRequest(req, 32 * 1024);
    const docId = normalizeDocId(body.docId);
    const url = normalizeReportUrl(body.url);
    const markdown = await convertReportCached(docId, url);
    res.writeHead(200, {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(markdown);
    return;
  }
  if (req.url === "/__convert-sec-filing" && method === "POST") {
    const body = await readJsonRequest(req, 32 * 1024);
    const docId = normalizeDocId(body.docId);
    const url = normalizeSecFilingUrl(body.url);
    const markdown = await convertSecFilingCached(docId, url);
    res.writeHead(200, {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(markdown);
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
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createKnowledgeContentServer();
  server.listen(port, host, () => {
    console.log(JSON.stringify({
      host,
      port,
      contentDir,
      reportWorkDir,
      reportConversionConcurrency,
    }, null, 2));
  });
}

async function convertReportCached(docId, url) {
  const existing = reportConversionsInFlight.get(docId);
  if (existing) {
    return existing;
  }
  const pending = reportConversionQueue.run(async () => {
    const markdownFile = join(reportMarkdownDir, `${docId}.md`);
    if (existsSync(markdownFile) && statSync(markdownFile).size > 0) {
      return readFile(markdownFile, "utf8");
    }
    const pdfFile = join(reportPdfDir, `${docId}.pdf`);
    await downloadReportPdfCached(url, pdfFile);
    await convertReportPdfToMarkdown(pdfFile, markdownFile);
    return readFile(markdownFile, "utf8");
  }).finally(() => reportConversionsInFlight.delete(docId));
  reportConversionsInFlight.set(docId, pending);
  return pending;
}

async function convertSecFilingCached(docId, url) {
  const cacheKey = `sec-${docId}`;
  const existing = reportConversionsInFlight.get(cacheKey);
  if (existing) return existing;
  const pending = reportConversionQueue.run(async () => {
    const markdownFile = join(reportMarkdownDir, `${cacheKey}.md`);
    if (existsSync(markdownFile) && statSync(markdownFile).size > 0) return readFile(markdownFile, "utf8");
    const response = await fetch(url, {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "stock-info research contact research@localhost",
      },
    });
    if (!response.ok) throw new Error(`SEC filing download failed: ${response.status}`);
    const html = await response.text();
    const markdown = secHtmlToMarkdown(html);
    if (!markdown.trim()) throw new Error("SEC filing conversion returned empty content");
    const temporaryFile = `${markdownFile}.tmp-${process.pid}`;
    await writeFile(temporaryFile, markdown, "utf8");
    await rename(temporaryFile, markdownFile);
    return markdown;
  }).finally(() => reportConversionsInFlight.delete(cacheKey));
  reportConversionsInFlight.set(cacheKey, pending);
  return pending;
}

async function downloadReportPdfCached(url, file) {
  if (await hasCachedPdf(file)) {
    return;
  }
  const bytes = await downloadPdfBytes(url);
  const temporaryFile = `${file}.tmp-${process.pid}`;
  await writeFile(temporaryFile, bytes);
  await rename(temporaryFile, file);
}

async function hasCachedPdf(file) {
  if (!existsSync(file) || statSync(file).size < 1000) return false;
  const handle = await open(file, "r");
  try {
    const bytes = Buffer.alloc(5);
    await handle.read(bytes, 0, bytes.length, 0);
    return isPdfBytes(bytes);
  } finally {
    await handle.close();
  }
}

async function convertReportPdfToMarkdown(pdfFile, markdownFile) {
  const python = process.env.PYTHON_BIN || "python3";
  const code = `
import pathlib, sys
pdf = pathlib.Path(sys.argv[1])
out = pathlib.Path(sys.argv[2])
try:
    import pymupdf4llm
    text = pymupdf4llm.to_markdown(str(pdf))
except Exception:
    import fitz
    doc = fitz.open(str(pdf))
    text = "\\n\\n".join(page.get_text("text") for page in doc)
out.write_text(text, encoding="utf-8")
`;
  try {
    await execFileAsync(python, ["-c", code, pdfFile, markdownFile], {
      encoding: "utf8",
      timeout: reportConversionTimeoutMs,
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch (error) {
    const detail = error && typeof error === "object" && "stderr" in error
      ? String(error.stderr || "").trim()
      : "";
    throw new Error(`pdf to markdown failed: ${detail || (error instanceof Error ? error.message : String(error))}`);
  }
  if (!existsSync(markdownFile) || statSync(markdownFile).size === 0) {
    throw new Error(`pdf to markdown produced empty content: ${pdfFile}`);
  }
}

function createTaskQueue(concurrency) {
  let active = 0;
  const pending = [];
  const drain = () => {
    while (active < concurrency && pending.length > 0) {
      const item = pending.shift();
      active += 1;
      Promise.resolve()
        .then(item.task)
        .then(item.resolve, item.reject)
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  };
  return {
    run(task) {
      return new Promise((resolveTask, rejectTask) => {
        pending.push({ task, resolve: resolveTask, reject: rejectTask });
        drain();
      });
    },
    status() {
      return { active, pending: pending.length, concurrency };
    },
  };
}

async function readJsonRequest(req, maxBytes) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      throw new Error("request body is too large");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new Error("invalid JSON request body");
  }
}

function normalizeDocId(value) {
  const docId = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{8,120}$/.test(docId)) {
    throw new Error("invalid report doc id");
  }
  return docId;
}

function normalizeReportUrl(value) {
  const url = new URL(String(value || ""));
  if (url.protocol !== "https:" || !reportConverterHosts.has(url.hostname.toLowerCase()) || !url.pathname.toLowerCase().endsWith(".pdf")) {
    throw new Error("report URL is not allowed by the converter");
  }
  return url.toString();
}

function normalizeSecFilingUrl(value) {
  const url = new URL(String(value || ""));
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== secFilingHost || !/^\/Archives\/edgar\/data\/\d+\/.+\.html?$/i.test(url.pathname)) {
    throw new Error("SEC filing URL is not allowed by the converter");
  }
  return url.toString();
}

function secHtmlToMarkdown(html) {
  const text = String(html)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|head)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|tr|li|h[1-6]|table)>/gi, "\n")
    .replace(/<t[dh][^>]*>/gi, " | ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return text.slice(0, 2 * 1024 * 1024);
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

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
