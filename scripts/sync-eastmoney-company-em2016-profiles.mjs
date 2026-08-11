#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const outputPath = path.resolve(process.cwd(), "config/eastmoney-company-em2016-profiles.json");
const defaultInputPath = path.resolve(process.cwd(), "web/src/config/institutional-track-snapshot.json");
const legacySeedPath = path.resolve(process.cwd(), "config/research-eastmoney-em2016-top300.json");

const explicitCodes = parseCodes(optionValue("--codes"));
const inputPath = optionValue("--input") ? path.resolve(process.cwd(), optionValue("--input")) : defaultInputPath;
const concurrency = Math.max(1, Number.parseInt(optionValue("--concurrency") || "4", 10) || 4);
const refreshExisting = hasFlag("--refresh-existing");

const existingConfig = await readJson(outputPath).catch(() => null);
const legacySeed = await readJson(legacySeedPath).catch(() => null);
const inputPayload = await readJson(inputPath).catch(() => null);

const existingProfiles = new Map();
for (const entry of normalizeConfigEntries(legacySeed?.rows || [])) existingProfiles.set(entry.code, entry);
for (const entry of normalizeConfigEntries(existingConfig?.profiles || [])) existingProfiles.set(entry.code, entry);

const codesFromInput = extractCodes(inputPayload);
const targetCodes = [...new Set([
  ...codesFromInput,
  ...explicitCodes,
])];

if (!targetCodes.length) {
  throw new Error("no security codes resolved; pass --codes or provide an input json with rows[].code");
}

const namesByCode = extractNames(inputPayload);
const pendingCodes = targetCodes.filter((code) => refreshExisting || !isUsableProfile(existingProfiles.get(code)));
const fetchedProfiles = await fetchProfiles(pendingCodes, concurrency, namesByCode);

for (const [code, entry] of fetchedProfiles.entries()) existingProfiles.set(code, entry);

const profiles = [...existingProfiles.values()].sort((left, right) => left.code.localeCompare(right.code, "en"));
const available = profiles.filter((item) => item.availability === "available" && item.industry).length;
const output = {
  schemaVersion: "eastmoney-company-em2016-profiles.v1",
  taxonomy: "eastmoney-em2016.v1",
  generatedAt: new Date().toISOString(),
  source: {
    endpoint: "https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_F10_ORG_BASICINFO",
    field: "EM2016",
    inputPath: path.relative(process.cwd(), inputPath),
  },
  coverage: {
    total: profiles.length,
    available,
    unavailable: profiles.length - available,
  },
  profiles,
};

await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  output: path.relative(process.cwd(), outputPath),
  input: path.relative(process.cwd(), inputPath),
  totalProfiles: profiles.length,
  fetched: pendingCodes.length,
  available,
}, null, 2));

function optionValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function parseCodes(raw) {
  return [...new Set(String(raw || "")
    .split(/[\s,]+/u)
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean))];
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function extractCodes(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload.map((item) => String(item || "").trim().toUpperCase()).filter(Boolean);
  if (Array.isArray(payload.codes)) return payload.codes.map((item) => String(item || "").trim().toUpperCase()).filter(Boolean);
  if (Array.isArray(payload.rows)) {
    return payload.rows
      .map((row) => String(row?.code || row?.SECUCODE || "").trim().toUpperCase())
      .filter(Boolean);
  }
  return [];
}

function extractNames(payload) {
  const names = new Map();
  if (!payload || !Array.isArray(payload.rows)) return names;
  for (const row of payload.rows) {
    const code = String(row?.code || row?.SECUCODE || "").trim().toUpperCase();
    const name = String(row?.name || row?.SECURITY_NAME_ABBR || "").trim();
    if (code && name) names.set(code, name);
  }
  return names;
}

function normalizeConfigEntries(entries) {
  return entries.flatMap((entry) => {
    const code = String(entry?.code || "").trim().toUpperCase();
    if (!code) return [];
    const industry = String(entry?.industry ?? entry?.em2016 ?? "").trim() || null;
    const industryLevels = Array.isArray(entry?.industryLevels)
      ? entry.industryLevels.map((item) => String(item || "").trim()).filter(Boolean)
      : industry ? industry.split("-").map((item) => item.trim()).filter(Boolean) : [];
    return [{
      code,
      name: String(entry?.name || "").trim() || undefined,
      availability: String(entry?.availability || entry?.status || (industry ? "available" : "unavailable")).trim() || "unavailable",
      industry,
      industryLevels,
      mainBusiness: String(entry?.mainBusiness ?? "").trim() || null,
      products: Array.isArray(entry?.products) ? [...new Set(entry.products.map((item) => String(item || "").trim()).filter(Boolean))] : [],
      sourceUrl: String(entry?.sourceUrl || "").trim() || undefined,
      updatedAt: String(entry?.updatedAt || "").trim() || undefined,
    }];
  });
}

function isUsableProfile(entry) {
  return Boolean(entry && entry.availability === "available" && entry.industry && Array.isArray(entry.industryLevels) && entry.industryLevels.length === 3);
}

async function fetchProfiles(codes, limit, namesByCode) {
  const results = new Map();
  const queue = [...codes];
  async function worker() {
    while (queue.length) {
      const code = queue.shift();
      if (!code) continue;
      const profile = await fetchProfile(code, namesByCode.get(code) || "");
      results.set(code, profile);
      process.stderr.write(`${code} ${profile.availability}${profile.industry ? ` ${profile.industry}` : ""}\n`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, queue.length || 1) }, () => worker()));
  return results;
}

async function fetchProfile(code, fallbackName) {
  const url = new URL("https://datacenter.eastmoney.com/securities/api/data/v1/get");
  url.searchParams.set("reportName", "RPT_F10_ORG_BASICINFO");
  url.searchParams.set("columns", "SECUCODE,SECURITY_NAME_ABBR,EM2016,MAIN_BUSINESS,MAXPROFIT_PRODUCT,PRODUCT_NAME");
  url.searchParams.set("quoteColumns", "");
  url.searchParams.set("filter", `(SECUCODE=\"${code}\")`);
  url.searchParams.set("pageNumber", "1");
  url.searchParams.set("pageSize", "1");
  url.searchParams.set("sortTypes", "");
  url.searchParams.set("sortColumns", "");
  url.searchParams.set("source", "HSF10");
  url.searchParams.set("client", "PC");
  const sourceUrl = url.toString();
  try {
    const response = await fetch(url, { headers: { Referer: "https://emweb.securities.eastmoney.com/" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    const row = Array.isArray(body?.result?.data) ? body.result.data[0] : null;
    const industry = String(row?.EM2016 ?? "").trim() || null;
    return {
      code,
      name: String(row?.SECURITY_NAME_ABBR ?? "").trim() || fallbackName || undefined,
      availability: industry ? "available" : "unavailable",
      industry,
      industryLevels: industry ? industry.split("-").map((item) => item.trim()).filter(Boolean) : [],
      mainBusiness: String(row?.MAIN_BUSINESS ?? "").trim() || null,
      products: [...new Set([row?.MAXPROFIT_PRODUCT, row?.PRODUCT_NAME].map((item) => String(item ?? "").trim()).filter(Boolean))],
      sourceUrl,
      updatedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      code,
      name: fallbackName || undefined,
      availability: "unavailable",
      industry: null,
      industryLevels: [],
      mainBusiness: null,
      products: [],
      sourceUrl,
      updatedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
