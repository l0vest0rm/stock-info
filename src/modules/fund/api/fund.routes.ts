import { Hono } from "hono";
import { fetchEastmoneyText } from "../../../adapters/eastmoney";
import { bareCode, normalizeSecurityCode } from "../../../shared/codes";
import { ok, parseJsonOrJsonp, requireQuery } from "../../../shared/http";
import type { AppEnv } from "../../../types";

export const fundRoutes = new Hono<AppEnv>();

fundRoutes.get("/fund/info", async (c) => {
  const code = requireQuery(c, "code");
  if (code instanceof Response) return code;
  return ok(c, await fetchFundInfo(c.env.DB, code));
});

fundRoutes.get("/fund/position", async (c) => {
  const code = requireQuery(c, "code");
  if (code instanceof Response) return code;
  const num = positiveInt(c.req.query("num"), 2);
  return ok(c, await fetchFundPosition(c.env.DB, code, num));
});

fundRoutes.get("/fund/share-change", async (c) => {
  const code = requireQuery(c, "code");
  if (code instanceof Response) return code;
  return ok(c, await fetchFundShareChange(c.env.DB, code));
});

fundRoutes.get("/fund/notices", async (c) => {
  const code = requireQuery(c, "code");
  if (code instanceof Response) return code;
  const page = Math.min(positiveInt(c.req.query("page"), 1), 10_000);
  const pageSize = Math.min(positiveInt(c.req.query("pageSize"), 20), 100);
  const category = fundNoticeCategory(c.req.query("category"));
  return ok(c, await fetchFundNotices(c.env.DB, code, page, pageSize, category));
});

fundRoutes.get("/fund/constituents", async (c) => {
  const code = requireQuery(c, "code");
  if (code instanceof Response) return code;
  return ok(c, await fetchFundConstituents(c.env.DB, code));
});

fundRoutes.get("/fund/rank", async (c) => ok(c, await fetchFundRank(c.env.DB, c.req.query())));

fundRoutes.get("/fund/companies", async (c) => ok(c, await fetchFundCompanies(c.env.DB)));

async function fetchFundInfo(db: D1Database, code: string): Promise<Record<string, string>> {
  const fundCode = bareFundCode(code);
  const html = await fetchEastmoneyText(db, `https://fundf10.eastmoney.com/jbgk_${fundCode}.html`);
  const allText = normalizeText(stripTags(html));
  const info: Record<string, string> = {
    name: textBetween(stripTags(firstMatch(html, /<div[^>]*class=["']fundDetail-tit["'][^>]*>([\s\S]*?)<\/div>/i)), "", ""),
    manager: "",
    company: "",
    beginDate: "",
    updateDate: "",
    style: "",
    scale: "",
  };
  for (const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<(?:th|td)[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)].map((m) =>
      normalizeText(stripTags(m[1])).replace(/[：:]\s*$/, "")
    );
    for (let i = 0; i + 1 < cells.length; i += 2) {
      const key = cells[i];
      const value = cells[i + 1];
      if (key === "基金简称" && !info.name) info.name = value;
      if (key === "基金经理人" || key === "基金经理") info.manager = value;
      if (key === "基金管理人") info.company = value;
      if (key === "成立日期/规模") info.beginDate = matchDate(value);
      if (key === "基金类型") info.style = value;
      if (key === "净资产规模") {
        info.scale = firstMatch(value, /(\d+(?:\.\d+)?)\s*亿/) || value;
        info.updateDate = matchDate(value) || info.updateDate;
      }
    }
  }
  if (!info.name) {
    info.name = firstMatch(allText, /基金简称\s+([^\s]+)/) || fundCode;
  }
  if (!info.updateDate) {
    info.updateDate = matchDate(allText) || new Date().toISOString().slice(0, 10);
  }
  return info;
}

async function fetchFundPosition(db: D1Database, code: string, num: number): Promise<Array<Record<string, unknown>>> {
  const fundCode = bareFundCode(code);
  const now = new Date();
  const startYear = now.getMonth() + 1 < 4 ? now.getFullYear() - 1 : now.getFullYear();
  const rows = [
    ...(await fetchFundPositionYear(db, fundCode, startYear)),
    ...(await fetchFundPositionYear(db, fundCode, startYear - 1)),
  ];
  rows.sort((a, b) => String(b.updateDate).localeCompare(String(a.updateDate)));
  const seen = new Set<string>();
  return rows
    .filter((row) => {
      const key = String(row.updateDate);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, num)
    .map((row) => ({ ...row, sourceCode: `${fundCode}.OF`, sourceName: "", sourceKind: "fund" }));
}

async function fetchFundPositionYear(db: D1Database, fundCode: string, year: number): Promise<Array<Record<string, unknown>>> {
  const url = new URL("https://fundf10.eastmoney.com/FundArchivesDatas.aspx");
  url.searchParams.set("type", "jjcc");
  url.searchParams.set("code", fundCode);
  url.searchParams.set("topline", "20");
  url.searchParams.set("year", String(year));
  url.searchParams.set("month", "");
  url.searchParams.set("rt", "0.1");
  const raw = await fetchEastmoneyText(db, url.toString());
  const content = extractFundArchivesContent(raw);
  const rows: Array<Record<string, unknown>> = [];
  for (const box of content.matchAll(/<div[^>]*class=["'][^"']*boxitem[^"']*["'][^>]*>([\s\S]*?)(?=<div[^>]*class=["'][^"']*boxitem|$)/gi)) {
    const html = box[1];
    const labels = [...html.matchAll(/<label[^>]*>([\s\S]*?)<\/label>/gi)].map((m) => normalizeText(stripTags(m[1])));
    const updateDate = labels.map(matchDate).find(Boolean) || "";
    const data: unknown[] = [];
    for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => normalizeText(stripTags(m[1])));
      if (cells.length < 6) continue;
      const name = cells[2] || "";
      const stockCode = normalizeFundHoldingCode(cells[1], name);
      const ratioIdx = cells.length > 7 ? 6 : 4;
      const shareIdx = cells.length > 7 ? 7 : 5;
      if (!stockCode || !name) continue;
      data.push([stockCode, name, num(cells[ratioIdx].replace("%", "")), num(cells[shareIdx])]);
    }
    if (updateDate) rows.push({ updateDate, data });
  }
  return rows;
}

async function fetchFundShareChange(db: D1Database, code: string): Promise<Array<Record<string, unknown>>> {
  const fundCode = bareFundCode(code);
  const url = new URL("https://fundf10.eastmoney.com/FundArchivesDatas.aspx");
  url.searchParams.set("type", "gmbd");
  url.searchParams.set("mode", "0");
  url.searchParams.set("code", fundCode);
  url.searchParams.set("rt", "0.1");
  const raw = await fetchEastmoneyText(db, url.toString());
  const content = extractFundArchivesContent(raw);
  const parsedRows = [...content.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((m) => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => normalizeText(stripTags(cell[1]))))
    .filter((cells) => cells.length >= 6);
  return parsedRows.map((cells, idx) => {
    const total = num(cells[3]);
    const prevTotal = idx + 1 < parsedRows.length ? num(parsedRows[idx + 1][3]) : 0;
    return {
      date: cells[0],
      purchase: cells[1],
      redeem: cells[2],
      totalShare: cells[3],
      netAsset: cells[4],
      change: cells[5],
      shareChange: prevTotal > 0 ? ((total / prevTotal - 1) * 100).toFixed(2) : 0,
    };
  });
}

type EastmoneyFundNoticeResponse = {
  Data?: Array<{
    FUNDCODE?: string;
    TITLE?: string;
    NEWCATEGORY?: string;
    PUBLISHDATEDesc?: string;
    ATTACHTYPE?: string;
    ID?: string;
  }>;
  ErrCode?: number;
  ErrMsg?: string | null;
  TotalCount?: number;
  PageSize?: number;
  PageIndex?: number;
};

async function fetchFundNotices(
  db: D1Database,
  code: string,
  page: number,
  pageSize: number,
  category: string,
): Promise<Record<string, unknown>> {
  const fundCode = bareFundCode(code);
  const url = new URL("https://api.fund.eastmoney.com/f10/JJGG");
  url.searchParams.set("fundcode", fundCode);
  url.searchParams.set("pageIndex", String(page));
  url.searchParams.set("pageSize", String(pageSize));
  url.searchParams.set("type", category);
  const body = parseJsonOrJsonp(await fetchEastmoneyText(db, url.toString())) as EastmoneyFundNoticeResponse;
  if (body.ErrCode !== 0) {
    throw new Error(`eastmoney fund notices error: code=${body.ErrCode ?? "unknown"} msg=${body.ErrMsg ?? ""}`);
  }
  return {
    rows: (body.Data ?? []).map((item) => {
      const id = String(item.ID ?? "").trim();
      const itemFundCode = String(item.FUNDCODE ?? fundCode).trim() || fundCode;
      return {
        id,
        fundCode: itemFundCode,
        title: String(item.TITLE ?? "").trim(),
        category: String(item.NEWCATEGORY ?? "").trim(),
        publishDate: String(item.PUBLISHDATEDesc ?? "").slice(0, 10),
        detailUrl: id ? `https://fund.eastmoney.com/gonggao/${encodeURIComponent(itemFundCode)},${encodeURIComponent(id)}.html` : "",
        pdfUrl: id && item.ATTACHTYPE === "0" ? `https://pdf.dfcfw.com/pdf/H2_${encodeURIComponent(id)}_1.pdf` : "",
      };
    }).filter((item) => item.id && item.title),
    totalCount: Number(body.TotalCount ?? 0),
    page: Number(body.PageIndex ?? page),
    pageSize: Number(body.PageSize ?? pageSize),
  };
}

async function fetchFundConstituents(db: D1Database, code: string): Promise<Record<string, unknown>> {
  const fundCode = bareFundCode(code);
  try {
    const overview = await fetchSseOverview(db, fundCode);
    const rows = await fetchSseConstituents(db, fundCode);
    return {
      tradeDate: formatSseDate(String(overview.TRADING_DAY ?? "")),
      navPerCreationUnit: cleanMoney(overview.NAVPERCU),
      unitNav: cleanMoney(overview.NAV),
      recordCount: num(overview.RECORD_NUM),
      priceSourceNote: "",
      rows: rows.map((row) => ({
        rank: num(row.NUM),
        securityCode: String(row.INSTRUMENT_ID ?? "").trim(),
        securityName: String(row.INSTRUMENT_NAME ?? "").trim(),
        priceCode: null,
        price: "",
        priceSource: null,
        quantity: String(row.QUANTITY ?? "").replaceAll(",", ""),
        navPct: "",
      })),
    };
  } catch (err) {
    return {
      tradeDate: "",
      navPerCreationUnit: "",
      unitNav: "",
      recordCount: 0,
      rows: [],
      sourceError: err instanceof Error ? err.message : String(err),
    };
  }
}

async function fetchSseOverview(db: D1Database, fundCode: string): Promise<Record<string, unknown>> {
  const url = new URL("https://query.sse.com.cn/commonQuery.do");
  url.searchParams.set("jsonCallBack", "jsonpCallbackLicaiFundOverview");
  url.searchParams.set("isPagination", "false");
  url.searchParams.set("FUNDID2", fundCode);
  url.searchParams.set("sqlId", "COMMON_SSE_CP_JJLB_ETFJJGK_GGSGSHQD_JBXX_C");
  const body = parseJsonOrJsonp(await fetchEastmoneyText(db, url.toString(), "https://www.sse.com.cn/")) as {
    result?: Record<string, unknown>[];
  };
  return body.result?.[0] ?? {};
}

async function fetchSseConstituents(db: D1Database, fundCode: string): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let pageNo = 1;
  let pageCount = 1;
  while (pageNo <= pageCount && pageNo <= 50) {
    const url = new URL("https://query.sse.com.cn/commonQuery.do");
    url.searchParams.set("jsonCallBack", "jsonpCallbackLicaiFundConstituents");
    url.searchParams.set("isPagination", "true");
    url.searchParams.set("FUNDID2", fundCode);
    url.searchParams.set("sqlId", "COMMON_SSE_CP_JJLB_ETFJJGK_GGSGSHQD_COMPONENT_C");
    url.searchParams.set("pageHelp.pageSize", "10");
    url.searchParams.set("pageHelp.cacheSize", "1");
    url.searchParams.set("pageHelp.pageNo", String(pageNo));
    url.searchParams.set("pageHelp.beginPage", String(pageNo));
    url.searchParams.set("pageHelp.endPage", String(pageNo));
    const body = parseJsonOrJsonp(await fetchEastmoneyText(db, url.toString(), "https://www.sse.com.cn/")) as {
      result?: Record<string, unknown>[];
      pageHelp?: { pageCount?: number; data?: Record<string, unknown>[] };
    };
    pageCount = Math.max(1, Number(body.pageHelp?.pageCount ?? 1));
    rows.push(...(body.result?.length ? body.result : body.pageHelp?.data ?? []));
    pageNo += 1;
  }
  return rows;
}

async function fetchFundRank(db: D1Database, query: Record<string, string>): Promise<Record<string, unknown>> {
  const url = new URL("https://fund.eastmoney.com/data/rankhandler.aspx");
  const endDate = query.ed || new Date().toISOString().slice(0, 10);
  const startDate = query.sd || `${new Date().getFullYear() - 1}-${endDate.slice(5)}`;
  const params: Record<string, string> = {
    op: "ph",
    dt: "kf",
    ft: query.ft || "all",
    rs: "",
    gs: query.gs || "0",
    sc: query.sc || "3yzf",
    st: query.st || "desc",
    sd: startDate,
    ed: endDate,
    qdii: "",
    tabSubtype: ",,,,,",
    pi: query.pi || "1",
    pn: query.pn || "50",
    dx: "1",
    v: "0.7199999265711771",
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const text = await fetchEastmoneyText(db, url.toString(), "https://fund.eastmoney.com/data/fundranking.html");
  const dataSection = firstMatch(text, /datas:\[(.*)\],allRecords:/);
  const items = dataSection ? (JSON.parse(`[${dataSection}]`) as string[]) : [];
  return {
    rows: items
      .map((item, idx) => {
        const fields = item.split(",");
        if (fields.length < 19) return null;
        return [
          idx + 1,
          fields[0],
          `<a href="fund.html?code=${fields[0]}.OF">${fields[1]}</a>`,
          fields[3],
          fields[4],
          fields[5],
          fields[6],
          fields[7],
          fields[8],
          fields[9],
          fields[10],
          fields[11],
          fields[12],
          fields[13],
          fields[14],
          fields[15],
          fields[16],
          "",
          "",
          fields[24] || fundStyleLabel(params.ft),
          fields[18],
          "",
        ];
      })
      .filter(Boolean),
    allRecords: Number(firstMatch(text, /allRecords:(\d+)/) || 0),
    pageIndex: Number(firstMatch(text, /pageIndex:(\d+)/) || 1),
    pageNum: Number(firstMatch(text, /pageNum:(\d+)/) || 50),
    allPages: Number(firstMatch(text, /allPages:(\d+)/) || 1),
  };
}

async function fetchFundCompanies(db: D1Database): Promise<unknown> {
  const text = await fetchEastmoneyText(db, "https://fund.eastmoney.com/js/jjjz_gs.js?v=0.1", "https://fund.eastmoney.com/");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  return JSON.parse(text.slice(start, end + 1));
}

function extractFundArchivesContent(raw: string): string {
  let text = raw.trim().replace(/;$/, "").trim();
  const content = firstMatch(text, /content:"([\s\S]*?)",\s*arryear:/);
  if (content) return content.replaceAll('\\"', '"').replaceAll("\\/", "/");
  const equal = text.indexOf("=");
  if (equal >= 0) text = text.slice(equal + 1).trim().replace(/;$/, "").trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function bareFundCode(code: string): string {
  return bareCode(code).trim();
}

function stripTags(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function normalizeText(value: string): string {
  return value.split(/\s+/).join(" ").trim();
}

function firstMatch(value: string, pattern: RegExp): string {
  return value.match(pattern)?.[1]?.trim() ?? "";
}

function textBetween(value: string, _left: string, _right: string): string {
  return normalizeText(value);
}

function matchDate(value: string): string {
  const iso = value.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  if (iso) return iso;
  const cn = value.match(/(\d{4})年(\d{2})月(\d{2})日/);
  return cn ? `${cn[1]}-${cn[2]}-${cn[3]}` : "";
}

function num(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value !== "string") return 0;
  const parsed = Number(value.replaceAll(",", "").replace("%", "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function fundNoticeCategory(value: string | undefined): string {
  const category = String(value ?? "0").trim();
  return /^[0-6]$/.test(category) ? category : "0";
}

function formatSseDate(value: string): string {
  return /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : value;
}

function cleanMoney(value: unknown): string {
  return String(value ?? "").replace("￥", "").replaceAll(",", "").trim();
}

function fundStyleLabel(fundType: string): string {
  return (
    {
      gp: "股票型",
      hh: "混合型",
      zq: "债券型",
      zs: "指数型",
      ct: "场内交易",
      qdii: "QDII",
      lof: "LOF",
      fof: "FOF",
    }[fundType] || ""
  );
}

function normalizeFundHoldingCode(code: string, name: string): string {
  const bare = code.trim().toUpperCase().replace(/^A/, "");
  const normalizedName = name.toLowerCase();
  if (bare === "005930" || normalizedName.includes("samsung") || name.includes("三星")) {
    return `${bare}.KS`;
  }
  if (bare === "000660" || normalizedName.includes("sk hynix") || name.includes("海力士")) {
    return `${bare}.KS`;
  }
  if (bare === "042700" || normalizedName.includes("hanmi")) {
    return `${bare}.KS`;
  }
  return normalizeSecurityCode(bare);
}
