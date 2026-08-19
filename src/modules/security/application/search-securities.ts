import { fetchEastmoneySuggest } from "../../../adapters/eastmoney";
import { isSupportedSecurityCode, normalizeSecurityCode } from "../../../shared/codes";
import type { SecurityRecord } from "../../../types";

export async function searchSecurities(db: D1Database, q: string): Promise<SecurityRecord[]> {
  const trimmed = q.trim();
  if (!trimmed) {
    return [];
  }
  return mergeSecurityResults(await fetchEastmoneySuggest(db, trimmed));
}

export async function getSecurity(db: D1Database, code: string): Promise<SecurityRecord | null> {
  const normalized = normalizeSecurityCode(code);
  const query = normalized.split(".")[0] ?? normalized;
  const remote = await fetchEastmoneySuggest(db, query);
  return remote.find((item) => normalizeSecurityCode(item.code) === normalized) ?? null;
}

function mergeSecurityResults(...groups: SecurityRecord[][]): SecurityRecord[] {
  const seen = new Set<string>();
  const result: SecurityRecord[] = [];
  for (const group of groups) {
    for (const item of group) {
      const normalized = normalizeSearchRecord(item);
      if (!isSupportedSecurityCode(normalized.code) || seen.has(normalized.code)) {
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
