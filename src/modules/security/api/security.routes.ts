import { Hono } from "hono";
import { getSecurity, searchSecurities } from "../application/search-securities";
import { fail, ok, requireQuery } from "../../../shared/http";
import type { AppEnv } from "../../../types";

export const securityRoutes = new Hono<AppEnv>();

securityRoutes.get("/search", async (c) => {
  const q = requireQuery(c, "q");
  if (q instanceof Response) {
    return q;
  }
  const data = await searchSecurities(c.env.DB, q);
  return ok(c, data);
});

securityRoutes.get("/suggest", async (c) => {
  const q = requireQuery(c, "q");
  if (q instanceof Response) {
    return q;
  }
  const data = await searchSecurities(c.env.DB, q);
  return ok(
    c,
    data.map((item) => ({
      id: item.code,
      name: item.name,
    }))
  );
});

securityRoutes.get("/code/name", async (c) => {
  const code = requireQuery(c, "code");
  if (code instanceof Response) {
    return code;
  }
  const result: Record<string, string> = {};
  for (const item of code
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)) {
    const record = await getSecurity(c.env.DB, item);
    result[item] = record?.name || item;
  }
  return ok(c, result);
});

securityRoutes.get("/securities/:code", async (c) => {
  const record = await getSecurity(c.env.DB, c.req.param("code"));
  if (!record) {
    return fail(c, 404, "security not found");
  }
  return ok(c, record);
});
