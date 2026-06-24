import { Hono } from "hono";
import { ok } from "../shared/http";
import type { AppEnv } from "../types";

export const healthRoutes = new Hono<AppEnv>();

healthRoutes.get("/health", async (c) => {
  const dbCheck = await c.env.DB.prepare("select 1 as ok").first<{ ok: number }>();
  return ok(c, {
    name: "stock-info",
    version: c.env.APP_VERSION ?? "dev",
    d1: dbCheck?.ok === 1,
    time: new Date().toISOString(),
  });
});
