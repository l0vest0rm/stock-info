import { loadFinancialStatementReadModel } from "../../finance/application/load-financial-statements";
import { externalHttpOptions } from "../../../shared/http";
import type { Bindings, FinancialStatement, StatementType } from "../../../types";
import { classifyResearchSecurity } from "../domain/research-identity";
import { buildFormalDisclosureCoverageMatrix, REQUIRED_FORMAL_DISCLOSURE_METRICS } from "../domain/formal-disclosure-coverage-matrix";
import { canonicalFinancialComparisonKey } from "../domain/research-financial-comparison-identity";
import { loadFinancialStatutoryVerifications } from "./financial-statutory-verification";
import {
  buildResearchFinancialQuality,
  type ResearchFinancialInputReference,
  type ResearchFinancialMetric,
  type ResearchFinancialPeriod,
  type StandardizedResearchFinancialFact,
} from "../domain/research-financial-quality";
import type { ResearchFinancialQualityEntityType } from "../domain/research-financial-profile";

type FinancialEnvironment = Pick<Bindings, "DB" | "MARKET_DATA_BUCKET" | "HTTP_PROXY_URL" | "HTTP_PROXY_RELAY_URL" | "HTTP_PROXY_DOMAINS" | "HTTP_DOMAIN_CONCURRENCY" | "HTTP_REQUEST_TIMEOUT_MS">;

/**
 * Internal server-side source load shared by the read model and statutory
 * verification job.  The normalized facts deliberately never cross the
 * public API boundary: they are primary-source inputs, not research output.
 */
export async function loadResearchFinancialFactSet(env: FinancialEnvironment, code: string) {
  const security = classifyResearchSecurity({ code, instrumentType: "stock" });
  const statementTypes: StatementType[] = ["income", "balance", "cashflow"];
  const loaded = await Promise.all(statementTypes.map(async (statementType) => {
    const result = await loadFinancialStatementReadModel(env, code, statementType, { httpOptions: externalHttpOptions(env) });
    return { statementType, result, error: result.sourceHealth.message };
  }));
  return {
    security,
    loaded,
    facts: loaded.flatMap(({ statementType, result }) => normalizeStatementRows(statementType, result.rows)),
    sourceErrors: loaded.filter((item) => item.result.sourceHealth.status === "failed"),
    primaryAvailable: loaded.every(({ result }) => Boolean(result.rows.length)),
  };
}

export async function loadResearchFinancialQuality(
  env: FinancialEnvironment,
  code: string,
  options: { entityType?: ResearchFinancialQualityEntityType } = {},
) {
  const { security, loaded, facts, sourceErrors, primaryAvailable } = await loadResearchFinancialFactSet(env, code);
  const [statutoryGate, statutoryVerifications] = await Promise.all([
    loadStatutoryGate(env.DB, security.market, facts),
    loadFinancialStatutoryVerifications(env.DB, security.code, { limit: 500 }),
  ]);
  const formalDisclosureCoverage = buildFormalDisclosureCoverageMatrix({ market: security.market, facts, verifications: statutoryVerifications });
  const availability = sourceErrors.length ? "source_error" as const
    : primaryAvailable && statutoryGate.status === "verified" ? "available" as const : "partial" as const;
  return {
    availability,
    sourcePolicy: security.market === "us_share"
      ? "Yahoo → SEC 核验（本地经配置代理；生产统一 HTTP；无自动回退）"
      : security.market === "h_share"
        ? "Eastmoney HK F10 → HKEX 核验（无自动回退）"
        : "Eastmoney → CNINFO 核验（无自动回退）",
    // `source` is deliberately the delivery path (for example `r2` cache),
    // not the accounting-data origin.  Expose both: a cache hit must never
    // make the reader lose whether this statement originated at Eastmoney or
    // Yahoo, and it must not be presented as a different financial provider.
    statements: loaded.map(({ statementType, result, error }) => ({
      statementType,
      rows: result.rows.length,
      source: result.delivery?.cache ?? "source_error",
      originProviders: result.delivery?.originProviders ?? [],
      reportingCurrencies: result.reportingCurrencies,
      latestReportDate: result.latestReportDate,
      sourceHealth: result.sourceHealth,
      error,
    })),
    statutoryGate,
    formalDisclosureCoverage,
    // A listed-security code cannot safely identify a bank, insurer or broker.
    // The research identity/business-model layer must pass the explicit classification.
    quality: buildResearchFinancialQuality({ facts, entityType: options.entityType }),
    limitations: availability === "available" ? [] : sourceErrors.length
      ? sourceErrors.map((item) => `${item.statementType} 正式来源请求失败：${item.error}`)
      : primaryAvailable && statutoryGate.status !== "verified"
        ? [statutoryGate.reason]
        : ["至少一张正式财报当前不可用；财务质量结论保持部分或待补。"],
  };
}

function distinct(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => typeof value === "string" ? value.trim() : "").filter(Boolean))];
}

function reportingCurrencyForStatement(row: FinancialStatement): string | null {
  const payload = row.payload && typeof row.payload === "object" ? row.payload as Record<string, unknown> : {};
  const value = payload.REPORTING_CURRENCY ?? payload.CURRENCY;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function latestReportDate(rows: FinancialStatement[]): string | null {
  return rows.map((row) => row.reportDate).filter((value): value is string => typeof value === "string" && value.length > 0)
    .sort((left, right) => right.localeCompare(left))[0] ?? null;
}

export async function loadStatutoryGate(
  db: D1Database,
  market: ReturnType<typeof classifyResearchSecurity>["market"],
  facts: StandardizedResearchFinancialFact[],
): Promise<{ status: "verified" | "partial"; requiredMetrics: typeof REQUIRED_FORMAL_DISCLOSURE_METRICS[number][]; verifiedMetrics: string[]; reason: string }> {
  const primaryComparisonKeysByMetric = new Map<string, string[]>();
  for (const fact of facts) {
    if (!REQUIRED_FORMAL_DISCLOSURE_METRICS.includes(fact.metric as typeof REQUIRED_FORMAL_DISCLOSURE_METRICS[number]) || fact.value === null) continue;
    // Legacy observations have no canonical key and intentionally do not
    // satisfy the current gate. Reprocessing appends a fresh observation;
    // historical rows remain immutable evidence.
    if (!fact.canonicalComparisonKey) continue;
    primaryComparisonKeysByMetric.set(fact.metric, [...(primaryComparisonKeysByMetric.get(fact.metric) ?? []), fact.canonicalComparisonKey]);
  }
  const provider = market === "us_share" ? "sec" : market === "h_share" ? "hkex" : "cninfo";
  try {
    const verifiedMetrics: string[] = [];
    for (const metric of REQUIRED_FORMAL_DISCLOSURE_METRICS) {
      const comparisonKeys = primaryComparisonKeysByMetric.get(metric) ?? [];
      if (!comparisonKeys.length) continue;
      const placeholders = comparisonKeys.map(() => "?").join(", ");
      const row = await db.prepare(`select 1 as matched from research_financial_statutory_verifications
        where statutory_provider=? and outcome='match' and metric=? and canonical_comparison_key in (${placeholders}) limit 1`)
        .bind(provider, metric, ...comparisonKeys).first<{ matched: number }>();
      if (row?.matched) verifiedMetrics.push(metric);
    }
    const status = verifiedMetrics.length === REQUIRED_FORMAL_DISCLOSURE_METRICS.length ? "verified" as const : "partial" as const;
    return {
      status,
      requiredMetrics: [...REQUIRED_FORMAL_DISCLOSURE_METRICS],
      verifiedMetrics,
      reason: status === "verified"
        ? market === "us_share"
          ? "Yahoo 主财报的关键字段已由 SEC 同口径法定披露逐字段核验。"
          : `Eastmoney 主财报的关键字段已由 ${provider.toUpperCase()} 同口径法定披露逐字段核验。`
        : market === "us_share"
          ? `美股 Yahoo 主财报不能仅因三表齐全而视为完整；仍缺 SEC 同口径核验：${REQUIRED_FORMAL_DISCLOSURE_METRICS.filter((metric) => !verifiedMetrics.includes(metric)).join("、")}。`
          : `${market === "h_share" ? "港股" : "A 股"} Eastmoney 主财报不能仅因三表齐全而视为完整；仍缺 ${provider.toUpperCase()} 同口径核验：${REQUIRED_FORMAL_DISCLOSURE_METRICS.filter((metric) => !verifiedMetrics.includes(metric)).join("、")}。`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no such table|does not exist|not found/i.test(message)) {
      return { status: "partial", requiredMetrics: [...REQUIRED_FORMAL_DISCLOSURE_METRICS], verifiedMetrics: [], reason: `${provider.toUpperCase()} 字段级核验账本尚未初始化，财务与估值结论保持部分可用。` };
    }
    throw error;
  }
}

export function normalizeStatementRows(statementType: StatementType, rows: FinancialStatement[]): StandardizedResearchFinancialFact[] {
  if (rows.some((row) => isHongKongCumulativeRow(row))) {
    return normalizeHongKongStatementRows(statementType, rows);
  }
  return rows.flatMap((row, rowIndex) => {
    const payload = row.payload && typeof row.payload === "object" ? row.payload as Record<string, unknown> : {};
    // Yahoo supplies report currency per source point. Never substitute the
    // trading currency of a U.S.-listed ADS when that source metadata is
    // absent or conflicted: no financial fact is safer than a false USD fact.
    if (row.source === "yahoo" && (!hasYahooReportingMetadata(payload) || payload.YAHOO_CURRENCY_CONFLICT === true)) return [];
    const period = parsePeriod(payload, row.reportDate, row.source);
    if (!period) return [];
    const values = statementValues(statementType, payload);
    const currency = text(payload.REPORTING_CURRENCY) ?? text(payload.CURRENCY) ?? (row.code.endsWith(".HK") ? "HKD" : "CNY");
    const sourceId = `${row.source}:${row.code}:${statementType}:${row.reportDate}:${row.fiscalPeriod || payload.FISCAL_PERIOD || "unknown"}:${rowIndex}`;
    // A report date is a period, not an accounting basis.  Keeping it in the
    // basis key would silently split each quarter into its own series and
    // make trend/TTM calculations impossible.
    // Yahoo's timeseries endpoint does not state an accounting taxonomy. US
    // market policy supplies this temporary comparison label; the field's
    // currency and period remain source-reported and a formal actual still
    // requires a matching SEC disclosure before it can be accepted.
    const accountingStandard = row.code.endsWith(".HK") ? text(payload.REPORTING_ACCOUNT_STANDARD) ?? text(payload.ACCOUNT_STANDARD) ?? "IFRS" : row.code.endsWith(".US") ? "US_GAAP" : "CAS";
    const basis = { id: `${currency}:${accountingStandard}:consolidated:reported`, currency, accountingStandard, scope: "consolidated", revision: "reported" };
    return values.map(([metric, value]) => ({
      id: `${sourceId}:${metric}`,
      canonicalComparisonKey: canonicalFinancialComparisonKey({ source: row.source, securityCode: row.code, statementType, metric, period, basis }),
      metric, period, value, basis,
      provenance: { sourceId, sourceType: row.source, publishedAt: text(payload.NOTICE_DATE) ?? row.reportDate, locator: metric },
    }));
  });
}

function hasYahooReportingMetadata(payload: Record<string, unknown>): boolean {
  return (payload.FINANCIAL_SOURCE_CONTRACT === "yahoo_finance_timeseries.v2" || payload.FINANCIAL_SOURCE_CONTRACT === "yahoo_finance_timeseries.v3")
    && typeof payload.REPORTING_CURRENCY === "string" && payload.REPORTING_CURRENCY.trim().length > 0
    && typeof payload.FISCAL_PERIOD === "string" && payload.FISCAL_PERIOD.trim().length > 0;
}

/**
 * Eastmoney HK F10 main indicators report Q1/H1/9M/FY flow values from the
 * fiscal-year start.  The only safe quarterly bridge is an adjacent cumulative
 * subtraction within the same reported accounting basis.  We deliberately do
 * not fabricate a point when a predecessor, currency, standard, scope, or
 * revision is absent.  Balance-sheet and share facts are period-end values and
 * are consequently emitted directly, never subtracted.
 */
function normalizeHongKongStatementRows(statementType: StatementType, rows: FinancialStatement[]): StandardizedResearchFinancialFact[] {
  const sources = rows.flatMap((row, rowIndex) => normalizeHongKongRow(statementType, row, rowIndex));
  if (statementType !== "income" && statementType !== "cashflow") return sources.flatMap((item) => item.facts);

  const output: StandardizedResearchFinancialFact[] = sources
    .filter((item) => item.dateType === "001")
    .flatMap((item) => item.facts.map((fact) => {
      const period = annualPeriod(item.period.fiscalYear, item.period.endDate);
      return {
        ...fact,
        period,
        canonicalComparisonKey: canonicalFinancialComparisonKey({
          source: fact.provenance.sourceType, securityCode: item.securityCode, statementType: item.statementType, metric: fact.metric, period, basis: fact.basis,
        }),
      };
    }));
  const byYearAndMetric = new Map<string, HongKongCumulativeFact[]>();
  for (const source of sources) {
    if (!source.dateType || source.dateType === "001") continue;
    for (const fact of source.facts) {
      const key = `${source.period.fiscalYear}|${fact.metric}`;
      const values = byYearAndMetric.get(key) ?? [];
      values.push({ ...source, fact });
      byYearAndMetric.set(key, values);
    }
  }
  // FY is an input to the Q4 bridge, so add it after annual facts have been
  // retained verbatim in the annual series above.
  for (const source of sources.filter((item) => item.dateType === "001")) {
    for (const fact of source.facts) {
      const key = `${source.period.fiscalYear}|${fact.metric}`;
      const values = byYearAndMetric.get(key) ?? [];
      values.push({ ...source, fact });
      byYearAndMetric.set(key, values);
    }
  }
  for (const values of byYearAndMetric.values()) output.push(...bridgeHongKongCumulativeMetric(values));
  return output;
}

type HongKongCumulativeSource = {
  securityCode: string;
  statementType: StatementType;
  dateType: string | null;
  period: ResearchFinancialPeriod;
  fact: StandardizedResearchFinancialFact;
  facts: StandardizedResearchFinancialFact[];
};
type HongKongCumulativeFact = HongKongCumulativeSource;

function normalizeHongKongRow(statementType: StatementType, row: FinancialStatement, rowIndex: number): HongKongCumulativeSource[] {
  const payload = row.payload && typeof row.payload === "object" ? row.payload as Record<string, unknown> : {};
  const period = parseHongKongPeriod(payload, row.reportDate);
  if (!period) return [];
  const currency = text(payload.REPORTING_CURRENCY) ?? text(payload.CURRENCY) ?? "HKD";
  const accountingStandard = text(payload.REPORTING_ACCOUNT_STANDARD) ?? text(payload.ACCOUNT_STANDARD) ?? "IFRS";
  const basis = { id: `${currency}:${accountingStandard}:consolidated:reported`, currency, accountingStandard, scope: "consolidated", revision: "reported" };
  const sourceId = `${row.source}:${row.code}:${statementType}:${row.reportDate}:${rowIndex}`;
  const provenance = { sourceId, sourceType: row.source, publishedAt: text(payload.NOTICE_DATE) ?? row.reportDate };
  const facts = statementValues(statementType, payload).map(([metric, value]) => ({
    id: `${sourceId}:${metric}`,
    canonicalComparisonKey: canonicalFinancialComparisonKey({ source: row.source, securityCode: row.code, statementType, metric, period, basis }),
    metric,
    period,
    value,
    basis,
    provenance: { ...provenance, locator: metric },
  }));
  return [{ securityCode: row.code, statementType, dateType: text(payload.DATE_TYPE_CODE), period, fact: facts[0], facts }];
}

function bridgeHongKongCumulativeMetric(values: HongKongCumulativeFact[]): StandardizedResearchFinancialFact[] {
  const byType = new Map(values.map((item) => [item.dateType, item]));
  const metric = values[0]?.fact.metric;
  if (!metric) return [];
  const q1 = byType.get("003");
  const h1 = byType.get("002");
  const m9 = byType.get("004");
  const fy = byType.get("001");
  const result: StandardizedResearchFinancialFact[] = [];
  if (q1) result.push(derivedHongKongQuarter(metric, q1.period.fiscalYear, 1, [q1], "Q1 reported cumulative value"));
  if (h1 && q1) result.push(derivedHongKongQuarter(metric, h1.period.fiscalYear, 2, [h1, q1], "H1 cumulative value - Q1 cumulative value"));
  if (m9 && h1) result.push(derivedHongKongQuarter(metric, m9.period.fiscalYear, 3, [m9, h1], "9M cumulative value - H1 cumulative value"));
  if (fy && m9) result.push(derivedHongKongQuarter(metric, fy.period.fiscalYear, 4, [fy, m9], "FY cumulative value - 9M cumulative value"));
  return result;
}

function derivedHongKongQuarter(
  metric: ResearchFinancialMetric,
  fiscalYear: number,
  fiscalQuarter: 1 | 2 | 3 | 4,
  inputs: HongKongCumulativeFact[],
  formula: string,
): StandardizedResearchFinancialFact {
  const [first, second] = inputs;
  if (!first) throw new Error("Hong Kong cumulative bridge requires a reported input");
  const mixedBasis = inputs.some((item) => !sameBasis(item.fact.basis, first.fact.basis));
  const missingInput = inputs.some((item) => item.fact.value === null);
  const value = mixedBasis || missingInput ? null : second ? first.fact.value! - second.fact.value! : first.fact.value!;
  const inputReferences: ResearchFinancialInputReference[] = inputs.map((item) => ({
    factId: item.fact.id,
    provenance: item.fact.provenance,
  }));
  const endDate = quarterEndDate(fiscalYear, fiscalQuarter);
  const period: ResearchFinancialPeriod = { kind: "quarter", startDate: `${fiscalYear}-${String((fiscalQuarter - 1) * 3 + 1).padStart(2, "0")}-01`, endDate, fiscalYear, fiscalQuarter };
  return {
    id: `hk-cumulative-bridge:${first.securityCode}:${first.statementType}:${metric}:${fiscalYear}:Q${fiscalQuarter}:${first.fact.basis.id}`,
    canonicalComparisonKey: canonicalFinancialComparisonKey({
      source: "derived_from_eastmoney_hk_f10", securityCode: first.securityCode, statementType: first.statementType, metric, period, basis: first.fact.basis,
    }),
    metric,
    period,
    value,
    basis: first.fact.basis,
    provenance: {
      sourceId: `hk-cumulative-bridge:${first.fact.provenance.sourceId}`,
      sourceType: "derived_from_eastmoney_hk_f10",
      publishedAt: first.fact.provenance.publishedAt,
      locator: formula,
    },
    inputReferences,
    derivationFormula: formula,
    derivationStatus: mixedBasis ? "incomparable" : missingInput ? "missing" : undefined,
    derivationReasonCodes: mixedBasis ? ["cumulative_bridge_mixed_accounting_basis"] : missingInput ? ["cumulative_bridge_input_missing"] : undefined,
  };
}

function isHongKongCumulativeRow(row: FinancialStatement): boolean {
  const payload = row.payload && typeof row.payload === "object" ? row.payload as Record<string, unknown> : {};
  return text(payload.FINANCIAL_SOURCE_CONTRACT) === "eastmoney_hk_f10_main_indicator.v1";
}

function parseHongKongPeriod(payload: Record<string, unknown>, fallback: string): ResearchFinancialPeriod | null {
  const date = (text(payload.REPORT_DATE) ?? fallback).slice(0, 10);
  const match = date.match(/^(\d{4})-(03|06|09|12)-(31|30)$/);
  if (!match) return null;
  const fiscalYear = Number(match[1]);
  const fiscalQuarter = ({ "03": 1, "06": 2, "09": 3, "12": 4 } as Record<string, 1 | 2 | 3 | 4>)[match[2]];
  return { kind: "quarter", startDate: `${fiscalYear}-${String((fiscalQuarter - 1) * 3 + 1).padStart(2, "0")}-01`, endDate: date, fiscalYear, fiscalQuarter };
}

function annualPeriod(fiscalYear: number, endDate: string): ResearchFinancialPeriod {
  return { kind: "annual", startDate: `${fiscalYear}-01-01`, endDate, fiscalYear };
}
function quarterEndDate(fiscalYear: number, fiscalQuarter: 1 | 2 | 3 | 4): string {
  const month = String(fiscalQuarter * 3).padStart(2, "0");
  return `${fiscalYear}-${month}-${fiscalQuarter === 1 || fiscalQuarter === 4 ? "31" : "30"}`;
}
function sameBasis(left: { id: string }, right: { id: string }): boolean { return left.id === right.id; }

function statementValues(statementType: StatementType, payload: Record<string, unknown>): Array<[ResearchFinancialMetric, number | null]> {
  if (statementType === "income") return [
    ["revenue", numberOf(payload.TOTAL_OPERATE_INCOME) ?? numberOf(payload.OPERATE_INCOME) ?? numberOf(payload.totalOperateIncome)],
    ["cost_of_revenue", numberOf(payload.OPERATE_COST) ?? numberOf(payload.TOTAL_OPERATE_COST) ?? numberOf(payload.operateCost)],
    ["gross_profit", numberOf(payload.GROSS_PROFIT) ?? numberOf(payload.grossProfit)],
    ["operating_profit", numberOf(payload.OPERATE_PROFIT) ?? numberOf(payload.operateProfit)],
    ["net_profit", numberOf(payload.PARENT_NETPROFIT) ?? numberOf(payload.HOLDER_PROFIT) ?? numberOf(payload.NETPROFIT) ?? numberOf(payload.parentNetprofit) ?? numberOf(payload.netProfit)],
    ["pre_tax_profit", numberOf(payload.TOTAL_PROFIT) ?? numberOf(payload.PROFIT_BEFORE_TAX) ?? numberOf(payload.pretaxIncome)],
    ["income_tax_expense", numberOf(payload.INCOME_TAX) ?? numberOf(payload.INCOME_TAX_EXPENSE) ?? numberOf(payload.taxProvision)],
    ["interest_expense", numberOf(payload.INTEREST_EXPENSE) ?? numberOf(payload.interestExpense)],
    // An issued/common-share field is a point-in-time basic share count, not
    // an EPS denominator.  It must enter the separately reviewed security
    // market-structure ledger with an explicit measurement basis; do not
    // relabel it as either diluted weighted-average shares or period-end
    // diluted shares just because this statement happens to contain it.
    ["diluted_weighted_average_shares", numberOf(payload.DILUTED_AVERAGE_SHARES)],
  ];
  if (statementType === "balance") return [
    ["cash", numberOf(payload.MONETARYFUNDS) ?? numberOf(payload.END_CASH) ?? numberOf(payload.endCce)],
    // Total liabilities is not debt.  Only a source's explicitly labeled total debt is admitted.
    ["total_debt", numberOf(payload.TOTAL_DEBT) ?? numberOf(payload.totalDebt)],
    ["total_equity", numberOf(payload.TOTAL_EQUITY) ?? numberOf(payload.TOTAL_PARENT_EQUITY) ?? numberOf(payload.totalEquity)],
    ["total_assets", numberOf(payload.TOTAL_ASSETS) ?? numberOf(payload.TOTAL_ASSET) ?? numberOf(payload.totalAssets) ?? numberOf(payload.totaAssets)],
    ["current_assets", numberOf(payload.TOTAL_CURRENT_ASSETS) ?? numberOf(payload.CURRENT_ASSETS) ?? numberOf(payload.currentAssets)],
    ["current_liabilities", numberOf(payload.TOTAL_CURRENT_LIAB) ?? numberOf(payload.TOTAL_CURRENT_LIABILITIES) ?? numberOf(payload.currentLiabilities)],
    ["trade_receivables", numberOf(payload.ACCOUNT_RECE) ?? numberOf(payload.ACCOUNTS_RECEIVABLE) ?? numberOf(payload.accountsReceivable)],
    ["contract_assets", numberOf(payload.CONTRACT_ASSET) ?? numberOf(payload.contractAssets)],
    ["inventory", numberOf(payload.INVENTORY) ?? numberOf(payload.inventories)],
    ["trade_payables", numberOf(payload.ACCOUNT_PAYABLE) ?? numberOf(payload.ACCOUNTS_PAYABLE) ?? numberOf(payload.accountsPayable)],
    ["short_term_debt", numberOf(payload.SHORTTERM_LOAN) ?? numberOf(payload.SHORT_TERM_DEBT) ?? numberOf(payload.shortTermDebt)],
    ["long_term_debt", numberOf(payload.LONGTERM_LOAN) ?? numberOf(payload.LONG_TERM_DEBT) ?? numberOf(payload.longTermDebt)],
    ["lease_liabilities", numberOf(payload.LEASE_LIABILITY) ?? numberOf(payload.leaseLiabilities)],
  ];
  return [
    ["operating_cash_flow", numberOf(payload.NETCASH_OPERATE) ?? numberOf(payload.netcashOperate)],
    ["capital_expenditure", numberOf(payload.CONSTRUCT_LONG_ASSET)],
    // These fields are admitted only when the upstream payload states the cash-flow direction as an outflow/inflow.
    // No absolute-value conversion is used: a source with an ambiguous sign remains unavailable to derived allocation metrics.
    ["dividends_paid", nonNegativeCashAmount(payload.DIVIDEND_PAID) ?? nonNegativeCashAmount(payload.dividendsPaid)],
    ["share_repurchases", nonNegativeCashAmount(payload.SHARE_REPURCHASES) ?? nonNegativeCashAmount(payload.shareRepurchases)],
    ["share_issuance", nonNegativeCashAmount(payload.SHARE_ISSUANCE) ?? nonNegativeCashAmount(payload.shareIssuance)],
    ["acquisition_spend", nonNegativeCashAmount(payload.ACQUISITION_SPEND) ?? nonNegativeCashAmount(payload.acquisitionSpend)],
    ["debt_repayment", nonNegativeCashAmount(payload.DEBT_REPAYMENT) ?? nonNegativeCashAmount(payload.debtRepayment)],
  ];
}

function parsePeriod(payload: Record<string, unknown>, fallback: string, source?: string) {
  const date = (text(payload.REPORT_DATE) ?? fallback).slice(0, 10);
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const fiscalYear = Number(match[1]);
  // HK F10 main indicators expose interim values on a year-to-date basis.
  // Do not mislabel those cumulative values as standalone quarters until the
  // statement-item normalizer performs an audited cumulative-to-quarter bridge.
  if (text(payload.FINANCIAL_SOURCE_CONTRACT) === "eastmoney_hk_f10_main_indicator.v1") {
    if (String(payload.DATE_TYPE_CODE ?? "") !== "001") return null;
    return { kind: "annual" as const, startDate: `${fiscalYear}-01-01`, endDate: date, fiscalYear };
  }
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(fiscalYear, month, 0)).getUTCDate()) return null;
  // U.S. issuers can have non-calendar fiscal quarter ends (for example
  // Nvidia's April/July/October/January cycle).  The source data available to
  // this normalizer carries a period-end date but not an authoritative fiscal
  // calendar, so retain its exact date and use a deterministic calendar bucket
  // only for sequence calculations.  We never claim this inferred bucket is a
  // statutory fiscal-quarter label; SEC comparison still uses the exact source
  // end date and marks a mismatch/unavailable explicitly when needed.
  if (/^(12M|FY|ANNUAL)$/i.test(String(payload.FISCAL_PERIOD ?? payload.fiscalPeriod ?? ""))
    // Eastmoney's A-share quarterly-comparison income endpoint reports the
    // year-end flow as `四季度`, while its balance/cash-flow endpoints use
    // `年报`.  The raw response has no FISCAL_PERIOD field, so treating every
    // December row as Q4 loses the annual primary fact needed for an audited
    // statutory comparison.  Keep this source-specific: a 12-31 date alone
    // never implies a fiscal year for a different provider or non-calendar
    // issuer.
    || (source === "eastmoney" && (
      text(payload.FINANCIAL_SOURCE_CONTRACT) === "eastmoney_f10_annual_income.v1"
      || /^(?:年报|年度报告|年度)$/.test(String(payload.REPORT_TYPE ?? "").trim())
    ) && month === 12 && day === 31)) {
    return { kind: "annual" as const, startDate: `${fiscalYear}-01-01`, endDate: date, fiscalYear };
  }
  const quarter = Math.ceil(month / 3) as 1 | 2 | 3 | 4;
  const start = `${fiscalYear}-${String((quarter - 1) * 3 + 1).padStart(2, "0")}-01`;
  return { kind: "quarter" as const, startDate: start, endDate: date, fiscalYear, fiscalQuarter: quarter };
}

function numberOf(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
/** Cash-allocation metrics use the explicit normalized convention: non-negative absolute cash amount.
 * A signed source field is not reinterpreted here; its upstream adapter must normalize it first. */
function nonNegativeCashAmount(value: unknown): number | null {
  const parsed = numberOf(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}
function text(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
