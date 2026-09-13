import { getKvCacheByLegacyKey } from "../db/queries";
import { isSupportedCompanyCode, normalizeSecurityCode } from "./codes";
import { validateFinancialMarkdown } from "../modules/research/application/research-financial-analysis";
import { validateResearchInvestmentAnalysisMarkdown } from "../modules/research/application/research-investment-analysis";
import { validateMacroAnalysisMarkdown } from "../modules/macro/application/macro-analysis";
import { COMPANY_REPORT_DISCOVERY_NAMESPACE, REPORT_SOURCE_CACHE_VERSION } from "../modules/company/domain/report-policy";
import type { Bindings } from "../types";

const MAX_RECORD_BYTES = 700_000;
const REPORT_NAMESPACES = new Set(["research_investment_analysis", "research_financial_analysis", "macro_analysis", COMPANY_REPORT_DISCOVERY_NAMESPACE]);
const SOURCE_NAMESPACE = "company_reports_source";

export type RemoteReportSyncRecord = {
  namespace: string;
  key: string;
  valueJson: string;
  expiresAt: number | null;
  updatedAt: number;
};

/**
 * Local taskd/LLM work never executes in the Worker.  It may publish only a
 * validated, already materialized read model through this authenticated path.
 */
export async function publishCompletedReportsToProduction(env: Bindings): Promise<{ attempted: number; published: number; skipped: number }> {
  if (env.LLM_RUNTIME !== "local") return { attempted: 0, published: 0, skipped: 0 };
  if (!String(env.PRODUCTION_REPORT_SYNC_URL || "").trim() || !String(env.REPORT_SYNC_TOKEN || "").trim()) {
    // A missing deployment secret must not poison otherwise healthy local
    // taskd reconciliation every 15 seconds. Once configured, the next tick
    // publishes the durable completed projections automatically.
    return { attempted: 0, published: 0, skipped: 1 };
  }
  const records = await completedLocalReportRecords(env);
  let published = 0;
  for (const record of records) {
    await publishRecord(env, record);
    published += 1;
  }
  return { attempted: records.length, published, skipped: 0 };
}

/** Verify and persist a local read model in production; it performs no taskd or LLM call. */
export async function acceptPublishedReport(db: Bindings["DB"], record: unknown): Promise<RemoteReportSyncRecord> {
  const valid = validateRecord(record);
  // Delivery is at-least-once: delayed retries must never replace a newer
  // remote read model with an older local projection.
  await db.prepare(`insert into kv_cache (namespace, key, value_json, expires_at, updated_at)
    values (?, ?, ?, ?, ?) on conflict(namespace, key) do update set
      value_json = excluded.value_json, expires_at = excluded.expires_at, updated_at = excluded.updated_at
    where excluded.updated_at >= kv_cache.updated_at`)
    .bind(valid.namespace, valid.key, valid.valueJson, valid.namespace === SOURCE_NAMESPACE ? valid.expiresAt : null, valid.updatedAt).run();
  return valid;
}

export function reportSyncTokenMatches(expected: string | undefined, supplied: string | undefined): boolean {
  if (!expected || !supplied || expected.length !== supplied.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= expected.charCodeAt(index) ^ supplied.charCodeAt(index);
  return difference === 0;
}

async function completedLocalReportRecords(env: Bindings): Promise<RemoteReportSyncRecord[]> {
  const rows = await env.DB.prepare(`select namespace, key, value_json as valueJson, expires_at as expiresAt, updated_at as updatedAt
    from kv_cache where namespace in (?, ?, ?, ?) and expires_at is null order by updated_at asc`)
    .bind("research_investment_analysis", "research_financial_analysis", "macro_analysis", COMPANY_REPORT_DISCOVERY_NAMESPACE)
    .all<RemoteReportSyncRecord>();
  const records: RemoteReportSyncRecord[] = [];
  for (const row of rows.results) {
    try {
      const report = validateRecord({ ...row, expiresAt: null });
      records.push(report);
      if (report.namespace === COMPANY_REPORT_DISCOVERY_NAMESPACE) {
        const sourceKey = `company-reports-source:${REPORT_SOURCE_CACHE_VERSION}:${report.key}`;
        const source = await getKvCacheByLegacyKey(env.DB, sourceKey);
        if (source) records.push(validateRecord({ namespace: SOURCE_NAMESPACE, key: sourceKey, ...source }));
      }
    } catch {
      // Pending, failed, malformed, and legacy records remain local.  Only a
      // complete report is eligible for publication.
    }
  }
  return records;
}

async function publishRecord(env: Bindings, record: RemoteReportSyncRecord): Promise<void> {
  const endpoint = String(env.PRODUCTION_REPORT_SYNC_URL || "").trim();
  const token = String(env.REPORT_SYNC_TOKEN || "").trim();
  if (!endpoint || !token) throw new Error("PRODUCTION_REPORT_SYNC_URL and REPORT_SYNC_TOKEN are required to publish local reports");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "authorization": `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ record }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`production report sync failed: HTTP ${response.status}`);
  const body = await response.json().catch(() => null) as { code?: number; msg?: string } | null;
  if (body?.code !== 200) throw new Error(body?.msg || "production report sync returned an invalid response");
}

function validateRecord(value: unknown): RemoteReportSyncRecord {
  const row = object(value);
  const namespace = string(row?.namespace);
  // Report identities are normalized security codes, while the legacy source
  // cache key has a case-sensitive namespace prefix. Do not uppercase the
  // latter before its prefix contract is verified.
  const rawKey = string(row?.key);
  const key = namespace === SOURCE_NAMESPACE ? rawKey : rawKey.toUpperCase();
  const valueJson = string(row?.valueJson);
  const updatedAt = Number(row?.updatedAt);
  const expiresAt = row?.expiresAt === null || row?.expiresAt === undefined ? null : Number(row.expiresAt);
  if ((!REPORT_NAMESPACES.has(namespace) && namespace !== SOURCE_NAMESPACE) || !key || !valueJson || new TextEncoder().encode(valueJson).byteLength > MAX_RECORD_BYTES || !Number.isFinite(updatedAt)) {
    throw new Error("invalid published report record");
  }
  if (expiresAt !== null && !Number.isFinite(expiresAt)) throw new Error("invalid published report expiry");
  const parsed = parseJson(valueJson);
  if (namespace === "macro_analysis") {
    if (key !== "GLOBAL") throw new Error("macro report key must be GLOBAL");
    validateMarkdown(parsed, validateMacroAnalysisMarkdown);
  } else if (namespace === "research_investment_analysis") {
    validateCompanyKey(key);
    validateMarkdown(parsed, validateResearchInvestmentAnalysisMarkdown);
  } else if (namespace === "research_financial_analysis") {
    validateCompanyKey(key);
    validateMarkdown(parsed, validateFinancialMarkdown);
  } else if (namespace === COMPANY_REPORT_DISCOVERY_NAMESPACE) {
    validateCompanyKey(key);
    validateDiscovery(parsed, key);
  } else {
    validateCompanySource(parsed, key, expiresAt);
  }
  return { namespace, key, valueJson, expiresAt, updatedAt };
}

function validateMarkdown(value: unknown, validate: (markdown: string) => void): void {
  const markdown = string(object(value)?.markdown);
  const projectedAt = Number(object(value)?.projectedAt);
  if (!markdown || !Number.isFinite(projectedAt)) throw new Error("published report must be a completed projection");
  validate(markdown);
}

function validateDiscovery(value: unknown, key: string): void {
  const row = object(value);
  const report = object(row?.report);
  const response = object(report?.response);
  const projection = object(report?.projection);
  if (!string(response?.text) || string(projection?.securityCode).toUpperCase() !== key || !Number.isFinite(Number(projection?.cachedAt))) {
    throw new Error("published report discovery is incomplete");
  }
}

function validateCompanySource(value: unknown, key: string, expiresAt: number | null): void {
  const match = new RegExp(`^company-reports-source:${REPORT_SOURCE_CACHE_VERSION}:([A-Z0-9.]+)$`).exec(key);
  if (!match || !Array.isArray(value) || expiresAt === null || expiresAt <= Date.now()) throw new Error("invalid published company report source cache");
  validateCompanyKey(match[1]);
}

function validateCompanyKey(key: string): void {
  const normalized = normalizeSecurityCode(key);
  if (!isSupportedCompanyCode(normalized) || normalized !== key) throw new Error("invalid published company security code");
}
function object(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function string(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function parseJson(value: string): unknown { try { return JSON.parse(value); } catch { throw new Error("published report valueJson is not JSON"); } }
