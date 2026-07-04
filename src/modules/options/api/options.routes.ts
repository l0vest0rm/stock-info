import { Hono } from "hono";
import { fetchNasdaqUSOptionChain, fetchUSOptionChainSummary, fetchUSOptionExpiration } from "../../../adapters/eastmoney";
import { externalHttpOptions, fail, ok, requireQuery } from "../../../shared/http";
import { isLocalDevelopmentRuntime } from "../../../shared/request";
import type { AppEnv } from "../../../types";

export const optionsRoutes = new Hono<AppEnv>();

optionsRoutes.get("/options/us", async (c) => {
  if (!isLocalDevelopmentRuntime()) {
    return fail(c, 404, "options API is only available in local development");
  }
  const code = requireQuery(c, "code");
  if (code instanceof Response) return code;
  if (!code.toUpperCase().endsWith(".US")) {
    return fail(c, 400, "US options only supports .US code");
  }
  try {
    return ok(c, await fetchNasdaqUSOptionChain(c.env.DB, code, externalHttpOptions(c.env)));
  } catch (err) {
    return fail(c, 502, err instanceof Error ? err.message : String(err));
  }
});

optionsRoutes.get("/options/us/summary", async (c) => {
  if (!isLocalDevelopmentRuntime()) {
    return fail(c, 404, "options API is only available in local development");
  }
  const code = requireQuery(c, "code");
  if (code instanceof Response) return code;
  if (!code.toUpperCase().endsWith(".US")) {
    return fail(c, 400, "US options only supports .US code");
  }
  try {
    return ok(c, await fetchUSOptionChainSummary(c.env.DB, code, externalHttpOptions(c.env)));
  } catch (err) {
    return fail(c, 502, err instanceof Error ? err.message : String(err));
  }
});

optionsRoutes.get("/options/us/contracts", async (c) => {
  if (!isLocalDevelopmentRuntime()) {
    return fail(c, 404, "options API is only available in local development");
  }
  const code = requireQuery(c, "code");
  if (code instanceof Response) return code;
  if (!code.toUpperCase().endsWith(".US")) {
    return fail(c, 400, "US options only supports .US code");
  }
  const expirationsParam = c.req.query("expirations") || "";
  const strikesParam = c.req.query("strikes") || "";
  try {
    const summary = await fetchUSOptionChainSummary(c.env.DB, code, externalHttpOptions(c.env));
    const selectedExpirations = new Set(
      expirationsParam
        .split("|")
        .map((value) => value.trim())
        .filter(Boolean)
    );
    const selectedStrikes = new Set(
      strikesParam
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0)
    );
    const expirations = [];
    for (const item of summary.expirations) {
      if (selectedExpirations.size > 0 && !selectedExpirations.has(item.date)) {
        continue;
      }
      const expiration = await fetchUSOptionExpiration(c.env.DB, code, item.date, externalHttpOptions(c.env));
      expirations.push({
        date: expiration.date,
        calls: selectedStrikes.size > 0 ? expiration.calls.filter((contract) => selectedStrikes.has(contract.strike)) : expiration.calls,
        puts: selectedStrikes.size > 0 ? expiration.puts.filter((contract) => selectedStrikes.has(contract.strike)) : expiration.puts,
      });
    }
    return ok(c, {
      code: summary.code,
      symbol: summary.symbol,
      currentPrice: summary.currentPrice,
      updatedAt: summary.updatedAt,
      expirations,
    });
  } catch (err) {
    return fail(c, 502, err instanceof Error ? err.message : String(err));
  }
});
