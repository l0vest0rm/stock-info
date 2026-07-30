import type { MacroSourceHealth } from "./types";

export type MacroSourceErrorCode =
  | "missing_credential"
  | "invalid_request"
  | "timeout"
  | "http_error"
  | "invalid_response";

export class MacroSourceError extends Error {
  constructor(
    public readonly sourceId: string,
    public readonly code: MacroSourceErrorCode,
    message: string,
    public readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MacroSourceError";
  }
}

export function requireCredential(sourceId: string, value: string | undefined, label: string): string {
  const credential = value?.trim();
  if (!credential) {
    throw new MacroSourceError(sourceId, "missing_credential", `${label} is not configured`, false);
  }
  return credential;
}

export function sourceHealthFromError(error: MacroSourceError, checkedAt = new Date().toISOString()): MacroSourceHealth {
  return {
    sourceId: error.sourceId,
    state: error.code === "missing_credential" ? "not_configured" : "unavailable",
    checkedAt,
    observationCount: 0,
    message: error.message,
  };
}
