import { Hono } from "hono";
import { fetchEastmoneyCompanyNotices, fetchEastmoneyCompanyOverview } from "../adapters/eastmoney";
import { ok, requireQuery } from "../shared/http";
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

companyRoutes.get("/company/notices", async (c) => {
  const code = requireQuery(c, "code");
  if (code instanceof Response) {
    return code;
  }
  const page = Number(c.req.query("page") ?? "1") || 1;
  const pageSize = Number(c.req.query("pageSize") ?? "20") || 20;
  const data = await fetchEastmoneyCompanyNotices(code, page, pageSize);
  return ok(c, data);
});
