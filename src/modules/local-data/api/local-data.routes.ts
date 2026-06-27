import { Hono } from "hono";
import { fail, ok } from "../../../shared/http";
import { isLocalHostHeader } from "../../../shared/request";
import type { AppEnv } from "../../../types";

export const localDataRoutes = new Hono<AppEnv>();

localDataRoutes.get("/knowledge/docs", (c) => ok(c, { items: [], total: 0, hasNext: false }));
localDataRoutes.get("/knowledge/doc", (c) => ok(c, null));
localDataRoutes.post("/knowledge/doc/read", (c) => fail(c, 404, "knowledge read state is not enabled"));
localDataRoutes.post("/knowledge/doc/event", (c) => fail(c, 404, "knowledge events are not enabled"));
localDataRoutes.post("/knowledge/doc/favorite", (c) => fail(c, 404, "knowledge favorites are not enabled"));
localDataRoutes.get("/knowledge/sources", (c) => ok(c, []));
localDataRoutes.get("/knowledge/ingest-config", (c) => {
  if (!isLocalHostHeader(c.req.header("host"))) {
    return fail(c, 404, "knowledge ingest config is only available in local development");
  }
  return ok(c, {
    config: {
      enabled: false,
      scheduleEvery: 30 * 60 * 1000,
      topic: "ai",
      pageSize: 50,
      scanPages: 50,
      workers: 1,
      companyEnabled: false,
      industryEnabled: false,
      newsEnabled: false,
      secEnabled: false,
    },
    sources: [],
    newsSources: [],
    newsSourceBacklog: [],
  });
});
localDataRoutes.post("/knowledge/ingest-config", (c) => {
  if (!isLocalHostHeader(c.req.header("host"))) {
    return fail(c, 404, "knowledge ingest config is only available in local development");
  }
  return ok(c, { saved: false, reason: "not-migrated" });
});
localDataRoutes.post("/knowledge/ingest-run", (c) => {
  if (!isLocalHostHeader(c.req.header("host"))) {
    return fail(c, 404, "knowledge ingest run is only available in local development");
  }
  return ok(c, { started: false, reason: "not-migrated" });
});

localDataRoutes.get("/portfolio/calculate", (c) =>
  ok(c, {
    trend: [],
    trendWithoutIncomeExpense: [],
    positions: [],
    stockPositions: [],
    sectorPositions: [],
    accountTotals: [],
    transactions: [],
  })
);
localDataRoutes.get("/portfolio/transaction-candidates", (c) => ok(c, []));
localDataRoutes.post("/portfolio/transactions/confirm", (c) => ok(c, { saved: false, reason: "not-migrated" }));
localDataRoutes.get("/stock-info", (c) => ok(c, {}));

localDataRoutes.get("/companies/follow/forecast", (c) => ok(c, {}));
localDataRoutes.post("/companies/follow/forecast", (c) => ok(c, { saved: false, reason: "not-migrated" }));
localDataRoutes.get("/report/forecast", (c) => ok(c, {}));
localDataRoutes.get("/company/reports", (c) => ok(c, { items: [], total: 0, hasNext: false }));
localDataRoutes.post("/company/report/update", (c) => ok(c, { started: false, reason: "not-migrated" }));
localDataRoutes.post("/company/report-ts/update", (c) => ok(c, { started: false, reason: "not-migrated" }));
