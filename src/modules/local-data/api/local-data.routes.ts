import { Hono } from "hono";
import { getAppKv, putAppKv } from "../../../db/queries";
import { fail, ok } from "../../../shared/http";
import { isLocalDevelopmentRuntime } from "../../../shared/request";
import type { AppEnv } from "../../../types";

export const localDataRoutes = new Hono<AppEnv>();
const COMPANIES_FOLLOW_CONFIG_KEY = "companies-follow-config:v1";

localDataRoutes.get("/knowledge/docs", (c) => ok(c, { items: [], total: 0, hasNext: false }));
localDataRoutes.get("/knowledge/doc", (c) => ok(c, null));
localDataRoutes.post("/knowledge/doc/read", (c) => fail(c, 404, "knowledge read state is not enabled"));
localDataRoutes.post("/knowledge/doc/event", (c) => fail(c, 404, "knowledge events are not enabled"));
localDataRoutes.post("/knowledge/doc/favorite", (c) => fail(c, 404, "knowledge favorites are not enabled"));
localDataRoutes.get("/knowledge/sources", (c) => ok(c, []));
localDataRoutes.get("/knowledge/ingest-config", (c) => {
  if (!isLocalDevelopmentRuntime()) {
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
  if (!isLocalDevelopmentRuntime()) {
    return fail(c, 404, "knowledge ingest config is only available in local development");
  }
  return ok(c, { saved: false, reason: "not-migrated" });
});
localDataRoutes.post("/knowledge/ingest-run", (c) => {
  if (!isLocalDevelopmentRuntime()) {
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

localDataRoutes.get("/companies/follow/forecast", async (c) => {
  if (!isLocalDevelopmentRuntime()) {
    return ok(c, { version: 1, storage: "browser" });
  }
  const record = await getAppKv(c.env.DB, COMPANIES_FOLLOW_CONFIG_KEY);
  if (!record) {
    return ok(c, {
      version: 1,
      tracks: {},
      positions: {},
      costs: {},
      riskPolicy: {},
      profits: {},
      profitSavedAt: {},
      storage: "backend",
      configured: false,
    });
  }
  const config = normalizeCompaniesFollowConfig(JSON.parse(record.valueJson) as Record<string, unknown>);
  return ok(c, { ...config, storage: "backend", configured: true });
});
localDataRoutes.post("/companies/follow/forecast", async (c) => {
  if (!isLocalDevelopmentRuntime()) {
    return fail(c, 404, "companies follow config is only writable in local development");
  }
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return fail(c, 400, "invalid companies follow config");
  }
  const config = normalizeCompaniesFollowConfig(body as Record<string, unknown>);
  await putAppKv(c.env.DB, {
    key: COMPANIES_FOLLOW_CONFIG_KEY,
    valueJson: JSON.stringify(config),
    expiresAt: null,
    updatedAt: Date.now(),
  });
  return ok(c, { ...config, storage: "backend", configured: true });
});
localDataRoutes.get("/report/forecast", (c) => ok(c, {}));
localDataRoutes.get("/company/reports", (c) => ok(c, { items: [], total: 0, hasNext: false }));
localDataRoutes.post("/company/report/update", (c) => ok(c, { started: false, reason: "not-migrated" }));
localDataRoutes.post("/company/report-ts/update", (c) => ok(c, { started: false, reason: "not-migrated" }));

type CompaniesFollowConfig = {
  version: 1;
  tracks: Record<string, string>;
  positions: Record<string, number>;
  costs: Record<string, number>;
  riskPolicy: {
    accountRiskPct?: number;
    maxStockPositionPct?: number;
  };
  profits: Record<string, Record<string, number>>;
  profitSavedAt: Record<string, Record<string, string>>;
};

function normalizeCompaniesFollowConfig(value: Record<string, unknown>): CompaniesFollowConfig {
  const tracks: Record<string, string> = {};
  const rawTracks = objectRecord(value.tracks);
  for (const [rawCode, rawTrack] of Object.entries(rawTracks)) {
    const code = rawCode.trim().toUpperCase();
    const track = typeof rawTrack === "string" ? rawTrack.trim() : "";
    if (code && track) {
      tracks[code] = track;
    }
  }

  const profits: Record<string, Record<string, number>> = {};
  const positions: Record<string, number> = {};
  const rawPositions = objectRecord(value.positions);
  for (const [rawCode, rawPosition] of Object.entries(rawPositions)) {
    const code = rawCode.trim().toUpperCase();
    const position = typeof rawPosition === "number" ? rawPosition : Number(rawPosition);
    if (code && Number.isFinite(position) && position > 0 && position <= 100) {
      positions[code] = position;
    }
  }

  const costs: Record<string, number> = {};
  const rawCosts = objectRecord(value.costs);
  for (const [rawCode, rawCost] of Object.entries(rawCosts)) {
    const code = rawCode.trim().toUpperCase();
    const cost = typeof rawCost === "number" ? rawCost : Number(rawCost);
    if (code && Number.isFinite(cost) && cost > 0) {
      costs[code] = cost;
    }
  }

  const riskPolicy: CompaniesFollowConfig["riskPolicy"] = {};
  const rawRiskPolicy = objectRecord(value.riskPolicy);
  const accountRiskPct = Number(rawRiskPolicy.accountRiskPct);
  const maxStockPositionPct = Number(rawRiskPolicy.maxStockPositionPct);
  if (Number.isFinite(accountRiskPct) && accountRiskPct > 0 && accountRiskPct <= 5) {
    riskPolicy.accountRiskPct = accountRiskPct;
  }
  if (Number.isFinite(maxStockPositionPct) && maxStockPositionPct > 0 && maxStockPositionPct <= 100) {
    riskPolicy.maxStockPositionPct = maxStockPositionPct;
  }

  const rawProfits = objectRecord(value.profits);
  for (const [rawCode, rawYears] of Object.entries(rawProfits)) {
    const code = rawCode.trim().toUpperCase();
    const years: Record<string, number> = {};
    for (const [year, rawProfit] of Object.entries(objectRecord(rawYears))) {
      const profit = typeof rawProfit === "number" ? rawProfit : Number(rawProfit);
      if (/^\d{4}$/.test(year) && Number.isFinite(profit) && profit > 0) {
        years[year] = profit;
      }
    }
    if (code && Object.keys(years).length > 0) {
      profits[code] = years;
    }
  }

  const profitSavedAt: Record<string, Record<string, string>> = {};
  const rawProfitSavedAt = objectRecord(value.profitSavedAt);
  for (const [rawCode, rawYears] of Object.entries(rawProfitSavedAt)) {
    const code = rawCode.trim().toUpperCase();
    const years: Record<string, string> = {};
    for (const [year, rawSavedAt] of Object.entries(objectRecord(rawYears))) {
      if (
        /^\d{4}$/.test(year)
        && typeof rawSavedAt === "string"
        && Number.isFinite(Date.parse(rawSavedAt))
        && profits[code]?.[year] !== undefined
      ) {
        years[year] = rawSavedAt;
      }
    }
    if (code && Object.keys(years).length > 0) {
      profitSavedAt[code] = years;
    }
  }
  return { version: 1, tracks, positions, costs, riskPolicy, profits, profitSavedAt };
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
