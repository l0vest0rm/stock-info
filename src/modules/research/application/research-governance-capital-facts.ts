import {
  assertGovernanceCapitalCandidateReview,
  assertGovernanceCapitalFactVersion,
  governanceCapitalFactConfigVersion,
  governanceCapitalFactDefinitions,
  governanceCapitalFactMappings,
  governanceCapitalSourceLocator,
  latestGovernanceCapitalFacts,
  type GovernanceCapitalFactStatus,
  type GovernanceCapitalSourceAuthority,
  type ResearchGovernanceCapitalFactCandidate,
  type ResearchGovernanceCapitalFactCandidateReview,
  type ResearchGovernanceCapitalFactVersion,
} from "../domain/research-governance-capital-facts";

type Row = Record<string, unknown>;
export type GovernanceCapitalFactCandidateReviewWrite = {
  candidateReviewId: string;
  candidateId: string;
  decision: ResearchGovernanceCapitalFactCandidateReview["decision"];
  reviewNote: string;
  reviewedBy?: string;
  reviewedAt?: number;
  governanceCapitalFactVersionId?: string;
  factStatus?: GovernanceCapitalFactStatus;
  valueNumber?: number | null;
  valueRangeLower?: number | null;
  valueRangeUpper?: number | null;
  valueText?: string | null;
  unit?: string | null;
  asOf?: string;
  sourceAuthority?: GovernanceCapitalSourceAuthority;
  expectedSecurityCode?: string;
};

/** Materializes configured governance/capital candidates only from an exact
 * company-code mapping. It never interprets the statement or writes a fact. */
export async function refreshResearchGovernanceCapitalFactCandidates(db: D1Database, securityCode: string, createdAt = Date.now()): Promise<{ created: number; existing: number }> {
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
    where result.outcome='extracted'
    order by result.created_at desc, record.sort_order asc, record.information_id asc`).bind(code).all<Row>();
  let created = 0; let existing = 0;
  for (const row of records.results) {
    const mappings = governanceCapitalFactMappings().filter((mapping) => mapping.category === text(row.category) && mapping.informationTypes.includes(text(row.informationType)));
    for (const mapping of mappings) {
      const result = await db.prepare(`insert into research_governance_capital_fact_candidates (
        candidate_id, security_code, information_id, result_id, run_id, version_id, content_hash, doc_id,
        entity, information_type, category, period, statement, fact_key, required_fields_json,
        source_url, content_url, title, source_name, published_at, mapping_config_version, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(security_code, information_id, fact_key) do nothing`)
        .bind(`research-governance-capital-candidate:${crypto.randomUUID()}`, code, text(row.informationId), text(row.resultId), text(row.runId), text(row.versionId), text(row.contentHash), text(row.docId),
          text(row.entity), text(row.informationType), text(row.category), optional(row.period), text(row.statement), mapping.factKey, JSON.stringify(mapping.requiredFields),
          optional(row.sourceUrl), optional(row.contentUrl), optional(row.title), optional(row.sourceName), optional(row.publishedAt), governanceCapitalFactConfigVersion(), createdAt).run();
      if (result.meta.changes) created += Number(result.meta.changes); else existing += 1;
    }
  }
  return { created, existing };
}

export async function loadResearchGovernanceCapitalFactCandidates(db: D1Database, securityCode: string, limit = 200): Promise<Array<ResearchGovernanceCapitalFactCandidate & { latestReview: ResearchGovernanceCapitalFactCandidateReview | null; factVersion: ResearchGovernanceCapitalFactVersion | null }>> {
  const rows = await db.prepare(`select candidate.*, review.candidate_review_id as reviewId, review.decision as reviewDecision,
      review.review_note as reviewNote, review.reviewed_by as reviewedBy, review.reviewed_at as reviewedAt, review.created_at as reviewCreatedAt,
      fact.governance_capital_fact_version_id as factVersionId, fact.candidate_review_id as factCandidateReviewId,
      fact.supersedes_fact_version_id as factSupersedesId, fact.company_id as factCompanyId, fact.security_code as factSecurityCode,
      fact.fact_key as factKey, fact.fact_status as factStatus, fact.value_kind as factValueKind, fact.value_number as factValueNumber,
      fact.value_range_lower as factValueRangeLower, fact.value_range_upper as factValueRangeUpper,
      fact.value_text as factValueText, fact.unit as factUnit, fact.as_of as factAsOf, fact.period as factPeriod,
      fact.source_authority as factSourceAuthority, fact.information_id as factInformationId, fact.result_id as factResultId,
      fact.run_id as factRunId, fact.version_id as factSourceVersionId, fact.content_hash as factContentHash, fact.doc_id as factDocId,
      fact.source_url as factSourceUrl, fact.content_url as factContentUrl, fact.source_title as factSourceTitle,
      fact.source_name as factSourceName, fact.published_at as factPublishedAt, fact.source_locator as factSourceLocator, fact.created_at as factCreatedAt
    from research_governance_capital_fact_candidates candidate
    left join research_governance_capital_fact_candidate_reviews review on review.candidate_review_id=(
      select latest.candidate_review_id from research_governance_capital_fact_candidate_reviews latest
      where latest.candidate_id=candidate.candidate_id order by latest.reviewed_at desc, latest.candidate_review_id desc limit 1)
    left join research_governance_capital_fact_versions fact on fact.candidate_review_id=review.candidate_review_id
    where candidate.security_code=? order by candidate.created_at desc, candidate.candidate_id desc limit ?`).bind(required(securityCode, "securityCode").toUpperCase(), boundedLimit(limit)).all<Row>();
  return rows.results.map((row) => {
    const candidate = mapCandidate(row); const latestReview = row.reviewId ? mapReview(row) : null;
    return { ...candidate, latestReview, factVersion: row.factVersionId ? mapFact(row, "fact") : null };
  });
}

export async function loadResearchGovernanceCapitalFactLedger(db: D1Database, securityCode: string) {
  try {
    const rows = await db.prepare(`select governance_capital_fact_version_id, candidate_review_id, supersedes_fact_version_id, company_id, security_code,
      fact_key, fact_status, value_kind, value_number, value_range_lower, value_range_upper, value_text, unit, as_of, period, source_authority,
      information_id, result_id, run_id, version_id, content_hash, doc_id, source_url, content_url, source_title,
      source_name, published_at, source_locator, created_at
      from research_governance_capital_fact_versions where security_code=? order by as_of desc, created_at desc`).bind(required(securityCode, "securityCode").toUpperCase()).all<Row>();
    const facts = rows.results.map((row) => mapFact(row));
    return { availability: facts.length ? "available" as const : "empty" as const, ruleVersion: governanceCapitalFactConfigVersion(), definitions: governanceCapitalFactDefinitions(), facts, latestFacts: latestGovernanceCapitalFacts(facts) };
  } catch (error) {
    if (/no such table|does not exist|not found/i.test(error instanceof Error ? error.message : String(error))) return { availability: "unavailable" as const, reason: "storage_not_initialized", ruleVersion: governanceCapitalFactConfigVersion(), definitions: governanceCapitalFactDefinitions(), facts: [] as ResearchGovernanceCapitalFactVersion[], latestFacts: [] as ResearchGovernanceCapitalFactVersion[] };
    throw error;
  }
}

/** Appends an audit review. Only acceptance writes one immutable structured fact
 * version, and its source chain is wholly derived from the selected candidate. */
export async function reviewResearchGovernanceCapitalFactCandidate(db: D1Database, input: GovernanceCapitalFactCandidateReviewWrite): Promise<{ review: ResearchGovernanceCapitalFactCandidateReview; factVersion: ResearchGovernanceCapitalFactVersion | null }> {
  const candidate = await candidateById(db, input.candidateId);
  if (!candidate) throw new Error("governance/capital candidate not found");
  if (input.expectedSecurityCode && candidate.securityCode !== input.expectedSecurityCode.trim().toUpperCase()) throw new Error("governance/capital candidate does not belong to requested security");
  const reviewedAt = input.reviewedAt ?? Date.now();
  const review: ResearchGovernanceCapitalFactCandidateReview = { candidateReviewId: required(input.candidateReviewId, "candidateReviewId"), candidateId: candidate.candidateId, decision: input.decision, reviewNote: required(input.reviewNote, "reviewNote"), reviewedBy: required(input.reviewedBy ?? "local-user", "reviewedBy"), reviewedAt, createdAt: reviewedAt };
  assertGovernanceCapitalCandidateReview(review);
  const statements: D1PreparedStatement[] = [db.prepare(`insert into research_governance_capital_fact_candidate_reviews (
    candidate_review_id, candidate_id, decision, review_note, reviewed_by, reviewed_at, created_at
  ) values (?, ?, ?, ?, ?, ?, ?)`)
    .bind(review.candidateReviewId, review.candidateId, review.decision, review.reviewNote, review.reviewedBy, review.reviewedAt, review.createdAt)];
  let factVersion: ResearchGovernanceCapitalFactVersion | null = null;
  if (review.decision === "accepted") {
    const company = await db.prepare("select company_id as companyId from research_listed_securities where security_code=?").bind(candidate.securityCode).first<{ companyId: string | null }>();
    if (!company?.companyId) throw new Error("operating-company mapping is required before accepting a governance/capital fact");
    const definition = governanceCapitalFactDefinitions().find((item) => item.factKey === candidate.factKey);
    if (!definition) throw new Error("candidate factKey is no longer configured");
    const fact: ResearchGovernanceCapitalFactVersion = {
      governanceCapitalFactVersionId: required(input.governanceCapitalFactVersionId ?? `research-governance-capital-fact:${crypto.randomUUID()}`, "governanceCapitalFactVersionId"),
      candidateReviewId: review.candidateReviewId, supersedesFactVersionId: await latestFactVersionId(db, company.companyId, candidate.factKey), companyId: company.companyId,
      securityCode: candidate.securityCode, factKey: candidate.factKey, factStatus: requiredStatus(input.factStatus), valueKind: definition.valueKind,
      valueNumber: input.valueNumber ?? null, valueRangeLower: input.valueRangeLower ?? null, valueRangeUpper: input.valueRangeUpper ?? null,
      valueText: optional(input.valueText), unit: optional(input.unit), asOf: required(input.asOf ?? "", "asOf"), period: candidate.period,
      sourceAuthority: requiredSourceAuthority(input.sourceAuthority), informationId: candidate.informationId, resultId: candidate.resultId, runId: candidate.runId, versionId: candidate.versionId,
      contentHash: candidate.contentHash, docId: candidate.docId, sourceUrl: candidate.sourceUrl, contentUrl: candidate.contentUrl, sourceTitle: candidate.title, sourceName: candidate.sourceName,
      publishedAt: candidate.publishedAt, sourceLocator: governanceCapitalSourceLocator(candidate), createdAt: reviewedAt,
    };
    assertGovernanceCapitalFactVersion(fact);
    statements.push(db.prepare(`insert into research_governance_capital_fact_versions (
      governance_capital_fact_version_id, candidate_review_id, supersedes_fact_version_id, company_id, security_code, fact_key, fact_status,
      value_kind, value_number, value_range_lower, value_range_upper, value_text, unit, as_of, period, source_authority, information_id, result_id, run_id, version_id,
      content_hash, doc_id, source_url, content_url, source_title, source_name, published_at, source_locator, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(fact.governanceCapitalFactVersionId, fact.candidateReviewId, fact.supersedesFactVersionId, fact.companyId, fact.securityCode, fact.factKey, fact.factStatus,
        fact.valueKind, fact.valueNumber, fact.valueRangeLower, fact.valueRangeUpper, fact.valueText, fact.unit, fact.asOf, fact.period, fact.sourceAuthority, fact.informationId, fact.resultId, fact.runId, fact.versionId,
        fact.contentHash, fact.docId, fact.sourceUrl, fact.contentUrl, fact.sourceTitle, fact.sourceName, fact.publishedAt, fact.sourceLocator, fact.createdAt));
    factVersion = fact;
  }
  await db.batch(statements);
  return { review, factVersion };
}

async function candidateById(db: D1Database, candidateId: string): Promise<ResearchGovernanceCapitalFactCandidate | null> {
  const row = await db.prepare("select * from research_governance_capital_fact_candidates where candidate_id=?").bind(required(candidateId, "candidateId")).first<Row>();
  return row ? mapCandidate(row) : null;
}
async function latestFactVersionId(db: D1Database, companyId: string, factKey: string): Promise<string | null> {
  const row = await db.prepare(`select governance_capital_fact_version_id as factVersionId from research_governance_capital_fact_versions
    where company_id=? and fact_key=? order by as_of desc, created_at desc, governance_capital_fact_version_id desc limit 1`).bind(companyId, factKey).first<{ factVersionId: string }>();
  return row?.factVersionId ?? null;
}
function mapCandidate(row: Row): ResearchGovernanceCapitalFactCandidate { return {
  candidateId: text(row.candidate_id), securityCode: text(row.security_code), informationId: text(row.information_id), resultId: text(row.result_id), runId: text(row.run_id), versionId: text(row.version_id), contentHash: text(row.content_hash), docId: text(row.doc_id), entity: text(row.entity), informationType: text(row.information_type), category: text(row.category), period: optional(row.period), statement: text(row.statement), factKey: text(row.fact_key), requiredFields: array(row.required_fields_json), sourceUrl: optional(row.source_url), contentUrl: optional(row.content_url), title: optional(row.title), sourceName: optional(row.source_name), publishedAt: optional(row.published_at), mappingConfigVersion: text(row.mapping_config_version), createdAt: number(row.created_at),
}; }
function mapReview(row: Row): ResearchGovernanceCapitalFactCandidateReview { return { candidateReviewId: text(row.reviewId), candidateId: text(row.candidate_id), decision: text(row.reviewDecision) as ResearchGovernanceCapitalFactCandidateReview["decision"], reviewNote: text(row.reviewNote), reviewedBy: text(row.reviewedBy), reviewedAt: number(row.reviewedAt), createdAt: number(row.reviewCreatedAt) }; }
function mapFact(row: Row, prefix = ""): ResearchGovernanceCapitalFactVersion {
  const get = (field: string) => row[`${prefix}${field}`] ?? row[field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)];
  return { governanceCapitalFactVersionId: text(get("VersionId") ?? row.governance_capital_fact_version_id), candidateReviewId: text(get("CandidateReviewId") ?? row.candidate_review_id), supersedesFactVersionId: optional(get("SupersedesId") ?? row.supersedes_fact_version_id), companyId: text(get("CompanyId") ?? row.company_id), securityCode: text(get("SecurityCode") ?? row.security_code), factKey: text(get("Key") ?? row.fact_key), factStatus: text(get("Status") ?? row.fact_status) as GovernanceCapitalFactStatus, valueKind: text(get("ValueKind") ?? row.value_kind) as ResearchGovernanceCapitalFactVersion["valueKind"], valueNumber: numericOrNull(get("ValueNumber") ?? row.value_number), valueRangeLower: numericOrNull(get("ValueRangeLower") ?? row.value_range_lower), valueRangeUpper: numericOrNull(get("ValueRangeUpper") ?? row.value_range_upper), valueText: optional(get("ValueText") ?? row.value_text), unit: optional(get("Unit") ?? row.unit), asOf: text(get("AsOf") ?? row.as_of), period: optional(get("Period") ?? row.period), sourceAuthority: text(get("SourceAuthority") ?? row.source_authority) as GovernanceCapitalSourceAuthority, informationId: text(get("InformationId") ?? row.information_id), resultId: text(get("ResultId") ?? row.result_id), runId: text(get("RunId") ?? row.run_id), versionId: text(get("SourceVersionId") ?? row.version_id), contentHash: text(get("ContentHash") ?? row.content_hash), docId: text(get("DocId") ?? row.doc_id), sourceUrl: optional(get("SourceUrl") ?? row.source_url), contentUrl: optional(get("ContentUrl") ?? row.content_url), sourceTitle: optional(get("SourceTitle") ?? row.source_title), sourceName: optional(get("SourceName") ?? row.source_name), publishedAt: optional(get("PublishedAt") ?? row.published_at), sourceLocator: text(get("SourceLocator") ?? row.source_locator), createdAt: number(get("CreatedAt") ?? row.created_at) };
}
function requiredStatus(value: unknown): GovernanceCapitalFactStatus { const result = String(value ?? "").trim(); if (!["verified", "unavailable", "conflicting"].includes(result)) throw new Error("factStatus is invalid"); return result as GovernanceCapitalFactStatus; }
function requiredSourceAuthority(value: unknown): GovernanceCapitalSourceAuthority { const result = String(value ?? "").trim(); if (!["issuer_disclosure", "exchange_filing", "regulator_or_court", "audit_report"].includes(result)) throw new Error("sourceAuthority is invalid"); return result as GovernanceCapitalSourceAuthority; }
function array(value: unknown): string[] { try { const parsed = JSON.parse(String(value ?? "[]")); return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : []; } catch { return []; } }
function required(value: string | null | undefined, label: string): string { const result = String(value ?? "").trim(); if (!result) throw new Error(`${label} is required`); return result; }
function text(value: unknown): string { return required(value === null || value === undefined ? "" : String(value), "stored governance/capital text"); }
function optional(value: unknown): string | null { const result = String(value ?? "").trim(); return result || null; }
function number(value: unknown): number { const result = Number(value); if (!Number.isFinite(result)) throw new Error("stored governance/capital timestamp is invalid"); return result; }
function numericOrNull(value: unknown): number | null { return value === null || value === undefined ? null : number(value); }
function boundedLimit(value: number): number { return Math.min(500, Math.max(1, Math.floor(value))); }
