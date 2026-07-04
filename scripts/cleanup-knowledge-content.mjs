#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { buildContentOptions } from "./knowledge-content-r2.mjs";

const args = parseArgs(process.argv.slice(2));
const options = buildContentOptions({
  remote: args.remote,
  contentBucket: args.contentBucket,
  contentPublicBaseUrl: args.contentPublicBaseUrl,
  uploadContentRemote: true,
});
const run = {
  runId: `knowledge-content-cleanup:${randomUUID()}`,
  startedAt: Date.now(),
  source: "knowledge_content_cleanup",
};

try {
  const refs = loadReferencedKeys(args.database, args.remote, args.prefix);
  const objects = listBucketObjects({
    bucket: options.bucket,
    endpoint: options.s3Endpoint,
    accessKeyId: options.s3AccessKeyId,
    secretAccessKey: options.s3SecretAccessKey,
    prefix: args.prefix,
  });
  const now = Date.now();
  const referenced = new Set(refs);
  const bucketByKey = new Map(objects.map((item) => [item.key, item]));
  const missingRefs = refs.filter((key) => !bucketByKey.has(key)).sort();
  const orphans = objects
    .filter((item) => !referenced.has(item.key))
    .filter((item) => now - item.lastModifiedMs >= args.minAgeDays * 86400000)
    .sort((a, b) => a.key.localeCompare(b.key));

  let deleted = [];
  if (args.apply && orphans.length > 0) {
    deleted = deleteBucketObjects({
      bucket: options.bucket,
      endpoint: options.s3Endpoint,
      accessKeyId: options.s3AccessKeyId,
      secretAccessKey: options.s3SecretAccessKey,
      keys: orphans.map((item) => item.key),
    });
  }

  const summary = {
    dryRun: !args.apply,
    database: args.database,
    remote: args.remote,
    bucket: options.bucket,
    prefix: args.prefix,
    minAgeDays: args.minAgeDays,
    referencedKeys: refs.length,
    bucketObjects: objects.length,
    orphanObjects: orphans.length,
    orphanBytes: orphans.reduce((sum, item) => sum + item.size, 0),
    deletedObjects: deleted.length,
    missingRefs: missingRefs.length,
    missingRefSample: missingRefs.slice(0, 20),
    orphanSample: orphans.slice(0, 20),
  };

  if (args.writeRun) {
    recordRun({
      database: args.database,
      remote: args.remote,
      runId: run.runId,
      source: run.source,
      startedAt: run.startedAt,
      finishedAt: Date.now(),
      status: "success",
      stats: summary,
    });
  }
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (args.writeRun) {
    try {
      recordRun({
        database: args.database,
        remote: args.remote,
        runId: run.runId,
        source: run.source,
        startedAt: run.startedAt,
        finishedAt: Date.now(),
        status: "failed",
        stats: {},
        error: message,
      });
    } catch {
      // Ignore secondary write failures.
    }
  }
  throw error;
}

function parseArgs(argv) {
  const parsed = {
    database: "stock_info",
    remote: false,
    apply: false,
    prefix: "knowledge-content/",
    minAgeDays: 7,
    writeRun: true,
    contentBucket: "",
    contentPublicBaseUrl: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--remote") parsed.remote = true;
    else if (arg === "--local") parsed.remote = false;
    else if (arg === "--apply") parsed.apply = true;
    else if (arg === "--dry-run") parsed.apply = false;
    else if (arg === "--database") parsed.database = requireValue(argv, ++i, arg);
    else if (arg === "--prefix") parsed.prefix = requireValue(argv, ++i, arg);
    else if (arg === "--min-age-days") parsed.minAgeDays = positiveInteger(requireValue(argv, ++i, arg), 7);
    else if (arg === "--content-bucket") parsed.contentBucket = requireValue(argv, ++i, arg);
    else if (arg === "--content-public-base-url") parsed.contentPublicBaseUrl = requireValue(argv, ++i, arg);
    else if (arg === "--skip-run-record") parsed.writeRun = false;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return parsed;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value) {
    throw new Error(`missing value for ${flag}`);
  }
  return value;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function loadReferencedKeys(database, remote, prefix) {
  const sql = `
    select content_key
    from knowledge_doc_content_refs
    where coalesce(content_key, '') like ${sqlString(`${prefix}%`)}
    union
    select content_key
    from knowledge_filtered_doc_content_refs
    where coalesce(content_key, '') like ${sqlString(`${prefix}%`)}
  `;
  const output = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", database, remote ? "--remote" : "--local", "--json", "--command", sql],
    { encoding: "utf8", stdio: "pipe", maxBuffer: 20 * 1024 * 1024 }
  );
  const payload = JSON.parse(output);
  return (payload[0]?.results ?? [])
    .map((row) => String(row.content_key || "").trim())
    .filter(Boolean)
    .sort();
}

function listBucketObjects({ bucket, endpoint, accessKeyId, secretAccessKey, prefix }) {
  assertS3Config({ bucket, endpoint, accessKeyId, secretAccessKey });
  const items = [];
  let continuationToken = "";
  while (true) {
    const url = new URL(`${endpoint}/${bucket}`);
    url.searchParams.set("list-type", "2");
    url.searchParams.set("prefix", prefix);
    if (continuationToken) {
      url.searchParams.set("continuation-token", continuationToken);
    }
    const xml = execCurl({
      method: "GET",
      url: url.toString(),
      endpoint,
      accessKeyId,
      secretAccessKey,
    });
    items.push(...parseListBucketXml(xml));
    const next = parseXmlTag(xml, "NextContinuationToken");
    const truncated = parseXmlTag(xml, "IsTruncated") === "true";
    if (!truncated || !next) {
      break;
    }
    continuationToken = next;
  }
  return items;
}

function deleteBucketObjects({ bucket, endpoint, accessKeyId, secretAccessKey, keys }) {
  assertS3Config({ bucket, endpoint, accessKeyId, secretAccessKey });
  const deleted = [];
  for (const key of keys) {
    const url = `${endpoint}/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
    execCurl({
      method: "DELETE",
      url,
      endpoint,
      accessKeyId,
      secretAccessKey,
    });
    deleted.push(key);
  }
  return deleted;
}

function execCurl({ method, url, endpoint, accessKeyId, secretAccessKey }) {
  const command = [
    "--fail",
    "--silent",
    "--show-error",
    "--aws-sigv4",
    "aws:amz:auto:s3",
    "--user",
    `${accessKeyId}:${secretAccessKey}`,
    "--request",
    method,
    url,
  ];
  return execFileSync("curl", command, {
    encoding: "utf8",
    stdio: "pipe",
    maxBuffer: 50 * 1024 * 1024,
    env: {
      ...process.env,
      CURL_CA_BUNDLE: process.env.CURL_CA_BUNDLE || "",
    },
  });
}

function parseListBucketXml(xml) {
  const contents = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)];
  return contents.map((match) => {
    const body = match[1] || "";
    return {
      key: decodeXml(parseXmlTag(body, "Key")),
      lastModified: parseXmlTag(body, "LastModified"),
      lastModifiedMs: Date.parse(parseXmlTag(body, "LastModified") || "") || 0,
      etag: stripQuotes(parseXmlTag(body, "ETag")),
      size: Number(parseXmlTag(body, "Size") || 0),
    };
  }).filter((item) => item.key);
}

function parseXmlTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return match ? match[1].trim() : "";
}

function stripQuotes(value) {
  return String(value || "").replace(/^"+|"+$/g, "");
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function assertS3Config({ bucket, endpoint, accessKeyId, secretAccessKey }) {
  if (!bucket) {
    throw new Error("missing content bucket name");
  }
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error("cleanup requires CLOUDFLARE_R2_ENDPOINT, CLOUDFLARE_R2_ACCESS_KEY_ID, and CLOUDFLARE_R2_SECRET_ACCESS_KEY");
  }
}

function recordRun({ database, remote, runId, source, startedAt, finishedAt, status, stats, error = "" }) {
  const sql = `
    insert into knowledge_ingest_runs (run_id, status, source, started_at, finished_at, stats_json, error)
    values (
      ${sqlString(runId)},
      ${sqlString(status)},
      ${sqlString(source)},
      ${startedAt},
      ${finishedAt},
      ${sqlString(JSON.stringify(stats || {}))},
      ${sqlString(error)}
    );
  `;
  execFileSync(
    "npx",
    ["wrangler", "d1", "execute", database, remote ? "--remote" : "--local", "--command", sql],
    { encoding: "utf8", stdio: "pipe", maxBuffer: 20 * 1024 * 1024 }
  );
}

function sqlString(value) {
  return `'${String(value ?? "").replaceAll("'", "''")}'`;
}
