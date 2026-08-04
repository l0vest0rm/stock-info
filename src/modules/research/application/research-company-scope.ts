/**
 * Shared write-side scope guard for company-level research records. A code
 * alone is not enough: provisional, unresolved, and conflicting mappings may
 * stay readable but cannot anchor a new company fact.
 */
export type ConfirmedSecurityCompanyScope = { securityCode: string; companyId: string };

export async function requireConfirmedSecurityCompanyScope(
  db: D1Database,
  securityCode: string,
  subject = "company-level research write",
): Promise<ConfirmedSecurityCompanyScope> {
  const code = required(securityCode, "securityCode").toUpperCase();
  const row = await db.prepare(`select security_code as securityCode, company_id as companyId
    from research_listed_securities where security_code=? and mapping_status='confirmed'`)
    .bind(code).first<{ securityCode: string; companyId: string | null }>();
  if (!row?.companyId) throw new Error(`${subject} requires a confirmed security-to-operating-company mapping`);
  return { securityCode: required(row.securityCode, "stored securityCode"), companyId: required(row.companyId, "stored companyId") };
}

function required(value: unknown, label: string): string {
  const result = String(value ?? "").trim();
  if (!result) throw new Error(`${label} is required`);
  return result;
}
