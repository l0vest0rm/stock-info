import { Context, Hono } from "hono";
import { fetchEastmoneyCompanyNotices, fetchEastmoneyCompanyOverview } from "../adapters/eastmoney";
import { fail, ok, requireQuery } from "../shared/http";
import type { AppEnv } from "../types";

export const companyRoutes = new Hono<AppEnv>();

companyRoutes.get("/company/overview", async (c) => {
  const code = requireQuery(c, "code");
  if (code instanceof Response) {
    return code;
  }
  const data = await fetchEastmoneyCompanyOverview(code);
  return ok(c, data);
});

companyRoutes.get("/company/info", async (c) => {
  const code = requireQuery(c, "code");
  if (code instanceof Response) {
    return code;
  }
  const overview = await fetchEastmoneyCompanyOverview(code);
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
  const data = await fetchEastmoneyCompanyNotices(code, page, pageSize);
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
