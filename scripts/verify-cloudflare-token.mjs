#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const root = resolve(new URL("..", import.meta.url).pathname);
const args = parseArgs(process.argv.slice(2));
const config = readWranglerConfig(resolve(root, "wrangler.jsonc"));
const token = process.env.CLOUDFLARE_API_TOKEN?.trim() || "";
const domain = args.domain || config.routeDomain || "tinfo.cc";

if (!token) {
  console.error("Missing CLOUDFLARE_API_TOKEN in environment.");
  process.exit(1);
}

const checks = [];
let zoneId = args.zoneId || "";

checks.push(await verifyToken(token));

const zoneLookup = await apiRequest({
  token,
  path: `/zones?name=${encodeURIComponent(domain)}`,
});
checks.push(makeCheck("Zone lookup", "Zone -> Zone -> Read", zoneLookup));

if (zoneLookup.ok) {
  const zone = Array.isArray(zoneLookup.body?.result) ? zoneLookup.body.result[0] : null;
  zoneId = zone?.id || zoneId;
}

if (!zoneId) {
  console.log(renderReport({ domain, zoneId: null, checks }));
  process.exit(hasFailures(checks) ? 1 : 0);
}

if (args.requireD1) {
  const databaseId = config.d1DatabaseId;
  if (!databaseId) {
    checks.push({
      name: "D1 database access",
      neededPermission: "Account -> D1 -> Edit",
      ok: false,
      status: null,
      error: "No d1_databases[0].database_id found in wrangler.jsonc",
    });
  } else {
    const d1Read = await apiRequest({
      token,
      path: `/accounts/${zoneIdToAccountId(zoneLookup.body, zoneId)}/d1/database/${databaseId}`,
    });
    checks.push(makeCheck("D1 database access", "Account -> D1 -> Edit", d1Read));
  }
}

if (args.requireR2) {
  const buckets = config.r2Buckets;
  if (buckets.length === 0) {
    checks.push({
      name: "R2 bucket access",
      neededPermission: "Account -> Workers R2 Storage -> Edit",
      ok: false,
      status: null,
      error: "No r2_buckets configured in wrangler.jsonc",
    });
  } else {
    for (const bucketName of buckets) {
      const r2Read = await apiRequest({
        token,
        path: `/accounts/${zoneIdToAccountId(zoneLookup.body, zoneId)}/r2/buckets/${encodeURIComponent(bucketName)}`,
      });
      checks.push(
        makeCheck(`R2 bucket access (${bucketName})`, "Account -> Workers R2 Storage -> Edit", r2Read),
      );
    }
  }
}

if (args.requireWorker) {
  const workerName = config.workerName;
  if (!workerName) {
    checks.push({
      name: "Worker service access",
      neededPermission: "Account -> Workers Scripts -> Edit",
      ok: false,
      status: null,
      error: "No worker name found in wrangler.jsonc",
    });
  } else {
    const workerRead = await apiRequest({
      token,
      path: `/accounts/${zoneIdToAccountId(zoneLookup.body, zoneId)}/workers/services/${encodeURIComponent(workerName)}`,
    });
    checks.push(makeCheck(`Worker service access (${workerName})`, "Account -> Workers Scripts -> Edit", workerRead));
  }
}

const dnsRead = await apiRequest({
  token,
  path: `/zones/${zoneId}/dns_records?per_page=1`,
});
checks.push(makeCheck("DNS records read", "Zone -> DNS -> Read", dnsRead));

const workersRoutesRead = await apiRequest({
  token,
  path: `/zones/${zoneId}/workers/routes`,
});
checks.push(makeCheck("Workers routes read", "Zone -> Workers Routes -> Edit", workersRoutesRead));

const report = renderReport({ domain, zoneId, checks });
console.log(report);
process.exit(hasFailures(checks) ? 1 : 0);

async function verifyToken(tokenValue) {
  const response = await apiRequest({
    token: tokenValue,
    path: "/user/tokens/verify",
  });
  return makeCheck("Token verify", "Token valid", response);
}

async function apiRequest({ token: tokenValue, path }) {
  let response;
  try {
    response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      headers: {
        Authorization: `Bearer ${tokenValue}`,
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    return {
      ok: false,
      status: null,
      body: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  const success = response.ok && body?.success !== false;
  return {
    ok: success,
    status: response.status,
    body,
    error: success ? null : formatApiError(body),
  };
}

function makeCheck(name, neededPermission, response) {
  return {
    name,
    neededPermission,
    ok: response.ok,
    status: response.status,
    error: response.error,
  };
}

function hasFailures(checksList) {
  return checksList.some((check) => !check.ok);
}

function renderReport({ domain: targetDomain, zoneId: targetZoneId, checks: checksList }) {
  const lines = [];
  lines.push(`Cloudflare token verification for ${targetDomain}`);
  lines.push(`Zone ID: ${targetZoneId || "unresolved"}`);
  lines.push("");

  for (const check of checksList) {
    const status = check.ok ? "PASS" : "FAIL";
    const code = check.status == null ? "no-http-status" : String(check.status);
    lines.push(`[${status}] ${check.name} (${code})`);
    lines.push(`  needs: ${check.neededPermission}`);
    if (check.error) {
      lines.push(`  error: ${check.error}`);
    }
  }

  const missing = checksList.filter((check) => !check.ok).map((check) => check.neededPermission);
  lines.push("");
  if (missing.length === 0) {
    lines.push("All non-destructive permission checks passed.");
    lines.push("Note: this proves token validity plus the non-destructive checks requested for this repo.");
    lines.push("It does not safely prove DNS edit permission without making a real change.");
  } else {
    lines.push("Likely missing permissions:");
    for (const permission of unique(missing)) {
      lines.push(`- ${permission}`);
    }
  }

  return lines.join("\n");
}

function formatApiError(body) {
  const errors = Array.isArray(body?.errors) ? body.errors : [];
  if (errors.length === 0) {
    return "Unknown API error";
  }
  return errors
    .map((entry) => {
      const code = entry?.code == null ? "unknown" : String(entry.code);
      const message = entry?.message ? String(entry.message) : "unknown error";
      return `${code} ${message}`;
    })
    .join("; ");
}

function unique(values) {
  return [...new Set(values)];
}

function readWranglerConfig(filePath) {
  const text = readFileSync(filePath, "utf8");
  const parsed = Function(`"use strict"; return (${text});`)();
  const routeDomain = Array.isArray(parsed.routes)
    ? parsed.routes
        .map((entry) => String(entry?.pattern || "").trim())
        .find(Boolean) || null
    : null;
  const d1DatabaseId = Array.isArray(parsed.d1_databases)
    ? String(parsed.d1_databases[0]?.database_id || "").trim() || null
    : null;
  const r2Buckets = Array.isArray(parsed.r2_buckets)
    ? parsed.r2_buckets
        .map((entry) => String(entry?.bucket_name || "").trim())
        .filter(Boolean)
    : [];
  const workerName = String(parsed.name || "").trim() || null;
  return {
    routeDomain,
    d1DatabaseId,
    r2Buckets,
    workerName,
  };
}

function parseArgs(argv) {
  const argsMap = {
    requireD1: false,
    requireR2: false,
    requireWorker: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--domain") {
      argsMap.domain = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (value === "--zone-id") {
      argsMap.zoneId = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (value === "--require-d1") {
      argsMap.requireD1 = true;
      continue;
    }
    if (value === "--require-r2") {
      argsMap.requireR2 = true;
      continue;
    }
    if (value === "--require-worker") {
      argsMap.requireWorker = true;
    }
  }
  return argsMap;
}

function zoneIdToAccountId(zoneLookupBody, fallbackZoneId) {
  const zone = Array.isArray(zoneLookupBody?.result) ? zoneLookupBody.result[0] : null;
  const accountId = String(zone?.account?.id || "").trim();
  if (!accountId) {
    throw new Error(`Unable to resolve account ID for zone ${fallbackZoneId}`);
  }
  return accountId;
}
