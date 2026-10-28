/**
 * Evidence records for the investment watchlist.
 *
 * The universe JSON used to carry `evidenceRefs: string[]` — free text that no
 * machine could check.  "Evidence exists" therefore meant "someone typed
 * something".  This module turns each reference into a record with a source
 * class, a registry identifier, a publication date and a locator, so a reader
 * (and a validator) can answer three separate questions:
 *
 * 1. Is this a primary source?  Filings, exchange pages and the issuer's own IR
 *    page are `primary`.  A news article is `secondary` and never counts as
 *    evidence for a fact.
 * 2. Which security does it describe?  A CNINFO filing is about the A-share
 *    line; it says nothing about the H-share line's identity, rights or
 *    depositary ratio.  Claims are therefore bound to one security.
 * 3. Is it the latest one?  `lastEvidenceDate` is derived from the records, so
 *    it cannot drift away from what was actually collected.
 *
 * Rules enforced here, not documented away:
 * - `kind: "secondary"` (news, rumours, reposts) is rejected outright.  The TODO
 *   says news must be marked "pending primary verification"; the honest place
 *   for it is not inside the evidence array at all.
 * - A primary record must carry a registry identifier AND a URL AND a date.
 * - A credential-free check function decides whether a set of records is enough
 *   to call a security identity-verified.
 */

export type EvidenceSource =
  | "cninfo_filing"
  | "hkex_filing"
  | "sec_filing"
  | "sse_filing"
  | "szse_filing"
  | "issuer_ir"
  | "exchange_quote";

export type EvidenceKind = "primary" | "secondary";

export type EvidenceRecord = {
  source: EvidenceSource;
  kind: EvidenceKind;
  /**
   * Security this record speaks about.  A CNINFO filing on 600036.SH is about
   * the A-share line only; it does not verify 03968.HK.
   */
  security: string;
  /** Registry-native document id (公告号 / accession number / HKEX news id). */
  documentId: string;
  title: string;
  /** ISO date (`YYYY-MM-DD`) the registry published it. */
  publishedAt: string;
  url: string;
};

export type EvidenceValidation = {
  ok: boolean;
  /** Machine-readable failure codes so a validator can report them in bulk. */
  problems: string[];
};

const PRIMARY_SOURCES = new Set<EvidenceSource>([
  "cninfo_filing",
  "hkex_filing",
  "sec_filing",
  "sse_filing",
  "szse_filing",
  "issuer_ir",
  "exchange_quote",
]);

/**
 * Sources that identify the *issuer behind a security code*.  A quote page
 * confirms the ticker trades, not which legal entity it is; an IR page is the
 * issuer's own statement of identity.
 */
const IDENTITY_SOURCES = new Set<EvidenceSource>(["cninfo_filing", "hkex_filing", "sec_filing", "sse_filing", "szse_filing", "issuer_ir"]);

const URL_HOSTS: Record<EvidenceSource, RegExp | null> = {
  cninfo_filing: /(^|\.)cninfo\.com\.cn$/,
  hkex_filing: /(^|\.)hkexnews\.hk$/,
  sec_filing: /(^|\.)sec\.gov$/,
  sse_filing: /(^|\.)sse\.com\.cn$/,
  szse_filing: /(^|\.)szse\.cn$/,
  issuer_ir: null,
  exchange_quote: null,
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function validateEvidenceRecord(record: unknown): EvidenceValidation {
  const problems: string[] = [];
  if (!record || typeof record !== "object") return { ok: false, problems: ["not_an_object"] };
  const item = record as Partial<EvidenceRecord>;
  if (!item.source || !PRIMARY_SOURCES.has(item.source)) problems.push("unknown_source");
  if (item.kind !== "primary") problems.push("secondary_source_rejected");
  if (typeof item.security !== "string" || !item.security.trim()) problems.push("missing_security");
  if (typeof item.documentId !== "string" || !item.documentId.trim()) problems.push("missing_document_id");
  if (typeof item.title !== "string" || !item.title.trim()) problems.push("missing_title");
  if (typeof item.publishedAt !== "string" || !ISO_DATE.test(item.publishedAt)) problems.push("invalid_published_at");
  if (typeof item.url !== "string" || !/^https:\/\//.test(item.url)) {
    problems.push("invalid_url");
  } else if (item.source && URL_HOSTS[item.source]) {
    let host = "";
    try {
      host = new URL(item.url).hostname.toLowerCase();
    } catch {
      problems.push("unparsable_url");
    }
    if (host && URL_HOSTS[item.source] && !URL_HOSTS[item.source]!.test(host)) problems.push("url_host_mismatch");
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Can this security be marked `identityVerified`?
 *
 * One filing is enough: a statutory filing carries the issuer's legal name and
 * the registry's own mapping to the security code.  But it must be for *this*
 * security — the A-share filing never verifies the H-share line.
 */
export function canVerifyIdentity(security: string, records: EvidenceRecord[]): EvidenceValidation {
  const forSecurity = records.filter((record) => record.security === security);
  if (forSecurity.length === 0) return { ok: false, problems: ["no_evidence_for_security"] };
  const invalid = forSecurity.map(validateEvidenceRecord).filter((result) => !result.ok);
  if (invalid.length > 0) return { ok: false, problems: [...new Set(invalid.flatMap((result) => result.problems))] };
  if (!forSecurity.some((record) => IDENTITY_SOURCES.has(record.source))) {
    // A quote page proves the ticker is quoted; it does not prove which entity.
    return { ok: false, problems: ["no_identity_source"] };
  }
  return { ok: true, problems: [] };
}

/** Newest publication date among valid records, or null. Reply for `lastEvidenceDate`. */
export function latestEvidenceDate(records: EvidenceRecord[]): string | null {
  const dates = records
    .filter((record) => validateEvidenceRecord(record).ok)
    .map((record) => record.publishedAt)
    .sort();
  return dates.length > 0 ? dates[dates.length - 1] : null;
}

/**
 * Every security of a company, mapped to whether its identity can be verified
 * and why not.  This is the acceptance surface for P2-1: a multi-listed company
 * shows an A-share line verified and an H-share line pending, instead of one
 * boolean implying both.
 */
export function identityReport(
  securities: string[],
  records: EvidenceRecord[],
): Array<{ security: string; verified: boolean; problems: string[] }> {
  return securities.map((security) => {
    const result = canVerifyIdentity(security, records);
    return { security, verified: result.ok, problems: result.problems };
  });
}

/**
 * Evidence coverage for a company record.  `minimum` describes the smallest
 * defensible set: the latest filed periodic report for each listed security.
 * A company with no filing for one of its lines is reported as partial, never
 * rounded up.
 */
export function evidenceCoverage(
  securities: string[],
  records: EvidenceRecord[],
): { covered: string[]; missing: string[]; total: number } {
  const covered = securities.filter((security) => canVerifyIdentity(security, records).ok);
  const missing = securities.filter((security) => !covered.includes(security));
  return { covered, missing, total: securities.length };
}
