import type { FormalActualCandidate, FormalActualCandidateReview, ResearchModelReviewItem } from "./formal-actual-candidate";
import type { ResearchCatalystReview } from "./research-catalyst-review";
import type { ResearchSourceHealth } from "./research-data-requirements";
import type { ResearchSourceReference } from "./research-dossier";

export const RESEARCH_REVIEW_QUEUE_VERSION = "research-review-queue.v2";

export type ResearchReviewTarget = { kind: string; id: string };
export type ResearchReviewQueueItem = {
  queueItemId: string;
  kind: "source_health" | "thesis_review_due" | "risk_review_due" | "focus_profile_review_due" | "formal_actual_candidate" | "model_version" | "guidance_impact_mapping" | "event_actual_impact_mapping" | "formal_actual_impact_mapping";
  state: "requires_action" | "blocked";
  observedAt: number | null;
  title: string;
  reason: string;
  /** Source identity is retained even when the queue item has no source URL. */
  source: { kind: string; id: string; url: string | null; title: string | null; version: string | null; supersedesVersion: string | null };
  /** `target` remains for existing clients; `impactedTargets` is the complete, non-inferred set. */
  target: ResearchReviewTarget | null;
  impactedTargets: ResearchReviewTarget[];
  nextAction: string;
};

type Guidance = { forecastId: string; forecastDate: string; metric: string; fiscalPeriod: string; sourceReferences?: ResearchSourceReference[]; supersedesGuidanceForecastId?: string | null };
type ImpactReview = {
  impactReviewId: string;
  sourceKind: "management_guidance" | "catalyst_actual" | "formal_actual";
  sourceId: string;
  targets: Array<{ targetKind: "thesis" | "risk" | "scenario" | "dcf" | "reverse_dcf"; targetId: string; reviewState: "requires_review" | "no_change" | "follow_up_recorded" | "not_applicable" }>;
};
type FormalActual = { actualId: string; metric: string; fiscalPeriod: string; filedAt: string; actualStatus: string; sourceReferences?: ResearchSourceReference[] };
type Requirement = { requirementId: string; label: string; primarySources: Array<{ sourceId: string }>; crossSources: Array<{ sourceId: string }> };
type Thesis = { thesisId: string; title: string; reviewBy: number | null; updatedAt: number; evidence?: Array<{ sourceUrl?: string | null; sourceTitle?: string | null; sourceReferences?: ResearchSourceReference[]; createdAt?: number }> };
type Risk = { riskId: string; title: string; status: string; reviewBy?: number | null; reviewFrequency?: string | null; updatedAt: number; sourceReferences?: ResearchSourceReference[] };
type FocusProfile = { focusProfileId: string; title: string; version: number; supersedesFocusProfileId: string | null; reviewBy: number | null; asOf: number; items: Array<{ targetKind: string; targetId: string }> };

/**
 * Read-only, cross-ledger review agenda. It deliberately only exposes the
 * recorded source/version and affected ledger targets: no status here changes
 * a thesis, a risk, a scenario, a model, or a source record.
 */
export function buildResearchReviewQueue(input: {
  now?: number;
  sourceHealth?: ResearchSourceHealth[];
  requirements?: Requirement[];
  theses?: Thesis[];
  risks?: Risk[];
  focusProfile?: FocusProfile | null;
  formalActualCandidates: FormalActualCandidate[];
  formalActualCandidateReviews: FormalActualCandidateReview[];
  modelReviewItems: ResearchModelReviewItem[];
  managementGuidance: Guidance[];
  formalActuals?: FormalActual[];
  catalystReviews: ResearchCatalystReview[];
  impactReviews: ImpactReview[];
}): { ruleVersion: string; items: ResearchReviewQueueItem[]; openCount: number } {
  const now = validTimestamp(input.now) ?? Date.now();
  const items: ResearchReviewQueueItem[] = [
    ...sourceHealthItems(input.sourceHealth ?? [], input.requirements ?? []),
    ...reviewByItems(input.theses ?? [], input.risks ?? [], input.focusProfile ?? null, now),
  ];
  const finalCandidateDecisions = new Map<string, FormalActualCandidateReview["decision"]>();
  for (const review of input.formalActualCandidateReviews) {
    if (review.decision === "accepted" || review.decision === "rejected") finalCandidateDecisions.set(review.candidateId, review.decision);
  }
  for (const candidate of input.formalActualCandidates) {
    // Blocked statutory comparisons stay in source health/immutable
    // verification history. They are deliberately not candidate-review work.
    if (candidate.eligibility !== "ready_for_review") continue;
    if (finalCandidateDecisions.has(candidate.candidateId)) continue;
    items.push(item({
      queueItemId: `formal-actual:${candidate.candidateId}`, kind: "formal_actual_candidate", state: "requires_action", observedAt: timestamp(candidate.statutoryPublishedAt),
      title: `${candidate.metric} · ${candidate.fiscalPeriod} 法定实际候选`, reason: "已完成字段级法定匹配，仍需人工确认会计与归属口径。",
      source: source(candidate.statutoryProvider, candidate.candidateId, candidate.statutoryDisclosureUrl, candidate.statutoryLocator, candidate.candidateId),
      nextAction: "在预测与估值区审核候选；审核不会改写既有模型。",
    }));
  }
  for (const model of input.modelReviewItems) {
    if (model.state !== "open") continue;
    const target = { kind: model.targetKind, id: model.targetVersionId };
    items.push(item({
      queueItemId: `model:${model.reviewItemId}`, kind: "model_version", state: "requires_action", observedAt: model.createdAt,
      title: `${model.targetKind} 冻结版本待复核`, reason: model.reason,
      source: source(model.triggerKind, model.triggerId, null, null, model.triggerId), target, impactedTargets: [target],
      nextAction: "记录复核处置或新建后续版本；不可修改冻结版本。",
    }));
  }
  for (const guidance of input.managementGuidance) {
    const mappings = sourceImpactMappings(input.impactReviews, "management_guidance", guidance.forecastId);
    if (sourceImpactMappingsComplete(mappings, input.modelReviewItems)) continue;
    const reference = firstReference(guidance.sourceReferences);
    items.push(item({
      queueItemId: `guidance:${guidance.forecastId}`, kind: "guidance_impact_mapping", state: "requires_action", observedAt: timestamp(guidance.forecastDate),
      title: `管理层指引 · ${guidance.fiscalPeriod} ${guidance.metric}`, reason: impactReason(mappings, input.modelReviewItems),
      source: source("management_guidance", guidance.forecastId, reference.url, reference.title, guidance.forecastId, guidance.supersedesGuidanceForecastId ?? null),
      impactedTargets: unresolvedImpactTargets(mappings, input.modelReviewItems),
      nextAction: impactNextAction(mappings, input.modelReviewItems),
    }));
  }
  for (const review of input.catalystReviews) {
    const mappings = sourceImpactMappings(input.impactReviews, "catalyst_actual", review.catalystReviewId);
    if (sourceImpactMappingsComplete(mappings, input.modelReviewItems)) continue;
    const reference = firstReference(review.sourceReferences);
    items.push(item({
      queueItemId: `event-actual:${review.catalystReviewId}`, kind: "event_actual_impact_mapping", state: "requires_action", observedAt: review.asOf,
      title: `事件实际 · ${review.reviewStatus}`, reason: impactReason(mappings, input.modelReviewItems),
      source: source("catalyst_actual", review.catalystReviewId, reference.url, reference.title, review.catalystReviewId),
      impactedTargets: unresolvedImpactTargets(mappings, input.modelReviewItems),
      nextAction: impactNextAction(mappings, input.modelReviewItems),
    }));
  }
  for (const actual of input.formalActuals ?? []) {
    if (actual.actualStatus === "superseded") continue;
    const mappings = sourceImpactMappings(input.impactReviews, "formal_actual", actual.actualId);
    if (sourceImpactMappingsComplete(mappings, input.modelReviewItems)) continue;
    const reference = firstReference(actual.sourceReferences);
    items.push(item({
      queueItemId: `formal-actual-impact:${actual.actualId}`, kind: "formal_actual_impact_mapping", state: "requires_action", observedAt: timestamp(actual.filedAt),
      title: `已接受法定实际 · ${actual.fiscalPeriod} ${actual.metric}`, reason: impactReason(mappings, input.modelReviewItems),
      source: source("formal_actual", actual.actualId, reference.url, reference.title, actual.actualId),
      impactedTargets: unresolvedImpactTargets(mappings, input.modelReviewItems),
      nextAction: impactNextAction(mappings, input.modelReviewItems),
    }));
  }
  items.sort((left, right) => (right.observedAt ?? 0) - (left.observedAt ?? 0) || left.queueItemId.localeCompare(right.queueItemId));
  return { ruleVersion: RESEARCH_REVIEW_QUEUE_VERSION, items, openCount: items.filter((entry) => entry.state === "requires_action").length };
}

function sourceHealthItems(sources: ResearchSourceHealth[], requirements: Requirement[]): ResearchReviewQueueItem[] {
  return sources.filter((entry) => ["stale", "conflict", "source_error"].includes(entry.status)).map((entry) => {
    const impactedTargets = requirements.filter((requirement) => [...requirement.primarySources, ...requirement.crossSources].some((candidate) => candidate.sourceId === entry.sourceId))
      .map((requirement) => ({ kind: "data_requirement", id: requirement.requirementId }));
    return item({
      queueItemId: `source-health:${entry.sourceId}:${entry.status}:${entry.observedAt ?? "none"}`, kind: "source_health", state: entry.status === "conflict" ? "blocked" : "requires_action", observedAt: entry.observedAt,
      title: `${entry.label} · ${healthLabel(entry.status)}`, reason: entry.detail,
      source: source("data_source", entry.sourceId, null, entry.label, observationVersion(entry), null), impactedTargets,
      nextAction: entry.status === "conflict" ? "保留冲突来源与口径，人工核对后再建立新的来源事实或复核项；不得选一方自动覆盖。" : "刷新或核验该来源；新观察只可追加到对应账本，再人工判断是否影响目标。",
    });
  });
}

function reviewByItems(theses: Thesis[], risks: Risk[], focusProfile: FocusProfile | null, now: number): ResearchReviewQueueItem[] {
  const items: ResearchReviewQueueItem[] = [];
  for (const thesis of theses) {
    if (thesis.reviewBy === null || thesis.reviewBy > now) continue;
    const reference = firstReference(thesis.evidence?.flatMap((evidence) => evidence.sourceReferences ?? []).length ? thesis.evidence?.flatMap((evidence) => evidence.sourceReferences ?? []) : thesis.evidence?.map((evidence) => ({ url: evidence.sourceUrl ?? null, title: evidence.sourceTitle ?? null })));
    const target = { kind: "research_thesis", id: thesis.thesisId };
    items.push(item({ queueItemId: `thesis-review:${thesis.thesisId}:${thesis.reviewBy}`, kind: "thesis_review_due", state: "requires_action", observedAt: thesis.reviewBy,
      title: `命题复核到期 · ${thesis.title}`, reason: "已到记录的 reviewBy；命题本身及其证据不会由议程自动修改。", source: source("research_thesis", thesis.thesisId, reference.url, reference.title, versionAt(thesis.updatedAt)), target, impactedTargets: [target],
      nextAction: "审阅支持、反对与冲突证据；如需改变判断，追加新命题版本或记录复核处置。" }));
  }
  for (const risk of risks) {
    if (["resolved", "unavailable"].includes(risk.status)) continue;
    const due = risk.reviewBy ?? reviewFrequencyDueAt(risk.reviewFrequency, risk.updatedAt);
    if (due === null || due > now) continue;
    const reference = firstReference(risk.sourceReferences);
    const target = { kind: "research_risk", id: risk.riskId };
    items.push(item({ queueItemId: `risk-review:${risk.riskId}:${due}`, kind: "risk_review_due", state: "requires_action", observedAt: due,
      title: `风险复核到期 · ${risk.title}`, reason: risk.reviewBy ? "已到记录的 reviewBy。" : `依据记录的复核频率“${risk.reviewFrequency}”计算的复核日已到期。`, source: source("research_risk", risk.riskId, reference.url, reference.title, versionAt(risk.updatedAt)), target, impactedTargets: [target],
      nextAction: "复核风险触发条件、来源与传导；如需改变风险，追加记录而非改写旧快照。" }));
  }
  if (focusProfile && focusProfile.reviewBy !== null && focusProfile.reviewBy <= now) {
    const target = { kind: "focus_profile", id: focusProfile.focusProfileId };
    const impactedTargets = [target, ...focusProfile.items.map((entry) => ({ kind: entry.targetKind, id: entry.targetId }))];
    items.push(item({ queueItemId: `focus-profile-review:${focusProfile.focusProfileId}:${focusProfile.reviewBy}`, kind: "focus_profile_review_due", state: "requires_action", observedAt: focusProfile.reviewBy,
      title: `重点公司档案复核到期 · ${focusProfile.title}`, reason: `重点档案 v${focusProfile.version} 已到记录的 reviewBy；个人关注状态不在此项中。`, source: source("company_focus_profile", focusProfile.focusProfileId, null, focusProfile.title, `v${focusProfile.version}`, focusProfile.supersedesFocusProfileId), target, impactedTargets,
      nextAction: "核对所引账本对象和来源状态；如需更新，创建新的不可变档案版本。" }));
  }
  return items;
}

function sourceImpactMappings(reviews: ImpactReview[], sourceKind: ImpactReview["sourceKind"], sourceId: string) {
  return reviews.filter((review) => review.sourceKind === sourceKind && review.sourceId === sourceId);
}
function sourceImpactMappingsComplete(reviews: ImpactReview[], modelReviewItems: ResearchModelReviewItem[]) {
  return reviews.length > 0 && reviews.every((review) => Array.isArray(review.targets) && review.targets.length > 0 && review.targets.every((target) => impactTargetFinal(review, target, modelReviewItems)));
}
function impactTargetFinal(review: ImpactReview, target: ImpactReview["targets"][number], modelReviewItems: ResearchModelReviewItem[]) {
  if (target.targetKind === "thesis" || target.targetKind === "risk") return target.reviewState !== "requires_review";
  return modelReviewItems.some((item) => item.triggerId === review.impactReviewId && item.targetKind === target.targetKind && item.targetVersionId === target.targetId && item.state !== "open");
}
function unresolvedImpactTargets(reviews: ImpactReview[], modelReviewItems: ResearchModelReviewItem[]): ResearchReviewTarget[] {
  const targets = reviews.flatMap((review) => (review.targets ?? []).filter((target) => !impactTargetFinal(review, target, modelReviewItems))
    .map((target) => ({ kind: target.targetKind, id: target.targetId })));
  return dedupeTargets(targets);
}
function impactReason(reviews: ImpactReview[], modelReviewItems: ResearchModelReviewItem[]) {
  if (!reviews.length) return "已有来源绑定记录，但尚未人工映射到命题、风险或冻结模型复核。";
  const unresolved = unresolvedImpactTargets(reviews, modelReviewItems).length;
  return unresolved ? `已有 ${reviews.length} 条明确影响映射，但仍有 ${unresolved} 个目标没有最终人工处置。` : "影响映射的目标状态不完整，不能自动关闭复核。";
}
function impactNextAction(reviews: ImpactReview[], modelReviewItems: ResearchModelReviewItem[]) {
  if (!reviews.length) return "在复盘区选择受影响命题/风险或冻结模型并说明关联；系统不会自动判断影响。";
  const targets = unresolvedImpactTargets(reviews, modelReviewItems);
  if (targets.some((target) => target.kind === "thesis" || target.kind === "risk")) return "为每个命题/风险目标追加最终处置；如判断改变，另行新建不可变记录并引用其 ID。";
  return "在冻结模型待复核项中记录最终处置或后续版本；不得修改原冻结版本。";
}

function item(value: Omit<ResearchReviewQueueItem, "target" | "impactedTargets"> & Partial<Pick<ResearchReviewQueueItem, "target" | "impactedTargets">>): ResearchReviewQueueItem {
  const impactedTargets = dedupeTargets(value.impactedTargets ?? (value.target ? [value.target] : []));
  return { ...value, target: value.target ?? impactedTargets[0] ?? null, impactedTargets };
}
function source(kind: string, id: string, url: string | null | undefined, title: string | null | undefined, version: string | null = null, supersedesVersion: string | null = null) { return { kind, id, url: url ?? null, title: title ?? null, version, supersedesVersion }; }
function firstReference(references: Array<Pick<ResearchSourceReference, "url" | "title"> | { url?: string | null; title?: string | null }> | undefined) { const reference = references?.find((entry) => entry && (entry.url || entry.title)); return { url: reference?.url ?? null, title: reference?.title ?? null }; }
function dedupeTargets(targets: ResearchReviewTarget[]) { const seen = new Set<string>(); return targets.filter((target) => Boolean(target.kind && target.id) && !seen.has(`${target.kind}:${target.id}`) && (seen.add(`${target.kind}:${target.id}`), true)); }
function observationVersion(entry: ResearchSourceHealth) { return entry.observedAt === null ? `health:${entry.status}:unobserved` : `health:${entry.status}:${entry.observedAt}`; }
function versionAt(value: number) { return Number.isFinite(value) && value > 0 ? `observed:${value}` : null; }
function healthLabel(status: ResearchSourceHealth["status"]) { return status === "stale" ? "已过期" : status === "conflict" ? "存在冲突" : "来源错误"; }
function timestamp(value: string | null | undefined): number | null { if (!value?.trim()) return null; const parsed = Date.parse(value); return Number.isFinite(parsed) && parsed > 0 ? parsed : null; }
function validTimestamp(value: unknown): number | null { const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? parsed : null; }
function reviewFrequencyDueAt(value: string | null | undefined, updatedAt: number): number | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  const days = normalized === "monthly" || normalized === "每月" ? 31
    : normalized === "quarterly" || normalized === "每季度" || normalized === "季度" ? 92
      : normalized === "semiannual" || normalized === "每半年" || normalized === "半年" ? 183
        : normalized === "annual" || normalized === "每年" || normalized === "年度" ? 366 : null;
  return days && Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt + days * 86_400_000 : null;
}
