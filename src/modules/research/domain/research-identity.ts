import { normalizeSecurityCode } from "../../../shared/codes";

export const FINANCIAL_STATEMENT_TYPES = ["income", "balance", "cashflow"] as const;

export type FinancialStatementType = typeof FINANCIAL_STATEMENT_TYPES[number];
export type ResearchMarket = "a_share" | "h_share" | "us_share";
export type ResearchInstrumentKind = "equity" | "adr" | "unknown";
export type FinancialProvider = "eastmoney" | "yahoo" | "cninfo" | "hkex" | "sec";
export type FinancialSourceRole = "primary_structured" | "statutory_verification";
export type FinancialAvailabilityStatus =
  | "verified_available"
  | "partially_available"
  | "requires_integration"
  | "document_only"
  | "unavailable"
  | "source_unhealthy";

export type ResearchSecurityDescriptor = {
  code: string;
  name?: string | null;
  instrumentType?: string | null;
};

export type ClassifiedResearchSecurity = {
  code: string;
  market: ResearchMarket;
  instrumentKind: ResearchInstrumentKind;
  eligibility: "eligible" | "needs_review";
};

/**
 * A source-bound research identity can be more specific than the broad search
 * record. Providers commonly label ADSs as generic stocks; once a reviewed
 * ADR classification is persisted, that generic label must not remove its
 * ADR-specific rights and market-structure gates.
 */
export function resolveResearchInstrumentKind(
  sourceInstrumentKind: ResearchInstrumentKind,
  persistedInstrumentKind: ResearchInstrumentKind | null,
): ResearchInstrumentKind {
  return persistedInstrumentKind ?? sourceInstrumentKind;
}

export type FinancialSourcePolicy = {
  market: ResearchMarket;
  primaryProvider: FinancialProvider;
  verificationProvider: FinancialProvider;
  expectedTradingCurrency: "CNY" | "HKD" | "USD";
  runtimeIntegration: "integrated" | "not_integrated";
  localAccess: "direct" | "configured_proxy_required";
  productionAccess: "direct" | "unified_http_direct";
  noAutomaticFallback: true;
};

export type FinancialAvailabilityObservation = {
  observationId: string;
  statementType: FinancialStatementType;
  provider: string;
  sourceRole: FinancialSourceRole;
  status: FinancialAvailabilityStatus;
  asOf: number;
  latestPeriod: string | null;
  reportingCurrency: string | null;
  accountingBasis: string | null;
  sourceUrl: string | null;
  blockingReason: string | null;
  details: Record<string, unknown>;
};

export type StatementFinancialAvailability = {
  statementType: FinancialStatementType;
  status: FinancialAvailabilityStatus;
  primaryProvider: FinancialProvider;
  verificationProvider: FinancialProvider;
  primaryObservation: FinancialAvailabilityObservation | null;
  verificationObservation: FinancialAvailabilityObservation | null;
  blockingReason: string | null;
};

export type FinancialCoverage = {
  policy: FinancialSourcePolicy;
  status: FinancialAvailabilityStatus;
  statements: StatementFinancialAvailability[];
  gaps: string[];
};

export const SECURITY_RIGHTS_EVIDENCE_KINDS = [
  "securities_regulator_filing",
  "official_exchange_disclosure",
  "depositary_agreement",
  "issuer_official_disclosure",
] as const;
export type SecurityRightsEvidenceKind = typeof SECURITY_RIGHTS_EVIDENCE_KINDS[number];

export type SecurityRightsEvidence = {
  evidenceKind: SecurityRightsEvidenceKind;
  sourceUrl: string;
  sourceTitle: string;
  sourceNote: string;
};

const officialEvidenceHosts: Record<Exclude<SecurityRightsEvidenceKind, "issuer_official_disclosure">, string[]> = {
  securities_regulator_filing: ["sec.gov", "cninfo.com.cn", "csrc.gov.cn"],
  official_exchange_disclosure: ["hkexnews.hk", "hkex.com.hk", "sse.com.cn", "szse.cn", "bse.cn"],
  depositary_agreement: ["adr.com", "jpmorgan.com", "citibank.com", "bnymellon.com", "db.com"],
};

/**
 * Rights mappings are manually sourced facts.  This deliberately validates the
 * declared official evidence class but never tries to infer a relationship from
 * names, ticker stems, or a market-data provider response.
 */
export function validateSecurityRightsEvidence(input: SecurityRightsEvidence): SecurityRightsEvidence {
  if (!SECURITY_RIGHTS_EVIDENCE_KINDS.includes(input.evidenceKind)) throw new Error("unsupported security-rights evidenceKind");
  const sourceTitle = String(input.sourceTitle ?? "").trim();
  const sourceNote = String(input.sourceNote ?? "").trim();
  if (!sourceTitle || !sourceNote) throw new Error("security-rights evidence requires sourceTitle and sourceNote");
  let url: URL;
  try { url = new URL(String(input.sourceUrl ?? "").trim()); }
  catch { throw new Error("security-rights evidence requires an absolute https sourceUrl"); }
  if (url.protocol !== "https:") throw new Error("security-rights evidence requires an https sourceUrl");
  const host = url.hostname.toLowerCase();
  if (input.evidenceKind !== "issuer_official_disclosure") {
    const allowed = officialEvidenceHosts[input.evidenceKind];
    if (!allowed.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
      throw new Error(`${input.evidenceKind} sourceUrl must use an official filing, exchange, or depositary host`);
    }
  }
  return { evidenceKind: input.evidenceKind, sourceUrl: url.toString(), sourceTitle, sourceNote };
}

const rejectedInstrumentTypes = new Set([
  "etf", "fund", "index", "index_fund", "mutual_fund", "closed_end_fund", "open_end_fund",
]);
const equityInstrumentTypes = new Set([
  "stock", "equity", "common_stock", "common_share", "ordinary_share", "h_share",
]);
const knownIndexCodes = new Set(["SPX.US", "DJI.US", "IXIC.US"]);

export function classifyResearchSecurity(input: ResearchSecurityDescriptor): ClassifiedResearchSecurity {
  const code = normalizeSecurityCode(input.code);
  const type = normalizeToken(input.instrumentType);
  const name = String(input.name ?? "").trim();
  if (!code) throw new Error("security code is required");
  if (rejectedInstrumentTypes.has(type) || knownIndexCodes.has(code) || code.startsWith("^") || looksLikeFundOrIndex(name)) {
    throw new Error(`research identity only supports listed company equity securities: ${code}`);
  }
  let market: ResearchMarket;
  if (/^\d{6}\.(SH|SZ|BJ)$/.test(code)) {
    if (/^[15]/.test(code)) {
      throw new Error(`research identity rejects mainland funds and ETFs: ${code}`);
    }
    market = "a_share";
  } else if (/^\d{5}\.HK$/.test(code)) {
    market = "h_share";
  } else if (/^[A-Z0-9.-]+\.US$/.test(code)) {
    market = "us_share";
  } else {
    throw new Error(`unsupported listed company security code: ${code}`);
  }
  const instrumentKind: ResearchInstrumentKind = type === "adr" || type === "depositary_receipt"
    ? "adr"
    : equityInstrumentTypes.has(type) ? "equity" : "unknown";
  return { code, market, instrumentKind, eligibility: instrumentKind === "unknown" ? "needs_review" : "eligible" };
}

export function financialSourcePolicyForMarket(market: ResearchMarket): FinancialSourcePolicy {
  if (market === "a_share") {
    return {
      market,
      primaryProvider: "eastmoney",
      verificationProvider: "cninfo",
      expectedTradingCurrency: "CNY",
      runtimeIntegration: "integrated",
      localAccess: "direct",
      productionAccess: "direct",
      noAutomaticFallback: true,
    };
  }
  if (market === "h_share") {
    return {
      market,
      primaryProvider: "eastmoney",
      verificationProvider: "hkex",
      expectedTradingCurrency: "HKD",
      runtimeIntegration: "integrated",
      localAccess: "direct",
      productionAccess: "direct",
      noAutomaticFallback: true,
    };
  }
  return {
    market,
    primaryProvider: "yahoo",
    verificationProvider: "sec",
    expectedTradingCurrency: "USD",
    // The local Worker reaches Yahoo through the unified HTTP client, whose
    // configured domain proxy routes yahoo.com and its subdomains through the
    // local relay.  This is an implemented primary-source path, not a future
    // provider placeholder; an unavailable request is reported as a source
    // observation/error and must never trigger an alternate-provider fallback.
    runtimeIntegration: "integrated",
    localAccess: "configured_proxy_required",
    productionAccess: "unified_http_direct",
    noAutomaticFallback: true,
  };
}

export function buildFinancialCoverage(
  market: ResearchMarket,
  observations: FinancialAvailabilityObservation[],
): FinancialCoverage {
  const policy = financialSourcePolicyForMarket(market);
  const statements = FINANCIAL_STATEMENT_TYPES.map((statementType) => {
    const primaryObservation = latestObservation(observations, statementType, policy.primaryProvider, "primary_structured");
    const verificationObservation = latestObservation(observations, statementType, policy.verificationProvider, "statutory_verification");
    const status = primaryObservation?.status
      ?? (policy.runtimeIntegration === "integrated" ? "unavailable" : "requires_integration");
    const blockingReason = primaryObservation?.blockingReason
      ?? (policy.runtimeIntegration === "integrated"
        ? `No dated ${statementType} availability observation exists for the selected security.`
        : `${policy.primaryProvider} ${statementType} statements are selected by policy but are not integrated in the current runtime.`);
    return {
      statementType,
      status,
      primaryProvider: policy.primaryProvider,
      verificationProvider: policy.verificationProvider,
      primaryObservation,
      verificationObservation,
      blockingReason: status === "verified_available" ? null : blockingReason,
    } satisfies StatementFinancialAvailability;
  });
  const status = summarizeFinancialCoverage(statements.map((item) => item.status));
  const gaps = statements
    .filter((item) => item.status !== "verified_available")
    .map((item) => `${financialStatementLabel(item.statementType)}：${presentFinancialAvailabilityReason(item.blockingReason ?? item.status)}`);
  return { policy, status, statements, gaps };
}

function financialStatementLabel(statementType: FinancialStatementType): string {
  return ({ income: "利润表", balance: "资产负债表", cashflow: "现金流量表" } satisfies Record<FinancialStatementType, string>)[statementType];
}

/** Keep internal provider diagnostics intact in their observation, but make the
 * cockpit's next-evidence text readable without forcing users to decode field
 * keys or English transport messages. */
function presentFinancialAvailabilityReason(reason: string): string {
  const missing = reason.match(/^([A-Z]+) verification is still missing: (.+)$/);
  if (missing) return `${missing[1]} 法定核验仍缺：${missing[2].split(", ").map(financialMetricLabel).join("、")}`;
  if (/^No dated (income|balance|cashflow) availability observation exists/.test(reason)) return "尚无带日期的主源可得性观测";
  if (reason.includes("Yahoo source reporting currency is conflicting")) return "Yahoo 报告币种冲突，未用交易币种替代";
  if (reason.includes("Yahoo source reporting currency is missing")) return "Yahoo 缺少报告币种，未用交易币种替代";
  if (reason.includes("Yahoo primary statement returned no rows")) return "Yahoo 主源未返回报表行";
  return reason;
}

function financialMetricLabel(metric: string): string {
  return ({ revenue: "收入", net_profit: "净利润", total_equity: "权益", diluted_shares: "期末稀释股数", operating_cash_flow: "经营现金流" } as Record<string, string>)[metric] ?? metric;
}

function latestObservation(
  observations: FinancialAvailabilityObservation[],
  statementType: FinancialStatementType,
  provider: string,
  sourceRole: FinancialSourceRole,
): FinancialAvailabilityObservation | null {
  return observations
    .filter((item) => item.statementType === statementType && item.provider === provider && item.sourceRole === sourceRole)
    .sort((left, right) => right.asOf - left.asOf)[0] ?? null;
}

function summarizeFinancialCoverage(statuses: FinancialAvailabilityStatus[]): FinancialAvailabilityStatus {
  if (statuses.includes("source_unhealthy")) return "source_unhealthy";
  const available = statuses.filter((item) => item === "verified_available").length;
  const partial = statuses.filter((item) => item === "partially_available" || item === "document_only").length;
  if (available === statuses.length) return "verified_available";
  if (available > 0 || partial > 0) return "partially_available";
  if (statuses.includes("requires_integration")) return "requires_integration";
  return "unavailable";
}

function normalizeToken(value: string | null | undefined): string {
  return String(value ?? "").trim().toLocaleLowerCase().replace(/[ -]+/g, "_");
}

function looksLikeFundOrIndex(name: string): boolean {
  if (!name) return false;
  return /ETF/i.test(name)
    || /交易型开放式指数证券投资基金|证券投资基金$|股票指数$/.test(name);
}
