import { Context, Hono } from "hono";
import { fetchEastmoneyCompanyNotices, fetchEastmoneyCompanyOverview } from "../adapters/eastmoney";
import { loadKline } from "../services/kline";
import { getSecurity } from "../services/search";
import { inferSecurityType, normalizeSecurityCode, securityMarket } from "../shared/codes";
import { externalHttpOptions, fail, ok, requireQuery } from "../shared/http";
import type { AppEnv, CompanyOverview, KlineBar } from "../types";

export const companyRoutes = new Hono<AppEnv>();

companyRoutes.get("/company/overview", async (c) => {
  const code = requireQuery(c, "code");
  if (code instanceof Response) {
    return code;
  }
  const data = await fetchCompanyOverview(c, code);
  return ok(c, data);
});

companyRoutes.get("/company/info", async (c) => {
  const code = requireQuery(c, "code");
  if (code instanceof Response) {
    return code;
  }
  const overview = await fetchCompanyOverview(c, code);
  return ok(c, {
    code: overview.code,
    secCode: overview.code.split(".")[0],
    shortName: overview.name,
    name: overview.name,
    market: overview.market,
    type: overview.type,
    latestPrice: overview.latestPrice,
    marketCapYi: overview.marketCapYi,
    peTtm: overview.peTtm,
    pb: overview.pb,
  });
});

companyRoutes.get("/company/notices", async (c) => {
  const code = noticeCode(c);
  if (!code) {
    return fail(c, 400, "Missing code parameter");
  }
  const page = Number(c.req.query("page") ?? "1") || 1;
  const pageSize = Number(c.req.query("pageSize") ?? "20") || 20;
  const data = await fetchEastmoneyCompanyNotices(c.env.DB, code, page, pageSize);
  return ok(
    c,
    data.map((item) => ({
      art_code: item.artCode,
      title: item.title,
      notice_date: item.noticeDate,
      columns: [{ column_name: item.noticeType }],
    }))
  );
});

companyRoutes.get("/notice/pdf", async (c) => {
  const artCode = requireQuery(c, "artCode");
  if (artCode instanceof Response) {
    return artCode;
  }
  return ok(c, `https://pdf.dfcfw.com/pdf/H3_${encodeURIComponent(artCode)}_1.pdf`);
});

companyRoutes.get("/report/url", (c) => ok(c, null));

function noticeCode(c: Context<AppEnv>): string {
  const direct = c.req.query("code")?.trim();
  if (direct) {
    return direct;
  }
  const stock = c.req.query("stock")?.trim();
  const type = c.req.query("type")?.trim();
  if (!stock) {
    return "";
  }
  return type ? `${stock}.${type.toUpperCase()}` : stock;
}

async function fetchCompanyOverview(c: Context<AppEnv>, code: string): Promise<CompanyOverview> {
  try {
    return await fetchEastmoneyCompanyOverview(c.env.DB, code);
  } catch (err) {
    if (!isUnsupportedEastmoneyCompanyError(err)) {
      throw err;
    }
    return fetchGlobalCompanyOverview(c, code);
  }
}

async function fetchGlobalCompanyOverview(c: Context<AppEnv>, code: string): Promise<CompanyOverview> {
  const normalized = normalizeSecurityCode(code);
  const httpOptions = externalHttpOptions(c.env);
  const [security, kline] = await Promise.all([
    getSecurity(c.env.DB, normalized, { httpOptions }).catch(() => null),
    loadKline(c.env.DB, normalized, "day", "normal", "1990-01-01", today(), {
      httpOptions,
    }).catch(() => ({ rows: [] as KlineBar[] })),
  ]);
  const rows = kline.rows.filter((row): row is KlineBar => "close" in row && row.close !== null);
  const latest = rows.at(-1);
  const previous = rows.length > 1 ? rows.at(-2) : undefined;
  const latestPrice = latest?.close ?? null;
  const previousPrice = previous?.close ?? null;
  const changeAmount =
    latestPrice !== null && previousPrice !== null ? latestPrice - previousPrice : null;
  return {
    code: normalized,
    name: security?.name || normalized,
    market: securityMarket(normalized),
    type: inferSecurityType(normalized),
    latestPrice,
    pctChange:
      changeAmount !== null && previousPrice !== null && previousPrice !== 0
        ? (changeAmount * 100) / previousPrice
        : null,
    changeAmount,
    turnover: null,
    marketCapYi: null,
    peTtm: null,
    pb: null,
    source: latest ? "yahoo" : "local",
    updatedAt: Date.now(),
  };
}

function isUnsupportedEastmoneyCompanyError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith("unsupported company code:");
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
