import type { ForecastAccountingBasis, ForecastMetric, ForecastOwnershipBasis, ForecastShareBasis } from "../domain/forecast-consolidation";
import {
  FORMAL_ACTUAL_CANDIDATE_RULE_VERSION,
  FORMAL_FINANCIAL_FACT_DICTIONARY_VERSION,
  formalFinancialFactDictionaryEntry,
  type FormalActualCandidate,
  type FormalActualCandidateDecision,
  type FormalActualCandidateReview,
  type ModelReviewItemState,
  type ResearchModelReviewAction,
  type ResearchModelReviewItem,
} from "../domain/formal-actual-candidate";
import { loadFinancialStatutoryVerifications } from "./financial-statutory-verification";
import { createForecastActualCalibration, registerFormalActual, type FormalActualRegistrationWrite } from "./forecast-actual-calibration";
import { assertNoUnreviewedStatutoryRevisionCandidate } from "./statutory-disclosure-revision-candidates";

type Row = Record<string, unknown>;

export type FormalActualCandidateMaterialization = {
  /** Stable, normalized scope requested by the local operator. */
  securityCodes: string[];
  scannedVerificationCount: number;
  createdCount: number;
  existingCount: number;
  readyForReviewCount: number;
  blockedCount: number;
  /** Blocked statutory comparisons remain auditable in verification/source health. */
  blockedByReason: Array<{ reason: string; count: number }>;
  created: FormalActualCandidate[];
};

/**
 * Materializes candidates only from immutable statutory comparisons already in
 * D1.  It deliberately performs no fetch and never upgrades conflict or
 * unverified rows to an actual.
 */
export async function refreshFormalActualCandidates(db: D1Database, securityCode: string, createdAt = Date.now()): Promise<FormalActualCandidate[]> {
  return (await materializeFormalActualCandidates(db, [securityCode], createdAt)).created;
}

/**
 * Deterministically scans the already-persisted statutory comparisons for an
 * explicit local batch.  It does not fetch providers, create actual facts,
 * change scenarios/models, or promote a candidate: those all require later,
 * separate human review flows.
 *
 * The scan pages over every immutable verification rather than treating the
 * first 500 observations as a complete history.  Its result reports both
 * newly persisted and already-present reviewable candidates, so a repeated
 * run is observably idempotent. Blocked statutory comparisons remain in the
 * immutable verification ledger/source health; they are not review-queue
 * candidates and cannot crowd out actionable human review.
 */
export async function materializeFormalActualCandidates(
  db: D1Database,
  securityCodes: readonly string[],
  createdAt = Date.now(),
): Promise<FormalActualCandidateMaterialization> {
  const scope = [...new Set(securityCodes.map((value) => value.trim()).filter(Boolean))].sort();
  if (!scope.length) throw new Error("at least one security code is required for formal actual candidate materialization");
  const created: FormalActualCandidate[] = [];
  let scannedVerificationCount = 0;
  let existingCount = 0;
  let readyForReviewCount = 0;
  let blockedCount = 0;
  const blockedReasons = new Map<string, number>();

  for (const securityCode of scope) {
    const verifications = await loadAllFinancialStatutoryVerifications(db, securityCode);
    for (const verification of verifications) {
      scannedVerificationCount += 1;
    const candidate = materializeFormalActualCandidate(verification, createdAt);
      if (candidate.eligibility === "ready_for_review") readyForReviewCount += 1;
      else {
        blockedCount += 1;
        const reason = candidate.blockingReason || "candidate_basis_invalid";
        blockedReasons.set(reason, (blockedReasons.get(reason) ?? 0) + 1);
        continue;
      }
      const result = await db.prepare(`insert or ignore into research_formal_actual_candidates (
      candidate_id, security_code, verification_id, canonical_comparison_key, metric, forecast_metric, fiscal_year, fiscal_period,
      period_start_date, period_end_date, reported_value, reported_unit, currency, statutory_provider,
      statutory_document_id, statutory_disclosure_url, statutory_locator, statutory_published_at, statutory_report_date,
      source_binding_json, candidate_rule_version, eligibility, blocking_reason, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(candidate.candidateId, candidate.securityCode, candidate.verificationId, candidate.canonicalComparisonKey, candidate.metric, candidate.forecastMetric,
        candidate.fiscalYear, candidate.fiscalPeriod, candidate.periodStartDate, candidate.periodEndDate,
        candidate.reportedValue, candidate.reportedUnit, candidate.currency, candidate.statutoryProvider,
        candidate.statutoryDocumentId, candidate.statutoryDisclosureUrl, candidate.statutoryLocator,
        candidate.statutoryPublishedAt, candidate.statutoryReportDate, JSON.stringify(candidate.sourceBinding),
        candidate.candidateRuleVersion, candidate.eligibility, candidate.blockingReason, candidate.createdAt).run();
      if (result.meta.changes) created.push(candidate);
      else existingCount += 1;
      if (candidate.factDictionaryEntryId && candidate.factDictionaryVersion) {
        await db.prepare(`insert or ignore into research_formal_actual_candidate_dictionary_bindings (
        candidate_id, fact_dictionary_entry_id, fact_dictionary_version, bound_at
      ) values (?, ?, ?, ?)`)
          .bind(candidate.candidateId, candidate.factDictionaryEntryId, candidate.factDictionaryVersion, candidate.createdAt).run();
      }
    }
  }
  return {
    securityCodes: scope,
    scannedVerificationCount,
    createdCount: created.length,
    existingCount,
    readyForReviewCount,
    blockedCount,
    blockedByReason: [...blockedReasons.entries()].map(([reason, count]) => ({ reason, count })).sort((left, right) => left.reason.localeCompare(right.reason)),
    created,
  };
}

/**
 * Fully automatic bridge from an already matched statutory field to a formal
 * actual and its historical forecast calibrations.  It is deliberately
 * narrower than the legacy candidate-review route: the rule may only admit a
 * metric when its accounting and ownership basis are deterministically fixed
 * by the source contract.  Anything else stays source-visible and blocked;
 * there is no operator queue or silent semantic choice.
 */
export async function syncAutomaticFormalActuals(
  db: D1Database,
  securityCode: string,
  createdAt = Date.now(),
): Promise<{
  materialization: FormalActualCandidateMaterialization;
  acceptedActualIds: string[];
  calibrationIds: string[];
  blocked: Array<{ candidateId: string; reason: string }>;
}> {
  const code = securityCode.trim().toUpperCase();
  const materialization = await materializeFormalActualCandidates(db, [code], createdAt);
  const candidates = await loadFormalActualCandidates(db, code);
  const acceptedActualIds: string[] = [];
  const calibrationIds: string[] = [];
  const blocked: Array<{ candidateId: string; reason: string }> = [];

  for (const candidate of candidates) {
    const existingDecision = await db.prepare(`select decision from research_formal_actual_candidate_reviews
      where candidate_id=? order by reviewed_at desc, review_id desc limit 1`).bind(candidate.candidateId).first<{ decision: string }>();
    if (existingDecision) continue;
    const basisResolution = await automaticBasis(db, candidate);
    if (!basisResolution.basis) {
      blocked.push({ candidateId: candidate.candidateId, reason: basisResolution.reason });
      continue;
    }
    const basis = basisResolution.basis;
    const currentnessBlock = await automaticCandidateCurrentnessBlock(db, candidate);
    if (currentnessBlock) {
      blocked.push({ candidateId: candidate.candidateId, reason: currentnessBlock });
      continue;
    }
    const currentActual = await db.prepare(`select actual_id as actualId from research_formal_actuals
      where security_code=? and metric=? and fiscal_period=? and actual_status in ('original','restated') limit 1`)
      .bind(code, candidate.forecastMetric, candidate.fiscalPeriod).first<{ actualId: string }>();
    if (currentActual) {
      blocked.push({ candidateId: candidate.candidateId, reason: "current_formal_actual_already_exists_requires_explicit_restatement_evidence" });
      continue;
    }
    const actualId = `formal-actual:auto:${candidate.candidateId}`;
    const actual = await registerFormalActual(db, {
      actualId,
      securityCode: code,
      companyId: await companyIdForSecurity(db, code),
      metric: candidate.forecastMetric!,
      fiscalYear: candidate.fiscalYear,
      fiscalPeriod: candidate.fiscalPeriod,
      rawValue: candidate.reportedValue!,
      rawUnit: candidate.reportedUnit!,
      currency: candidate.currency!,
      accountingBasis: basis.accountingBasis,
      ownershipBasis: basis.ownershipBasis,
      shareBasis: "unspecified",
      filedAt: candidate.statutoryPublishedAt!,
      sourceStatement: `自动法定字段核验 ${candidate.verificationId}；规则 ${AUTOMATIC_FORMAL_ACTUAL_RULE_VERSION} 仅接受已匹配且口径可机械确定的 ${candidate.metric}。定位：${candidate.statutoryLocator}`,
      sourceReferences: [{ sourceKind: "filing", url: candidate.statutoryDisclosureUrl!, locator: candidate.statutoryLocator! }],
      restatesActualId: null,
      restatementNote: null,
    } satisfies FormalActualRegistrationWrite, createdAt);
    await insertReview(db, {
      reviewId: `formal-actual-auto-decision:${candidate.candidateId}`,
      candidateId: candidate.candidateId,
      decision: "accepted",
      reviewer: `system:${AUTOMATIC_FORMAL_ACTUAL_RULE_VERSION}`,
      reason: `系统按 ${AUTOMATIC_FORMAL_ACTUAL_RULE_VERSION} 自动接受：法定核验为 match，事实字典和可机械确定的会计/所有权口径均完整。`,
      accountingBasis: basis.accountingBasis,
      ownershipBasis: basis.ownershipBasis,
      shareBasis: "unspecified",
      candidate,
      actualId: actual.actualId,
      reviewedAt: createdAt,
    });
    acceptedActualIds.push(actual.actualId);
    calibrationIds.push(...await createAutomaticCalibrations(db, code, actual.actualId, candidate.forecastMetric!, candidate.fiscalPeriod, createdAt));
  }
  return { materialization, acceptedActualIds, calibrationIds, blocked };
}

export const AUTOMATIC_FORMAL_ACTUAL_RULE_VERSION = "formal-actual-auto.v1";

async function automaticBasis(
  db: D1Database,
  candidate: FormalActualCandidate,
): Promise<{ basis: { accountingBasis: ForecastAccountingBasis; ownershipBasis: ForecastOwnershipBasis } | null; reason: string }> {
  if (!candidate.forecastMetric) return { basis: null, reason: "forecast_metric_dictionary_mapping_missing" };
  if (candidate.reportedValue === null || !candidate.reportedUnit || !candidate.currency) return { basis: null, reason: "statutory_value_or_currency_incomplete" };
  if (!candidate.statutoryDisclosureUrl || !candidate.statutoryLocator || !candidate.statutoryPublishedAt) return { basis: null, reason: "statutory_source_binding_incomplete" };
  if (candidate.forecastMetric === "revenue" || candidate.forecastMetric === "operating_cash_flow") {
    return { basis: { accountingBasis: "gaap", ownershipBasis: "unspecified" }, reason: "" };
  }
  if (candidate.forecastMetric !== "net_profit") return { basis: null, reason: "automatic_basis_not_available" };

  // A scope label only becomes a forecast ownership basis when both immutable
  // sides of the statutory comparison carry the *same controlled value*.
  // In particular, do not translate a display label such as "归母净利润" or
  // infer common-shareholder earnings from an ADR, ticker, or report title.
  const verification = await db.prepare(`select outcome, normalized_scope as normalizedScope, statutory_scope as statutoryScope,
      normalized_accounting_standard as normalizedAccountingStandard, statutory_accounting_standard as statutoryAccountingStandard
    from research_financial_statutory_verifications where verification_id=?`)
    .bind(candidate.verificationId).first<{
      outcome: string; normalizedScope: string | null; statutoryScope: string | null;
      normalizedAccountingStandard: string | null; statutoryAccountingStandard: string | null;
    }>();
  if (!verification || verification.outcome !== "match") return { basis: null, reason: "statutory_match_no_longer_available" };
  if (!sameControlledBasis(verification.normalizedAccountingStandard, verification.statutoryAccountingStandard)) {
    return { basis: null, reason: "accounting_basis_not_machine_resolved" };
  }
  if (!sameControlledBasis(verification.normalizedScope, verification.statutoryScope)) {
    return { basis: null, reason: "ownership_basis_source_scope_conflict" };
  }
  const ownershipBasis = ownershipBasisFromControlledScope(verification.statutoryScope);
  if (!ownershipBasis) return { basis: null, reason: "ownership_basis_not_machine_resolved" };
  return { basis: { accountingBasis: "gaap", ownershipBasis }, reason: "" };
}

function sameControlledBasis(left: unknown, right: unknown): boolean {
  const normalizedLeft = String(left || "").trim();
  const normalizedRight = String(right || "").trim();
  return Boolean(normalizedLeft) && normalizedLeft === normalizedRight;
}

function ownershipBasisFromControlledScope(value: unknown): ForecastOwnershipBasis | null {
  const scope = String(value || "").trim();
  if (scope === "consolidated") return "consolidated";
  if (scope === "attributable_to_parent") return "attributable_to_parent";
  if (scope === "common_shareholders") return "common_shareholders";
  return null;
}

async function automaticCandidateCurrentnessBlock(db: D1Database, candidate: FormalActualCandidate): Promise<string | null> {
  if (!candidate.statutoryDocumentId || !candidate.statutoryPublishedAt) return "statutory_source_binding_incomplete";
  // A later document is an objectively newer input. A same-day different
  // document has no deterministic order in the source contract, so neither
  // may be silently selected by the automatic pipeline.
  const [later, sameDay] = await Promise.all([
    db.prepare(`select candidate_id as candidateId from research_formal_actual_candidates
      where security_code=? and metric=? and fiscal_period=? and statutory_document_id is not null
        and statutory_document_id<>? and statutory_published_at>?
      order by statutory_published_at desc, created_at desc limit 1`)
      .bind(candidate.securityCode, candidate.metric, candidate.fiscalPeriod, candidate.statutoryDocumentId, candidate.statutoryPublishedAt)
      .first<{ candidateId: string }>(),
    db.prepare(`select candidate_id as candidateId from research_formal_actual_candidates
      where security_code=? and metric=? and fiscal_period=? and statutory_document_id is not null
        and statutory_document_id<>? and statutory_published_at=?
      order by created_at desc limit 1`)
      .bind(candidate.securityCode, candidate.metric, candidate.fiscalPeriod, candidate.statutoryDocumentId, candidate.statutoryPublishedAt)
      .first<{ candidateId: string }>(),
  ]);
  if (later) return "newer_statutory_document_available";
  if (sameDay) return "same_day_statutory_document_order_ambiguous";
  return null;
}

async function createAutomaticCalibrations(
  db: D1Database,
  securityCode: string,
  actualId: string,
  metric: ForecastMetric,
  fiscalPeriod: string,
  createdAt: number,
): Promise<string[]> {
  const forecastRows = await db.prepare(`select 'third_party_forecast' as forecastKind, forecast_id as forecastId
      from research_source_forecasts where security_code=? and metric=? and fiscal_period=?
    union all
    select 'management_guidance' as forecastKind, guidance_forecast_id as forecastId
      from research_management_guidance_forecasts where security_code=? and metric=? and fiscal_period=?`)
    .bind(securityCode, metric, fiscalPeriod, securityCode, metric, fiscalPeriod).all<{ forecastKind: "third_party_forecast" | "management_guidance"; forecastId: string }>();
  const calibrationIds: string[] = [];
  for (const forecast of forecastRows.results) {
    const prior = await db.prepare(`select calibration_id as calibrationId from research_forecast_actual_calibration_records
      where forecast_kind=? and forecast_id=? and actual_id=?`).bind(forecast.forecastKind, forecast.forecastId, actualId).first<{ calibrationId: string }>();
    if (prior) continue;
    const calibrationId = `formal-actual-auto-calibration:${forecast.forecastKind}:${forecast.forecastId}:${actualId}`;
    await createForecastActualCalibration(db, { calibrationId, securityCode, forecastKind: forecast.forecastKind, forecastId: forecast.forecastId, actualId, calibratedAt: createdAt });
    calibrationIds.push(calibrationId);
  }
  return calibrationIds;
}

/** Returns only candidates eligible for human review; blocked comparisons are source-health evidence, not queue items. */
export async function loadFormalActualCandidates(db: D1Database, securityCode: string): Promise<FormalActualCandidate[]> {
  const rows = await db.prepare(`select c.*, d.fact_dictionary_entry_id, d.fact_dictionary_version
    from research_formal_actual_candidates c
    left join research_formal_actual_candidate_dictionary_bindings d on d.candidate_id=c.candidate_id
    where c.security_code=? and c.eligibility='ready_for_review' order by c.fiscal_year desc, c.created_at desc`)
    .bind(securityCode).all<Row>();
  return rows.results.map(mapCandidate);
}

export type ReviewFormalActualCandidateInput = {
  reviewId: string;
  candidateId: string;
  decision: FormalActualCandidateDecision;
  reviewer: string;
  reason: string;
  accountingBasis?: ForecastAccountingBasis;
  ownershipBasis?: ForecastOwnershipBasis;
  shareBasis?: ForecastShareBasis;
  restatesActualId?: string | null;
  restatementNote?: string | null;
  reviewedAt?: number;
};

/**
 * The reviewer can decide semantic comparability, but never supplies a value,
 * period, filing URL or locator.  Accepted facts are assembled server-side
 * from the immutable candidate and retain the review link in the audit table.
 */
export async function reviewFormalActualCandidate(
  db: D1Database,
  securityCode: string,
  input: ReviewFormalActualCandidateInput,
): Promise<{ review: FormalActualCandidateReview; actualId: string | null }> {
  const candidate = await loadCandidate(db, input.candidateId, securityCode);
  const now = input.reviewedAt ?? Date.now();
  assertText(input.reviewId, "reviewId"); assertText(input.reviewer, "reviewer"); assertText(input.reason, "reason");
  if (!(["accepted", "rejected", "needs_evidence"] as const).includes(input.decision)) throw new Error("unsupported candidate review decision");
  if (candidate.eligibility !== "ready_for_review") {
    throw new Error("candidate is not eligible for review; inspect immutable statutory verification/source health instead");
  }
  if (input.decision !== "accepted") {
    await insertReview(db, { ...input, candidate, actualId: null, reviewedAt: now });
    return { review: await loadCandidateReview(db, input.reviewId), actualId: null };
  }
  if (candidate.eligibility !== "ready_for_review" || !candidate.forecastMetric || candidate.reportedValue === null || !candidate.reportedUnit || !candidate.currency || !candidate.statutoryDisclosureUrl || !candidate.statutoryLocator || !candidate.statutoryPublishedAt) {
    throw new Error(`candidate is not eligible for acceptance: ${candidate.blockingReason || "missing statutory evidence"}`);
  }
  const dictionary = formalFinancialFactDictionaryEntry(candidate.metric);
  if (!dictionary || dictionary.entryId !== candidate.factDictionaryEntryId
    || candidate.factDictionaryVersion !== FORMAL_FINANCIAL_FACT_DICTIONARY_VERSION
    || dictionary.forecastMetric !== candidate.forecastMetric) {
    throw new Error("candidate formal fact dictionary mapping is unavailable or has changed; materialize a new statutory verification candidate");
  }
  const requiresOwnershipBasis = dictionary.requiredSemanticConfirmations.some((confirmation: string) => confirmation === "ownership_basis");
  const accountingBasis = requiredEnum(input.accountingBasis, ["gaap", "non_gaap", "adjusted", "unspecified"] as const, "accountingBasis");
  const ownershipBasis = requiresOwnershipBasis
    ? requiredEnum(input.ownershipBasis, ["attributable_to_parent", "consolidated", "common_shareholders", "unspecified"] as const, "ownershipBasis")
    : optionalEnum(input.ownershipBasis, ["attributable_to_parent", "consolidated", "common_shareholders", "unspecified"] as const, "ownershipBasis") ?? "unspecified";
  const shareBasis = optionalEnum(input.shareBasis, ["basic", "diluted", "unspecified"] as const, "shareBasis") ?? "unspecified";
  if (accountingBasis === "unspecified") throw new Error("accountingBasis must be confirmed for an accepted formal actual");
  if (requiresOwnershipBasis && ownershipBasis === "unspecified") {
    throw new Error("ownershipBasis must be confirmed for this formal financial fact");
  }
  // A later statutory document for the same field/period is evidence that
  // this frozen candidate is no longer the latest filing observation.  Do
  // not let an operator accept an older value simply because it happened to
  // be materialized first; same-day document ambiguity remains visible in
  // the read-model but is not guessed into an ordering here.
  await assertCandidateHasNoLaterStatutoryDocument(db, candidate);
  await assertNoUnreviewedStatutoryRevisionCandidate(db, securityCode, candidate.fiscalPeriod);
  if (input.restatesActualId) await assertRestatementCandidateLineage(db, securityCode, input.restatesActualId);
  const actualId = `formal-actual:${input.candidateId}`;
  const actual = await registerFormalActual(db, {
    actualId, securityCode, companyId: await companyIdForSecurity(db, securityCode), metric: candidate.forecastMetric,
    fiscalYear: candidate.fiscalYear, fiscalPeriod: candidate.fiscalPeriod, rawValue: candidate.reportedValue,
    rawUnit: candidate.reportedUnit, currency: candidate.currency, accountingBasis, ownershipBasis, shareBasis,
    filedAt: candidate.statutoryPublishedAt,
    sourceStatement: `法定字段核验候选 ${candidate.verificationId}；${candidate.statutoryProvider} ${candidate.metric}，定位：${candidate.statutoryLocator}`,
    sourceReferences: [{ sourceKind: "filing", url: candidate.statutoryDisclosureUrl, locator: candidate.statutoryLocator }],
    restatesActualId: input.restatesActualId ?? null, restatementNote: input.restatementNote ?? null,
  } satisfies FormalActualRegistrationWrite, now);
  await insertReview(db, {
    ...input, accountingBasis, ownershipBasis, shareBasis, candidate, actualId: actual.actualId, reviewedAt: now,
  });
  await enqueueModelReviews(db, securityCode, input.restatesActualId ? "actual_restatement" : "formal_actual_accepted", actual.actualId,
    input.restatesActualId ? "已确认的法定实际为重述；旧模型不被改写，但必须人工判断是否重建。" : "已确认新的法定实际；现有模型不被改写，但应检查观察锚定和假设。",
    { candidateId: candidate.candidateId, verificationId: candidate.verificationId, actualId: actual.actualId, fiscalPeriod: candidate.fiscalPeriod }, now);
  return { review: await loadCandidateReview(db, input.reviewId), actualId: actual.actualId };
}

export async function loadCandidateReviews(db: D1Database, securityCode: string): Promise<FormalActualCandidateReview[]> {
  const rows = await db.prepare(`select r.* from research_formal_actual_candidate_reviews r
    join research_formal_actual_candidates c on c.candidate_id=r.candidate_id where c.security_code=? order by r.reviewed_at desc`).bind(securityCode).all<Row>();
  return rows.results.map(mapReview);
}

export async function enqueueModelReviews(db: D1Database, securityCode: string, triggerKind: ResearchModelReviewItem["triggerKind"], triggerId: string, reason: string, evidence: Record<string, unknown>, createdAt = Date.now()): Promise<number> {
  const targets = await db.batch([
    db.prepare(`select model_version_id as id, 'dcf' as kind from research_valuation_model_versions where security_code=? and status<>'superseded'`).bind(securityCode),
    db.prepare(`select model_version_id as id, 'reverse_dcf' as kind from research_reverse_valuation_model_versions where security_code=? and status<>'superseded'`).bind(securityCode),
    db.prepare(`select scenario_id as id, 'scenario' as kind from research_forecast_scenarios where security_code=? and status<>'superseded'`).bind(securityCode),
  ]);
  const all = targets.flatMap((result) => (result.results as Row[]));
  let created = 0;
  for (const target of all) {
    const targetVersionId = String(target.id); const targetKind = String(target.kind);
    const result = await db.prepare(`insert or ignore into research_model_review_items (
      review_item_id, security_code, trigger_kind, trigger_id, target_kind, target_version_id, state, reason, evidence_json, created_at
    ) values (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`)
      .bind(`model-review:${triggerKind}:${triggerId}:${targetKind}:${targetVersionId}`, securityCode, triggerKind, triggerId, targetKind, targetVersionId, reason, JSON.stringify(evidence), createdAt).run();
    created += result.meta.changes || 0;
  }
  return created;
}

/**
 * Writes review items only for versions explicitly selected by a source-impact
 * mapping.  This is intentionally separate from the derived all-version
 * queue used when an actual is first accepted: an impact rationale must never
 * silently widen its target set.
 */
export async function enqueueSelectedModelReviews(
  db: D1Database,
  input: {
    securityCode: string;
    triggerKind: ResearchModelReviewItem["triggerKind"];
    triggerId: string;
    reason: string;
    evidence: Record<string, unknown>;
    targets: Array<{ targetKind: "dcf" | "reverse_dcf" | "scenario"; targetVersionId: string }>;
    createdAt: number;
  },
): Promise<number> {
  let created = 0;
  for (const target of input.targets) {
    const result = await db.prepare(`insert or ignore into research_model_review_items (
      review_item_id, security_code, trigger_kind, trigger_id, target_kind, target_version_id, state, reason, evidence_json, created_at
    ) values (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`)
      .bind(`model-review:${input.triggerKind}:${input.triggerId}:${target.targetKind}:${target.targetVersionId}`, input.securityCode,
        input.triggerKind, input.triggerId, target.targetKind, target.targetVersionId, input.reason,
        JSON.stringify(input.evidence), input.createdAt).run();
    created += result.meta.changes || 0;
  }
  return created;
}

export async function loadModelReviewItems(db: D1Database, securityCode: string): Promise<ResearchModelReviewItem[]> {
  const rows = await db.prepare(`select * from research_model_review_items where security_code=? order by case state when 'open' then 0 else 1 end, created_at desc`).bind(securityCode).all<Row>();
  return rows.results.map(mapModelReview);
}

export type ResolveModelReviewItemInput = {
  actionId: string;
  state: Exclude<ModelReviewItemState, "open">;
  resolutionNote: string;
  actedBy: string;
  followUpTargetKind?: "dcf" | "reverse_dcf" | "scenario" | null;
  followUpTargetVersionId?: string | null;
  reviewedAt?: number;
};

export async function resolveModelReviewItem(db: D1Database, securityCode: string, reviewItemId: string, input: ResolveModelReviewItemInput): Promise<ResearchModelReviewItem> {
  if (!(["acknowledged", "resolved", "not_applicable"] as const).includes(input.state)) throw new Error("invalid model review state");
  assertText(input.actionId, "actionId"); assertText(input.resolutionNote, "resolutionNote"); assertText(input.actedBy, "actedBy");
  const followUpTargetKind = input.followUpTargetKind ?? null;
  const followUpTargetVersionId = input.followUpTargetVersionId?.trim() || null;
  if ((followUpTargetKind === null) !== (followUpTargetVersionId === null)) throw new Error("follow-up target kind and version must be provided together");
  if (followUpTargetKind && !(["dcf", "reverse_dcf", "scenario"] as const).includes(followUpTargetKind)) throw new Error("invalid follow-up target kind");
  const reviewedAt = input.reviewedAt ?? Date.now();
  if (!Number.isInteger(reviewedAt) || reviewedAt <= 0) throw new Error("reviewedAt must be a positive integer timestamp");
  const existing = await db.prepare(`select state from research_model_review_items where review_item_id=? and security_code=?`).bind(reviewItemId, securityCode).first<Row>();
  if (!existing || existing.state !== "open") throw new Error("open model review item not found");
  await db.batch([
    db.prepare(`update research_model_review_items set state=?, reviewed_at=?, resolution_note=? where review_item_id=? and security_code=? and state='open'`)
      .bind(input.state, reviewedAt, input.resolutionNote, reviewItemId, securityCode),
    db.prepare(`insert into research_model_review_item_actions (
      action_id, review_item_id, previous_state, next_state, acted_by, resolution_note, follow_up_target_kind, follow_up_target_version_id, acted_at
    ) values (?, ?, 'open', ?, ?, ?, ?, ?, ?)`)
      .bind(input.actionId, reviewItemId, input.state, input.actedBy, input.resolutionNote, followUpTargetKind, followUpTargetVersionId, reviewedAt),
  ]);
  const item = (await loadModelReviewItems(db, securityCode)).find((value) => value.reviewItemId === reviewItemId);
  if (!item) throw new Error("model review item not found after update");
  return item;
}

export async function loadModelReviewActions(db: D1Database, securityCode: string): Promise<ResearchModelReviewAction[]> {
  const rows = await db.prepare(`select a.* from research_model_review_item_actions a
    join research_model_review_items i on i.review_item_id=a.review_item_id
    where i.security_code=? order by a.acted_at desc, a.action_id desc`).bind(securityCode).all<Row>();
  return rows.results.map(mapModelReviewAction);
}

/** Pure materializer used by refresh and tests; it never fetches or writes. */
export function materializeFormalActualCandidate(verification: Awaited<ReturnType<typeof loadFinancialStatutoryVerifications>>[number], createdAt: number): FormalActualCandidate {
  const metric = verification.normalizedFact.metric;
  const dictionary = formalFinancialFactDictionaryEntry(metric);
  const forecastMetric = dictionary?.forecastMetric ?? null;
  const disclosure = verification.statutoryDisclosure;
  const failure = verification.outcome !== "match" ? `statutory_${verification.outcome}`
    : !forecastMetric ? "metric_requires_explicit_dictionary_mapping"
      : disclosure?.value === null || disclosure?.value === undefined ? "statutory_value_missing"
        : !hasCompleteStatutoryBasis(disclosure?.basis) ? "statutory_basis_incomplete"
          : !hasValidPeriod(verification.normalizedFact.period.startDate, verification.normalizedFact.period.endDate, verification.normalizedFact.period.fiscalYear) ? "normalized_period_invalid"
            : !disclosure.documentId || !disclosure.disclosureUrl || !disclosure.locator || !disclosure.publishedAt || !disclosure.reportDate ? "statutory_locator_incomplete" : null;
  return {
    candidateId: `formal-actual-candidate:${verification.verificationId}`, securityCode: verification.securityCode,
    verificationId: verification.verificationId, canonicalComparisonKey: verification.normalizedFact.canonicalComparisonKey, metric, forecastMetric,
    factDictionaryEntryId: dictionary?.entryId ?? null, factDictionaryVersion: dictionary ? FORMAL_FINANCIAL_FACT_DICTIONARY_VERSION : null,
    fiscalYear: verification.normalizedFact.period.fiscalYear,
    fiscalPeriod: verification.normalizedFact.period.kind === "annual" ? `${verification.normalizedFact.period.fiscalYear}FY` : `${verification.normalizedFact.period.fiscalYear}Q${verification.normalizedFact.period.fiscalQuarter}`,
    periodStartDate: verification.normalizedFact.period.startDate, periodEndDate: verification.normalizedFact.period.endDate,
    reportedValue: disclosure?.value ?? null, reportedUnit: disclosure?.value === null || disclosure?.value === undefined ? null : dictionary?.rawUnit ?? null,
    currency: disclosure?.basis?.currency ?? null, statutoryProvider: verification.provider, statutoryDocumentId: disclosure?.documentId ?? null,
    statutoryDisclosureUrl: disclosure?.disclosureUrl ?? null, statutoryLocator: disclosure?.locator ?? null,
    statutoryPublishedAt: disclosure?.publishedAt ?? null, statutoryReportDate: disclosure?.reportDate ?? null,
    sourceBinding: candidateSourceBinding(verification, dictionary?.entryId ?? null),
    candidateRuleVersion: FORMAL_ACTUAL_CANDIDATE_RULE_VERSION, eligibility: failure ? "blocked" : "ready_for_review", blockingReason: failure, createdAt,
  };
}

async function loadAllFinancialStatutoryVerifications(db: D1Database, securityCode: string) {
  const all: Awaited<ReturnType<typeof loadFinancialStatutoryVerifications>> = [];
  let offset = 0;
  const pageSize = 500;
  while (true) {
    const page = await loadFinancialStatutoryVerifications(db, securityCode, { limit: pageSize, offset });
    all.push(...page);
    if (page.length < pageSize) return all;
    offset += page.length;
  }
}

function hasCompleteStatutoryBasis(value: { id: string; currency: string; accountingStandard: string; scope: string; revision: string } | null | undefined): boolean {
  return Boolean(value && [value.id, value.currency, value.accountingStandard, value.scope, value.revision].every((part) => part.trim()));
}

function hasValidPeriod(startDate: string, endDate: string, fiscalYear: number): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(startDate) && /^\d{4}-\d{2}-\d{2}$/.test(endDate)
    && startDate <= endDate && Number.isInteger(fiscalYear) && fiscalYear > 1900;
}

function candidateSourceBinding(
  verification: Awaited<ReturnType<typeof loadFinancialStatutoryVerifications>>[number],
  factDictionaryEntryId: string | null,
): Record<string, unknown> {
  const ledgerBinding = verification.metadata.sourceBinding;
  return {
    sourceKind: "financial_statutory_verification",
    verificationId: verification.verificationId,
    verificationRuleVersion: verification.ruleVersion,
    normalizedFactId: verification.normalizedFact.id,
    canonicalComparisonKey: verification.normalizedFact.canonicalComparisonKey,
    sourceMetric: verification.normalizedFact.metric,
    fiscalYear: verification.normalizedFact.period.fiscalYear,
    periodStartDate: verification.normalizedFact.period.startDate,
    periodEndDate: verification.normalizedFact.period.endDate,
    statutoryProvider: verification.provider,
    statutoryDocumentId: verification.statutoryDisclosure?.documentId ?? null,
    statutoryPublishedAt: verification.statutoryDisclosure?.publishedAt ?? null,
    factDictionaryEntryId,
    factDictionaryVersion: factDictionaryEntryId ? FORMAL_FINANCIAL_FACT_DICTIONARY_VERSION : null,
    knowledgeLedgerBinding: ledgerBinding && typeof ledgerBinding === "object" && !Array.isArray(ledgerBinding)
      ? ledgerBinding as Record<string, unknown>
      : { status: "not_bound_to_knowledge_ledger" },
  };
}

async function loadCandidate(db: D1Database, candidateId: string, securityCode: string): Promise<FormalActualCandidate> {
  const row = await db.prepare(`select c.*, d.fact_dictionary_entry_id, d.fact_dictionary_version
    from research_formal_actual_candidates c
    left join research_formal_actual_candidate_dictionary_bindings d on d.candidate_id=c.candidate_id
    where c.candidate_id=? and c.security_code=?`).bind(candidateId, securityCode).first<Row>();
  if (!row) throw new Error("formal actual candidate not found"); return mapCandidate(row);
}
async function insertReview(db: D1Database, input: ReviewFormalActualCandidateInput & { candidate: FormalActualCandidate; actualId: string | null; reviewedAt: number }) {
  await db.prepare(`insert into research_formal_actual_candidate_reviews (
    review_id, candidate_id, decision, reviewer, reason, accounting_basis, ownership_basis, share_basis, actual_id, reviewed_at, created_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(input.reviewId, input.candidate.candidateId, input.decision, input.reviewer, input.reason,
      input.accountingBasis ?? null, input.ownershipBasis ?? null, input.shareBasis ?? null, input.actualId, input.reviewedAt, input.reviewedAt).run();
}
async function loadCandidateReview(db: D1Database, reviewId: string): Promise<FormalActualCandidateReview> {
  const row = await db.prepare(`select * from research_formal_actual_candidate_reviews where review_id=?`).bind(reviewId).first<Row>();
  if (!row) throw new Error("formal actual candidate review not found"); return mapReview(row);
}
async function companyIdForSecurity(db: D1Database, securityCode: string): Promise<string | null> { const row = await db.prepare(`select company_id as companyId from research_listed_securities where security_code=?`).bind(securityCode).first<Row>(); return nullable(row?.companyId); }
async function assertRestatementCandidateLineage(db: D1Database, securityCode: string, actualId: string): Promise<void> {
  const prior = await db.prepare(`select r.actual_id as actualId from research_formal_actual_candidate_reviews r
    join research_formal_actual_candidates c on c.candidate_id=r.candidate_id
    where r.actual_id=? and r.decision='accepted' and c.security_code=? limit 1`).bind(actualId, securityCode).first<Row>();
  if (!prior) throw new Error("restated formal actual must supersede an accepted statutory candidate actual");
}
async function assertCandidateHasNoLaterStatutoryDocument(db: D1Database, candidate: FormalActualCandidate): Promise<void> {
  // Candidate acceptance already requires both values. Keep this guard
  // defensive so a malformed historical row cannot bypass it through a
  // direct API call.
  if (!candidate.statutoryDocumentId || !candidate.statutoryPublishedAt) {
    throw new Error("candidate statutory document metadata is incomplete");
  }
  const later = await db.prepare(`select candidate_id as candidateId, statutory_document_id as statutoryDocumentId,
      statutory_published_at as statutoryPublishedAt
    from research_formal_actual_candidates
    where security_code=? and metric=? and fiscal_period=?
      and statutory_document_id is not null and statutory_document_id<>?
      and statutory_published_at>?
    order by statutory_published_at desc, created_at desc limit 1`)
    .bind(candidate.securityCode, candidate.metric, candidate.fiscalPeriod, candidate.statutoryDocumentId, candidate.statutoryPublishedAt)
    .first<Row>();
  if (later) {
    throw new Error(`candidate is older than a later statutory document (${text(later.candidateId)}; ${text(later.statutoryPublishedAt)}); review the newer filing candidate first`);
  }
}
function mapCandidate(row: Row): FormalActualCandidate {
  const metric = text(row.metric);
  return {
    candidateId: text(row.candidate_id), securityCode: text(row.security_code), verificationId: text(row.verification_id), canonicalComparisonKey: nullable(row.canonical_comparison_key), metric,
    forecastMetric: nullable(row.forecast_metric) as FormalActualCandidate["forecastMetric"],
    factDictionaryEntryId: nullable(row.fact_dictionary_entry_id),
    factDictionaryVersion: nullable(row.fact_dictionary_version),
    fiscalYear: number(row.fiscal_year), fiscalPeriod: text(row.fiscal_period), periodStartDate: text(row.period_start_date), periodEndDate: text(row.period_end_date),
    reportedValue: nullableNumber(row.reported_value), reportedUnit: nullable(row.reported_unit) as "currency" | null, currency: nullable(row.currency),
    statutoryProvider: text(row.statutory_provider), statutoryDocumentId: nullable(row.statutory_document_id), statutoryDisclosureUrl: nullable(row.statutory_disclosure_url),
    statutoryLocator: nullable(row.statutory_locator), statutoryPublishedAt: nullable(row.statutory_published_at), statutoryReportDate: nullable(row.statutory_report_date),
    sourceBinding: json(row.source_binding_json), candidateRuleVersion: text(row.candidate_rule_version),
    eligibility: text(row.eligibility) as FormalActualCandidate["eligibility"], blockingReason: nullable(row.blocking_reason), createdAt: number(row.created_at),
  };
}
function mapReview(row: Row): FormalActualCandidateReview { return { reviewId: text(row.review_id), candidateId: text(row.candidate_id), decision: text(row.decision) as FormalActualCandidateDecision, reviewer: text(row.reviewer), reason: text(row.reason), accountingBasis: nullable(row.accounting_basis) as ForecastAccountingBasis | null, ownershipBasis: nullable(row.ownership_basis) as ForecastOwnershipBasis | null, shareBasis: nullable(row.share_basis) as ForecastShareBasis | null, actualId: nullable(row.actual_id), reviewedAt: number(row.reviewed_at), createdAt: number(row.created_at) }; }
function mapModelReview(row: Row): ResearchModelReviewItem { return { reviewItemId: text(row.review_item_id), securityCode: text(row.security_code), triggerKind: text(row.trigger_kind) as ResearchModelReviewItem["triggerKind"], triggerId: text(row.trigger_id), targetKind: text(row.target_kind) as ResearchModelReviewItem["targetKind"], targetVersionId: text(row.target_version_id), state: text(row.state) as ResearchModelReviewItem["state"], reason: text(row.reason), evidence: json(row.evidence_json), createdAt: number(row.created_at), reviewedAt: nullableNumber(row.reviewed_at), resolutionNote: nullable(row.resolution_note) }; }
function mapModelReviewAction(row: Row): ResearchModelReviewAction { return { actionId: text(row.action_id), reviewItemId: text(row.review_item_id), previousState: "open", nextState: text(row.next_state) as ResearchModelReviewAction["nextState"], actedBy: text(row.acted_by), resolutionNote: text(row.resolution_note), followUpTargetKind: nullable(row.follow_up_target_kind) as ResearchModelReviewAction["followUpTargetKind"], followUpTargetVersionId: nullable(row.follow_up_target_version_id), actedAt: number(row.acted_at) }; }
function text(value: unknown): string { const result = String(value ?? "").trim(); if (!result) throw new Error("stored formal actual candidate text is missing"); return result; }
function nullable(value: unknown): string | null { const result = String(value ?? "").trim(); return result || null; }
function number(value: unknown): number { const result = Number(value); if (!Number.isFinite(result)) throw new Error("stored formal actual candidate number is invalid"); return result; }
function nullableNumber(value: unknown): number | null { return value === null || value === undefined ? null : number(value); }
function json(value: unknown): Record<string, unknown> { try { const parsed = JSON.parse(String(value ?? "{}")); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; } }
function assertText(value: string, label: string) { if (!value?.trim()) throw new Error(`${label} is required`); }
function requiredEnum<T extends readonly string[]>(value: string | undefined, values: T, label: string): T[number] { if (!value || !values.includes(value)) throw new Error(`${label} is required`); return value as T[number]; }
function optionalEnum<T extends readonly string[]>(value: string | undefined, values: T, label: string): T[number] | null { if (!value) return null; if (!values.includes(value)) throw new Error(`${label} is invalid`); return value as T[number]; }
