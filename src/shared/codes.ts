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
  return isSupportedCompanyCode(normalized) || /^\d{6}\.(OF|SF|ZF)$/.test(normalized);
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
    case "OF":
      return "fund";
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
