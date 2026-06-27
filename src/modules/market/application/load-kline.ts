import {
  fetchEastmoneyFundNav,
  fetchEastmoneyStockKline,
  fetchTencentStockKline,
} from "../../../adapters/eastmoney";
import {
  getFundNavRows,
  getKlineBars,
  upsertFundNav,
  upsertKlineBars,
  upsertSecurity,
} from "../../../db/queries";
import { inferSecurityType, normalizeSecurityCode } from "../../../shared/codes";
import type { ExternalHttpOptions } from "../../../shared/http";
import type { FundNavRow, KlineBar } from "../../../types";

export async function loadKline(
  db: D1Database,
  rawCode: string,
  period: string,
  fq: string,
  from: string,
  to: string,
  options?: { httpOptions?: ExternalHttpOptions }
): Promise<{ code: string; source: "d1" | "eastmoney" | "yahoo"; rows: KlineBar[] | FundNavRow[] }> {
  const code = normalizeSecurityCode(rawCode);
  if (inferSecurityType(code) === "fund" || code.endsWith(".OF")) {
    const fundCode = code.endsWith(".OF") ? code : `${code.split(".")[0]}.OF`;
    const cached = await getFundNavRows(db, fundCode, from, to);
    if (cached.length > 0 && isFreshEnough(cached[0]?.updatedAt)) {
      return { code: fundCode, source: "d1", rows: cached };
    }
    const rows = await fetchEastmoneyFundNav(db, fundCode, from, to);
    await upsertFundNav(db, rows);
    return { code: fundCode, source: "eastmoney", rows };
  }

  const cached = await getKlineBars(db, code, period, fq, from, to);
  if (cached.length > 0 && isFreshEnough(cached[0]?.updatedAt)) {
    return { code, source: "d1", rows: cached };
  }
  if (!isEastmoneyKlineCode(code)) {
    const cachedGlobal = await getKlineBars(db, code, period, fq, from, to);
    if (cachedGlobal.length > 0 && isFreshEnough(cachedGlobal[0]?.updatedAt)) {
      return { code, source: "d1", rows: cachedGlobal };
    }
    const fetched = await fetchEastmoneyStockKline(db, code, period, fq, from, to)
      .then((result) => result)
      .catch((err) => {
        console.warn(`eastmoney kline unavailable for ${code}:`, err);
        return { rows: [] as KlineBar[] };
      });
    await upsertKlineBars(db, fetched.rows);
    return { code, source: "eastmoney", rows: fetched.rows };
  }

  const fetched = await fetchTencentStockKline(db, code, period, fq).catch(async (err) => {
    console.warn(`tencent kline unavailable for ${code}, trying Eastmoney:`, err);
    return fetchEastmoneyStockKline(db, code, period, fq, from, to);
  });
  if (fetched.security) {
    await upsertSecurity(db, fetched.security);
  }
  await upsertKlineBars(db, fetched.rows);
  return { code, source: "eastmoney", rows: fetched.rows };
}

function isEastmoneyKlineCode(code: string): boolean {
  return /\.(SH|SZ|BJ|HK|US)$/.test(code);
}

function isFreshEnough(updatedAt: number | undefined): boolean {
  if (!updatedAt) {
    return false;
  }
  return Date.now() - updatedAt < 6 * 60 * 60 * 1000;
}
