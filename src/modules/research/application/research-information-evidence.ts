import mappingConfig from "../../../../config/research-information-evidence-mapping.json";
import {
  assertEvidenceCandidateReview,
  reusableReferenceFromCandidate,
  type ResearchInformationEvidenceCandidate,
  type ResearchInformationEvidenceCandidateReview,
  type ResearchInformationEvidenceTargetModule,
  type ResearchReusableEvidenceReference,
  type SourceEvidenceReference,
  type SourceEvidenceReferenceEligibilityReason,
  type SourceEvidenceReferenceGuard,
} from "../domain/research-information-evidence";

type Row = Record<string, unknown>;
type Mapping = {
  category: string;
  informationTypes: string[];
  /**
   * An optional, configuration-owned semantic guard for a broad ontology
   * category.  It narrows candidate creation only; the original immutable
   * statement remains the source of truth and still needs human review.
   */
  statementIncludesAll?: string[];
  targetModule: ResearchInformationEvidenceTargetModule;
  targetField: string;
  requiredFields: string[];
};
const config = mappingConfig as { version: string; mappings: Mapping[] };

/** Immutable information-processing row plus its document/version provenance.
 * A producer may narrow this set (for example, to an indexed public filing),
 * but it cannot supply a synthetic record or bypass the preprocessing ledger. */
export type ResearchInformationEvidenceSourceRecord = {
  informationId: string;
  entity: string;
  informationType: string;
  category: string;
  period: string | null;
  statement: string;
  resultId: string;
  runId: string;
  versionId: string;
  contentHash: string;
  docId: string;
  sourceUrl: string | null;
  contentUrl: string | null;
  title: string | null;
  sourceName: string | null;
  publishedAt: string | null;
};

export type ResearchInformationEvidenceMaterialization = {
  created: number;
  existing: number;
  /** Present only when the caller must bind a second immutable provenance ledger. */
  candidates: Array<{ candidateId: string; source: ResearchInformationEvidenceSourceRecord; mapping: Mapping }>;
};

export type EvidenceCandidateReviewWrite = {
  candidateReviewId: string;
  candidateId: string;
  decision: ResearchInformationEvidenceCandidateReview["decision"];
  reviewNote: string;
  reviewedBy?: string;
  reviewedAt?: number;
  evidenceReferenceId?: string;
  expectedSecurityCode?: string;
};
export type ResearchStatutoryEvidenceCandidateProvenance = {
  registry: "cninfo" | "hkex" | "sec";
  documentId: string;
  documentUrl: string;
  sourceLocator: string;
  producerVersion: string;
  createdAt: number;
};

/**
 * Reads the complete immutable knowledge chain behind a reusable reference.
 * Historical references are returned even when they are no longer eligible
 * for a new research write; callers must inspect `eligibility` or use the
 * asserting variant below.
 */
export async function loadSourceEvidenceReference(db: D1Database, evidenceReferenceId: string): Promise<SourceEvidenceReference | null> {
  const row = await db.prepare(`select reference.evidence_reference_id as evidenceReferenceId,
      reference.candidate_id as referenceCandidateId, reference.candidate_review_id as referenceCandidateReviewId,
      reference.security_code as referenceSecurityCode, reference.target_module as referenceTargetModule,
      reference.target_field as referenceTargetField, reference.field_status as fieldStatus,
      reference.information_id as referenceInformationId, reference.result_id as referenceResultId,
      reference.run_id as referenceRunId, reference.version_id as referenceVersionId,
      reference.content_hash as referenceContentHash, reference.doc_id as referenceDocId,
      reference.source_url as storedSourceUrl, reference.content_url as storedContentUrl,
      reference.title as storedTitle, reference.source_name as storedSourceName,
      reference.published_at as storedPublishedAt, reference.locator, reference.created_at as referenceCreatedAt,
      candidate.candidate_id as candidateId, candidate.candidate_review_id as unusedCandidateReviewId,
      candidate.security_code as candidateSecurityCode, candidate.target_module as candidateTargetModule,
      candidate.target_field as candidateTargetField, candidate.information_id as candidateInformationId,
      candidate.result_id as candidateResultId, candidate.run_id as candidateRunId,
      candidate.version_id as candidateVersionId, candidate.content_hash as candidateContentHash,
      candidate.doc_id as candidateDocId, candidate.entity, candidate.information_type as informationType,
      candidate.category, candidate.period, candidate.statement,
      accepted_review.candidate_review_id as acceptedReviewId, accepted_review.candidate_id as acceptedReviewCandidateId,
      accepted_review.decision as acceptedDecision, accepted_review.review_note as reviewNote,
      accepted_review.reviewed_by as reviewedBy, accepted_review.reviewed_at as reviewedAt,
      latest_review.candidate_review_id as latestReviewId, latest_review.decision as latestDecision,
      information.information_id as informationId, information.result_id as informationResultId,
      result.result_id as resultId, result.run_id as resultRunId, result.version_id as resultVersionId, result.outcome,
      run.run_id as runId, run.version_id as runVersionId, run.model, run.returned_model as returnedModel,
      run.prompt_version as promptVersion, run.schema_version as schemaVersion,
      run.ontology_version as ontologyVersion, run.input_hash as inputHash, run.status as runStatus,
      version.version_id as versionId, version.doc_id as versionDocId, version.content_hash as versionContentHash,
      coalesce(version.source_url, doc.url) as sourceUrl, content.content_url as contentUrl,
      coalesce(version.published_at, doc.published_at) as publishedAt, doc.doc_id as documentId,
      doc.title, doc.source_name as sourceName,
      current_version.version_id as currentVersionId
    from research_reusable_evidence_references reference
    join research_information_evidence_candidates candidate on candidate.candidate_id=reference.candidate_id
    join research_information_evidence_candidate_reviews accepted_review on accepted_review.candidate_review_id=reference.candidate_review_id
    join research_information_evidence_candidate_reviews latest_review on latest_review.candidate_review_id=(
      select latest.candidate_review_id from research_information_evidence_candidate_reviews latest
      where latest.candidate_id=candidate.candidate_id order by latest.reviewed_at desc, latest.candidate_review_id desc limit 1)
    join knowledge_information_records information on information.information_id=candidate.information_id
    join knowledge_document_results result on result.result_id=candidate.result_id
    join knowledge_processing_runs run on run.run_id=candidate.run_id
    join knowledge_document_versions version on version.version_id=candidate.version_id
    join knowledge_docs doc on doc.doc_id=candidate.doc_id
    join knowledge_document_versions current_version on current_version.version_id=(
      select latest_version.version_id from knowledge_document_versions latest_version
      where latest_version.doc_id=version.doc_id order by latest_version.created_at desc, latest_version.version_id desc limit 1)
    left join knowledge_doc_content_refs content on content.doc_id=doc.doc_id
    where reference.evidence_reference_id=?`).bind(required(evidenceReferenceId, "evidenceReferenceId")).first<Row>();
  return row ? mapSourceEvidenceReference(row) : null;
}

/** Rejects revoked, superseded, malformed, cross-security, or wrong-target evidence. */
export async function requireEligibleSourceEvidenceReference(
  db: D1Database,
  evidenceReferenceId: string,
  guard: SourceEvidenceReferenceGuard = {},
): Promise<SourceEvidenceReference> {
  const reference = await loadSourceEvidenceReference(db, evidenceReferenceId);
  if (!reference) throw new Error("source evidence reference was not found");
  if (reference.eligibility.status !== "eligible") {
    throw new Error(`source evidence reference is not eligible: ${reference.eligibility.reasons.join(",")}`);
  }
  if (guard.expectedSecurityCode && reference.securityCode !== guard.expectedSecurityCode.trim().toUpperCase()) {
    throw new Error("source evidence reference does not belong to requested security");
  }
  if (guard.expectedTargetModule && reference.targetModule !== guard.expectedTargetModule) {
    throw new Error("source evidence reference target module does not match requested consumer");
  }
  if (guard.expectedTargetField && reference.targetField !== guard.expectedTargetField.trim()) {
    throw new Error("source evidence reference target field does not match requested consumer");
  }
  return reference;
}

/**
 * Materializes only configured, exact code-mapped information records.  It
 * never creates an operating/market row: the output is a review candidate.
 */
export async function refreshResearchInformationEvidenceCandidates(db: D1Database, securityCode: string, createdAt = Date.now()): Promise<{ created: number; existing: number }> {
  const code = required(securityCode, "securityCode").toUpperCase();
  const records = await db.prepare(`select record.information_id as informationId, record.entity, record.information_type as informationType,
      record.category, record.period, record.statement, result.result_id as resultId, result.run_id as runId,
      version.version_id as versionId, version.content_hash as contentHash, version.doc_id as docId,
      coalesce(version.source_url, doc.url) as sourceUrl, content.content_url as contentUrl, doc.title,
      doc.source_name as sourceName, coalesce(version.published_at, doc.published_at) as publishedAt
    from knowledge_information_records record
    join knowledge_company_code_mappings mapping on mapping.company_name=record.entity and mapping.code=?
    join knowledge_document_results result on result.result_id=record.result_id
    join knowledge_document_versions version on version.version_id=result.version_id
    join knowledge_docs doc on doc.doc_id=version.doc_id
    left join knowledge_doc_content_refs content on content.doc_id=doc.doc_id
    -- A document-level needs_review result can still contain individual
    -- records that passed the strict parser. Preserve those source-bound rows
    -- as candidates for a second, explicit human review; do not let an
    -- unrelated rejected record erase a valid direct disclosure. Failed and
    -- all other outcomes remain ineligible.
    where result.outcome in ('extracted', 'needs_review')
    order by result.created_at desc, record.sort_order asc, record.information_id asc`).bind(code).all<Row>();
  const materialized = await materializeResearchInformationEvidenceCandidates(
    db,
    code,
    records.results.map(sourceRecord),
    createdAt,
  );
  return { created: materialized.created, existing: materialized.existing };
}

/**
 * Shared candidate materializer.  It deliberately accepts only rows shaped
 * like the immutable information-processing ledger, so specialized producers
 * can add a second source constraint without becoming a new extraction path.
 */
export async function materializeResearchInformationEvidenceCandidates(
  db: D1Database,
  securityCode: string,
  records: ResearchInformationEvidenceSourceRecord[],
  createdAt = Date.now(),
  options: { includePersistedIds?: boolean } = {},
): Promise<ResearchInformationEvidenceMaterialization> {
  const code = required(securityCode, "securityCode").toUpperCase();
  let created = 0;
  let existing = 0;
  const candidates: ResearchInformationEvidenceMaterialization["candidates"] = [];
  for (const record of records) {
    const matching = config.mappings.filter((item) => item.category === record.category
      && item.informationTypes.includes(record.informationType)
      && matchesStatementGuard(item, record.statement));
    for (const mapping of matching) {
      const generatedCandidateId = `research-information-evidence:${crypto.randomUUID()}`;
      const result = await db.prepare(`insert into research_information_evidence_candidates (
        candidate_id, security_code, information_id, result_id, run_id, version_id, content_hash, doc_id,
        entity, information_type, category, period, statement, target_module, target_field, required_fields_json,
        source_url, content_url, title, source_name, published_at, mapping_config_version, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(security_code, information_id, target_module, target_field) do nothing`)
        .bind(generatedCandidateId, code, record.informationId, record.resultId, record.runId, record.versionId, record.contentHash, record.docId,
          record.entity, record.informationType, record.category, record.period, record.statement, mapping.targetModule, mapping.targetField,
          JSON.stringify(mapping.requiredFields), record.sourceUrl, record.contentUrl, record.title, record.sourceName, record.publishedAt, config.version, createdAt).run();
      const wasCreated = Number(result.meta.changes ?? 0) > 0;
      if (wasCreated) created += Number(result.meta.changes); else existing += 1;
      if (options.includePersistedIds) {
        let candidateId = generatedCandidateId;
        if (!wasCreated) {
          const stored = await db.prepare(`select candidate_id as candidateId from research_information_evidence_candidates
            where security_code=? and information_id=? and target_module=? and target_field=?`)
            .bind(code, record.informationId, mapping.targetModule, mapping.targetField).first<Row>();
          if (!stored) throw new Error("existing research information evidence candidate could not be resolved");
          candidateId = text(stored.candidateId);
        }
        candidates.push({ candidateId, source: record, mapping });
      }
    }
  }
  return { created, existing, candidates };
}

function matchesStatementGuard(mapping: Mapping, statement: string): boolean {
  const terms = mapping.statementIncludesAll;
  return !terms?.length || terms.every((term) => statement.includes(term));
}

export async function loadResearchInformationEvidenceCandidates(db: D1Database, securityCode: string, limit = 200): Promise<Array<ResearchInformationEvidenceCandidate & { latestReview: ResearchInformationEvidenceCandidateReview | null; reusableEvidenceReference: ResearchReusableEvidenceReference | null; statutoryProvenance: ResearchStatutoryEvidenceCandidateProvenance | null }>> {
  const rows = await db.prepare(`select candidate.*, review.candidate_review_id as reviewId, review.decision as reviewDecision,
      review.review_note as reviewNote, review.reviewed_by as reviewedBy, review.reviewed_at as reviewedAt, review.created_at as reviewCreatedAt,
      reference.evidence_reference_id as evidenceReferenceId, reference.candidate_review_id as evidenceCandidateReviewId,
      reference.field_status as fieldStatus, reference.locator as referenceLocator, reference.created_at as referenceCreatedAt,
      statutory.registry as statutoryRegistry, statutory.statutory_document_id as statutoryDocumentId,
      statutory.statutory_document_url as statutoryDocumentUrl, statutory.statutory_source_locator as statutorySourceLocator,
      statutory.producer_version as statutoryProducerVersion, statutory.created_at as statutoryProvenanceCreatedAt
    from research_information_evidence_candidates candidate
    left join research_information_evidence_candidate_reviews review on review.candidate_review_id=(
      select latest.candidate_review_id from research_information_evidence_candidate_reviews latest
       where latest.candidate_id=candidate.candidate_id order by latest.reviewed_at desc, latest.candidate_review_id desc limit 1)
    left join research_reusable_evidence_references reference on reference.candidate_review_id=review.candidate_review_id
    left join research_statutory_operating_candidate_provenance statutory on statutory.candidate_id=candidate.candidate_id
    where candidate.security_code=? order by candidate.created_at desc, candidate.candidate_id desc limit ?`).bind(required(securityCode, "securityCode").toUpperCase(), boundedLimit(limit)).all<Row>();
  return rows.results.map((row) => {
    const candidate = mapCandidate(row);
    const latestReview = row.reviewId ? mapReview(row) : null;
    const reusableEvidenceReference = row.evidenceReferenceId && latestReview ? {
      evidenceReferenceId: text(row.evidenceReferenceId), candidateId: candidate.candidateId, candidateReviewId: text(row.evidenceCandidateReviewId), securityCode: candidate.securityCode,
      targetModule: candidate.targetModule, targetField: candidate.targetField, fieldStatus: text(row.fieldStatus) as "needs_field_entry",
      sourceReference: { ...reusableReferenceFromCandidate(candidate, text(row.evidenceReferenceId)), locator: text(row.referenceLocator) }, createdAt: number(row.referenceCreatedAt),
    } satisfies ResearchReusableEvidenceReference : null;
    const statutoryProvenance = row.statutoryRegistry ? {
      registry: text(row.statutoryRegistry) as ResearchStatutoryEvidenceCandidateProvenance["registry"],
      documentId: text(row.statutoryDocumentId), documentUrl: text(row.statutoryDocumentUrl), sourceLocator: text(row.statutorySourceLocator),
      producerVersion: text(row.statutoryProducerVersion), createdAt: number(row.statutoryProvenanceCreatedAt),
    } satisfies ResearchStatutoryEvidenceCandidateProvenance : null;
    return { ...candidate, latestReview, reusableEvidenceReference, statutoryProvenance };
  });
}

/** Appends a review; accepting creates exactly one reusable research_record reference and no domain fact. */
export async function reviewResearchInformationEvidenceCandidate(db: D1Database, input: EvidenceCandidateReviewWrite): Promise<{ review: ResearchInformationEvidenceCandidateReview; reusableEvidenceReference: ResearchReusableEvidenceReference | null }> {
  const candidate = await candidateById(db, input.candidateId);
  if (!candidate) throw new Error("research information evidence candidate not found");
  if (input.expectedSecurityCode && candidate.securityCode !== input.expectedSecurityCode.trim().toUpperCase()) {
    throw new Error("research information evidence candidate does not belong to requested security");
  }
  const reviewedAt = input.reviewedAt ?? Date.now();
  const review: ResearchInformationEvidenceCandidateReview = {
    candidateReviewId: required(input.candidateReviewId, "candidateReviewId"), candidateId: candidate.candidateId,
    decision: input.decision, reviewNote: required(input.reviewNote, "reviewNote"), reviewedBy: required(input.reviewedBy ?? "local-user", "reviewedBy"), reviewedAt, createdAt: reviewedAt,
  };
  assertEvidenceCandidateReview(review);
  const statements: D1PreparedStatement[] = [db.prepare(`insert into research_information_evidence_candidate_reviews (
      candidate_review_id, candidate_id, decision, review_note, reviewed_by, reviewed_at, created_at
    ) values (?, ?, ?, ?, ?, ?, ?)`)
    .bind(review.candidateReviewId, review.candidateId, review.decision, review.reviewNote, review.reviewedBy, review.reviewedAt, review.createdAt)];
  let reusableEvidenceReference: ResearchReusableEvidenceReference | null = null;
  if (review.decision === "accepted") {
    const evidenceReferenceId = required(input.evidenceReferenceId ?? `research-evidence:${crypto.randomUUID()}`, "evidenceReferenceId");
    const sourceReference = reusableReferenceFromCandidate(candidate, evidenceReferenceId);
    statements.push(db.prepare(`insert into research_reusable_evidence_references (
        evidence_reference_id, candidate_id, candidate_review_id, security_code, target_module, target_field, field_status,
        information_id, result_id, run_id, version_id, content_hash, doc_id, source_url, content_url, title, source_name, published_at, locator, created_at
      ) values (?, ?, ?, ?, ?, ?, 'needs_field_entry', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(evidenceReferenceId, candidate.candidateId, review.candidateReviewId, candidate.securityCode, candidate.targetModule, candidate.targetField,
        candidate.informationId, candidate.resultId, candidate.runId, candidate.versionId, candidate.contentHash, candidate.docId,
        candidate.sourceUrl, candidate.contentUrl, candidate.title, candidate.sourceName, candidate.publishedAt, sourceReference.locator, reviewedAt));
    reusableEvidenceReference = { evidenceReferenceId, candidateId: candidate.candidateId, candidateReviewId: review.candidateReviewId,
      securityCode: candidate.securityCode, targetModule: candidate.targetModule, targetField: candidate.targetField, fieldStatus: "needs_field_entry", sourceReference, createdAt: reviewedAt };
  }
  await db.batch(statements);
  return { review, reusableEvidenceReference };
}

async function candidateById(db: D1Database, candidateId: string): Promise<ResearchInformationEvidenceCandidate | null> {
  const row = await db.prepare("select * from research_information_evidence_candidates where candidate_id=?").bind(required(candidateId, "candidateId")).first<Row>();
  return row ? mapCandidate(row) : null;
}
function mapCandidate(row: Row): ResearchInformationEvidenceCandidate {
  const targetModule = text(row.target_module) as ResearchInformationEvidenceTargetModule;
  // Candidates record the mapping version and required fields at creation time.
  // They must stay readable even after a future mapping configuration revision
  // retires that category; otherwise an immutable audit trail would disappear.
  return { candidateId: text(row.candidate_id), securityCode: text(row.security_code), informationId: text(row.information_id), resultId: text(row.result_id), runId: text(row.run_id), versionId: text(row.version_id), contentHash: text(row.content_hash), docId: text(row.doc_id), entity: text(row.entity), informationType: text(row.information_type), category: text(row.category), period: optional(row.period), statement: text(row.statement), targetModule, targetField: text(row.target_field), requiredFields: array(row.required_fields_json), sourceUrl: optional(row.source_url), contentUrl: optional(row.content_url), title: optional(row.title), sourceName: optional(row.source_name), publishedAt: optional(row.published_at), mappingConfigVersion: text(row.mapping_config_version), createdAt: number(row.created_at) };
}

/**
 * Maps the joined immutable evidence chain into the shared read contract.
 *
 * This must validate every persisted foreign-key-like link again at read time:
 * historical rows remain inspectable, but a stale review, superseded document
 * version, or broken provenance chain must never become eligible input for a
 * new research write.
 */
function mapSourceEvidenceReference(row: Row): SourceEvidenceReference {
  const reasons: SourceEvidenceReferenceEligibilityReason[] = [];
  const referenceCandidateId = text(row.referenceCandidateId);
  const candidateId = text(row.candidateId);
  const acceptedReviewId = text(row.acceptedReviewId);
  const latestReviewId = text(row.latestReviewId);
  const latestDecision = text(row.latestDecision) as ResearchInformationEvidenceCandidateReview["decision"];
  const sourceChainMatches = referenceCandidateId === candidateId
    && text(row.referenceCandidateReviewId) === acceptedReviewId
    && text(row.acceptedReviewCandidateId) === candidateId
    && text(row.referenceSecurityCode) === text(row.candidateSecurityCode)
    && text(row.referenceTargetModule) === text(row.candidateTargetModule)
    && text(row.referenceTargetField) === text(row.candidateTargetField)
    && text(row.referenceInformationId) === text(row.candidateInformationId)
    && text(row.referenceResultId) === text(row.candidateResultId)
    && text(row.referenceRunId) === text(row.candidateRunId)
    && text(row.referenceVersionId) === text(row.candidateVersionId)
    && text(row.referenceContentHash) === text(row.candidateContentHash)
    && text(row.referenceDocId) === text(row.candidateDocId)
    && text(row.informationId) === text(row.candidateInformationId)
    && text(row.resultId) === text(row.candidateResultId)
    && text(row.resultRunId) === text(row.candidateRunId)
    && text(row.resultVersionId) === text(row.candidateVersionId)
    && text(row.runId) === text(row.candidateRunId)
    && text(row.runVersionId) === text(row.candidateVersionId)
    && text(row.versionId) === text(row.candidateVersionId)
    && text(row.versionDocId) === text(row.candidateDocId)
    && text(row.versionContentHash) === text(row.candidateContentHash)
    && text(row.documentId) === text(row.candidateDocId);
  if (!sourceChainMatches) reasons.push("source_chain_mismatch");
  if (latestReviewId !== acceptedReviewId) reasons.push("accepted_review_superseded");
  if (latestDecision !== "accepted") reasons.push("latest_review_not_accepted");
  if (text(row.currentVersionId) !== text(row.versionId)) reasons.push("source_version_superseded");
  const runStatus = text(row.runStatus);
  const outcome = text(row.outcome);
  if (!(runStatus === "succeeded" || runStatus === "needs_review") || !(outcome === "extracted" || outcome === "needs_review")) {
    reasons.push("processing_result_not_eligible");
  }
  const status = reasons.includes("source_chain_mismatch") || reasons.includes("processing_result_not_eligible")
    ? "invalid"
    : reasons.includes("latest_review_not_accepted")
      ? "revoked"
      : reasons.length ? "superseded" : "eligible";
  return {
    evidenceReferenceId: text(row.evidenceReferenceId), candidateId,
    candidateReviewId: text(row.referenceCandidateReviewId), securityCode: text(row.referenceSecurityCode),
    entity: text(row.entity), informationType: text(row.informationType), category: text(row.category), period: optional(row.period),
    statement: text(row.statement), targetModule: text(row.referenceTargetModule) as ResearchInformationEvidenceTargetModule,
    targetField: text(row.referenceTargetField), fieldStatus: text(row.fieldStatus) as "needs_field_entry",
    document: {
      documentId: text(row.documentId), versionId: text(row.versionId), contentHash: text(row.versionContentHash), currentVersionId: text(row.currentVersionId),
      sourceUrl: optional(row.sourceUrl) ?? optional(row.storedSourceUrl), contentUrl: optional(row.contentUrl) ?? optional(row.storedContentUrl),
      title: optional(row.title) ?? optional(row.storedTitle), sourceName: optional(row.sourceName) ?? optional(row.storedSourceName),
      publishedAt: optional(row.publishedAt) ?? optional(row.storedPublishedAt), locator: text(row.locator),
    },
    processing: {
      informationId: text(row.informationId), resultId: text(row.resultId), runId: text(row.runId), model: text(row.model), returnedModel: optional(row.returnedModel),
      promptVersion: text(row.promptVersion), schemaVersion: text(row.schemaVersion), ontologyVersion: text(row.ontologyVersion), inputHash: text(row.inputHash),
      runStatus: runStatus as SourceEvidenceReference["processing"]["runStatus"], outcome: outcome as SourceEvidenceReference["processing"]["outcome"],
    },
    review: {
      decision: "accepted", reviewNote: text(row.reviewNote), reviewedBy: text(row.reviewedBy), reviewedAt: number(row.reviewedAt),
      latestCandidateReviewId: latestReviewId, latestDecision,
    },
    createdAt: number(row.referenceCreatedAt), eligibility: { status, reasons },
  };
}
function sourceRecord(row: Row): ResearchInformationEvidenceSourceRecord {
  return {
    informationId: text(row.informationId), entity: text(row.entity), informationType: text(row.informationType), category: text(row.category),
    period: optional(row.period), statement: text(row.statement), resultId: text(row.resultId), runId: text(row.runId), versionId: text(row.versionId),
    contentHash: text(row.contentHash), docId: text(row.docId), sourceUrl: optional(row.sourceUrl), contentUrl: optional(row.contentUrl),
    title: optional(row.title), sourceName: optional(row.sourceName), publishedAt: optional(row.publishedAt),
  };
}
function mapReview(row: Row): ResearchInformationEvidenceCandidateReview { return { candidateReviewId: text(row.reviewId), candidateId: text(row.candidate_id), decision: text(row.reviewDecision) as ResearchInformationEvidenceCandidateReview["decision"], reviewNote: text(row.reviewNote), reviewedBy: text(row.reviewedBy), reviewedAt: number(row.reviewedAt), createdAt: number(row.reviewCreatedAt) }; }
function array(value: unknown): string[] { try { const parsed = JSON.parse(String(value ?? "[]")); return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : []; } catch { return []; } }
function required(value: string | null | undefined, label: string): string { const result = String(value ?? "").trim(); if (!result) throw new Error(`${label} is required`); return result; }
function text(value: unknown): string { return required(value === null || value === undefined ? "" : String(value), "stored evidence text"); }
function optional(value: unknown): string | null { const result = String(value ?? "").trim(); return result || null; }
function number(value: unknown): number { const result = Number(value); if (!Number.isFinite(result)) throw new Error("stored evidence timestamp is invalid"); return result; }
function boundedLimit(value: number): number { return Math.min(500, Math.max(1, Math.floor(value))); }
