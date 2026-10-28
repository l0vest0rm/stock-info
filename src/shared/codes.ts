export function normalizeSecurityCode(input: string): string {
  const raw = input.trim().toUpperCase();
  if (!raw) {
    return "";
  }
  const compactKorea = raw.match(/^(\d{6})(KS|KQ)$/);
  if (compactKorea) {
    return `${compactKorea[1]}.${compactKorea[2]}`;
  }
  const malformedKorea = raw.match(/^(\d{6})(KS|KQ)\.(SH|SZ)$/);
  if (malformedKorea) {
    return `${malformedKorea[1]}.${malformedKorea[2]}`;
  }
  if (raw.includes(".")) {
    return raw;
  }
  if (/^\d{6}$/.test(raw)) {
    if (raw.startsWith("5") || raw.startsWith("6") || raw.startsWith("9")) {
      return `${raw}.SH`;
    }
    if (raw.startsWith("0") || raw.startsWith("1") || raw.startsWith("2") || raw.startsWith("3")) {
      return `${raw}.SZ`;
    }
  }
  if (/^\d{5}$/.test(raw)) {
    return `${raw}.HK`;
  }
  return raw;
}

export function isSupportedCompanyCode(input: string): boolean {
  const normalized = normalizeSecurityCode(input);
  return /^\d{6}\.(SH|SZ|BJ)$/.test(normalized)
    || /^\d{5}\.HK$/.test(normalized)
    || /^[A-Z0-9.-]+\.US$/.test(normalized);
}

export function isSupportedSecurityCode(input: string): boolean {
  const normalized = normalizeSecurityCode(input);
  return isSupportedCompanyCode(normalized)
    || /^\d{6}\.(OF|SF|ZF|KS|KQ)$/.test(normalized)
    || normalized === "KS11.UI"
    || normalized === "HSI.HK";
}

export function normalizeSupportedCompanyCode(input: string): string {
  const raw = input.trim().toUpperCase();
  if (!raw) {
    return "";
  }
  const usMatch = raw.match(/^US([A-Z0-9.-]+)\.(?:OQ|NQ|N|AMEX|PK|OB)$/);
  if (usMatch) {
    return `${usMatch[1]}.US`;
  }
  const prefixedMatch = raw.match(/^(SH|SZ|BJ)(\d{6})$/);
  if (prefixedMatch) {
    return `${prefixedMatch[2]}.${prefixedMatch[1]}`;
  }
  const hkPrefixedMatch = raw.match(/^HK(\d{5})$/);
  if (hkPrefixedMatch) {
    return `${hkPrefixedMatch[1]}.HK`;
  }
  const normalized = normalizeSecurityCode(raw);
  return isSupportedCompanyCode(normalized) ? normalized : "";
}

export function securityMarket(code: string): string {
  const normalized = normalizeSecurityCode(code);
  const suffix = normalized.split(".").pop() ?? "";
  switch (suffix) {
    case "SH":
      return "cn-sh";
    case "SZ":
      return "cn-sz";
    case "BJ":
      return "cn-bj";
    case "HK":
      return "hk";
    case "US":
      return "us";
    case "OF":
      return "fund";
    case "UI":
      return normalized === "KS11.UI" ? "kr" : "global";
    default:
      return "global";
  }
}

export function inferSecurityType(code: string): string {
  const normalized = normalizeSecurityCode(code);
  if (normalized.endsWith(".OF") || normalized.endsWith(".SF") || normalized.endsWith(".ZF")) {
    return "fund";
  }
  if (/^\d{6}\.(SH|SZ|BJ)$/.test(normalized)) {
    const base = normalized.slice(0, 6);
    if (base.startsWith("5") || base.startsWith("1")) {
      return "fund";
    }
    return "stock";
  }
  return "stock";
}

export function eastmoneySecId(code: string): string | null {
  const normalized = normalizeSecurityCode(code);
  if (normalized === "SPX.US") {
    return "100.SPX";
  }
  if (normalized === "HSI.HK") {
    return "100.HSI";
  }
  if (normalized === "KS11.UI") {
    return "100.KS11";
  }
  const [base, suffix] = normalized.split(".");
  if (!base || !suffix) {
    return null;
  }
  if (suffix === "SH") {
    return `1.${base}`;
  }
  if (suffix === "SZ") {
    return `0.${base}`;
  }
  if (suffix === "BJ") {
    return `0.${base}`;
  }
  if (suffix === "HK") {
    return `116.${base}`;
  }
  if (suffix === "US") {
    return `105.${base}`;
  }
  return null;
}

export function bareCode(code: string): string {
  return normalizeSecurityCode(code).split(".")[0] ?? "";
}

export function securitySuffix(code: string): string {
  return normalizeSecurityCode(code).split(".")[1] ?? "";
}

/**
 * Do two security strings name the same listing?
 *
 * The watchlist stores the exchange's own symbol (`NVDA`) while the internal
 * API stores a normalized code (`NVDA.US`); other codes are already suffixed on
 * both sides (`600036.SH`).  Comparing them literally is therefore wrong in one
 * direction only, and it fails silently: `companyValuationArchetype("NVDA.US")`
 * returned `null`, so all 15 US companies fell through to the generic `other`
 * profile and lost their method-specific bands.
 *
 * The rule is deliberately narrow — an unsuffixed symbol only equals the `.US`
 * form, because that is the one market whose native symbols carry no suffix.
 * An A-share or HK code is never inferred from a bare number here; that would
 * turn `00700` into an A-share and make a listing comparison a guess.
 */
export function sameSecurity(left: string, right: string): boolean {
  const a = normalizeSecurityCode(left);
  const b = normalizeSecurityCode(right);
  if (!a || !b) return false;
  if (a === b) return true;
  return a === `${b}.US` || b === `${a}.US`;
}
