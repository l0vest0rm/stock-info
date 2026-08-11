#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

const outputPath = new URL("../config/research-eastmoney-em2016-top300.json", import.meta.url);
const ranking = await fetchTop300();
const rows = ranking.map((row, index) => ({ rank: index + 1, code: String(row.SECUCODE ?? ""), name: String(row.SECURITY_NAME_ABBR ?? ""), institutionCount: Number(row.ALLCORP_NUM ?? 0), dataDate: String(row.MAX_TRADE_DATE ?? "") }));
if (rows.length !== 300) throw new Error(`expected exactly 300 Top300 rows, received ${rows.length}`);
const offset = integerOption("--offset", 0);
const limit = integerOption("--limit", rows.length);
if (offset < 0 || limit < 1 || offset >= rows.length) throw new Error(`invalid range: offset=${offset}, limit=${limit}`);
const selectedRows = rows.slice(offset, offset + limit);
const existing = await readExistingOutput();
const resultsByCode = new Map((Array.isArray(existing?.rows) ? existing.rows : []).map((row) => [String(row?.code ?? ""), row]));

const collectedAt = new Date().toISOString();
for (const [index, row] of selectedRows.entries()) {
  const code = String(row?.code ?? "").trim().toUpperCase();
  if (!/^\d{6}\.(?:SH|SZ|BJ)$/.test(code)) {
    resultsByCode.set(code, { code, name: String(row?.name ?? ""), status: "unsupported", em2016: null, mainBusiness: null, products: [] });
    continue;
  }
  const profile = await fetchProfile(code);
  resultsByCode.set(code, { code, name: String(row?.name ?? ""), ...profile });
  process.stderr.write(`[${offset + index + 1}/${rows.length}] ${code} ${profile.status}${profile.em2016 ? ` ${profile.em2016}` : ""}\n`);
}
const results = rows.map((row) => resultsByCode.get(String(row?.code ?? "").trim().toUpperCase())).filter(Boolean);

const industries = [...new Map(results.filter((row) => row.status === "available" && row.em2016).map((row) => [row.em2016, {
  em2016: row.em2016,
  levels: row.em2016.split("-").map((item) => item.trim()).filter(Boolean),
  securityCodes: [],
  securityNames: [],
}])).values()];
const byIndustry = new Map(industries.map((item) => [item.em2016, item]));
for (const row of results) {
  const industry = row.em2016 ? byIndustry.get(row.em2016) : null;
  if (!industry) continue;
  industry.securityCodes.push(row.code);
  industry.securityNames.push(row.name);
}
for (const industry of industries) {
  industry.securityCodes.sort();
  industry.securityNames.sort();
}
industries.sort((left, right) => left.em2016.localeCompare(right.em2016, "zh-CN"));

const output = {
  schemaVersion: "research-eastmoney-em2016-top300.v1",
  source: {
    ranking: "Eastmoney institutional holding count Top300",
    rankingDataDate: String(rows[0]?.dataDate ?? ""),
    rankingGeneratedAt: collectedAt,
    rankingEndpoint: "https://data.eastmoney.com/dataapi/xuangu/list?st=ALLCORP_NUM&sr=-1&ps=300&p=1",
    endpoint: "https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_F10_ORG_BASICINFO",
    field: "EM2016",
    collectedAt,
  },
  rows: results,
  industries,
  coverage: {
    total: results.length,
    available: results.filter((row) => row.status === "available").length,
    unavailable: results.filter((row) => row.status === "unavailable").length,
    unsupported: results.filter((row) => row.status === "unsupported").length,
    uniqueEm2016: industries.length,
  },
};
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output: outputPath.pathname, coverage: output.coverage }, null, 2));

function integerOption(name, fallback) {
  const position = process.argv.indexOf(name);
  if (position < 0) return fallback;
  const value = Number(process.argv[position + 1]);
  return Number.isInteger(value) ? value : fallback;
}

async function readExistingOutput() {
  try { return JSON.parse(await readFile(outputPath, "utf8")); }
  catch (error) { if (error && typeof error === "object" && error.code === "ENOENT") return null; throw error; }
}

async function fetchProfile(code) {
  const url = new URL("https://datacenter.eastmoney.com/securities/api/data/v1/get");
  url.searchParams.set("reportName", "RPT_F10_ORG_BASICINFO");
  url.searchParams.set("columns", "SECUCODE,EM2016,MAIN_BUSINESS,MAXPROFIT_PRODUCT,PRODUCT_NAME");
  url.searchParams.set("quoteColumns", "");
  url.searchParams.set("filter", `(SECUCODE=\"${code}\")`);
  url.searchParams.set("pageNumber", "1");
  url.searchParams.set("pageSize", "1");
  url.searchParams.set("sortTypes", "");
  url.searchParams.set("sortColumns", "");
  url.searchParams.set("source", "HSF10");
  url.searchParams.set("client", "PC");
  try {
    const response = await fetch(url, { headers: { Referer: "https://emweb.securities.eastmoney.com/" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    const item = Array.isArray(body?.result?.data) ? body.result.data[0] : null;
    const em2016 = String(item?.EM2016 ?? "").trim() || null;
    return {
      status: em2016 ? "available" : "unavailable",
      em2016,
      mainBusiness: String(item?.MAIN_BUSINESS ?? "").trim() || null,
      products: [...new Set([item?.MAXPROFIT_PRODUCT, item?.PRODUCT_NAME].map((value) => String(value ?? "").trim()).filter(Boolean))],
    };
  } catch (error) {
    return { status: "unavailable", em2016: null, mainBusiness: null, products: [], error: error instanceof Error ? error.message : String(error) };
  }
}

async function fetchTop300() {
  const url = new URL("https://data.eastmoney.com/dataapi/xuangu/list");
  url.search = new URLSearchParams({ st: "ALLCORP_NUM", sr: "-1", ps: "300", p: "1", sty: "SECUCODE,SECURITY_NAME_ABBR,ALLCORP_NUM,MAX_TRADE_DATE", source: "SELECT_SECURITIES", client: "WEB" }).toString();
  const response = await fetch(url, { headers: { Referer: "https://data.eastmoney.com/xuangu/" } });
  if (!response.ok) throw new Error(`Top300 ranking request failed: HTTP ${response.status}`);
  const body = await response.json();
  const data = Array.isArray(body?.result?.data) ? body.result.data : [];
  if (data.length !== 300 || new Set(data.map((row) => String(row?.SECUCODE ?? ""))).size !== 300) throw new Error(`Top300 ranking response is invalid: ${data.length} rows`);
  return data;
}
