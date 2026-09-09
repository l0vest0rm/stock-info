import { fetchEastmoneyCompanyOverview } from "../../../adapters/eastmoney";
import { loadKline } from "../../market/application/load-kline";
import { loadLatestFinancialValuation } from "../../finance/application/latest-financial-valuation";
import { getSecurity } from "../../security/application/search-securities";
import { inferSecurityType, normalizeSecurityCode, securityMarket } from "../../../shared/codes";
import { externalHttpOptions } from "../../../shared/http";
import { type AppEnv, type CompanyOverview, type KlineBar } from "../../../types";

export async function fetchCompanyOverview(env: AppEnv["Bindings"], code: string): Promise<CompanyOverview> {
  try {
    const normalized = normalizeSecurityCode(code);
    const [eastmoneyOverview, kline] = await Promise.all([
      fetchEastmoneyCompanyOverview(env.DB, normalized),
      loadKline(env, normalized, "day", "normal", "1990-01-01", today()),
    ]);
    return applyLatestFinancialValuation(env, normalized, applyXueqiuKlineOverview(eastmoneyOverview, kline.rows));
  } catch (err) {
    if (!isUnsupportedEastmoneyCompanyError(err)) {
      throw err;
    }
    return fetchGlobalCompanyOverview(env, code);
  }
}

async function fetchGlobalCompanyOverview(env: AppEnv["Bindings"], code: string): Promise<CompanyOverview> {
  const normalized = normalizeSecurityCode(code);
  const [security, kline] = await Promise.all([
    getSecurity(env.DB, normalized).catch(() => null),
    loadKline(env, normalized, "day", "normal", "1990-01-01", today())
      .catch(() => ({ rows: [] as KlineBar[] })),
  ]);
  const rows = kline.rows.filter((row): row is KlineBar => "close" in row && row.close !== null);
  const latest = rows.at(-1);
  const previous = rows.length > 1 ? rows.at(-2) : undefined;
  const latestPrice = latest?.close ?? null;
  const previousPrice = previous?.close ?? null;
  const changeAmount = latestPrice !== null && previousPrice !== null ? latestPrice - previousPrice : null;
  return applyLatestFinancialValuation(env, normalized, {
    code: normalized,
    name: security?.name || normalized,
    market: securityMarket(normalized),
    type: inferSecurityType(normalized),
    marketDate: latest?.date ?? null,
    latestPrice,
    pctChange:
      changeAmount !== null && previousPrice !== null && previousPrice !== 0
        ? (changeAmount * 100) / previousPrice
        : null,
    changeAmount,
    turnover: latest?.turnover ?? null,
    marketCapYi: latest?.marketCapital !== null && latest?.marketCapital !== undefined
      ? latest.marketCapital / 100_000_000
      : null,
    peTtm: null,
    pb: null,
    psTtm: null,
    pcfTtm: null,
    companyProfile: null,
    source: latest?.source ?? "local",
    updatedAt: Date.now(),
  });
}

async function applyLatestFinancialValuation(
  env: AppEnv["Bindings"],
  code: string,
  overview: CompanyOverview,
): Promise<CompanyOverview> {
  try {
    const valuation = await loadLatestFinancialValuation(
      env,
      code,
      overview.marketCapYi === null ? null : overview.marketCapYi * 100_000_000,
      { httpOptions: externalHttpOptions(env) },
    );
    return {
      ...overview,
      // Xueqiu is deliberately limited to price, market cap, and historical
      // observations. Current multiples always come from disclosed financials.
      peTtm: valuation.peTtm,
      pb: valuation.pb,
      psTtm: valuation.psTtm,
      pcfTtm: valuation.pcfTtm,
    };
  } catch (error) {
    console.warn("latest financial valuation unavailable", {
      code,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ...overview, peTtm: null, pb: null, psTtm: null, pcfTtm: null };
  }
}

function applyXueqiuKlineOverview(
  eastmoneyOverview: CompanyOverview,
  rows: Array<KlineBar | { date: string }>
): CompanyOverview {
  const latest = rows.filter((row): row is KlineBar => "close" in row).at(-1);
  if (!latest) {
    throw new Error(`Xueqiu K-line is empty for company overview: ${eastmoneyOverview.code}`);
  }
  return {
    ...eastmoneyOverview,
    marketDate: latest.date,
    latestPrice: latest.close,
    pctChange: latest.pctChange,
    changeAmount: latest.changeAmount,
    turnover: latest.turnover,
    marketCapYi: latest.marketCapital !== null ? latest.marketCapital / 100_000_000 : null,
    peTtm: null,
    pb: null,
    psTtm: null,
    pcfTtm: null,
    source: "xueqiu",
    updatedAt: latest.updatedAt,
  };
}

function isUnsupportedEastmoneyCompanyError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith("unsupported company code:");
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
