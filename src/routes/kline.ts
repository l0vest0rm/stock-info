import { Hono } from "hono";
import { loadKline } from "../services/kline";
import { fail, ok, requireQuery } from "../shared/http";
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
  const from = normalizeDate(c.req.query("from")) ?? offsetDate(to, 90);
  if (!period || !fq) {
    return fail(c, 400, "invalid period or fq parameter");
  }
  const data = await loadKline(c.env.DB, code, period, fq, from, to);
  return ok(c, data);
});

function normalizePeriod(value: string): string | null {
  if (value === "day" || value === "week" || value === "month") {
    return value;
  }
  return null;
}

function normalizeFq(value: string): string | null {
  if (value === "normal" || value === "qfq" || value === "hfq") {
    return value;
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

function offsetDate(endDate: string, days: number): string {
  const date = new Date(`${endDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}
