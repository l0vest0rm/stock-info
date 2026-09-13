import { Hono } from "hono";
import { fail, ok } from "../../../shared/http";
import { acceptPublishedReport, reportSyncTokenMatches } from "../../../shared/remote-report-sync";
import type { AppEnv } from "../../../types";

/** Private Worker ingress for completed local report projections. */
export const reportSyncRoutes = new Hono<AppEnv>();

reportSyncRoutes.post("/internal/report-sync", async (c) => {
  if (c.env.APP_RUNTIME !== "cloudflare") return fail(c, 404, "not found");
  const bearer = c.req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!reportSyncTokenMatches(c.env.REPORT_SYNC_TOKEN, bearer)) return fail(c, 401, "unauthorized report sync");
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return fail(c, 400, "invalid report sync request");
  try {
    const record = await acceptPublishedReport(c.env.DB, body.record);
    return ok(c, { namespace: record.namespace, key: record.key, updatedAt: record.updatedAt });
  } catch (error) {
    return fail(c, 400, error instanceof Error ? error.message : String(error));
  }
});
