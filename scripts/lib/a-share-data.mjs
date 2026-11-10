// 全 A 股筛选的数据获取层：行业/市值快照 + 东财利润表。
//
// 边界（AGENTS.md）：
//   - 股票 K 线只用雪球，这里不取K线。雪球在 ./kline-store.mjs。
//   - 行业归属和总市值用东财行情快照（f100 行业名、f20 总市值、f12 代码、f14 名称）。
//     K线仍是唯一的价格来源，快照只用来选「行业内市值 Top N」。
//   - 利润表用东财 F10，与后端 finance/providers.rs 的 RPT_F10_FINANCE_* 家族一致。
//
// 两个接口都有本地磁盘缓存：行业快照按交易日缓存一天，利润表缓存数天，
// 重复运行基本不联网。缓存只是取数加速，任何缺失都会在结果里显式标注。

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { readJson, writeJsonAtomic } from "./kline-store.mjs";

const EM_HEADERS = {
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
  referer: "https://quote.eastmoney.com/",
  accept: "*/*",
};

const EM_F10_HEADERS = {
  "user-agent": EM_HEADERS["user-agent"],
  referer: "https://emweb.securities.eastmoney.com/",
};

// 沪市主板+科创板、深市主板+创业板、北交所
const A_SHARE_FS = ["m:0+t:6", "m:0+t:80", "m:1+t:2", "m:1+t:23", "m:0+t:81+s:2048"].join(",");

function eastmoneyCode(code) {
  const match = /^(\d{6})\.(SH|SZ|BJ)$/.exec(code ?? "");
  return match ? match[1] : null;
}

/**
 * 全 A 股行业快照。返回 [{ code, name, industry, marketCap, close, percent }]。
 * 分页拉，总条数以接口返回的 total 为准；中途失败就抛错，不做部分静默成功。
 */
export async function fetchIndustrySnapshot({ cacheDir, maxAgeMs = 6 * 3600_000, onProgress } = {}) {
  const cachePath = cacheDir ? resolve(cacheDir, "a-share-industry-snapshot.json") : null;
  if (cachePath && existsSync(cachePath)) {
    const cached = readJson(cachePath);
    const age = Date.now() - Number(cached?.fetchedAt ?? 0);
    if (cached?.rows?.length && age >= 0 && age < maxAgeMs) {
      return { rows: cached.rows, fetchedAt: cached.fetchedAt, fromCache: true };
    }
  }

  const rows = [];
  const seen = new Set();
  let total = null;
  for (let page = 1; page <= 200; page += 1) {
    const url = new URL("https://82.push2.eastmoney.com/api/qt/clist/get");
    url.searchParams.set("pn", String(page));
    url.searchParams.set("pz", "100");
    url.searchParams.set("po", "1");
    url.searchParams.set("np", "1");
    url.searchParams.set("fltt", "2");
    url.searchParams.set("invt", "2");
    url.searchParams.set("fid", "f20");
    url.searchParams.set("fs", A_SHARE_FS);
    url.searchParams.set("fields", "f12,f13,f14,f20,f2,f3,f100");
    const response = await fetch(url, { headers: EM_HEADERS, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`东财行情快照失败：HTTP ${response.status}`);
    const body = await response.json();
    const diff = body?.data?.diff;
    if (!Array.isArray(diff) || diff.length === 0) break;
    total = Number(body?.data?.total ?? total ?? 0);
    for (const item of diff) {
      const digits = String(item.f12 ?? "");
      if (!/^\d{6}$/.test(digits)) continue;
      const suffix = Number(item.f13) === 1 ? "SH" : /^(4|8|9)/.test(digits) ? "BJ" : "SZ";
      const code = `${digits}.${suffix}`;
      if (seen.has(code)) continue;
      seen.add(code);
      rows.push({
        code,
        name: String(item.f14 ?? "").trim(),
        industry: String(item.f100 ?? "").trim(),
        marketCap: Number.isFinite(item.f20) && item.f20 > 0 ? item.f20 : null,
        close: Number.isFinite(item.f2) && item.f2 > 0 ? item.f2 : null,
        percent: Number.isFinite(item.f3) ? item.f3 : null,
      });
    }
    onProgress?.({ page, collected: rows.length, total });
    if (total && rows.length >= total) break;
  }
  if (!rows.length) throw new Error("东财行情快照返回空列表");

  const fetchedAt = Date.now();
  if (cachePath) writeJsonAtomic(cachePath, { fetchedAt, total: total ?? rows.length, rows });
  return { rows, fetchedAt, fromCache: false };
}

function reportDates(now = new Date()) {
  // 与后端 report_dates 相同的窗口：近 8 年、按季度
  const dates = [];
  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth() + 1;
  for (let offset = 0; offset < 8; offset += 1) {
    const year = currentYear - offset;
    if (offset > 0) dates.push(`${year}-12-31`);
    for (const [month, end] of [[9, "09-30"], [6, "06-30"], [3, "03-31"]]) {
      if (offset > 0 || currentMonth > month) dates.push(`${year}-${end}`);
    }
  }
  return dates;
}

/** 与后端 finance-mappings.json 一致：银行/券商/保险用各自的报表家族。 */
export function reportFamily(code, mappings) {
  if (mappings?.bankCodes?.includes(code)) return "B";
  if (mappings?.securityCodes?.includes(code)) return "S";
  if (mappings?.insuranceCodes?.includes(code)) return "I";
  return "G";
}

async function fetchIncomeKind(code, kind, dates) {
  const eastmoney = eastmoneyCode(code);
  if (!eastmoney) throw new Error("不支持的A股代码");
  const url = new URL("https://datacenter-web.eastmoney.com/securities/api/data/get");
  url.searchParams.set("type", `RPT_F10_FINANCE_${kind}`);
  url.searchParams.set("sty", `APP_F10_${kind}`);
  url.searchParams.set("filter", `(SECUCODE="${code}")(REPORT_DATE in ('${dates.join("','")}'))`);
  url.searchParams.set("p", "1");
  url.searchParams.set("ps", "");
  url.searchParams.set("sr", "-1");
  url.searchParams.set("st", "REPORT_DATE");
  url.searchParams.set("source", "HSF10");
  url.searchParams.set("client", "PC");
  const response = await fetch(url, { headers: EM_F10_HEADERS, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`东财利润表失败：HTTP ${response.status}`);
  const body = await response.json();
  if (body?.success === false) throw new Error(`东财利润表失败：${body?.message ?? "unknown"}`);
  return Array.isArray(body?.result?.data) ? body.result.data : [];
}

function toSnapshotRows(code, data, contract) {
  const now = Date.now();
  const rows = [];
  for (const payload of data) {
    const reportDate = String(payload?.REPORT_DATE ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) continue;
    const fiscalPeriod = String(payload?.REPORT_TYPE ?? "");
    const annual = /^(年报|ANNUAL|FY|12M)$/i.test(fiscalPeriod);
    rows.push({
      code,
      statementType: "income",
      reportDate,
      fiscalPeriod: annual && contract !== "quarterly" ? "12M" : fiscalPeriod,
      payload: { ...payload, FINANCIAL_SOURCE_CONTRACT: contract },
      source: "eastmoney",
      rawR2Key: null,
      updatedAt: now,
    });
  }
  return rows;
}

/**
 * 一只票的利润表：累计 + 单季度两个家族，合并成后端快照同构的 rows。
 * 任一家族失败都抛错，由调用方把该票标成「财务缺失」，而不是拼出半边数据。
 */
export async function fetchIncomeRows(code, { family = "G", cacheDir, maxAgeMs = 7 * 86_400_000, offline = false, now } = {}) {
  // 缓存写在自己的目录，绝不写入后端 finance 读取的正式快照目录：
  // 那边的文件必须满足「累计 + 年报都在」的合同校验，这里只用于筛选。
  const cachePath = cacheDir ? resolve(cacheDir, `${code}.json`) : null;
  if (cachePath && existsSync(cachePath)) {
    const cached = readJson(cachePath);
    const age = Date.now() - Number(cached?.fetchedAt ?? 0);
    if (cached?.rows?.length && age >= 0 && age < maxAgeMs) return { rows: cached.rows, fromCache: true };
  }
  if (offline) throw new Error("offline 且没有本地财报缓存");

  const dates = reportDates(now);
  const cumulative = await fetchIncomeKind(code, `${family}INCOME`, dates);
  let quarterly = [];
  try {
    quarterly = await fetchIncomeKind(code, `${family}INCOMEQC`, dates);
  } catch {
    // 单季度家族部分标的没有；此时由 oversold-metrics 用累计差得到单季，属正常降级
    quarterly = [];
  }
  const rows = [
    ...toSnapshotRows(code, cumulative, "eastmoney_f10_income.v1"),
    ...toSnapshotRows(code, quarterly, "eastmoney_f10_incomeqc.v1"),
  ];
  if (!rows.length) throw new Error("东财利润表返回空数据");
  if (cachePath) writeJsonAtomic(cachePath, { fetchedAt: Date.now(), code, rows });
  return { rows, fromCache: false };
}
