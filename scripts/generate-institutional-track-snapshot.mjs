#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
const baseUrl = process.argv[2] || "https://tinfo.cc";
const output = new URL("../web/src/config/institutional-track-snapshot.json", import.meta.url);
const rankingUrl = new URL("/api/companies/filter", baseUrl);
rankingUrl.search = new URLSearchParams({
  st: "ALLCORP_NUM",
  sr: "-1",
  ps: "300",
  p: "1",
  sty: "SECUCODE,SECURITY_NAME_ABBR,ALLCORP_NUM,MAX_TRADE_DATE",
}).toString();

const rankingResponse = await fetch(rankingUrl);
if (!rankingResponse.ok) throw new Error(`ranking request failed: HTTP ${rankingResponse.status}`);
const rankingBody = await rankingResponse.json();
const ranking = Array.isArray(rankingBody?.data?.data) ? rankingBody.data.data : [];
if (ranking.length !== 300) throw new Error(`expected 300 ranking rows, received ${ranking.length}`);
if (new Set(ranking.map((row) => row.SECUCODE)).size !== 300) throw new Error("ranking contains duplicate codes");
if (ranking.some((row, index) => index > 0 && Number(row.ALLCORP_NUM) > Number(ranking[index - 1].ALLCORP_NUM))) {
  throw new Error("ranking is not sorted by ALLCORP_NUM descending");
}

const [industryRows, conceptRows] = await Promise.all([fetchIndustries(), fetchConcepts()]);
const industryMap = new Map(industryRows.map((row) => [String(row.f12 || ""), String(row.f100 || "")]));
const conceptMap = new Map(conceptRows.map((row) => [String(row.SECUCODE || ""), row]));
const snapshot = {
  generatedAt: new Date().toISOString(),
  dataDate: String(ranking[0]?.MAX_TRADE_DATE || ""),
  rankingField: "ALLCORP_NUM",
  source: "Eastmoney via stock-info",
  rows: ranking.map((row, index) => ({
    rank: index + 1,
    code: String(row.SECUCODE),
    name: String(row.SECURITY_NAME_ABBR || ""),
    institutionCount: Number(row.ALLCORP_NUM || 0),
    industry: industryMap.get(String(row.SECUCODE).slice(0, 6)) || String(conceptMap.get(String(row.SECUCODE))?.INDUSTRY || "未分类"),
    concepts: Array.isArray(conceptMap.get(String(row.SECUCODE))?.CONCEPT) ? conceptMap.get(String(row.SECUCODE)).CONCEPT.map(String) : [],
  })),
};
await writeFile(output, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output: output.pathname, rows: snapshot.rows.length, dataDate: snapshot.dataDate }, null, 2));

async function fetchIndustries() {
  const first = await fetchApi("/api/companies/change?pz=100&pn=1");
  const pageCount = Math.ceil(Number(first.total || 0) / 100);
  const remaining = await mapConcurrent(
    Array.from({ length: Math.max(0, pageCount - 1) }, (_, index) => index + 2),
    2,
    (page) => fetchApi(`/api/companies/change?pz=100&pn=${page}`)
  );
  return [first, ...remaining].flatMap((page) => Array.isArray(page.diff) ? page.diff : []);
}

async function fetchConcepts() {
  const data = await fetchApi("/api/companies/filter?st=ALLCORP_NUM&sr=-1&ps=1000&p=1&sty=SECUCODE,INDUSTRY,CONCEPT");
  return Array.isArray(data.data) ? data.data : [];
}

async function fetchApi(pathname) {
  let lastError;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const response = await fetch(new URL(pathname, baseUrl));
      if (!response.ok) throw new Error(`${pathname} failed: HTTP ${response.status}`);
      const body = await response.json();
      if (body?.code !== 200) throw new Error(`${pathname} failed: ${body?.msg || "unknown error"}`);
      return body.data;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  throw lastError;
}

async function mapConcurrent(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index]);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}
