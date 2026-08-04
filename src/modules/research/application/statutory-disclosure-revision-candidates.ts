import revisionSignals from "../../../../config/research-statutory-disclosure-revision-signals.v1.json";

type Registry = "cninfo" | "hkex";
type Row = Record<string, unknown>;
type Decision = "confirmed_financial_restatement" | "not_financial_correction" | "needs_evidence";
export type StatutoryDisclosureRevisionCandidate = {
  candidateId: string; registry: Registry; securityCode: string; documentId: string; title: string; publishedAt: string; documentUrl: string; sourceLocator: string;
  reportPeriod: string | null; candidateSignals: string[]; ruleVersion: string; discoveredAt: number; latestReview: StatutoryDisclosureRevisionReview | null;
};
export type StatutoryDisclosureRevisionReview = { reviewId: string; candidateId: string; decision: Decision; originalDocumentId: string | null; affectedScope: string | null; reviewer: string; reason: string; reviewedAt: number; createdAt: number };

const config = revisionSignals as { version: string; registries: Record<Registry, { include: string[]; exclude: string[]; periodPatterns: string[] }> };

/** Pure title classification: it discovers a review candidate, never a restatement. */
export function classifyStatutoryDisclosureRevisionCandidate(input: { registry: Registry; securityCode: string; documentId: string; title: string; publishedAt: string; documentUrl: string; sourceLocator: string }) {
  const rules = config.registries[input.registry]; const lower = input.title.toLowerCase();
  const excluded = rules.exclude.find((signal) => lower.includes(signal.toLowerCase()));
  const signals = rules.include.filter((signal) => lower.includes(signal.toLowerCase()));
  if (excluded || !signals.length) return null;
  const reportPeriod = parsePeriod(input.title, input.registry, rules.periodPatterns);
  return { ...input, reportPeriod, candidateSignals: signals, ruleVersion: config.version };
}

/** Materializes only documents already indexed from the official registry. */
export async function refreshStatutoryDisclosureRevisionCandidates(db: D1Database, securityCode: string, discoveredAt = Date.now()) {
  const documents = await db.prepare(`select registry, security_code as securityCode, document_id as documentId, title, published_at as publishedAt, document_url as documentUrl, source_locator as sourceLocator from research_statutory_disclosure_documents where security_code=? and registry in ('cninfo','hkex') order by published_at desc, document_id`).bind(securityCode).all<Row>();
  const candidates = documents.results.flatMap((row) => {
    const registry = String(row.registry) as Registry;
    return registry === "cninfo" || registry === "hkex" ? [classifyStatutoryDisclosureRevisionCandidate({ registry, securityCode: text(row.securityCode), documentId: text(row.documentId), title: text(row.title), publishedAt: text(row.publishedAt), documentUrl: text(row.documentUrl), sourceLocator: text(row.sourceLocator) })].filter(Boolean) : [];
  });
  let createdCount = 0;
  for (const candidate of candidates) {
    const id = `statutory-revision:${candidate!.registry}:${candidate!.securityCode}:${candidate!.documentId}:${candidate!.ruleVersion}`;
    const result = await db.prepare(`insert or ignore into research_statutory_disclosure_revision_candidates (
      candidate_id, registry, security_code, document_id, title, published_at, document_url, source_locator, report_period, candidate_signals_json, rule_version, discovered_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, candidate!.registry, candidate!.securityCode, candidate!.documentId, candidate!.title, candidate!.publishedAt, candidate!.documentUrl, candidate!.sourceLocator, candidate!.reportPeriod, JSON.stringify(candidate!.candidateSignals), candidate!.ruleVersion, discoveredAt).run();
    createdCount += Number(result.meta.changes ?? 0);
  }
  return { scannedDocumentCount: documents.results.length, matchedCount: candidates.length, createdCount, ruleVersion: config.version };
}

export async function loadStatutoryDisclosureRevisionCandidates(db: D1Database, securityCode: string): Promise<{ availability: "available" | "empty" | "unavailable"; reason: string | null; items: StatutoryDisclosureRevisionCandidate[] }> {
  try {
    const rows = await db.prepare(`select c.*, r.review_id as reviewId, r.decision, r.original_document_id as originalDocumentId, r.affected_scope as affectedScope, r.reviewer, r.reason as reviewReason, r.reviewed_at as reviewedAt, r.created_at as reviewCreatedAt
      from research_statutory_disclosure_revision_candidates c left join research_statutory_disclosure_revision_reviews r on r.review_id=(select review_id from research_statutory_disclosure_revision_reviews where candidate_id=c.candidate_id order by reviewed_at desc, created_at desc, review_id desc limit 1)
      where c.security_code=? order by c.published_at desc, c.discovered_at desc`).bind(securityCode).all<Row>();
    return { availability: rows.results.length ? "available" : "empty", reason: rows.results.length ? null : "no_candidates", items: rows.results.map(mapCandidate) };
  } catch (error) { if (/no such table|does not exist|not found/i.test(String(error))) return { availability: "unavailable", reason: "storage_not_initialized", items: [] }; throw error; }
}

export async function reviewStatutoryDisclosureRevisionCandidate(db: D1Database, securityCode: string, input: { reviewId: string; candidateId: string; decision: Decision; originalDocumentId?: string | null; affectedScope?: string | null; reviewer: string; reason: string; reviewedAt?: number }) {
  const candidate = await db.prepare(`select * from research_statutory_disclosure_revision_candidates where candidate_id=? and security_code=?`).bind(input.candidateId, securityCode).first<Row>();
  if (!candidate) throw new Error("statutory revision candidate was not found for this security");
  const now = input.reviewedAt ?? Date.now(); const decision = input.decision;
  if (!(["confirmed_financial_restatement", "not_financial_correction", "needs_evidence"] as string[]).includes(decision)) throw new Error("invalid statutory revision review decision");
  if (!text(input.reviewId) || !text(input.reviewer) || !text(input.reason)) throw new Error("revision review id, reviewer and reason are required");
  const originalDocumentId = optional(input.originalDocumentId);
  const affectedScope = optional(input.affectedScope);
  if (decision === "confirmed_financial_restatement") {
    if (!originalDocumentId || originalDocumentId === text(candidate.document_id) || !affectedScope) throw new Error("confirmed financial restatement requires a distinct originalDocumentId and affectedScope");
    const original = await db.prepare(`select 1 as present from research_statutory_disclosure_documents where registry=? and security_code=? and document_id=?`).bind(candidate.registry, securityCode, originalDocumentId).first<{ present: number }>();
    if (!original) throw new Error("originalDocumentId must be an indexed official document for this security and registry");
  } else if (originalDocumentId || affectedScope) throw new Error("only confirmed financial restatement may declare an original document or affected scope");
  await db.prepare(`insert into research_statutory_disclosure_revision_reviews (review_id, candidate_id, decision, original_document_id, affected_scope, reviewer, reason, reviewed_at, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(input.reviewId, input.candidateId, decision, originalDocumentId, affectedScope, input.reviewer.trim(), input.reason.trim(), now, now).run();
  return { reviewId: input.reviewId, candidateId: input.candidateId, decision, originalDocumentId, affectedScope, reviewedAt: now };
}

/** Acceptance of a primary/statutory matching actual stops until potentially relevant official corrections are reviewed. */
export async function assertNoUnreviewedStatutoryRevisionCandidate(db: D1Database, securityCode: string, fiscalPeriod: string): Promise<void> {
  try {
    const year = /^([0-9]{4})/.exec(fiscalPeriod)?.[1] ?? null;
    if (!year) return;
    const row = await db.prepare(`select c.candidate_id as candidateId from research_statutory_disclosure_revision_candidates c
      where c.security_code=? and (c.report_period like ? or c.report_period is null) and not exists (select 1 from research_statutory_disclosure_revision_reviews r where r.candidate_id=c.candidate_id)
      order by c.published_at desc limit 1`).bind(securityCode, `${year}%`).first<{ candidateId: string }>();
    if (row) throw new Error(`formal actual acceptance is blocked by unreviewed possible statutory restatement: ${row.candidateId}`);
  } catch (error) { if (/no such table|does not exist|not found/i.test(String(error))) return; throw error; }
}

function parsePeriod(title: string, registry: Registry, patterns: string[]): string | null {
  for (const source of patterns) { const match = new RegExp(source, "i").exec(title); if (!match) continue; const year = match[1]; const token = (match[2] ?? "").toLowerCase(); if (/年度|annual|results/.test(title.toLowerCase())) return `${year}FY`; if (/半年度|interim|half|six months/.test(title.toLowerCase())) return `${year}H1`; if (/三|third|nine months/.test(token || title.toLowerCase())) return `${year}Q3`; if (/二|second|half/.test(token || title.toLowerCase())) return `${year}Q2`; return `${year}Q1`; }
  return null;
}
function mapCandidate(row: Row): StatutoryDisclosureRevisionCandidate { const review = row.reviewId ? { reviewId: text(row.reviewId), candidateId: text(row.candidate_id), decision: text(row.decision) as Decision, originalDocumentId: optional(row.originalDocumentId), affectedScope: optional(row.affectedScope), reviewer: text(row.reviewer), reason: text(row.reviewReason), reviewedAt: number(row.reviewedAt), createdAt: number(row.reviewCreatedAt) } : null; return { candidateId: text(row.candidate_id), registry: text(row.registry) as Registry, securityCode: text(row.security_code), documentId: text(row.document_id), title: text(row.title), publishedAt: text(row.published_at), documentUrl: text(row.document_url), sourceLocator: text(row.source_locator), reportPeriod: optional(row.report_period), candidateSignals: JSON.parse(text(row.candidate_signals_json)), ruleVersion: text(row.rule_version), discoveredAt: number(row.discovered_at), latestReview: review }; }
function text(value: unknown): string { const result = String(value ?? "").trim(); if (!result) throw new Error("stored statutory revision value missing"); return result; } function optional(value: unknown): string | null { const result = String(value ?? "").trim(); return result || null; } function number(value: unknown): number { const result = Number(value); if (!Number.isFinite(result)) throw new Error("stored statutory revision number invalid"); return result; }
