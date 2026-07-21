import {
  fetchEastmoneyFundNav,
  fetchEastmoneyStockKline,
} from "../../../adapters/eastmoney";
import { upsertSecurity } from "../../../db/queries";
import {
  fullKlineHistoryStartDate,
  getFundNavSnapshot,
  getKlineSnapshot,
  putFundNavSnapshot,
  putKlineSnapshot,
  sliceFundNavRows,
  sliceKlineRows,
  snapshotCoversRange,
} from "../../../storage/market-data";
import { inferSecurityType, normalizeSecurityCode } from "../../../shared/codes";
import { marketDataCacheExpiresAtMsForCode } from "../../../shared/cache-policy";
import { externalHttpOptions } from "../../../shared/http";
import type { Bindings, FundNavRow, KlineBar } from "../../../types";

export async function loadKline(
  env: Pick<
    Bindings,
    | "DB"
    | "MARKET_DATA_BUCKET"
    | "HTTP_PROXY_URL"
    | "HTTP_PROXY_RELAY_URL"
    | "HTTP_DOMAIN_CONCURRENCY"
    | "HTTP_REQUEST_TIMEOUT_MS"
  >,
  rawCode: string,
  period: string,
  fq: string,
  from: string,
  to: string
): Promise<{
  code: string;
  source: "r2" | "eastmoney";
  rows: KlineBar[] | FundNavRow[];
}> {
  if (period !== "day") {
    throw new Error(`unsupported kline period: ${period}`);
  }
  const code = normalizeSecurityCode(rawCode);
  if (inferSecurityType(code) === "fund" || code.endsWith(".OF")) {
    const fundCode = code.endsWith(".OF") ? code : `${code.split(".")[0]}.OF`;
    const snapshot = await getFundNavSnapshot(env, fundCode);
    if (snapshot && isFreshEnough(fundCode, snapshot.updatedAt) && snapshotCoversRange(snapshot, from, to)) {
      return { code: fundCode, source: "r2", rows: sliceFundNavRows(snapshot.rows, from, to) };
    }
    const historyRows = await fetchEastmoneyFundNav(env.DB, fundCode, fullKlineHistoryStartDate(), to);
    if (historyRows.length > 0) {
      await putFundNavSnapshot(env, fundCode, historyRows);
    }
    return { code: fundCode, source: "eastmoney", rows: sliceFundNavRows(historyRows, from, to) };
  }

  const snapshot = await getKlineSnapshot(env, code, fq);
  if (
    snapshot
    && snapshot.source === "eastmoney"
    && isFreshEnough(code, snapshot.updatedAt)
    && snapshotCoversRange(snapshot, from, to)
  ) {
    return { code, source: "r2", rows: sliceKlineRows(snapshot.rows, from, to) };
  }
  const fetched = await fetchEastmoneyStockKline(
    env.DB,
    code,
    period,
    fq,
    fullKlineHistoryStartDate(),
    to,
    externalHttpOptions(env)
  );
  if (fetched.security) {
    await upsertSecurity(env.DB, fetched.security);
  }
  if (fetched.rows.length > 0) {
    await putKlineSnapshot(env, code, fq, fetched.rows);
  }
  return { code, source: "eastmoney", rows: sliceKlineRows(fetched.rows, from, to) };
}

function isFreshEnough(code: string, updatedAt: number | undefined): boolean {
  if (!updatedAt) {
    return false;
  }
  return Date.now() < marketDataCacheExpiresAtMsForCode(code, updatedAt);
}
