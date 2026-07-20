import { fetchEastmoneySuggest } from "../../../adapters/eastmoney";
import { findSecurity, searchLocalSecurities, upsertSecurity } from "../../../db/queries";
import { isSupportedCompanyCode, normalizeSecurityCode } from "../../../shared/codes";
import type { ExternalHttpOptions } from "../../../shared/http";
import type { SecurityRecord } from "../../../types";

export async function searchSecurities(
  db: D1Database,
  q: string,
  _options?: { httpOptions?: ExternalHttpOptions }
): Promise<SecurityRecord[]> {
  const trimmed = q.trim();
  if (!trimmed) {
    return [];
  }
  const local = (await searchLocalSecurities(db, trimmed)).map(normalizeSearchRecord);
  const remote = await fetchEastmoneySuggest(db, trimmed).catch((err) => {
    if (local.length === 0) {
      throw err;
    }
    console.warn(`eastmoney suggest unavailable for ${trimmed}:`, err);
    return [] as SecurityRecord[];
  });
  const merged = mergeSecurityResults(local, remote);
  for (const item of remote) {
    await upsertSecurity(db, item);
  }
  return merged;
}

export async function getSecurity(
  db: D1Database,
  code: string,
  _options?: { httpOptions?: ExternalHttpOptions }
): Promise<SecurityRecord | null> {
  const normalized = normalizeSecurityCode(code);
  const local = await findSecurity(db, normalized);
  if (local) {
    return local;
  }
  const query = normalized.split(".")[0] ?? normalized;
  const remote = await fetchEastmoneySuggest(db, query).catch(() => []);
  const match = remote.find((item) => item.code === normalized) ?? remote[0] ?? null;
  if (match) {
    await upsertSecurity(db, match);
  }
  return match;
}

function mergeSecurityResults(...groups: SecurityRecord[][]): SecurityRecord[] {
  const seen = new Set<string>();
  const result: SecurityRecord[] = [];
  for (const group of groups) {
    for (const item of group) {
      const normalized = normalizeSearchRecord(item);
      if (!isSupportedCompanyCode(normalized.code) || seen.has(normalized.code)) {
        continue;
      }
      seen.add(normalized.code);
      result.push(normalized);
    }
  }
  return result.slice(0, 12);
}

function normalizeSearchRecord(record: SecurityRecord): SecurityRecord {
  const match = record.code.match(/^US(.+)$/i);
  if (!match || record.code.includes(".")) {
    return record;
  }
  const code = `${match[1].toUpperCase()}.US`;
  return {
    ...record,
    code,
    market: "global",
    type: "stock",
  };
}
