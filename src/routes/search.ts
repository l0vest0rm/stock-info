import { Hono } from "hono";
import { getSecurity, searchSecurities } from "../services/search";
import { fail, ok, requireQuery } from "../shared/http";
import type { AppEnv } from "../types";

export const searchRoutes = new Hono<AppEnv>();

searchRoutes.get("/search", async (c) => {
  const q = requireQuery(c, "q");
  if (q instanceof Response) {
    return q;
  }
  const data = await searchSecurities(c.env.DB, q);
  return ok(c, data);
});

searchRoutes.get("/securities/:code", async (c) => {
  const record = await getSecurity(c.env.DB, c.req.param("code"));
  if (!record) {
    return fail(c, 404, "security not found");
  }
  return ok(c, record);
});
