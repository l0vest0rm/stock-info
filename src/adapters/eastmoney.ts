import financeMappings from "../../shared/finance-mappings.json";
import { bareCode, eastmoneySecId, inferSecurityType, normalizeSecurityCode, securityMarket, securitySuffix } from "../shared/codes";
import { getAppKv, putAppKv } from "../db/queries";
import { cachedFetchJson, cachedFetchText, numberOrNull } from "../shared/http";
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
  };
};

type FinanceMappings = {
  bankCodes?: string[];
};

const bankCodeSet = new Set(((financeMappings as FinanceMappings).bankCodes ?? []).map((code) => normalizeSecurityCode(code)));

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

type YahooChartResponse = {
  chart?: {
    error?: { code?: string; description?: string } | null;
    result?: Array<{
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: Array<number | null>;
          close?: Array<number | null>;
          high?: Array<number | null>;
          low?: Array<number | null>;
          volume?: Array<number | null>;
        }>;
        adjclose?: Array<{
          adjclose?: Array<number | null>;
        }>;
      };
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

type USOptionChainMeta = {
  code: string;
  symbol: string;
  currentPrice: number;
  expirationDates: string[];
};

type USOptionExpirationMeta = {
  date: string;
  callChunks: number;
  putChunks: number;
};

type TencentKlineResponse = {
  code?: number;
  msg?: string;
  data?: Record<
    string,
    {
      day?: string[][];
      qfqday?: string[][];
      hfqday?: string[][];
      qt?: Record<string, string[]>;
    }
  >;
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
    if (!normalized || !name) {
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
  to: string
): Promise<{ security?: SecurityRecord; rows: KlineBar[] }> {
  const normalized = normalizeSecurityCode(code);
  const secid = eastmoneySecId(normalized);
  if (!secid) {
    throw new Error(`unsupported Eastmoney stock code: ${code}`);
  }
  const url = new URL("https://push2his.eastmoney.com/api/qt/stock/kline/get");
  url.searchParams.set("secid", secid);
  url.searchParams.set("fields1", "f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13");
  url.searchParams.set("fields2", "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61");
  url.searchParams.set("klt", eastmoneyKlt(period));
  url.searchParams.set("fqt", eastmoneyFqt(fq));
  url.searchParams.set("beg", from.replaceAll("-", ""));
  url.searchParams.set("end", to.replaceAll("-", ""));
  url.searchParams.set("ut", "fa5fd1943c7b386f172d6893dbfba10b");
  url.searchParams.set("rtntype", "6");
  const body = (await cachedFetchJson(db, url.toString(), {
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
  }, 6 * 60 * 60 * 1000)) as EastmoneyStockKlineResponse;
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
  const url = new URL("https://api.fund.eastmoney.com/f10/lsjz");
  url.searchParams.set("callback", "jQuery");
  url.searchParams.set("fundCode", bareCode(normalized));
  url.searchParams.set("pageIndex", "1");
  url.searchParams.set("pageSize", String(pageSize));
  url.searchParams.set("startDate", from);
  url.searchParams.set("endDate", to);
  url.searchParams.set("_", String(Date.now()));
  const body = (await cachedFetchJson(db, url.toString(), {
    headers: { Referer: "https://fundf10.eastmoney.com/" },
  }, 6 * 60 * 60 * 1000)) as EastmoneyFundNavResponse;
  if (body.ErrCode && body.ErrCode !== 0) {
    throw new Error(`eastmoney fund nav error: code=${body.ErrCode} msg=${body.ErrMsg ?? ""}`);
  }
  const now = Date.now();
  return (body.Data?.LSJZList ?? [])
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
    .filter((row) => row.date)
    .sort((a, b) => a.date.localeCompare(b.date));
}

export async function fetchEastmoneyFinance(
  db: D1Database,
  code: string,
  statementType: StatementType
): Promise<FinancialStatement[]> {
  const normalized = normalizeSecurityCode(code);
  if (!/\.(SH|SZ|BJ)$/.test(normalized)) {
    throw new Error(`finance statement only supports CN A-share codes in the MVP: ${code}`);
  }
  const reportType = financeReportType(statementType, normalized);
  const url = new URL("https://datacenter.eastmoney.com/securities/api/data/get");
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
  }, 24 * 60 * 60 * 1000)) as EastmoneyFinanceResponse;
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
  }, 24 * 60 * 60 * 1000, httpOptions)) as YahooTimeseriesResponse;
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
  params: Record<string, string>
): Promise<Record<string, unknown>[]> {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const body = (await cachedFetchJson(db, url.toString(), {
    headers: { Referer: "https://emweb.securities.eastmoney.com/" },
  }, 24 * 60 * 60 * 1000)) as EastmoneyFinanceResponse;
  return body.result?.data ?? [];
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

export async function fetchYahooStockKline(db: D1Database, code: string, fq: string): Promise<KlineBar[]> {
  return fetchYahooStockKlineWithProxy(db, code, fq);
}

export async function fetchYahooStockKlineWithProxy(
  db: D1Database,
  code: string,
  fq: string,
  httpOptions?: ExternalHttpOptions
): Promise<KlineBar[]> {
  const normalized = normalizeSecurityCode(code);
  const symbol = yahooChartSymbol(normalized);
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  url.searchParams.set("period1", "0");
  url.searchParams.set("period2", String(Math.floor(Date.now() / 1000) + 86400));
  url.searchParams.set("interval", "1d");
  url.searchParams.set("events", "history");
  url.searchParams.set("includeAdjustedClose", "true");
  const body = (await cachedFetchJson(db, url.toString(), {
    headers: {
      Origin: "https://finance.yahoo.com",
      Referer: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/`,
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-site",
    },
  }, 6 * 60 * 60 * 1000, httpOptions)) as YahooChartResponse;
  const error = body.chart?.error;
  if (error) {
    throw new Error(`yahoo chart error: code=${error.code ?? ""} description=${error.description ?? ""}`);
  }
  const result = body.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  if (!result?.timestamp?.length || !quote) {
    return [];
  }
  const adjClose = result.indicators?.adjclose?.[0]?.adjclose ?? [];
  const now = Date.now();
  const rows: KlineBar[] = [];
  for (let idx = 0; idx < result.timestamp.length; idx += 1) {
    const ts = result.timestamp[idx];
    const close = at(quote.close, idx);
    const low = at(quote.low, idx);
    const high = at(quote.high, idx);
    if (!ts || close === null || low === null || high === null) {
      continue;
    }
    const displayClose = fq === "qfq" ? at(adjClose, idx) ?? close : close;
    rows.push({
      code: normalized,
      period: "day",
      fq,
      date: new Date(ts * 1000).toISOString().slice(0, 10),
      open: at(quote.open, idx),
      close: displayClose,
      high,
      low,
      volume: at(quote.volume, idx),
      amount: null,
      amplitude: null,
      pctChange: null,
      changeAmount: null,
      turnover: null,
      source: "yahoo",
      updatedAt: now,
    });
  }
  return rows;
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

  const cached = await getCachedUSOptionChain(db, `nasdaq.options.chain.${code}`);
  if (cached) {
    return cached;
  }

  let lastError: unknown = null;
  for (const assetClass of ["stocks", "etf"]) {
    try {
      const chain = await fetchNasdaqUSOptionChainForAsset(db, code, symbol, assetClass, httpOptions);
      if (chain.expirations.length > 0) {
        await putCachedUSOptionChain(db, `nasdaq.options.chain.${code}`, chain);
        return chain;
      }
      return chain;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`nasdaq option chain empty for ${code}`);
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
  }, 30 * 60 * 1000, {
    ...httpOptions,
    cacheKey: `nasdaq:options:${assetClass}:${symbol}:${fromDate}:${toDate}:${limit}:${offset}`,
    cacheTtlMs: 30 * 60 * 1000,
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

async function putCachedUSOptionChain(db: D1Database, prefix: string, chain: USOptionChain): Promise<void> {
  const now = Date.now();
  const expiresAt = now + 30 * 60 * 1000;
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

export async function fetchTencentStockKline(db: D1Database, code: string, period: string, fq: string): Promise<{ security?: SecurityRecord; rows: KlineBar[] }> {
  const normalized = normalizeSecurityCode(code);
  const symbol = tencentSymbol(normalized);
  if (!symbol || period !== "day") {
    throw new Error(`unsupported Tencent kline code or period: ${code} ${period}`);
  }
  const url = new URL("https://web.ifzq.gtimg.cn/appstock/app/fqkline/get");
  url.searchParams.set("param", `${symbol},day,,,2000,${tencentFq(fq)}`);
  const body = (await cachedFetchJson(db, url.toString(), {
    headers: { Referer: "https://gu.qq.com/" },
  }, 6 * 60 * 60 * 1000)) as TencentKlineResponse;
  if (body.code && body.code !== 0) {
    throw new Error(`tencent kline error: code=${body.code} msg=${body.msg ?? ""}`);
  }
  const data = body.data?.[symbol];
  const key = tencentKlineKey(fq);
  const rawRows = data?.[key] ?? data?.day ?? [];
  const now = Date.now();
  const quote = data?.qt?.[symbol];
  const security = quote?.[1]
    ? ({
        code: normalized,
        market: securityMarket(normalized),
        type: inferSecurityType(normalized),
        name: quote[1],
        source: "tencent",
        updatedAt: now,
      } satisfies SecurityRecord)
    : undefined;
  const rows = rawRows.map((row) => ({
    code: normalized,
    period,
    fq,
    date: row[0] ?? "",
    open: numberOrNull(row[1]),
    close: numberOrNull(row[2]),
    high: numberOrNull(row[3]),
    low: numberOrNull(row[4]),
    volume: numberOrNull(row[5]),
    amount: null,
    amplitude: null,
    pctChange: null,
    changeAmount: null,
    turnover: null,
    source: "tencent",
    updatedAt: now,
  } satisfies KlineBar)).filter((row) => row.date);
  return { security, rows };
}

function at(values: Array<number | null> | undefined, idx: number): number | null {
  const value = values?.[idx];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function tencentSymbol(code: string): string | null {
  const [base, suffix] = normalizeSecurityCode(code).split(".");
  if (!base || !suffix) return null;
  if (suffix === "SH") return `sh${base}`;
  if (suffix === "SZ") return `sz${base}`;
  if (suffix === "BJ") return `bj${base}`;
  return null;
}

function tencentFq(fq: string): string {
  if (fq === "qfq") return "qfq";
  if (fq === "hfq") return "hfq";
  return "";
}

function tencentKlineKey(fq: string): "day" | "qfqday" | "hfqday" {
  if (fq === "qfq") return "qfqday";
  if (fq === "hfq") return "hfqday";
  return "day";
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
  }, 10 * 60 * 1000)) as EastmoneyOverviewResponse;
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
