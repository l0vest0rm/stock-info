import type { ResearchSourceReference } from "./research-dossier";

/** Candidate targets are controlled configuration identifiers.  A financial
 * specialty target can only become a source fact through its matching metric
 * ledger; it is not an operating-model, scenario, valuation, or decision input. */
export type ResearchInformationEvidenceTargetModule = "operating_model" | "operating_driver" | "market_space" | "financial_specialty";
export type ResearchInformationEvidenceCandidate = {
  candidateId: string;
  securityCode: string;
  informationId: string;
  resultId: string;
  runId: string;
  versionId: string;
  contentHash: string;
  docId: string;
  entity: string;
  informationType: string;
  category: string;
  period: string | null;
  statement: string;
  targetModule: ResearchInformationEvidenceTargetModule;
  targetField: string;
  requiredFields: string[];
  sourceUrl: string | null;
  contentUrl: string | null;
  title: string | null;
  sourceName: string | null;
  publishedAt: string | null;
  mappingConfigVersion: string;
  createdAt: number;
};
export type ResearchInformationEvidenceCandidateReview = {
  candidateReviewId: string;
  candidateId: string;
  decision: "accepted" | "rejected" | "needs_evidence";
  reviewNote: string;
  reviewedBy: string;
  reviewedAt: number;
  createdAt: number;
};
export type ResearchReusableEvidenceReference = {
  evidenceReferenceId: string;
  candidateId: string;
  candidateReviewId: string;
  securityCode: string;
  targetModule: ResearchInformationEvidenceTargetModule;
  targetField: string;
  fieldStatus: "needs_field_entry";
  sourceReference: ResearchSourceReference;
  createdAt: number;
};

/**
 * Canonical read contract for one accepted, immutable source reference.
 *
 * The reference remains readable after a later review or document version
 * supersedes it, but only `eligible` references may enter a new research
 * ledger row.  This distinction keeps historical auditability separate from
 * current input eligibility.
 */
export type SourceEvidenceReferenceEligibilityReason =
  | "latest_review_not_accepted"
  | "accepted_review_superseded"
  | "source_version_superseded"
  | "source_chain_mismatch"
  | "processing_result_not_eligible";
export type SourceEvidenceReference = {
  evidenceReferenceId: string;
  candidateId: string;
  candidateReviewId: string;
  securityCode: string;
  entity: string;
  informationType: string;
  category: string;
  period: string | null;
  statement: string;
  targetModule: ResearchInformationEvidenceTargetModule;
  targetField: string;
  fieldStatus: "needs_field_entry";
  document: {
    documentId: string;
    versionId: string;
    contentHash: string;
    currentVersionId: string;
    sourceUrl: string | null;
    contentUrl: string | null;
    title: string | null;
    sourceName: string | null;
    publishedAt: string | null;
    locator: string;
  };
  processing: {
    informationId: string;
    resultId: string;
    runId: string;
    model: string;
    returnedModel: string | null;
    promptVersion: string;
    schemaVersion: string;
    ontologyVersion: string;
    inputHash: string;
    runStatus: "succeeded" | "needs_review";
    outcome: "extracted" | "needs_review";
  };
  review: {
    decision: "accepted";
    reviewNote: string;
    reviewedBy: string;
    reviewedAt: number;
    latestCandidateReviewId: string;
    latestDecision: ResearchInformationEvidenceCandidateReview["decision"];
  };
  createdAt: number;
  eligibility: {
    status: "eligible" | "revoked" | "superseded" | "invalid";
    reasons: SourceEvidenceReferenceEligibilityReason[];
  };
};

export type SourceEvidenceReferenceGuard = {
  expectedSecurityCode?: string;
  expectedTargetModule?: ResearchInformationEvidenceTargetModule;
  expectedTargetField?: string;
};

export function reusableReferenceFromCandidate(candidate: ResearchInformationEvidenceCandidate, evidenceReferenceId: string): ResearchSourceReference {
  return {
    sourceKind: "research_record", sourceId: evidenceReferenceId,
    informationId: candidate.informationId, versionId: candidate.versionId, documentId: candidate.docId,
    url: candidate.sourceUrl ?? candidate.contentUrl ?? undefined,
    title: candidate.title ?? candidate.sourceName ?? `信息预处理记录 ${candidate.informationId}`,
    publishedAt: candidate.publishedAt ?? undefined,
    locator: `information_id=${candidate.informationId}; result_id=${candidate.resultId}; run_id=${candidate.runId}; content_hash=${candidate.contentHash}`,
  };
}

export function assertEvidenceCandidateReview(input: Pick<ResearchInformationEvidenceCandidateReview, "decision" | "reviewNote" | "reviewedBy" | "reviewedAt">): void {
  if (!(["accepted", "rejected", "needs_evidence"] as const).includes(input.decision)) throw new Error("evidence candidate decision is invalid");
  if (!input.reviewNote.trim()) throw new Error("evidence candidate review note is required");
  if (!input.reviewedBy.trim()) throw new Error("evidence candidate reviewer is required");
  if (!Number.isInteger(input.reviewedAt) || input.reviewedAt <= 0) throw new Error("evidence candidate reviewedAt is invalid");
}
