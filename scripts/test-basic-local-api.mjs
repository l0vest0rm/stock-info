#!/usr/bin/env node

// Run after ./start-local.sh has made the Node API healthy.
const baseUrl = String(process.env.BASIC_TEST_BASE_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");
const code = "300308.SZ";
const timeoutMs = Number(process.env.BASIC_TEST_TIMEOUT_MS || 60000);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function finitePositive(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

async function get(path) {
  const response = await fetch(new URL(path, baseUrl), { signal: AbortSignal.timeout(timeoutMs) });
  const body = await response.json().catch(() => null);
  assert(response.ok && body?.code === 200, `${path}: HTTP ${response.status}, ${body?.msg || "invalid JSON response"}`);
  return body.data;
}

const health = await get("/api/health");
assert(health?.d1 === true, "local database health check failed");

const kline = await get(`/api/kline?code=${code}&period=day&fq=normal&format=structured`);
assert(Array.isArray(kline) && kline.length > 0, "中际旭创 K 线数据为空");
const latestKline = kline.at(-1);
assert(typeof latestKline?.date === "string" && finitePositive(latestKline.close), "中际旭创最新 K 线无有效日期或收盘价");

const statements = {};
for (const type of ["income", "balance", "cashflow"]) {
  const model = await get(`/api/finance/${type}?code=${code}&format=read-model`);
  assert(model?.code === code && model.statementType === type, `${type} 财报代码或类型错误`);
  assert(model.sourcePolicy?.primaryProvider === "eastmoney", `${type} 财报主数据源不是东方财富`);
  assert(model.sourceHealth?.status === "healthy" && Array.isArray(model.rows) && model.rows.length > 0,
    `${type} 财报不可用：${model.sourceHealth?.message || model.sourceHealth?.reason || "无数据"}`);
  assert(model.fieldAvailability?.nonEmptyPayloadRows > 0 && model.latestReportDate, `${type} 财报缺少有效内容或报告期`);
  statements[type] = { rows: model.rows.length, latestReportDate: model.latestReportDate };
}

const overview = await get(`/api/company/overview?code=${code}`);
assert(overview?.code === code && overview.name?.includes("中际旭创"), "公司概览不是中际旭创");
assert(finitePositive(overview.latestPrice), "公司概览缺少最新价格");
assert(finitePositive(overview.marketCapYi), "公司概览缺少有效市值（亿元）");
assert(finitePositive(overview.peTtm), "公司概览缺少有效 PE(TTM)");

console.log(JSON.stringify({
  status: "passed",
  code,
  name: overview.name,
  kline: { rows: kline.length, latestDate: latestKline.date, latestClose: latestKline.close },
  statements,
  peTtm: overview.peTtm,
  marketCapYi: overview.marketCapYi,
}, null, 2));
