import { fetchEastmoneySuggest } from "../adapters/eastmoney";
import { findSecurity, searchLocalSecurities, upsertSecurity } from "../db/queries";
import { normalizeSecurityCode } from "../shared/codes";
import type { SecurityRecord } from "../types";

export async function searchSecurities(db: D1Database, q: string): Promise<SecurityRecord[]> {
  const trimmed = q.trim();
  if (!trimmed) {
    return [];
  }
  const local = await searchLocalSecurities(db, trimmed);
  if (local.length > 0) {
    return local;
  }
  const remote = await fetchEastmoneySuggest(trimmed);
  for (const item of remote) {
    await upsertSecurity(db, item);
  }
  return remote;
}

export async function getSecurity(db: D1Database, code: string): Promise<SecurityRecord | null> {
  const normalized = normalizeSecurityCode(code);
  const local = await findSecurity(db, normalized);
  if (local) {
    return local;
  }
  const remote = await fetchEastmoneySuggest(normalized.split(".")[0] ?? normalized);
  const match = remote.find((item) => item.code === normalized) ?? remote[0] ?? null;
  if (match) {
    await upsertSecurity(db, match);
  }
  return match;
}
