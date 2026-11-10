// 雪球 K 线取数与本地缓存：两个筛选脚本共用的 I/O 层。
//
// 约束（见 AGENTS.md）：A 股 K 线只允许雪球。这里不提供任何备用数据源，
// 缺 Cookie、被人机验证、返回 HTML 时都显式失败，不做静默降级。
//
// 缓存结构保持后端快照格式（schemaVersion 2，rows 为日K数组），
// 只做「补缺/更新」，不删除已有行。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { DAY, closeOf, daysBetween, positive } from "./oversold-metrics.mjs";

const XUEQIU_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

export const todayUtc = () => new Date().toISOString().slice(0, 10);

export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, path);
}

export function xueqiuSymbol(code) {
  const match = /^(\d{6})\.(SH|SZ|BJ)$/.exec(code ?? "");
  if (!match) return null;
  return `${match[2]}${match[1]}`;
}

/**
 * 雪球 Cookie：本地凭据仓 → 环境变量 → .dev.vars（与后端 xueqiu.rs 优先级一致）。
 * 只返回内存中的字符串，绝不打印或落盘。
 */
export function xueqiuCookie({ credentialStore, root }) {
  const stored = readJson(credentialStore);
  if (typeof stored?.cookie === "string" && stored.cookie.trim()) return stored.cookie.trim();
  if (process.env.XUEQIU_COOKIE?.trim()) return process.env.XUEQIU_COOKIE.trim();
  try {
    const text = readFileSync(resolve(root, ".dev.vars"), "utf8");
    for (const line of text.split("\n")) {
      const match = /^\s*XUEQIU_COOKIE\s*=\s*"?([^"\r\n]*)"?\s*$/.exec(line);
      if (match?.[1]?.trim()) return match[1].trim();
    }
  } catch {
    // 没有 .dev.vars 就是没有，不算错误
  }
  return null;
}

export function readKlineCache(klineDir, code) {
  const path = resolve(klineDir, `${code}.json`);
  if (!existsSync(path)) return { exists: false, path, rows: [] };
  const snapshot = readJson(path);
  const raw = Array.isArray(snapshot?.rows) ? snapshot.rows : [];
  const rows = [];
  const seen = new Set();
  for (const row of raw) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row?.date ?? "") || seen.has(row.date)) continue;
    if (!positive(closeOf(row))) continue;
    seen.add(row.date);
    rows.push(row);
  }
  rows.sort((left, right) => left.date.localeCompare(right.date));
  return { exists: true, path, snapshot, rows };
}

export function parseXueqiuKline(body, code) {
  if (!body?.data?.column || !Array.isArray(body.data.item)) throw new Error("雪球K线结构无效");
  const columns = body.data.column;
  const at = (item, name) => {
    const index = columns.indexOf(name);
    const value = index >= 0 ? item[index] : null;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };
  const rows = [];
  for (const item of body.data.item) {
    if (!Array.isArray(item)) continue;
    const stamp = at(item, "timestamp");
    if (!positive(stamp)) continue;
    const date = new Date(stamp + 8 * 3_600_000).toISOString().slice(0, 10);
    const close = at(item, "close");
    if (!positive(close)) continue;
    rows.push({
      code,
      date,
      open: at(item, "open"),
      high: at(item, "high"),
      low: at(item, "low"),
      close,
      volume: at(item, "volume"),
      peTtm: positive(at(item, "pe")) ? at(item, "pe") : null,
      pb: positive(at(item, "pb")) ? at(item, "pb") : null,
      marketCapital: positive(at(item, "market_capital")) ? at(item, "market_capital") : null,
      source: "xueqiu",
    });
  }
  return rows;
}

/** 雪球日K（前复权）。indicator 与后端 xueqiu.rs 保持一致，保证 pe/pb/市值同口径。 */
export async function fetchXueqiuKline(code, cookie, { timeoutMs = 20_000, count = -2000 } = {}) {
  const symbol = xueqiuSymbol(code);
  if (!symbol) throw new Error("不支持的A股代码");
  const url = new URL("https://stock.xueqiu.com/v5/stock/chart/kline.json");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("begin", String(Date.now() + 2 * DAY));
  url.searchParams.set("period", "day");
  url.searchParams.set("type", "before");
  url.searchParams.set("count", String(count));
  url.searchParams.set("indicator", "kline,pe,pb,ps,pcf,market_capital,agt,ggt,balance");
  const response = await fetch(url, {
    headers: {
      cookie,
      referer: "https://xueqiu.com/",
      "user-agent": XUEQIU_UA,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "accept-language": "zh-CN,zh;q=0.9",
      "cache-control": "no-cache",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (text.trimStart().startsWith("<")) {
    throw new Error(text.includes("人机验证") || text.includes("访问触发保护") ? "雪球触发人机验证，请先刷新雪球 Cookie" : "雪球返回 HTML");
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`雪球返回非 JSON（HTTP ${response.status}）`);
  }
  const errorCode = body?.error_code;
  if (errorCode !== undefined && errorCode !== null && String(errorCode) !== "0") {
    throw new Error(`雪球行情失败：${body?.error_description ?? errorCode}`);
  }
  return parseXueqiuKline(body, code);
}

/** 合并新旧行，保留后端快照的其余字段，只补缺/更新。 */
export function mergeKlineCache(snapshot, code, fresh) {
  const byDate = new Map();
  for (const row of snapshot?.rows ?? []) {
    if (row?.date && !byDate.has(row.date)) byDate.set(row.date, row);
  }
  for (const row of fresh) {
    const previous = byDate.get(row.date);
    byDate.set(row.date, { ...previous, ...row, updatedAt: Date.now() });
  }
  const rows = [...byDate.values()].sort((left, right) => String(left.date).localeCompare(String(right.date)));
  return {
    schemaVersion: 2,
    code,
    fq: "qfq",
    source: "xueqiu",
    updatedAt: Date.now(),
    startDate: rows[0]?.date ?? null,
    endDate: rows.at(-1)?.date ?? null,
    rows,
    rawResponseText: null,
  };
}

/**
 * 缓存优先的 K 线读取器。缺缓存、行数不足或落后超过 staleDays 时才联网。
 * 返回结构化状态（fetched / fetchError / current），由调用方决定是否把
 * 「行情未刷新」当成阻塞项，而不是在这里静默放过。
 */
export function createKlineResolver({ klineDir, credentialStore, root, offline, writeCache, staleDays, timeoutMs }) {
  let cookieCache;
  return async function ensureKline(code, refDate) {
    const cached = readKlineCache(klineDir, code);
    const cachedEnd = cached.rows.at(-1)?.date ?? null;
    const frontier = refDate ?? todayUtc();
    const age = cachedEnd ? daysBetween(cachedEnd, frontier) : null;
    const lagging = !cached.exists || cached.rows.length < 260 || age === null || age > staleDays;
    const result = {
      code,
      rows: cached.rows,
      cacheEnd: cachedEnd,
      fetched: false,
      fetchError: null,
      source: cached.exists ? "cache" : "missing",
      current: false,
    };
    if (!lagging) {
      result.current = true;
      return result;
    }
    if (offline) {
      result.fetchError = "offline";
      return result;
    }
    if (cookieCache === undefined) cookieCache = xueqiuCookie({ credentialStore, root });
    if (!cookieCache) {
      result.fetchError = "缺少 XUEQIU_COOKIE：请先 npm run refresh:xueqiu-cookie，或加 --offline 只用缓存";
      return result;
    }
    try {
      const fresh = await fetchXueqiuKline(code, cookieCache, { timeoutMs });
      result.fetched = true;
      result.source = cached.exists ? "cache+xueqiu" : "xueqiu";
      const merged = mergeKlineCache(cached.snapshot, code, fresh);
      result.rows = merged.rows;
      result.cacheEnd = result.rows.at(-1)?.date ?? null;
      result.current = result.cacheEnd === frontier
        || (result.cacheEnd ? daysBetween(result.cacheEnd, frontier) <= staleDays : false);
      if (writeCache) writeJsonAtomic(resolve(klineDir, `${code}.json`), merged);
    } catch (error) {
      result.fetchError = error instanceof Error ? error.message : String(error);
    }
    return result;
  };
}

/** 有界并发池，保持输入顺序。 */
export async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
