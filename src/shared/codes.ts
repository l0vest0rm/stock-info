export function normalizeSecurityCode(input: string): string {
  const raw = input.trim().toUpperCase();
  if (!raw) {
    return "";
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
  if (normalized.endsWith(".OF")) {
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
  return null;
}

export function bareCode(code: string): string {
  return normalizeSecurityCode(code).split(".")[0] ?? "";
}

export function securitySuffix(code: string): string {
  return normalizeSecurityCode(code).split(".")[1] ?? "";
}
