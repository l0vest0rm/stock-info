import type { Database } from "../platform/contracts";
import {
  normalizeSecurityCode,
} from "../shared/codes";
import { cachedFetchText, numberOrNull } from "../shared/http";
import type { ExternalHttpOptions } from "../shared/http";
import type { KlineBar } from "../types";

type XueqiuKlineResponse = {
  data?: {
    column?: unknown[];
    item?: unknown[][];
    name?: string;
  };
  error_code?: string | number;
  error_description?: string;
};

const XUEQIU_KLINE_URL = "https://stock.xueqiu.com/v5/stock/chart/kline.json";
const XUEQIU_REFERER = "https://xueqiu.com/";
// Explicitly supplied current default-browser User-Agent.
const XUEQIU_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
const XUEQIU_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8";
const XUEQIU_ACCEPT_LANGUAGE = "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7";

/** Dated spot market cap, not a K-line substitute or a PE-derived estimate. */
export function parseXueqiuQuote(text: string, code: string) {
  const normalized = normalizeSecurityCode(code);
  const symbol = xueqiuSymbol(normalized);
  const currency = normalized.endsWith('.US') ? 'USD' : normalized.endsWith('.HK') ? 'HKD' : 'CNY';
  let body;
  try { body = JSON.parse(text); } catch { throw new Error('雪球行情返回非 JSON 数据'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('雪球行情数据结构无效');
  if (isXueqiuAuthError(body)) throw new Error('雪球 Cookie 已失效或被拒绝');
  if (body.error_code != null && String(body.error_code) !== '0') throw new Error('雪球行情请求被拒绝');
  const q = body.data?.quote;
  const marketCap = numberOrNull(q?.market_capital);
  const timestamp = numberOrNull(q?.timestamp);
  if (!symbol || q?.symbol !== symbol || q?.currency !== currency
    || marketCap === null || !Number.isFinite(marketCap) || marketCap <= 0
    || timestamp === null || timestamp <= 0 || !Number.isFinite(new Date(timestamp).getTime())) {
    throw new Error('雪球行情标的、币种、市值或行情时间无效');
  }
  return { currency, marketCap, priceAsOf: new Date(timestamp).toLocaleDateString('en-CA', {
    timeZone: currency === 'USD' ? 'America/New_York' : 'Asia/Shanghai',
  }) };
}

export async function fetchXueqiuStockQuote(db: Database, code: string,
  httpOptions: ExternalHttpOptions | undefined, xueqiuCookie: string | undefined) {
  const normalized = normalizeSecurityCode(code);
  const symbol = xueqiuSymbol(normalized);
  if (!symbol) throw new Error('不支持的雪球行情标的');
  if (!xueqiuCookie?.trim()) throw new Error('XUEQIU_COOKIE is required for Xueqiu quote requests');
  const url = new URL('https://stock.xueqiu.com/v5/stock/quote.json');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('extend', 'detail');
  const text = await cachedFetchText(db, url.toString(), { headers: {
    Cookie: xueqiuCookie.trim(), Referer: XUEQIU_REFERER, 'User-Agent': XUEQIU_USER_AGENT,
    Accept: 'application/json',
  } }, 10 * 60_000, { ...httpOptions, cacheKey: `xueqiu:quote:v1:${normalized}`,
    validateResponseText: text => { parseXueqiuQuote(text, normalized); },
  });
  return { ...parseXueqiuQuote(text, normalized), fetchedAt: new Date().toISOString() };
}

export async function fetchXueqiuStockKline(
  db: Database,
  code: string,
  period: string,
  fq: string,
  to: string,
  httpOptions: ExternalHttpOptions | undefined,
  xueqiuCookie: string | undefined
): Promise<{ rows: KlineBar[]; rawResponseText: string }> {
  const normalized = normalizeSecurityCode(code);
  const symbol = xueqiuSymbol(normalized);
  if (!symbol) {
    throw new Error(`unsupported Xueqiu stock code: ${code}`);
  }
  const cookie = xueqiuCookie?.trim();
  if (!cookie) {
    throw new Error("XUEQIU_COOKIE is required for Xueqiu stock K-line requests");
  }
  const request = createXueqiuKlineRequest(symbol, period, fq, to, cookie);

  const rawResponseText = await cachedFetchText(db, request.url, {
    headers: request.headers,
  }, 10 * 60 * 1000, {
    ...httpOptions,
    cacheKey: `xueqiu:kline:v1:${normalized}:${period}:${fq}:${to}`,
    validateResponseText: (text) => { parseXueqiuKlineResponse(text); },
  });
  const body = parseXueqiuKlineResponse(rawResponseText);
  const now = Date.now();
  const rows = mapXueqiuKlineRows(body, { code: normalized, period, fq, updatedAt: now });
  return { rows, rawResponseText };
}

export function parseXueqiuKlineResponse(text: string): XueqiuKlineResponse {
  if (/^\s*</.test(text)) {
    if (/人机验证|访问触发保护|service\/captcha/.test(text)) {
      throw new Error("雪球访问触发保护，K线暂不可用。请在当前网络的浏览器打开 https://www.xueqiu.com/service/captcha 完成人机验证，再刷新本地雪球 Cookie 后重试。");
    }
    throw new Error("雪球K线接口返回了 HTML 而非行情数据，请检查雪球访问状态后重试。");
  }
  let body: XueqiuKlineResponse;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("雪球K线接口返回了无效 JSON，请稍后重试。");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("雪球K线接口返回了无效数据结构。");
  }
  if (isXueqiuAuthError(body)) {
    throw new Error("雪球 Cookie 已失效或被拒绝，请刷新本地雪球 Cookie 后重试。");
  }
  if (body.error_code != null && String(body.error_code) !== "0") {
    throw new Error(`雪球K线请求失败：${body.error_description || body.error_code}`);
  }
  if (!Array.isArray(body.data?.column) || !Array.isArray(body.data?.item)
    || !["timestamp", "open", "high", "low", "close"].every((column) => body.data!.column!.includes(column))) {
    throw new Error("雪球K线接口返回的数据缺少行情字段，请稍后重试。");
  }
  return body;
}

export function createXueqiuKlineRequest(
  symbol: string,
  period: string,
  fq: string,
  to: string,
  cookie: string
): { url: string; headers: Record<string, string> } {
  const url = new URL(XUEQIU_KLINE_URL);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("begin", String(Date.parse(`${to}T00:00:00.000Z`) + 86_400_000));
  url.searchParams.set("period", period);
  url.searchParams.set("type", xueqiuFq(fq));
  url.searchParams.set("count", "-7500");
  url.searchParams.set("indicator", "kline,pe,pb,ps,pcf,market_capital,agt,ggt,balance");
  return {
    url: url.toString(),
    headers: {
      Accept: XUEQIU_ACCEPT,
      "Accept-Language": XUEQIU_ACCEPT_LANGUAGE,
      Cookie: cookie,
      Referer: XUEQIU_REFERER,
      "User-Agent": XUEQIU_USER_AGENT,
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    },
  };
}

export function mapXueqiuKlineRows(
  response: XueqiuKlineResponse,
  context: Pick<KlineBar, "code" | "period" | "fq" | "updatedAt">
): KlineBar[] {
  const columnIndex = new Map(
    (response.data?.column ?? [])
      .map((column, index) => [typeof column === "string" ? column : "", index] as const)
      .filter(([column]) => Boolean(column))
  );
  for (const required of ["timestamp", "open", "high", "low", "close"]) {
    if (!columnIndex.has(required)) {
      throw new Error(`Xueqiu K-line response missing required column: ${required}`);
    }
  }
  const value = (item: unknown[], column: string): number | null => {
    const index = columnIndex.get(column);
    return index === undefined ? null : numberOrNull(item[index]);
  };
  return (response.data?.item ?? [])
    .filter((item): item is unknown[] => Array.isArray(item))
    .map((item) => ({
      ...context,
      date: xueqiuDate(item[columnIndex.get("timestamp")!]),
      volume: value(item, "volume"),
      open: value(item, "open"),
      high: value(item, "high"),
      low: value(item, "low"),
      close: value(item, "close"),
      turnover: value(item, "turnoverrate"),
      amplitude: null,
      pctChange: value(item, "percent"),
      changeAmount: value(item, "chg"),
      amount: value(item, "amount"),
      peTtm: value(item, "pe"),
      pb: value(item, "pb"),
      ps: value(item, "ps"),
      pcf: value(item, "pcf"),
      marketCapital: value(item, "market_capital"),
      balance: value(item, "balance"),
      source: "xueqiu",
    } satisfies KlineBar))
    .filter((row) => Boolean(row.date));
}

export function xueqiuSymbol(code: string): string | null {
  const normalized = normalizeSecurityCode(code);
  const [base, suffix] = normalized.split(".");
  if (!base || !suffix) return null;
  if (suffix === "SZ" || suffix === "ZF") return `SZ${base}`;
  if (suffix === "SH" || suffix === "SF") return `SH${base}`;
  if (suffix === "BJ") return `BJ${base}`;
  if (suffix === "HK") return base.padStart(5, "0");
  if (["US", "O", "N", "AF"].includes(suffix)) return base;
  return null;
}

export function xueqiuFq(fq: string): "before" | "normal" | "after" {
  if (fq === "qfq" || fq === "before") return "before";
  if (fq === "hfq" || fq === "after") return "after";
  return "normal";
}

function xueqiuDate(value: unknown): string {
  const timestamp = numberOrNull(value);
  if (timestamp === null) return "";
  return new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function isXueqiuAuthError(body: XueqiuKlineResponse): boolean {
  return String(body.error_code ?? "") === "400016"
    || /重新登录|登录.*失效|login/i.test(body.error_description ?? "");
}
