import { normalizeSecurityCode } from "../../../shared/codes";

export type FinancialStatementProvider = "eastmoney" | "yahoo";
export type FinancialStatementSourceAvailability = "available" | "source_unavailable" | "unsupported_security";

/**
 * The selected structured provider is deliberately a routing rule, rather than
 * a retry order.  A source failure must remain visible to research consumers;
 * it must not silently change the accounting source for a security.
 */
export type FinancialStatementSource = {
  code: string;
  provider: FinancialStatementProvider | null;
  availability: FinancialStatementSourceAvailability;
  statutoryVerificationSource: string | null;
  reason: string | null;
};

export function resolveFinancialStatementSource(rawCode: string): FinancialStatementSource {
  const code = normalizeSecurityCode(rawCode);
  if (/\.(SH|SZ|BJ)$/.test(code)) {
    return {
      code,
      provider: "eastmoney",
      availability: "available",
      statutoryVerificationSource: "issuer periodic report and exchange/CNINFO disclosure",
      reason: null,
    };
  }
  if (/\.HK$/.test(code)) {
    return {
      code,
      provider: "eastmoney",
      // Hong Kong statements use Eastmoney's HK F10 main-indicator contract,
      // not the A-share RPT_F10_FINANCE_* endpoint.  The adapter preserves
      // the original HK field names and attaches auditable canonical aliases.
      availability: "available",
      statutoryVerificationSource: "HKEXnews periodic report, interim report, or results announcement",
      reason: null,
    };
  }
  if (/\.US$/.test(code)) {
    return {
      code,
      provider: "yahoo",
      availability: "available",
      statutoryVerificationSource: "SEC EDGAR filing or issuer investor-relations filing",
      reason: null,
    };
  }
  return {
    code,
    provider: null,
    availability: "unsupported_security",
    statutoryVerificationSource: null,
    reason: "Financial statements support A-share, Hong Kong, and U.S. listed-security codes only.",
  };
}
