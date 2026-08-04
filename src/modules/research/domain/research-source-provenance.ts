/**
 * Presentation boundary for research evidence sourced from the knowledge
 * ledger.  Test/demo documents remain in the ledger for reproducibility, but
 * must never become an apparently real source, forecast, or derived summary.
 *
 * This is intentionally based on immutable document provenance rather than
 * institution names or copied source statements, so a legitimate local user
 * document is not hidden merely because of its wording.
 */
export type ResearchSourceDocumentProvenance = {
  docId: string;
  sourceUrl?: string | null;
  discoveryMethod?: string | null;
  metadataJson?: string | null;
};

export type ResearchSourcePresentationEligibility =
  | { eligible: true }
  | { eligible: false; reason: "fixture_document" | "sample_seed" | "reserved_example_domain" };

export function researchSourcePresentationEligibility(
  provenance: ResearchSourceDocumentProvenance,
): ResearchSourcePresentationEligibility {
  const documentId = String(provenance.docId || "").trim().toLowerCase();
  if (documentId.startsWith("fixture-")) return { eligible: false, reason: "fixture_document" };

  if (String(provenance.discoveryMethod || "").trim().toLowerCase() === "local_seed" || isExplicitSample(provenance.metadataJson)) {
    return { eligible: false, reason: "sample_seed" };
  }

  if (isReservedExampleDomain(provenance.sourceUrl)) return { eligible: false, reason: "reserved_example_domain" };
  return { eligible: true };
}

export function isPresentableResearchSource(provenance: ResearchSourceDocumentProvenance): boolean {
  return researchSourcePresentationEligibility(provenance).eligible;
}

function isExplicitSample(metadataJson: string | null | undefined): boolean {
  try {
    const metadata = JSON.parse(String(metadataJson || "{}")) as Record<string, unknown>;
    return metadata.source === "sample" || metadata.synthetic === true || metadata.fixture === true;
  } catch {
    return false;
  }
}

function isReservedExampleDomain(sourceUrl: string | null | undefined): boolean {
  try {
    const hostname = new URL(String(sourceUrl || "")).hostname.toLowerCase();
    return hostname === "example.com" || hostname.endsWith(".example.com");
  } catch {
    return false;
  }
}
