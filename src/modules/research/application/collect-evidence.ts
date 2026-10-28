/**
 * Collect watchlist evidence from primary registries.
 *
 * Sources are the ones the repository already integrates:
 * - CNINFO          for SH / SZ / BJ filings
 * - HKEX news       for HK filings (12-month search window per request)
 * - SEC EDGAR       for US registrants
 *
 * What this deliberately does *not* do:
 * - it never treats a news article, a repost or a broker note as evidence;
 * - it never marks a security verified because a *sibling* security of the same
 *   issuer was verified — an A-share filing says nothing about the H-share
 *   line's rights, and passing that through would be the exact silent
 *   equivalence the universe rules forbid;
 * - it never guesses.  A registry that fails is reported with its failure code
 *   and the security stays unverified.
 */
import { cninfoNoticesToStatutoryDocuments, fetchStatutoryDisclosureIndex, statutoryRegistryForSecurity } from "../../../adapters/statutory-disclosures";
import { fetchCninfoPeriodicReports } from "../../../adapters/cninfo";
import { normalizeSecurityCode, securitySuffix } from "../../../shared/codes";
import { externalHttpOptions, type ExternalHttpOptions } from "../../../shared/http";
import type { Bindings } from "../../../types";
import type { EvidenceRecord } from "../domain/evidence-record";
import { loadSecRegistrantIndex, secFilingUrl } from "../adapters/sec-xbrl";

type Environment = Pick<Bindings, "DB" | "MARKET_DATA_BUCKET">;

export type EvidenceCollectionStatus = "collected" | "no_documents" | "unsupported" | "source_failed";

export type EvidenceCollection = {
  security: string;
  status: EvidenceCollectionStatus;
  /** Registry used, or null when the market has no supported primary registry. */
  registry: "cninfo" | "hkex" | "sec" | null;
  records: EvidenceRecord[];
  /** Failure code from the registry when `status === "source_failed"`. */
  failure: string | null;
};

/**
 * Periodic report titles.  We only keep a filing whose title identifies it as a
 * periodic financial report, because that is what the minimum evidence set is:
 * "the latest filed financial statement", not "any announcement".
 */
const PERIODIC_REPORT = /(年度报告|半年度报告|[第]?[一二三四五六]?季度报告|annual report|interim report|quarterly report|form 10-k|form 20-f|form 10-q)/i;

/**
 * SEC statutory periodic-report forms.
 *
 * 10-K/10-Q are domestic filers, 20-F/40-F are foreign private issuers — both
 * are the issuer's own audited periodic filing, which is what identity evidence
 * is.  8-K/6-K (current reports) and ownership forms are deliberately excluded:
 * they carry no full-period financial statements.
 */
const SEC_PERIODIC_FORMS = /^(10-K|10-Q|20-F|40-F)(\/A)?$/i;

export async function collectSecurityEvidence(
  env: Environment,
  rawCode: string,
  options?: { httpOptions?: ExternalHttpOptions },
): Promise<EvidenceCollection> {
  const security = normalizeSecurityCode(rawCode);
  const httpOptions = options?.httpOptions ?? externalHttpOptions(env);
  const suffix = securitySuffix(security);

  if (["SH", "SZ", "BJ"].includes(suffix)) {
    return collectCninfo(env, security, httpOptions);
  }
  if (suffix === "HK") {
    return collectHkex(env, security, httpOptions);
  }
  if (suffix === "US") {
    return collectSec(env, security, httpOptions);
  }
  return { security, status: "unsupported", registry: null, records: [], failure: "unsupported_security" };
}

async function collectCninfo(env: Environment, security: string, httpOptions: ExternalHttpOptions): Promise<EvidenceCollection> {
  try {
    // Ask the registry for its periodic-report categories rather than filtering
    // the announcement feed: the feed is recency-ordered, so a report can sit
    // thousands of items deep, and titles are not uniform ("2026年三季度报告"
    // has no 第, which a 第[一二三四]季度报告 pattern misses).
    const notices = await fetchCninfoPeriodicReports(env.DB, security);
    const records: EvidenceRecord[] = [];
    for (const notice of cninfoNoticesToStatutoryDocuments(security, notices)) {
      const { documentId, title, publishedAt, documentUrl: url } = notice;
      if (!PERIODIC_REPORT.test(title)) continue;
      records.push({
        source: "cninfo_filing",
        kind: "primary",
        security,
        documentId,
        title,
        publishedAt,
        url,
      });
    }
    return { security, status: records.length ? "collected" : "no_documents", registry: "cninfo", records, failure: null };
  } catch (error) {
    return { security, status: "source_failed", registry: "cninfo", records: [], failure: errorMessage(error) };
  }
}

async function collectHkex(env: Environment, security: string, httpOptions: ExternalHttpOptions): Promise<EvidenceCollection> {
  // HKEX's title search is limited to a 12-month window per request, so ask for
  // the window that contains a recent annual/interim filing.
  const today = new Date();
  const from = new Date(today.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const index = await fetchStatutoryDisclosureIndex(env.DB, security, {
    fromDate: from,
    toDate: today.toISOString().slice(0, 10),
    pageSize: 100,
    httpOptions,
  }).catch(() => null);
  if (!index) return { security, status: "source_failed", registry: "hkex", records: [], failure: "upstream_request_failed" };
  if (index.availability !== "available") {
    return {
      security,
      status: index.availability === "not_found" ? "no_documents" : "source_failed",
      registry: "hkex",
      records: [],
      failure: index.failure?.code ?? null,
    };
  }
  const records: EvidenceRecord[] = index.documents
    .filter((document) => PERIODIC_REPORT.test(document.title))
    .map((document) => ({
      source: "hkex_filing" as const,
      kind: "primary" as const,
      security,
      documentId: document.documentId,
      title: document.title,
      publishedAt: document.publishedAt.slice(0, 10),
      url: document.documentUrl,
    }));
  return { security, status: records.length ? "collected" : "no_documents", registry: "hkex", records, failure: null };
}

/**
 * SEC EDGAR filing index for a US registrant.
 *
 * Only the filing index is read — the issuer's own statutory filings. No
 * financial figures are taken from here: statements keep coming from their
 * normal loader, so this cannot become a second, divergent financial source.
 * Company facts are also deliberately skipped; they are a bulk XBRL document
 * that usually exceeds the small HTTP cache and would be re-downloaded to
 * answer a question that only needs dates and accession numbers.
 */
async function collectSec(env: Environment, security: string, httpOptions: ExternalHttpOptions): Promise<EvidenceCollection> {
  // The SEC loader expects the `.US`-suffixed security code, not a bare ticker.
  const secCode = /\.US$/i.test(security) ? security : `${security}.US`;
  try {
    const registrant = await loadSecRegistrantIndex(env.DB, secCode, httpOptions);
    // Form sets are read from the index rather than `secRegistrantDocuments`:
    // a 20-F filer (ASML, TSM) is a foreign private issuer with no 10-K, so
    // restricting identity evidence to 10-K/10-Q made them look like they had
    // filed nothing at all.  `loadSecRegistrantIndex` includes the per-year
    // overflow files, which is what a frequent filer's annual report lives in.
    const records: EvidenceRecord[] = [...registrant.filingsByAccession.values()]
      .filter((filing) => SEC_PERIODIC_FORMS.test(filing.form))
      .flatMap((filing) => {
        const url = secFilingUrl(registrant.cik, filing);
        const publishedAt = String(filing.filingDate ?? "").slice(0, 10);
        if (!url || !/^\d{4}-\d{2}-\d{2}$/.test(publishedAt)) return [];
        return [{
          source: "sec_filing" as const,
          kind: "primary" as const,
          security,
          documentId: filing.accessionNumber,
          title: `${registrant.entityName || registrant.ticker} ${filing.form}${filing.reportDate ? ` (${filing.reportDate})` : ""}`,
          publishedAt,
          url,
        }];
      })
      .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt));
    return { security, status: records.length ? "collected" : "no_documents", registry: "sec", records, failure: null };
  } catch (error) {
    return { security, status: "source_failed", registry: "sec", records: [], failure: errorMessage(error) };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
}

/** Registry a security *should* have evidence from, for reporting gaps. */
export function expectedRegistry(code: string): "cninfo" | "hkex" | "sec" | null {
  const registry = statutoryRegistryForSecurity(code);
  if (registry) return registry;
  return securitySuffix(normalizeSecurityCode(code)) === "US" ? "sec" : null;
}
