import { Hono } from "hono";
import { ok } from "../shared/http";
import type { AppEnv } from "../types";

export const optionsRoutes = new Hono<AppEnv>();

optionsRoutes.get("/options/us", async (c) => {
  const code = (c.req.query("code") ?? "").trim().toUpperCase();
  return ok(c, {
    code,
    symbol: code.replace(/\.US$/, ""),
    currentPrice: 0,
    expirations: [],
    migrated: false,
    reason: "nasdaq-options-requires-local-cdp",
  });
});
