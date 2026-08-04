import type { FinancialStatement, StatementType } from "../../../types";

/**
 * The public, provider-neutral read contract for one primary financial
 * statement.  It deliberately distinguishes the primary accounting-data
 * provider from the cache used to deliver a response.  Statutory filings are
 * verification evidence and never an automatic fallback provider.
 */
export type FinancialStatementReadModel = {
  code: string;
  statementType: StatementType;
  sourcePolicy: FinancialStatementSourcePolicy;
  delivery: FinancialStatementDelivery | null;
  reportingCurrencies: string[];
  accountingStandards: string[];
  /** Source-reported end date and full-period marker; never inferred from UI labels. */
  periods: Array<{ reportDate: string; fiscalPeriod: string | null }>;
  latestReportDate: string | null;
  dataAsOf: string | null;
  revisionStatuses: string[];
  fieldAvailability: { rows: number; nonEmptyPayloadRows: number; status: "available" | "unavailable" };
  sourceHealth: FinancialStatementSourceHealth;
  rows: FinancialStatement[];
};

export type FinancialStatementSourcePolicy = {
  market: "a_share" | "h_share" | "us_share" | "unsupported";
  primaryProvider: "eastmoney" | "yahoo" | null;
  statutoryVerifier: "cninfo" | "hkex" | "sec" | null;
  automaticFallback: false;
  usTransport: "local_proxy_or_production_direct" | null;
};

export type FinancialStatementDelivery = {
  cache: "r2" | "provider";
  originProviders: string[];
  updatedAt: number | null;
  freshness: "fresh" | "stale" | "unknown";
};

export type FinancialStatementFailureCode =
  | "unsupported_security"
  | "missing_proxy_configuration"
  | "provider_rate_limited"
  | "provider_timeout"
  | "provider_response_error"
  | "invalid_provider_response"
  | "no_primary_data"
  | "unexpected_error";

export type FinancialStatementSourceHealth = {
  status: "healthy" | "degraded" | "failed";
  reason: FinancialStatementFailureCode | null;
  message: string | null;
};

export function financialStatementSourcePolicy(code: string): FinancialStatementSourcePolicy {
  const normalized = code.trim().toUpperCase();
  if (/\.(SH|SZ|BJ)$/.test(normalized)) {
    return { market: "a_share", primaryProvider: "eastmoney", statutoryVerifier: "cninfo", automaticFallback: false, usTransport: null };
  }
  if (/^\d{5}\.HK$/.test(normalized)) {
    return { market: "h_share", primaryProvider: "eastmoney", statutoryVerifier: "hkex", automaticFallback: false, usTransport: null };
  }
  if (/\.US$/.test(normalized)) {
    return { market: "us_share", primaryProvider: "yahoo", statutoryVerifier: "sec", automaticFallback: false, usTransport: "local_proxy_or_production_direct" };
  }
  return { market: "unsupported", primaryProvider: null, statutoryVerifier: null, automaticFallback: false, usTransport: null };
}

export function financialStatementFailure(error: unknown): Pick<FinancialStatementSourceHealth, "reason" | "message"> {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (/only supports|requires an \.hk|unsupported/.test(normalized)) return { reason: "unsupported_security", message };
  if (normalized.includes("http_proxy_relay_url is required")) return { reason: "missing_proxy_configuration", message };
  if (/status=429|rate limit|too many requests/.test(normalized)) return { reason: "provider_rate_limited", message };
  if (/timed out|timeout/.test(normalized)) return { reason: "provider_timeout", message };
  if (/invalid json|jsonp|unexpected token/.test(normalized)) return { reason: "invalid_provider_response", message };
  if (/request failed: status=|proxy relay request failed|yahoo finance error/.test(normalized)) return { reason: "provider_response_error", message };
  return { reason: "unexpected_error", message };
}

export function buildFinancialStatementReadModel(input: {
  code: string;
  statementType: StatementType;
  source: "r2" | "eastmoney" | "yahoo";
  rows: FinancialStatement[];
  fresh: boolean;
}): FinancialStatementReadModel {
  const rows = input.rows;
  const payloads = rows.map(payload);
  const latestReportDate = dates(rows.map((row) => row.reportDate))[0] ?? null;
  const currencies = values(payloads.map((item) => item.REPORTING_CURRENCY ?? item.CURRENCY));
  const accountingStandards = values(payloads.map((item) => item.REPORTING_ACCOUNT_STANDARD ?? item.ACCOUNT_STANDARD));
  const revisionStatuses = values(payloads.map((item) => item.REVISION ?? item.REVISION_STATUS)).map((item) => item.toLowerCase());
  const originProviders = values(rows.map((row) => row.source));
  const updatedAt = rows.map((row) => Number(row.updatedAt)).filter(Number.isFinite).sort((a, b) => b - a)[0] ?? null;
  const unavailable = rows.length === 0;
  return {
    code: input.code,
    statementType: input.statementType,
    sourcePolicy: financialStatementSourcePolicy(input.code),
    delivery: unavailable ? null : {
      cache: input.source === "r2" ? "r2" : "provider",
      originProviders,
      updatedAt,
      freshness: input.fresh ? "fresh" : "stale",
    },
    reportingCurrencies: currencies,
    accountingStandards,
    periods: rows.map((row) => ({ reportDate: row.reportDate, fiscalPeriod: row.fiscalPeriod ?? stringOrNull(payload(row).FISCAL_PERIOD) })),
    latestReportDate,
    dataAsOf: latestReportDate,
    revisionStatuses: revisionStatuses.length ? revisionStatuses : ["not_supplied"],
    fieldAvailability: { rows: rows.length, nonEmptyPayloadRows: rows.filter((row) => Object.keys(payload(row)).length > 0).length, status: unavailable ? "unavailable" : "available" },
    sourceHealth: unavailable
      ? { status: "degraded", reason: "no_primary_data", message: "primary financial provider returned no statement rows" }
      : { status: "healthy", reason: null, message: null },
    rows,
  };
}

export function failedFinancialStatementReadModel(code: string, statementType: StatementType, error: unknown): FinancialStatementReadModel {
  const failure = financialStatementFailure(error);
  return {
    code, statementType, sourcePolicy: financialStatementSourcePolicy(code), delivery: null,
    reportingCurrencies: [], accountingStandards: [], periods: [], latestReportDate: null, dataAsOf: null,
    revisionStatuses: [], fieldAvailability: { rows: 0, nonEmptyPayloadRows: 0, status: "unavailable" },
    sourceHealth: { status: "failed", ...failure }, rows: [],
  };
}

function payload(row: FinancialStatement): Record<string, unknown> {
  return row.payload && typeof row.payload === "object" ? row.payload as Record<string, unknown> : {};
}

function values(valuesToRead: unknown[]): string[] {
  return [...new Set(valuesToRead.map((value) => typeof value === "string" ? value.trim() : "").filter(Boolean))];
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function dates(valuesToRead: string[]): string[] {
  return [...new Set(valuesToRead.filter(Boolean))].sort((left, right) => right.localeCompare(left));
}
