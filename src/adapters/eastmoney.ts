import financeMappings from "../../shared/finance-mappings.json";
import {
  financialStatementsCacheTtlMs,
  marketDataCacheExpiresAtMsForCode,
  marketDataCacheTtlMsForCode,
} from "../shared/cache-policy";
import {
  bareCode,
  eastmoneySecId,
  inferSecurityType,
  isSupportedSecurityCode,
  normalizeSecurityCode,
  securityMarket,
  securitySuffix,
} from "../shared/codes";
import { getAppKv, putAppKv } from "../db/queries";
import { cachedFetchJson, cachedFetchText, numberOrNull, parseJsonOrJsonp } from "../shared/http";
import type { ExternalHttpOptions } from "../shared/http";
import type { CompanyNotice, CompanyOverview, FinancialStatement, FundNavRow, KlineBar, SecurityRecord, StatementType } from "../types";

type EastmoneySuggestResponse = {
  GubaCodeTable?: {
    Data?: Array<{
      ShortName?: string;
      OuterCode?: string;
    }>;
  };
};

type EastmoneyStockKlineResponse = {
  data?: {
    code?: string;
    name?: string;
    klines?: string[];
  };
};

type EastmoneyFundNavResponse = {
  Data?: {
    LSJZList?: Array<{
      FSRQ?: string;
      DWJZ?: string;
      LJJZ?: string;
      JZZZL?: string;
      SGZT?: string;
      SHZT?: string;
    }>;
  };
  ErrCode?: number;
  ErrMsg?: string | null;
};

type EastmoneyFinanceResponse = {
  result?: {
    data?: Record<string, unknown>[];
    pages?: number;
    count?: number;
  };
};

type FinanceMappings = {
  bankCodes?: string[];
};

const bankCodeSet = new Set(((financeMappings as FinanceMappings).bankCodes ?? []).map((code) => normalizeSecurityCode(code)));
const PROVISIONAL_FINANCE_SOURCE_TTL_MS = 10 * 60 * 1000;

export type EastmoneyDataPage = {
  rows: Record<string, unknown>[];
  pages: number;
  count: number;
};

type EastmoneyOverviewResponse = {
  data?: {
    f57?: string;
    f58?: string;
    f116?: number;
    f117?: number;
    f162?: number;
    f167?: number;
    f43?: number;
    f169?: number;
    f170?: number;
    f168?: number;
  };
};

type EastmoneyNoticeResponse = {
  data?: {
    list?: Array<{
      art_code?: string;
      title?: string;
      notice_date?: string;
      columns?: Array<{
        column_name?: string;
      }>;
    }>;
  };
};

type YahooSuggestResponse = {
  quotes?: Array<{
    exchange?: string;
    exchDisp?: string;
    longname?: string;
    quoteType?: string;
    shortname?: string;
    symbol?: string;
  }> | null;
};

type YahooTimeseriesResponse = {
  timeseries?: {
    error?: { code?: string; description?: string } | null;
    result?: YahooTimeseriesResult[];
  };
};

type YahooOptionResponse = {
  optionChain?: {
    error?: { code?: string; description?: string } | null;
    result?: Array<{
      underlyingSymbol?: string;
      expirationDates?: number[];
      quote?: {
        regularMarketPrice?: number;
      };
      options?: Array<{
        expirationDate?: number;
        calls?: YahooOptionContract[];
        puts?: YahooOptionContract[];
      }>;
    }>;
  };
};

type YahooOptionContract = {
  contractSymbol?: string;
  strike?: number;
  lastPrice?: number;
  bid?: number;
  ask?: number;
  volume?: number;
  openInterest?: number;
};

type YahooTimeseriesResult = {
  meta?: {
    type?: string[];
  };
  [key: string]: unknown;
};

type YahooTimeseriesPoint = {
  asOfDate?: string;
  reportedValue?: {
    raw?: number;
  };
};

type NasdaqOptionChainResponse = {
  data?: NasdaqOptionChainData | null;
};

type NasdaqOptionChainData = {
  totalRecord?: number;
  lastTrade?: string | null;
  filterlist?: {
    fromdate?: {
      filter?: Array<{
        value?: string | null;
      }>;
    };
  };
  table?: {
    rows?: NasdaqOptionRow[];
  };
};

type NasdaqOptionRow = {
  expirygroup?: string | null;
  c_Last?: string | null;
  c_Bid?: string | null;
  c_Ask?: string | null;
  c_Volume?: string | null;
  c_Openinterest?: string | null;
  strike?: string | null;
  p_Last?: string | null;
  p_Bid?: string | null;
  p_Ask?: string | null;
  p_Volume?: string | null;
  p_Openinterest?: string | null;
  drillDownURL?: string | null;
};

export type USOptionContract = {
  symbol: string;
  type: "call" | "put";
  expiration: string;
  strike: number;
  last: number;
  bid: number;
  ask: number;
  price: number;
  volume: number;
  openInterest: number;
};

export type USOptionExpiration = {
  date: string;
  calls: USOptionContract[];
  puts: USOptionContract[];
};

export type USOptionChain = {
  code: string;
  symbol: string;
  currentPrice: number;
  expirations: USOptionExpiration[];
};

export type USOptionExpirationSummary = {
  date: string;
  strikeCount: number;
};

export type USOptionChainSummary = {
  code: string;
  symbol: string;
  currentPrice: number;
  updatedAt: number;
  expirations: USOptionExpirationSummary[];
  strikes: number[];
};

type USOptionChainMeta = {
  code: string;
  symbol: string;
  currentPrice: number;
  expirationDates: string[];
};

type USOptionChainSummaryMeta = {
  code: string;
  symbol: string;
  currentPrice: number;
  updatedAt: number;
  expirations: USOptionExpirationSummary[];
  strikes: number[];
};

type USOptionExpirationMeta = {
  date: string;
  callChunks: number;
  putChunks: number;
};

const EASTMONEY_SUGGEST_TOKEN = "D43BF722C8E33BDC906FB84D85E326E8";

export async function fetchEastmoneySuggest(db: D1Database, q: string): Promise<SecurityRecord[]> {
  const url = new URL("https://searchadapter.eastmoney.com/api/suggest/get");
  url.searchParams.set("input", q);
  url.searchParams.set("type", "8");
  url.searchParams.set("token", EASTMONEY_SUGGEST_TOKEN);
  url.searchParams.set("count", "10");
  const body = (await cachedFetchJson(db, url.toString(), {
    headers: { Referer: "https://www.eastmoney.com/" },
  }, 7 * 24 * 60 * 60 * 1000)) as EastmoneySuggestResponse;
  const now = Date.now();
  const records: SecurityRecord[] = [];
  for (const item of body.GubaCodeTable?.Data ?? []) {
    const rawCode = item.OuterCode?.trim() ?? "";
    const normalized = normalizeEastmoneySuggestCode(rawCode);
    const name = item.ShortName?.trim() ?? "";
    if (!normalized || !name || !isSupportedSecurityCode(normalized)) {
      continue;
    }
    records.push({
      code: normalized,
      market: securityMarket(normalized),
      type: inferSecurityType(normalized),
      name,
      source: "eastmoney",
      updatedAt: now,
    });
  }
  return records;
}

function normalizeEastmoneySuggestCode(rawCode: string): string {
  const code = rawCode.trim();
  const lowered = code.toLowerCase();
  if (lowered.startsWith("us") && code.length > 2) {
    return `${code.slice(2).toUpperCase()}.US`;
  }
  if (lowered.startsWith("hk") && code.length > 2) {
    return normalizeSecurityCode(code.slice(2));
  }
  if ((lowered.startsWith("sh") || lowered.startsWith("sz") || lowered.startsWith("bj")) && code.length > 2) {
    return normalizeSecurityCode(code.slice(2));
  }
  if (lowered.startsWith("of") && code.length > 2) {
    return `${code.slice(2).toUpperCase()}.OF`;
  }
  return normalizeSecurityCode(code);
}

export async function fetchYahooSuggest(
  db: D1Database,
  q: string,
  httpOptions?: ExternalHttpOptions
): Promise<SecurityRecord[]> {
  const trimmed = q.trim();
  if (!trimmed || containsHan(trimmed)) {
    return [];
  }
  const url = new URL("https://query2.finance.yahoo.com/v1/finance/search");
  url.searchParams.set("q", trimmed);
  url.searchParams.set("lang", "en-US");
  url.searchParams.set("region", "US");
  url.searchParams.set("quotesCount", "8");
  url.searchParams.set("newsCount", "0");
  url.searchParams.set("listsCount", "0");
  url.searchParams.set("enableFuzzyQuery", "false");
  url.searchParams.set("quotesQueryId", "tss_match_phrase_query");
  url.searchParams.set("multiQuoteQueryId", "multi_quote_single_token_query");
  url.searchParams.set("enableCb", "false");
  url.searchParams.set("enableNavLinks", "true");
  url.searchParams.set("enableEnhancedTrivialQuery", "true");
  const body = (await cachedFetchJson(db, url.toString(), {
    headers: yahooHeaders("https://finance.yahoo.com/quote/AAPL/"),
  }, 24 * 60 * 60 * 1000, httpOptions)) as YahooSuggestResponse;
  const now = Date.now();
  const records: SecurityRecord[] = [];
  const seen = new Set<string>();
  for (const item of body.quotes ?? []) {
    const code = normalizeYahooSuggestCode(item);
    if (!code || seen.has(code)) {
      continue;
    }
    seen.add(code);
    const name = item.longname?.trim() || item.shortname?.trim() || code;
    records.push({
      code,
      market: securityMarket(code),
      type: inferSecurityType(code),
      name,
      exchangeName: item.exchDisp || item.exchange || null,
      source: "yahoo",
      updatedAt: now,
    });
  }
  return records;
}

export async function fetchEastmoneyStockKline(
  db: D1Database,
  code: string,
  period: string,
  fq: string,
  from: string,
  to: string,
  httpOptions?: ExternalHttpOptions
): Promise<{ security?: SecurityRecord; rows: KlineBar[] }> {
  const normalized = normalizeSecurityCode(code);
  const secid = eastmoneySecId(normalized);
  if (!secid) {
    throw new Error(`unsupported Eastmoney stock code: ${code}`);
  }
  let body: EastmoneyStockKlineResponse | undefined;
  let lastError: unknown;
  for (let requestRound = 1; requestRound <= 3; requestRound += 1) {
    const requestNonce = Date.now() + requestRound;
    const url = new URL("https://push2his.eastmoney.com/api/qt/stock/kline/get");
    url.searchParams.set("cb", `jQuery3510123456789_${requestNonce}`);
    url.searchParams.set("secid", secid);
    url.searchParams.set("fields1", "f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13");
    url.searchParams.set("fields2", "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61");
    url.searchParams.set("klt", eastmoneyKlt(period));
    url.searchParams.set("fqt", eastmoneyFqt(fq));
    url.searchParams.set("beg", from.replaceAll("-", ""));
    url.searchParams.set("end", to.replaceAll("-", ""));
    url.searchParams.set("lmt", "120");
    url.searchParams.set("ut", "fa5fd1943c7b386f172d6893dbfba10b");
    url.searchParams.set("rtntype", "6");
    url.searchParams.set("_", String(requestNonce));
    try {
      body = (await cachedFetchJson(db, url.toString(), {
        headers: {
          Accept: "*/*",
          "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
          Cookie: "nid18=1",
          Referer: "https://quote.eastmoney.com/",
          "Sec-Fetch-Dest": "script",
          "Sec-Fetch-Mode": "no-cors",
          "Sec-Fetch-Site": "same-site",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
        },
      }, marketDataCacheTtlMsForCode(normalized), {
        ...httpOptions,
        cacheKey: `eastmoney:kline:v2:${normalized}:${period}:${fq}:${from}:${to}`,
      })) as EastmoneyStockKlineResponse;
      break;
    } catch (err) {
      lastError = err;
      if (requestRound < 3) {
        console.warn(`Eastmoney kline request failed for ${normalized}; retrying with a fresh JSONP request:`, err);
      }
    }
  }
  if (!body) {
    throw lastError;
  }
  const now = Date.now();
  const security = body.data?.name
    ? ({
        code: normalized,
        market: securityMarket(normalized),
        type: inferSecurityType(normalized),
        name: body.data.name,
        source: "eastmoney",
        updatedAt: now,
      } satisfies SecurityRecord)
    : undefined;
  const rows = (body.data?.klines ?? []).map((line) => {
    const parts = line.split(",");
    return {
      code: normalized,
      period,
      fq,
      date: parts[0] ?? "",
      open: numberOrNull(parts[1]),
      close: numberOrNull(parts[2]),
      high: numberOrNull(parts[3]),
      low: numberOrNull(parts[4]),
      volume: numberOrNull(parts[5]),
      amount: numberOrNull(parts[6]),
      amplitude: numberOrNull(parts[7]),
      pctChange: numberOrNull(parts[8]),
      changeAmount: numberOrNull(parts[9]),
      turnover: numberOrNull(parts[10]),
      source: "eastmoney",
      updatedAt: now,
    } satisfies KlineBar;
  });
  return { security, rows };
}

export async function fetchEastmoneyFundNav(
  db: D1Database,
  code: string,
  from: string,
  to: string,
  pageSize = 120
): Promise<FundNavRow[]> {
  const normalized = normalizeSecurityCode(code).endsWith(".OF")
    ? normalizeSecurityCode(code)
    : `${bareCode(code)}.OF`;
  const now = Date.now();
  const rows: FundNavRow[] = [];
  let pageIndex = 1;
  while (true) {
    const url = new URL("https://api.fund.eastmoney.com/f10/lsjz");
    url.searchParams.set("callback", "jQuery");
    url.searchParams.set("fundCode", bareCode(normalized));
    url.searchParams.set("pageIndex", String(pageIndex));
    url.searchParams.set("pageSize", String(pageSize));
    url.searchParams.set("startDate", from);
    url.searchParams.set("endDate", to);
    url.searchParams.set("_", String(now));
    const body = (await cachedFetchJson(db, url.toString(), {
      headers: { Referer: "https://fundf10.eastmoney.com/" },
    }, marketDataCacheTtlMsForCode(normalized))) as EastmoneyFundNavResponse;
    if (body.ErrCode && body.ErrCode !== 0) {
      throw new Error(`eastmoney fund nav error: code=${body.ErrCode} msg=${body.ErrMsg ?? ""}`);
    }
    const pageRows = (body.Data?.LSJZList ?? [])
      .map((item) => ({
        code: normalized,
        date: item.FSRQ ?? "",
        nav: numberOrNull(item.DWJZ),
        accumNav: numberOrNull(item.LJJZ),
        dailyReturn: numberOrNull(item.JZZZL),
        subscriptionStatus: item.SGZT ?? null,
        redemptionStatus: item.SHZT ?? null,
        updatedAt: now,
      }))
      .filter((row) => row.date);
    rows.push(...pageRows);
    if (pageRows.length < pageSize) {
      break;
    }
    pageIndex += 1;
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function fetchEastmoneyFinance(
  db: D1Database,
  code: string,
  statementType: StatementType,
  httpOptions?: ExternalHttpOptions
): Promise<FinancialStatement[]> {
  const normalized = normalizeSecurityCode(code);
  if (!/\.(SH|SZ|BJ)$/.test(normalized)) {
    throw new Error(`finance statement only supports CN A-share codes in the MVP: ${code}`);
  }
  const reportType = financeReportType(statementType, normalized);
  const url = new URL("https://datacenter-web.eastmoney.com/securities/api/data/get");
  url.searchParams.set("type", `RPT_F10_FINANCE_${reportType}`);
  url.searchParams.set("sty", financeStyle(statementType, reportType));
  url.searchParams.set(
    "filter",
    `(SECUCODE="${normalized}")(REPORT_DATE in ('${genReportDates(5).join("','")}'))`
  );
  url.searchParams.set("p", "1");
  url.searchParams.set("ps", "");
  url.searchParams.set("sr", "-1");
  url.searchParams.set("st", "REPORT_DATE");
  url.searchParams.set("source", "HSF10");
  url.searchParams.set("client", "PC");
  const body = (await cachedFetchJson(db, url.toString(), {
    headers: { Referer: "https://emweb.securities.eastmoney.com/" },
  }, 24 * 60 * 60 * 1000, {
    ...httpOptions,
    resolveCacheTtlMs: ({ text }) => ttlForEastmoneyFinancialResponse(text),
  })) as EastmoneyFinanceResponse;
  const now = Date.now();
  const statements: FinancialStatement[] = [];
  for (const row of body.result?.data ?? []) {
    const reportDate = trimDate(row.REPORT_DATE);
    if (!reportDate) {
      continue;
    }
    statements.push({
      code: normalized,
      statementType,
      reportDate,
      fiscalPeriod: typeof row.REPORT_TYPE === "string" ? row.REPORT_TYPE : null,
      payload: row,
      source: "eastmoney",
      rawR2Key: null,
      updatedAt: now,
    });
  }
  return statements;
}

export async function fetchEastmoneyPerformanceReportPage(
  db: D1Database,
  reportDate: string,
  pageNumber: number,
  pageSize: number
): Promise<EastmoneyDataPage> {
  return fetchEastmoneyDataPage(db, "https://datacenter-web.eastmoney.com/api/data/v1/get", {
    reportName: "RPT_FCI_PERFORMANCEE",
    columns: "ALL",
    filter: `(SECURITY_TYPE_CODE in ("058001001","058001008"))(TRADE_MARKET_CODE!="069001017")(REPORT_DATE='${reportDate}')`,
    pageNumber: String(pageNumber),
    pageSize: String(pageSize),
    sortTypes: "-1,-1",
    sortColumns: "UPDATE_DATE,SECURITY_CODE",
  }, PROVISIONAL_FINANCE_SOURCE_TTL_MS);
}

export async function fetchEastmoneyPerformanceForecastPage(
  db: D1Database,
  reportDate: string,
  pageNumber: number,
  pageSize: number
): Promise<EastmoneyDataPage> {
  return fetchEastmoneyDataPage(db, "https://datacenter-web.eastmoney.com/api/data/v1/get", {
    reportName: "RPT_PUBLIC_OP_NEWPREDICT",
    columns: "ALL",
    filter: `(REPORT_DATE='${reportDate}')`,
    pageNumber: String(pageNumber),
    pageSize: String(pageSize),
    sortTypes: "-1,-1",
    sortColumns: "NOTICE_DATE,SECURITY_CODE",
  }, PROVISIONAL_FINANCE_SOURCE_TTL_MS);
}

export async function fetchYahooFinance(
  db: D1Database,
  code: string,
  statementType: StatementType,
  httpOptions?: ExternalHttpOptions
): Promise<FinancialStatement[]> {
  const normalized = normalizeSecurityCode(code);
  const symbol = yahooChartSymbol(normalized);
  const url = new URL(`https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}`);
  url.searchParams.set("type", yahooFinanceTypes().join(","));
  url.searchParams.set("period1", "0");
  url.searchParams.set("period2", String(yahooStablePeriod2()));
  const body = (await cachedFetchJson(db, url.toString(), {
    headers: yahooFinanceHeaders(symbol),
  }, 24 * 60 * 60 * 1000, {
    ...httpOptions,
    resolveCacheTtlMs: ({ text }) => ttlForYahooFinancialResponse(text),
  })) as YahooTimeseriesResponse;
  const error = body.timeseries?.error;
  if (error) {
    throw new Error(`yahoo finance error: code=${error.code ?? ""} description=${error.description ?? ""}`);
  }
  const rowsByDate = new Map<string, Record<string, unknown>>();
  for (const result of body.timeseries?.result ?? []) {
    const type = result.meta?.type?.[0];
    if (!type) {
      continue;
    }
    const key = yahooFinancePayloadKey(type);
    if (!key) {
      continue;
    }
    const points = Array.isArray(result[type]) ? result[type] as YahooTimeseriesPoint[] : [];
    for (const point of points) {
      const reportDate = trimDate(point.asOfDate);
      if (!reportDate) {
        continue;
      }
      const row = rowsByDate.get(reportDate) ?? {
        reportDate,
        noticeDate: reportDate,
        REPORT_DATE: reportDate,
        NOTICE_DATE: reportDate,
      };
      row[key] = numberOrNull(point.reportedValue?.raw);
      rowsByDate.set(reportDate, row);
    }
  }
  const now = Date.now();
  return [...rowsByDate.values()]
    .map((payload) => normalizeYahooFinancePayload(payload, statementType))
    .filter((payload) => Object.keys(payload).length > 4)
    .sort((a, b) => String(b.reportDate).localeCompare(String(a.reportDate)))
    .map((payload) => ({
      code: normalized,
      statementType,
      reportDate: String(payload.reportDate),
      fiscalPeriod: "3M",
      payload,
      source: "yahoo",
      rawR2Key: null,
      updatedAt: now,
    }));
}

export async function fetchEastmoneyDataRows(
  db: D1Database,
  endpoint: string,
  params: Record<string, string>,
  ttlMs = 24 * 60 * 60 * 1000
): Promise<Record<string, unknown>[]> {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const body = (await cachedFetchJson(db, url.toString(), {
    headers: { Referer: "https://emweb.securities.eastmoney.com/" },
  }, ttlMs)) as EastmoneyFinanceResponse;
  return body.result?.data ?? [];
}

export async function fetchEastmoneyDataPage(
  db: D1Database,
  endpoint: string,
  params: Record<string, string>,
  ttlMs = 24 * 60 * 60 * 1000
): Promise<EastmoneyDataPage> {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const body = (await cachedFetchJson(db, url.toString(), {
    headers: { Referer: "https://emweb.securities.eastmoney.com/" },
  }, ttlMs)) as EastmoneyFinanceResponse;
  return {
    rows: body.result?.data ?? [],
    pages: Number(body.result?.pages ?? 0),
    count: Number(body.result?.count ?? 0),
  };
}

function ttlForEastmoneyFinancialResponse(text: string): number {
  try {
    const body = parseJsonOrJsonp(text) as EastmoneyFinanceResponse;
    const rows = (body.result?.data ?? [])
      .map((row) => ({ reportDate: trimDate(row.REPORT_DATE) }))
      .filter((row) => row.reportDate);
    return financialStatementsCacheTtlMs(rows);
  } catch {
    return 24 * 60 * 60 * 1000;
  }
}

function ttlForYahooFinancialResponse(text: string): number {
  try {
    const body = parseJsonOrJsonp(text) as YahooTimeseriesResponse;
    const reportDates = new Set<string>();
    for (const result of body.timeseries?.result ?? []) {
      for (const value of Object.values(result)) {
        if (!Array.isArray(value)) {
          continue;
        }
        for (const point of value as YahooTimeseriesPoint[]) {
          const reportDate = trimDate(point?.asOfDate);
          if (reportDate) {
            reportDates.add(reportDate);
          }
        }
      }
    }
    return financialStatementsCacheTtlMs([...reportDates].sort().reverse().map((reportDate) => ({ reportDate })));
  } catch {
    return 24 * 60 * 60 * 1000;
  }
}

export async function fetchEastmoneyText(
  db: D1Database,
  url: string,
  referer = "https://fundf10.eastmoney.com/",
  ttlMs = 24 * 60 * 60 * 1000
): Promise<string> {
  return cachedFetchText(db, url, {
    headers: {
      Referer: referer,
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    },
  }, ttlMs);
}

function yahooChartSymbol(code: string): string {
  if (code.endsWith(".US")) {
    return code.slice(0, -3);
  }
  const hkMatch = code.match(/^0(\d{4})\.HK$/);
  if (hkMatch) {
    return `${hkMatch[1]}.HK`;
  }
  return code;
}

export async function fetchNasdaqUSOptionChain(
  db: D1Database,
  rawCode: string,
  httpOptions?: ExternalHttpOptions
): Promise<USOptionChain> {
  const code = normalizeSecurityCode(rawCode);
  const symbol = code.replace(/\.US$/, "");
  const empty = { code, symbol, currentPrice: 0, expirations: [] };
  if (!code.endsWith(".US") || !symbol) {
    return empty;
  }
  const summary = await fetchUSOptionChainSummary(db, code, httpOptions);
  const expirations: USOptionExpiration[] = [];
  for (const expiration of summary.expirations) {
    expirations.push(await fetchUSOptionExpiration(db, code, expiration.date, httpOptions));
  }
  return {
    code,
    symbol: summary.symbol,
    currentPrice: summary.currentPrice,
    expirations,
  };
}

export async function fetchUSOptionChainSummary(
  db: D1Database,
  rawCode: string,
  httpOptions?: ExternalHttpOptions
): Promise<USOptionChainSummary> {
  const code = normalizeSecurityCode(rawCode);
  const symbol = code.replace(/\.US$/, "");
  const empty: USOptionChainSummary = { code, symbol, currentPrice: 0, updatedAt: Date.now(), expirations: [], strikes: [] };
  if (!code.endsWith(".US") || !symbol) {
    return empty;
  }
  const prefix = `us.options.chain.v2.${code}`;
  const cached = await getCachedUSOptionChainSummary(db, prefix);
  if (cached) {
    return cached;
  }

  let lastError: unknown = null;
  for (const assetClass of ["stocks", "etf"]) {
    try {
      const firstPage = await fetchNasdaqUSOptionChainRange(db, code, symbol, assetClass, "", "", httpOptions);
      const ranges = nasdaqOptionDateRanges(firstPage);
      const updatedAt = Date.now();
      const expirationMap = new Map<string, USOptionExpiration>();
      const strikeSet = new Set<number>();
      const currentPrice = parseNasdaqNumber(firstPage.data?.lastTrade);
      const pages = ranges.length > 0 ? ranges : [{ fromDate: "", toDate: "" }];
      for (const range of pages) {
        const page = range.fromDate && range.toDate
          ? await fetchNasdaqUSOptionChainRange(db, code, symbol, assetClass, range.fromDate, range.toDate, httpOptions)
          : firstPage
        const chain = normalizeNasdaqUSOptionChain(code, symbol, page)
        for (const expiration of chain.expirations) {
          expirationMap.set(expiration.date, expiration)
          await putCachedUSOptionExpiration(db, prefix, expiration.date, expiration, updatedAt)
          for (const contract of expiration.calls) strikeSet.add(contract.strike)
          for (const contract of expiration.puts) strikeSet.add(contract.strike)
        }
      }
      const expirations = Array.from(expirationMap.values())
        .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
        .map((expiration) => ({
          date: expiration.date,
          strikeCount: new Set(expiration.calls.concat(expiration.puts).map((item) => item.strike)).size,
        }))
      const summary: USOptionChainSummary = {
        code,
        symbol,
        currentPrice,
        updatedAt,
        expirations,
        strikes: Array.from(strikeSet).sort((a, b) => a - b),
      }
      await putCachedUSOptionChainSummary(db, prefix, summary)
      return summary
    } catch (err) {
      lastError = err
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`nasdaq option summary empty for ${code}`)
}

export async function fetchUSOptionExpiration(
  db: D1Database,
  rawCode: string,
  expirationDate: string,
  httpOptions?: ExternalHttpOptions
): Promise<USOptionExpiration> {
  const code = normalizeSecurityCode(rawCode);
  const symbol = code.replace(/\.US$/, "");
  const prefix = `us.options.chain.v2.${code}`;
  const cached = await getCachedUSOptionExpiration(db, prefix, expirationDate);
  if (cached) {
    return cached;
  }
  const summary = await fetchUSOptionChainSummary(db, code, httpOptions);
  const refetched = await getCachedUSOptionExpiration(db, prefix, expirationDate);
  if (refetched) {
    return refetched;
  }
  throw new Error(`option expiration not found for ${code}: ${expirationDate} (${summary.expirations.length} expirations cached)`);
}

async function fetchNasdaqUSOptionChainForAsset(
  db: D1Database,
  code: string,
  symbol: string,
  assetClass: string,
  httpOptions?: ExternalHttpOptions
): Promise<USOptionChain> {
  const firstPage = await fetchNasdaqUSOptionChainRange(db, code, symbol, assetClass, "", "", httpOptions);
  const firstChain = normalizeNasdaqUSOptionChain(code, symbol, firstPage);
  const [fromDate, toDate] = nasdaqOptionDateBounds(firstPage);
  if (!fromDate || !toDate) {
    return firstChain;
  }
  try {
    const fullRange = await fetchNasdaqUSOptionChainRange(db, code, symbol, assetClass, fromDate, toDate, httpOptions);
    if (fullRange.data && firstPage.data) {
      fullRange.data.filterlist = firstPage.data.filterlist;
    }
    const fullChain = normalizeNasdaqUSOptionChain(code, symbol, fullRange);
    return fullChain.expirations.length === 0 && firstChain.expirations.length > 0 ? firstChain : fullChain;
  } catch {
    return firstChain;
  }
}

async function fetchNasdaqUSOptionChainRange(
  db: D1Database,
  code: string,
  symbol: string,
  assetClass: string,
  fromDate: string,
  toDate: string,
  httpOptions?: ExternalHttpOptions
): Promise<NasdaqOptionChainResponse> {
  const limit = 10_000;
  let merged: NasdaqOptionChainData | null = null;
  for (let offset = 0; ; offset += limit) {
    const page = await fetchNasdaqUSOptionChainPage(
      db,
      code,
      symbol,
      assetClass,
      fromDate,
      toDate,
      limit,
      offset,
      httpOptions
    );
    const data = page.data;
    if (!data) {
      throw new Error(`nasdaq option chain empty for ${code}`);
    }
    const rows = data.table?.rows ?? [];
    if (!merged) {
      merged = {
        totalRecord: data.totalRecord ?? rows.length,
        lastTrade: data.lastTrade ?? "",
        filterlist: data.filterlist,
        table: { rows: [] },
      };
    }
    merged.table ??= { rows: [] };
    merged.table.rows ??= [];
    merged.table.rows.push(...rows);
    const totalRecord = data.totalRecord ?? merged.table.rows.length;
    if (rows.length === 0 || merged.table.rows.length >= totalRecord || rows.length < limit) {
      break;
    }
  }
  return { data: merged };
}

async function fetchNasdaqUSOptionChainPage(
  db: D1Database,
  code: string,
  symbol: string,
  assetClass: string,
  fromDate: string,
  toDate: string,
  limit: number,
  offset: number,
  httpOptions?: ExternalHttpOptions
): Promise<NasdaqOptionChainResponse> {
  const url = new URL(`https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/option-chain`);
  url.searchParams.set("assetclass", assetClass);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("money", "all");
  if (fromDate && toDate) {
    url.searchParams.set("fromdate", fromDate);
    url.searchParams.set("todate", toDate);
  }
  const parsed = (await cachedFetchJson(db, url.toString(), {
    headers: nasdaqOptionHeaders(assetClass, symbol),
  }, marketDataCacheTtlMsForCode(code), {
    ...httpOptions,
    cacheKey: `nasdaq:options:${assetClass}:${symbol}:${fromDate}:${toDate}:${limit}:${offset}`,
    cacheTtlMs: marketDataCacheTtlMsForCode(code),
  })) as NasdaqOptionChainResponse;
  if (!parsed.data) {
    throw new Error(`nasdaq option chain empty for ${code} assetClass=${assetClass}`);
  }
  return parsed;
}

function nasdaqOptionHeaders(assetClass: string, symbol: string): Record<string, string> {
  return {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    Origin: "https://www.nasdaq.com",
    Referer: `https://www.nasdaq.com/market-activity/${assetClass}/${symbol.toLowerCase()}/option-chain`,
    "Sec-CH-UA": "\"Google Chrome\";v=\"144\", \"Chromium\";v=\"144\", \"Not:A-Brand\";v=\"24\"",
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": "\"macOS\"",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
  };
}

function nasdaqOptionDateBounds(parsed: NasdaqOptionChainResponse): [string, string] {
  let fromDate = "";
  let toDate = "";
  for (const item of parsed.data?.filterlist?.fromdate?.filter ?? []) {
    const value = String(item.value ?? "").trim();
    if (!value || value.toLowerCase() === "all") {
      continue;
    }
    const [start, end] = value.split("|").map((part) => part.trim());
    if (!start || !end) {
      continue;
    }
    if (!fromDate || start < fromDate) {
      fromDate = start;
    }
    if (!toDate || end > toDate) {
      toDate = end;
    }
  }
  return [fromDate, toDate];
}

function nasdaqOptionDateRanges(parsed: NasdaqOptionChainResponse): Array<{ fromDate: string; toDate: string }> {
  const ranges: Array<{ fromDate: string; toDate: string }> = [];
  const seen = new Set<string>();
  for (const item of parsed.data?.filterlist?.fromdate?.filter ?? []) {
    const value = String(item.value ?? "").trim();
    if (!value || value.toLowerCase() === "all") {
      continue;
    }
    const [fromDate, toDate] = value.split("|").map((part) => part.trim());
    if (!fromDate || !toDate) {
      continue;
    }
    const key = `${fromDate}|${toDate}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    ranges.push({ fromDate, toDate });
  }
  return ranges;
}

function normalizeNasdaqUSOptionChain(
  code: string,
  symbol: string,
  parsed: NasdaqOptionChainResponse
): USOptionChain {
  const data = parsed.data;
  if (!data) {
    throw new Error(`nasdaq option chain empty for ${code}`);
  }
  const expirations = new Map<string, USOptionExpiration>();
  let currentExpiration = "";
  for (const row of data.table?.rows ?? []) {
    const expiryGroup = String(row.expirygroup ?? "").trim();
    if (expiryGroup) {
      currentExpiration = expiryGroup;
      getOptionExpiration(expirations, currentExpiration);
      continue;
    }
    const strike = parseNasdaqNumber(row.strike);
    if (!currentExpiration || strike <= 0) {
      continue;
    }
    const call = buildNasdaqUSOptionContract(symbol, currentExpiration, "call", strike, [
      row.c_Last,
      row.c_Bid,
      row.c_Ask,
    ], [
      row.c_Volume,
      row.c_Openinterest,
    ], row.drillDownURL);
    const put = buildNasdaqUSOptionContract(symbol, currentExpiration, "put", strike, [
      row.p_Last,
      row.p_Bid,
      row.p_Ask,
    ], [
      row.p_Volume,
      row.p_Openinterest,
    ], row.drillDownURL);
    const expiration = getOptionExpiration(expirations, currentExpiration);
    if (call.price > 0 || call.last > 0 || call.bid > 0 || call.ask > 0) {
      expiration.calls.push(call);
    }
    if (put.price > 0 || put.last > 0 || put.bid > 0 || put.ask > 0) {
      expiration.puts.push(put);
    }
  }
  return {
    code,
    symbol,
    currentPrice: parseNasdaqNumber(data.lastTrade),
    expirations: [...expirations.values()],
  };
}

async function fetchYahooUSOptionMetadata(
  db: D1Database,
  symbol: string,
  httpOptions?: ExternalHttpOptions
): Promise<{ symbol: string; currentPrice: number; expirationDates: number[] }> {
  const parsed = await fetchYahooUSOptionPage(db, symbol, null, httpOptions);
  const result = parsed.optionChain?.result?.[0];
  if (!result) {
    throw new Error(`yahoo option metadata empty for ${symbol}`);
  }
  return {
    symbol: String(result.underlyingSymbol || symbol).toUpperCase(),
    currentPrice: Number(result.quote?.regularMarketPrice ?? 0) || 0,
    expirationDates: Array.isArray(result.expirationDates) ? result.expirationDates.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0) : [],
  };
}

async function fetchYahooUSOptionExpirationAndCache(
  db: D1Database,
  prefix: string,
  code: string,
  symbol: string,
  timestamp: number,
  updatedAt: number,
  httpOptions?: ExternalHttpOptions
): Promise<USOptionExpiration> {
  const parsed = await fetchYahooUSOptionPage(db, symbol, timestamp, httpOptions);
  const result = parsed.optionChain?.result?.[0];
  const option = result?.options?.[0];
  if (!option) {
    throw new Error(`yahoo option expiration empty for ${code} timestamp=${timestamp}`);
  }
  const expiration = normalizeYahooUSOptionExpiration(symbol, option, timestamp);
  await putCachedUSOptionExpiration(db, prefix, expiration.date, expiration, updatedAt);
  return expiration;
}

async function fetchYahooUSOptionPage(
  db: D1Database,
  symbol: string,
  timestamp: number | null,
  httpOptions?: ExternalHttpOptions
): Promise<YahooOptionResponse> {
  const url = new URL(`https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol)}`);
  if (timestamp) {
    url.searchParams.set("date", String(timestamp));
  }
  const parsed = (await cachedFetchJson(db, url.toString(), {
    headers: yahooHeaders(`https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/options/`),
  }, marketDataCacheTtlMsForCode(`${symbol}.US`), {
    ...httpOptions,
    cacheKey: `yahoo:options:v2:${symbol}:${timestamp || "base"}`,
    cacheTtlMs: marketDataCacheTtlMsForCode(`${symbol}.US`),
  })) as YahooOptionResponse;
  const error = parsed.optionChain?.error;
  if (error?.description || error?.code) {
    throw new Error(`yahoo option error for ${symbol}: ${error.code || ""} ${error.description || ""}`.trim());
  }
  if (!parsed.optionChain?.result?.[0]) {
    throw new Error(`yahoo option result empty for ${symbol}`);
  }
  return parsed;
}

function normalizeYahooUSOptionExpiration(
  symbol: string,
  option: { expirationDate?: number; calls?: YahooOptionContract[]; puts?: YahooOptionContract[] },
  fallbackTimestamp: number
): USOptionExpiration {
  const expirationTimestamp = Number(option.expirationDate ?? fallbackTimestamp) || fallbackTimestamp;
  const date = formatYahooExpirationDate(expirationTimestamp);
  return {
    date,
    calls: normalizeYahooUSOptionContracts(symbol, date, "call", option.calls),
    puts: normalizeYahooUSOptionContracts(symbol, date, "put", option.puts),
  };
}

function normalizeYahooUSOptionContracts(
  symbol: string,
  expiration: string,
  type: "call" | "put",
  contracts: YahooOptionContract[] | undefined
): USOptionContract[] {
  const result: USOptionContract[] = [];
  for (const contract of contracts ?? []) {
    const strike = Number(contract.strike ?? 0);
    if (!Number.isFinite(strike) || strike <= 0) {
      continue;
    }
    const bid = Number(contract.bid ?? 0) || 0;
    const ask = Number(contract.ask ?? 0) || 0;
    const last = Number(contract.lastPrice ?? 0) || 0;
    result.push({
      symbol: String(contract.contractSymbol || `${symbol}-${type}-${expiration}-${strike}`),
      type,
      expiration,
      strike,
      last,
      bid,
      ask,
      price: bid > 0 && ask > 0 ? (bid + ask) / 2 : bid || ask || last,
      volume: Math.trunc(Number(contract.volume ?? 0) || 0),
      openInterest: Math.trunc(Number(contract.openInterest ?? 0) || 0),
    });
  }
  return result.sort((a, b) => a.strike - b.strike);
}

function formatYahooExpirationDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function buildNasdaqUSOptionContract(
  symbol: string,
  expiration: string,
  type: "call" | "put",
  strike: number,
  prices: Array<string | null | undefined>,
  counts: Array<string | null | undefined>,
  drillDownURL: string | null | undefined
): USOptionContract {
  const last = parseNasdaqNumber(prices[0]);
  const bid = parseNasdaqNumber(prices[1]);
  const ask = parseNasdaqNumber(prices[2]);
  return {
    symbol: nasdaqOptionSymbolFromDrillDown(symbol, type, drillDownURL),
    type,
    expiration,
    strike,
    last,
    bid,
    ask,
    price: bid > 0 && ask > 0 ? (bid + ask) / 2 : bid || ask || last,
    volume: Math.trunc(parseNasdaqNumber(counts[0])),
    openInterest: Math.trunc(parseNasdaqNumber(counts[1])),
  };
}

function nasdaqOptionSymbolFromDrillDown(
  symbol: string,
  type: "call" | "put",
  drillDownURL: string | null | undefined
): string {
  const value = String(drillDownURL ?? "").trim().split("/").filter(Boolean).at(-1);
  if (value) {
    if (type === "put") {
      const idx = value.lastIndexOf("c");
      if (idx >= 0) {
        return `${value.slice(0, idx)}p${value.slice(idx + 1)}`;
      }
    }
    return value;
  }
  return `${symbol.toLowerCase()}-${type}`;
}

function parseNasdaqNumber(value: unknown): number {
  const normalized = String(value ?? "").trim().replaceAll(",", "");
  if (!normalized || normalized === "--") {
    return 0;
  }
  const match = normalized.match(/-?\d+(?:\.\d+)?/);
  if (!match) {
    return 0;
  }
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getOptionExpiration(expirations: Map<string, USOptionExpiration>, date: string): USOptionExpiration {
  let item = expirations.get(date);
  if (!item) {
    item = { date, calls: [], puts: [] };
    expirations.set(date, item);
  }
  return item;
}

async function getCachedUSOptionChain(db: D1Database, prefix: string): Promise<USOptionChain | null> {
  const row = await getAppKv(db, prefix);
  if (row) {
    return JSON.parse(row.valueJson) as USOptionChain;
  }
  const metaRow = await getAppKv(db, `${prefix}.meta`);
  if (!metaRow) {
    return null;
  }
  const meta = JSON.parse(metaRow.valueJson) as USOptionChainMeta;
  const expirations: USOptionExpiration[] = [];
  for (const date of meta.expirationDates ?? []) {
    const expirationRow = await getAppKv(db, `${prefix}.expiration.${date}`);
    if (expirationRow) {
      expirations.push(JSON.parse(expirationRow.valueJson) as USOptionExpiration);
      continue;
    }
    const expirationMetaRow = await getAppKv(db, `${prefix}.expiration.${date}.meta`);
    if (!expirationMetaRow) {
      return null;
    }
    const expirationMeta = JSON.parse(expirationMetaRow.valueJson) as USOptionExpirationMeta;
    const calls: USOptionContract[] = [];
    const puts: USOptionContract[] = [];
    for (let i = 0; i < expirationMeta.callChunks; i++) {
      const chunkRow = await getAppKv(db, `${prefix}.expiration.${date}.calls.${i}`);
      if (!chunkRow) return null;
      calls.push(...JSON.parse(chunkRow.valueJson) as USOptionContract[]);
    }
    for (let i = 0; i < expirationMeta.putChunks; i++) {
      const chunkRow = await getAppKv(db, `${prefix}.expiration.${date}.puts.${i}`);
      if (!chunkRow) return null;
      puts.push(...JSON.parse(chunkRow.valueJson) as USOptionContract[]);
    }
    expirations.push({ date, calls, puts });
  }
  return {
    code: meta.code,
    symbol: meta.symbol,
    currentPrice: meta.currentPrice,
    expirations,
  };
}

async function getCachedUSOptionChainSummary(db: D1Database, prefix: string): Promise<USOptionChainSummary | null> {
  const row = await getAppKv(db, `${prefix}.summary`);
  if (!row) {
    return null;
  }
  return JSON.parse(row.valueJson) as USOptionChainSummary;
}

async function putCachedUSOptionChainSummary(db: D1Database, prefix: string, summary: USOptionChainSummary): Promise<void> {
  const expiresAt = marketDataCacheExpiresAtMsForCode(summary.code, summary.updatedAt);
  const meta: USOptionChainSummaryMeta = {
    code: summary.code,
    symbol: summary.symbol,
    currentPrice: summary.currentPrice,
    updatedAt: summary.updatedAt,
    expirations: summary.expirations,
    strikes: summary.strikes,
  };
  await putAppKv(db, {
    key: `${prefix}.summary`,
    valueJson: JSON.stringify(meta),
    expiresAt,
    updatedAt: summary.updatedAt,
  });
}

async function getCachedUSOptionExpiration(db: D1Database, prefix: string, date: string): Promise<USOptionExpiration | null> {
  const row = await getAppKv(db, `${prefix}.expiration.${date}`);
  if (!row) {
    return null;
  }
  return JSON.parse(row.valueJson) as USOptionExpiration;
}

async function putCachedUSOptionExpiration(
  db: D1Database,
  prefix: string,
  date: string,
  expiration: USOptionExpiration,
  updatedAt: number
): Promise<void> {
  const code = optionChainCodeFromPrefix(prefix);
  await putAppKv(db, {
    key: `${prefix}.expiration.${date}`,
    valueJson: JSON.stringify(expiration),
    expiresAt: marketDataCacheExpiresAtMsForCode(code, updatedAt),
    updatedAt,
  });
}

async function putCachedUSOptionChain(db: D1Database, prefix: string, chain: USOptionChain): Promise<void> {
  const now = Date.now();
  const expiresAt = marketDataCacheExpiresAtMsForCode(chain.code, now);
  const meta: USOptionChainMeta = {
    code: chain.code,
    symbol: chain.symbol,
    currentPrice: chain.currentPrice,
    expirationDates: chain.expirations.map((item) => item.date),
  };
  await putAppKv(db, {
    key: `${prefix}.meta`,
    valueJson: JSON.stringify(meta),
    expiresAt,
    updatedAt: now,
  });
  for (const expiration of chain.expirations) {
    const callChunks = chunkArray(expiration.calls, 50);
    const putChunks = chunkArray(expiration.puts, 50);
    const expirationMeta: USOptionExpirationMeta = {
      date: expiration.date,
      callChunks: callChunks.length,
      putChunks: putChunks.length,
    };
    await putAppKv(db, {
      key: `${prefix}.expiration.${expiration.date}.meta`,
      valueJson: JSON.stringify(expirationMeta),
      expiresAt,
      updatedAt: now,
    });
    for (const [i, chunk] of callChunks.entries()) {
      await putAppKv(db, {
        key: `${prefix}.expiration.${expiration.date}.calls.${i}`,
        valueJson: JSON.stringify(chunk),
        expiresAt,
        updatedAt: now,
      });
    }
    for (const [i, chunk] of putChunks.entries()) {
      await putAppKv(db, {
        key: `${prefix}.expiration.${expiration.date}.puts.${i}`,
        valueJson: JSON.stringify(chunk),
        expiresAt,
        updatedAt: now,
      });
    }
  }
}

function optionChainCodeFromPrefix(prefix: string): string {
  return prefix.replace(/^us\.options\.chain\.v2\./, "");
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function yahooHeaders(referer: string): Record<string, string> {
  return {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    Origin: "https://finance.yahoo.com",
    Referer: referer,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
  };
}

function yahooFinanceHeaders(symbol: string): Record<string, string> {
  return {
    Accept: "application/json, text/plain, */*",
    Referer: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/financials/`,
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
  };
}

function normalizeYahooSuggestCode(item: NonNullable<YahooSuggestResponse["quotes"]>[number]): string | null {
  const symbol = item.symbol?.trim().toUpperCase() ?? "";
  if (!symbol) {
    return null;
  }
  if (symbol.endsWith(".KS") || symbol.endsWith(".KQ")) {
    return symbol;
  }
  if (symbol.includes(".")) {
    return null;
  }
  if (item.quoteType === "EQUITY" || item.quoteType === "ETF") {
    return `${symbol}.US`;
  }
  return null;
}

function containsHan(value: string): boolean {
  return [...value].some((ch) => (ch >= "\u4e00" && ch <= "\u9fff") || (ch >= "\u3400" && ch <= "\u4dbf"));
}

export async function fetchEastmoneyCompanyOverview(db: D1Database, code: string): Promise<CompanyOverview> {
  const normalized = normalizeSecurityCode(code);
  const secid = eastmoneySecId(normalized);
  if (!secid) {
    throw new Error(`unsupported company code: ${code}`);
  }
  const url = new URL("https://push2delay.eastmoney.com/api/qt/stock/get");
  url.searchParams.set("ut", "fa5fd1943c7b386f172d6893dbfba10b");
  url.searchParams.set("invt", "2");
  url.searchParams.set("fltt", "1");
  url.searchParams.set("secid", secid);
  url.searchParams.set("fields", "f43,f57,f58,f116,f162,f167,f168,f169,f170");
  const body = (await cachedFetchJson(db, url.toString(), {
    headers: { Referer: "https://quote.eastmoney.com/" },
  }, marketDataCacheTtlMsForCode(normalized))) as EastmoneyOverviewResponse;
  const data = body.data ?? {};
  const latestPriceRaw = numberOrNull(data.f43);
  const changeAmountRaw = numberOrNull(data.f169);
  const pctChangeRaw = numberOrNull(data.f170);
  return {
    code: normalized,
    name: String(data.f58 ?? "").trim() || normalized,
    market: securityMarket(normalized),
    type: inferSecurityType(normalized),
    latestPrice: latestPriceRaw !== null ? latestPriceRaw / 1000 : null,
    pctChange: pctChangeRaw !== null ? pctChangeRaw / 100 : null,
    changeAmount: changeAmountRaw !== null ? changeAmountRaw / 1000 : null,
    turnover: numberOrNull(data.f168) !== null ? numberOrNull(data.f168)! / 100 : null,
    marketCapYi: numberOrNull(data.f116) !== null ? numberOrNull(data.f116)! / 1_000_000_000 : null,
    peTtm: numberOrNull(data.f162) !== null ? numberOrNull(data.f162)! / 100 : null,
    pb: numberOrNull(data.f167) !== null ? numberOrNull(data.f167)! / 1000 : null,
    source: "eastmoney",
    updatedAt: Date.now(),
  };
}

export async function fetchEastmoneyCompanyNotices(
  db: D1Database,
  code: string,
  page = 1,
  pageSize = 20
): Promise<CompanyNotice[]> {
  const normalized = normalizeSecurityCode(code);
  const suffix = securitySuffix(normalized);
  const annType = suffix === "HK" ? "H" : suffix === "US" ? "U,U_Pink" : "A";
  const url = new URL("https://np-anotice-stock.eastmoney.com/api/security/ann");
  url.searchParams.set("cb", `jQuery${Date.now()}`);
  url.searchParams.set("sr", "-1");
  url.searchParams.set("page_size", String(pageSize));
  url.searchParams.set("page_index", String(page));
  url.searchParams.set("ann_type", annType);
  url.searchParams.set("client_source", "web");
  url.searchParams.set("stock_list", bareCode(normalized));
  url.searchParams.set("f_node", "");
  url.searchParams.set("s_node", "");
  const body = (await cachedFetchJson(db, url.toString(), {
    headers: { Referer: "https://data.eastmoney.com/" },
  }, 6 * 60 * 60 * 1000)) as EastmoneyNoticeResponse;
  return (body.data?.list ?? []).map((item) => ({
    artCode: item.art_code?.trim() ?? "",
    title: item.title?.trim() ?? "",
    noticeDate: String(item.notice_date ?? "").slice(0, 10),
    noticeType: item.columns?.[0]?.column_name?.trim() ?? "",
    pdfUrl: `https://pdf.dfcfw.com/pdf/H3_${encodeURIComponent(item.art_code?.trim() ?? "")}_1.pdf`,
  })).filter((item) => item.artCode && item.title);
}

function eastmoneyKlt(period: string): string {
  switch (period) {
    case "week":
      return "102";
    case "month":
      return "103";
    default:
      return "101";
  }
}

function eastmoneyFqt(fq: string): string {
  switch (fq) {
    case "qfq":
      return "1";
    case "hfq":
      return "2";
    default:
      return "0";
  }
}

function financeReportType(statementType: StatementType, code: string): string {
  const isBank = bankCodeSet.has(normalizeSecurityCode(code));
  switch (statementType) {
    case "income":
      return isBank ? "BINCOMEQC" : "GINCOMEQC";
    case "balance":
      return isBank ? "BBALANCE" : "GBALANCE";
    case "cashflow":
      return isBank ? "BCASHFLOWQC" : "GCASHFLOWQC";
  }
}

function financeStyle(statementType: StatementType, reportType: string): string {
  if (statementType === "balance") {
    return `F10_FINANCE_${reportType}`;
  }
  return `APP_F10_${reportType}`;
}

function yahooFinanceTypes(): string[] {
  return [
    "quarterlyTotalRevenue",
    "quarterlyCostOfRevenue",
    "quarterlyGrossProfit",
    "quarterlyOperatingIncome",
    "quarterlyNetIncome",
    "quarterlyBasicEPS",
    "quarterlyDilutedEPS",
    "quarterlyTotalAssets",
    "quarterlyTotalLiabilitiesNetMinorityInterest",
    "quarterlyStockholdersEquity",
    "quarterlyOperatingCashFlow",
    "quarterlyFreeCashFlow",
    "quarterlyEndCashPosition",
  ];
}

function yahooStablePeriod2(): number {
  const now = new Date();
  return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 2) / 1000);
}

function yahooFinancePayloadKey(type: string): string | null {
  const map: Record<string, string> = {
    quarterlyTotalRevenue: "totalOperateIncome",
    quarterlyCostOfRevenue: "operateCost",
    quarterlyGrossProfit: "grossProfit",
    quarterlyOperatingIncome: "operateProfit",
    quarterlyNetIncome: "netProfit",
    quarterlyBasicEPS: "basicEps",
    quarterlyDilutedEPS: "dilutedEps",
    quarterlyTotalAssets: "totaAssets",
    quarterlyTotalLiabilitiesNetMinorityInterest: "totalLiabilities",
    quarterlyStockholdersEquity: "totalEquity",
    quarterlyOperatingCashFlow: "netcashOperate",
    quarterlyFreeCashFlow: "freeCashFlow",
    quarterlyEndCashPosition: "endCce",
  };
  return map[type] ?? null;
}

function normalizeYahooFinancePayload(
  payload: Record<string, unknown>,
  statementType: StatementType
): Record<string, unknown> {
  const row = { ...payload };
  if (statementType === "income") {
    row.operateIncome = row.totalOperateIncome;
    row.totalOperateCost = row.operateCost;
    row.parentNetprofit = row.netProfit;
  }
  if (statementType === "balance") {
    row.totalAssets = row.totaAssets;
  }
  return row;
}

function genReportDates(years: number): string[] {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const dates: string[] = [];
  for (let i = 0; i < years; i += 1) {
    const current = year - i;
    if (i > 0) {
      dates.push(`${current}-12-31`);
    }
    if (i !== 0 || month > 9) {
      dates.push(`${current}-09-30`);
    }
    if (i !== 0 || month > 6) {
      dates.push(`${current}-06-30`);
    }
    if (i !== 0 || month > 3) {
      dates.push(`${current}-03-31`);
    }
  }
  return dates;
}

function trimDate(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.slice(0, 10);
}
