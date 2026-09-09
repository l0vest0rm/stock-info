


export function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function normalizeCompanyReportDate(value: string): string {
  const raw = value.trim();
  const match = raw.match(/^(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (match) {
    const month = match[2].padStart(2, "0");
    const day = match[3].padStart(2, "0");
    const iso = `${match[1]}-${month}-${day}`;
    return Number.isFinite(Date.parse(iso)) ? iso : "";
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : "";
}

export function parseJsonObjectFromText(value: string): Record<string, unknown> | null {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    const parsed = JSON.parse(value.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function parseJsonArrayFromText(value: string): unknown[] | null {
  try {
    const parsed = JSON.parse(value.trim());
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function trimText(value: string, maxChars: number): string {
  return value.trim().slice(0, Math.max(0, maxChars));
}

export function numberOrUndefined(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : Number(String(value).replaceAll(",", "").replace(/%$/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function positiveNumberOrUndefined(value: unknown): number | undefined {
  const parsed = numberOrUndefined(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

export function nonEmptyTextOrUndefined(value: unknown): string | undefined {
  const normalized = text(value);
  return normalized ? normalized : undefined;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function firstNonEmpty(values: string[]): string {
  return values.find((value) => value.trim()) ?? "";
}

export function text(value: unknown): string {
  return String(value ?? "").trim();
}
