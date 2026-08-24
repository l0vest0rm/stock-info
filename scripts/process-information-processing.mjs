#!/usr/bin/env node

import { runAutomaticInformationProcessing } from "./lib/automatic-information-processing.mjs";

const args = parseArgs(process.argv.slice(2));
const server = String(args.server || process.env.INFORMATION_PROCESSING_SERVER || "http://127.0.0.1:8000").replace(/\/$/, "");
const documentIds = String(args.documentIds || args.documentId || process.env.INFORMATION_PROCESSING_DOCUMENT_IDS || "")
  .split(",").map((value) => value.trim()).filter(Boolean);
const automatic = args.auto === true || args.auto === "true" || process.env.INFORMATION_PROCESSING_AUTO === "true";
const concurrency = Math.min(20, Math.max(1, Number(args.concurrency || process.env.INFORMATION_PROCESSING_CONCURRENCY || 5)));
const maxDocuments = Math.min(200, Math.max(0, Number(args.maxDocuments || process.env.INFORMATION_PROCESSING_MAX_DOCUMENTS || concurrency)));
const maxAgeDays = Number(args.maxAgeDays || process.env.INFORMATION_PROCESSING_MAX_AGE_DAYS || 30);
const requestTimeoutMs = Math.min(20 * 60_000, Math.max(1_000, Number(args.requestTimeoutMs || process.env.INFORMATION_PROCESSING_REQUEST_TIMEOUT_MS || 240_000)));

if (documentIds.length === 0 && !automatic) {
  throw new Error("missing --document-id DOC_ID (or use --auto)");
}

if (automatic) {
  const result = await runAutomaticInformationProcessing({
    enabled: true,
    server,
    concurrency,
    maxDocuments,
    maxAgeDays,
    requestTimeoutMs,
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.status === "incomplete") process.exitCode = 1;
} else {
  const results = [];
  for (const documentId of documentIds) {
    const response = await fetch(`${server}/api/knowledge/processing-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(requestTimeoutMs),
      body: JSON.stringify({ documentId, concurrency: 1 }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || payload.code !== 200) {
      throw new Error(`information processing failed: ${payload?.msg || response.status}`);
    }
    results.push(...(Array.isArray(payload.data?.results) ? payload.data.results : []));
  }
  console.log(JSON.stringify({ requested: documentIds.length, processed: results.filter((item) => item?.status !== "failed").length, failed: results.filter((item) => item?.status === "failed").length, results }, null, 2));
}

function parseArgs(values) {
  const result = {};
  const booleanOptions = new Set(["auto"]);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const [key, inline] = value.slice(2).split("=", 2);
    const normalized = key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (inline !== undefined) {
      result[normalized] = inline;
    } else if (booleanOptions.has(normalized)) {
      result[normalized] = true;
    } else {
      result[normalized] = values[index + 1] ?? "";
      index += 1;
    }
  }
  return result;
}
