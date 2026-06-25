import { Hono } from "hono";
import { fetchNasdaqUSOptionChain } from "../adapters/eastmoney";
import { externalHttpOptions, fail, ok, requireQuery } from "../shared/http";
import { isLocalHostHeader } from "../shared/request";
import type { AppEnv } from "../types";

export const optionsRoutes = new Hono<AppEnv>();

optionsRoutes.get("/options/us", async (c) => {
  if (!isLocalHostHeader(c.req.header("host"))) {
    return fail(c, 404, "options API is only available in local development");
  }
  const code = requireQuery(c, "code");
  if (code instanceof Response) return code;
  if (!code.toUpperCase().endsWith(".US")) {
    return fail(c, 400, "US options only supports .US code");
  }
  try {
    return ok(c, await fetchNasdaqUSOptionChain(c.env.DB, code, externalHttpOptions(c.env)));
  } catch (err) {
    return fail(c, 502, err instanceof Error ? err.message : String(err));
  }
});
