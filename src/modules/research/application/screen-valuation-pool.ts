/** Server-only valuation assembly. The dashboard cache schedules bounded,
 * per-security requests; the legacy bulk screen remains available to CLI callers.
 * Failures stay data, not investment conclusions. No LLM or trading execution.
 */
import { buildInvestmentOpportunity } from "../domain/investment-opportunity";
import type { InvestmentOpportunity } from "../../../../shared/investment-opportunity";
import opportunityPolicy from "../../../../config/investment-opportunity-policy.json";
import { trailingTwelveMonths } from "../../finance/domain/ttm-fiscal-calendar";
import { loadValuationBands } from "../../finance/application/load-valuation-bands";
import { loadFinancialStatementReadModel } from "../../finance/application/load-financial-statements";
import { buildQuarterlySeries } from "../../finance/domain/quarterly-ttm-series";
import { fetchXueqiuStockKline } from "../../../adapters/xueqiu";
import { assessValuation, type ValuationAssessment } from "../domain/valuation-assessment";
import { normalizeCurrency } from "../domain/valuation-screen";
import { fetchEastmoneyCompanyOverview } from "../../../adapters/eastmoney";
import { normalizeSecurityCode } from "../../../shared/codes";
import { externalHttpOptions, type ExternalHttpOptions } from "../../../shared/http";
import type { Bindings } from "../../../types";
import { screenValuationCandidate, type ValuationScreenResult } from "../domain/valuation-screen";
import { companyValuationArchetype } from "../domain/valuation-coverage";
import universeJson from "../../../../config/investment-universe.json";

type Environment = Pick<Bindings, "DB" | "MARKET_DATA_BUCKET"> & Partial<Pick<Bindings, "XUEQIU_COOKIE">>;

export type ValuationScreenRow = {
  assessment?: ValuationAssessment;
  opportunity?: InvestmentOpportunity;
  code: string;
  name: string;
  market: "CN" | "HK" | "US" | "KR";
  /** The archetype the band engine actually used, not the JSON's copy. */
  archetype: string;
  verdict: ValuationScreenResult["verdict"];
  /** Which band carried the verdict, so a reader can see the method. */
  basis: ValuationScreenResult["basis"];
  position: ValuationScreenResult["position"];
  /**
   * Domain reasons, plus the two facts that live one layer below the domain:
   * the quote provider failed, or this row's computation threw.  `valuation-screen`
   * cannot know either — it is given a quote or not — so they are declared here
   * rather than widening the domain union and making two of its members
   * unreachable from its own self-test.
   */
  blockReasons: Array<ValuationScreenResult["blockReasons"][number] | "quote_fetch_failed" | "request_failed" | "financial_refresh_failed" | "stale_quote">;
  note: string;
  /** Growth reading, present even when it changed nothing. */
  growth: ValuationScreenResult["growth"] | null;
  /** Always false; carried on every row so a consumer cannot lose the fact. */
  executable: false;
  /** Why the row could not be computed, phrased as a data fact. */
  unavailableReason?: string;
};

export type ValuationScreenSnapshot = {
  asOf: string;
  generatedAt: string;
  universeAsOf: string | null;
  companies: number;
  byVerdict: Record<string, number>;
  blockedDetail: Record<string, number>;
  rows: ValuationScreenRow[];
  /** Set when the snapshot is stale enough that a reader must not treat it as current. */
  stale: boolean;
  warnings: string[];
};

/** Parsed shape of `config/investment-universe.json`, reduced to what is needed. */
type UniverseCompany = {
  id: string;
  displayName: string;
  classificationStatus: string;
  preferredMarket: "CN" | "HK" | "US" | "KR";
  preferredTicker: string;
  securities: Array<{ ticker: string; market: string }>;
};
type Universe = { asOf?: string; companies: UniverseCompany[] };

const universe = universeJson as unknown as Universe;

/** The API code for a security: US tickers are bare in the JSON, `*.US` in the API. */
function apiCodeFor(security: { ticker: string; market: string }): string {
  return security.market === "US" && !security.ticker.endsWith(".US")
    ? `${security.ticker}.US`
    : security.ticker;
}

function tradingCurrency(market: string): string | null {
  return market === "CN" ? "CNY" : market === "HK" ? "HKD" : market === "US" ? "USD" : null;
}

/** Targets in a stable order so a snapshot diff is meaningful. */
export function screenTargets(): Array<{
  code: string;
  name: string;
  market: "CN" | "HK" | "US" | "KR";
  companyId: string;
}> {
  return (universe.companies ?? [])
    .filter((company) => company.classificationStatus === "verified")
    .map((company) => {
      const security = company.securities?.find((item) => item.ticker === company.preferredTicker)
        ?? company.securities?.[0];
      if (!security) return null;
      return {
        code: normalizeSecurityCode(apiCodeFor(security)),
        name: company.displayName,
        market: (security.market as "CN" | "HK" | "US" | "KR") ?? company.preferredMarket,
        companyId: company.id,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
}

/**
 * Reporting currency of the newest statement that declares one.
 *
 * Scanning past rows without a currency is deliberate: a 业绩预告 row carries no
 * `CURRENCY`, and taking the newest row blindly made 生益科技 — an A-share
 * reporting in CNY — look like a currency mismatch.  The fix belongs at the
 * source of the reading, not in a caller's special case.
 */
async function reportingCurrency(
  env: Environment,
  code: string,
  httpOptions: ExternalHttpOptions,
): Promise<string | null> {
  try {
    const model = await loadFinancialStatementReadModel(env, code, "income", { httpOptions });
    for (const row of model.rows ?? []) {
      const payload = row.payload && typeof row.payload === "object"
        ? row.payload as Record<string, unknown>
        : {};
      const currency = payload.CURRENCY ?? payload.CURRENCY_TYPE ?? payload.REPORTING_CURRENCY;
      if (typeof currency === "string" && currency.trim()) return currency.trim();
    }
  } catch {
    // An unreadable statement is reported as "currency unknown" by the screen,
    // which is the honest outcome; it is not a reason to fail the pool.
  }
  return null;
}

/**
 * Trailing net-profit growth from the newest quarterly/interim period.
 *
 * Never from an annual report, and the year-ago period matched by date rather
 * than array position, because US filers interleave 12M and 3M rows.  Absent
 * growth returns null: a data gap must not become a verdict.
 */
function ttmGrowth(points: Array<{ reportDate: string; ttmNetProfit: number | null; provisional?: boolean }>) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const latest = points[0];
  const latestTime = Date.parse(`${latest?.reportDate}T00:00:00Z`);
  if (!Number.isFinite(latestTime)) return null;
  let best: (typeof points)[number] | null = null;
  let bestDistance = Infinity;
  for (const point of points.slice(1)) {
    const time = Date.parse(`${point?.reportDate}T00:00:00Z`);
    if (!Number.isFinite(time)) continue;
    const distance = Math.abs(time - (latestTime - 365 * 86_400_000));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = point;
    }
  }
  if (!best || bestDistance > 45 * 86_400_000) return null;
  const now = latest?.ttmNetProfit;
  const then = best.ttmNetProfit;
  if (typeof now !== "number" || typeof then !== "number" || then <= 0 || now <= 0) return null;
  return {
    ttmGrowth: now / then - 1,
    reportDate: latest.reportDate,
    provisional: latest.provisional === true,
  };
}


/**
 * Compute one company's verdict.
 *
 * The bands engine already resolves the archetype from the universe definition,
 * so `archetype` on the row is the one the arithmetic used.  Reusing that rather
 * than the JSON's copy means the page cannot show a method it did not apply.
 */
async function screenOne(
  env: Environment,
  target: ReturnType<typeof screenTargets>[number],
  httpOptions: ExternalHttpOptions,
): Promise<ValuationScreenRow> {
  const base = {
    code: target.code,
    name: target.name,
    market: target.market,
    archetype: companyValuationArchetype(target.code) ?? "other",
    executable: false as const,
  };

  // Refresh each source once, then let the band loader reuse those same snapshots.
  const financials = await Promise.all((["income", "balance", "cashflow"] as const).map((type) =>
    loadFinancialStatementReadModel(env, target.code, type, { httpOptions })));
  const income = financials[0];
  const series = buildQuarterlySeries(target.code, income.rows ?? [], { limit: 12 });
  const growth = ttmGrowth(series.points);
  const cachedOptions = { ...httpOptions, bypassCache: false };
  const bandCurrency = await reportingCurrency(env, target.code, cachedOptions);
  let bars: import("../../../types").KlineBar[] = [];
  let quote: { currency: string | null; priceAsOf: string | null; marketCap: number | null } | null = null;
  let quoteMeta: ValuationAssessment['quote'] = null;
  let quoteFailed = false;
  let quoteStage = "雪球日线";
  let quoteFailureReason: string | undefined;
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    bars = (await fetchXueqiuStockKline(env.DB, target.code, "day", "normal", today, httpOptions, env.XUEQIU_COOKIE)).rows;
    const last = bars.at(-1);
    if (last?.marketCapital && last.marketCapital > 0) {
      quote = { currency: tradingCurrency(target.market), priceAsOf: last.date, marketCap: last.marketCapital };
      quoteMeta = { source: '雪球日线市值', date: last.date, fetchedAt: new Date(last.updatedAt).toISOString() };
    } else {
      // HK/US K-lines often have no market cap. Use an explicit dated quote,
      // never PE × our own profit (that circularly manufactures a valuation).
      quoteStage = "东方财富带日期市值";
      const overview = await fetchEastmoneyCompanyOverview(env.DB, target.code, { ...httpOptions, quoteOnly: true });
      quote = { currency: tradingCurrency(target.market), priceAsOf: overview.marketDate, marketCap: overview.marketCapYi == null ? null : overview.marketCapYi * 1e8 };
      quoteMeta = { source: '东方财富行情市值（非K线）', date: overview.marketDate, fetchedAt: new Date(overview.updatedAt).toISOString() };
    }
  } catch { quoteFailed = true; quoteFailureReason = `${quoteStage}请求失败；请检查数据源连接与凭据。`; }
  const comparableCurrency = !!bandCurrency && normalizeCurrency(bandCurrency) === normalizeCurrency(tradingCurrency(target.market));
  const bands = await loadValuationBands(env, target.code, { httpOptions: cachedOptions, marketCap: comparableCurrency ? quote?.marketCap ?? null : null });
  let result = screenValuationCandidate({ code: target.code, archetype: base.archetype, bands: bands.bands, bandCurrency, quote, growth });
  const quoteAge = quote?.priceAsOf ? (Date.now() - Date.parse(quote.priceAsOf)) / 86400000 : Infinity;
  const failedFinancials = financials.filter((model) => model.sourceHealth.status !== 'healthy');
  // A fresh computation does not make an old quote fresh. Holidays get a bounded
  // calendar allowance; suspensions beyond it must not produce a green badge.
  if (quoteFailed || (quoteAge > 7 || quoteAge < -1 || !Number.isFinite(quoteAge)) || failedFinancials.length) {
    result = { ...result, verdict: 'blocked', basis: null, position: null, blockReasons: ['quote_missing'], note: failedFinancials.length ? '本次财报刷新失败；不以旧财报冒充最新结果。' : quoteFailed ? quoteFailureReason! : '行情日期缺失或距今超过7天，不能判定当前估值。' };
  }
  const assessment = assessValuation({ result, bands, series, statements: income.rows, bars, quote: quoteMeta,
    historyComparable: comparableCurrency });
  const blockReasons: ValuationScreenRow['blockReasons'] = failedFinancials.length ? ['financial_refresh_failed'] : quoteFailed ? ['quote_fetch_failed'] : (quoteAge > 7 || quoteAge < -1 || !Number.isFinite(quoteAge)) ? ['stale_quote'] : result.blockReasons;
  // Separate adjusted-price contract. Never use normal-price bars for drawdowns.
  let adjustedBars: import("../../../types").KlineBar[] = [];
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    adjustedBars = (await fetchXueqiuStockKline(env.DB, target.code, 'day', 'qfq', today, httpOptions, env.XUEQIU_COOKIE)).rows;
  } catch { /* Missing adjusted data stays an uncovered signal, not a fallback. */ }
  const cashRows = financials[2].sourceHealth.status === 'healthy' ? financials[2].rows : [];
  const balanceRows = financials[1].sourceHealth.status === 'healthy' ? financials[1].rows : [];
  const cashDate = cashRows.map((r) => r.reportDate).sort().at(-1) ?? null;
  const balanceRow = [...balanceRows].sort((a, b) => b.reportDate.localeCompare(a.reportDate))[0];
  const numeric = (payload: unknown, keys: string[]) => {
    const object = (payload ?? {}) as Record<string, unknown>;
    for (const key of keys) if (typeof object[key] === 'number' && Number.isFinite(object[key])) return object[key] as number;
    return null;
  };
  const assets = numeric(balanceRow?.payload, ['TOTAL_ASSETS', 'totalAssets', 'totaAssets']);
  const liabilities = numeric(balanceRow?.payload, ['TOTAL_LIABILITIES', 'totalLiabilities', 'totalLiab']);
  const cashflowTtm = target.market === 'US' ? null : trailingTwelveMonths(cashRows, (row) => numeric(row.payload, ['NETCASH_OPERATE', 'netcashOperate', 'netCashOperate']));
  const opportunity = buildInvestmentOpportunity({ assessment, archetype: base.archetype, blockReasons,
    points: series.points, adjustedBars, cashflowTtm, cashflowReportDate: cashDate,
    debtRatio: assets !== null && assets > 0 && liabilities !== null && liabilities >= 0 ? liabilities / assets : null,
    balanceReportDate: balanceRow?.reportDate ?? null, policy: opportunityPolicy });
  return { ...base, ...result, blockReasons, growth: result.growth ?? null, assessment, opportunity };

}

/**
 * Screen the whole pool.
 *
 * Concurrency is bounded because the underlying provider rate-limits, and a
 * single company's failure must not abort the pass: it becomes a `blocked` row
 * with the reason attached, so the page shows "provider failed" rather than a
 * company silently missing from a list a reader assumes is complete.
 */
export async function screenValuationPool(
  env: Environment,
  options?: { httpOptions?: ExternalHttpOptions; concurrency?: number; codeFilter?: string[]; refreshData?: boolean },
): Promise<ValuationScreenSnapshot> {
  const httpOptions = { ...(options?.httpOptions ?? externalHttpOptions(env)), bypassCache: options?.refreshData === true };
  const concurrency = Math.max(1, options?.concurrency ?? 4);
  const filter = options?.codeFilter?.length ? new Set(options.codeFilter.map((code) => normalizeSecurityCode(code))) : null;
  const targets = screenTargets().filter((target) => !filter || filter.has(target.code));

  const rows: ValuationScreenRow[] = new Array(targets.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= targets.length) return;
      try {
        rows[index] = await screenOne(env, targets[index], httpOptions);
      } catch (error) {
        rows[index] = {
          code: targets[index].code,
          name: targets[index].name,
          market: targets[index].market,
          archetype: companyValuationArchetype(targets[index].code) ?? "other",
          verdict: "blocked",
          basis: null,
          position: null,
          blockReasons: ["request_failed"],
          note: "单家计算异常；这是执行问题，不代表公司无法估值。",
          growth: null,
          executable: false,
          unavailableReason: error instanceof Error ? error.message : String(error),
          opportunity: buildInvestmentOpportunity({ assessment: null, archetype: companyValuationArchetype(targets[index].code) ?? 'other', blockReasons: ['request_failed'], points: [], adjustedBars: [], cashflowTtm: null, cashflowReportDate: null, debtRatio: null, balanceReportDate: null, policy: opportunityPolicy }),
        };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(targets.length, 1)) }, worker));

  const byVerdict: Record<string, number> = {};
  const blockedDetail: Record<string, number> = {};
  for (const row of rows) {
    byVerdict[row.verdict] = (byVerdict[row.verdict] ?? 0) + 1;
    for (const reason of row.blockReasons) blockedDetail[reason] = (blockedDetail[reason] ?? 0) + 1;
  }

  const warnings: string[] = [];
  // A pass where most companies are blocked on the quote provider is a
  // provider outage, not a valuation conclusion.  Saying so in the payload
  // stops the page from rendering "22 companies have no valuation".
  const quoteFailures = (blockedDetail.quote_missing ?? 0) + (blockedDetail.quote_fetch_failed ?? 0);
  if (quoteFailures > 0 && quoteFailures >= rows.length / 2) {
    warnings.push(
      `本次 ${quoteFailures}/${rows.length} 家因行情取数失败被阻断；这是行情链路问题，不是这些公司无法估值。`,
    );
  }

  return {
    asOf: new Date().toISOString().slice(0, 10),
    generatedAt: new Date().toISOString(),
    universeAsOf: universe.asOf ?? null,
    companies: rows.length,
    byVerdict,
    blockedDetail,
    rows,
    stale: false,
    warnings,
  };
}

/**
 * Serve the last computed snapshot, refreshing only when it is absent or old.
 *
 * The page must not wait for a 100-company provider sweep. A stale snapshot is
 * served *with* its age and a `stale` flag rather than silently, because a
 * verdict from three days ago and one from an hour ago are different claims and
 * only the reader can judge which is acceptable.
 */
export const SCREEN_SNAPSHOT_TTL_MS = 6 * 60 * 60 * 1000;
const SCREEN_SNAPSHOT_NAMESPACE = "valuation-screen";
const SCREEN_SNAPSHOT_KEY = "watchlist";

type StoredSnapshot = ValuationScreenSnapshot & { storedAt: number };

export async function loadOrRefreshValuationScreen(
  env: Environment,
  options?: { force?: boolean; httpOptions?: ExternalHttpOptions },
): Promise<ValuationScreenSnapshot> {
  const { getKvCache, putKvCache } = await import("../../../db/queries");
  const now = Date.now();

  if (!options?.force) {
    const cached = await getKvCache(env.DB, SCREEN_SNAPSHOT_NAMESPACE, SCREEN_SNAPSHOT_KEY, now);
    if (cached) {
      try {
        const stored = JSON.parse(cached.valueJson) as StoredSnapshot;
        const age = now - stored.storedAt;
        return { ...stored, stale: age > SCREEN_SNAPSHOT_TTL_MS };
      } catch {
        // A corrupt snapshot must not block a refresh; fall through and rebuild.
      }
    }
  }

  const snapshot = await screenValuationPool(env, { httpOptions: options?.httpOptions });
  const stored: StoredSnapshot = { ...snapshot, storedAt: now };
  try {
    await putKvCache(env.DB, {
      namespace: SCREEN_SNAPSHOT_NAMESPACE,
      key: SCREEN_SNAPSHOT_KEY,
      valueJson: JSON.stringify(stored),
      expiresAt: now + 7 * 24 * 60 * 60 * 1000,
      updatedAt: now,
    });
  } catch {
    // Serving a fresh computation without persisting it is better than failing
    // the request; the next call simply recomputes.
  }
  return snapshot;
}
