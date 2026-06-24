import { bareCode, eastmoneySecId, inferSecurityType, normalizeSecurityCode, securityMarket, securitySuffix } from "../shared/codes";
import { fetchJson, fetchText, numberOrNull } from "../shared/http";
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

export async function fetchEastmoneySuggest(q: string): Promise<SecurityRecord[]> {
  const url = new URL("https://searchadapter.eastmoney.com/api/suggest/get");
  url.searchParams.set("input", q);
  url.searchParams.set("type", "8");
  url.searchParams.set("token", EASTMONEY_SUGGEST_TOKEN);
  url.searchParams.set("count", "10");
  const body = (await fetchJson(url.toString(), {
    headers: { Referer: "https://www.eastmoney.com/" },
  })) as EastmoneySuggestResponse;
  const now = Date.now();
  const records: SecurityRecord[] = [];
  for (const item of body.GubaCodeTable?.Data ?? []) {
    const rawCode = item.OuterCode?.trim() ?? "";
    const normalized = normalizeSecurityCode(rawCode);
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

export async function fetchEastmoneyStockKline(
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
  const body = (await fetchJson(url.toString(), {
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
  })) as EastmoneyStockKlineResponse;
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
  const body = (await fetchJson(url.toString(), {
    headers: { Referer: "https://fundf10.eastmoney.com/" },
  })) as EastmoneyFundNavResponse;
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
  code: string,
  statementType: StatementType
): Promise<FinancialStatement[]> {
  const normalized = normalizeSecurityCode(code);
  if (!/\.(SH|SZ|BJ)$/.test(normalized)) {
    throw new Error(`finance statement only supports CN A-share codes in the MVP: ${code}`);
  }
  const reportType = financeReportType(statementType);
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
  const body = (await fetchJson(url.toString(), {
    headers: { Referer: "https://emweb.securities.eastmoney.com/" },
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

export async function fetchEastmoneyDataRows(
  endpoint: string,
  params: Record<string, string>
): Promise<Record<string, unknown>[]> {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const body = (await fetchJson(url.toString(), {
    headers: { Referer: "https://emweb.securities.eastmoney.com/" },
  })) as EastmoneyFinanceResponse;
  return body.result?.data ?? [];
}

export async function fetchEastmoneyText(
  url: string,
  referer = "https://fundf10.eastmoney.com/"
): Promise<string> {
  return fetchText(url, {
    headers: {
      Referer: referer,
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    },
  });
}

export async function fetchYahooStockKline(code: string, fq: string): Promise<KlineBar[]> {
  const normalized = normalizeSecurityCode(code);
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(normalized)}`);
  url.searchParams.set("period1", "0");
  url.searchParams.set("period2", String(Math.floor(Date.now() / 1000) + 86400));
  url.searchParams.set("interval", "1d");
  url.searchParams.set("events", "history");
  url.searchParams.set("includeAdjustedClose", "true");
  const body = (await fetchJson(url.toString(), {
    headers: {
      Origin: "https://finance.yahoo.com",
      Referer: `https://finance.yahoo.com/quote/${encodeURIComponent(normalized)}/`,
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-site",
    },
  })) as YahooChartResponse;
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

export async function fetchTencentStockKline(code: string, period: string, fq: string): Promise<{ security?: SecurityRecord; rows: KlineBar[] }> {
  const normalized = normalizeSecurityCode(code);
  const symbol = tencentSymbol(normalized);
  if (!symbol || period !== "day") {
    throw new Error(`unsupported Tencent kline code or period: ${code} ${period}`);
  }
  const url = new URL("https://web.ifzq.gtimg.cn/appstock/app/fqkline/get");
  url.searchParams.set("param", `${symbol},day,,,8000,${tencentFq(fq)}`);
  const body = (await fetchJson(url.toString(), {
    headers: { Referer: "https://gu.qq.com/" },
  })) as TencentKlineResponse;
  if (body.code && body.code !== 0) {
    throw new Error(`tencent kline error: code=${body.code} msg=${body.msg ?? ""}`);
  }
  const data = body.data?.[symbol];
  const key = tencentKlineKey(fq);
  const rawRows = data?.[key] ?? [];
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

export async function fetchEastmoneyCompanyOverview(code: string): Promise<CompanyOverview> {
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
  const body = (await fetchJson(url.toString(), {
    headers: { Referer: "https://quote.eastmoney.com/" },
  })) as EastmoneyOverviewResponse;
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
  const body = (await fetchJson(url.toString(), {
    headers: { Referer: "https://data.eastmoney.com/" },
  })) as EastmoneyNoticeResponse;
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

function financeReportType(statementType: StatementType): string {
  switch (statementType) {
    case "income":
      return "GINCOMEQC";
    case "balance":
      return "GBALANCE";
    case "cashflow":
      return "GCASHFLOWQC";
  }
}

function financeStyle(statementType: StatementType, reportType: string): string {
  if (statementType === "balance") {
    return `F10_FINANCE_${reportType}`;
  }
  return `APP_F10_${reportType}`;
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
