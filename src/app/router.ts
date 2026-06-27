import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { companyRoutes } from "../modules/company/api/company.routes";
import { financeRoutes } from "../modules/finance/api/finance.routes";
import { fundRoutes } from "../modules/fund/api/fund.routes";
import { healthRoutes } from "../modules/health/api/health.routes";
import { knowledgeRoutes } from "../modules/knowledge/api/knowledge.routes";
import { localDataRoutes } from "../modules/local-data/api/local-data.routes";
import { marketRoutes } from "../modules/market/api/market.routes";
import { klineRoutes } from "../modules/market/api/kline.routes";
import { optionsRoutes } from "../modules/options/api/options.routes";
import { securityRoutes } from "../modules/security/api/security.routes";
import { thirteenFRoutes } from "../modules/thirteenf/api/thirteenf.routes";
import { fail } from "../platform/http/response";
import { isLocalHostHeader } from "../platform/request/host";
import type { AppEnv } from "../types";

export function createRouter(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", logger());
  app.use("/api/*", cors());

  app.route("/api", healthRoutes);
  app.route("/api", securityRoutes);
  app.route("/api", klineRoutes);
  app.route("/api", financeRoutes);
  app.route("/api", companyRoutes);
  app.route("/api", fundRoutes);
  app.route("/api", marketRoutes);
  app.route("/api", optionsRoutes);
  app.route("/api", thirteenFRoutes);
  app.route("/api", knowledgeRoutes);
  app.route("/api", localDataRoutes);

  app.get("/company-option.html", (c) => {
    if (!isLocalHostHeader(c.req.header("host"))) {
      return fail(c, 404, "options page is only available in local development");
    }
    if (c.env.ASSETS) {
      return c.env.ASSETS.fetch(c.req.raw);
    }
    return fail(c, 404, "not found");
  });

  app.get("/knowledge-config.html", (c) => {
    if (!isLocalHostHeader(c.req.header("host"))) {
      return fail(c, 404, "knowledge config is only available in local development");
    }
    if (c.env.ASSETS) {
      return c.env.ASSETS.fetch(c.req.raw);
    }
    return fail(c, 404, "not found");
  });

  app.notFound((c) => {
    if (c.env.ASSETS) {
      return c.env.ASSETS.fetch(c.req.raw);
    }
    return fail(c, 404, "not found");
  });

  app.onError((err, c) => {
    console.error(err);
    return fail(c, 500, err instanceof Error ? err.message : String(err));
  });

  return app;
}
