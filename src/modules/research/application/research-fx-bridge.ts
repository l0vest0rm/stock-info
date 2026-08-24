import { cachedFetchJson, cachedFetchText } from "../../../shared/http";

type Currency = "CNY" | "HKD" | "USD";
type Row = Record<string, unknown>;

export type ResearchFxSource = {
  seriesId: string;
  observationDate: string;
  value: number;
  unit: string;
  sourceUrl: string | null;
  observedAt: number;
};

export type ResearchFxBridge = {
  fromCurrency: string;
  toCurrency: string;
  status: "ready" | "blocked";
  rate: number | null;
  asOf: string | null;
  sources: ResearchFxSource[];
  formula: string;
  processing: string;
  processedAt: number;
  reason: string | null;
};

export type ResearchFxSourceLoader = (
  db: D1Database,
  source: "DEXCHUS" | "HKMA_USD_HKD",
) => Promise<ResearchFxSource | null>;

export type ResearchFxBridgeOptions = {
  /** Test and batch callers may supply an already-bound official FX loader.
   * The default reads the two public official endpoints through http_cache. */
  loadSource?: ResearchFxSourceLoader;
};

const FRED_CNY_USD_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DEXCHUS";
const HKMA_USD_HKD_URL = "https://api.hkma.gov.hk/public/market-data-and-statistics/monthly-statistical-bulletin/er-ir/er-eeri-daily?lang=en&offset=0";
const OFFICIAL_FX_CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Builds an FX bridge only from public official-source observations.  It is
 * intentionally outside the macro indicator catalogue: bilateral company
 * valuation conversion must survive a macro catalogue redesign, and cannot
 * be silently approximated by an unrelated macro indicator.
 * It never derives a currency rate from a security price, market cap, income
 * statement or an LLM conclusion. Responses use the existing http_cache, and
 * every bridge retains its official source URL and observation date.
 */
export async function loadResearchFxBridge(
  db: D1Database,
  input: { fromCurrency: string | null | undefined; toCurrency: string | null | undefined; asOf?: number },
  options: ResearchFxBridgeOptions = {},
): Promise<ResearchFxBridge> {
  const fromCurrency = normalizeCurrency(input.fromCurrency);
  const toCurrency = normalizeCurrency(input.toCurrency);
  const processedAt = input.asOf ?? Date.now();
  if (!fromCurrency || !toCurrency) return blocked(input, processedAt, "currency_not_supported_by_source_bound_fx_bridge");
  if (fromCurrency === toCurrency) return {
    fromCurrency, toCurrency, status: "ready", rate: 1, asOf: null, sources: [],
    formula: "同币种，不使用外汇换算。", processing: "工程识别估值币种与证券币种相同，固定换算率为 1；未查询或生成 FX 数据。", processedAt, reason: null,
  };
  const loadSource = options.loadSource ?? loadOfficialFxSource;
  const sourceResults = await Promise.allSettled([
    loadSource(db, "DEXCHUS"),
    loadSource(db, "HKMA_USD_HKD"),
  ]);
  const cnyUsd = settledSource(sourceResults[0]);
  const hkdUsd = settledSource(sourceResults[1]);
  const sourceFailures = failedSources(sourceResults);
  const required = requiredSourceIds(fromCurrency, toCurrency);
  const unavailableRequired = [...required].filter((id) => sourceFailures.has(id));
  const sources = [cnyUsd, hkdUsd].filter((item): item is ResearchFxSource => Boolean(item));
  if (unavailableRequired.length) return {
    fromCurrency, toCurrency, status: "blocked", rate: null, asOf: latestDate(sources), sources,
    formula: formula(fromCurrency, toCurrency),
    processing: "工程只接受官方 FX 原始序列；所需官方来源当前不可用时不使用证券价格、估值或文本补算。",
    processedAt, reason: unavailableRequired.map((id) => `official_fx_source_unavailable:${id}`).join(","),
  };
  const rate = convert(fromCurrency, toCurrency, cnyUsd?.value ?? null, hkdUsd?.value ?? null);
  if (rate === null) return {
    fromCurrency, toCurrency, status: "blocked", rate: null, asOf: latestDate(sources), sources,
    formula: formula(fromCurrency, toCurrency),
    processing: "工程仅可用官方 FX 原始序列做单位换算；所需序列缺失、非正或不可用时不从证券价格或其他字段补算。",
    processedAt, reason: missingSeriesReason(fromCurrency, toCurrency, cnyUsd, hkdUsd),
  };
  return {
    fromCurrency, toCurrency, status: "ready", rate, asOf: latestDate(sources), sources,
    formula: formula(fromCurrency, toCurrency),
    processing: "工程读取经缓存的官方 FX 原始序列并按明确币种单位执行乘除换算；每个中间序列保留观测日、来源 URL 和取得时间，不从价格、估值或文本推断汇率。",
    processedAt, reason: null,
  }
}

/** Returns FX candidates from every observed financial reporting currency to
 * the selected security's trading currency.  Multiple currencies remain
 * separate: the reader must select a model currency explicitly and cannot
 * silently mix an annual report with a market quote. */
export async function loadResearchFxBridgesForSecurity(db: D1Database, input: { securityCode: string; securityCurrency: string | null | undefined; asOf?: number }) {
  const securityCode = String(input.securityCode || "").trim().toUpperCase();
  const securityCurrency = normalizeCurrency(input.securityCurrency);
  const processedAt = input.asOf ?? Date.now();
  if (!securityCode || !securityCurrency) return { availability: "blocked" as const, bridges: [] as ResearchFxBridge[], reason: "security_trading_currency_missing", processedAt };
  try {
    const currencies = await db.prepare(`select distinct reporting_currency as reportingCurrency
      from research_financial_availability_observations where security_code=?
        and reporting_currency is not null and trim(reporting_currency)<>''
      order by reporting_currency`).bind(securityCode).all<Row>();
    const reportingCurrencies = [...new Set(currencies.results.map((row) => normalizeCurrency(row.reportingCurrency)).filter((item): item is Currency => Boolean(item)))];
    const bridges = await Promise.all(reportingCurrencies.map((fromCurrency) => loadResearchFxBridge(db, { fromCurrency, toCurrency: securityCurrency, asOf: processedAt })));
    return {
      availability: reportingCurrencies.length ? "available" as const : "empty" as const,
      securityCode, securityCurrency, reportingCurrencies, bridges,
      reason: reportingCurrencies.length ? null : "reporting_currency_not_yet_source_bound",
      processedAt,
      rule: "只为已来源绑定的财报报告币种与当前证券交易币种建立 FX 候选；不因市场惯例或公司名称猜测估值币种。",
    };
  } catch (error) {
    if (/no such table/i.test(String(error))) return { availability: "unavailable" as const, bridges: [] as ResearchFxBridge[], reason: "storage_not_initialized", processedAt };
    throw error;
  }
}

async function loadOfficialFxSource(
  db: D1Database,
  source: "DEXCHUS" | "HKMA_USD_HKD",
): Promise<ResearchFxSource | null> {
  if (source === "DEXCHUS") {
    const csv = await cachedFetchText(db, FRED_CNY_USD_URL, {
      headers: { Accept: "text/csv", "Accept-Language": "en-US,en;q=0.8" },
    }, OFFICIAL_FX_CACHE_TTL_MS, { cacheMaxBytes: 512 * 1024 });
    return parseFredCnyUsd(csv, Date.now());
  }
  const payload = await cachedFetchJson(db, HKMA_USD_HKD_URL, {
    headers: { Accept: "application/json" },
  }, OFFICIAL_FX_CACHE_TTL_MS, { cacheMaxBytes: 512 * 1024 });
  return parseHkmaUsdHkd(payload, Date.now());
}

function parseFredCnyUsd(csv: string, observedAt: number): ResearchFxSource | null {
  const lines = csv.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
  const header = lines.shift()?.split(",").map((item) => item.trim()) ?? [];
  if (header[0] !== "observation_date" || header[1] !== "DEXCHUS") throw new Error("official_fx_source_invalid_response:DEXCHUS");
  const observations = lines.flatMap((line) => {
    const separator = line.indexOf(",");
    const observationDate = line.slice(0, separator).trim();
    const value = Number(line.slice(separator + 1).trim());
    return separator > 0 && /^\d{4}-\d{2}-\d{2}$/.test(observationDate) && Number.isFinite(value) && value > 0
      ? [{ observationDate, value }] : [];
  }).sort((left, right) => left.observationDate.localeCompare(right.observationDate));
  const latest = observations.at(-1);
  return latest ? { seriesId: "DEXCHUS", ...latest, unit: "CNY/USD", sourceUrl: FRED_CNY_USD_URL, observedAt } : null;
}

function parseHkmaUsdHkd(payload: unknown, observedAt: number): ResearchFxSource | null {
  const root = record(payload);
  const result = record(root?.result);
  const records = Array.isArray(result?.records) ? result.records.map(record).filter((item): item is Row => Boolean(item)) : [];
  const observations = records.flatMap((item) => {
    const observationDate = text(item.end_of_day ?? item.end_of_date ?? item.end_of_month ?? item.date ?? item.reference_date);
    const value = finiteNumber(item.usd);
    return observationDate && /^\d{4}-\d{2}-\d{2}$/.test(observationDate) && value !== null && value > 0 ? [{ observationDate, value }] : [];
  }).sort((left, right) => left.observationDate.localeCompare(right.observationDate));
  const latest = observations.at(-1);
  if (!latest && records.length) throw new Error("official_fx_source_invalid_response:HKMA_USD_HKD");
  return latest ? { seriesId: "HKMA_USD_HKD", ...latest, unit: "HKD/USD", sourceUrl: HKMA_USD_HKD_URL, observedAt } : null;
}

function settledSource(result: PromiseSettledResult<ResearchFxSource | null>): ResearchFxSource | null {
  return result.status === "fulfilled" ? result.value : null;
}

function failedSources(results: readonly PromiseSettledResult<ResearchFxSource | null>[]): Set<"DEXCHUS" | "HKMA_USD_HKD"> {
  const sourceIds = ["DEXCHUS", "HKMA_USD_HKD"] as const;
  return new Set(sourceIds.filter((id, index) => results[index]?.status === "rejected"));
}

function requiredSourceIds(from: Currency, to: Currency): Set<"DEXCHUS" | "HKMA_USD_HKD"> {
  const required = new Set<"DEXCHUS" | "HKMA_USD_HKD">();
  if (from === "CNY" || to === "CNY") required.add("DEXCHUS");
  if (from === "HKD" || to === "HKD") required.add("HKMA_USD_HKD");
  return required;
}

function convert(from: Currency, to: Currency, cnyPerUsd: number | null, hkdPerUsd: number | null): number | null {
  const perUsd: Partial<Record<Currency, number>> = { USD: 1, CNY: cnyPerUsd ?? undefined, HKD: hkdPerUsd ?? undefined };
  const fromPerUsd = perUsd[from]; const toPerUsd = perUsd[to];
  if (typeof fromPerUsd !== "number" || typeof toPerUsd !== "number" || !Number.isFinite(fromPerUsd) || !Number.isFinite(toPerUsd) || fromPerUsd <= 0 || toPerUsd <= 0) return null;
  const rate = toPerUsd / fromPerUsd;
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

function formula(from: Currency, to: Currency): string {
  if (from === "USD" && to === "CNY") return "CNY/USD（DEXCHUS）。";
  if (from === "CNY" && to === "USD") return "USD/CNY = 1 ÷ CNY/USD（DEXCHUS）。";
  if (from === "USD" && to === "HKD") return "HKD/USD（HKMA_USD_HKD）。";
  if (from === "HKD" && to === "USD") return "USD/HKD = 1 ÷ HKD/USD（HKMA_USD_HKD）。";
  if (from === "CNY" && to === "HKD") return "HKD/CNY = (HKD/USD) ÷ (CNY/USD)。";
  return "CNY/HKD = (CNY/USD) ÷ (HKD/USD)。";
}

function missingSeriesReason(from: Currency, to: Currency, cnyUsd: ResearchFxSource | null, hkdUsd: ResearchFxSource | null): string {
  return [...requiredSourceIds(from, to)].filter((id) => id === "DEXCHUS" ? !cnyUsd : !hkdUsd).map((id) => `source_series_missing:${id}`).join(",") || "fx_rate_not_usable";
}

function normalizeCurrency(value: unknown): Currency | null {
  const currency = String(value || "").trim().toUpperCase();
  return currency === "CNY" || currency === "HKD" || currency === "USD" ? currency : null;
}
function record(value: unknown): Row | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null; }
function text(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value.replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : null;
}
function latestDate(sources: ResearchFxSource[]): string | null { return sources.map((item) => item.observationDate).sort().at(-1) ?? null; }
function blocked(input: { fromCurrency?: unknown; toCurrency?: unknown }, processedAt: number, reason: string): ResearchFxBridge {
  return { fromCurrency: String(input.fromCurrency || "").trim().toUpperCase(), toCurrency: String(input.toCurrency || "").trim().toUpperCase(), status: "blocked", rate: null, asOf: null, sources: [], formula: "无可用的严格 FX 换算公式。", processing: "未执行换算；需要来源绑定且单位明确的 FX 原始序列。", processedAt, reason };
}
