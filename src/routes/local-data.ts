import { Hono } from "hono";
import { ok } from "../shared/http";
import type { AppEnv } from "../types";

export const localDataRoutes = new Hono<AppEnv>();

localDataRoutes.get("/knowledge/docs", (c) => ok(c, { items: [], total: 0, hasNext: false }));
localDataRoutes.get("/knowledge/doc", (c) => ok(c, null));
localDataRoutes.post("/knowledge/doc/read", (c) => ok(c, { saved: false, reason: "not-migrated" }));
localDataRoutes.post("/knowledge/doc/event", (c) => ok(c, { saved: false, reason: "not-migrated" }));
localDataRoutes.post("/knowledge/doc/favorite", (c) => ok(c, { saved: false, reason: "not-migrated" }));
localDataRoutes.get("/knowledge/sources", (c) => ok(c, []));
localDataRoutes.get("/knowledge/ingest-config", (c) =>
  ok(c, {
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
  })
);
localDataRoutes.post("/knowledge/ingest-config", (c) => ok(c, { saved: false, reason: "not-migrated" }));
localDataRoutes.post("/knowledge/ingest-run", (c) => ok(c, { started: false, reason: "not-migrated" }));

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
