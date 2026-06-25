import { Hono } from "hono";
import { getSecurity, searchSecurities } from "../services/search";
import { externalHttpOptions, fail, ok, requireQuery } from "../shared/http";
import type { AppEnv } from "../types";

export const searchRoutes = new Hono<AppEnv>();

searchRoutes.get("/search", async (c) => {
  const q = requireQuery(c, "q");
  if (q instanceof Response) {
    return q;
  }
  const data = await searchSecurities(c.env.DB, q, { httpOptions: externalHttpOptions(c.env) });
  return ok(c, data);
});

searchRoutes.get("/suggest", async (c) => {
  const q = requireQuery(c, "q");
  if (q instanceof Response) {
    return q;
  }
  const data = await searchSecurities(c.env.DB, q, { httpOptions: externalHttpOptions(c.env) });
  return ok(c, data.map((item) => ({
    id: item.code,
    name: item.name,
  })));
});

searchRoutes.get("/code/name", async (c) => {
  const code = requireQuery(c, "code");
  if (code instanceof Response) {
    return code;
  }
  const result: Record<string, string> = {};
  for (const item of code.split(",").map((value) => value.trim()).filter(Boolean)) {
    const record = await getSecurity(c.env.DB, item, { httpOptions: externalHttpOptions(c.env) });
    result[item] = record?.name || item;
  }
  return ok(c, result);
});

searchRoutes.get("/securities/:code", async (c) => {
  const record = await getSecurity(c.env.DB, c.req.param("code"), { httpOptions: externalHttpOptions(c.env) });
  if (!record) {
    return fail(c, 404, "security not found");
  }
  return ok(c, record);
});
