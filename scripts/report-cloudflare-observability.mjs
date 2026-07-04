#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const args = parseArgs(process.argv.slice(2));
const token = requiredEnv("CLOUDFLARE_API_TOKEN");
const accountTag = requiredEnv("CLOUDFLARE_ACCOUNT_ID");
const zoneTag = process.env.CLOUDFLARE_ZONE_ID || "";
const bucketName = process.env.KNOWLEDGE_CONTENT_BUCKET || "stock-info-knowledge-content";
const contentHostname = process.env.KNOWLEDGE_CONTENT_HOSTNAME || "content.tinfo.cc";
const workerScriptName = process.env.CLOUDFLARE_WORKER_SCRIPT_NAME || "stock-info";

const startedAt = isoDateTimeHoursAgo(args.hours);
const endedAt = new Date().toISOString();

const summary = {
  window: { startedAt, endedAt, hours: args.hours },
  worker: null,
  d1: null,
  d1Insights: null,
  r2: null,
  contentCache: null,
  errors: [],
};

await capture("worker", async () => queryWorkerMetrics({
  token,
  accountTag,
  scriptName: workerScriptName,
  startedAt,
  endedAt,
}));

await capture("d1", async () => queryD1Metrics({
  token,
  accountTag,
  databaseId: args.d1DatabaseId || process.env.CLOUDFLARE_D1_DATABASE_ID || "",
  startedAt,
  endedAt,
}));

await capture("d1Insights", async () => loadD1Insights(args.databaseName));

await capture("r2", async () => queryR2Metrics({
  token,
  accountTag,
  bucketName,
  startedAt,
  endedAt,
}));

if (zoneTag) {
  await capture("contentCache", async () => queryContentCacheMetrics({
    token,
    zoneTag,
    hostname: contentHostname,
    startedAt,
    endedAt,
  }));
}

console.log(JSON.stringify(summary, null, 2));

async function capture(key, loader) {
  try {
    summary[key] = await loader();
  } catch (error) {
    summary.errors.push({
      key,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseArgs(argv) {
  const parsed = {
    hours: 24,
    databaseName: "stock_info",
    d1DatabaseId: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--hours") parsed.hours = positiveInteger(requireValue(argv, ++i, arg), 24);
    else if (arg === "--database-name") parsed.databaseName = requireValue(argv, ++i, arg);
    else if (arg === "--d1-database-id") parsed.d1DatabaseId = requireValue(argv, ++i, arg);
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

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    throw new Error(`missing env ${name}`);
  }
  return value;
}

function isoDateTimeHoursAgo(hours) {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

async function queryWorkerMetrics({ token, accountTag, scriptName, startedAt, endedAt }) {
  const query = `
    query WorkerMetrics($accountTag: string!, $scriptName: string!, $startedAt: Time!, $endedAt: Time!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          workersInvocationsAdaptive(
            filter: {
              datetime_geq: $startedAt
              datetime_lt: $endedAt
              scriptName: $scriptName
            }
            limit: 1000
          ) {
            sum {
              requests
              errors
              subrequests
            }
            quantiles {
              cpuTimeP50
              cpuTimeP95
              cpuTimeP99
            }
          }
        }
      }
    }
  `;
  const data = await graphqlQuery({ token, query, variables: { accountTag, scriptName, startedAt, endedAt } });
  const rows = data.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
  return {
    scriptName,
    requests: sumField(rows, "sum.requests"),
    errors: sumField(rows, "sum.errors"),
    subrequests: sumField(rows, "sum.subrequests"),
    cpuTimeMsP50: averageField(rows, "quantiles.cpuTimeP50"),
    cpuTimeMsP95: averageField(rows, "quantiles.cpuTimeP95"),
    cpuTimeMsP99: averageField(rows, "quantiles.cpuTimeP99"),
  };
}

async function queryD1Metrics({ token, accountTag, databaseId, startedAt, endedAt }) {
  if (!databaseId) {
    throw new Error("missing D1 database id; set CLOUDFLARE_D1_DATABASE_ID or pass --d1-database-id");
  }
  const query = `
    query D1Metrics($accountTag: string!, $databaseId: string!, $startedAt: Time!, $endedAt: Time!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          d1AnalyticsAdaptiveGroups(
            filter: {
              datetime_geq: $startedAt
              datetime_lt: $endedAt
              databaseId: $databaseId
            }
            limit: 1000
          ) {
            sum {
              rowsRead
              rowsWritten
              readQueries
              writeQueries
            }
            quantiles {
              queryDurationMsP50
              queryDurationMsP95
              queryDurationMsP99
            }
          }
        }
      }
    }
  `;
  const data = await graphqlQuery({ token, query, variables: { accountTag, databaseId, startedAt, endedAt } });
  const rows = data.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups ?? [];
  return {
    databaseId,
    readQueries: sumField(rows, "sum.readQueries"),
    writeQueries: sumField(rows, "sum.writeQueries"),
    rowsRead: sumField(rows, "sum.rowsRead"),
    rowsWritten: sumField(rows, "sum.rowsWritten"),
    queryDurationMsP50: averageField(rows, "quantiles.queryDurationMsP50"),
    queryDurationMsP95: averageField(rows, "quantiles.queryDurationMsP95"),
    queryDurationMsP99: averageField(rows, "quantiles.queryDurationMsP99"),
  };
}

function loadD1Insights(databaseName) {
  try {
    const output = execFileSync(
      "npx",
      ["wrangler", "d1", "insights", databaseName, "--remote", "--json"],
      { encoding: "utf8", stdio: "pipe", maxBuffer: 20 * 1024 * 1024 }
    );
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`wrangler d1 insights failed: ${error.stderr || error.message || error}`);
  }
}

async function queryR2Metrics({ token, accountTag, bucketName, startedAt, endedAt }) {
  const query = `
    query R2Metrics($accountTag: string!, $bucketName: string!, $startedAt: Time!, $endedAt: Time!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          r2OperationsAdaptiveGroups(
            filter: {
              datetime_geq: $startedAt
              datetime_lt: $endedAt
              bucketName: $bucketName
            }
            limit: 1000
          ) {
            dimensions {
              actionType
            }
            sum {
              requests
            }
          }
          r2StorageAdaptiveGroups(
            filter: {
              datetime_geq: $startedAt
              datetime_lt: $endedAt
              bucketName: $bucketName
            }
            limit: 1000
          ) {
            max {
              payloadSize
              objectCount
              metadataSize
            }
          }
        }
      }
    }
  `;
  const data = await graphqlQuery({ token, query, variables: { accountTag, bucketName, startedAt, endedAt } });
  const operationRows = data.viewer?.accounts?.[0]?.r2OperationsAdaptiveGroups ?? [];
  const storageRows = data.viewer?.accounts?.[0]?.r2StorageAdaptiveGroups ?? [];
  const byActionType = operationRows.map((row) => ({
    actionType: String(row.dimensions?.actionType || ""),
    requests: Number(row.sum?.requests || 0),
    operationClass: classifyR2ActionType(String(row.dimensions?.actionType || "")),
  }));
  return {
    bucketName,
    classARequests: byActionType.filter((row) => row.operationClass === "A").reduce((sum, row) => sum + row.requests, 0),
    classBRequests: byActionType.filter((row) => row.operationClass === "B").reduce((sum, row) => sum + row.requests, 0),
    unknownRequests: byActionType.filter((row) => row.operationClass === "unknown").reduce((sum, row) => sum + row.requests, 0),
    byActionType,
    storage: {
      payloadSizeBytesMax: maxField(storageRows, "max.payloadSize"),
      metadataSizeBytesMax: maxField(storageRows, "max.metadataSize"),
      objectCountMax: maxField(storageRows, "max.objectCount"),
    },
  };
}

async function queryContentCacheMetrics({ token, zoneTag, hostname, startedAt, endedAt }) {
  const query = `
    query ContentCache($zoneTag: string!, $hostname: string!, $startedAt: Time!, $endedAt: Time!) {
      viewer {
        zones(filter: { zoneTag: $zoneTag }) {
          httpRequestsAdaptiveGroups(
            filter: {
              datetime_geq: $startedAt
              datetime_lt: $endedAt
              clientRequestHTTPHost: $hostname
            }
            limit: 1000
          ) {
            sum {
              requests
              cachedRequests
              bytes
              cachedBytes
            }
          }
        }
      }
    }
  `;
  const data = await graphqlQuery({ token, query, variables: { zoneTag, hostname, startedAt, endedAt } });
  const rows = data.viewer?.zones?.[0]?.httpRequestsAdaptiveGroups ?? [];
  const requests = sumField(rows, "sum.requests");
  const cachedRequests = sumField(rows, "sum.cachedRequests");
  const bytes = sumField(rows, "sum.bytes");
  const cachedBytes = sumField(rows, "sum.cachedBytes");
  return {
    hostname,
    requests,
    cachedRequests,
    cacheHitRatio: requests > 0 ? cachedRequests / requests : 0,
    bytes,
    cachedBytes,
    byteHitRatio: bytes > 0 ? cachedBytes / bytes : 0,
  };
}

async function graphqlQuery({ token, query, variables }) {
  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    throw new Error(`graphql http ${response.status}: ${await response.text()}`);
  }
  const payload = await response.json();
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new Error(payload.errors.map((item) => item.message).join("; "));
  }
  return payload.data;
}

function classifyR2ActionType(actionType) {
  const value = actionType.trim().toUpperCase();
  if (!value) return "unknown";
  if (value.includes("GET") || value.includes("HEAD")) return "B";
  if (value.includes("PUT") || value.includes("POST") || value.includes("DELETE") || value.includes("LIST")) return "A";
  return "unknown";
}

function sumField(rows, path) {
  return rows.reduce((sum, row) => sum + Number(readPath(row, path) || 0), 0);
}

function averageField(rows, path) {
  const values = rows.map((row) => Number(readPath(row, path) || 0)).filter((value) => Number.isFinite(value) && value > 0);
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function maxField(rows, path) {
  return rows.reduce((max, row) => {
    const value = Number(readPath(row, path) || 0);
    return Number.isFinite(value) && value > max ? value : max;
  }, 0);
}

function readPath(value, path) {
  return path.split(".").reduce((current, key) => (current == null ? undefined : current[key]), value);
}
