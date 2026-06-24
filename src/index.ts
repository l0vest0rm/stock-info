import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { companyRoutes } from "./routes/company";
import { financeRoutes } from "./routes/finance";
import { fundRoutes } from "./routes/fund";
import { healthRoutes } from "./routes/health";
import { klineRoutes } from "./routes/kline";
import { localDataRoutes } from "./routes/local-data";
import { marketRoutes } from "./routes/market";
import { optionsRoutes } from "./routes/options";
import { searchRoutes } from "./routes/search";
import { thirteenFRoutes } from "./routes/thirteenf";
import { fail } from "./shared/http";
import type { AppEnv, Bindings } from "./types";

const app = new Hono<AppEnv>();

app.use("*", logger());
app.use("/api/*", cors());

app.route("/api", healthRoutes);
app.route("/api", searchRoutes);
app.route("/api", klineRoutes);
app.route("/api", financeRoutes);
app.route("/api", companyRoutes);
app.route("/api", fundRoutes);
app.route("/api", marketRoutes);
app.route("/api", optionsRoutes);
app.route("/api", thirteenFRoutes);
app.route("/api", localDataRoutes);

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

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    ctx.waitUntil(recordCronSkip(env));
  },
};

async function recordCronSkip(env: Bindings): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `insert into sync_jobs (job_id, job_type, status, started_at, finished_at, stats_json)
     values (?, 'cron', 'skipped', ?, ?, ?)`
  )
    .bind(crypto.randomUUID(), now, now, JSON.stringify({ reason: "free-tier-mvp-no-bulk-sync" }))
    .run();
}
