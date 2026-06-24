import { Hono } from "hono";
import { loadKline } from "../services/kline";
import { fail, ok, requireQuery } from "../shared/http";
import type { FundNavRow, KlineBar } from "../types";
import type { AppEnv } from "../types";

export const klineRoutes = new Hono<AppEnv>();

klineRoutes.get("/kline", async (c) => {
  const code = requireQuery(c, "code");
  if (code instanceof Response) {
    return code;
  }
  const period = normalizePeriod(c.req.query("period") ?? "day");
  const fq = normalizeFq(c.req.query("fq") ?? "normal");
  const to = normalizeDate(c.req.query("to")) ?? today();
  const from = normalizeDate(c.req.query("from")) ?? "1990-01-01";
  if (!period || !fq) {
    return fail(c, 400, "invalid period or fq parameter");
  }
  const data = await loadKline(c.env.DB, code, period, fq, from, to);
  return ok(c, toLegacyKlineRows(data.rows));
});

function normalizePeriod(value: string): string | null {
  if (value === "day" || value === "week" || value === "month") {
    return value;
  }
  return null;
}

function normalizeFq(value: string): string | null {
  if (!value || value === "before" || value === "qfq") {
    return "qfq";
  }
  if (value === "normal") {
    return "normal";
  }
  if (value === "after" || value === "hfq") {
    return "hfq";
  }
  return null;
}

function normalizeDate(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function toLegacyKlineRows(rows: Array<KlineBar | FundNavRow>): unknown[][] {
  return rows.map((row) => {
    if ("nav" in row) {
      return [dateToTimestamp(row.date), row.nav ?? row.accumNav ?? 0];
    }
    return [
      dateToTimestamp(row.date),
      row.close ?? 0,
      row.open ?? 0,
      row.high ?? 0,
      row.low ?? 0,
      row.volume ?? 0,
      row.turnover,
      null,
      null,
      null,
      null,
      null,
    ];
  });
}

function dateToTimestamp(date: string): number {
  const ts = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isFinite(ts) ? ts : 0;
}
