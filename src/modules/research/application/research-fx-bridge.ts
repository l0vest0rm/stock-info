import { D1MacroRepository } from "../../macro/application/macro-repository";

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

/**
 * Projects only already-persisted macro-series observations into an FX bridge.
 * It never derives a currency rate from a security price, market cap, income
 * statement or an LLM conclusion.  The underlying macro observation keeps the
 * original source URL, release vintage and observed time in its own ledger.
 */
export async function loadResearchFxBridge(
  db: D1Database,
  input: { fromCurrency: string | null | undefined; toCurrency: string | null | undefined; asOf?: number },
): Promise<ResearchFxBridge> {
  const fromCurrency = normalizeCurrency(input.fromCurrency);
  const toCurrency = normalizeCurrency(input.toCurrency);
  const processedAt = input.asOf ?? Date.now();
  if (!fromCurrency || !toCurrency) return blocked(input, processedAt, "currency_not_supported_by_source_bound_fx_bridge");
  if (fromCurrency === toCurrency) return {
    fromCurrency, toCurrency, status: "ready", rate: 1, asOf: null, sources: [],
    formula: "同币种，不使用外汇换算。", processing: "工程识别估值币种与证券币种相同，固定换算率为 1；未查询或生成 FX 数据。", processedAt, reason: null,
  };
  try {
    const repository = new D1MacroRepository(db);
    const [cnyUsd, hkdUsd] = await Promise.all([
      latestSource(repository, "DEXCHUS", "CNY/USD"),
      latestSource(repository, "HKMA_USD_HKD", "HKD/USD"),
    ]);
    const rate = convert(fromCurrency, toCurrency, cnyUsd?.value ?? null, hkdUsd?.value ?? null);
    const sources = [cnyUsd, hkdUsd].filter((item): item is ResearchFxSource => Boolean(item));
    if (rate === null) return {
      fromCurrency, toCurrency, status: "blocked", rate: null, asOf: latestDate(sources), sources,
      formula: formula(fromCurrency, toCurrency),
      processing: "工程仅可用已保存的宏观 FX 原始序列做单位换算；所需序列缺失、非正或不可用时不从证券价格或其他字段补算。",
      processedAt, reason: missingSeriesReason(fromCurrency, toCurrency, cnyUsd, hkdUsd),
    };
    return {
      fromCurrency, toCurrency, status: "ready", rate, asOf: latestDate(sources), sources,
      formula: formula(fromCurrency, toCurrency),
      processing: "工程读取已保存的 FX 原始序列并按明确币种单位执行乘除换算；每个中间序列保留观测日、来源 URL 和采集时间，不从价格、估值或文本推断汇率。",
      processedAt, reason: null,
    };
  } catch (error) {
    if (/no such table|storage_not_initialized/i.test(String(error))) return blocked({ fromCurrency, toCurrency }, processedAt, "macro_fx_storage_not_initialized");
    throw error;
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

async function latestSource(repository: D1MacroRepository, seriesId: string, unit: string): Promise<ResearchFxSource | null> {
  const observations = await repository.getObservationSeries(seriesId);
  const item = observations.at(-1);
  if (!item || !Number.isFinite(item.value) || item.value <= 0) return null;
  return { seriesId, observationDate: item.observationDate, value: item.value, unit, sourceUrl: item.sourceUrl, observedAt: item.observedAt };
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
  const required = new Set<string>();
  if (from === "CNY" || to === "CNY") required.add("DEXCHUS");
  if (from === "HKD" || to === "HKD") required.add("HKMA_USD_HKD");
  return [...required].filter((id) => id === "DEXCHUS" ? !cnyUsd : !hkdUsd).map((id) => `source_series_missing:${id}`).join(",") || "fx_rate_not_usable";
}

function normalizeCurrency(value: unknown): Currency | null {
  const currency = String(value || "").trim().toUpperCase();
  return currency === "CNY" || currency === "HKD" || currency === "USD" ? currency : null;
}
function latestDate(sources: ResearchFxSource[]): string | null { return sources.map((item) => item.observationDate).sort().at(-1) ?? null; }
function blocked(input: { fromCurrency?: unknown; toCurrency?: unknown }, processedAt: number, reason: string): ResearchFxBridge {
  return { fromCurrency: String(input.fromCurrency || "").trim().toUpperCase(), toCurrency: String(input.toCurrency || "").trim().toUpperCase(), status: "blocked", rate: null, asOf: null, sources: [], formula: "无可用的严格 FX 换算公式。", processing: "未执行换算；需要来源绑定且单位明确的 FX 原始序列。", processedAt, reason };
}
