#!/usr/bin/env node

const args = parseArgs(process.argv.slice(2));
const server = String(args.server || process.env.INFORMATION_PROCESSING_SERVER || "http://127.0.0.1:8000").replace(/\/$/, "");
const documentIds = String(args.documentIds || args.documentId || process.env.INFORMATION_PROCESSING_DOCUMENT_IDS || "")
  .split(",").map((value) => value.trim()).filter(Boolean);
const automatic = args.auto === true || args.auto === "true" || process.env.INFORMATION_PROCESSING_AUTO === "true";
const concurrency = Math.min(20, Math.max(1, Number(args.concurrency || process.env.INFORMATION_PROCESSING_CONCURRENCY || 5)));
const maxAgeDays = Number(args.maxAgeDays || process.env.INFORMATION_PROCESSING_MAX_AGE_DAYS || 30);

if (documentIds.length === 0 && !automatic) {
  throw new Error("missing --document-id DOC_ID (or use --auto)");
}

const response = await fetch(`${server}/api/knowledge/processing-jobs`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(automatic ? {
    auto: true,
    concurrency,
    ...(Number.isFinite(maxAgeDays) && maxAgeDays > 0
      ? { maxAgeDays }
      : {}),
  } : { documentIds, concurrency }),
});
const payload = await response.json().catch(() => null);
if (!response.ok || !payload || payload.code !== 200) {
  throw new Error(`information processing failed: ${payload?.msg || response.status}`);
}
console.log(JSON.stringify(payload.data, null, 2));

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const [key, inline] = value.slice(2).split("=", 2);
    result[key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = inline ?? values[index + 1] ?? "";
    if (inline === undefined) index += 1;
  }
  return result;
}
